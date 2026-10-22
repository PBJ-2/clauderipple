// An `openai-compatible` provider may hold several credentials (`providers.<name>.credentials`), and
// a refused key is replaced inside the same turn — before the first byte reaches the client — the way
// the anthropic-compatible wire has always worked. These drive the real proxy and real HTTP fakes;
// the keys are fake. A 400 is not walked across the pool, a 401 quarantines its key, and each key of
// an OpenCode Go provider reports its own usage.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { startAdmin } from "../src/admin.ts";
import { CertStore } from "../src/certs.ts";
import { ConfigStore, DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { createCa } from "../src/x509.ts";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type Reply = { status: number; headers?: Record<string, string>; body?: string };
type Upstream = {
  port: number;
  keys: string[];
  /** Every request's headers, in order, for the ones a test reads more than the key from. */
  headers: http.IncomingHttpHeaders[];
  /** GET /usage answers: which key asked, and how many times. */
  usageSeen: { key: string; at: number }[];
  /** What the usage endpoint answers per key: rolling percent, and where that window resets. */
  usage: Map<string, { percent: number; resetsAt: string }>;
  close: () => Promise<void>;
};

/**
 * A Chat Completions endpoint that answers `reply` per request and records the key each one carried.
 * A GET to `/usage` is the OpenCode Go usage route: it answers per key from `usage`, and a key with
 * no entry answers 40% used, resetting in an hour.
 */
async function upstream(reply: (key: string, n: number) => Reply): Promise<Upstream> {
  const keys: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const usageSeen: { key: string; at: number }[] = [];
  const usage = new Map<string, { percent: number; resetsAt: string }>();
  const server = http.createServer((req, res) => {
    const key = String(req.headers.authorization ?? "");
    if (req.method === "GET" && (req.url ?? "").endsWith("/usage")) {
      usageSeen.push({ key, at: Date.now() });
      const row = usage.get(key) ?? { percent: 40, resetsAt: new Date(Date.now() + 3_600_000).toISOString() };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: {
        rolling: { status: "ok", percent: row.percent, resetsAt: row.resetsAt },
        weekly: { status: "ok", percent: 10, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        monthly: { status: "ok", percent: 5, resetsAt: new Date(Date.now() + 20 * 86_400_000).toISOString() },
      } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      keys.push(key);
      headers.push(req.headers);
      const r = reply(key, keys.length);
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(r.body ?? "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    keys,
    headers,
    usageSeen,
    usage,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** What a Chat Completions vendor answers to a turn it accepts: a stream, as the adapter asks for. */
const answer = (text: string): Reply => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  body: [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ].map((record) => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n",
});

const rateLimited: Reply = { status: 429, headers: { "retry-after": "300" }, body: JSON.stringify({ error: { message: "slow down" } }) };

type Rig = {
  proxy: Proxy;
  /** The config file the proxy reads, so a test can drive the admin API against the same router. */
  configFile: string;
  /** The hot-reloading store behind `config()` when `configStore` was asked for. */
  store?: ConfigStore;
  send: (conversation?: string) => Promise<number>;
  /** The same request as `send`, but `/v1/messages/count_tokens`, which the router answers locally. */
  sendCount: (conversation?: string) => Promise<number>;
  stop: () => Promise<void>;
};

/**
 * A live proxy in front of `providers`, reached the way Claude Code reaches it.
 *
 * `configStore` puts the config in a file and reads it through the same `ConfigStore` the router
 * runs, so a test can write that file the way the admin API does and see the next request pick it
 * up — the no-restart path, which a `config: () => cfg` closure cannot show.
 */
async function rig(providers: Config["providers"], routes: Config["routes"], opts: { usageFetch?: (url: string, init?: RequestInit) => Promise<Response>; usageTtlMs?: number; creditFetch?: (url: string, init?: RequestInit) => Promise<Response>; creditTtlMs?: number; creditVendor?: (provider: { url?: string }) => "sail" | "openrouter" | null; configStore?: boolean } = {}): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-openai-keys-"));
  const ca = createCa({ cn: "clauderipple test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const proxyPort = await freePort();
  const cfg: Config = { ...DEFAULTS, listen: { host: "127.0.0.1", port: proxyPort }, providers, routes, direct: [] };
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
  // Backdated, so a write in the same millisecond as this one is still a different mtime to the store.
  fs.utimesSync(configFile, new Date(Date.now() - 5_000), new Date(Date.now() - 5_000));
  const store = opts.configStore ? new ConfigStore(configFile) : undefined;
  const proxy = new Proxy({
    config: () => store ? store.get() : cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests: new RequestLog(path.join(home, "requests.jsonl")),
    ...(opts.usageFetch || opts.usageTtlMs !== undefined
      ? { opencodeUsage: { ...(opts.usageFetch ? { fetch: opts.usageFetch } : {}), ...(opts.usageTtlMs !== undefined ? { ttlMs: opts.usageTtlMs } : {}) } }
      : {}),
    ...(opts.creditFetch || opts.creditTtlMs !== undefined || opts.creditVendor
      ? {
        creditBalance: {
          ...(opts.creditFetch ? { fetch: opts.creditFetch } : {}),
          ...(opts.creditTtlMs !== undefined ? { ttlMs: opts.creditTtlMs } : {}),
          ...(opts.creditVendor ? { vendor: opts.creditVendor } : {}),
        },
      }
      : {}),
  });
  await proxy.listen();

  const send = async (conversation = "user-1", path = "/v1/messages"): Promise<number> => {
    const sock = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
    await new Promise<void>((r) => sock.once("data", () => r()));
    const secure = tls.connect({ socket: sock, servername: "api.anthropic.com", ca: ca.certPem });
    await new Promise<void>((r) => secure.once("secureConnect", () => r()));
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 16,
      stream: false,
      metadata: { user_id: conversation },
      messages: [{ role: "user", content: "hi" }],
    });
    secure.write(`POST ${path} HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const first = await new Promise<Buffer>((r) => secure.once("data", (d: Buffer) => setTimeout(() => r(d), 80)));
    secure.destroy();
    return Number(/^HTTP\/1\.1 (\d{3})/.exec(first.toString("latin1"))?.[1] ?? 0);
  };

  return { proxy, configFile, ...(store ? { store } : {}), send, sendCount: (conversation = "user-1") => send(conversation, "/v1/messages/count_tokens"), stop: async () => { proxy.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}

/** Two keys for one provider; each is a complete header set, as the config declares them. */
const pooled = (port: number, extra: Partial<Provider> = {}): Provider => ({
  type: "openai-compatible",
  url: `http://127.0.0.1:${port}/v1`,
  credentials: [
    { id: "key-1", label: "First key", headers: { authorization: "Bearer test-key-1" } },
    { id: "key-2", label: "Second key", headers: { authorization: "Bearer test-key-2" } },
  ],
  ...extra,
} as Provider);

/** The same two keys on a provider the router recognises as OpenCode Go (its usage route exists). */
const goPooled = (port: number, extra: Partial<Provider> = {}): Provider =>
  pooled(port, { preset: "opencode-go", ...extra });

const routes: Config["routes"] = { "claude-opus-4-8": { provider: "p", model: "vendor-model" } };

test("a rate-limited key hands the same turn to the next key, and the client sees one 200", async () => {
  const up = await upstream((key) => key === "Bearer test-key-1" ? rateLimited : answer("second key"));
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 200, "answered on the first ask");
    assert.deepEqual(up.keys, ["Bearer test-key-1", "Bearer test-key-2"], "both keys tried, within one turn");
  } finally { await r.stop(); await up.close(); }
});

test("the conversation stays on the key that answered while the limited one cools", async () => {
  // The first key is limited for the whole test. Turn 1 discovers it and lands on key 2; turn 2 must
  // start there — moving it back would take the prompt cache with it (§4).
  const up = await upstream((key) => key === "Bearer test-key-1" ? rateLimited : answer("second key"));
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 200);
    assert.equal(await r.send(), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-1", "Bearer test-key-2", "Bearer test-key-2"], "turn 2 starts on the key that answered");
  } finally { await r.stop(); await up.close(); }
});

// A relay answers 403 "Upstream request failed" — its whole ladder, twice — and key 2 answers. The
// failure says nothing about the credential, so the turn gets one more ask on the same key (a second
// full ladder here) before it may move; only after that is the key given up and the next one used.
// It is never charged: a relay's broken upstream is not a statement about the key.
test("a relay's broken upstream gets one more ask on the same key, then the turn moves on", async () => {
  const relay = { status: 403, body: JSON.stringify({ error: { message: "Error from provider (Console Go): Upstream request failed" } }) };
  // The adapter's own ladder is ten asks per attempt, so key 1 refuses twenty times — ten for the
  // turn's first ask and ten for the one retry it is given before moving.
  const up = await upstream((key, n) => (key === "Bearer test-key-1" && n <= 20 ? relay : answer("second key")));
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    // The client is answered on its first ask: the relay hiccup never reaches it.
    assert.equal(await r.send("conv-1"), 200);
    assert.deepEqual(up.keys.slice(0, 20), Array(20).fill("Bearer test-key-1"), "the same key was asked again before the turn moved");
    assert.equal(up.keys.at(20), "Bearer test-key-2", "and only then the next key");
    // The turn that answered was key 2's, so the conversation stays there — moving it back would take
    // the prompt cache with it (§4).
    assert.equal(await r.send("conv-1"), 200);
    assert.equal(up.keys.at(-1), "Bearer test-key-2", "the conversation stayed on the key that answered");
    // Nothing was charged: a relay report is not about the key, and it is not charged to the
    // provider either, because the provider answered.
    const report = r.proxy.credentialHealth().p ?? [];
    assert.deepEqual(report.map((entry) => [entry.id, entry.state]), [["key-1", "ready"], ["key-2", "ready"]], "nothing was charged");
  } finally { await r.stop(); await up.close(); }
});

// The openai-compatible wire's half of the same rule: a 503 is not the key's own failure, so the
// turn is asked again on the same key once after the adapter's ladder, and only the second refusal
// moves it to the next key. A one-off edge hiccup then costs a retry rather than the prompt cache.
test("a 503 gets one more ask on the same key before the turn moves to the next", async () => {
  // Each of key 1's asks suffers a ladder of ten 503s (the adapter's ceiling). Twenty of them is the
  // first ask plus its one retry; after that the turn moves and key 2 answers.
  const busy = { status: 503, body: JSON.stringify({ error: { message: "service unavailable" } }) };
  const up = await upstream((key, n) => (key === "Bearer test-key-1" && n <= 20 ? busy : answer("second key")));
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 200, "the client got an answer, not the hiccup");
    assert.deepEqual(up.keys.slice(0, 20), Array(20).fill("Bearer test-key-1"), "the same key was asked again");
    assert.equal(up.keys.at(20), "Bearer test-key-2", "and only then the next key");
    const report = r.proxy.credentialHealth().p ?? [];
    assert.deepEqual(report.map((entry) => [entry.id, entry.state]), [["key-1", "ready"], ["key-2", "ready"]], "a transient failure is charged to neither key");
  } finally { await r.stop(); await up.close(); }
});

