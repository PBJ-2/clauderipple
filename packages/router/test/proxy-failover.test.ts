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
  /** The same turn, keeping the whole answer so a test can assert on the body too. */
  sendDetailed: () => Promise<{ status: number; body: string }>;
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

  /** The same turn, keeping the whole answer so a test can assert on the body too. */
  const sendDetailed = async (): Promise<{ status: number; body: string }> => {
    const sock = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
    await new Promise<void>((r) => sock.once("data", () => r()));
    const secure = tls.connect({ socket: sock, servername: "api.anthropic.com", ca: ca.certPem });
    await new Promise<void>((r) => secure.once("secureConnect", () => r()));
    const body = JSON.stringify({ model: "claude-opus-4-8", max_tokens: 1, metadata: { user_id: "user-1" }, messages: [{ role: "user", content: "hi" }] });
    secure.write(
      `POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    const first = await new Promise<Buffer>((r) => secure.once("data", (d: Buffer) => setTimeout(() => r(d), 120)));
    secure.destroy();
    const text = first.toString("utf8");
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
    const split = text.indexOf("\r\n\r\n");
    return { status, body: split >= 0 ? text.slice(split + 4) : "" };
  };

  return {
    send,
    sendDetailed,
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
    // The first turn spends both credentials — the limited one, then the one that answers — and
    // every turn after it goes straight to the second and stays there for the cache.
    assert.equal(await r.send(), 200);
    assert.equal(await r.send(), 200);
    assert.equal(await r.send(), 200);
    assert.deepEqual(up.seen.map((s) => s.key), ["one", "two", "two", "two"]);
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
    assert.ok(up.seen.length >= 3, `every turn reached the provider, got ${up.seen.length}`);
    // The point: never an unauthenticated request, whose 401 would quarantine an innocent key.
    for (const s of up.seen) assert.ok(s.key === "one" || s.key === "two", `credential present, got ${s.key}`);
  } finally { await r.stop(); await up.close(); }
});

// A relay reporting a broken upstream answers 403, and that is not a statement about our key. It was
// charged as an auth failure, so one bad minute parked a working credential for the next minute and
// every turn in between reached the user as an authentication error (2026-09-21).
test("a 403 about a broken upstream is not charged to the credential", async () => {
  const relayError = JSON.stringify({ error: { type: "server_error", message: "Error from provider (Console Go): Upstream request failed: [server_error] Upstream response was not valid JSON" } });
  // Every request is refused this way, so the pool has to stay usable turn after turn. If the first
  // turn parked the credential, the second would come back with the auth error instead of the
  // provider's own refusal.
  const up = await upstream(() => ({ status: 403, body: relayError }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    assert.equal(await r.send(), 403);
    assert.equal(await r.send(), 403, "the second turn is answered, not refused for a parked key");
    // Turn 1 spends both credentials and ends on the second, so the pool holds the conversation
    // there. Turn 2 must start on that same one. If the 403 had parked it, `pick` would have had
    // nothing usable and fallen back to the first credential — which is what this rules out.
    assert.equal(up.seen[2]?.key, "two", "turn 2 starts on the credential the conversation held");
  } finally { await r.stop(); await up.close(); }
});

// The other half of the same bug: a 403 arriving with a body was answered by destroying the upstream
// and never writing anything, so the turn died as a client-side socket reset rather than with the
// provider's own message.
test("a 403 keeps the provider's body instead of dropping the connection", async () => {
  const relayError = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed" } });
  const up = await upstream(() => ({ status: 403, body: relayError }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    const res = await r.sendDetailed();
    assert.equal(res.status, 403);
    // Chunked, because the body is written from memory and its length is already decided then: the
    // point is that the provider's own words arrive at all, where destroying the upstream sent none.
    assert.match(res.body, /Upstream request failed/, "the refusal reached the client, not an empty socket");
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

test("one client request survives a rate-limited credential without the client seeing it", async () => {
  // The turn that discovers a limit used to be spent: the client got the 429 and had to retry it
  // itself. Nothing has been written to the client yet at that point, so the router can take the
  // next credential and answer on the first ask.
  const up = await upstream((n) => n === 1
    ? { status: 429, headers: { "retry-after": "300" }, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }) }
    : { status: 200 });
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    assert.equal(await r.send(), 200, "answered on the first ask");
    assert.deepEqual(up.seen.map((s) => s.key), ["one", "two"], "both credentials tried, within one turn");
  } finally { await r.stop(); await up.close(); }
});

test("a retry stops when there is nothing left rather than looping", async () => {
  // Every credential is limited. The client gets the provider's own refusal once, not a hang and
  // not one attempt per credential per retry.
  const up = await upstream(() => ({ status: 429, headers: { "retry-after": "300" }, body: "{}" }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    assert.equal(await r.send(), 429);
    assert.equal(up.seen.length, 2, "tried each credential once, then gave the answer to the client");
  } finally { await r.stop(); await up.close(); }
});

test("a request that is wrong is not retried against the rest of the pool", async () => {
  // A 400 is refused everywhere. Retrying it burns the pool and still fails.
  const up = await upstream(() => ({ status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }) }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    assert.equal(await r.send(), 400);
    assert.equal(up.seen.length, 1, "asked once");
  } finally { await r.stop(); await up.close(); }
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
