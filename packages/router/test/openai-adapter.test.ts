import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mapHttpError, OpenAiCompatibleAdapter, type OpenAiCredential } from "../src/providers/openai/index.ts";
import { Logger } from "../src/log.ts";
import { decodeEnvelope, encodeEnvelope } from "../src/reasoning.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";
import { requestKind } from "../src/routing.ts";

const seen: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let mode: "chat" | "responses" | "error" | "cut-responses" | "cut-chat" | "done-chat" | "refuse-reasoning" | "refuse-chat" | "sealed" | "sealed-chat" | "missing-thinking" = "chat";
const sse = (records: Record<string, unknown>[]) => records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("");

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
    if (req.headers.authorization === "Bearer hop-first") {
      res.writeHead(429, { "retry-after": "123" }).end('{"error":{"message":"hop-first limited"}}');
      return;
    }
    if (mode === "missing-thinking") {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Upstream request failed: The `content[].thinking` in the thinking mode must be passed back to the API. (reasoning signature required)" } }));
      return;
    }
    if (mode === "error") {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "missing key" } }));
      return;
    }
    // A vendor that refuses the reasoning carried back in the request it was given.
    if (mode === "refuse-reasoning" || mode === "refuse-chat") {
      const body = seen.at(-1)!.body as { input?: unknown[]; messages?: unknown[] };
      const carried = mode === "refuse-chat" ? JSON.stringify(body.messages ?? []) : JSON.stringify(body);
      if (carried.includes(mode === "refuse-chat" ? '"reasoning_content"' : "encrypted_content")) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: mode === "refuse-chat" ? "Invalid request: `reasoning_content` was not produced by this model" : "Invalid value for 'input[3].encrypted_content': the item was not produced by this model" } }));
        return;
      }
    }
    // A Chat vendor that streams its reasoning beside the answer and takes tool calls (DeepSeek).
    if (mode === "sealed-chat") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([
        { choices: [{ delta: { reasoning_content: "let me look" }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 40, completion_tokens: 5 } },
      ]));
      return;
    }
    // A Responses deployment that seals its reasoning into the completed item.
    if (mode === "sealed") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" }, output_index: 0 },
        { type: "response.reasoning_summary_text.delta", delta: "thinking…", item_id: "rs_1" },
        { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAsealed" } },
        { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", id: "fc_1", name: "Read" }, output_index: 1 },
        { type: "response.function_call_arguments.delta", delta: '{"file_path":"a.ts"}', item_id: "fc_1" },
        { type: "response.output_item.done", item: { type: "function_call", id: "fc_1" } },
        { type: "response.completed", response: { usage: { input_tokens: 40, output_tokens: 5 } } },
      ]));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Streams that stop without the vendor saying they are done, as muse's did (2026-09-19).
    if (mode === "cut-responses") {
      res.end(sse([{ type: "response.output_item.added", item: { type: "message", id: "msg_1" } }, { type: "response.output_text.delta", delta: "Hal" }]));
      return;
    }
    if (mode === "cut-chat") {
      res.end(sse([{ choices: [{ delta: { content: "Hal" }, finish_reason: null }] }]));
      return;
    }
    if (mode === "done-chat") {
      res.end(`${sse([{ choices: [{ delta: { content: "Hi" }, finish_reason: null }] }])}data: [DONE]\n\n`);
      return;
    }
    const records = mode === "chat" || mode === "refuse-chat"
      ? [
          { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"path":"a"}' } }] }, finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 40, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens: 5 } },
        ]
      : [
          { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
          { type: "response.output_text.delta", delta: "Hi" },
          { type: "response.output_item.done", item: { type: "message", id: "msg_1" } },
          { type: "response.completed", response: { usage: { input_tokens: 40, input_tokens_details: { cached_tokens: 30 }, output_tokens: 5 } } },
        ];
    const body = sse(records);
    // Odd chunks exercise parser boundaries.
    for (let at = 0; at < body.length; at += 17) res.write(body.slice(at, at + 17));
    res.end();
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

const upstreamPort = await listen(upstream);
const log = new Logger(null, 1_000_000, 1, false);
let adapter: OpenAiCompatibleAdapter;
let configuredEffort = "high";
let credential: OpenAiCredential | undefined;
const front = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest;
    const requestPath = (req.url ?? "/v1/messages").split("?")[0] ?? "/v1/messages";
    void adapter.handle(req, res, req.url ?? "/v1/messages", json, "vendor-model", configuredEffort, credential, { kind: requestKind(json, requestPath) });
  });
});
const frontPort = await listen(front);

