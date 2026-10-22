// Credential rotation and provider failover, through the real proxy rather than the state machine
// alone. An independent review found three defects here that unit tests could not have caught,
// because every one of them lived in the wiring: a pool that never heard about the translated
// providers, an empty credential header set going out when the pool had nothing ready, and a
// cancelled turn being charged to the credential as a failure. These are those paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import zlib from "node:zlib";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import { createCa, createLeaf } from "../src/x509.ts";
import { saveGoogleAccount } from "../src/providers/google/accounts.ts";
import { capacityRetry, GoogleAdapter } from "../src/providers/google/index.ts";
import { saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";

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
async function upstream(reply: (n: number) => { status: number; headers?: Record<string, string>; body?: string | Buffer; delayMs?: number }): Promise<Upstream> {
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
  /** The same turn again, keeping the answer as bytes — a compressed body is not text. */
  sendRaw: () => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
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

  /** The same turn again, keeping the answer as bytes — a compressed body is not text. */
  const sendRaw = async (): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> => {
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
    const chunks: Buffer[] = [];
    secure.on("data", (d: Buffer) => chunks.push(d));
    await new Promise<void>((r) => setTimeout(r, 250));
    secure.destroy();
    const all = Buffer.concat(chunks);
    const split = all.indexOf("\r\n\r\n");
    const head = all.subarray(0, split < 0 ? all.length : split).toString("latin1");
    const headers: Record<string, string> = {};
    for (const line of head.split("\r\n").slice(1)) {
      const at = line.indexOf(":");
      if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    return {
      status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0),
      headers,
      body: split < 0 ? Buffer.alloc(0) : all.subarray(split + 4),
    };
  };

  return {
    send,
    sendDetailed,
    sendRaw,
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

test("the anthropic-compatible wire answers every-paused locally, and falls back only to a non-paused key", async () => {
  // The same rule the openai-compatible branch follows: pausing is the operator's decision, so with
  // every key paused there is nothing to send on — and when only one is paused the fallback must not
  // be `credentials[0]`, which may be the paused key itself.
  const up = await upstream(() => ({ status: 429, headers: { "retry-after": "300" }, body: "{}" }));
  const provider = pooled(up.port);
  (provider as { credentials: { paused?: boolean }[] }).credentials[0]!.paused = true;
  const r = await rig({ p: provider }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    // Turn 1 goes out on the unpaused key and cools it; turn 2 has nothing usable and must still
    // carry that same key, never the paused one.
    assert.equal(await r.send(), 429);
    assert.equal(await r.send(), 429);
    assert.deepEqual(up.seen.map((s) => s.key), ["two", "two"], "the paused key is never asked, even as the last resort");
  } finally { await r.stop(); await up.close(); }
});

test("with every anthropic-compatible key paused the router refuses locally, without calling upstream", async () => {
  const up = await upstream(() => ({ status: 200 }));
  const provider = pooled(up.port);
  for (const credential of (provider as { credentials: { paused?: boolean }[] }).credentials) credential.paused = true;
  const r = await rig({ p: provider }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    assert.equal(await r.sendDetailed().then((res) => res.status), 503);
    assert.equal(up.seen.length, 0, "nothing went upstream");
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
    // A relay's broken upstream says nothing about the credential, so the turn is asked twice on the
    // key it started on and only then may move. Here the other key is just as broken, so each turn
    // still ends on the provider's own 403 — and neither key is charged for it.
    assert.deepEqual(up.seen.map((seen) => seen.key), ["one", "one", "two", "two", "two", "one"], "one retry on the starting key, then the next key, per turn");
    // Nothing was parked either: the second turn of the same conversation starts on its first key.
    assert.equal(up.seen.at(-1)?.key, "one", "the conversation was not rotated by a refusal that was not the key's");
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

// The third part of the same bug, and the one that reached a user: reading the 403 body handed it
// on as a UTF-8 string. A compressed body is arbitrary binary, so every invalid sequence became
// U+FFFD and never came back — while `content-encoding` still stood in the response. Claude Desktop
// showed `net::ERR_CONTENT_DECODING_FAILED` on every message for an hour, because its OAuth refresh
// was answering 403 zstd (2026-09-22). Chromium 152 asks for zstd, so this is the ordinary case.
for (const [encoding, compress] of [
  ["zstd", (b: Buffer) => (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync(b)],
  ["gzip", (b: Buffer) => zlib.gzipSync(b)],
  ["br", (b: Buffer) => zlib.brotliCompressSync(b)],
] as const) {
  test(`a ${encoding} 403 body reaches the client byte for byte`, async () => {
    const relayError = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed" } });
    const packed = compress(Buffer.from(relayError));
    const up = await upstream(() => ({
      status: 403,
      headers: { "content-encoding": encoding, "content-length": String(packed.length) },
      body: packed,
    }));
    const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
    try {
      const res = await r.sendRaw();
      assert.equal(res.status, 403);
      assert.equal(res.headers["content-encoding"], encoding, "the encoding was promised, so it must still hold");
      assert.deepEqual(res.body, packed, "the bytes came back unchanged");
      // What the browser does with them. Before the fix this threw, which is the user-visible bug.
      const decoded = encoding === "zstd"
        ? (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(res.body)
        : encoding === "gzip" ? zlib.gunzipSync(res.body) : zlib.brotliDecompressSync(res.body);
      assert.equal(decoded.toString("utf8"), relayError);
    } finally { await r.stop(); await up.close(); }
  });
}

// The judgement that reads a 403 body is the reason it is read at all (§5). A compressed body used
// to arrive at it as mojibake, so a relay's "upstream failed" was unreadable and the credential was
// charged for it — the very failure the 403 body was introduced to prevent.
test("a compressed relay 403 is still recognised, so the credential is not parked", async () => {
  const relayError = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed" } });
  const packed = zlib.gzipSync(Buffer.from(relayError));
  const up = await upstream(() => ({
    status: 403,
    headers: { "content-encoding": "gzip", "content-length": String(packed.length) },
    body: packed,
  }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    assert.equal(await r.send(), 403);
    assert.equal(await r.send(), 403, "the second turn is answered, not refused for a parked key");
    // Exactly as in the uncompressed case above: readable or not, a relay report is not about the
    // key, so nothing is charged and nothing rotates for the refusal. Each turn is asked twice on its
    // starting key and then on the other, which is just as broken.
    assert.deepEqual(up.seen.map((seen) => seen.key), ["one", "one", "two", "two", "two", "one"], "the compressed relay report was read, so nothing was charged");
  } finally { await r.stop(); await up.close(); }
});

// A refusal longer than the reader's cap is the one 403 that cannot go back as it arrived: its bytes
// stop mid-stream, so they are no longer a whole compressed body and neither the upstream's
// `content-encoding` nor its `content-length` describes what is written. Leaving either in place is
// the same ERR_CONTENT_DECODING_FAILED by a different route. Reaching the client readable at all
// takes a flushing decode — a strict one throws `Z_BUF_ERROR` on a stream that stops (Node 24).
test("a compressed 403 past the read cap arrives decoded, with nothing left promising an encoding", async () => {
  const relayError = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed" } });
  // Random hex, because anything repetitive compresses to well under the cap and would not be truncated.
  const packed = zlib.gzipSync(Buffer.from(relayError + crypto.randomBytes(20_000).toString("hex")));
  assert.ok(packed.length > 4096, "the compressed body must exceed the read cap for this to test anything");
  const up = await upstream(() => ({
    status: 403,
    headers: { "content-encoding": "gzip", "content-length": String(packed.length) },
    body: packed,
  }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    const res = await r.sendRaw();
    assert.equal(res.status, 403);
    assert.equal(res.headers["content-encoding"], undefined, "nothing may promise an encoding these bytes no longer carry");
    assert.equal(res.headers["content-length"], undefined, "the upstream's length described the compressed body, not this one");
    assert.match(res.body.toString("utf8"), /Upstream request failed/, "the head of the provider's own message arrived readable");
  } finally { await r.stop(); await up.close(); }
});

// The judgement runs on the head, so a relay report too long to read whole must still be classified
// from the part that arrived. Otherwise a 403 past the cap parks a credential that did nothing —
// the original failure, reached by a body size instead of a compression.
test("a relay 403 too long to read whole is still recognised from its head", async () => {
  const relayError = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed" } });
  const packed = zlib.gzipSync(Buffer.from(relayError + crypto.randomBytes(20_000).toString("hex")));
  const up = await upstream(() => ({
    status: 403,
    headers: { "content-encoding": "gzip", "content-length": String(packed.length) },
    body: packed,
  }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    assert.equal(await r.send(), 403);
    assert.equal(await r.send(), 403, "the second turn is answered, not refused for a parked key");
    assert.deepEqual(up.seen.map((seen) => seen.key), ["one", "one", "two", "two", "two", "one"], "the truncated relay report was read, so nothing was charged and nothing was parked");
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

// Born from a provider outage: the primary answers 503 on every attempt, so the turn it was asked
// on cannot be saved. The provider-level cooldown recorded by that failure is what makes the NEXT
// turn use the route's fallback instead of spending another turn discovering the same outage.
test("a primary answering 5xx sends the next turn to its fallback", async () => {
  const down = await upstream(() => ({ status: 503, body: JSON.stringify({ error: { message: "bad gateway" } }) }));
  const back = await upstream(() => ({ status: 200 }));
  const r = await rig(
    {
      prim: { type: "openai-compatible", url: `http://127.0.0.1:${down.port}/v1`, headers: { authorization: "Bearer k" } } as Provider,
      back: { type: "anthropic-compatible", url: `http://127.0.0.1:${back.port}`, headers: { "x-api-key": "b" } } as Provider,
    },
    { "claude-opus-4-8": { provider: "prim", model: "m1", fallbacks: [{ provider: "back", model: "m2" }] } },
  );
  try {
    assert.notEqual(await r.send(), 200, "the outage reaches the client on the turn that found it");
    assert.equal(back.seen.length, 0, "the fallback was not invented inside that turn");
    assert.equal(await r.send(), 200, "the next turn goes to the fallback");
    assert.equal(back.seen.length, 1);
    assert.equal(down.seen.length >= 2, true, `the primary was retried inside the first turn, got ${down.seen.length}`);
  } finally { await r.stop(); await down.close(); await back.close(); }
});

// The same rule on the anthropic-compatible wire: a 503 says nothing about the key, so it is asked
// again once on that key before the turn gives up. The key never moves — moving it takes the prompt
// cache with it (§4) — and the client sees the provider's own answer if the second ask fails too.
// The reason for that retry: a hiccup on the first ask is absorbed without the user or the pool ever
// seeing it. Turn one is a single 503 then an answer, on the same key.
test("a one-off 503 is absorbed by the same-key retry, and the other key is never asked", async () => {
  const up = await upstream((n) => (n === 1 ? { status: 503, body: "{}" } : { status: 200 }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    assert.equal(await r.send(), 200, "the hiccup never reached the client");
    assert.deepEqual(up.seen.map((seen) => seen.key), ["one", "one"], "the same key was asked again; the conversation never moved");
  } finally { await r.stop(); await up.close(); }
});

// The same rule on the anthropic-compatible wire: a 503 says nothing about the key, so it is asked
// again once on that key; only after that second refusal does the turn try the other key, and with
// every key refusing the client gets the provider's own answer.
test("a 503 on a key is asked once more on that key, then the turn moves to the next", async () => {
  const up = await upstream(() => ({ status: 503, body: "{}" }));
  const r = await rig({ p: pooled(up.port) }, { "claude-opus-4-8": { provider: "p", model: "m" } });
  try {
    assert.equal(await r.send(), 503, "every key is down, so the provider's own answer reaches the client");
    assert.deepEqual(up.seen.map((seen) => seen.key), ["one", "one", "two"], "twice on the first key, then the second");
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

// ---- Antigravity prompt refusal: one route fallback, before any byte reaches the client ----------
//
// The adapter reports a refusal it recognised (the exact 429 body, an SDK system paragraph, and
// fresh quota left for the account and model) as an unwritten outcome. The proxy may then try ONE
// configured route fallback with the original request; a second refusal, or no usable fallback, is
// explained to the client with a 400. These drive the real proxy, the real Google adapter and real
// HTTP/TLS fakes; only the quota lookup (global fetch) and the upstream servers are fabricated.
const SDK = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const GENERIC_429 = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota)." } };

type Hit = { path: string; headers: http.IncomingHttpHeaders; body: any };
type Reply = { status: number; headers?: Record<string, string>; body?: string; delayMs?: number };
type Recorder = { port: number; hits: Hit[]; close: () => Promise<void> };

/** A server that records each request (parsed body included) and answers with `reply`. */
async function recorder(reply: (hit: Hit, n: number) => Reply, tlsOptions?: https.ServerOptions): Promise<Recorder> {
  const hits: Hit[] = [];
  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      const hit: Hit = { path: req.url ?? "", headers: req.headers, body };
      hits.push(hit);
      const r = reply(hit, hits.length);
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
        res.end(r.body ?? "{}");
      }, r.delayMs ?? 0);
    });
  };
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const sseOf = (events: [string, unknown][]): string => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

/** What a vendor's Anthropic-shaped endpoint answers, streamed or not, saying `text`. */
function anthropicReply(hit: Hit, text: string): Reply {
  const model = String(hit.body?.model ?? "m");
  const usage = { input_tokens: 5, output_tokens: 3 };
  if (hit.body?.stream === true) {
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sseOf([
        ["message_start", { type: "message_start", message: { id: "msg_fb", type: "message", role: "assistant", model, content: [], usage } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }],
        ["message_stop", { type: "message_stop" }],
      ]),
    };
  }
  return { status: 200, body: JSON.stringify({ id: "msg_fb", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage }) };
}

/** Cloud Code Assist's answer to a turn it accepts, in the stream or whole form the URL asked for. */
function googleAnswer(hit: Hit, text = "google answer"): Reply {
  const frame = { response: { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } } };
  return hit.path.includes("streamGenerateContent")
    ? { status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(frame)}\n\n` }
    : { status: 200, body: JSON.stringify(frame) };
}

const carriesSdk = (hit: Hit): boolean => JSON.stringify(hit.body).includes(SDK);

type QuotaShape = { five?: number | null; weekly?: number | null; reset?: string; extra?: boolean; geminiName?: string };
/** The quota fixture: both windows finite, > 0, resetting in the future, with the measured bucket ids. */
function quotaBody(o: QuotaShape = {}): string {
  const reset = o.reset ?? new Date(Date.now() + 3_600_000).toISOString();
  const group = (displayName: string, prefix: string) => {
    const bucket = (window: "5h" | "weekly", fraction: number | null | undefined, fallback: number) => fraction === null ? [] : [{
      bucketId: `${prefix}-${window}`, displayName: window, window, resetTime: reset, remainingFraction: fraction ?? fallback,
    }];
    const buckets: { bucketId: string; displayName: string; window: string; resetTime: string; remainingFraction: number }[] = [...bucket("5h", o.five, 0.4), ...bucket("weekly", o.weekly, 0.6)];
    if (o.extra) buckets.push({ bucketId: `${prefix}-daily`, displayName: "daily", window: "daily", resetTime: reset, remainingFraction: 0.5 });
    return { displayName, buckets };
  };
  return JSON.stringify({ groups: [group(o.geminiName ?? "Gemini Models", "gemini"), group("Claude and GPT models", "3p")] });
}

type Quota = "fresh" | "none" | { body: string };

type FRig = {
  proxy: Proxy;
  google: Recorder;
  compat: Recorder;
  openai: Recorder;
  chatgpt: Recorder;
  native: Recorder;
  quotaCalls: () => number;
  post: (body: unknown, disconnect?: Promise<void>) => Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>;
  records: (n?: number) => Promise<RequestRecord[]>;
  states: () => string[];
  stop: () => Promise<void>;
};

async function frig(opts: {
  routes: () => Config["routes"];
  /** Overrides for the Google fake: default refuses any prompt carrying the SDK paragraph. */
  google?: (hit: Hit, n: number) => Reply;
  quota?: Quota;
  accounts?: number;
}): Promise<FRig> {
  const google = await recorder((hit, n) => opts.google ? opts.google(hit, n) : carriesSdk(hit) ? { status: 429, body: JSON.stringify(GENERIC_429) } : googleAnswer(hit));
  const compat = await recorder((hit) => anthropicReply(hit, "compat answer"));
  const openai = await recorder((hit) => hit.body?.stream === true
    ? { status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: "openai answer" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 6, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n` }
    : { status: 200, body: JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "openai answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 6, completion_tokens: 2 } }) });
  const chatgpt = await recorder(() => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: sseOf([
      ["response.created", { type: "response.created", response: { id: "resp_1" } }],
      ["response.output_item.added", { type: "response.output_item.added", item: { type: "message", id: "m1" } }],
      ["response.output_text.delta", { type: "response.output_text.delta", delta: "chatgpt answer", item_id: "m1" }],
      ["response.output_item.done", { type: "response.output_item.done", item: { type: "message", id: "m1" } }],
      ["response.completed", { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 9, output_tokens: 3 } } }],
    ]),
  }));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-prompt-fallback-"));
  const ca = createCa({ cn: "clauderipple prompt fallback test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const native = await recorder((hit) => anthropicReply(hit, "native answer"), { cert: leaf.certPem, key: leaf.keyPem });
  for (let n = 1; n <= (opts.accounts ?? 1); n++) {
    saveGoogleAccount(home, { accessToken: `token-${n}`, projectId: `project-${n}`, email: `user-${n}@example.test`, expiresAt: Date.now() + 3_600_000 });
  }
  fs.writeFileSync(path.join(home, "chatgpt-auth.json"), JSON.stringify({ accessToken: "tok_test", accountId: "acct_test", expiresAt: Date.now() + 3_600_000, source: "own" }));
  saveClaudeOAuthAccount(home, { accessToken: "native-token", refreshToken: "native-refresh", expiresAt: Date.now() + 3_600_000, accountId: "native-upstream-uuid", email: "native@example.test" });

  let quotaCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).includes("retrieveUserQuotaSummary")) {
      quotaCalls++;
      const quota = opts.quota ?? "fresh";
      return new Response(typeof quota === "object" ? quota.body : quotaBody(), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const proxyPort = await freePort();
  const providers: Config["providers"] = {
    g: { type: "google", auth: "antigravity", url: `http://127.0.0.1:${google.port}` } as Provider,
    c: {
      type: "anthropic-compatible", url: `http://127.0.0.1:${compat.port}`,
      credentials: [{ id: "c1", headers: { "x-api-key": "c1" } }, { id: "c2", headers: { "x-api-key": "c2" } }],
      caps: { effortLevels: ["low", "medium", "high"] },
    } as Provider,
    o: { type: "openai-compatible", url: `http://127.0.0.1:${openai.port}/v1`, headers: { authorization: "Bearer secret" }, caps: { reasoning: "effort", effortLevels: ["low", "medium", "high"] } } as Provider,
    gpt: { type: "chatgpt", auth: "own", url: `http://127.0.0.1:${chatgpt.port}` } as Provider,
    claude: { type: "anthropic", auth: "claude-code", accountPool: true } as Provider,
    ingress: { type: "anthropic", auth: "claude-code" } as Provider,
  };
  const cfg: Config = { ...DEFAULTS, upstream: "localhost", listen: { host: "127.0.0.1", port: proxyPort }, providers, routes: opts.routes(), direct: [] };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests,
    agentDir: path.join(home, "agents"),
    upstreamPort: native.port,
    upstreamAgent: new https.Agent({ ca: ca.certPem }),
  });
  await proxy.listen();
  // Seed the quota evidence the way production does: a lookup through the real adapter.
  if ((opts.quota ?? "fresh") !== "none") await proxy.googleUsage("g");

  const post: FRig["post"] = async (body, disconnect) => {
    const sock = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((r) => sock.once("data", () => r()));
    const secure = tls.connect({ socket: sock, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((r) => secure.once("secureConnect", () => r()));
    const raw = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const agent = new http.Agent({ keepAlive: false });
      (agent as unknown as { createConnection: () => tls.TLSSocket }).createConnection = () => secure;
      const guard = setTimeout(() => { secure.destroy(); reject(new Error("post timed out")); }, 8000);
      secure.once("close", () => clearTimeout(guard));
      const req = http.request({
        agent, method: "POST", path: "/v1/messages",
        headers: { host: "localhost", "content-type": "application/json", "content-length": Buffer.byteLength(raw), "x-claude-code-session-id": "sess-1" },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => { secure.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }); });
        res.on("error", reject);
      });
      req.on("error", (e) => { secure.destroy(); if (disconnect) resolve({ status: 0, headers: {}, text: "" }); else reject(e); });
      req.end(raw);
      if (disconnect) void disconnect.then(() => {
        clearTimeout(guard);
        req.destroy(); secure.destroy(); sock.destroy(); agent.destroy();
        resolve({ status: 0, headers: {}, text: "" });
      });
    });
  };

  return {
    proxy, google, compat, openai, chatgpt, native,
    quotaCalls: () => quotaCalls,
    post,
    records: async (n = 1) => {
      // The record is written when the turn finishes, which can trail the last byte the client read.
      for (let i = 0; i < 100; i++) {
        const rows = requests.list(50).filter((r) => r.kind === "messages");
        if (rows.length >= n) return rows;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      return requests.list(50).filter((r) => r.kind === "messages");
    },
    states: () => (proxy.googleAccounts().g ?? []).map((a) => a.state),
    stop: async () => {
      globalThis.fetch = realFetch;
      proxy.close();
      await Promise.all([google, compat, openai, chatgpt, native].map((s) => s.close()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A Claude Code turn as the SDK sends it: the SDK paragraph, a tool, a thread, an effort. */
const turn = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: "claude-opus-4-8",
  max_tokens: 64,
  stream: true,
  metadata: { user_id: "user-1" },
  system: [{ type: "text", text: "Keep the user's instructions." }, { type: "text", text: SDK }],
  messages: [{ role: "user", content: "hello" }],
  tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
  thread: { type: "create" },
  output_config: { effort: "high" },
  ...over,
});

const route = (fallbacks: { provider: string; model: string; effort?: string }[], model = "gemini-3.8-flash"): Config["routes"] =>
  ({ "claude-opus-4-8": { provider: "g", model, fallbacks } as Config["routes"][string] });

const errorOf = (text: string): { type: string; message: string } => (JSON.parse(text) as { error: { type: string; message: string } }).error;

test("prompt refusal, streamed: the fallback answers, nothing of the refusal reaches the client", async () => {
  const r = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }]) });
  try {
    const res = await r.post(turn());
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);
    assert.match(res.text, /compat answer/);
    assert.doesNotMatch(res.text, /Antigravity|invalid_request_error|RESOURCE_EXHAUSTED/, "the refusal is not spliced into the answer");
    assert.equal(r.google.hits.length, 1, "Google was asked once and not walked account by account");
    assert.equal(r.compat.hits.length, 1);
    const sent = r.compat.hits[0]!;
    assert.equal(sent.body.model, "fb-model");
    assert.equal(sent.body.stream, true);
    assert.deepEqual(sent.body.tools, turn().tools, "the client's tools reach the fallback untouched");
    assert.deepEqual(sent.body.messages, [{ role: "user", content: "hello" }]);
    assert.equal(sent.body.thread, undefined, "an Anthropic-shaped vendor never sees a thread");
    assert.equal(sent.body.output_config?.effort, "high", "the client's effort is the one the fallback gets");
    const [rec] = await r.records();
    assert.equal(rec!.status, 200);
    assert.equal(rec!.ok, true);
    assert.equal(rec!.provider, "c", "telemetry names the route that answered");
    assert.equal(rec!.target, "fb-model");
    assert.equal(rec!.source, "claude-opus-4-8");
    assert.equal(rec!.refusal, undefined, "the turn succeeded, so it is not recorded as a refusal");
    assert.equal(rec!.upstreamCalled, undefined, "Google was called first, so the request must never say nothing was");
    assert.match(rec!.note ?? "", /Antigravity SDK prompt refusal/);
    assert.match(rec!.note ?? "", /fallback g\/gemini-3\.8-flash → c\/fb-model/);
    assert.doesNotMatch(rec!.note ?? "", /token|Bearer|project-1/i, "the note carries no credential");
    assert.equal(rec!.effort, "high");
    assert.equal(rec!.stream, true);
    assert.deepEqual(r.states(), ["ready"], "no account was rested for a refusal that is about the prompt");
  } finally { await r.stop(); }
});

test("prompt refusal, not streamed: the fallback's whole message is the answer", async () => {
  const r = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }]) });
  try {
    const res = await r.post(turn({ stream: false }));
    assert.equal(res.status, 200);
    const message = JSON.parse(res.text) as { content: { text: string }[]; model: string };
    assert.equal(message.content[0]!.text, "compat answer");
    assert.equal(message.model, "fb-model");
    assert.equal(r.compat.hits[0]!.body.stream, false);
    assert.equal(r.google.hits.length, 1);
    const [rec] = await r.records();
    assert.equal(rec!.ok, true);
    assert.equal(rec!.provider, "c");
    assert.equal(rec!.stream, false);
    assert.equal(rec!.upstreamCalled, undefined);
  } finally { await r.stop(); }
});