test("a 400 is the request's own fault: it is not retried against the other key", async () => {
  const up = await upstream(() => ({ status: 400, body: JSON.stringify({ error: { message: "bad body" } }) }));
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 400);
    assert.equal(up.keys.length, 1, "asked once, not walked across the pool");
  } finally { await r.stop(); await up.close(); }
});

test("a 401 quarantines the key that produced it; the next turn uses the other one", async () => {
  const up = await upstream((key) => key === "Bearer test-key-1" ? { status: 401, body: JSON.stringify({ error: { message: "invalid key" } }) } : answer("second key"));
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 200);
    // Reported for the dashboard: key-1 is quarantined, key-2 is ready.
    const report = r.proxy.credentialHealth().p ?? [];
    assert.deepEqual(report.map((entry) => [entry.id, entry.state]), [["key-1", "quarantined"], ["key-2", "ready"]]);
    assert.equal(await r.send(), 200);
    assert.equal(up.keys.at(-1), "Bearer test-key-2", "a quarantined key is not asked again");
  } finally { await r.stop(); await up.close(); }
});

test("OpenCode Go reports one limits entry per key, read with that key's own headers", async () => {
  // The `/usage` endpoint answers a different percentage per key, so a lookup that ignored the key
  // would show the same numbers under both entries.
  const percentFor: Record<string, number> = { "Bearer test-key-1": 11, "Bearer test-key-2": 77 };
  const usageSeen: string[] = [];
  const usage = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? "");
    usageSeen.push(auth);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: {
      rolling: { status: "ok", percent: percentFor[auth] ?? 0, resetsAt: "2026-10-21T05:39:48Z" },
      weekly: { status: "ok", percent: 52, resetsAt: "2026-10-25T00:00:00Z" },
      monthly: { status: "ok", percent: 92, resetsAt: "2026-11-20T00:00:00Z" },
    } }));
  });
  await new Promise<void>((r) => usage.listen(0, "127.0.0.1", r));
  const port = (usage.address() as net.AddressInfo).port;
  const provider: Provider = { ...pooled(port), preset: "opencode-go" } as Provider;
  const r = await rig({ p: provider }, routes);
  try {
    const rows = await r.proxy.opencodeLimits("p");
    assert.deepEqual(rows.map((row) => [row.id, row.label]), [["key-1", "First key"], ["key-2", "Second key"]]);
    assert.deepEqual(rows.map((row) => row.windows.find((w) => w.kind === "five_hour")?.used_percent), [11, 77]);
    assert.deepEqual([...usageSeen].sort(), ["Bearer test-key-1", "Bearer test-key-2"]);
  } finally { await r.stop(); await new Promise<void>((done) => usage.close(() => done())); }
});