function call(body: unknown, path = "/v1/messages"): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: frontPort, method: "POST", path, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

const request: AnthropicRequest = { model: "claude", stream: true, system: "sys", messages: [{ role: "user", content: "read a" }], tools: [{ name: "Read", input_schema: { type: "object" } }] };

test("adapter streams chat completions, carries bearer auth, usage and tool calls", async () => {
  mode = "chat";
  adapter = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, headers: { authorization: "Bearer secret" }, caps: { reasoning: "effort", effortLevels: ["low", "high"] } }, log);
  const response = await call(request);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/event-stream/);
  const sent = seen.at(-1)!;
  assert.equal(sent.path, "/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer secret");
  assert.equal(sent.body.model, "vendor-model");
  assert.equal(sent.body.reasoning_effort, "high");
  assert.deepEqual(sent.body.stream_options, { include_usage: true });
  assert.match(response.text, /"text":"Hi"/);
  assert.match(response.text, /"partial_json":"{\\"path\\":\\"a\\"}"/);
  assert.match(response.text, /"cache_read_input_tokens":30/);
});

test("adapter uses a model-level effort capability before its provider default", async () => {
  mode = "chat";
  configuredEffort = "high";
  adapter = new OpenAiCompatibleAdapter("fake", {
    type: "openai-compatible",
    url: `http://127.0.0.1:${upstreamPort}/v1`,
    caps: { reasoning: "effort", effortLevels: ["low", "high"] },
    models: [{ id: "vendor-model", effortLevels: [] }],
  }, log);
  const response = await call(request);
  assert.equal(response.status, 200);
  assert.equal(seen.at(-1)?.body.reasoning_effort, undefined);
});

test("adapter clamps effort to the configured model-level list", async () => {
  mode = "chat";
  configuredEffort = "high";
  adapter = new OpenAiCompatibleAdapter("fake", {
    type: "openai-compatible",
    url: `http://127.0.0.1:${upstreamPort}/v1`,
    caps: { reasoning: "effort", effortLevels: ["low", "medium", "high"] },
    models: [{ id: "vendor-model", effortLevels: ["low"] }],
  }, log);
  const response = await call(request);
  assert.equal(response.status, 200);
  assert.equal(seen.at(-1)?.body.reasoning_effort, "low");
  configuredEffort = "high";
});

test("adapter translates stateless Responses wire and supports non-streaming output", async () => {
  mode = "responses";
  adapter = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, wire: "responses" }, log);
  const response = await call({ ...request, stream: false });
  assert.equal(response.status, 200);
  const sent = seen.at(-1)!;
  assert.equal(sent.path, "/v1/responses");
  assert.deepEqual(sent.body.input && (sent.body.input as { type: string }[]).map((item) => item.type), ["message"]);
  assert.equal(JSON.parse(response.text).content[0].text, "Hi");
});

test("an Auto mode classifier's system text reaches the upstream exactly as sent, on both wires", async () => {
  const system = "You are a security monitor for autonomous AI coding agents.\n\nJudge this action.";
  const addendum = "Be brief.";
  const classifier: AnthropicRequest = { model: "claude-haiku-5-5", stream: true, system, messages: [{ role: "user", content: "check" }] };
  const ordinarySystem = "Judge this action.";

  for (const wire of ["chat", "responses"] as const) {
    mode = wire;
    adapter = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, wire, instructionsAppend: addendum }, log);
    const classifierResponse = await call(classifier);
    assert.equal(classifierResponse.status, 200);
    const classifierBody = seen.at(-1)!.body;
    const classifierSystem = wire === "chat"
      ? (classifierBody.messages as { content: unknown }[])[0]!.content
      : classifierBody.instructions;
    assert.equal(classifierSystem, system);

    const turnResponse = await call({ ...classifier, system: ordinarySystem });
    assert.equal(turnResponse.status, 200);
    const turnBody = seen.at(-1)!.body;
    const turnSystem = wire === "chat"
      ? (turnBody.messages as { content: unknown }[])[0]!.content
      : turnBody.instructions;
    assert.equal(turnSystem, `You are vendor-model, answering through Claude Code, a terminal-based coding agent.\n\n${ordinarySystem}\n\n${addendum}`);
  }
});