test("a fallback after a prompt refusal rests neither the account nor the primary route", async () => {
  const r = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }]), accounts: 2 });
  try {
    assert.equal((await r.post(turn())).status, 200);
    assert.equal(r.google.hits.length, 1, "the second account was not asked the same prompt");
    assert.deepEqual(r.states(), ["ready", "ready"]);
    // A prompt without the SDK paragraph goes straight back to Google: the route was not moved.
    const next = await r.post(turn({ system: "A different client.", stream: false }));
    assert.equal(next.status, 200);
    assert.match(next.text, /google answer/);
    assert.equal(r.google.hits.length, 2);
    assert.equal(r.compat.hits.length, 1, "the fallback was used once, for the refused prompt only");
    const rows = await r.records(2);
    assert.deepEqual(rows.map((x) => x.provider).sort(), ["c", "g"]);
  } finally { await r.stop(); }
});

test("the native fallback receives the original request, not what the Google attempt made of it", async () => {
  // Native Messages need no translation, so the body the fallback gets is the clone of the original
  // with only the model replaced: thread, tools, system and effort intact, although the Google
  // attempt stripped the thread and translated the rest.
  const r = await frig({ routes: () => route([{ provider: "claude", model: "claude-opus-5" }]) });
  try {
    const original = turn();
    const res = await r.post(original);
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /native answer/);
    assert.equal(r.google.hits.length, 1);
    assert.equal(r.native.hits.length, 1);
    assert.deepEqual(r.native.hits[0]!.body, { ...original, model: "claude-opus-5" });
    assert.equal(r.native.hits[0]!.headers.authorization, "Bearer native-token", "the native fallback authenticates as its own account");
    const [rec] = await r.records();
    assert.equal(rec!.provider, "claude");
    assert.equal(rec!.target, "claude-opus-5");
    assert.equal(rec!.upstreamCalled, undefined);
    assert.equal(rec!.effort, "high");
  } finally { await r.stop(); }
});

