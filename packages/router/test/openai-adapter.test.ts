import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { OpenAiCompatibleAdapter } from "../src/providers/openai/index.ts";
import { Logger } from "../src/log.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

const seen: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let mode: "chat" | "responses" | "error" = "chat";
const sse = (records: Record<string, unknown>[]) => records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("");

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
    if (mode === "error") {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "missing key" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const records = mode === "chat"
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
const front = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest;
    void adapter.handle(req, res, req.url ?? "/v1/messages", json, "vendor-model", configuredEffort);
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

test("cleanup", () => {
  front.close();
  upstream.close();
});