test("adapter maps a vendor 401 to Anthropic authentication_error", async () => {
  mode = "error";
  adapter = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1` }, log);
  const response = await call(request);
  assert.equal(response.status, 401);
  assert.equal(JSON.parse(response.text).error.type, "authentication_error");
});

test("count tokens is local", async () => {
  const before = seen.length;
  const response = await call(request, "/v1/messages/count_tokens");
  assert.equal(response.status, 200);
  assert.ok(JSON.parse(response.text).input_tokens > 0);
  assert.equal(seen.length, before);
});

// Some vendors key their prompt cache on a session header (OpenCode Go's `x-opencode-session`) and
// charge full price to anyone who omits one. A miss here is silent and shows up on the bill.
test("a configured session header is sent, stable per conversation and different between two", async () => {
  mode = "chat";
  adapter = new OpenAiCompatibleAdapter("fake", {
    type: "openai-compatible",
    url: `http://127.0.0.1:${upstreamPort}/v1`,
    headers: { authorization: "Bearer secret" },
    sessionHeader: "x-opencode-session",
  }, log);

  const conversation = { ...request, metadata: { user_id: "user-1" }, messages: [{ role: "user" as const, content: "first question" }] };
  await call(conversation);
  const first = seen.at(-1)!.headers["x-opencode-session"];
  assert.ok(typeof first === "string" && first.length > 0, "the header went out");

  // A later turn of the same conversation keeps the value; a different conversation gets its own.
  await call({ ...conversation, messages: [...conversation.messages, { role: "assistant" as const, content: "ok" }, { role: "user" as const, content: "second question" }] });
  assert.equal(seen.at(-1)!.headers["x-opencode-session"], first, "same conversation, same session");

  await call({ ...request, metadata: { user_id: "user-1" }, messages: [{ role: "user" as const, content: "a different opening" }] });
  assert.notEqual(seen.at(-1)!.headers["x-opencode-session"], first, "a different conversation is not the same session");
});

test("no session header is sent unless the provider asks for one", async () => {
  mode = "chat";
  adapter = new OpenAiCompatibleAdapter("fake", {
    type: "openai-compatible",
    url: `http://127.0.0.1:${upstreamPort}/v1`,
    headers: { authorization: "Bearer secret" },
  }, log);
  await call(request);
  assert.equal(seen.at(-1)!.headers["x-opencode-session"], undefined);
});

// A stream that closes before the vendor says it is done was cut off. Finishing it as end_turn gave
// the worker an empty or half answer it took as final; overloaded_error is what Claude Code retries.
test("a Responses stream cut off before response.completed ends in a retryable overloaded_error", async () => {
  mode = "cut-responses";
  adapter = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, wire: "responses" }, log);
  const response = await call(request);
  assert.match(response.text, /event: error\ndata: \{"type":"error","error":\{"type":"overloaded_error"/);
  assert.doesNotMatch(response.text, /"stop_reason":"end_turn"/);
  assert.doesNotMatch(response.text, /message_stop/);
});

test("a Chat stream cut off before any finish_reason ends in overloaded_error too", async () => {
  mode = "cut-chat";
  adapter = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1` }, log);
  const response = await call(request);
  assert.match(response.text, /"type":"overloaded_error"/);
  assert.doesNotMatch(response.text, /message_stop/);
});

test("a Chat stream that ends on [DONE] without a finish_reason is complete, not cut off", async () => {
  mode = "done-chat";
  adapter = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1` }, log);
  const response = await call(request);
  assert.doesNotMatch(response.text, /event: error/);
  assert.match(response.text, /"stop_reason":"end_turn"/);
});

test("a cut-off non-streaming turn is answered 529, not 200 with the fragment", async () => {
  mode = "cut-responses";
  adapter = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, wire: "responses" }, log);
  const response = await call({ ...request, stream: false });
  assert.equal(response.status, 529);
  assert.equal(JSON.parse(response.text).error.type, "overloaded_error");
});

// ---- reasoning replay through the whole adapter (reasoning.ts) ----------------------------------

