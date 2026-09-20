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
import { readClaudeAccountsFile, saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";
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

type Seen = { authorization?: string; currentOnly?: string; body: Record<string, unknown> };
type Reply = { status: number; headers?: Record<string, string>; body?: string };

async function nativeRig(reply: (seen: Seen, attempt: number) => Reply) {
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
        ...(typeof req.headers["anthropic-client-current-only"] === "string" ? { currentOnly: req.headers["anthropic-client-current-only"] } : {}),
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
    providers: {
      claude: {
        type: "anthropic",
        auth: "claude-code",
        accountPool: true,
        models: [{ id: "claude-opus-5" }],
      },
    },
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

  const send = async (conversation = "conversation-1"): Promise<number> => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve) => socket.once("data", resolve));
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve) => secure.once("secureConnect", resolve));
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 32,
      metadata: { user_id: conversation },
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      tool_choice: { type: "tool", name: "web_search" },
      messages: [{ role: "user", content: "find this" }],
    });
    secure.write(
      "POST /v1/messages HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "content-type: application/json\r\n" +
      "authorization: Bearer caller-token\r\n" +
      "anthropic-client-current-only: caller-fingerprint\r\n" +
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
    requests,
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