test("a provider with no credentials still reports its one limits entry", async () => {
  const usage = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { rolling: { status: "ok", percent: 5, resetsAt: "2026-10-21T05:39:48Z" } } }));
  });
  await new Promise<void>((r) => usage.listen(0, "127.0.0.1", r));
  const port = (usage.address() as net.AddressInfo).port;
  const r = await rig({ p: { type: "openai-compatible", preset: "opencode-go", url: `http://127.0.0.1:${port}/v1`, headers: { authorization: "Bearer only-key" } } as Provider }, routes);
  try {
    const rows = await r.proxy.opencodeLimits("p");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "default");
    assert.equal(rows[0]!.windows[0]!.used_percent, 5);
  } finally { await r.stop(); await new Promise<void>((done) => usage.close(() => done())); }
});

test("a key whose 5-hour window is full is skipped before the turn, and a new conversation starts on the next key", async () => {
  // key-1 has spent its 5-hour window; the account card knows it before any request is made here.
  const up = await upstream(() => answer("second key"));
  const reset = new Date(Date.now() + 2 * 3_600_000).toISOString();
  up.usage.set("Bearer test-key-1", { percent: 100, resetsAt: reset });
  const r = await rig({ p: goPooled(up.port) }, routes);
  try {
    // Reading the cards is what fills the usage cache the router reads (the real one fills it on a
    // timer); the turn itself only ever looks at that cache.
    const accounts = await r.proxy.opencodeAccounts("p");
    assert.deepEqual(accounts.map((a) => [a.id, a.state]), [["key-1", "cooling"], ["key-2", "in-use"]]);
    assert.equal(accounts[0]!.cooldown_seconds! > 3_000, true, "cooling until that window resets");

    assert.equal(await r.send(), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-2"], "the spent key was never asked");
    // And the other conversation does not drag it back either.
    assert.equal(await r.send("user-2"), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-2", "Bearer test-key-2"]);
  } finally { await r.stop(); await up.close(); }
});

test("a charged 429 cools its key until the reset the vendor states in the body", async () => {
  // key-1 refuses with OpenCode's usage-limit shape: 100% of the weekly window, and when it resets.
  const resetsAt = new Date(Date.now() + 90 * 60_000).toISOString();
  const up = await upstream((key) => key === "Bearer test-key-1"
    ? {
      status: 429,
      body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Weekly limit reached", usage: { weekly: { percent: 100, resetsAt } } } }),
    }
    : answer("second key"));
  const r = await rig({ p: goPooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-1", "Bearer test-key-2"], "the same turn moved on before the first byte");
    const accounts = await r.proxy.opencodeAccounts("p");
    // ~90 minutes of cooldown, from the body's own reset — not the pool's one-minute default.
    const cooldown = accounts[0]!.cooldown_seconds ?? 0;
    assert.equal(cooldown > 5_000 && cooldown <= 5_400, true, `cooling until the stated reset, got ${cooldown}s`);
    assert.equal(accounts[1]!.state, "in-use");
  } finally { await r.stop(); await up.close(); }
});

test("a 429 that states no reset is cooled to the full window's reset, found by one usage read", async () => {
  const up = await upstream((key) => key === "Bearer test-key-1"
    ? { status: 429, body: JSON.stringify({ error: { message: "slow down" } }) }
    : answer("second key"));
  const r = await rig({ p: goPooled(up.port) }, routes);
  try {
    // The cache first says key-1 is fine, so a key cooled from the cache alone would be at a minute.
    await r.proxy.opencodeAccounts("p");
    // What the fresh read finds: the 5-hour window is full and resets in three hours.
    const reset = new Date(Date.now() + 3 * 3_600_000).toISOString();
    up.usage.set("Bearer test-key-1", { percent: 100, resetsAt: reset });

    assert.equal(await r.send(), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-1", "Bearer test-key-2"]);
    // The refusal made the router read that key's usage once more, past the cache.
    assert.equal(up.usageSeen.filter((seen) => seen.key === "Bearer test-key-1").length >= 2, true, "usage was read again");
    const accounts = await r.proxy.opencodeAccounts("p");
    assert.equal(accounts[0]!.state, "cooling");
    assert.equal((accounts[0]!.cooldown_seconds ?? 0) > 3_000, true, "cooled past a fallback minute, to the window's reset");
  } finally { await r.stop(); await up.close(); }
});

test("a 429 with nothing stated and no full window falls back to one minute", async () => {
  const up = await upstream((key) => key === "Bearer test-key-1" ? { status: 429, body: "{}" } : answer("second key"));
  const r = await rig({ p: goPooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 200);
    const accounts = await r.proxy.opencodeAccounts("p");
    const cooldown = accounts[0]!.cooldown_seconds ?? 0;
    assert.equal(cooldown > 0 && cooldown <= 60, true, `a minute by default, got ${cooldown}s`);
  } finally { await r.stop(); await up.close(); }
});

test("a paused key is never used, and the turn goes to the next one", async () => {
  const up = await upstream(() => answer("second key"));
  const provider = goPooled(up.port);
  (provider as { credentials?: { paused?: boolean }[] }).credentials![0]!.paused = true;
  const r = await rig({ p: provider }, routes);
  try {
    assert.equal(await r.send(), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-2"], "a paused key is not asked at all");
    const accounts = await r.proxy.opencodeAccounts("p");
    assert.deepEqual(accounts.map((a) => a.state), ["paused", "in-use"]);
  } finally { await r.stop(); await up.close(); }
});

test("with one key paused and the other cooling, the turn still goes out on the cooling one", async () => {
  // The all-paused 503 does not cover this: key-2 is out of rotation only until its cooldown ends, so
  // there is still a key to send on. The fallback used to be `credentials[0]`, which here is the
  // paused key — the exact key the operator took out of rotation.
  const up = await upstream((_key, n) => n === 1 ? rateLimited : answer("second key"));
  const provider = goPooled(up.port);
  (provider as { credentials?: { paused?: boolean }[] }).credentials![0]!.paused = true;
  const r = await rig({ p: provider }, routes);
  try {
    assert.equal(await r.send(), 429, "the cooling key's own refusal reaches the client once");
    // Turn 2: key-1 paused, key-2 cooling, so `pick` has nothing. The turn must still carry key-2.
    assert.equal(await r.send(), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-2", "Bearer test-key-2"], "the paused key is never asked, even as the last resort");
  } finally { await r.stop(); await up.close(); }
});

test("every key paused is answered locally instead of sending the turn on the first one", async () => {
  // Pausing is the operator's decision, not a failure: there is no key left to send the turn on, and
  // falling back to key 1 would use a key the dashboard says is out of rotation.
  const up = await upstream(() => answer("should not be called"));
  const provider = goPooled(up.port);
  for (const credential of (provider as { credentials: { paused?: boolean }[] }).credentials) credential.paused = true;
  const r = await rig({ p: provider }, routes);
  try {
    assert.equal(await r.send(), 503);
    assert.deepEqual(up.keys, [], "nothing went upstream");
    const accounts = await r.proxy.opencodeAccounts("p");
    assert.deepEqual(accounts.map((a) => a.state), ["paused", "paused"]);
  } finally { await r.stop(); await up.close(); }
});

test("a 429's retry-after is the cooldown, not the pool's one-minute default", async () => {
  // A relay answering `retry-after: 3600` means an hour. Judged without it, that key was retried after
  // a minute and refused again, once a minute for the whole hour.
  const up = await upstream((key) => key === "Bearer test-key-1"
    ? { status: 429, headers: { "retry-after": "3600" }, body: JSON.stringify({ error: { message: "slow down" } }) }
    : answer("second key"));
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 200);
    const report = r.proxy.credentialHealth().p ?? [];
    const cooling = report.find((entry) => entry.id === "key-1")!.cooldownSeconds ?? 0;
    assert.equal(cooling > 3_500 && cooling <= 3_600, true, `an hour, got ${cooling}s`);
  } finally { await r.stop(); await up.close(); }
});

test("a relay's 403 about its own broken upstream does not cool the key that carried it", async () => {
  // "Upstream request failed" is the relay saying its own call broke, not a statement about our key.
  // Charged without the body it read as an auth failure and parked the key for a minute, which moved
  // the conversation off it and took the prompt cache with it (ARCHITECTURE 2026-09-21).
  const relay = { status: 403, body: JSON.stringify({ error: { message: "Error from provider (Console Go): Upstream request failed" } }) };
  const up = await upstream(() => relay);
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 403);
    const report = r.proxy.credentialHealth().p ?? [];
    assert.deepEqual(report.map((entry) => [entry.id, entry.state]), [["key-1", "ready"], ["key-2", "ready"]]);
  } finally { await r.stop(); await up.close(); }
});

// A vendor says 402 when a key has run out of credit. This adapter translates that to 400 for Claude
// Code (402 is not an Anthropic status), and the pool was charged with the translated code — so a 400
// is "the request's own fault, charge nobody", and the last key of a pool stayed `in-use` instead of
// cooling. Two keys both out of credit: the first cooled, the second did not.
test("a 402 parks every out-of-credit key, including the last one in the pool", async () => {
  const outOfCredit = { status: 402, body: JSON.stringify({ error: { message: "insufficient credit" } }) };
  const up = await upstream(() => outOfCredit);
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    // The client still gets the shape it can read (the 402 is a 400 there, as before).
    assert.equal(await r.send(), 400);
    const report = r.proxy.credentialHealth().p ?? [];
    assert.deepEqual(report.map((entry) => [entry.id, entry.state]), [["key-1", "cooling"], ["key-2", "cooling"]], "both are out of credit, not just the first");
    // And the cooldown is the out-of-credit one (half an hour), not the transient one a 5xx gets.
    const cooldown = report[1]!.cooldownSeconds ?? 0;
    assert.equal(cooldown > 1_700 && cooldown <= 1_800, true, `half an hour, got ${cooldown}s`);
  } finally { await r.stop(); await up.close(); }
});

test("a key added after a deletion never reuses the deleted key's id, so it never inherits its quarantine", async () => {
  // key-1 answers 401 and is quarantined. Removed through the admin API, then a new key is added.
  // Ids were the first free `key-<n>`, so the new key became `key-1` again — and since health is
  // keyed on the id, the brand-new key was quarantined before it ever asked anything (the
  // "replaced credential keeps the old quarantine" failure, ARCHITECTURE §5).
  const up = await upstream((key) => key === "Bearer test-key-revoked" ? { status: 401, body: JSON.stringify({ error: { message: "invalid key" } }) } : answer("ok"));
  const provider: Provider = {
    type: "openai-compatible",
    url: `http://127.0.0.1:${up.port}/v1`,
    credentials: [
      { id: "key-1", label: "Revoked", headers: { authorization: "Bearer test-key-revoked" } },
      { id: "key-2", headers: { authorization: "Bearer test-key-2" } },
    ],
  } as Provider;
  const r = await rig({ p: provider }, routes, { configStore: true });
  const admin = await adminFor(r);
  const api = `http://127.0.0.1:${admin.port}`;
  try {
    // Turn 1: key-1's 401 quarantines it, key-2 answers.
    assert.equal(await r.send("conv-1"), 200);
    assert.equal((r.proxy.credentialHealth().p ?? []).find((entry) => entry.id === "key-1")?.state, "quarantined");

    assert.equal((await fetch(`${api}/api/provider-keys/key-1?provider=p`, { method: "DELETE", headers: { origin: api } })).status, 200);
    const post = await fetch(`${api}/api/provider-keys?provider=p`, {
      method: "POST", headers: { "content-type": "application/json", origin: api }, body: JSON.stringify({ key: "test-key-new", label: "New" }),
    });
    assert.equal(post.status, 201);
    const created = (await post.json()) as { id: string };
    assert.equal(created.id, "key-3", "the released id is not handed to a different key");

    // The new key is usable at once — it carries none of the revoked key's history.
    const keys = (await (await fetch(`${api}/api/provider-keys?provider=p`)).json()) as { accounts: { id: string; state: string }[] };
    assert.deepEqual(keys.accounts.map((a) => [a.id, a.state]), [["key-2", "in-use"], ["key-3", "standby"]], "no quarantine was inherited");
    assert.equal(await r.send("conv-2"), 200);
    assert.equal(up.keys.at(-1), "Bearer test-key-2", "the new key is standby behind key-2, not the first usable because of a stale park");
    // And when key-2 is paused, the new key answers — the pool does not believe it is quarantined.
    assert.equal((await fetch(`${api}/api/provider-keys/key-2?provider=p`, {
      method: "PATCH", headers: { "content-type": "application/json", origin: api }, body: JSON.stringify({ paused: true }),
    })).status, 200);
    assert.equal(await r.send("conv-3"), 200);
    assert.equal(up.keys.at(-1), "Bearer test-key-new", "the new key carries its own credential");
  } finally { admin.close(); await r.stop(); await up.close(); }
});

test("a local count_tokens answer charges nobody, so it cannot lift a quarantine it did not earn", async () => {
  const up = await upstream((key) => key === "Bearer test-key-1"
    ? { status: 401, body: JSON.stringify({ error: { message: "invalid key" } }) }
    : answer("second key"));
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 200);
    assert.equal((r.proxy.credentialHealth().p ?? []).find((entry) => entry.id === "key-1")?.state, "quarantined");
    assert.equal(await r.sendCount("user-1"), 200);
    assert.equal(
      (r.proxy.credentialHealth().p ?? []).find((entry) => entry.id === "key-1")?.state,
      "quarantined",
      "count_tokens is answered locally; a local 200 must not clear a quarantine",
    );
  } finally { await r.stop(); await up.close(); }
});