// The adapter hands the client a carrier block for the reasoning the backend sealed, and the very
// block comes back on the next turn — so it is put back exactly where the CLI replays it, with
// `include` asking for the reasoning to keep being sealed. One round trip proves the loop closes.
test("a sealed reasoning item is carried to the client and replayed on the next turn", async () => {
  mode = "sealed";
  adapter = new OpenAiCompatibleAdapter("opencode-go", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, wire: "responses" }, log);
  const first = await call({ ...request, stream: false });
  assert.equal(first.status, 200);
  assert.equal(seen.at(-1)?.body.include, undefined, "nothing to carry yet, so nothing is asked for");
  const message = JSON.parse(first.text) as { content: { type: string; thinking?: string; signature?: string }[] };
  const carried = message.content.find((b) => b.type === "thinking")!;
  assert.equal(carried.thinking, "thinking…");
  assert.deepEqual(decodeEnvelope(carried.signature), {
    w: "responses",
    p: "opencode-go",
    m: "vendor-model",
    r: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAsealed" },
  });

  // The next turn carries the block exactly as the client got it, in front of the call it belongs to.
  const second = await call({
    ...request,
    stream: false,
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: [carried, { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
    ],
  });
  assert.equal(second.status, 200);
  const replayed = seen.at(-1)!.body as { include?: unknown; input: unknown[] };
  assert.deepEqual(replayed.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(replayed.input[1], { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAsealed" });
  assert.deepEqual(replayed.input[2], { type: "function_call", call_id: "call_1", name: "Read", arguments: '{"file_path":"a.ts"}' });
});

// A vendor that refuses the reasoning carried back gets one more ask without it. The turn is the
// user's and must not fail over an optimisation the router chose to make (reasoning.ts).
test("a refusal naming the replayed reasoning is retried once without it", async () => {
  mode = "refuse-reasoning";
  adapter = new OpenAiCompatibleAdapter("opencode-go", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, wire: "responses" }, log);
  const carried = { type: "thinking", thinking: "", signature: encodeEnvelope({ w: "responses", p: "opencode-go", m: "vendor-model", r: { type: "reasoning", encrypted_content: "gAAAAsealed" } }) };
  const response = await call({
    ...request,
    stream: false,
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: [carried, { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
    ],
  });
  assert.equal(response.status, 200, "the retry answered, the refusal did not reach the user");
  const attempts = seen.slice(-2).map((s) => JSON.stringify(s.body).includes("encrypted_content"));
  assert.deepEqual(attempts, [true, false], "the second ask carried no reasoning");
});

// The Chat wire carries no sealed blob to hand back, so the block's own text is what returns, under
// the field name the vendor used. DeepSeek's own docs make this mandatory while tools are present:
// a turn that omits a previous turn's `reasoning_content` is answered 400.
test("a Chat reasoning turn is carried to the client and replayed as reasoning_content", async () => {
  mode = "sealed-chat";
  adapter = new OpenAiCompatibleAdapter("opencode-zen", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, wire: "chat" }, log);
  const first = await call({ ...request, stream: false });
  assert.equal(first.status, 200);
  const message = JSON.parse(first.text) as { content: { type: string; thinking?: string; signature?: string }[] };
  const carried = message.content.find((b) => b.type === "thinking")!;
  assert.equal(carried.thinking, "let me look");
  assert.deepEqual(decodeEnvelope(carried.signature), { w: "chat", p: "opencode-zen", m: "vendor-model", f: "reasoning_content" });

  const plain = await call({ ...request, stream: false, messages: [{ role: "user", content: "read a" }] });
  assert.equal(plain.status, 200);
  assert.equal((seen.at(-1)!.body.messages as { reasoning_content?: string }[]).some((m) => m.reasoning_content !== undefined), false, "nothing to replay, so no message carries it");

  const second = await call({
    ...request,
    stream: false,
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: [carried, { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
    ],
  });
  assert.equal(second.status, 200);
  const messages = (seen.at(-1)!.body as { messages: { role: string; reasoning_content?: string; tool_calls?: unknown[] }[] }).messages;
  const assistant = messages.find((m) => m.role === "assistant")!;
  assert.equal(assistant.reasoning_content, "let me look");
  assert.deepEqual(assistant.tool_calls, [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }]);
});

// The same one-more-ask applies: a Chat vendor that refuses `reasoning_content` from another account
// must not fail the user's turn over it (reasoning.ts).
test("a Chat vendor's refusal of reasoning_content is retried once without it", async () => {
  mode = "refuse-chat";
  adapter = new OpenAiCompatibleAdapter("opencode-zen", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, wire: "chat" }, log);
  const carried = { type: "thinking", thinking: "deepseek thought", signature: encodeEnvelope({ w: "chat", p: "opencode-zen", m: "vendor-model", f: "reasoning_content" }) };
  const response = await call({
    ...request,
    stream: false,
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: [carried, { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
    ],
  });
  assert.equal(response.status, 200, "the retry answered, the refusal did not reach the user");
  const attempts = seen.slice(-2).map((s) => JSON.stringify((s.body as { messages?: unknown }).messages ?? []).includes('"reasoning_content"'));
  assert.deepEqual(attempts, [true, false], "the second ask carried no reasoning");
});

test("per-call credential wins over session and configured headers; reasoning retry survives a hop", async () => {
  mode = "refuse-chat";
  adapter = new OpenAiCompatibleAdapter("fake", {
    type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, wire: "chat",
    sessionHeader: "authorization", headers: { authorization: "Bearer config" },
  }, log);
  const before = seen.length;
  const refusals: [number, number | undefined, string][] = [];
  credential = {
    headers: { authorization: "Bearer hop-first" },
    next: (status, retry, body) => {
      refusals.push([status, retry, body]);
      return status === 429 ? { authorization: "Bearer hop-second" } : null;
    },
  };
  try {
    const response = await call({
      ...request, stream: false,
      messages: [
        { role: "user", content: "read a" },
        { role: "assistant", content: [{ type: "thinking", thinking: "thought", signature: encodeEnvelope({ w: "chat", p: "fake", m: "vendor-model", f: "reasoning_content" }) }] },
        { role: "user", content: "continue" },
      ],
    });
    assert.equal(response.status, 200);
    const attempts = seen.slice(before);
    assert.deepEqual(attempts.map((a) => a.headers.authorization), ["Bearer hop-first", "Bearer hop-second", "Bearer hop-second"]);
    assert.deepEqual(attempts.map((a) => JSON.stringify(a.body).includes('"reasoning_content"')), [true, true, false]);
    assert.equal(refusals[0]![0], 429);
    assert.equal(refusals[0]![1], 123000);
    assert.match(refusals[0]![2], /hop-first limited/);
    assert.equal(refusals[1]![0], 400);
  } finally { credential = undefined; }
});

test("replayed reasoning does not buffer a successful stream until upstream EOF", async (t) => {
  let pending: http.ServerResponse | undefined;
  let sent: { messages: { reasoning_content?: string }[] } | undefined;
  const slow = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      sent = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: { reasoning_content?: string }[] };
      pending = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse([{ choices: [{ delta: { content: "first chunk" }, finish_reason: null }] }]));
      // The test releases EOF only after the client has received the text.
    });
  });
  const port = await listen(slow);
  const streaming = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", url: `http://127.0.0.1:${port}/v1` }, log);
  const gateway = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      void streaming.handle(req, res, "/v1/messages", {
        ...request,
        messages: [
          { role: "user", content: "question" },
          { role: "assistant", content: [{ type: "thinking", thinking: "thought", signature: encodeEnvelope({ w: "chat", p: "fake", m: "vendor-model", f: "reasoning_content" }) }] },
          { role: "user", content: "continue" },
        ],
      }, "vendor-model", undefined);
    });
  });
  t.after(() => {
    pending?.end();
    gateway.closeAllConnections();
    slow.closeAllConnections();
    gateway.close();
    slow.close();
  });
  const gatewayPort = await listen(gateway);
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: "{}", signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes('"text":"first chunk"')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += new TextDecoder().decode(chunk.value);
  }
  assert.ok(pending);
  assert.equal(pending.writableEnded, false);
  assert.ok(sent?.messages.some((message) => message.reasoning_content === "thought"), "the successful request really carried replayed reasoning");
  pending.end(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]));
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  assert.match(text, /message_stop/);
});

