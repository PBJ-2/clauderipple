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
import { readClaudeAccountsFile, removeClaudeAccount, replaceClaudeOAuthAccount, saveClaudeOAuthAccount, updateClaudeAccount } from "../src/providers/anthropic-accounts.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { createCa, createLeaf } from "../src/x509.ts";

const noClaudeCodeCredentialReaders = { keychain: () => null, credentialsFile: () => null };

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
  const third = saveClaudeOAuthAccount(home, {
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
    claudeCodeCredentialReaders: noClaudeCodeCredentialReaders,
    upstreamPort,
    upstreamAgent: new https.Agent({ ca: ca.certPem }),
  });
  await proxy.listen();

  let lastHeaders: Record<string, string> = {};
  const send = async (conversation = "conversation-1", options: { content?: string; previous?: string; model?: string; auth?: string } = {}): Promise<number> => {
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
      (options.auth ?? "authorization: Bearer current-token\r\nanthropic-client-current-only: current-fingerprint\r\n") +
      `anthropic-beta: ${clientBeta}\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    const first = await new Promise<Buffer>((resolve) => secure.once("data", (chunk: Buffer) => setTimeout(() => resolve(chunk), 30)));
    secure.destroy();
    const head = first.toString("latin1").split("\r\n\r\n")[0] ?? "";
    const parsed: Record<string, string> = {};
    for (const line of head.split("\r\n").slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) parsed[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    lastHeaders = parsed;
    return Number(/^HTTP\/1\.1 (\d{3})/.exec(first.toString("latin1"))?.[1] ?? 0);
  };

  return {
    home,
    stored,
    third,
    seen,
    observed,
    requests,
    proxy,
    send,
    lastHeaders: () => lastHeaders,
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

// A Claude 429 whose unified headers say the account's 5h window is spent used to cool it for 60 s
// and re-try a spent subscription every minute (2026-11-07). It now rests until the stated reset,
// and the caller is told not to spend its own retry ladder on it.
test("a spent Claude window rests until its reset and answers x-should-retry: false", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3_600;
  const headers = {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1",
    "anthropic-ratelimit-unified-5h-reset": String(reset),
    "anthropic-ratelimit-unified-7d-utilization": "0.584",
    "anthropic-ratelimit-unified-7d-reset": String(reset + 86_400),
  };
  const rig = await nativeRig(() => ({ status: 429, headers, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }) }));
  try {
    assert.equal(await rig.send("spent-window"), 429);
    assert.equal(rig.seen.length, 3, "every account was tried once before the caller was told");
    assert.equal(rig.lastHeaders()["x-should-retry"], "false", "the CLI's own retry ladder must not run");
    const wait = Number(rig.lastHeaders()["retry-after"]);
    assert.ok(wait >= 3_500 && wait <= 3_600, `retry-after is the stated reset, not a minute: ${wait}s`);
    const health = rig.proxy.credentialHealth()["claude"]!;
    assert.equal(health.length, 3);
    for (const row of health) {
      assert.equal(row.state, "cooling");
      assert.ok((row.cooldownSeconds ?? 0) >= 3_500, `${row.id} rests ${row.cooldownSeconds}s, not 60`);
    }
  } finally {
    await rig.stop();
  }
});

// A short `retry-after` beside a rejected window is the limiter's next refresh, not the end of the
// window. The rest and the caller's retry-after both follow the later of the two, so they agree
// (2026-11-07: the pool rested 60 s while the response said an hour).
test("a short Retry-After does not shorten a spent Claude window's rest", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3_600;
  const headers = {
    "retry-after": "60",
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1",
    "anthropic-ratelimit-unified-5h-reset": String(reset),
  };
  const rig = await nativeRig(() => ({ status: 429, headers, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }) }));
  try {
    assert.equal(await rig.send("short-retry"), 429);
    assert.equal(rig.seen.length, 3, "every account was tried once before the caller was told");
    assert.equal(rig.lastHeaders()["x-should-retry"], "false", "the CLI's own retry ladder must not run");
    const wait = Number(rig.lastHeaders()["retry-after"]);
    assert.ok(wait >= 3_500 && wait <= 3_600, `retry-after follows the window reset, not the 60 s: ${wait}s`);
    for (const row of rig.proxy.credentialHealth()["claude"]!) {
      assert.equal(row.state, "cooling");
      assert.ok((row.cooldownSeconds ?? 0) >= 3_500, `${row.id} rests ${row.cooldownSeconds}s, not 60`);
    }
  } finally {
    await rig.stop();
  }
});

// After an in-turn retry the completion line and requests.jsonl must name the account that answered.
// The tag was built once from the first account, and a credential refreshed between the first pick
// and the retry was not in that pick's list, so both reported the wrong account / `#0` (2026-11-07).
test("an in-turn retry is logged and recorded against the credential that answered", async () => {
  let rotate: (() => void) | undefined;
  const rig = await nativeRig((_seen, attempt) => {
    if (attempt === 1) {
      rotate?.();
      return { status: 429, headers: { "retry-after": "300" }, body: "{}" };
    }
    return { status: 200, body: JSON.stringify({ id: "msg_after_retry", type: "message", role: "assistant", model: "claude-opus-5", content: [], usage: {} }) };
  });
  try {
    // A refresh lands between the first pick and the retry: the same account answers under a new
    // runtime id that the first pick's credential list does not contain.
    rotate = () => {
      assert.equal(replaceClaudeOAuthAccount(rig.home, rig.stored.id, "stored-refresh", {
        accessToken: "stored-refreshed", refreshToken: "stored-refreshed-refresh", expiresAt: Date.now() + 3_600_000,
      }), true);
    };
    assert.equal(await rig.send("retry-naming"), 200);
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer current-token", "Bearer stored-refreshed"]);
    const storedPin = rig.stored.id.slice(0, 8);
    const log = fs.readFileSync(path.join(rig.home, "router.log"), "utf8");
    assert.match(log, new RegExp(`CLAUDE .*account=${storedPin} .*-> 200`), "the completion line names the account that answered");
    assert.doesNotMatch(log, /CLAUDE .*account=current .*-> 200/);
    assert.match(log, /RETRY claude: .*trying #2/, "the retry line names the account, not #0");
    assert.match(JSON.stringify(rig.requests.list(20)), /"credential":"#2"/);
    assert.equal(rig.requests.list(1)[0]!.account, rig.stored.id);
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

test("a slot on a Claude API key sends the key alone: no sign-in, no sign-in betas", async () => {
  const key: Config["providers"][string] = { type: "anthropic", auth: "api-key", apiKey: "sk-ant-test", models: [{ id: "claude-opus-5" }] };
  const rig = await nativeRig(() => ({ status: 200 }), key, "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14");
  try {
    assert.equal(await rig.send(), 200);
    assert.equal(rig.seen.length, 1);
    assert.equal(rig.seen[0]!.apiKey, "sk-ant-test");
    assert.equal(rig.seen[0]!.authorization, undefined, "the caller's sign-in never reaches the key's bill");
    // A key on a subscription's API credit refuses claude-code-* with billing_error 400 (2026-11-10).
    assert.equal(rig.seen[0]!.beta, "interleaved-thinking-2025-05-14", "the OAuth and Claude Code betas belong to a sign-in");
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
    const store = new ClaudeCodeAuthStore(undefined, { observed: rig.observed, home: rig.home, env: {}, credentialReaders: noClaudeCodeCredentialReaders });
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
    const store = new ClaudeCodeAuthStore(undefined, { observed: rig.observed, home: rig.home, env: {}, credentialReaders: noClaudeCodeCredentialReaders });
    assert.equal(store.describeSource(), null, "the rejected login is no longer the current one");
    assert.equal(await rig.send("after-signout"), 200);
    assert.equal(rig.seen.at(-1)?.authorization, "Bearer stored-token", "the dead token is not tried again");
  } finally {
    await rig.stop();
  }
});

// A script in a session's shell inherits HTTPS_PROXY and calls the API on its own key. Routing it
// put it on the subscription accounts, whose 429 cooled both for a minute (2026-11-05).
test("a script's own API key goes out on that key, unrouted, and its 429 cools no account", async () => {
  const rig = await nativeRig((seen) => seen.apiKey
    ? { status: 429, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Error" } }) }
    : { status: 200 });
  try {
    const script = "x-api-key: sk-ant-api03-script\r\nuser-agent: Python-urllib/3.12\r\n";
    assert.equal(await rig.send("script-1", { auth: script }), 429, "the key's own answer reaches the script");
    assert.equal(rig.seen.length, 1, "no stored account is tried for it");
    assert.equal(rig.seen[0]!.apiKey, "sk-ant-api03-script");
    assert.equal(rig.seen[0]!.authorization, undefined);
    assert.equal(rig.seen[0]!.body.model, "claude-opus-4-8", "a mapped model is not rewritten for a caller key");
    assert.equal(await rig.send("conversation-1"), 200);
    assert.equal(rig.seen[1]!.authorization, "Bearer current-token", "the current login was not cooled by the script's 429");
    assert.doesNotMatch(JSON.stringify(rig.requests.list(20)), /sk-ant-api03-script/);
  } finally {
    await rig.stop();
  }
});

test("Claude Code on an API key keeps the pool path", async () => {
  const rig = await nativeRig(() => ({ status: 200 }));
  try {
    const cli = "x-api-key: sk-ant-api03-cli\r\nx-app: cli\r\nuser-agent: claude-cli/2.1.317 (external, cli)\r\n";
    assert.equal(await rig.send("conversation-1", { auth: cli }), 200);
    assert.equal(rig.seen[0]!.authorization, "Bearer current-token");
    assert.equal(rig.seen[0]!.apiKey, undefined, "the pool's identity replaces the caller's key, as before");
    assert.equal(rig.seen[0]!.body.model, "claude-opus-5");
  } finally {
    await rig.stop();
  }
});

// A pinned worker (`<provider>#<account-pin>:<model>`) runs on one stored account, whatever the
// conversation's affinity or the provider's order would choose, and the upstream sees the bare id.
test("a pinned worker runs on its stored Claude account and forwards the bare model", async () => {
  const rig = await nativeRig(() => ({ status: 200 }));
  try {
    const pin = rig.stored.id.slice(0, 8);
    assert.equal(await rig.send("mixed-conversation"), 200);
    assert.equal(rig.seen[0]!.authorization, "Bearer current-token", "an unpinned turn is unchanged");

    assert.equal(await rig.send("mixed-conversation", { model: `claude#${pin}:claude-opus-5` }), 200);
    assert.equal(rig.seen[1]!.authorization, "Bearer stored-token", "the pin wins over the conversation's claim");
    assert.equal(rig.seen[1]!.body.model, "claude-opus-5", "the pin never reaches the upstream");
    assert.doesNotMatch(JSON.stringify(rig.seen[1]!.body), /#/);
    const log = fs.readFileSync(path.join(rig.home, "router.log"), "utf8");
    assert.match(log, new RegExp(`CLAUDE claude#${pin}:claude-opus-5->claude-opus-5 account=${pin}`), "the log names the account that answered");
    assert.match(log, /reason=account-pin/);

    // The pinned turn left the other conversation's claim alone: it still runs on the current login.
    assert.equal(await rig.send("mixed-conversation", { content: "later" }), 200);
    assert.equal(rig.seen[2]!.authorization, "Bearer current-token");
  } finally {
    await rig.stop();
  }
});

test("a pinned account that is paused or removed falls back to the pool instead of failing", async () => {
  const rig = await nativeRig(() => ({ status: 200 }));
  try {
    const pin = rig.stored.id.slice(0, 8);
    const model = `claude#${pin}:claude-opus-5`;
    updateClaudeAccount(rig.home, rig.stored.id, { paused: true });
    assert.equal(await rig.send("paused-pin", { model }), 200, "the turn still goes out");
    assert.equal(rig.seen[0]!.authorization, "Bearer current-token", "a paused pin falls back to the pool order");

    updateClaudeAccount(rig.home, rig.stored.id, { paused: false });
    assert.equal(await rig.send("unpaused-pin", { model }), 200);
    assert.equal(rig.seen[1]!.authorization, "Bearer stored-token", "unpaused, the same worker pins again");

    removeClaudeAccount(rig.home, rig.stored.id);
    assert.equal(await rig.send("removed-pin", { model }), 200);
    assert.equal(rig.seen[2]!.authorization, "Bearer current-token", "a removed account's pin falls back too");
    const log = fs.readFileSync(path.join(rig.home, "router.log"), "utf8");
    assert.equal((log.match(new RegExp(`account-pin fallback ${pin} → current`, "g")) ?? []).length, 2, "logged once per fallback turn");
  } finally {
    await rig.stop();
  }
});

test("a cooling pin falls back on the next turn, and an in-turn retry honours the pin first", async () => {
  let rateLimited = true;
  const rig = await nativeRig((seen) => seen.authorization === "Bearer stored-token" && rateLimited
    ? { status: 429, headers: { "retry-after": "300" }, body: "{}" }
    : { status: 200 });
  try {
    const pin = rig.stored.id.slice(0, 8);
    assert.equal(await rig.send("cooling-pin", { model: `claude#${pin}:claude-opus-5` }), 200);
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer stored-token", "Bearer current-token"], "the refused pin is retried from the pool");
    rateLimited = false;

    assert.equal(await rig.send("after-cooling", { model: `claude#${pin}:claude-opus-5` }), 200);
    assert.deepEqual(rig.seen.at(-1)!.authorization, "Bearer current-token", "a cooling pin is not retried while it rests");
    assert.match(fs.readFileSync(path.join(rig.home, "router.log"), "utf8"), new RegExp(`account-pin fallback ${pin} → current`));
  } finally {
    await rig.stop();
  }

  // The pin first, then the ordinary order: a pin that is not the pool's first choice leads the turn.
  const third = await nativeRig((seen) => seen.authorization === "Bearer third-token"
    ? { status: 429, headers: { "retry-after": "300" }, body: "{}" }
    : { status: 200 });
  try {
    const pin = third.third.id.slice(0, 8);
    assert.equal(await third.send("pin-retry", { model: `claude#${pin}:claude-opus-5` }), 200);
    assert.deepEqual(third.seen.map((item) => item.authorization), ["Bearer third-token", "Bearer current-token"], "the pin answered first; the retry used the pool");
  } finally {
    await third.stop();
  }
});
