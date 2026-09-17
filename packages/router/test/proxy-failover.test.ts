// Credential rotation and provider failover, through the real proxy rather than the state machine
// alone. An independent review found three defects here that unit tests could not have caught,
// because every one of them lived in the wiring: a pool that never heard about the translated
// providers, an empty credential header set going out when the pool had nothing ready, and a
// cancelled turn being charged to the credential as a failure. These are those paths.
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

type Seen = { key: string | undefined; auth: string | undefined };
type Upstream = { port: number; seen: Seen[]; close: () => Promise<void> };

/** A provider that answers whatever `reply` says, and records the credential each request carried. */
async function upstream(reply: (n: number) => { status: number; headers?: Record<string, string>; body?: string; delayMs?: number }): Promise<Upstream> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ key: req.headers["x-api-key"] as string | undefined, auth: req.headers.authorization as string | undefined });
      const r = reply(seen.length);
      // A `delayMs` reply is still in flight when the client gives up, which is the only way to
      // exercise a cancellation: an upstream that answers at once has already finished.
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
        res.end(r.body ?? JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", content: [], usage: {} }));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

type Rig = {
  send: (opts?: { cancel?: boolean; conversation?: string }) => Promise<number>;
  stop: () => Promise<void>;
};

/** A live proxy in front of `providers`, reachable the way Claude Code reaches it. */
async function rig(providers: Config["providers"], routes: Config["routes"]): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-failover-"));
  const ca = createCa({ cn: "clauderipple test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const proxyPort = await freePort();
  const cfg: Config = { ...DEFAULTS, listen: { host: "127.0.0.1", port: proxyPort }, providers, routes, direct: [] };
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests: new RequestLog(path.join(home, "requests.jsonl")),
  });
  await proxy.listen();

  const send = async (opts: { cancel?: boolean; conversation?: string } = {}): Promise<number> => {
    const sock = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
    await new Promise<void>((r) => sock.once("data", () => r()));
    const secure = tls.connect({ socket: sock, servername: "api.anthropic.com", ca: ca.certPem });
    await new Promise<void>((r) => secure.once("secureConnect", () => r()));
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 1,
      metadata: { user_id: opts.conversation ?? "user-1" },
      messages: [{ role: "user", content: "hi" }],
    });
    secure.write(
      `POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    if (opts.cancel) {
      // What the client does when the user presses escape: drop the connection mid-turn.
      await new Promise<void>((r) => setTimeout(r, 30));
      secure.destroy();
      await new Promise<void>((r) => setTimeout(r, 120));
      return 0;
    }
    const first = await new Promise<Buffer>((r) => secure.once("data", (d: Buffer) => setTimeout(() => r(d), 40)));
    secure.destroy();
    return Number(/^HTTP\/1\.1 (\d{3})/.exec(first.toString("latin1"))?.[1] ?? 0);
  };

  return {
    send,
    stop: async () => { proxy.close(); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

const pooled = (port: number): Provider => ({
  type: "anthropic-compatible",
  url: `http://127.0.0.1:${port}`,
  credentials: [
    { id: "first", headers: { "x-api-key": "one" } },
    { id: "second", headers: { "x-api-key": "two" } },
  ],
} as Provider);

test("a rate-limited credential hands the conversation to the next one, which then keeps it", async () => {
  // The first key is always out of quota; the second always answers.
  const up = await upstream((n) => n === 1
    ? { status: 429, headers: { "retry-after": "300" }, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }) }
    : { status: 200 });
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    assert.equal(await r.send(), 429, "the first turn discovers the limit");
    assert.equal(await r.send(), 200);
    assert.equal(await r.send(), 200);
    assert.deepEqual(up.seen.map((s) => s.key), ["one", "two", "two"], "moved once, then stayed for the cache");
  } finally { await r.stop(); await up.close(); }
});

test("with every credential cooling, the request still carries one — not an empty header set", async () => {
  // Both keys rate-limit, so the pool has nothing ready by the third turn. The danger this pins:
  // falling back to `provider.headers` (absent here) sent an unauthenticated request, whose 401
  // then quarantined a credential that had done nothing wrong.
  const up = await upstream(() => ({ status: 429, headers: { "retry-after": "300" }, body: "{}" }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    await r.send();
    await r.send();
    await r.send();
    assert.equal(up.seen.length, 3);
    for (const s of up.seen) assert.ok(s.key === "one" || s.key === "two", `credential present, got ${s.key}`);
  } finally { await r.stop(); await up.close(); }
});

test("a cancelled turn is not charged to the credential, so the next turn keeps the cache", async () => {
  // Destroying the upstream request makes Node emit ECONNRESET, which used to look exactly like the
  // provider dropping us: the credential was cooled and the conversation moved to another one.
  // The second turn is held open long enough for the client to give up on it mid-flight.
  const up = await upstream((n) => (n === 2 ? { status: 200, delayMs: 400 } : { status: 200 }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    await r.send();
    assert.equal(up.seen[0]?.key, "one");
    await r.send({ cancel: true });
    assert.equal(up.seen.length, 2, "the cancelled turn did reach the provider");
    await r.send();
    assert.equal(up.seen[up.seen.length - 1]?.key, "one", "still on the credential it was on");
  } finally { await r.stop(); await up.close(); }
});

test("an exhausted provider hands the turn to its fallback, and a healthy one keeps it", async () => {
  const primary = await upstream(() => ({ status: 429, headers: { "retry-after": "300" }, body: "{}" }));
  const backup = await upstream(() => ({ status: 200 }));
  const r = await rig(
    {
      prim: { type: "anthropic-compatible", url: `http://127.0.0.1:${primary.port}`, headers: { "x-api-key": "p" } } as Provider,
      back: { type: "anthropic-compatible", url: `http://127.0.0.1:${backup.port}`, headers: { "x-api-key": "b" } } as Provider,
    },
    { "claude-opus-4-8": { provider: "prim", model: "m1", fallbacks: [{ provider: "back", model: "m2" }] } },
  );
  try {
    assert.equal(await r.send(), 429, "the first turn finds the limit");
    assert.equal(await r.send(), 200);
    assert.equal(await r.send(), 200);
    assert.equal(primary.seen.length, 1, "the exhausted provider is not asked again");
    assert.equal(backup.seen.length, 2);
  } finally { await r.stop(); await primary.close(); await backup.close(); }
});

test("a failover never lands on a provider that serves the ingress only", async () => {
  // §5: a slot pointing at a native `anthropic` provider answers 400 for every request. `resolve`
  // refuses one as a primary; a fallback must not be the way back in.
  const primary = await upstream(() => ({ status: 429, headers: { "retry-after": "300" }, body: "{}" }));
  const r = await rig(
    {
      prim: { type: "anthropic-compatible", url: `http://127.0.0.1:${primary.port}`, headers: { "x-api-key": "p" } } as Provider,
      native: { type: "anthropic", auth: "claude-code" } as Provider,
    },
    { "claude-opus-4-8": { provider: "prim", model: "m1", fallbacks: [{ provider: "native", model: "claude-opus-5" }] } },
  );
  try {
    await r.send();
    const second = await r.send();
    assert.notEqual(second, 400, "must not have been handed to the ingress-only provider");
    assert.equal(primary.seen.length, 2, "stays with the primary, which refuses for itself");
  } finally { await r.stop(); await primary.close(); }
});