for (const wire of ["chat", "responses"] as const) {
  for (const stream of [true, false]) {
    for (const afterTerminal of ["open", "reset", "error"] as const) {
      test(`${wire} terminal completes stream=${stream} without waiting for EOF (${afterTerminal})`, { timeout: 3000 }, async (t) => {
        const closed = Promise.withResolvers<void>();
        let reset: NodeJS.Timeout | undefined;
        const backend = http.createServer((req, res) => {
          req.resume();
          req.on("end", () => {
            res.on("close", () => closed.resolve());
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(sse(wire === "chat" ? [
              { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
            ] : [
              { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
              { type: "response.output_text.delta", item_id: "msg_1", delta: "answer" },
              { type: "response.output_item.done", item: { type: "message", id: "msg_1" } },
            ]));
            // Usage arrives after finish_reason, in a later write. It must not be lost.
            setImmediate(() => {
              const terminal = wire === "chat"
                ? sse([{ choices: [], usage: { prompt_tokens: 40, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens: 5 } }]) + "data: [DONE]\n\n"
                : sse([{ type: "response.completed", response: { usage: { input_tokens: 40, input_tokens_details: { cached_tokens: 30 }, output_tokens: 5 } } }]);
              const lateError = sse([{ error: { message: "too late", code: "server_is_overloaded" } }]);
              res.write(terminal + (afterTerminal === "error" ? lateError : ""));
              if (afterTerminal === "reset") reset = setTimeout(() => res.destroy(), 50);
              // No EOF, even after the terminal marker: the adapter owns cleanup.
            });
          });
        });
        const port = await listen(backend);
        const local = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", wire, url: `http://127.0.0.1:${port}` }, log);
        const outcome = Promise.withResolvers<Awaited<ReturnType<OpenAiCompatibleAdapter["handle"]>>>();
        const gateway = http.createServer((req, res) => {
          req.resume();
          req.on("end", () => {
            local.handle(req, res, "/v1/messages", { ...request, stream }, "vendor-model", undefined).then(outcome.resolve, outcome.reject);
          });
        });
        t.after(() => {
          if (reset) clearTimeout(reset);
          gateway.closeAllConnections(); backend.closeAllConnections();
          gateway.close(); backend.close();
        });
        const gatewayPort = await listen(gateway);
        const response = await fetch(`http://127.0.0.1:${gatewayPort}`, { method: "POST", body: "{}", signal: AbortSignal.timeout(1000) });
        const text = await response.text();
        const result = await outcome.promise;
        assert.equal(result.status, 200);
        assert.deepEqual(result.usage, { input: 10, cached: 30, output: 5 });
        assert.equal(result.stopReason, "end_turn");
        if (stream) {
          const events = text.split("\n\n").filter(Boolean).map((event) => JSON.parse(event.split("\ndata: ")[1]!) as { type: string; usage?: unknown });
          assert.equal(events.filter((event) => event.type === "message_stop").length, 1);
          assert.equal(events.some((event) => event.type === "error"), false);
          assert.deepEqual(events.find((event) => event.type === "message_delta")?.usage, { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 0, output_tokens: 5 });
        } else {
          assert.equal(response.status, 200);
          assert.equal(JSON.parse(text).content[0].text, "answer");
        }
        await closed.promise;
      });
    }
  }
}

test("missing thinking 400 logs assistant shapes only and never retries (#109)", async () => {
  mode = "missing-thinking";
  const warnings: string[] = [];
  class CaptureLogger extends Logger {
    override warn(line: string): void { warnings.push(line); }
  }
  adapter = new OpenAiCompatibleAdapter("opencode-go", { type: "openai-compatible", url: `http://127.0.0.1:${upstreamPort}/v1`, wire: "responses" }, new CaptureLogger(null, 1000000, 1, false));
  const before = seen.length;
  let hops = 0;
  credential = { headers: {}, next: () => { hops++; return null; } };
  try {
    const response = await call({ ...request, messages: [
      { role: "user", content: "PRIVATE_USER" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "PRIVATE_THOUGHT", signature: encodeEnvelope({ w: "responses", p: "opencode-go", m: "vendor-model", r: { type: "reasoning", encrypted_content: "PRIVATE_BLOB" } }) },
        { type: "tool_use", id: "PRIVATE_ID", name: "PRIVATE_TOOL", input: { secret: "PRIVATE_ARGUMENT" } },
        { type: "tool_use", id: "b", name: "Read", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "PRIVATE_ID", content: "PRIVATE_RESULT" }] },
      { role: "assistant", content: "PRIVATE_TEXT" },
      { role: "assistant", content: [] },
      { role: "assistant", content: [{ type: "PRIVATE_TYPE", text: "PRIVATE_UNKNOWN" }] },
    ] });
    assert.equal(response.status, 400);
    assert.equal(response.headers["x-should-retry"], "false");
    assert.equal(seen.length - before, 1);
    assert.equal(hops, 0);
    const diagnostic = warnings.find((line) => line.includes("assistantTurns="));
    assert.ok(diagnostic, "shape diagnostic is emitted at WARN");
    const turns = JSON.parse(diagnostic.split("assistantTurns=")[1]!) as unknown;
    assert.deepEqual(turns, [
      { turn: 1, blocks: { thinking: 1, tool_use: 2 } },
      { turn: 3, blocks: { text: 1 } },
      { turn: 4, blocks: {} },
      { turn: 5, blocks: { unknown: 1 } },
    ]);
    assert.doesNotMatch(warnings.join("\n"), /PRIVATE_/);
    const noCarriers = await call(request);
    assert.equal(noCarriers.status, 400);
    assert.equal(noCarriers.headers["x-should-retry"], "false");
    assert.equal(seen.length - before, 2, "replayed=0 also makes exactly one attempt");
    assert.equal(hops, 0);
    assert.ok(warnings.some((line) => line.endsWith("assistantTurns=[]")));
  } finally { credential = undefined; }
});

