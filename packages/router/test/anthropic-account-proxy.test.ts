// Native Anthropic account rotation through the real TLS proxy. No request translation is involved:
// only the OAuth identity changes when one account is rate-limited or rejected.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import { ClaudeCodeAuthStore } from "../src/providers/anthropic.ts";
import { readClaudeAccountsFile, saveClaudeOAuthAccount, updateClaudeAccount } from "../src/providers/anthropic-accounts.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { createCa, createLeaf } from "../src/x509.ts";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

type Seen = { authorization?: string; apiKey?: string; currentOnly?: string; beta?: string; body: Record<string, unknown> };
type Reply = { status: number; headers?: Record<string, string>; body?: string };

const POOL: Config["providers"][string] = { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-opus-5" }] };

async function nativeRig(reply: (seen: Seen, attempt: number) => Reply, claude: Config["providers"][string] = POOL, clientBeta = "claude-code-20250219,prompt-caching-scope-2026-01-05") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-native-account-proxy-"));
  const ca = createCa({ cn: "clauderipple native account test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);

  const seen: Seen[] = [];
  const upstream = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const item = {
        ...(typeof req.headers.authorization === "string" ? { authorization: req.headers.authorization } : {}),
        ...(typeof req.headers["x-api-key"] === "string" ? { apiKey: req.headers["x-api-key"] } : {}),
        ...(typeof req.headers["anthropic-client-current-only"] === "string" ? { currentOnly: req.headers["anthropic-client-current-only"] } : {}),
        ...(typeof req.headers["anthropic-beta"] === "string" ? { beta: req.headers["anthropic-beta"] } : {}),
        body,
      };
      seen.push(item);
      const response = reply(item, seen.length);
      res.writeHead(response.status, { "content-type": "application/json", ...(response.headers ?? {}) });
      res.end(response.body ?? JSON.stringify({ id: "msg", type: "message", role: "assistant", model: body.model, content: [], usage: {} }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;

  const observed = new ObservedClaudeCodeAuth();
  observed.observe([
    "authorization", "Bearer current-token",
    "anthropic-version", "2023-06-01",
    "anthropic-client-current-only", "current-fingerprint",
  ]);
  const stored = saveClaudeOAuthAccount(home, {
    accessToken: "stored-token",
    refreshToken: "stored-refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "stored-upstream-uuid",
    email: "stored@example.test",
  });
  saveClaudeOAuthAccount(home, {
    accessToken: "third-token",
    refreshToken: "third-refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "third-upstream-uuid",
    email: "third@example.test",
  });

  const proxyPort = await freePort();
  const cfg: Config = {
    ...DEFAULTS,
    upstream: "localhost",
    listen: { host: "127.0.0.1", port: proxyPort },
    providers: { claude },
    routes: { "claude-opus-4-8": { provider: "claude", model: "claude-opus-5" } },
    direct: [],
  };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests,
    observedClaudeCodeAuth: observed,
    upstreamPort,
    upstreamAgent: new https.Agent({ ca: ca.certPem }),
  });
  await proxy.listen();

  const send = async (conversation = "conversation-1", options: { content?: string; previous?: string; model?: string } = {}): Promise<number> => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve) => socket.once("data", resolve));
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve) => secure.once("secureConnect", resolve));
    const body = JSON.stringify({
      model: options.model ?? "claude-opus-4-8",
      max_tokens: 32,
      metadata: { user_id: conversation },
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      tool_choice: { type: "tool", name: "web_search" },
      messages: [{ role: "user", content: options.content ?? "find this" }],
      ...(options.previous ? { thread: { type: "continue", previous_message_id: options.previous } } : {}),
    });
    secure.write(
      "POST /v1/messages HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "content-type: application/json\r\n" +
      // The app's own login is the observed one: every request carries it, routed or not.
      "authorization: Bearer current-token\r\n" +
      "anthropic-client-current-only: current-fingerprint\r\n" +
      `anthropic-beta: ${clientBeta}\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    const first = await new Promise<Buffer>((resolve) => secure.once("data", (chunk: Buffer) => setTimeout(() => resolve(chunk), 30)));
    secure.destroy();
    return Number(/^HTTP\/1\.1 (\d{3})/.exec(first.toString("latin1"))?.[1] ?? 0);
  };

  return {
    home,
    stored,
    seen,
    observed,
    requests,
    proxy,
    send,
    stop: async () => {
      proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a native Claude turn survives 429, keeps the replacement account, and preserves server tools", async () => {
  const rig = await nativeRig((_seen, attempt) => attempt === 1
    ? { status: 429, headers: { "retry-after": "300" }, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }) }
    : { status: 200 });
  try {
    assert.equal(await rig.send(), 200, "the first client request survives the first account's limit");
    assert.equal(await rig.send(), 200, "the conversation remains on the account that answered");
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer current-token", "Bearer stored-token", "Bearer stored-token"]);
    assert.equal(rig.seen[0]!.currentOnly, "current-fingerprint");
    assert.equal(rig.seen[1]!.currentOnly, undefined, "the previous identity's fingerprint header is removed on retry");
    assert.equal(rig.seen[2]!.currentOnly, undefined, "a stored account chosen on the next request does not inherit the caller fingerprint");
    assert.equal(rig.seen[1]!.body.model, "claude-opus-5");
    assert.deepEqual(rig.seen[1]!.body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }]);
    assert.deepEqual(rig.seen[1]!.body.tool_choice, { type: "tool", name: "web_search" });
    const logs = JSON.stringify(rig.requests.list(20));
    assert.doesNotMatch(logs, /current-token|stored-token|stored-refresh|stored-upstream-uuid|stored@example\.test/);
    const runtimeDigest = crypto.createHash("sha256").update("stored-refresh").digest("hex").slice(0, 12);
    assert.doesNotMatch(fs.readFileSync(path.join(rig.home, "router.log"), "utf8"), new RegExp(runtimeDigest));
  } finally {
    await rig.stop();
  }
});

// A session that began while the stored account was resting stays on the current login. Its next
// turn is a `continue` carrying only the delta, whose own first user message is not the
// conversation's; without the remembered answer→conversation mapping the pool seeds a new affinity
// and picks the now-recovered preferred account, which answers 404 thread_not_found (router.log,
// 2026-11-04: every turn of an already-running Code tab).
test("a thread continue follows the conversation that produced its previous message", async () => {
  let answered = 0;
  const rig = await nativeRig((seen) => {
    if (seen.authorization === "Bearer stored-token" && answered === 0) {
      return { status: 429, headers: { "retry-after": "1" }, body: "{}" };
    }
    answered++;
    return { status: 200, body: JSON.stringify({ id: `msg_native_${answered}`, type: "message", role: "assistant", model: seen.body.model, content: [], usage: {} }) };
  });
  try {
    updateClaudeAccount(rig.home, rig.stored.id, { preferred: true });
    assert.equal(await rig.send("thread-conversation"), 200, "the preferred account is resting; the current login answers");
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer stored-token", "Bearer current-token"]);

    // Its one-second rest lapses: the preferred account is usable again for new conversations.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(await rig.send("thread-conversation", { content: "a tool result", previous: "msg_native_1" }), 200);
    assert.deepEqual(rig.seen.map((item) => item.authorization),
      ["Bearer stored-token", "Bearer current-token", "Bearer current-token"],
      "the continue stays on the account holding its thread although another is preferred");
  } finally {
    await rig.stop();
  }
});

test("a third account does not regain the first session's identity headers", async () => {
  const rig = await nativeRig((_seen, attempt) => attempt < 3
    ? { status: 429, headers: { "retry-after": "300" }, body: "{}" }
    : { status: 200 });
  try {
    assert.equal(await rig.send("three-account-conversation"), 200);
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer current-token", "Bearer stored-token", "Bearer third-token"]);
    assert.deepEqual(rig.seen.map((item) => item.currentOnly), ["current-fingerprint", undefined, undefined]);
  } finally {
    await rig.stop();
  }
});

test("every account keeps the client's beta flags alongside its own OAuth flags (issue #15)", async () => {
  const rig = await nativeRig((_seen, attempt) => attempt === 1
    ? { status: 429, headers: { "retry-after": "300" }, body: "{}" }
    : { status: 200 });
  try {
    assert.equal(await rig.send("beta-conversation"), 200);
    assert.equal(await rig.send("beta-conversation"), 200);
    assert.equal(rig.seen[0]!.beta, "claude-code-20250219,prompt-caching-scope-2026-01-05", "an observed session without its own flags sends the client's");
    for (const item of rig.seen.slice(1)) {
      assert.equal(item.authorization, "Bearer stored-token");
      assert.equal(item.beta, "claude-code-20250219,prompt-caching-scope-2026-01-05,oauth-2025-04-20", "stored account: client flags plus OAuth, no duplicates");
    }
  } finally {
    await rig.stop();
  }
});

test("a slot on a Claude API key sends the key alone: no sign-in, no OAuth beta", async () => {
  const key: Config["providers"][string] = { type: "anthropic", auth: "api-key", apiKey: "sk-ant-test", models: [{ id: "claude-opus-5" }] };
  const rig = await nativeRig(() => ({ status: 200 }), key, "claude-code-20250219,oauth-2025-04-20");
  try {
    assert.equal(await rig.send(), 200);
    assert.equal(rig.seen.length, 1);
    assert.equal(rig.seen[0]!.apiKey, "sk-ant-test");
    assert.equal(rig.seen[0]!.authorization, undefined, "the caller's sign-in never reaches the key's bill");
    assert.equal(rig.seen[0]!.beta, "claude-code-20250219", "the OAuth beta belongs to a sign-in");
    assert.equal(rig.seen[0]!.body.model, "claude-opus-5");
    assert.doesNotMatch(JSON.stringify(rig.requests.list(20)), /sk-ant-test/);
  } finally {
    await rig.stop();
  }
});

test("a native Claude request error does not consume another account", async () => {
  const rig = await nativeRig(() => ({
    status: 400,
    body: JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }),
  }));
  try {
    assert.equal(await rig.send(), 400);
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer current-token"]);
  } finally {
    await rig.stop();
  }
});

test("a stored Claude account rejected with 401 is persisted as needing reauthentication", async () => {
  const rig = await nativeRig((seen) => seen.authorization === "Bearer current-token"
    ? { status: 429, headers: { "retry-after": "300" }, body: "{}" }
    : { status: 401, body: JSON.stringify({ type: "error", error: { type: "authentication_error" } }) });
  try {
    assert.equal(await rig.send(), 401);
    const stored = readClaudeAccountsFile(rig.home).find((account) => account.id === rig.stored.id)!;
    assert.equal(stored.needsReauth, true);
  } finally {
    await rig.stop();
  }
});

// The reporter's timeline (issue #123): the last un-routed `/v1/messages` request was over 12 h
// ago, everything since was routed, and the login vanished from the accounts list and the pool.
test("routed use keeps the current login 12 h after the last un-routed request (#123)", async () => {
  const rig = await nativeRig(() => ({ status: 200 }));
  try {
    rig.observed.observe(["authorization", "Bearer current-token", "anthropic-version", "2023-06-01"], Date.now() - 13 * 3_600_000);
    assert.equal(await rig.send(), 200);
    assert.equal(rig.seen[0]?.authorization, "Bearer current-token", "the app's own login still leads the pool");
    const store = new ClaudeCodeAuthStore(undefined, { observed: rig.observed, home: rig.home, env: {} });
    assert.equal(store.describeSource(), "observed", "the login is still listed after the routed request");
  } finally {
    await rig.stop();
  }
});

// An un-routed native Messages turn is pass-through traffic on the app's own sign-in: no pool
// credential answers, so nothing else ever reports that login's unified limits. While
// /api/oauth/usage refuses, this answer's headers are the only reading it gets (issue #123).
test("an un-routed answer on the app's own login feeds its unified limit headers to usage (#123)", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const rig = await nativeRig(() => ({
    status: 200,
    headers: {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": String(reset),
    },
  }));
  const realFetch = globalThis.fetch;
  // The usage lookup is refused, as it is while the reading matters; only the answer is left.
  globalThis.fetch = (async () => new Response("no", { status: 429 })) as typeof fetch;
  try {
    assert.equal(await rig.send("unrouted-current", { model: "claude-sonnet-5" }), 200);
    assert.equal(rig.seen[0]?.authorization, "Bearer current-token", "the turn went out on the app's own sign-in");
    assert.equal(rig.seen[0]?.body.model, "claude-sonnet-5", "the native model id passed through un-routed");
    const usage = (await rig.proxy.claudeUsage.snapshot()).current as { rate_limits: { primary: { used_percent: number } } };
    assert.equal(usage.rate_limits.primary.used_percent, 42, "the answer's headers became the current login's reading");
  } finally {
    globalThis.fetch = realFetch;
    await rig.stop();
  }
});

// A 401 is the upstream saying this exact token is signed out or revoked; it must leave the pool,
// and re-presenting the same dead token must not bring it back (issue #123).
test("a 401 on the current login drops it and does not readopt the same token (#123)", async () => {
  const rig = await nativeRig((seen) => seen.authorization === "Bearer current-token"
    ? { status: 401, body: JSON.stringify({ type: "error", error: { type: "authentication_error" } }) }
    : { status: 200 });
  try {
    assert.equal(await rig.send(), 200, "the turn is answered on the next account");
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer current-token", "Bearer stored-token"]);
    const store = new ClaudeCodeAuthStore(undefined, { observed: rig.observed, home: rig.home, env: {} });
    assert.equal(store.describeSource(), null, "the rejected login is no longer the current one");
    assert.equal(await rig.send("after-signout"), 200);
    assert.equal(rig.seen.at(-1)?.authorization, "Bearer stored-token", "the dead token is not tried again");
  } finally {
    await rig.stop();
  }
});
