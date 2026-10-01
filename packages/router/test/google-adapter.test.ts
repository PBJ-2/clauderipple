import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GoogleAdapter, googleLooksLikeAuth, googleRetryDelayMs } from "../src/providers/google/index.ts";
import { Logger } from "../src/log.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

const seen: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let mode: "text" | "tool" | "cut" | "badkey" = "text";
const sse = (records: Record<string, unknown>[]) => records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("");

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
    if (mode === "badkey") {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "API_KEY_INVALID" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "cut") {
      // A stream that stops with no finishReason and no usage, as a stalled vendor's did (§5 muse).
      res.end(sse([{ candidates: [{ content: { parts: [{ text: "Hal" }] } }] }]));
      return;
    }
    if (mode === "tool") {
      res.end(sse([
        { candidates: [{ content: { parts: [{ text: "Let me read." }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: "Read", args: { file_path: "a.ts" } }, thoughtSignature: "SIG-1" }] } }], usageMetadata: { promptTokenCount: 40, cachedContentTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 3 } },
        { candidates: [{ finishReason: "STOP" }] },
      ]));
      return;
    }
    const body = sse([
      { candidates: [{ content: { parts: [{ text: "Hi " }] } }] },
      { candidates: [{ content: { parts: [{ text: "there" }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 40, cachedContentTokenCount: 30, candidatesTokenCount: 5 } },
    ]);
    // Odd chunks exercise the SSE parser's frame boundaries.
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-google-adapter-"));
let adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
const front = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest;
    void adapter.handle(req, res, req.url ?? "/v1/messages", json, "gemini-3-pro-preview", "high");
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

test("adapter streams text, carries the API key, and maps usage", async () => {
  mode = "text";
  adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
  const response = await call(request);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/event-stream/);
  const sent = seen.at(-1)!;
  assert.equal(sent.path, "/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse");
  assert.equal(sent.headers["x-goog-api-key"], "test-key");
  assert.equal(sent.body.model, undefined, "the model goes in the path, not the body");
  assert.deepEqual((sent.body.contents as { role: string }[]).map((c) => c.role), ["user"]);
  assert.match(response.text, /"text":"Hi "/);
  assert.match(response.text, /"text":"there"/);
  assert.match(response.text, /"cache_read_input_tokens":30/);
  assert.match(response.text, /"stop_reason":"end_turn"/);
});

test("a function call carries its signature into the store and it is replayed on the next turn", async () => {
  mode = "tool";
  adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
  const response = await call(request);
  assert.match(response.text, /"type":"tool_use"/);
  const id = /"id":"(toolu_[0-9a-f]+)"/.exec(response.text)?.[1];
  assert.ok(id, "the tool_use id is minted as toolu_…");
  assert.equal(adapter.signatureCount, 1, "SIG-1 was remembered against the minted id");

  // The next turn replays that call from Claude Code's history; the signature must ride back on it.
  const replay: AnthropicRequest = {
    ...request,
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: [{ type: "tool_use", id: id!, name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id!, content: "ok" }] },
    ],
  };
  await call(replay);
  const contents = seen.at(-1)!.body.contents as { role: string; parts: { functionCall?: { name?: string }; thoughtSignature?: string }[] }[];
  const modelTurn = contents.find((c) => c.role === "model")!;
  // The signature is a sibling of functionCall on the same part, not a field inside functionCall.
  assert.equal(modelTurn.parts[0]?.thoughtSignature, "SIG-1");
});

test("a stream cut off with no finishReason ends in a retryable overloaded_error", async () => {
  mode = "cut";
  adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
  const response = await call(request);
  assert.match(response.text, /"type":"overloaded_error"/);
  assert.doesNotMatch(response.text, /message_stop/);
});

test("a 400 with API_KEY_INVALID maps to an Anthropic authentication_error", async () => {
  mode = "badkey";
  adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
  const response = await call(request);
  assert.equal(response.status, 401);
  assert.equal((JSON.parse(response.text) as { error: { type: string } }).error.type, "authentication_error");
  // 401 and a body that names the key are auth; a bare 403 is a permission/region/policy problem.
  assert.equal(googleLooksLikeAuth(401, ""), true);
  assert.equal(googleLooksLikeAuth(400, JSON.stringify({ error: { status: "API_KEY_INVALID" } })), true);
  assert.equal(googleLooksLikeAuth(400, JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "bad field" } })), false);
  assert.equal(googleLooksLikeAuth(403, JSON.stringify({ error: { status: "PERMISSION_DENIED" } })), true);
  assert.equal(googleLooksLikeAuth(403, ""), false, "a bare 403 is a permission problem, not a bad key");
});

test("a Google 429 states its wait in a RetryInfo detail, not a header", () => {
  const body = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37.2s" }] } });
  assert.equal(googleRetryDelayMs(body), 37_200);
  assert.equal(googleRetryDelayMs(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } })), undefined);
});

test("count tokens is local and an antigravity provider with no account says so by name", async () => {
  const before = seen.length;
  const response = await call(request, "/v1/messages/count_tokens");
  assert.equal(response.status, 200);
  assert.ok((JSON.parse(response.text) as { input_tokens: number }).input_tokens > 0);
  assert.equal(seen.length, before, "no upstream call for a local count");

  const restore = adapter;
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "cr-google-empty-"));
  adapter = new GoogleAdapter("ag", { type: "google", auth: "antigravity" }, emptyHome, log);
  const refused = await call(request);
  adapter = restore;
  assert.equal(refused.status, 401);
  assert.match(refused.text, /no Google account: run `clauderipple google-login`/);
});

test("cleanup", () => {
  front.close();
  upstream.close();
});
