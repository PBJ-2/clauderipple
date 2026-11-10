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
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import { RequestLog } from "../src/requestlog.ts";
import type { Config } from "../src/config.ts";

const noClaudeCodeCredentialReaders = { keychain: () => null, credentialsFile: () => null };
const seen: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let upstreamStopReason = "end_turn";
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
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: upstreamStopReason }, usage: { input_tokens: 12, cache_read_input_tokens: 8, output_tokens: 2 } })}\n\n`,
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: upstreamStopReason, usage: { input_tokens: 12, cache_read_input_tokens: 8, output_tokens: 2 } }));
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
const ingress = new OpenAiIngress({ config: () => config, log, requests, claudeCodeCredentialReaders: noClaudeCodeCredentialReaders });
const ingressPort = await ingress.listen();

async function call(pathname: string, body?: unknown, port = ingressPort): Promise<{ status: number; text: string }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer local", ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      res.on("error", reject);
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

// Issue #104: this is the body Codex sends for /compact against a Claude model (transcript, then the
// remote-compaction control item). Anthropic refuses it when it arrives with an assistant last turn.
test("Codex /compact body reaches the provider ending with a user message", async () => {
  const response = await call("/v1/responses", {
    model: "claude-sonnet-5",
    instructions: "system",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "add a test" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I added it." }] },
      { type: "compaction_trigger" },
    ],
    max_output_tokens: 16,
  });
  assert.equal(response.status, 200);
  const messages = seen.at(-1)?.body.messages as { role: string }[];
  assert.equal(messages.at(-2)?.role, "assistant", "the transcript is unchanged");
  assert.equal(messages.at(-1)?.role, "user");
});

for (const stream of [true, false]) {
  test(`Codex compaction round trip restores summary (${stream ? "stream" : "JSON"})`, async () => {
    const response = await call("/v1/responses", {
      ...input, stream,
      input: [
        { type: "message", role: "user", content: "add a test" },
        { type: "message", role: "assistant", content: "I added it." },
        { type: "compaction_trigger" },
      ],
    });
    assert.equal(response.status, 200);
    let output: Record<string, unknown>[];
    if (stream) {
      const events = response.text.split("\n").filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
      const done = events.filter((event) => event.type === "response.output_item.done");
      assert.equal(done.length, 1);
      const item = done[0]!.item as Record<string, unknown>;
      assert.equal(item.type, "compaction");
      assert.deepEqual(events.map((event) => event.type), [
        "response.created", "response.output_item.added", "response.output_item.done", "response.completed",
      ]);
      assert.deepEqual(events[1]!.item, item);
      output = (events.at(-1)!.response as { output: Record<string, unknown>[] }).output;
      assert.deepEqual(output, [item]);
    } else {
      output = (JSON.parse(response.text) as { output: Record<string, unknown>[] }).output;
    }
    assert.equal(output.length, 1);
    assert.equal(output[0]!.type, "compaction");
    assert.equal(typeof output[0]!.encrypted_content, "string");
    const next = await call("/v1/responses", {
      ...input, input: [...output, { type: "message", role: "user", content: "continue" }],
    });
    assert.equal(next.status, 200);
    assert.deepEqual(seen.at(-1)!.body.messages, [
      { role: "user", content: [{ type: "text", text: "Summary of the earlier conversation: ok" }] },
      { role: "user", content: [{ type: "text", text: "continue", cache_control: { type: "ephemeral" } }] },
    ]);
    assert.equal(JSON.parse(next.text).output[0].type, "message", "ordinary turns stay ordinary");
  });
}

test("foreign compaction is logged once without leaking its opaque content", async () => {
  const warnings: string[] = [];
  const warn = log.warn;
  log.warn = (message: string) => { warnings.push(message); };
  try {
    const response = await call("/v1/responses", { ...input, input: [
      { type: "compaction", encrypted_content: "foreign-opaque-content" },
      { type: "message", role: "user", content: "continue" },
    ] });
    assert.equal(response.status, 200);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /ignored foreign compaction/);
    assert.ok(!warnings[0]!.includes("foreign-opaque-content"));
    assert.deepEqual(seen.at(-1)!.body.messages, [
      { role: "user", content: [{ type: "text", text: "continue", cache_control: { type: "ephemeral" } }] },
    ]);
  } finally {
    log.warn = warn;
  }
});

test("truncated compaction fails over HTTP without a successful compaction response", async () => {
  upstreamStopReason = "max_tokens";
  try {
    const body = { ...input, input: [{ type: "compaction_trigger" }] };
    const response = await call("/v1/responses", body);
    assert.equal(response.status, 502);
    assert.equal(JSON.parse(response.text).output, undefined);
    assert.match(response.text, /Compaction did not finish/);
    await assert.rejects(call("/v1/responses", { ...body, stream: true }), /aborted|socket hang up/);
    assert.equal(requests.list(1)[0]?.status, 502);
  } finally {
    upstreamStopReason = "end_turn";
  }
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

test("an ingress turn on the current Claude login snapshots that login's email", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-current-"));
  const nativeSeen: http.IncomingHttpHeaders[] = [];
  const native = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      nativeSeen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_native", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const nativePort = await listen(native);
  const observed = new ObservedClaudeCodeAuth();
  observed.observe(["authorization", "Bearer ingress-login", "anthropic-version", "2023-06-01"]);
  const nativeConfig: Config = {
    ...config,
    providers: { claude: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-sonnet-5" }] } },
    routes: { "claude-sonnet-5": { provider: "claude", model: "claude-sonnet-5" } },
  };
  const nativeIngress = new OpenAiIngress({ config: () => nativeConfig, log, requests, home, observedClaudeCodeAuth: observed, claudeCodeCredentialReaders: noClaudeCodeCredentialReaders, nativeUpstream: `http://127.0.0.1:${nativePort}`, claudeIdentity: async () => ({ email: "ingress@example.test" }) });
  const nativeIngressPort = await nativeIngress.listen();
  try {
    const response = await call("/v1/responses", input, nativeIngressPort);
    assert.equal(response.status, 200);
    assert.equal(nativeSeen[0]!.authorization, "Bearer ingress-login");
    const row = requests.list(1)[0]!;
    assert.equal(row.account, "current");
    assert.equal(row.accountEmail, "ingress@example.test");
    assert.doesNotMatch(JSON.stringify(row), /ingress-login/, "no token in the row");
  } finally {
    await nativeIngress.drain(1);
    await new Promise<void>((resolve) => native.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
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
  const account = saveClaudeOAuthAccount(home, { accessToken: "added-access", refreshToken: "added-refresh", expiresAt: Date.now() + 3_600_000, accountId: "added-account" });
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
    assert.equal(requests.list(1)[0]!.account, account.id);
  } finally {
    await nativeIngress.drain(1);
    await new Promise<void>((resolve) => native.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cleanup", async () => {
  await ingress.drain(1);
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});