test("the fallback's own effort wins; without one it inherits the route's", async () => {
  const own = await frig({ routes: () => route([{ provider: "c", model: "fb-model", effort: "medium" }]) });
  try {
    assert.equal((await own.post(turn())).status, 200);
    assert.equal(own.compat.hits[0]!.body.output_config.effort, "medium");
    assert.equal((await own.records())[0]!.effort, "medium");
  } finally { await own.stop(); }
  const inherited = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }]) });
  try {
    assert.equal((await inherited.post(turn({ model: "claude-opus-4-8@low", output_config: { effort: "max" } }))).status, 200);
    assert.equal(inherited.compat.hits[0]!.body.output_config.effort, "low");
    assert.equal((await inherited.records())[0]!.effort, "low");
  } finally { await inherited.stop(); }
});

test("a same-provider fallback on another model is allowed, and answers", async () => {
  const r = await frig({
    routes: () => route([{ provider: "g", model: "gemini-3.7-flash" }]),
    // Only the primary's wire model refuses; the other model accepts the very same prompt.
    google: (hit) => String(hit.body.model).startsWith("gemini-3.8-flash") ? { status: 429, body: JSON.stringify(GENERIC_429) } : googleAnswer(hit, "second model"),
  });
  try {
    const res = await r.post(turn());
    assert.equal(res.status, 200);
    assert.match(res.text, /second model/);
    assert.equal(r.google.hits.length, 2);
    assert.match(r.google.hits[0]!.body.model, /^gemini-3\.8-flash/);
    assert.equal(r.google.hits[1]!.body.model, "gemini-3.7-flash-tiered");
    assert.equal(r.google.hits[1]!.headers.authorization, r.google.hits[0]!.headers.authorization, "same account: nothing was rested");
    const [rec] = await r.records();
    assert.equal(rec!.provider, "g");
    assert.equal(rec!.target, "gemini-3.7-flash");
    assert.equal(rec!.upstreamCalled, undefined);
    assert.equal(rec!.ok, true);
    assert.match(rec!.note ?? "", /fallback g\/gemini-3\.8-flash → g\/gemini-3\.7-flash/);
  } finally { await r.stop(); }
});

