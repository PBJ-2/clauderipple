// A routed request must authenticate as the provider and only as the provider. The caller's own
// Anthropic credentials are dropped: the provider header replaces only the one it shares a name
// with, so before this was enforced the other one travelled on to a third-party endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { providerExhaustion, UpstreamHealth, type ProviderExhaustion } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy, errorSnippet } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import zlib from "node:zlib";
import { createCa } from "../src/x509.ts";

const CLIENT_TOKEN = "Bearer sk-ant-oat01-CLIENTTOKEN";
const CLIENT_KEY = "CLIENT-X-API-KEY";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type ProviderReply = { status: number; headers: Record<string, string>; body: Buffer };
const OK_REPLY: ProviderReply = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [], model: "x", usage: {} })),
};

/** Sends one routed /v1/messages through the proxy; returns the headers the provider saw. */
async function forwardedHeaders(providerHeaders: Record<string, string>): Promise<http.IncomingHttpHeaders> {
  return (await roundTrip(providerHeaders, OK_REPLY)).seen;
}

/** One routed request against a provider that answers `reply`; returns what it saw and what was logged. */
async function roundTrip(
  providerHeaders: Record<string, string>,
  reply: ProviderReply,
  options: { provider?: Partial<Provider>; system?: unknown; body?: Record<string, unknown>; exhausted?: boolean } = {},
): Promise<{ seen: http.IncomingHttpHeaders; seenBody: Record<string, unknown>; records: RequestRecord[]; clientStatus: number; clientBody: string; clientHeaders: http.IncomingHttpHeaders; providerCalls: number; health: Record<string, ProviderExhaustion>; models: Record<string, Record<string, { reason: string }>> }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-proxy-headers-"));
  const ca = createCa({ cn: "clauderipple test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);

  let seen: http.IncomingHttpHeaders = {};
  let seenBody: Record<string, unknown> = {};
  let providerCalls = 0;
  const provider = http.createServer((req, res) => {
    providerCalls++;
    seen = req.headers;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { seenBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { seenBody = {}; }
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const providerPort = (provider.address() as net.AddressInfo).port;
  const proxyPort = await freePort();

  const cfg: Config = {
    ...DEFAULTS,
    listen: { host: "127.0.0.1", port: proxyPort },
    providers: { p: { type: "anthropic-compatible", url: `http://127.0.0.1:${providerPort}/anthropic`, headers: providerHeaders, ...options.provider } as Provider },
    routes: { "claude-opus-4-8": { provider: "p", model: "some-model" } },
    direct: [],
  };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    // A file, not null: a Logger with no file echoes every line to stdout.
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests,
  });
  if (options.exhausted) proxy.providerHealth.observe("p", 402, providerExhaustion(402, "Insufficient Balance"));
  await proxy.listen();

  const sock = net.connect(proxyPort, "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
  await new Promise<void>((r) => sock.once("data", () => r()));
  const secure = tls.connect({ socket: sock, servername: "api.anthropic.com", ca: ca.certPem });
  await new Promise<void>((r) => secure.once("secureConnect", () => r()));

  const body = JSON.stringify({ model: "claude-opus-4-8", max_tokens: 1, messages: [{ role: "user", content: "hi" }], ...(options.system === undefined ? {} : { system: options.system }), ...options.body });
  secure.write(
    "POST /v1/messages HTTP/1.1\r\n" +
      "Host: api.anthropic.com\r\n" +
      "content-type: application/json\r\n" +
      `authorization: ${CLIENT_TOKEN}\r\n` +
      `x-api-key: ${CLIENT_KEY}\r\n` +
      "anthropic-version: 2023-06-01\r\n" +
      "x-claude-code-session-id: 11111111-2222-4333-8444-555555555555\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
  const first = await new Promise<Buffer>((r) => secure.once("data", (d: Buffer) => setTimeout(() => r(d), 50)));
  const firstText = first.toString("latin1");
  const clientStatus = Number(/^HTTP\/1\.1 (\d{3})/.exec(firstText)?.[1] ?? 0);
  const clientBody = firstText.slice(firstText.indexOf("\r\n\r\n") + 4);
  const headEnd = firstText.indexOf("\r\n\r\n");
  const clientHeaders: http.IncomingHttpHeaders = {};
  for (const line of firstText.slice(0, headEnd >= 0 ? headEnd : firstText.length).split("\r\n").slice(1)) {
    const at = line.indexOf(":");
    if (at > 0) clientHeaders[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }

  secure.destroy();
  proxy.close();
  await new Promise<void>((r) => provider.close(() => r()));
  const records = requests.list(10);
  fs.rmSync(home, { recursive: true, force: true });
  return { seen, seenBody, records, clientStatus, clientBody, clientHeaders, providerCalls, health: proxy.providerHealth.snapshot(), models: proxy.modelHealth.snapshot() };
}

test("retired models are recorded per provider/model on compatible and translated wires (#94)", async () => {
  for (const type of ['anthropic-compatible', 'openai-compatible', 'google'] as const) {
    const result = await roundTrip({}, {
      status: 410, headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"error":{"type":"ModelDeprecated","message":"Model some-model has been deprecated."}}'),
    }, { provider: { type, apiKey: 'test-key', auth: 'api-key' } as Partial<Provider> });
    assert.deepEqual(result.health, {}, 'other models on the provider must stay usable');
    assert.equal(result.models.p?.['some-model']?.reason, 'model_deprecated');
  }
});

test("routed 402 and billing 429 teach provider health, but transient 429 does not; success clears it", async () => {
  for (const [status, message, exhausted] of [[402, 'Insufficient Balance', true], [429, 'insufficient_quota', true], [429, 'rate_limit_exceeded', false]] as const) {
    const result = await roundTrip({}, { status, headers: { 'content-type': 'application/json', 'retry-after': '2' }, body: Buffer.from(JSON.stringify({ error: { message } })) });
    assert.equal(result.clientStatus, status);
    assert.equal(!!result.health.p, exhausted);
    if (exhausted) assert.equal(result.health.p!.until - result.health.p!.at, 2000);
  }
  const recovered = await roundTrip({}, OK_REPLY, { exhausted: true });
  assert.equal(recovered.clientStatus, 200);
  assert.deepEqual(recovered.health, {});
  // A translated adapter maps 402 to a client 400, but must retain its actual meaning.
  const translated = await roundTrip({}, { status: 402, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":{"message":"Insufficient Balance"}}') }, { provider: { type: 'openai-compatible' } });
  assert.equal(translated.health.p?.reason, 'insufficient_balance');
  for (const code of ['insufficient_quota', 'rate_limit_exceeded']) {
    const streamed = await roundTrip({}, { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Buffer.from(`data: ${JSON.stringify({ error: { code, message: 'request refused' } })}\n\n`) }, { provider: { type: 'openai-compatible' } });
    assert.equal(!!streamed.health.p, code === 'insufficient_quota');
  }
});

// Claude Code retries a plain 429 ten times over ~2.5 minutes. A definite spending-cap exhaustion
// cannot succeed on any of those retries, so it is answered with the header the CLI reads before its
// 429 rule; an ordinary rate limit keeps no such header (#89, 2026-10-24).
test("a definite exhaustion tells the worker not to retry; a bare rate limit does not", async () => {
  const cap = await roundTrip({}, {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "120" },
    body: Buffer.from(JSON.stringify({ error: { code: 429, message: "Your project has exceeded its monthly spending cap." } })),
  });
  assert.equal(cap.clientStatus, 429);
  assert.equal(cap.clientHeaders["x-should-retry"], "false");
  assert.equal(cap.clientHeaders["retry-after"], "120");
  assert.equal(cap.health.p?.reason, "billing_exhausted");

  const rate = await roundTrip({}, {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "2" },
    body: Buffer.from(JSON.stringify({ error: { message: "rate_limit_exceeded" } })),
  });
  assert.equal(rate.clientStatus, 429);
  assert.equal(rate.clientHeaders["x-should-retry"], undefined);
  assert.equal(rate.clientHeaders["retry-after"], "2", "the provider's own wait is passed through");
  assert.deepEqual(rate.health, {});
});

test("an x-api-key provider never receives the caller's authorization header", async () => {
  const seen = await forwardedHeaders({ "x-api-key": "PROVIDER-KEY" });
  assert.equal(seen["x-api-key"], "PROVIDER-KEY");
  assert.equal(seen.authorization, undefined);
});

test("a bearer provider never receives the caller's x-api-key header", async () => {
  const seen = await forwardedHeaders({ authorization: "Bearer PROVIDER-KEY" });
  assert.equal(seen.authorization, "Bearer PROVIDER-KEY");
  assert.equal(seen["x-api-key"], undefined);
});

// The status code alone left a DeepSeek 401 unexplained for a day; the body says which key was
// refused. It is kept masked: a provider that echoes a whole key must not put it in the log.
test("a provider error body is recorded with credentials masked, and still reaches the client", async () => {
  const body = Buffer.from(JSON.stringify({ error: { message: "Authentication Fails, Your api key: sk-abcdef0123456789 is invalid", type: "authentication_error" } }));
  const { records, clientStatus } = await roundTrip({ "x-api-key": "PROVIDER-KEY" }, { status: 401, headers: { "content-type": "application/json" }, body });
  assert.equal(clientStatus, 401);
  const record = records.find((r) => r.kind === "messages");
  assert.ok(record, "the request was logged");
  assert.equal(record.ok, false);
  assert.match(record.note ?? "", /^upstream 401: .*Authentication Fails/);
  assert.match(record.note ?? "", /\[REDACTED\] is invalid/);
  assert.doesNotMatch(record.note ?? "", /sk-abcdef/);
  assert.equal(record.resent, undefined);
});

// Anthropic drops a thread after a few idle minutes; the CLI replays the conversation on the 404,
// so the log must not show it as a failure (2026-10-07: about half the turns after five minutes).
test("a thread the API forgot is recorded as resent, and the 404 still reaches the client", async () => {
  const body = Buffer.from(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "No thread state was found for the requested `previous_message_id`.", details: { error_code: "thread_not_found" } } }));
  const { records, clientStatus } = await roundTrip({ "x-api-key": "PROVIDER-KEY" }, { status: 404, headers: { "content-type": "application/json" }, body });
  assert.equal(clientStatus, 404);
  const record = records.find((r) => r.kind === "messages");
  assert.ok(record, "the request was logged");
  assert.equal(record.ok, false);
  assert.equal(record.resent, true);
  assert.match(record.note ?? "", /^upstream 404: /);
});

test("errorSnippet decodes gzip, masks bearer tokens and explicit opaque credentials, and bounds its length", () => {
  const gz = zlib.gzipSync(Buffer.from('{"error":"token Bearer sk-ant-oat01-SECRETSECRET1234 expired"}'));
  const s = errorSnippet(gz, "gzip");
  assert.match(s, /Bearer \[REDACTED\] expired/);
  assert.doesNotMatch(s, /SECRET/);
  const opaque = "vendor_key_not_matching_a_known_pattern";
  const reflected = errorSnippet(Buffer.from(`provider rejected ${opaque}`), undefined, [opaque]);
  assert.match(reflected, /provider rejected \[REDACTED\]/);
  assert.doesNotMatch(reflected, /vendor_key/);
  assert.equal(errorSnippet(Buffer.alloc(0), undefined), "(empty body)");
  assert.match(errorSnippet(Buffer.from("<html><body>Sign in</body></html>"), undefined, [], "text/html; charset=utf-8"), /^HTML page \(\d+B\)/);
  assert.ok(errorSnippet(Buffer.from("x".repeat(1000)), undefined).length <= 301);
});

test("a request is recorded under the Claude Code session that sent it", async () => {
  const { records } = await roundTrip({ "x-api-key": "PROVIDER-KEY" }, OK_REPLY);
  assert.equal(records[0]?.session, "11111111-2222-4333-8444-555555555555");
});

test("non-credential headers still reach the provider", async () => {
  const seen = await forwardedHeaders({ "x-api-key": "PROVIDER-KEY" });
  assert.equal(seen["anthropic-version"], "2023-06-01");
});

// Nothing else tells a mapped provider what it is: it reads Claude Code's system prompt, whose
// first line says "You are Claude Code, Anthropic's official CLI for Claude". DeepSeek answered
// accordingly (2026-09-16), so the model's own name goes in front of it.
test("a mapped provider is told which model it is, before the caller's system prompt", async () => {
  const { seenBody } = await roundTrip({ "x-api-key": "K" }, OK_REPLY, { system: "You are Claude Code." });
  assert.equal(seenBody.system, "You are some-model, answering through Claude Code, a terminal-based coding agent.\n\nYou are Claude Code.");
});

test("a system prompt in blocks keeps its blocks, with the identity added as its own", async () => {
  const system = [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }];
  const { seenBody } = await roundTrip({ "x-api-key": "K" }, OK_REPLY, { system });
  assert.deepEqual(seenBody.system, [
    { type: "text", text: "You are some-model, answering through Claude Code, a terminal-based coding agent." },
    { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
  ]);
});

test("identity false leaves the system prompt alone, and the addendum still follows it", async () => {
  const { seenBody } = await roundTrip({ "x-api-key": "K" }, OK_REPLY, {
    system: "You are Claude Code.",
    provider: { identity: false, instructionsAppend: "Answer in Korean." } as Partial<Provider>,
  });
  assert.equal(seenBody.system, "You are Claude Code.\n\nAnswer in Korean.");
});

test("an Auto mode classifier reaches an Anthropic-compatible provider unchanged", async () => {
  const system = "You are a security monitor for autonomous AI coding agents.\n\nJudge this action.";
  const { seenBody } = await roundTrip({ "x-api-key": "K" }, OK_REPLY, {
    system,
    provider: { instructionsAppend: "Answer in Korean." } as Partial<Provider>,
  });
  assert.equal(seenBody.system, system);
});

// A vendor that keys its prompt cache on a session header charges full price to anyone who omits
// one. On this path the header has to be added where the provider's own headers are, and it must
// never displace them.
test("an anthropic-compatible provider sends its session header, and the credential still wins", async () => {
  const withSession = await roundTrip({ "x-api-key": "provider-key" }, OK_REPLY, {
    provider: { sessionHeader: "x-opencode-session" } as never,
  });
  const session = withSession.seen["x-opencode-session"];
  assert.ok(typeof session === "string" && session.length > 0, "the header went out");
  assert.equal(withSession.seen["x-api-key"], "provider-key", "credentials untouched");

  const without = await roundTrip({ "x-api-key": "provider-key" }, OK_REPLY);
  assert.equal(without.seen["x-opencode-session"], undefined, "nothing extra unless asked for");
});

// Claude Code sends later turns as `thread: {type:"continue"}` with only the new messages. An
// Anthropic-shaped vendor holds no thread, so forwarding that delta hands it orphan tool_results
// and no task (DeepSeek via Bailian, 2026-09-24). Refused, the CLI resends the turn stateless.
test("an anthropic-compatible provider never receives a thread continue: the CLI is told to resend stateless", async () => {
  const r = await roundTrip({ authorization: "Bearer PROVIDER-KEY" }, OK_REPLY, {
    body: {
      thread: { type: "continue", previous_message_id: "msg_1" },
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "beta" }] }],
    },
  });
  assert.equal(r.clientStatus, 400);
  assert.equal((JSON.parse(r.clientBody) as { error: { details: { error_code: string } } }).error.details.error_code, "thread_unsupported_request");
  assert.equal(r.providerCalls, 0, "the delta never reached the provider");
  const record = r.records.find((x) => x.kind === "messages");
  assert.match(record?.note ?? "", /thread continue refused/);
  assert.equal(record?.resent, true, "a resend asked for is not a failure");
});

test("a thread create still reaches an anthropic-compatible provider, without the thread fields", async () => {
  const r = await roundTrip({ authorization: "Bearer PROVIDER-KEY" }, OK_REPLY, {
    body: { thread: { type: "create" }, diagnostics: { previous_message_id: null } },
  });
  assert.equal(r.clientStatus, 200);
  assert.equal(r.providerCalls, 1);
  assert.equal("thread" in r.seenBody, false);
  assert.equal("diagnostics" in r.seenBody, false);
  assert.deepEqual(r.seenBody.messages, [{ role: "user", content: "hi" }]);
});
