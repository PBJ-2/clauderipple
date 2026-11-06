// Holding new model calls while the network goes back from the hotspot to Wi-Fi (hold.ts,
// tether.ts). A held call must wait — nothing written, not refused, not 503 — and then complete,
// because zero vanished requests is an acceptance metric. These drive the real proxy and the real
// OpenAI ingress; the Mac is a fake runner (no osascript, no networksetup is ever run).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import type { RunResult } from "../src/awake.ts";
import { CertStore } from "../src/certs.ts";
import { DEFAULTS, TETHER_DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { HoldGate } from "../src/hold.ts";
import { OpenAiIngress } from "../src/ingress/server.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { DISASSOCIATE_JS, SCAN_KNOWN_JS, TetherController } from "../src/tether.ts";
import { createCa } from "../src/x509.ts";

const noClaudeCodeCredentialReaders = { keychain: () => null, credentialsFile: () => null };

// ---- The gate alone -----------------------------------------------------------------------------

/** Timers the test fires by hand. */
function manualTimers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    timers: { set: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { fn, ms }); return id; }, clear: (t: unknown) => void pending.delete(t as number) },
    fire: (ms: number) => { for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); } },
    pending: () => [...pending.values()].map((t) => t.ms),
  };
}

test("an open gate does not hold; an engaged one holds until release", async () => {
  const gate = new HoldGate();
  assert.deepEqual(await gate.wait(), { ms: 0, timedOut: false });
  assert.equal(gate.engage("switch", 60_000), true);
  let done = false;
  const w = gate.wait().then((r) => { done = true; return r; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  assert.equal(gate.waiting, 1);
  assert.equal(gate.release(), 1);
  assert.equal((await w).timedOut, false);
  assert.equal(gate.engaged, false);
  assert.equal(gate.release(), 0, "idempotent");
});

test("no call waits longer than the longest hold, and a forgotten gate releases itself", async () => {
  const t = manualTimers();
  const gate = new HoldGate({ maxHoldMs: 90_000, timers: t.timers });
  gate.engage("switch", 360_000);
  const w = gate.wait();
  assert.deepEqual(t.pending().sort(), [360_000, 90_000].sort());
  t.fire(90_000);
  assert.equal((await w).timedOut, true);
  assert.equal(gate.waiting, 0);
  assert.equal(gate.engaged, true, "the gate itself is still engaged");
  const w2 = gate.wait();
  t.fire(360_000); // the failsafe
  assert.equal((await w2).timedOut, false);
  assert.equal(gate.engaged, false);
  assert.deepEqual(t.pending(), [], "no timer left behind");
});

test("a closed gate (draining router) releases everyone and cannot be engaged again", async () => {
  const gate = new HoldGate();
  gate.engage("switch", 60_000);
  const w = gate.wait();
  assert.equal(gate.close(), 1);
  await w;
  assert.equal(gate.engage("switch", 60_000), false);
  assert.equal(gate.engaged, false);
});

// ---- Through the real proxy ---------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const MESSAGE = JSON.stringify({ id: "m", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });

/** An Anthropic-compatible provider; a request whose body says "slow" waits until `finishSlow()`. */
async function provider() {
  const seen: string[] = [];
  let finishSlow: () => void = () => {};
  const slow = new Promise<void>((r) => { finishSlow = r; });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      const tag = body.includes("slow") ? "slow" : "fast";
      seen.push(tag);
      void (tag === "slow" ? slow : Promise.resolve()).then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(MESSAGE);
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, seen, finishSlow: () => finishSlow(), close: () => server.close() };
}

type Sent = { status: Promise<number>; firstByteAt: () => number | null; bytes: () => number };

async function proxyRig(hold: HoldGate) {
  const up = await provider();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-hold-"));
  const ca = createCa({ cn: "clauderipple test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const port = await freePort();
  const providers = { p: { type: "anthropic-compatible", url: `http://127.0.0.1:${up.port}`, headers: { "x-api-key": "k" } } as Provider };
  const cfg: Config = { ...DEFAULTS, listen: { host: "127.0.0.1", port }, providers, routes: { "claude-opus-4-8": { provider: "p", model: "m" } }, direct: [], aliases: {} };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const lines: string[] = [];
  const log = new Logger(path.join(home, "router.log"), 1e6, 1, false);
  const info = log.info.bind(log);
  log.info = (m: string) => { lines.push(m); info(m); };
  const proxy = new Proxy({ config: () => cfg, log, certs: new CertStore(home), health: new UpstreamHealth(() => 100, () => {}), home, requests, agentDir: path.join(home, "agents"), hold });
  await proxy.listen();

  /** One turn the way Claude Code sends it (CONNECT, TLS, POST /v1/messages). */
  const send = async (text: string): Promise<Sent> => {
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
    await new Promise<void>((r) => sock.once("data", () => r()));
    const secure = tls.connect({ socket: sock, servername: "api.anthropic.com", ca: ca.certPem });
    await new Promise<void>((r) => secure.once("secureConnect", () => r()));
    const body = JSON.stringify({ model: "claude-opus-4-8", max_tokens: 1, messages: [{ role: "user", content: text }] });
    secure.write(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    let firstByteAt: number | null = null;
    let received = "";
    const status = new Promise<number>((resolve) => {
      secure.on("data", (d: Buffer) => {
        firstByteAt ??= Date.now();
        received += d.toString("latin1");
        if (received.includes("\r\n\r\n")) {
          resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0));
          setTimeout(() => secure.destroy(), 20);
        }
      });
      secure.on("close", () => resolve(0));
    });
    return { status, firstByteAt: () => firstByteAt, bytes: () => received.length };
  };
  return { proxy, up, send, requests, lines, stop: () => { proxy.close(); up.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}

const until = async (cond: () => boolean, what: string, ms = 5_000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("postponed → hold engaged after the grace period → the held call waits, then completes → return → released", async () => {
  const hold = new HoldGate();
  const r = await proxyRig(hold);
  try {
    // A fake Mac on the hotspot whose disassociate lands on a working home Wi-Fi.
    const clock = { t: 1_000_000 };
    let ip = "172.20.10.2";
    const events: string[] = [];
    const run = async (file: string, args: string[]): Promise<RunResult> => {
      const line = [file, ...args].join(" ");
      if (line === "/usr/sbin/networksetup -listallhardwareports") return { code: 0, stdout: "Hardware Port: Wi-Fi\nDevice: en0\n", stderr: "" };
      if (line === "/usr/sbin/networksetup -listpreferredwirelessnetworks en0") return { code: 0, stdout: "Preferred networks on en0:\n\tPBJ\n\tHome\n", stderr: "" };
      if (file === "/usr/bin/osascript" && args[3] === SCAN_KNOWN_JS) {
        assert.equal(hold.engaged, false, "visibility is established before the hold gate engages");
        assert.deepEqual(JSON.parse(args[5]!), ["Home"]);
        return { code: 0, stdout: JSON.stringify({ freshMs: 9_500, nets: [{ ssid: "Home", rssi: -40 }], found: [{ name: "Home", rssi: -40 }] }), stderr: "" };
      }
      if (file === "/usr/bin/osascript" && args[3] === DISASSOCIATE_JS) {
        events.push(`leave (held ${hold.waiting}, provider saw ${r.up.seen.join(",")})`);
        ip = "192.168.1.4";
        return { code: 0, stdout: "ok\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${line}`);
    };
    const tlines: string[] = [];
    let releasedAt = 0;
    const c = new TetherController({
      platform: "darwin",
      run,
      settings: () => ({ ...TETHER_DEFAULTS, enabled: true, hotspotSsid: "PBJ" }),
      // The router's own counters, as index.ts wires them.
      activity: () => ({ inFlight: r.proxy.stats.messagesInFlight, ...(r.proxy.stats.lastMessageStartedAt !== undefined ? { lastStartedAt: clock.t } : {}) }),
      log: {
        info: (m) => { tlines.push(m); if (/hold released/.test(m)) releasedAt = Date.now(); },
        warn: (m) => tlines.push(`WARN ${m}`),
      },
      now: () => clock.t,
      // Fake time for the controller, but real I/O keeps moving underneath it.
      sleep: async (ms) => { clock.t += ms; await new Promise((res) => setTimeout(res, 10)); },
      interfaces: () => ({ en0: [{ address: ip, family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }] }),
      probe: async () => true,
      schedule: () => () => {},
      hold,
    });

    // A long call is running (Claude, a subagent: there is always one).
    const a = await r.send("slow");
    await until(() => r.up.seen.length === 1, "the running call to reach the provider");
    // 0..410s: the return is due at the 5 min point (300s) and postponed; nothing is held yet.
    for (let i = 0; i < 42; i++) {
      await c.tick();
      clock.t += 10_000;
    }
    assert.equal(hold.engaged, false);
    assert.ok(tlines.some((l) => /Wi-Fi return postponed: a model call is running/.test(l)));

    // 420s, 120s past due: the controller makes the gap.
    const forced = c.tick();
    await until(() => hold.engaged, "the hold");
    const b = await r.send("fast");
    await until(() => hold.waiting === 1, "the new call to reach the gate");
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(b.bytes(), 0, "nothing is written to a held call");
    assert.deepEqual(r.up.seen, ["slow"], "a held call does not reach the provider");
    assert.equal(r.proxy.stats.messagesInFlight, 1, "a held call is not counted, so the switch waits only for the running one");

    r.up.finishSlow();
    assert.equal(await a.status, 200);
    await forced;
    assert.equal(await b.status, 200, "the held call completes — not refused, not 503");
    assert.deepEqual(events, ["leave (held 1, provider saw slow)"], "the hotspot was left while the new call still waited");
    assert.deepEqual(r.up.seen, ["slow", "fast"]);
    assert.ok(releasedAt > 0 && b.firstByteAt()! >= releasedAt, "the held call's first byte came after the release");
    assert.equal(hold.engaged, false);
    assert.equal(c.status().network, "wifi");
    assert.ok(r.lines.some((l) => /^HOLD POST \/v1\/messages waited \d+\.\ds$/.test(l)), r.lines.join("\n"));
    await until(() => r.requests.list(10).length === 2, "both request records");
    assert.ok(r.requests.list(10).every((rec) => rec.ok && rec.status === 200));
  } finally {
    r.stop();
  }
});

test("a router that drains while a call is held refuses it with the retryable 503 — it does not vanish", async () => {
  const hold = new HoldGate();
  const r = await proxyRig(hold);
  try {
    hold.engage("switch", 60_000);
    const b = await r.send("fast");
    await until(() => hold.waiting === 1, "the call to reach the gate");
    // beginDrain() (index.ts) only calls drain(); drain() lets the held call go itself.
    const drained = r.proxy.drain(1_000);
    assert.equal(hold.closed, true);
    assert.equal(await b.status, 503);
    await drained;
    assert.equal(hold.engage("switch", 60_000), false, "a draining router never holds again");
    const rec = r.requests.list(10)[0]!;
    assert.equal(rec.refusal, "drain");
    assert.deepEqual(r.up.seen, []);
  } finally {
    r.up.close();
  }
});

// ---- Through the real OpenAI ingress ------------------------------------------------------------

test("the OpenAI ingress holds a model call the same way, and never holds anything else", async () => {
  const up = await provider();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-hold-ingress-"));
  const config: Config = {
    ...DEFAULTS,
    listen: { host: "127.0.0.1", port: 30000, openaiPort: 0 },
    providers: { local: { type: "anthropic-compatible", url: `http://127.0.0.1:${up.port}`, headers: { "x-api-key": "k" } } },
    routes: { "claude-sonnet-5": { provider: "local", model: "claude-sonnet-5" } },
    direct: [],
    aliases: {},
  };
  const hold = new HoldGate();
  const ingress = new OpenAiIngress({ config: () => config, log: new Logger(path.join(root, "router.log"), 1e6, 1, false), requests: new RequestLog(path.join(root, "requests.jsonl")), claudeCodeCredentialReaders: noClaudeCodeCredentialReaders, hold });
  const port = await ingress.listen();
  const call = (pathname: string, body?: unknown) => {
    let firstByteAt: number | null = null;
    const data = body === undefined ? undefined : JSON.stringify(body);
    const status = new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: pathname, method: data ? "POST" : "GET", headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
        firstByteAt ??= Date.now();
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(data);
    });
    return { status, firstByteAt: () => firstByteAt };
  };
  try {
    hold.engage("switch", 60_000);
    assert.equal(await call("/v1/models").status, 200, "a model list is not a model call: never held");
    const held = call("/v1/chat/completions", { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] });
    await until(() => hold.waiting === 1, "the call to reach the gate");
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(held.firstByteAt(), null, "nothing is written to a held call");
    assert.deepEqual(up.seen, []);
    const releasedAt = Date.now();
    hold.release();
    assert.equal(await held.status, 200);
    assert.ok(held.firstByteAt()! >= releasedAt);
    assert.deepEqual(up.seen, ["fast"]);
    // Draining with a call held: it is let go and refused with the retryable 503, not cut.
    hold.engage("switch", 60_000);
    const late = call("/v1/chat/completions", { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] });
    await until(() => hold.waiting === 1, "the second call to reach the gate");
    const drained = ingress.drain(1_000);
    assert.equal(await late.status, 503);
    await drained;
    assert.deepEqual(up.seen, ["fast"]);
  } finally {
    await ingress.drain(100);
    up.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