test("the fallback is tried once: a second refusal gets the explanation, and no third route is asked", async () => {
  const r = await frig({ routes: () => route([{ provider: "g", model: "gemini-3.7-flash" }, { provider: "c", model: "fb-model" }]) });
  try {
    const res = await r.post(turn());
    assert.equal(res.status, 400);
    assert.equal(errorOf(res.text).type, "invalid_request_error");
    assert.match(errorOf(res.text).message, /Antigravity.*Claude Agent SDK/);
    assert.equal(res.headers["retry-after"], undefined);
    assert.equal(r.google.hits.length, 2, "primary and its one fallback, nothing more");
    assert.equal(r.compat.hits.length, 0, "the cap holds although another fallback was configured");
    const [rec] = await r.records();
    assert.equal(rec!.status, 400);
    assert.equal(rec!.ok, false);
    assert.equal(rec!.refusal, "prompt-incompatible");
    assert.equal(rec!.provider, "g");
    assert.equal(rec!.target, "gemini-3.7-flash", "the route that gave the final answer");
    assert.equal(rec!.upstreamCalled, undefined, "Google was called twice, so never upstreamCalled:false");
    assert.match(rec!.note ?? "", /fallback g\/gemini-3\.8-flash → g\/gemini-3\.7-flash/);
    assert.match(rec!.note ?? "", /Antigravity SDK prompt refusal/);
    assert.deepEqual(r.states(), ["ready"]);
  } finally { await r.stop(); }
});