test("when the cooldown expires, a new conversation returns to the first key", async () => {
  // List order is the priority, so a key that came back is key 1 again without anything having to
  // move a conversation: only the conversation already on key 2 stays there.
  const up = await upstream((key, n) => key === "Bearer test-key-1" && n === 1
    ? { status: 429, headers: { "retry-after": "1" }, body: JSON.stringify({ error: { message: "slow down" } }) }
    : answer("second key"));
  const r = await rig({ p: pooled(up.port) }, routes);
  try {
    assert.equal(await r.send(), 200);
    assert.equal(up.keys.at(-1), "Bearer test-key-2");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    // The old conversation keeps the key that answered it (its prompt cache lives there).
    assert.equal(await r.send("user-1"), 200);
    assert.equal(up.keys.at(-1), "Bearer test-key-2", "a running conversation stays where its cache is");
    assert.equal(await r.send("user-2"), 200);
    assert.equal(up.keys.at(-1), "Bearer test-key-1", "a new conversation starts on the key that is back");
  } finally { await r.stop(); await up.close(); }
});

test("the provider's own headers still travel with a credential; only its auth is replaced", async () => {
  // An organization id, a beta flag or a custom header used to disappear the moment the provider had
  // credentials configured, because the credential's headers replaced the provider's outright.
  const up = await upstream(() => answer("second key"));
  const provider = pooled(up.port, { headers: { authorization: "Bearer stale", "x-org": "acme" } });
  const r = await rig({ p: provider }, routes);
  try {
    assert.equal(await r.send(), 200);
    const sent = up.headers.at(-1)!;
    assert.equal(sent.authorization, "Bearer test-key-1", "the key in rotation, not the configured one");
    assert.equal(sent["x-org"], "acme", "the provider's own header came along");
  } finally { await r.stop(); await up.close(); }
});

