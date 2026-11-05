// A ladder failover must keep the fallback's account pin. The spawn snapshot names the worker that
// answers after the primary is out (`anthropic#<pin8>:<model>`), and the account pick at send time
// honours it: a primary that failed over to a pinned worker goes out on that worker's account, not
// on the ordinary pool order. The pin is dropped in three places if `workerFallbacks`, `chooseTarget`
// or `unwrittenFallback` forgets it — these drive the real proxy, a real 429 exhaustion, a real
// Google capacity refusal and a real native Claude upstream, so the account the upstream sees is
// the assertion.
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
import { DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import { saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";
import { saveGoogleAccount } from "../src/providers/google/accounts.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { createCa, createLeaf } from "../src/x509.ts";
import { syncAgentFiles } from "../src/agents.ts";
import { storedAccountsFor } from "../src/pinned-accounts.ts";
import { workerLadderLine } from "../../mod/hooks/ladder.ts";
import { normalizeSettings } from "../../mod/hooks/settings.ts";

type NativeSeen = { authorization?: string; body: Record<string, unknown> };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = (probe.address() as net.AddressInfo);
      probe.close(() => resolve(port));
    });
  });
}

const POOL: Provider = { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-opus-5" }] };
const BILLING_EXHAUSTED = JSON.stringify({ error: { type: "RESOURCE_EXHAUSTED", message: "Your project has exceeded its monthly spending cap." } });

/**
 * A worker spawned on `p/primary`, answered 429-with-spending-cap the first turn. The ladder's one
 * fallback is a pinned Claude worker. The native upstream records which account each turn ran on.
 */
async function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ladder-pin-"));
  const agentDir = path.join(home, "agents");
  const ca = createCa({ cn: "clauderipple ladder pin test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);

  const nativeSeen: NativeSeen[] = [];
  const native = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      nativeSeen.push({
        ...(typeof req.headers.authorization === "string" ? { authorization: req.headers.authorization } : {}),
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_ok", type: "message", role: "assistant", model: body.model, content: [], usage: {} }));
    });
  });
  await new Promise<void>((resolve) => native.listen(0, "127.0.0.1", resolve));
  const nativePort = (native.address() as net.AddressInfo).port;

  const primarySeen: Record<string, unknown>[] = [];
  const primary = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      primarySeen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      res.writeHead(429, { "content-type": "application/json" });
      res.end(BILLING_EXHAUSTED);
    });
  });
  await new Promise<void>((resolve) => primary.listen(0, "127.0.0.1", resolve));
  const primaryPort = (primary.address() as net.AddressInfo).port;

  // Google's model-capacity answer is unwritten: the proxy may hand the turn to one route fallback
  // before any byte reaches the client. It is asked three times (initial + capacityRetry's delays).
  const googleSeen: number[] = [];
  const google = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      googleSeen.push(1);
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "No capacity available for model gemini-test on the server", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "MODEL_CAPACITY_EXHAUSTED", domain: "cloudcode-pa.googleapis.com", metadata: { model: "gemini-test" } }] } }));
    });
  });
  await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
  const googlePort = (google.address() as net.AddressInfo).port;

  const observed = new ObservedClaudeCodeAuth();
  observed.observe([
    "authorization", "Bearer current-token",
    "anthropic-version", "2023-06-01",
    "anthropic-client-current-only", "current-fingerprint",
  ]);
  // The app's own login leads the pool; the pin names this stored account, so an ordinary pick and
  // the pinned pick are different accounts and the assertion can tell them apart.
  const stored = saveClaudeOAuthAccount(home, {
    accessToken: "stored-token",
    refreshToken: "stored-refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "stored-upstream-uuid",
    email: "stored@example.test",
  });
  saveGoogleAccount(home, { accessToken: "google-token", projectId: "project-1", email: "google@example.test", expiresAt: Date.now() + 3_600_000 });
  const pin = stored.id.slice(0, 8);

  const cfg: Config = {
    ...DEFAULTS,
    upstream: "localhost",
    listen: { host: "127.0.0.1", port: await freePort() },
    providers: {
      p: { type: "anthropic-compatible", url: `http://127.0.0.1:${primaryPort}`, identity: false, models: [{ id: "primary" }] },
      g: { type: "google", auth: "antigravity", url: `http://127.0.0.1:${googlePort}`, models: [{ id: "gemini-test" }] },
      anthropic: POOL,
    },
    routes: {},
    direct: [],
    aliases: {},
  };
  const accountsFor = (provider: Provider) => storedAccountsFor(provider, home);
  syncAgentFiles(cfg, agentDir, undefined, { manifestPath: path.join(home, "generated-agents.json"), pinnedAccounts: accountsFor });
  const pinnedName = `claude-opus-5-${pin}`;
  assert.ok(fs.existsSync(path.join(agentDir, `${pinnedName}.md`)), "the stored account has a pinned worker to name");

  // The saved ladder as the mod writes it: the primary first, the pinned worker as its fallback.
  fs.writeFileSync(path.join(home, "mod-settings.json"), JSON.stringify({
    revision: 1,
    settings: normalizeSettings({ rules: { general: { mode: "ladder", rungs: {
      standard: [
        { target: { agent: "primary" }, effort: "high" },
        { target: { agent: pinnedName }, effort: "high" },
      ],
      hard: [
        { target: { agent: "gemini-test" }, effort: "high" },
        { target: { agent: pinnedName }, effort: "high" },
      ],
    } } } }),
  }));

  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    agentDir,
    requests,
    observedClaudeCodeAuth: observed,
    claudeCodeCredentialReaders: { keychain: () => null, credentialsFile: () => null },
    upstreamPort: nativePort,
    upstreamAgent: new https.Agent({ ca: ca.certPem }),
  });
  await proxy.listen();

  const send = async (prompt: string, model = "primary@high"): Promise<number> => {
    const socket = net.connect(cfg.listen.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve) => socket.once("data", resolve));
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve) => secure.once("secureConnect", resolve));
    const body = JSON.stringify({
      model,
      max_tokens: 16,
      metadata: { user_id: `ladder-pin-${model}` },
      messages: [{ role: "user", content: prompt }],
    });
    secure.write(
      "POST /v1/messages HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "x-claude-code-session-id: session-ladder-pin\r\n" +
      "x-claude-code-agent-id: worker-ladder-pin\r\n" +
      "content-type: application/json\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    const first = await new Promise<Buffer>((resolve) => secure.once("data", (chunk: Buffer) => setTimeout(() => resolve(chunk), 40)));
    secure.destroy();
    return Number(/^HTTP\/1\.1 (\d{3})/.exec(first.toString("latin1"))?.[1] ?? 0);
  };

  return {
    home,
    pin,
    cfg,
    proxy,
    requests,
    primarySeen,
    googleSeen,
    nativeSeen,
    send,
    stop: async () => {
      proxy.close();
      await new Promise<void>((resolve) => native.close(() => resolve()));
      await new Promise<void>((resolve) => primary.close(() => resolve()));
      await new Promise<void>((resolve) => google.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a ladder failover to a pinned Claude worker runs on that account", async () => {
  const rig = await fixture();
  try {
    const line = workerLadderLine({ pick: "pick-a", model: "primary@high", fallbacks: [`anthropic#${rig.pin}:claude-opus-5@high`] });
    assert.equal(await rig.send(`${line}\nTask`), 429, "the primary's spending-cap 429 reaches the client first");
    assert.equal(rig.primarySeen.length, 1);

    assert.equal(await rig.send(`${line}\nTask`), 200, "the next turn runs the ladder's fallback");
    assert.deepEqual(rig.nativeSeen.map((row) => row.authorization), ["Bearer stored-token"], "the fallback used the pinned account, not the pool order");
    assert.equal(rig.nativeSeen[0]?.body.model, "claude-opus-5", "the pin never reaches the upstream");
    assert.doesNotMatch(JSON.stringify(rig.nativeSeen[0]?.body), /#/);
    assert.equal(rig.primarySeen.length, 1, "the exhausted primary is not asked a second time");

    const record = rig.requests.list(10).find((row) => row.provider === "anthropic");
    assert.equal(record?.target, "claude-opus-5");
    const log = fs.readFileSync(path.join(rig.home, "router.log"), "utf8");
    assert.match(log, /LADDER pick=pick-a/);
    assert.match(log, new RegExp(`CLAUDE .*account=${rig.pin}`), "the log names the pinned account that answered");
    assert.match(log, /reason=account-pin/);
  } finally {
    await rig.stop();
  }
});

test("an unwritten capacity fallback to a pinned Claude worker runs on that account", async () => {
  const rig = await fixture();
  try {
    const line = workerLadderLine({ pick: "pick-b", model: "gemini-test@high", fallbacks: [`anthropic#${rig.pin}:claude-opus-5@high`] });
    assert.equal(await rig.send(`${line}\nTask`, "gemini-test@high"), 200, "the capacity refusal falls over inside the turn");
    assert.equal(rig.googleSeen.length, 3, "Google is asked three times before the model is called out of capacity");
    assert.deepEqual(rig.nativeSeen.map((row) => row.authorization), ["Bearer stored-token"], "the unwritten fallback used the pinned account");
    assert.equal(rig.nativeSeen[0]?.body.model, "claude-opus-5", "the pin never reaches the upstream");
    const log = fs.readFileSync(path.join(rig.home, "router.log"), "utf8");
    assert.match(log, /FAILOVER .*fallback g\/gemini-test → anthropic\/claude-opus-5/);
    assert.match(log, /reason=account-pin/);
  } finally {
    await rig.stop();
  }
});