test("without a fallback the client gets the explanation and Google is asked once", async () => {
  const r = await frig({ routes: () => route([]) });
  try {
    const res = await r.post(turn({ stream: false }));
    assert.equal(res.status, 400);
    assert.match(res.headers["content-type"] ?? "", /application\/json/);
    assert.equal(errorOf(res.text).type, "invalid_request_error");
    assert.match(errorOf(res.text).message, /Antigravity.*Claude Agent SDK/);
    assert.match(errorOf(res.text).message, /Resource has been exhausted/);
    assert.equal(r.google.hits.length, 1);
    const [rec] = await r.records();
    assert.equal(rec!.status, 400);
    assert.equal(rec!.refusal, "prompt-incompatible");
    assert.equal(rec!.provider, "g");
    assert.equal(rec!.upstreamCalled, undefined);
    assert.equal(rec!.ok, false);
    assert.deepEqual(r.states(), ["ready"]);
    assert.equal((await r.post(turn({ system: "Other.", stream: false }))).status, 200, "compatible prompts still use the account at once");
  } finally { await r.stop(); }
});

test("duplicate and unusable candidates are skipped; the first usable one answers", async () => {
  const r = await frig({
    routes: () => route([
      { provider: "g", model: "gemini-3.8-flash" },    // the route that just refused
      { provider: "ghost", model: "nowhere" },         // not configured
      { provider: "ingress", model: "claude-opus-5" }, // serves the OpenAI ingress only
      { provider: "c", model: "fb-model" },
    ]),
  });
  try {
    const res = await r.post(turn());
    assert.equal(res.status, 200);
    assert.equal(r.google.hits.length, 1, "the duplicate of the primary is not asked again");
    assert.equal(r.native.hits.length, 0);
    assert.equal(r.compat.hits.length, 1);
    assert.equal((await r.records())[0]!.provider, "c");
  } finally { await r.stop(); }
});