/** The admin API in front of the same proxy, so a write goes through the real endpoint. */
async function adminFor(r: Rig) {
  return startAdmin({
    config: () => r.store!.get(),
    configFile: r.configFile,
    log: new Logger(null, 1e6, 1, false),
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    health: () => 0,
    version: "0.0.0-test",
    requests: new RequestLog(path.join(path.dirname(r.configFile), "admin-requests.jsonl")),
    providerKeys: (name) => r.proxy.providerKeys(name),
    creditBalance: (name) => r.proxy.creditLimits(name),
    credentialClear: (provider, id) => r.proxy.credentialClear(provider, id),
    providerRemoved: (provider) => r.proxy.providerRemoved(provider),
  });
}

// A prepaid key that cannot pay is not a failed key: it has nothing left until someone tops it up.
// It must not be handed a new conversation before then, and the balance read is the only thing that
// can bring it back — so the dashboard's own poll has to be enough, without a restart.
test("a key with an empty prepaid balance is skipped, and a later read that finds money releases it", async () => {
  const up = await upstream(() => answer("ok"));
  // Remaining credit per key, as the fake vendor reports it: key-1 is spent, key-2 is not.
  const remaining: Record<string, number> = { "Bearer test-key-1": 0, "Bearer test-key-2": 12 };
  const creditFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    const left = remaining[auth] ?? 0;
    return new Response(JSON.stringify({ data: { total_credits: 100, total_usage: 100 - left } }), { status: 200 });
  };
  // One second, not zero: the read's own cache period is also how long the park lasts, so the next
  // read (the dashboard's next poll) is exactly what can release it.
  const r = await rig({ p: pooled(up.port) }, routes, { creditFetch, creditTtlMs: 1_000, creditVendor: () => "openrouter", configStore: true });
  const admin = await adminFor(r);
  const api = `http://127.0.0.1:${admin.port}`;
  try {
    // The limits read is what fills the balance cache the request path looks at (in production a
    // timer does this at the reader's own pace).
    const limits = (await (await fetch(`${api}/api/limits`)).json()) as { providers: { provider: string; type: string; accounts: { account: number; label?: string; credit?: { remaining_usd: number } }[] }[] };
    const row = limits.providers.find((p) => p.provider === "p")!;
    assert.equal(row.type, "credit");
    assert.deepEqual(row.accounts.map((a) => [a.account, a.label, a.credit?.remaining_usd]), [[0, "First key", 0], [1, "Second key", 12]]);

    // key-1 is spent, so a new conversation goes to key-2 — the vendor is never asked to refuse it.
    assert.equal(await r.send("new-conv"), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-2"], "the empty key was skipped before the turn");
    const keys = (await (await fetch(`${api}/api/provider-keys?provider=p`)).json()) as { accounts: { id: string; state: string }[] };
    assert.deepEqual(keys.accounts.map((a) => [a.id, a.state]), [["key-1", "cooling"], ["key-2", "in-use"]]);

    // Money came back, and the dashboard's next poll is what says so — no restart, and no request
    // made to a key the router still believes is empty.
    remaining["Bearer test-key-1"] = 40;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const after = (await (await fetch(`${api}/api/provider-keys?provider=p`)).json()) as { accounts: { id: string; state: string; credit?: { remaining_usd: number } }[] };
    assert.deepEqual(after.accounts.map((a) => [a.id, a.state, a.credit?.remaining_usd]), [["key-1", "in-use", 40], ["key-2", "standby", 12]]);
    assert.equal(await r.send("another-conv"), 200);
    assert.equal(up.keys.at(-1), "Bearer test-key-1", "a topped-up key is first in order again");
  } finally { admin.close(); await r.stop(); await up.close(); }
});

