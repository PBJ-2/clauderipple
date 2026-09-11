// End-to-end through the adapter with a fake Codex backend: verifies headers, the request we
// send, SSE parsing over real HTTP, streaming translation, non-streaming assembly and error mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ChatGptAdapter } from "../src/providers/chatgpt/index.ts";
import { Logger } from "../src/log.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-gpt-"));
fs.writeFileSync(path.join(home, "chatgpt-auth.json"), JSON.stringify({ accessToken: "tok_test", accountId: "acct_test", expiresAt: Date.now() + 3600_000, source: "own" }));

type Seen = { headers: http.IncomingHttpHeaders; body: Record<string, unknown>; path: string };
const seen: Seen[] = [];
let mode: "stream" | "error429" | "sse-error" = "stream";

const sse = (evs: Record<string, unknown>[]): string => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const happy = [
  { type: "codex.rate_limits", plan_type: "prolite", rate_limits: { primary: { used_percent: 42 } } },
  { type: "response.created", response: { id: "resp_x" } },
  { type: "response.output_item.added", item: { type: "message", id: "m1" } },
  { type: "response.output_text.delta", delta: "Hi", item_id: "m1" },
  { type: "response.output_item.done", item: { type: "message", id: "m1" } },
  { type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "call_1", name: "Read", arguments: "" } },
  { type: "response.function_call_arguments.delta", delta: '{"file_path":"a"}', item_id: "fc1" },
  { type: "response.function_call_arguments.done", arguments: '{"file_path":"a"}', item_id: "fc1" },
  { type: "response.output_item.done", item: { type: "function_call", id: "fc1" } },
  { type: "response.completed", response: { id: "resp_x", usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 450 }, output_tokens: 7 } } },
];

const backend = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, path: req.url ?? "" });
    if (mode === "error429") {
      res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The usage limit has been reached", type: "usage_limit_reached" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "sse-error") {
      res.end(sse([{ type: "response.created", response: {} }, { type: "error", error: { code: "server_is_overloaded", message: "overloaded" } }]));
      return;
    }
    const body = sse(happy);
    // deliver in awkward chunk boundaries to exercise the parser
    let i = 0;
    const step = (): void => {
      if (i >= body.length) return void res.end();
      const n = 37 + ((i * 7) % 50);
      res.write(body.slice(i, i + n));
      i += n;
      setTimeout(step, 1);
    };
    step();
  });
});

const log = new Logger(null, 1e9, 0, false);
let adapter: ChatGptAdapter;
const front = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const json = JSON.parse(Buffer.concat(chunks).toString()) as AnthropicRequest;
    void adapter.handle(req, res, req.url ?? "/v1/messages", json, "gpt-5.6-terra", "high");
  });
});

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as { port: number }).port;
}

const backendPort = await listen(backend);
const frontPort = await listen(front);
adapter = new ChatGptAdapter("chatgpt", { type: "chatgpt", auth: "own", url: `http://127.0.0.1:${backendPort}`, instructionsAppend: "Be brief." }, home, log);

function call(body: unknown, p = "/v1/messages"): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: frontPort, method: "POST", path: p, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

const request: AnthropicRequest = { model: "claude-opus-4-6", stream: true, system: "sys", messages: [{ role: "user", content: "read a" }], tools: [{ name: "Read", input_schema: { type: "object" } }] };

test("streaming: headers, request body, and translated Anthropic SSE", async () => {
  mode = "stream";
  const r = await call(request);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/event-stream");
  const s = seen.at(-1)!;
  assert.equal(s.path, "/codex/responses");
  assert.equal(s.headers.authorization, "Bearer tok_test");
  assert.equal(s.headers["chatgpt-account-id"], "acct_test");
  assert.equal(s.headers["openai-beta"], "responses=experimental");
  assert.equal(s.headers.originator, "codex_cli_rs");
  assert.equal(s.body.model, "gpt-5.6-terra");
  assert.equal(s.body.stream, true);
  assert.equal(s.body.store, false);
  assert.ok(String(s.body.instructions).endsWith("Be brief."));
  assert.deepEqual(s.body.reasoning, { effort: "high", summary: "auto" });
  const events = r.text.split("\n\n").filter(Boolean).map((f) => f.split("\n")[0]!.replace("event: ", ""));
  assert.equal(events[0], "message_start");
  assert.deepEqual(events.slice(-2), ["message_delta", "message_stop"]);
  assert.ok(r.text.includes('"text_delta","text":"Hi"'));
  assert.ok(r.text.includes('"partial_json":"{\\"file_path\\":\\"a\\"}"'));
  assert.ok(r.text.includes('"cache_read_input_tokens":450'));
  assert.equal(adapter.lastRateLimits?.plan_type, "prolite");
});

test("non-streaming: assembled message", async () => {
  mode = "stream";
  const r = await call({ ...request, stream: false });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.text) as { content: { type: string }[]; stop_reason: string; usage: { input_tokens: number } };
  assert.deepEqual(j.content.map((c) => c.type), ["text", "tool_use"]);
  assert.equal(j.stop_reason, "tool_use");
  assert.equal(j.usage.input_tokens, 50);
});

test("count_tokens is answered locally", async () => {
  const before = seen.length;
  const r = await call(request, "/v1/messages/count_tokens");
  assert.equal(r.status, 200);
  assert.ok(JSON.parse(r.text).input_tokens > 0);
  assert.equal(seen.length, before, "no upstream call");
});

test("HTTP 429 upstream → Anthropic rate_limit_error 429", async () => {
  mode = "error429";
  const r = await call(request);
  assert.equal(r.status, 429);
  assert.equal(JSON.parse(r.text).error.type, "rate_limit_error");
});

test("SSE error event → streamed Anthropic error event", async () => {
  mode = "sse-error";
  const r = await call(request);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes("event: error"));
  assert.ok(r.text.includes("overloaded_error"));
});

test("cleanup", () => {
  backend.close();
  front.close();
});