test("with only unusable candidates the client is told why, not handed to one of them", async () => {
  const r = await frig({
    routes: () => route([
      { provider: "g", model: "gemini-3.8-flash" },
      { provider: "ghost", model: "nowhere" },
      { provider: "ingress", model: "claude-opus-5" },
    ]),
  });
  try {
    const res = await r.post(turn());
    assert.equal(res.status, 400);
    assert.match(errorOf(res.text).message, /Antigravity/);
    assert.equal(r.google.hits.length, 1);
    assert.equal(r.native.hits.length, 0);
    assert.equal(r.compat.hits.length, 0);
    const [rec] = await r.records();
    assert.equal(rec!.refusal, "prompt-incompatible");
    assert.equal(rec!.upstreamCalled, undefined);
  } finally { await r.stop(); }
});

test("a preselected Google fallback retains the original route's remaining candidates", async () => {
  const r = await frig({ routes: () => ({ "claude-opus-4-8": {
    provider: "c", model: "primary-model", fallbacks: [
      { provider: "g", model: "gemini-3.8-flash" }, { provider: "o", model: "oai-model" },
    ],
  } }) });
  try {
    const pool = (r.proxy as unknown as { pool: { penalise: (p: string, id: string, status: number, wait: number) => unknown } }).pool;
    for (const id of ["c1", "c2"]) pool.penalise("c", id, 429, 600_000);
    const res = await r.post(turn());
    assert.equal(res.status, 200);
    assert.match(res.text, /openai answer/);
    assert.equal(r.compat.hits.length, 0);
    assert.equal(r.google.hits.length, 1);
    assert.equal(r.openai.hits.length, 1);
    assert.equal((await r.records())[0]!.provider, "o");
    assert.equal(r.proxy.stats.messagesInFlight, 0);
  } finally { await r.stop(); }
});

test("a response closed between Google refusal and dispatch never starts the fallback", async t => {
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const handle = GoogleAdapter.prototype.handle;
  t.mock.method(GoogleAdapter.prototype, "handle", async function (this: GoogleAdapter, ...args: Parameters<GoogleAdapter["handle"]>) {
    const result = await handle.apply(this, args);
    // Deliver the disconnect at the exact handoff boundary, without depending on TCP close timing.
    assert.equal(result.kind, "prompt-incompatible");
    args[1].destroy();
    disconnected();
    return result;
  });
  const r = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }]) });
  try {
    assert.equal((await r.post(turn(), closed)).status, 0);
    const rows = await r.records();
    assert.equal(rows.length, 1, "one completion record despite cancellation");
    assert.equal(rows[0]!.ok, false);
    assert.equal(r.google.hits.length, 1);
    assert.equal(r.compat.hits.length, 0);
    assert.deepEqual(r.states(), ["ready"]);
    assert.equal(r.proxy.stats.inFlight, 0);
    assert.equal(r.proxy.stats.messagesInFlight, 0);
  } finally { await r.stop(); }
});

