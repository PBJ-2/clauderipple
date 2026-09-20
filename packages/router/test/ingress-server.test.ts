import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { OpenAiIngress } from "../src/ingress/server.ts";
import { Logger } from "../src/log.ts";
import { ClaudeAccountAuthPool } from "../src/providers/anthropic-account-pool.ts";
import { saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";
import { ClaudeCodeAuthStore, ClaudeCodeCredentialStore } from "../src/providers/anthropic.ts";
import { RequestLog } from "../src/requestlog.ts";
import type { Config } from "../src/config.ts";

const seen: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
    const body = seen.at(-1)!.body;
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":8,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":12,"cache_read_input_tokens":8,"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 12, cache_read_input_tokens: 8, output_tokens: 2 } }));
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

const upstreamPort = await listen(upstream);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-"));
const config: Config = {
  listen: { host: "127.0.0.1", port: 30000, openaiPort: 0 },
  upstream: "api.anthropic.com",
  providers: { local: { type: "anthropic-compatible", url: `http://127.0.0.1:${upstreamPort}`, headers: { "x-api-key": "upstream-key" } } },
  routes: { "claude-sonnet-5": { provider: "local", model: "claude-sonnet-5" } },
  direct: [], aliases: {}, effortClamp: { ultra: "max" }, cli: { extraModels: [] }, health: { maxConsecutiveUpstreamFailures: 20 }, log: { maxBytes: 1e6, keep: 1 },
};
const log = new Logger(null, 1e9, 0, false);
const requests = new RequestLog(path.join(root, "requests.jsonl"));
const ingress = new OpenAiIngress({ config: () => config, log, requests });
const ingressPort = await ingress.listen();

async function call(pathname: string, body?: unknown, port = ingressPort): Promise<{ status: number; text: string }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer local", ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    if (data) req.end(data); else req.end();
  });
}

const input = { model: "claude-sonnet-5", instructions: "system", input: "say ok", max_output_tokens: 16 };

test("models endpoint lists mapped IDs", async () => {
  const response = await call("/v1/models");
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text).data.map((model: { id: string }) => model.id), ["claude-sonnet-5"]);
});

test("Responses non-stream and stream traverse fake Anthropic-compatible provider", async () => {
  const nonstream = await call("/v1/responses", input);
  assert.equal(nonstream.status, 200);
  assert.equal(JSON.parse(nonstream.text).output[0].content[0].text, "ok");
  const stream = await call("/v1/responses", { ...input, stream: true });
  assert.equal(stream.status, 200);
  assert.match(stream.text, /event: response\.output_text\.delta/);
  assert.match(stream.text, /"cached_tokens":8/);
  assert.equal(seen.at(-1)?.headers.authorization, undefined, "local client bearer token is never forwarded");
  assert.equal(seen.at(-1)?.headers["x-api-key"], "upstream-key");
});

test("Chat Completions non-stream and stream traverse same provider", async () => {
  const body = { model: "claude-sonnet-5", messages: [{ role: "user", content: "say ok" }], tools: [{ type: "function", function: { name: "Read", description: "read", parameters: { type: "object" } } }] };
  const nonstream = await call("/v1/chat/completions", body);
  assert.equal(nonstream.status, 200);
  assert.equal(JSON.parse(nonstream.text).choices[0].message.content, "ok");
  const stream = await call("/v1/chat/completions", { ...body, stream: true });
  assert.equal(stream.status, 200);
  assert.match(stream.text, /data: \[DONE\]/);
  assert.match(stream.text, /"content":"ok"/);
  assert.equal((seen.at(-1)?.body.tools as { name?: string }[] | undefined)?.[0]?.name, "Read");
  assert.equal(requests.list(10)[0]?.note, "openai-ingress chat");
});

test("Responses reject previous_response_id to remain stateless", async () => {
  const response = await call("/v1/responses", { ...input, previous_response_id: "resp_old" });
  assert.equal(response.status, 400);
  assert.match(response.text, /previous_response_id unsupported/);
});

test("native ingress uses one added Claude account without enabling failover", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-claude-account-"));
  const nativeSeen: http.IncomingHttpHeaders[] = [];
  const native = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      nativeSeen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_native", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const nativePort = await listen(native);
  saveClaudeOAuthAccount(home, { accessToken: "added-access", refreshToken: "added-refresh", expiresAt: Date.now() + 3_600_000, accountId: "added-account" });
  const now = Date.now;
  const noCurrent = new ClaudeCodeAuthStore(new ClaudeCodeCredentialStore(() => null, now), { home, env: {}, now });
  const claudeAccounts = new ClaudeAccountAuthPool({ home, current: noCurrent, log });
  const nativeConfig: Config = {
    ...config,
    providers: { claude: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-sonnet-5" }] } },
    routes: { "claude-sonnet-5": { provider: "claude", model: "claude-sonnet-5" } },
  };
  const nativeIngress = new OpenAiIngress({ config: () => nativeConfig, log, requests, home, claudeAccounts, nativeUpstream: `http://127.0.0.1:${nativePort}` });
  const nativeIngressPort = await nativeIngress.listen();
  try {
    const response = await call("/v1/responses", input, nativeIngressPort);
    assert.equal(response.status, 200);
    assert.equal(nativeSeen.length, 1);
    assert.equal(nativeSeen[0]!.authorization, "Bearer added-access");
  } finally {
    await nativeIngress.drain(1);
    await new Promise<void>((resolve) => native.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cleanup", async () => {
  await ingress.drain(1);
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