test("cleanup", () => {
  front.close();
  upstream.close();
});

// A 403 is often about what the account may do rather than about the credential. Calling it an
// authentication error sends the user back to a key that was never the problem — which is how an
// OpenCode Go data-policy refusal read as a bad key.
test("a 403 that is not about the credential is a permission error, not an auth error", async () => {
  const policy = mapHttpError(403, JSON.stringify({ error: { type: "DataPolicyError", message: "This model collects data used to improve its quality and requires explicit opt in" } }));
  assert.equal(policy.status, 403);
  assert.match(policy.body, /permission_error/);
  assert.match(policy.body, /explicit opt in/, "the vendor's own words survive");

  // A 403 that really is the credential keeps saying so.
  const rejected = mapHttpError(403, JSON.stringify({ error: { message: "Invalid API key" } }));
  assert.equal(rejected.status, 401);
  assert.match(rejected.body, /authentication_error/);

  assert.equal(mapHttpError(401, "{}").status, 401);
});

// fetch refuses a header value it cannot send and quotes it whole — credential included — in the
// error, which reaches the retry log, the client and (rethrown) the request log.
test("a credential quoted in a connection error is redacted in the retry log, the client error and the rethrown error", async () => {
  const lines: string[] = [];
  const capture = { info: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) } as unknown as Logger;
  const bad = new OpenAiCompatibleAdapter("bad", { type: "openai-compatible", url: "http://127.0.0.1:9/v1", wire: "chat" }, capture, {
    headers: async () => ({ authorization: "Bearer sec\u0000ret-token-1234" }),
    attempts: 2,
  });
  // A response stand-in: nothing here needs a socket.
  let text = "";
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead() { this.headersSent = true; return this; },
    end(body?: string) { text += body ?? ""; return this; },
  }) as unknown as http.ServerResponse;
  let thrown: Error | undefined;
  await bad.handle({} as http.IncomingMessage, res, "/v1/messages", { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] } as AnthropicRequest, "m", undefined)
    .catch((error: Error) => { thrown = error; });
  assert.match(text, /unreachable/);
  assert.ok(lines.some((line) => /could not connect/.test(line)), "the retry was logged");
  assert.ok(thrown, "the error still reaches the caller");
  for (const out of [text, ...lines, thrown!.message]) assert.doesNotMatch(out, /ret-token-1234/);
});

test("a credential escaped inside a JSON error body is redacted once the body is decoded", () => {
  const body = JSON.stringify({ error: { message: "bad key PLACEHOLDER" } }).replace("PLACEHOLDER", "\\u0073ecret-xyz");
  assert.match(mapHttpError(401, body).body, /secret-xyz/, "decoded, the escape spells the credential");
  assert.doesNotMatch(mapHttpError(401, body, "P", undefined, (m) => m.replaceAll("secret-xyz", "[REDACTED]")).body, /secret-xyz/);
});