test("an HTTP-200 error frame cannot trigger route fallback after response commitment", async () => {
  const r = await frig({
    routes: () => route([{ provider: "c", model: "fb-model" }]),
    google: () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(GENERIC_429)}\n\n` }),
  });
  try {
    const res = await r.post(turn());
    assert.equal(res.status, 200);
    assert.match(res.text, /"type":"error"/);
    assert.equal(r.google.hits.length, 1);
    assert.equal(r.compat.hits.length, 0);
    assert.equal((await r.records())[0]!.refusal, undefined);
  } finally { await r.stop(); }
});

test("a candidate whose every credential is cooling is skipped", async () => {
  const r = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }, { provider: "o", model: "oai-model" }]) });
  try {
    const pool = (r.proxy as unknown as { pool: { penalise: (p: string, id: string, status: number, retryAfterMs?: number) => unknown } }).pool;
    pool.penalise("c", "c1", 429, 600_000);
    pool.penalise("c", "c2", 429, 600_000);
    const res = await r.post(turn());
    assert.equal(res.status, 200);
    assert.match(res.text, /openai answer/);
    assert.equal(r.compat.hits.length, 0, "the cooling provider was not sent the turn");
    assert.equal(r.openai.hits.length, 1);
    assert.equal((await r.records())[0]!.provider, "o");
  } finally { await r.stop(); }
});

test("dispatch to an OpenAI-compatible fallback keeps the original model, effort and tools", async () => {
  const r = await frig({ routes: () => route([{ provider: "o", model: "oai-model", effort: "low" }]) });
  try {
    const res = await r.post(turn());
    assert.equal(res.status, 200);
    assert.match(res.text, /openai answer/);
    const sent = r.openai.hits[0]!;
    assert.equal(sent.path, "/v1/chat/completions");
    assert.equal(sent.body.model, "oai-model");
    assert.equal(sent.body.reasoning_effort, "low");
    assert.equal(sent.body.tools?.[0]?.function?.name, "Read");
    assert.equal(sent.body.thread, undefined);
    assert.equal(sent.headers.authorization, "Bearer secret");
    const [rec] = await r.records();
    assert.equal(rec!.provider, "o");
    assert.equal(rec!.upstreamCalled, undefined);
    assert.equal(rec!.ok, true);
  } finally { await r.stop(); }
});

test("dispatch to a ChatGPT fallback keeps the original model, effort and tools", async () => {
  const r = await frig({ routes: () => route([{ provider: "gpt", model: "gpt-6-luna", effort: "medium" }]) });
  try {
    const res = await r.post(turn());
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /chatgpt answer/);
    const sent = r.chatgpt.hits[0]!;
    assert.equal(sent.path, "/codex/responses");
    assert.equal(sent.body.model, "gpt-6-luna");
    assert.equal(sent.body.reasoning?.effort, "medium");
    assert.equal(sent.body.tools?.[0]?.name, "Read");
    assert.equal(sent.headers.authorization, "Bearer tok_test");
    const [rec] = await r.records();
    assert.equal(rec!.provider, "gpt");
    assert.equal(rec!.target, "gpt-6-luna");
    assert.equal(rec!.upstreamCalled, undefined);
    assert.equal(rec!.ok, true);
  } finally { await r.stop(); }
});

// The refusal is only believed when the lookup shows room, because the same 429 body is also what a
// spent account says. Without exact evidence the old handling stands: rest the account, walk the
// pool, and leave the route fallback to the next turn (chooseTarget), not to this one.
for (const [label, quota] of [
  ["no quota lookup has happened", "none"],
  ["the five-hour window is spent", { body: quotaBody({ five: 0 }) }],
  ["the weekly window is spent", { body: quotaBody({ weekly: 0 }) }],
  ["a window is missing", { body: quotaBody({ weekly: null }) }],
  ["an extra bucket appears", { body: quotaBody({ extra: true }) }],
  ["the group is named differently", { body: quotaBody({ geminiName: "Gemini 3" }) }],
  ["a window has already reset", { body: quotaBody({ reset: new Date(Date.now() - 60_000).toISOString() }) }],
  ["the fraction is not a fraction", { body: quotaBody({ five: 1.5 }) }],
] as [string, Quota][]) {
  test(`${label}: the generic 429 stays an ordinary rate limit and does not use the fallback`, async () => {
    const r = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }]), quota, accounts: 2 });
    try {
      const res = await r.post(turn({ stream: false }));
      assert.equal(res.status, 429);
      assert.equal(errorOf(res.text).type, "rate_limit_error");
      assert.equal(r.google.hits.length, 2, "both accounts were tried, as for any 429");
      assert.equal(r.compat.hits.length, 0);
      assert.deepEqual(r.states(), ["cooling", "cooling"]);
      const [rec] = await r.records();
      assert.equal(rec!.refusal, undefined);
      assert.equal(rec!.status, 429);
      assert.doesNotMatch(rec!.note ?? "", /fallback/);
      if (quota === "none") assert.equal(r.quotaCalls(), 0);
    } finally { await r.stop(); }
  });
}

test("a model outside the known quota groups is unknown, never assumed to have room", async () => {
  const r = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }], "mystery-model") });
  try {
    const res = await r.post(turn({ stream: false }));
    assert.equal(res.status, 429);
    assert.equal(r.compat.hits.length, 0);
    assert.equal((await r.records())[0]!.refusal, undefined);
  } finally { await r.stop(); }
});

test("a refusal that is not the exact observed 429 never takes the fallback", async () => {
  for (const [label, reply] of [
    ["a quota message", { status: 429, body: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You have exhausted your capacity on this model. Your quota will reset after 3h." } }) }],
    ["a retry-after header", { status: 429, headers: { "retry-after": "120" }, body: JSON.stringify(GENERIC_429) }],
    ["a 400", { status: 400, body: JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Malformed tool schema" } }) }],
  ] as [string, Reply][]) {
    const r = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }]), google: () => reply });
    try {
      const res = await r.post(turn({ stream: false }));
      assert.notEqual(res.status, 200, label);
      assert.equal(r.compat.hits.length, 0, `${label}: the route fallback was not used`);
      assert.equal((await r.records())[0]!.refusal, undefined, label);
    } finally { await r.stop(); }
  }
});

test("a prompt without the SDK paragraph is never treated as a prompt refusal", async () => {
  const r = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }]), google: () => ({ status: 429, body: JSON.stringify(GENERIC_429) }) });
  try {
    const res = await r.post(turn({ system: "An ordinary assistant.", stream: false }));
    assert.equal(res.status, 429);
    assert.equal(r.compat.hits.length, 0);
    assert.deepEqual(r.states(), ["cooling"]);
  } finally { await r.stop(); }
});

// ---- Antigravity "no capacity for this model": the same unwritten hand-off ----------------------
//
// Measured 2026-10-20: Cloud Code Assist answered 503 MODEL_CAPACITY_EXHAUSTED for
// gemini-3.8-flash-high; the router asked ten times, rested the only account, and every concurrent
// turn got an instant 429 "all accounts resting". Now the adapter asks a few times without resting
// anything and the proxy may hand the turn to ONE configured route fallback (§5).
const CAPACITY_503 = JSON.stringify({ error: {
  code: 503, message: "No capacity available for model gemini-3.8-flash-high on the server", status: "UNAVAILABLE",
  details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "MODEL_CAPACITY_EXHAUSTED", domain: "cloudcode-pa.googleapis.com",
    metadata: { error_number: "2010", model: "gemini-3.8-flash-high", OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST: "true" } }],
} });

function withShortCapacityWaits(): () => void {
  const before = capacityRetry.delaysMs;
  capacityRetry.delaysMs = [20, 20];
  return () => { capacityRetry.delaysMs = before; };
}

test("no capacity, with a fallback: the fallback answers and nothing of the 503 reaches the client", async () => {
  const restore = withShortCapacityWaits();
  const r = await frig({ routes: () => route([{ provider: "c", model: "fb-model" }]), google: () => ({ status: 503, body: CAPACITY_503 }) });
  try {
    const res = await r.post(turn({ system: "Ordinary system instructions." }));
    assert.equal(res.status, 200);
    assert.match(res.text, /compat answer/);
    assert.doesNotMatch(res.text, /MODEL_CAPACITY_EXHAUSTED|overloaded_error/);
    assert.equal(r.google.hits.length, 3, "a bounded number of asks before handing over");
    assert.equal(r.compat.hits.length, 1);
    const [rec] = await r.records();
    assert.equal(rec!.ok, true);
    assert.equal(rec!.provider, "c");
    assert.equal(rec!.refusal, undefined);
    assert.equal(rec!.upstreamCalled, undefined);
    assert.match(rec!.note ?? "", /MODEL_CAPACITY_EXHAUSTED after 3 asks/);
    assert.match(rec!.note ?? "", /fallback g\/gemini-3\.8-flash → c\/fb-model/);
    assert.deepEqual(r.states(), ["ready"], "the account is not rested for the model's capacity");
  } finally { restore(); await r.stop(); }
});

test("no capacity, without a fallback: a clear 529 overloaded_error, and the next turn still reaches Google", async () => {
  const restore = withShortCapacityWaits();
  let capacity = true;
  const r = await frig({ routes: () => route([]), google: (hit) => capacity ? { status: 503, body: CAPACITY_503 } : googleAnswer(hit) });
  try {
    const res = await r.post(turn({ system: "Ordinary system instructions." }));
    assert.equal(res.status, 529);
    assert.match(res.headers["content-type"] ?? "", /application\/json/);
    assert.equal(errorOf(res.text).type, "overloaded_error");
    assert.match(errorOf(res.text).message, /MODEL_CAPACITY_EXHAUSTED/);
    assert.doesNotMatch(errorOf(res.text).message, /every signed-in account is at its limit/);
    assert.equal(r.google.hits.length, 3);
    const [rec] = await r.records();
    assert.equal(rec!.status, 529);
    assert.equal(rec!.ok, false);
    assert.equal(rec!.provider, "g");
    assert.equal(rec!.refusal, undefined);
    assert.deepEqual(r.states(), ["ready"]);
    capacity = false;
    const next = await r.post(turn({ system: "Ordinary system instructions.", stream: false }));
    assert.equal(next.status, 200, "not an instant 429 'all accounts resting'");
    assert.match(next.text, /google answer/);
    assert.equal(r.google.hits.length, 4);
  } finally { restore(); await r.stop(); }
});

test("no capacity on the fallback too: one fallback only, then the clear 529", async () => {
  const restore = withShortCapacityWaits();
  const r = await frig({
    routes: () => route([{ provider: "g", model: "gemini-3.7-flash" }, { provider: "c", model: "fb-model" }]),
    google: () => ({ status: 503, body: CAPACITY_503 }),
  });
  try {
    const res = await r.post(turn({ system: "Ordinary system instructions.", stream: false }));
    assert.equal(res.status, 529);
    assert.equal(errorOf(res.text).type, "overloaded_error");
    assert.equal(r.google.hits.length, 6, "three asks on the primary, three on its one fallback");
    assert.equal(r.compat.hits.length, 0, "the cap holds although another fallback was configured");
    assert.deepEqual(r.states(), ["ready"]);
  } finally { restore(); await r.stop(); }
});