// The same rule on the other wire: an `anthropic-compatible` balance is per key too, and an empty
// one parks that key the same way — this is the wire sail speaks.
test("an anthropic-compatible provider's empty-balance key is skipped too", async () => {
  const up = await upstream(() => answer("ok"));
  const creditFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    // The key is what the balance is read with, so the answer is per key here as well.
    const key = String((init?.headers as Record<string, string>)?.["x-api-key"] ?? "");
    const left = key === "test-key-1" ? 0 : 9;
    // sail's shape: `balance` is fractional cents.
    return new Response(JSON.stringify({ balance: left * 100, days_remaining: 5 }), { status: 200 });
  };
  const provider: Provider = {
    type: "anthropic-compatible",
    url: `http://127.0.0.1:${up.port}`,
    credentials: [
      { id: "key-1", headers: { "x-api-key": "test-key-1" } },
      { id: "key-2", headers: { "x-api-key": "test-key-2" } },
    ],
  } as Provider;
  // Not OpenCode Go: the usage reader must have nothing to do with this provider.
  const r = await rig({ p: provider }, routes, { creditFetch, creditTtlMs: 60_000, creditVendor: () => "sail" });
  try {
    const rows = await r.proxy.creditLimits("p");
    assert.deepEqual(rows.map((row) => [row.id, row.credit.remaining_usd]), [["key-1", 0], ["key-2", 9]]);
    assert.equal(await r.send("conv"), 200);
    assert.deepEqual(up.headers.map((h) => h["x-api-key"]), ["test-key-2"], "the spent key was never asked");
    assert.equal((await r.proxy.providerKeys("p")).map((row) => row.state).join(","), "cooling,in-use");
  } finally { await r.stop(); await up.close(); }
});

