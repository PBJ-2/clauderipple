import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import { setCurrentClaudeAccountPaused } from "../src/providers/anthropic-accounts.ts";
import { RequestLog } from "../src/requestlog.ts";
import { createCa, createLeaf } from "../src/x509.ts";

const noClaudeCodeCredentialReaders = { keychain: () => null, credentialsFile: () => null };

async function rig(options: { respond?: (res: http.ServerResponse) => void; healthLimit?: number } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-log-metadata-"));
  const ca = createCa({ cn: "request log test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  fs.writeFileSync(path.join(home, "chatgpt-auth.json"), JSON.stringify({ accessToken: "test-token", accountId: "test-account", expiresAt: Date.now() + 3600_000, source: "own" }));
  const seen: Record<string, unknown>[] = [];
  const seenAuth: (string | undefined)[] = [];
  let responseStatus = 200;
  let imageStatus = 200;
  const respond = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      seen.push(body);
      seenAuth.push(req.headers.authorization);
      if (options.respond) { options.respond(res); return; }
      if ((body.tools as { type?: string }[] | undefined)?.some((tool) => tool.type === "image_generation")) {
        if (imageStatus !== 200) {
          res.writeHead(imageStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "image backend failed" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          { type: "response.created", response: {} },
          { type: "response.output_item.done", item: { id: "ig_1", type: "image_generation_call", output_format: "png", quality: "low", size: "1536x1024", result: Buffer.from("PNGDATA").toString("base64") } },
          { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
        return;
      }
      const model = body.model ?? (req.url?.includes("gemini-test") ? "gemini-test" : undefined);
      const events = model === "gpt-test" || model === "responses-test"
        ? [{ type: "response.output_text.delta", delta: "answer" }, { type: "response.completed", response: { service_tier: "default", usage: { input_tokens: 10, output_tokens: 2 } } }]
        : model === "gemini-test"
          ? [{ candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }]
          : model === "chat-test"
            ? [{ service_tier: "default", choices: [{ delta: { content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }]
            : [{ type: "message_start", message: { id: "msg_upstream", usage: { input_tokens: 10, cache_creation_input_tokens: 0, service_tier: "standard" } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }];
      if (model === "gemini-test" && !req.url?.includes("streamGenerateContent")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(events[0]));
        return;
      }
      if (model === "compatible-test" && body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_upstream", usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, service_tier: "standard" } }));
        return;
      }
      res.writeHead(responseStatus, { "content-type": "text/event-stream", "request-id": "req_final" });
      const end = (): void => { res.end(responseStatus === 200 ? events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") : '{"error":{"message":"backend failed"}}'); };
      if (body.hold) setTimeout(end, 100);
      else end();
    });
  };
  const backend = http.createServer(respond);
  const native = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, respond);
  await Promise.all([backend, native].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const url = `http://127.0.0.1:${(backend.address() as net.AddressInfo).port}`;
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const cfg: Config = { ...DEFAULTS, upstream: "localhost", listen: { host: "127.0.0.1", port }, routes: {}, direct: [], aliases: {}, providers: {
    gpt: { type: "chatgpt", auth: "own", url, models: [{ id: "gpt-test" }] },
    chat: { type: "openai-compatible", url, models: [{ id: "chat-test" }] },
    responses: { type: "openai-compatible", wire: "responses", url, models: [{ id: "responses-test" }] },
    google: { type: "google", auth: "api-key", apiKey: "test-key", url, models: [{ id: "gemini-test" }] },
    compatible: { type: "anthropic-compatible", url, models: [{ id: "compatible-test" }] },
    claude: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-pool" }] },
  } };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const agent = new https.Agent({ ca: ca.certPem, lookup: (_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]) });
  const observed = new ObservedClaudeCodeAuth();
  const trips: number[] = [];
  const health = new UpstreamHealth(() => options.healthLimit ?? 100, (n) => trips.push(n));
  const proxy = new Proxy({ config: () => cfg, home, requests, claudeCodeCredentialReaders: noClaudeCodeCredentialReaders, observedClaudeCodeAuth: observed, agentDir: path.join(home, "agents"), certs: new CertStore(home), log: new Logger(path.join(home, "router.log"), 1e6, 1, false), health, upstreamPort: (native.address() as net.AddressInfo).port, upstreamAgent: agent });
  await proxy.listen();
  const send = async (model: string, extra: Record<string, unknown> = {}, pathname = "/v1/messages", beforeSend?: (socket: tls.TLSSocket) => void, headers: Record<string, string> = {}) => {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve) => secure.once("secureConnect", resolve));
    const body = JSON.stringify({ model, max_tokens: 16, stream: true, messages: [{ role: "user", content: "private-prompt" }], ...extra });
    const result = new Promise<string>((resolve, reject) => {
      let text = "";
      secure.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        const split = text.indexOf("\r\n\r\n");
        if (split < 0) return;
        const length = /content-length:\s*(\d+)/i.exec(text.slice(0, split));
        if (text.endsWith("\r\n0\r\n\r\n") || (length && Buffer.byteLength(text.slice(split + 4)) >= Number(length[1]))) resolve(text);
      });
      secure.once("end", () => resolve(text));
      secure.once("close", () => resolve(text));
      secure.once("error", reject);
    });
    beforeSend?.(secure);
    const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\r\n");
    secure.write(`POST ${pathname} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}${headerLines ? `\r\n${headerLines}` : ""}\r\n\r\n${body}`);
    const text = await result;
    secure.destroy();
    return { text, record: requests.list(1)[0]! };
  };
  return { cfg, seen, seenAuth, home, requests, proxy, observed, send, health, trips, failBackend: () => { responseStatus = 400; }, failImage: () => { imageStatus = 500; }, stop: async () => {
    proxy.close(); agent.destroy();
    await Promise.all([backend, native].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    fs.rmSync(home, { recursive: true, force: true });
  } };
}

test("repeated client cancellations before native headers never trip upstream health", { timeout: 5000 }, async () => {
  let received = Promise.withResolvers<http.ServerResponse>();
  const r = await rig({ respond: (res) => received.resolve(res), healthLimit: 2 });
  try {
    for (let i = 0; i < 3; i++) {
      let client: tls.TLSSocket | undefined;
      const sent = r.send("claude-native", {}, "/v1/messages", (socket) => { client = socket; });
      const upstream = await received.promise;
      const closed = new Promise<void>((resolve) => upstream.once("close", resolve));
      client!.destroy();
      await sent;
      await closed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(r.health.consecutiveFailures, 0);
      assert.deepEqual(r.trips, []);
      assert.equal(r.requests.list(10).length, i + 1);
      assert.equal(r.requests.list(1)[0]!.status, "aborted");
      assert.equal(r.requests.list(1)[0]!.ok, false);
      received = Promise.withResolvers<http.ServerResponse>();
    }
    assert.equal(r.proxy.stats.inFlight, 0);
    assert.equal(r.proxy.stats.completed, 0);
    assert.equal(r.proxy.stats.failed, 3);
  } finally { await r.stop(); }
});

for (const [model, provider] of [["claude-native", "anthropic"], ["chat-test", "chat"], ["responses-test", "responses"], ["gpt-test", "gpt"], ["gemini-test", "google"]] as const) {
  test(`cancelling ${model} after stream start is recorded once as aborted, not successful`, { timeout: 5000 }, async () => {
    const received = Promise.withResolvers<http.ServerResponse>();
    const r = await rig({ respond: (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(model === "chat-test"
        ? 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
        : model === "responses-test" || model === "gpt-test"
          ? 'data: {"type":"response.created","response":{}}\n\ndata: {"type":"response.output_item.added","item":{"id":"msg_partial","type":"message"}}\n\ndata: {"type":"response.output_text.delta","item_id":"msg_partial","delta":"partial"}\n\n'
          : model === "gemini-test"
            ? 'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'
            : 'data: {"type":"message_start","message":{"id":"msg_partial"}}\n\n');
      received.resolve(res);
    } });
    try {
      const exhaustion = { reason: "quota_exhausted" as const, at: Date.now(), until: Date.now() + 60_000 };
      r.proxy.providerHealth.observe(provider, 429, exhaustion);
      const started = Promise.withResolvers<void>();
      let client: tls.TLSSocket | undefined;
      const sent = r.send(model, {}, "/v1/messages", (socket) => {
        client = socket;
        socket.once("data", () => started.resolve());
      });
      const upstream = await received.promise;
      const closed = new Promise<void>((resolve) => upstream.once("close", resolve));
      await started.promise;
      client!.destroy();
      await sent;
      await closed;
      while (r.proxy.stats.inFlight > 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
      assert.equal(r.requests.list(10).length, 1);
      const record = r.requests.list(1)[0]!;
      assert.equal(record.ok, false);
      assert.equal(record.status, "aborted");
      assert.equal(record.stopReason, undefined);
      assert.equal(r.proxy.stats.completed, 0);
      assert.equal(r.proxy.stats.failed, 1);
      assert.equal(r.health.consecutiveFailures, 0);
      if (provider === "chat" || provider === "responses") {
        assert.deepEqual(r.proxy.providerHealth.snapshot()[provider], exhaustion, "a cancelled OpenAI turn must not clear an earlier provider exhaustion as a success");
      }
    } finally { await r.stop(); }
  });
}

test("real native connection resets still count toward upstream health", { timeout: 5000 }, async () => {
  const r = await rig({ respond: (res) => res.destroy(), healthLimit: 2 });
  try {
    for (let i = 0; i < 2; i++) {
      const { text, record } = await r.send("claude-native");
      assert.match(text, /^HTTP\/1\.1 502/);
      assert.equal(record.ok, false);
    }
    assert.equal(r.health.consecutiveFailures, 2);
    assert.deepEqual(r.trips, [2]);
  } finally { await r.stop(); }
});

test("proxy finish correlates every translated message and records actual service tiers", async () => {
  const r = await rig();
  try {
    for (const model of ["gpt-test", "chat-test", "responses-test", "gemini-test", "compatible-test"]) {
      for (const stream of [true, false]) {
        const { text, record } = await r.send(model, { stream, speed: "fast", service_tier: "not-forwarded-by-translators" });
        assert.ok(record.messageId, `${model} stream=${stream}: ${record.note ?? ""}`);
        assert.ok(text.includes(`"id":"${record.messageId}"`));
        assert.equal(record.upstreamRequestId, undefined);
        assert.equal(record.upstreamCalled, undefined);
        assert.equal(record.purpose, undefined);
        assert.equal(record.usage?.cacheWrite, model === "compatible-test" ? 0 : undefined);
        assert.equal(record.requestedTier, model === "gpt-test" ? "priority" : model === "compatible-test" ? "not-forwarded-by-translators" : undefined);
        assert.equal(record.servedTier, model === "gemini-test" ? undefined : model === "compatible-test" ? "standard" : "default");
        if (model === "gpt-test") {
          assert.equal(r.seen.at(-1)!.service_tier, "priority");
          assert.match(record.note!, / fast$/);
        }
      }
    }
    assert.doesNotMatch(fs.readFileSync(path.join(r.home, "requests.jsonl"), "utf8"), /private-prompt|test-token|test-key/);
    r.failBackend();
    const failed = await r.send("gpt-test", { stream: false, speed: "fast" });
    assert.equal(failed.record.messageId, undefined);
    assert.equal(failed.record.requestedTier, "priority");
    assert.equal(failed.record.servedTier, undefined);
    const count = await r.send("gpt-test", {}, "/v1/messages/count_tokens");
    assert.equal(count.record.messageId, undefined);
    assert.equal(count.record.requestedTier, undefined);
  } finally { await r.stop(); }
});

test("the agent header marks a subagent's turn, and the provider's Fast switch asks for the Codex tier", async () => {
  const r = await rig();
  try {
    const gpt = r.cfg.providers.gpt as { type: "chatgpt"; auth: "own"; url: string; models: { id: string }[]; fast?: { main?: boolean; subagent?: boolean } };
    r.cfg.providers.gpt = { ...gpt, fast: { subagent: true } };
    // A main session's own turn: no agent header, so the subagent switch does not reach it.
    const main = await r.send("gpt-test");
    assert.equal(r.seen.at(-1)!.service_tier, undefined);
    assert.equal(main.record.subagent, undefined);
    assert.equal(main.record.requestedTier, undefined);
    // A subagent's turn: the header is there, so the switch asks for the fast tier.
    const subagent = await r.send("gpt-test", {}, "/v1/messages", undefined, { "x-claude-code-agent-id": "agent_1" });
    assert.equal(r.seen.at(-1)!.service_tier, "priority");
    assert.equal(subagent.record.subagent, true);
    assert.equal(subagent.record.requestedTier, "priority", "the tier asked for is the tier recorded");
    // The header is recorded for any provider, so its arrival can be measured.
    const other = await r.send("chat-test", {}, "/v1/messages", undefined, { "x-claude-code-agent-id": "agent_2" });
    assert.equal(other.record.provider, "chat");
    assert.equal(other.record.subagent, true);
  } finally { await r.stop(); }
});

test("conversation identity separates agents in one session and survives model/prompt changes with an agent header", async () => {
  const r = await rig();
  try {
    const headers = { "x-claude-code-session-id": "shared-session" };
    const main = (await r.send("gpt-test", {}, "/v1/messages", undefined, headers)).record;
    const worker = (await r.send("gpt-test", {}, "/v1/messages", undefined, { ...headers, "x-claude-code-agent-id": "private-agent-one" })).record;
    const next = (await r.send("chat-test", { messages: [{ role: "user", content: "changed after compaction" }] }, "/v1/messages", undefined, { ...headers, "x-claude-code-agent-id": "private-agent-one" })).record;
    const other = (await r.send("gpt-test", {}, "/v1/messages", undefined, { ...headers, "x-claude-code-agent-id": "private-agent-two" })).record;
    assert.match(main.conversation!, /^[a-f0-9]{32}$/);
    assert.notEqual(main.conversation, worker.conversation);
    assert.equal(worker.conversation, next.conversation);
    assert.notEqual(other.conversation, worker.conversation);
    const summary = r.requests.usage(0, Date.now() + 1);
    assert.equal(summary.total.conversationTokens, 3 * 10 + 4 * 2);
    assert.equal(summary.total.ungroupedRequests, 0);
    assert.doesNotMatch(fs.readFileSync(path.join(r.home, "requests.jsonl"), "utf8"), /private-prompt|private-agent|changed after compaction/);
  } finally { await r.stop(); }
});

test("proxy generateImage records the image traffic, with usage on success and a failure record", async () => {
  const r = await rig();
  try {
    const image = await r.proxy.generateImage({ prompt: "a boat", aspect: "square", format: "png", images: [{ mediaType: "image/png", data: "QUJD" }] }, undefined, { session: "session-1" });
    assert.equal(image.data.toString(), "PNGDATA");
    assert.deepEqual(image.usage, { input: 10, cached: 0, output: 2 });
    const record = r.requests.list(1, { kind: "image" })[0]!;
    assert.deepEqual(
      { kind: record.kind, source: record.source, target: record.target, provider: record.provider, stream: record.stream, ok: record.ok, status: record.status, session: record.session, note: record.note },
      { kind: "image", source: "gpt-test", target: "image", provider: "gpt", stream: false, ok: true, status: 200, session: "session-1", note: "1536x1024 low png, 1 reference(s)" },
    );
    assert.deepEqual(record.usage, { input: 10, cached: 0, output: 2 });
    assert.match(record.at, /^\d{4}-\d\d-\d\dT/);
    assert.ok(record.ms >= 0);

    r.failImage();
    await assert.rejects(() => r.proxy.generateImage({ prompt: "x" }, undefined, { session: "session-1" }), /HTTP 500/);
    const failed = r.requests.list(1, { kind: "image" })[0]!;
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 502);
    assert.equal(failed.session, "session-1");
    assert.match(failed.note!, /HTTP 500/);
    assert.equal(failed.usage, undefined);
    assert.equal(r.requests.list(10).length, 2, "one record per call, nothing else");

    // A caller that gives up is still recorded, as an abort rather than an upstream failure.
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(() => r.proxy.generateImage({ prompt: "x" }, aborted.signal));
    const abortRecord = r.requests.list(1)[0]!;
    assert.equal(abortRecord.kind, "image");
    assert.equal(abortRecord.ok, false);
    assert.equal(abortRecord.status, "aborted");
  } finally { await r.stop(); }
});

test("proxy logs native request-id and classifier purpose without configuring classifier routing", async () => {
  const r = await rig();
  try {
    const { record } = await r.send("claude-native", { service_tier: "auto", system: "You are a security monitor for autonomous AI coding agents. Check this." });
    assert.equal(record.provider, "anthropic");
    assert.equal(record.target, "claude-native");
    assert.equal(record.upstreamRequestId, "req_final");
    assert.equal(record.messageId, undefined);
    assert.equal(record.purpose, "auto-mode-classifier");
    assert.equal(record.requestedTier, "auto");
    assert.equal(record.servedTier, "standard");
    r.observed.observe(["authorization", "Bearer test-native", "anthropic-version", "2023-06-01"]);
    const pooled = (await r.send("claude-pool")).record;
    assert.equal(pooled.provider, "claude");
    assert.equal(pooled.upstreamRequestId, "req_final");
    assert.equal(pooled.messageId, undefined);
    assert.equal(pooled.purpose, undefined);
    assert.equal(pooled.requestedTier, undefined);
  } finally { await r.stop(); }
});

test("with no usable pool account, a Claude pool turn goes out on the app's own sign-in instead of a 401 (#88)", async () => {
  const r = await rig();
  try {
    const { record } = await r.send("claude-pool", {}, "/v1/messages", undefined, { authorization: "Bearer app-own-token" });
    assert.equal(record.provider, "claude");
    assert.equal(record.status, 200);
    assert.equal(record.refusal, undefined);
    assert.equal(r.seenAuth.at(-1), "Bearer app-own-token");
  } finally { await r.stop(); }
});

// The #88 fallback carries the app login too; it must not spend a login the user paused.
test("a paused current Claude login refuses the app's Bearer instead of the empty-pool fallback", async () => {
  const r = await rig();
  try {
    setCurrentClaudeAccountPaused(r.home, true);
    const { text, record } = await r.send("claude-pool", {}, "/v1/messages", undefined, { authorization: "Bearer app-own-token" });
    assert.match(text, /^HTTP\/1\.1 401/);
    assert.equal(record.provider, "claude");
    assert.equal(record.refusal, "no-account");
    assert.equal(record.upstreamCalled, false);
    assert.deepEqual(r.seenAuth, []);
    assert.equal(r.seen.length, 0);

    setCurrentClaudeAccountPaused(r.home, false);
    const resumed = await r.send("claude-pool", {}, "/v1/messages", undefined, { authorization: "Bearer app-own-token" });
    assert.equal(resumed.record.status, 200);
    assert.equal(r.seenAuth.at(-1), "Bearer app-own-token");
  } finally { await r.stop(); }
});

test("proxy records a drain refusal on an already-connected client", async () => {
  const r = await rig();
  try {
    const active = r.send("claude-native", { hold: true });
    while (r.seen.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    let drained: Promise<void> | undefined;
    const { record } = await r.send("chat-test", {}, "/v1/messages", () => { drained = r.proxy.drain(2000); });
    assert.equal(record.refusal, "drain");
    assert.equal(record.upstreamCalled, false);
    assert.equal(record.resent, true);
    assert.equal(record.messageId, undefined);
    await active;
    await drained;
    assert.equal(r.seen.length, 1);
  } finally { await r.stop(); }
});

test("proxy early exits name their actual provider, target and refusal without calling upstream", async () => {
  const r = await rig();
  try {
    for (const [model, provider] of [["gpt-test", "gpt"], ["chat-test", "chat"], ["gemini-test", "google"], ["compatible-test", "compatible"]]) {
      const { record } = await r.send(`${model}@high`, { thread: { type: "continue", previous_message_id: "msg_previous" } });
      assert.equal(record.provider, provider);
      assert.equal(record.target, model);
      assert.equal(record.refusal, "thread-continue");
      assert.equal(record.upstreamCalled, false);
      assert.equal(record.resent, true);
      assert.equal(record.messageId, undefined);
    }
    assert.equal(r.seen.length, 0);
    assert.equal((await r.send("unknown-model")).record.refusal, "unroutable");
    r.cfg.routes["claude-missing-provider"] = { provider: "missing", model: "missing-model" };
    const unknown = (await r.send("claude-missing-provider")).record;
    assert.equal(unknown.provider, "missing");
    assert.equal(unknown.refusal, "unknown-provider");
    assert.equal(unknown.upstreamCalled, false);
    const noAccount = (await r.send("claude-pool")).record;
    assert.equal(noAccount.provider, "claude");
    assert.equal(noAccount.refusal, "no-account");
    assert.equal(noAccount.upstreamCalled, false);
    const search = { messages: [{ role: "user", content: "Perform a web search for the query: test" }], tools: [{ name: "web_search", type: "web_search_20250305" }], tool_choice: { type: "tool", name: "web_search" } };
    const refusedSearch = (await r.send("chat-test", search)).record;
    assert.equal(refusedSearch.refusal, "web-search-unsupported");
    assert.equal(refusedSearch.upstreamCalled, false);
    assert.equal(refusedSearch.purpose, "web-search");
    r.cfg.webSearch = { provider: "compatible", model: "compatible-test" };
    r.cfg.providers.compatible = { type: "anthropic-compatible", url: (r.cfg.providers.chat as { url: string }).url, caps: { serverTools: true } };
    r.failBackend();
    const attemptedSearch = (await r.send("chat-test", search)).record;
    assert.equal(attemptedSearch.refusal, "web-search-unsupported");
    assert.equal(attemptedSearch.upstreamCalled, undefined);
    assert.equal(r.seen.length, 1);
  } finally { await r.stop(); }
});