// A key parked on a balance of zero used to come back only when someone opened the dashboard or
// something asked `/api/limits`: the request path reads the cached zero and re-parks the key, so a
// top-up during a day of work with the GUI closed left it out of rotation for good. The router's own
// five-minute re-read is what makes the top-up reach it — no dashboard, no restart, no request to a
// key the router believes is empty.
test("a topped-up key is released by the router's own re-read, with no dashboard open", async () => {
  const up = await upstream(() => answer("ok"));
  let left = 0; // the first key starts empty; a top-up changes only what the vendor answers for it
  const creditFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    const remaining = auth === "Bearer test-key-1" ? left : 12;
    return new Response(JSON.stringify({ data: { total_credits: 100, total_usage: 100 - remaining } }), { status: 200 });
  };
  // An hour of cache: the cached zero cannot expire during this test, so only a forced re-read can
  // find the money. That is exactly the production shape (a five-minute cache, a five-minute timer).
  const r = await rig({ p: pooled(up.port) }, routes, { creditFetch, creditTtlMs: 3_600_000, creditVendor: () => "openrouter" });
  try {
    assert.deepEqual((await r.proxy.creditLimits("p")).map((row) => row.credit.remaining_usd), [0, 12], "key-1 is read as empty");
    // With key-1 parked and nothing else asking for a balance, a turn goes to key-2.
    assert.equal(await r.send("conv-1"), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-2"], "the empty key is skipped");

    left = 40;
    // The turn before the re-read still reads the cached zero: the key stays parked.
    assert.equal(await r.send("conv-2"), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-2", "Bearer test-key-2"], "the cache alone cannot release it");

    await r.proxy.refreshParkedBalances();
    const after = await r.proxy.providerKeys("p");
    assert.deepEqual(after.map((row) => [row.id, row.state, row.credit?.remaining_usd]), [["key-1", "in-use", 40], ["key-2", "standby", 12]], "the re-read found the money and released the key");

    assert.equal(await r.send("conv-3"), 200);
    assert.equal(up.keys.at(-1), "Bearer test-key-1", "a new conversation starts on the released key again");
  } finally { await r.stop(); await up.close(); }
});

// The re-read is cheap: with nothing parked it must not call the vendor at all, and it must not
// spend a read on a key that is merely healthy.
test("the parked-balance re-read asks the vendor nothing when no key is parked", async () => {
  const up = await upstream(() => answer("ok"));
  let reads = 0;
  const creditFetch = async (): Promise<Response> => {
    reads++;
    return new Response(JSON.stringify({ data: { total_credits: 100, total_usage: 0 } }), { status: 200 });
  };
  const r = await rig({ p: pooled(up.port) }, routes, { creditFetch, creditTtlMs: 3_600_000, creditVendor: () => "openrouter" });
  try {
    await r.proxy.refreshParkedBalances();
    assert.equal(reads, 0, "nothing parked, so no balance read at all");
    // One read fills the cache with money; the re-read still must not ask again.
    await r.proxy.creditLimits("p");
    const filled = reads;
    await r.proxy.refreshParkedBalances();
    assert.equal(reads, filled, "a funded key is not re-read");
  } finally { await r.stop(); await up.close(); }
});
// written through the admin endpoint and picked up by mtime, which is the path a `config()` closure
// in a test would hide.
test("a key added through POST /api/provider-keys is used by the next request without a restart", async () => {
  const up = await upstream(() => answer("ok"));
  const provider: Provider = { type: "openai-compatible", url: `http://127.0.0.1:${up.port}/v1`, headers: { authorization: "Bearer test-key-1" } };
  const r = await rig({ p: provider }, routes, { configStore: true });
  const admin = await adminFor(r);
  const api = `http://127.0.0.1:${admin.port}`;
  try {
    assert.equal(await r.send("user-1"), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-1"]);

    const post = await fetch(`${api}/api/provider-keys?provider=p`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "test-key-2", label: "Second" }),
    });
    assert.equal(post.status, 201);
    const created = (await post.json()) as { id: string; migrated: boolean };
    assert.equal(created.migrated, true);
    assert.equal(created.id, "key-1");

    // The router's own view of the config has both keys now — this is the reload, not the file.
    const keys = (await (await fetch(`${api}/api/provider-keys?provider=p`)).json()) as { accounts: { id: string; label?: string; state: string }[] };
    assert.deepEqual(keys.accounts.map((a) => [a.id, a.label]), [["default", undefined], ["key-1", "Second"]]);

    // Take the old key out of rotation, and the next turn must carry the new one.
    assert.equal((await fetch(`${api}/api/provider-keys/default?provider=p`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: true }),
    })).status, 200);
    assert.equal(await r.send("user-2"), 200);
    assert.deepEqual(up.keys, ["Bearer test-key-1", "Bearer test-key-2"], "the pasted key drove the next turn, no restart");
  } finally { admin.close(); await r.stop(); await up.close(); }
});

// Health is keyed by provider and key name, in memory. Deleting a provider from the config and
// adding one back under the same name used to inherit the old one's quarantines and cooldowns: the
// new provider started out with a key it had never asked. The config save is where the removal is
// seen, so the pool's record goes with it.
test("deleting a provider forgets its key health, so a provider re-added under the name starts clean", async () => {
  const up = await upstream((key) => (key === "Bearer test-key-1" ? { status: 401, body: JSON.stringify({ error: { message: "invalid key" } }) } : answer("second key")));
  const r = await rig({ p: pooled(up.port) }, routes, { configStore: true });
  const admin = await adminFor(r);
  const api = `http://127.0.0.1:${admin.port}`;
  try {
    assert.equal(await r.send(), 200, "key-1 is quarantined and key-2 answers");
    assert.equal(r.proxy.credentialHealth().p?.[0]?.state, "quarantined");

    // The GUI's delete: the provider leaves the config.
    const without = { ...r.store!.get(), providers: {}, routes: {} };
    assert.equal((await fetch(`${api}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(without) })).status, 200);
    // And it comes back under the same name, with the same two keys.
    const back = { ...r.store!.get(), providers: { p: pooled(up.port) }, routes };
    assert.equal((await fetch(`${api}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(back) })).status, 200);

    assert.deepEqual(r.proxy.credentialHealth().p?.map((entry) => entry.state), ["ready", "ready"], "no quarantine survived the delete");
    assert.equal(await r.send("fresh"), 200);
    // The fake vendor still refuses key-1, so this turn ends on key-2; what matters is that the
    // re-added provider asked key-1 first rather than trusting a quarantine from its old life.
    assert.equal(up.keys.at(-2), "Bearer test-key-1", "the re-added provider is asked on its first key again");
    assert.equal(up.keys.at(-1), "Bearer test-key-2", "and moves only because key-1 refuses it, as before");
  } finally { admin.close(); await r.stop(); await up.close(); }
});

test("a key whose usage has never been read reports unknown, and a failed read keeps the last good answer", async () => {
  // The account card used to derive "in-use" from a live read: a failed read left no windows, and the
  // card then presented a possibly spent key as the one in use. The read is injected here so no test
  // ever reaches the vendor.
  const up = await upstream(() => answer("second key"));
  let failing = true;
  const fetched: string[] = [];
  const usageFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    fetched.push(String((init?.headers as Record<string, string>)?.authorization ?? url));
    if (failing) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ usage: {
      rolling: { status: "ok", percent: 12, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      weekly: { status: "ok", percent: 20, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    } }), { status: 200 });
  };
  const r = await rig({ p: goPooled(up.port) }, routes, { usageFetch, usageTtlMs: 0 });
  try {
    const unread = await r.proxy.opencodeAccounts("p");
    assert.deepEqual(unread.map((a) => [a.id, a.state, a.windows.length, a.at]), [
      ["key-1", "unknown", 0, 0],
      ["key-2", "unknown", 0, 0],
    ]);
    assert.equal(fetched.length >= 2, true, "the dashboard did ask (and the fake answered 500)");

    failing = false;
    const read = await r.proxy.opencodeAccounts("p");
    assert.deepEqual(read.map((a) => [a.state, a.windows.length]), [["in-use", 2], ["standby", 2]]);
    assert.equal(read[0]!.at > 0, true);

    // And a read that fails afterwards keeps those windows instead of blanking them.
    failing = true;
    const kept = await r.proxy.opencodeAccounts("p");
    assert.deepEqual(kept.map((a) => a.windows.length), [2, 2], "the last good answer survives a failed read");
    assert.equal(kept[0]!.state, "in-use");
  } finally { await r.stop(); await up.close(); }
});
