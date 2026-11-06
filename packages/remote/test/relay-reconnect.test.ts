// Reconnects through the relay must always leave a phone a working route to the host.
//
// On 2026-10-15 the host logged ~120 relay reconnects and afterwards no phone could connect
// (web and native sat at "connecting") while the host's control socket was open and answering
// pings. Measured on the deployed relay with throwaway server ids: a replaced host control socket
// whose other end never answers the close stays in the Durable Object's socket list — 8 minutes
// and counting — and the room kept sending every phone's "connect" to it (`sockets("host")[0]`),
// through any number of host reconnects and a host restart. The moment that socket finally
// closed, phones reached the current host.
//
// Here the room, the host's RelayHost and a phone's RelaySocket run in process over a fake network
// that behaves like Cloudflare in that respect: a socket whose path is cut never completes a close,
// so the room keeps listing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import nacl from "tweetnacl";
import { toB64u } from "../src/e2ee.ts";
import { HOST_SILENT_MS, PING_MS, RELAY_CLOSE, STALE_MS } from "../src/protocol.ts";
import { ROUTE_CHECK_MS, ROUTE_FIRST_MS, ROUTE_TIMEOUT_MS, RelayHost } from "../src/relay.ts";
import type { WsLike } from "../src/relay.ts";
import type { Peer } from "../src/server.ts";
import { Room } from "../relay/room.ts";
import type { RoomCtx, Sock } from "../relay/room.ts";
import { RelaySocket } from "../web/secure.ts";
import type { RawSocket } from "../web/secure.ts";

class Clock {
  now = 1_800_000_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  set = (fn: () => void, ms: number): number => { const id = this.next++; this.timers.push({ at: this.now + ms, fn, id }); return id; };
  clear = (id: unknown): void => { this.timers = this.timers.filter((t) => t.id !== id); };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = this.timers[0];
      if (!t || t.at > end) break;
      this.timers.shift();
      this.now = Math.max(this.now, t.at); // a timer overdue after freeze() runs late, at "now"
      t.fn();
    }
    this.now = end;
  }
  /** The process was suspended for `ms`: no timer ran meanwhile; they all fire late, at once. */
  freeze(ms: number): void { this.now += ms; }
}

type Data = string | ArrayBuffer | Uint8Array;

/** The relay's end of one connection, as the room sees it. */
class RoomSock implements Sock {
  tags: string[] = [];
  /** Close finished: the runtime no longer lists it. */
  gone = false;
  closeCode: number | null = null;
  readonly wire: Wire;
  constructor(wire: Wire) { this.wire = wire; }
  send(data: Data): void {
    if (this.gone || this.closeCode !== null) throw new Error("closed");
    this.wire.toClient(data);
  }
  close(code = 1000, reason = ""): void {
    if (this.gone || this.closeCode !== null) return;
    this.closeCode = code;
    this.wire.serverClosed(code, reason);
  }
}

/** One-way delay of every frame and close, so nothing answers inside the call that caused it. */
const LATENCY_MS = 5;

/** One TCP path between a client and the relay. `cut` stops everything both ways, closes included. */
class Wire {
  cut = false;
  readonly sock: RoomSock;
  client: { deliver(data: Data): void; closedByServer(code: number, reason: string): void } | null = null;
  private net: Net;
  constructor(net: Net) { this.net = net; this.sock = new RoomSock(this); }
  private later(fn: () => void): void { this.net.clock.set(() => { if (!this.cut) fn(); }, LATENCY_MS); }
  toClient(data: Data): void { this.later(() => this.client?.deliver(data)); }
  toServer(data: Data): void {
    this.later(() => {
      if (this.sock.gone) return;
      // The Durable Object's auto-response: answered by the runtime, never reaching the room.
      if (data === "ping" && this.sock.tags.includes("host")) { this.net.lastPing.set(this.sock, this.net.clock.now); this.toClient("pong"); return; }
      this.net.room.message(this.sock, typeof data === "string" ? data : data instanceof Uint8Array ? data.slice().buffer : data);
    });
  }
  /** The room closed it: the client answers the close, unless the path is cut. */
  serverClosed(code: number, reason: string): void {
    this.later(() => {
      this.finish();
      this.client?.closedByServer(code, reason);
    });
  }
  /** The client closed or dropped it: the relay hears of it, unless the path is cut. */
  clientClosed(): void { this.later(() => this.finish()); }
  private finish(): void {
    if (this.sock.gone) return;
    this.sock.gone = true;
    this.net.room.closed(this.sock);
  }
}

class Net {
  readonly clock = new Clock();
  readonly lastPing = new Map<RoomSock, number>();
  readonly accepted: RoomSock[] = [];
  readonly room: Room<RoomSock>;
  /** New connections fail while the network is down. */
  down = false;
  private n = 0;
  constructor() {
    const ctx: RoomCtx<RoomSock> = {
      accept: (ws, tags) => { ws.tags = tags; this.accepted.push(ws); },
      // Like Cloudflare: listed until its close completed, in acceptance order.
      sockets: (tag) => this.accepted.filter((s) => !s.gone && s.tags.includes(tag)),
      tags: (ws) => ws.tags,
      lastPing: (ws) => this.lastPing.get(ws) ?? null,
      now: () => this.clock.now,
      get: async () => undefined,
      put: async () => {},
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      postExpo: async () => {},
      newId: () => `conn-${String(++this.n).padStart(4, "0")}`,
      sha256: async (s) => s,
    };
    this.room = new Room(ctx);
  }

  /** Accept a new connection a moment after it was made (the upgrade's round trip). */
  dial(url: string, wire: Wire, open: () => void, refuse: (status: number) => void, fail: () => void): void {
    this.clock.set(() => {
      if (this.down) { fail(); return; }
      const u = new URL(url);
      if (u.pathname === "/ws/host-data" && !this.room.hasClient(u.searchParams.get("conn") ?? "")) { refuse(404); return; }
      open();
      if (u.pathname === "/ws/host") this.room.hostControl(wire.sock);
      else if (u.pathname === "/ws/host-data") this.room.hostData(wire.sock, u.searchParams.get("conn")!);
      else this.room.client(wire.sock);
    }, 50);
  }
}

/** The host's socket (the `ws` package's shape) over a Wire. */
class HostWs extends EventEmitter implements WsLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly wire: Wire;
  constructor(net: Net, url: string, headers: Record<string, string>) {
    super();
    this.url = url;
    this.headers = headers;
    this.wire = new Wire(net);
    this.wire.client = {
      deliver: (data) => {
        if (this.readyState !== 1) return;
        if (typeof data === "string") this.emit("message", Buffer.from(data), false);
        else this.emit("message", Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)), true);
      },
      closedByServer: (code, reason) => this.end(code, reason),
    };
    net.dial(url, this.wire,
      () => { if (this.readyState !== 0) return; this.readyState = 1; this.emit("open"); },
      (status) => { if (this.readyState === 0) this.emit("unexpected-response", {}, { statusCode: status }); },
      () => { if (this.readyState === 0) this.end(1006, ""); });
  }
  send(data: string | Uint8Array): void { if (this.readyState === 1) this.wire.toServer(data); }
  close(code = 1000): void { if (this.readyState >= 2) return; this.wire.clientClosed(); this.end(code, ""); }
  terminate(): void { if (this.readyState === 3) return; this.wire.clientClosed(); this.end(1006, ""); }
  private end(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}

/** The phone's raw socket (browser / React Native shape) over a Wire. */
class PhoneWs implements RawSocket {
  binaryType = "blob";
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closeCode: number | null = null;
  private wire: Wire;
  constructor(net: Net, url: string) {
    this.wire = new Wire(net);
    this.wire.client = {
      deliver: (data) => { if (this.readyState === 1) this.onmessage?.({ data: typeof data === "string" ? data : data instanceof Uint8Array ? data.slice().buffer : data }); },
      closedByServer: (code) => this.end(code),
    };
    net.dial(url, this.wire, () => { this.readyState = 1; this.onopen?.({}); }, () => this.end(1006), () => this.end(1006));
  }
  send(data: string | Uint8Array): void { if (this.readyState === 1) this.wire.toServer(typeof data === "string" ? data : data.slice().buffer); }
  close(code = 1000): void { if (this.readyState === 3) return; this.wire.clientClosed(); this.end(code); }
  private end(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    this.onclose?.({ code });
  }
}

const SERVER = "server-id-0123456789";

function setup() {
  const net = new Net();
  const hostKey = nacl.box.keyPair();
  const logs: string[] = [];
  const controls: HostWs[] = [];
  const peers: Peer[] = [];
  const makeHost = (): RelayHost => new RelayHost({
    relay: "https://relay.example", serverId: SERVER, secret: "s".repeat(43), hostKey, nacl,
    makeSocket: (url, headers) => { const ws = new HostWs(net, url, headers); if (url.includes("/ws/host?")) controls.push(ws); return ws; },
    onPeer: (peer) => {
      peers.push(peer);
      peer.on("message", (d) => peer.send(`echo:${String(d)}`));
    },
    now: () => net.clock.now, setTimer: net.clock.set, clearTimer: net.clock.clear,
    log: (line) => logs.push(line),
  });
  /** A phone tries once, as RelaySocket over the relay; true when its frames reach the host and come back. */
  const phoneReaches = (): { ok: boolean; closed: number | null } => {
    const raw = new PhoneWs(net, `wss://relay.example/ws/client?server=${SERVER}`);
    const phone = new RelaySocket(raw, { url: "https://relay.example", server: SERVER, hpk: toB64u(hostKey.publicKey) }, nacl);
    const got: string[] = [];
    phone.onmessage = (ev) => got.push(String(ev.data));
    let opened = false;
    phone.onopen = () => { opened = true; phone.send("hello"); };
    // The phone's own link gives a socket READY_MS (8 s) to open.
    for (let i = 0; i < 80 && !got.length && raw.readyState !== 3; i++) net.clock.advance(100);
    const ok = opened && got.includes("echo:hello");
    phone.close(1000);
    return { ok, closed: raw.closeCode };
  };
  return { net, logs, controls, peers, makeHost, phoneReaches };
}

/** Cut the path of a host's control socket the way a network change does: no frames, no FIN, no close. */
function cut(ws: HostWs): void { ws.wire.cut = true; }

test("room: a replaced host socket that never answers its close is never sent a phone again", () => {
  const { net, phoneReaches, makeHost, controls } = setup();
  const host = makeHost();
  host.start();
  net.clock.advance(1000);
  const first = controls[0]!;
  assert.equal(host.state, "open");
  // The path of the first control socket dies without a FIN; the host notices the silence and reconnects.
  cut(first);
  net.clock.advance(STALE_MS + PING_MS + 2000);
  assert.ok(controls.length >= 2, "the host reconnected");
  assert.equal(host.state, "open");
  const old = first.wire.sock;
  assert.equal(old.closeCode, RELAY_CLOSE.replaced, "the room closed the old socket");
  assert.equal(old.gone, false, "…which, unanswered, the runtime still lists");
  assert.equal(net.room["ctx"].sockets("host").length, 2);
  // Before the fix the room sent the phone to sockets("host")[0] — the dead one.
  assert.equal(phoneReaches().ok, true);
  assert.equal(phoneReaches().ok, true);
  host.stop();
});

test("replacing a data socket keeps the phone and its new peer alive when the old close arrives", () => {
  const net = new Net();
  const control = new Wire(net);
  net.room.hostControl(control.sock);
  const phone = new Wire(net);
  const frames: Data[] = [];
  phone.client = { deliver: data => frames.push(data), closedByServer() {} };
  net.room.client(phone.sock);
  const conn = phone.sock.tags.find(tag => tag.startsWith("c:"))!.slice(2);
  const old = new Wire(net), replacement = new Wire(net);
  net.room.hostData(old.sock, conn);
  net.room.hostData(replacement.sock, conn);
  assert.equal(old.sock.closeCode, RELAY_CLOSE.replaced);
  net.clock.advance(50);
  assert.equal(old.sock.gone, true);
  // A fresh room (hibernation) has no in-memory replacement map to rely on.
  new Room(net.room["ctx"]).closed(old.sock);
  assert.equal(phone.sock.closeCode, null);
  assert.equal(replacement.sock.closeCode, null);
  net.room.message(replacement.sock, "still connected");
  net.clock.advance(10);
  assert.ok(frames.includes("still connected"));
  phone.clientClosed();
  net.clock.advance(20);
  assert.equal(replacement.sock.closeCode, 1000, "the current phone's real close still closes its peer");
});

test("a host restart while a dead socket is still listed: the new host gets the phones", () => {
  const { net, phoneReaches, makeHost, controls } = setup();
  const before = makeHost();
  before.start();
  net.clock.advance(1000);
  cut(controls[0]!);
  net.clock.advance(STALE_MS + PING_MS + 2000);
  before.stop(); // a clean stop: its live socket's close completes
  net.clock.advance(1000);
  const after = makeHost();
  after.start();
  net.clock.advance(1000);
  assert.equal(net.room["ctx"].sockets("host").length, 2, "the dead socket from before is still listed");
  assert.equal(phoneReaches().ok, true);
  after.stop();
});

test("drop, reconnect, overlap: through many reconnects every phone still reaches the host", () => {
  const { net, phoneReaches, makeHost, controls, logs } = setup();
  const host = makeHost();
  host.start();
  net.clock.advance(1000);
  for (let round = 0; round < 6; round++) {
    const current = controls.at(-1)!;
    // Even rounds: a dead path — the dead socket stays listed next to the new one.
    // Odd rounds: a clean drop from the relay's side (a deploy, an edge restart) that the host answers.
    if (round % 2 === 0) cut(current);
    else current.wire.sock.close(1001, "going away");
    net.clock.advance(STALE_MS + PING_MS + 3000);
    assert.equal(host.state, "open", `round ${round}: reconnected`);
    assert.equal(phoneReaches().ok, true, `round ${round}: a phone reaches the host`);
  }
  assert.ok(logs.some((l) => /nothing from the relay for \d+ s; dropping/.test(l)), "the drop says why");
  assert.ok(logs.some((l) => /connected again after \d+ attempt\(s\), \d+ s without the relay/.test(l)));
  host.stop();
});

test("half-open newest socket: the room stops sending phones to a host that went silent, and closes it", () => {
  const { net, makeHost, controls, phoneReaches } = setup();
  const host = makeHost();
  host.start();
  net.clock.advance(1000);
  assert.equal(phoneReaches().ok, true);
  // The Mac sleeps: its process and its path go quiet together; the relay hears no ping.
  cut(controls[0]!);
  host.stop(); // nothing the host does reaches the relay now
  net.clock.advance(HOST_SILENT_MS + 1000);
  const r = phoneReaches();
  assert.equal(r.ok, false);
  assert.equal(r.closed, RELAY_CLOSE.hostOffline, "the phone hears 'host offline' instead of waiting on a socket nobody reads");
  assert.equal(controls[0]!.wire.sock.closeCode, RELAY_CLOSE.stale);
});

test("a host that keeps pinging stays routable long past HOST_SILENT_MS", () => {
  const { net, makeHost, phoneReaches } = setup();
  const host = makeHost();
  host.start();
  net.clock.advance(10 * HOST_SILENT_MS);
  assert.equal(phoneReaches().ok, true);
  host.stop();
});

test("the host walks the phone's path after each hello and every 5 minutes; a probe never becomes a phone", () => {
  const { net, makeHost, controls, peers } = setup();
  const host = makeHost();
  host.start();
  net.clock.advance(ROUTE_FIRST_MS + 1000);
  assert.equal(host.routeFailures, 0);
  const probes = () => net.accepted.filter((s) => s.tags.includes("client")).length;
  assert.equal(probes(), 1, "one route check after the hello");
  net.clock.advance(ROUTE_CHECK_MS);
  assert.equal(probes(), 2);
  assert.equal(controls.length, 1, "passing checks do not reconnect");
  assert.equal(peers.length, 0, "probes never say hello, so the host never sees them as phones");
  host.stop();
});

test("route check: when the relay stops letting phones through, the host reconnects and they reach it again", () => {
  const { net, makeHost, controls, phoneReaches, logs } = setup();
  const host = makeHost();
  host.start();
  net.clock.advance(ROUTE_FIRST_MS + 1000);
  // Something the pings cannot see: the relay keeps answering this socket but no longer routes to it
  // (e.g. a room that lost track of it). Stand-in: its "connect" frames stop arriving.
  const deaf = controls[0]!;
  const deliver = deaf.wire.client!.deliver;
  deaf.wire.client!.deliver = (data) => { if (typeof data === "string" && data.includes(`"connect"`)) return; deliver(data); };
  assert.equal(phoneReaches().ok, false, "broken: the phone is not let through");
  net.clock.advance(ROUTE_CHECK_MS + ROUTE_TIMEOUT_MS + 10_000);
  assert.ok(controls.length >= 2, "the failed route check reconnected");
  assert.ok(logs.some((l) => /route check failed \(not let through within 10 s\)/.test(l)));
  assert.equal(phoneReaches().ok, true);
  net.clock.advance(ROUTE_CHECK_MS);
  assert.ok(logs.some((l) => /phones reach this host again/.test(l)));
  host.stop();
});

test("a stalled event loop is not taken for a dead connection", () => {
  const { net, makeHost, controls, logs, phoneReaches } = setup();
  const host = makeHost();
  host.start();
  net.clock.advance(ROUTE_FIRST_MS + 1000);
  // 40 s with no timer running (a blocking call); the relay's pongs were answered meanwhile.
  net.clock.freeze(STALE_MS + PING_MS);
  net.clock.advance(STALE_MS);
  assert.equal(controls.length, 1, "no reconnect");
  assert.ok(logs.some((l) => /timers ran \d+ s late/.test(l)));
  assert.equal(phoneReaches().ok, true);
  host.stop();
});

test("after a sleep the dead socket is still dropped, a few seconds after waking", () => {
  const { net, makeHost, controls } = setup();
  const host = makeHost();
  host.start();
  net.clock.advance(1000);
  cut(controls[0]!);
  net.clock.freeze(10 * 60_000);
  net.clock.advance(PING_MS);
  assert.ok(controls.length >= 2, "reconnected within one ping interval of waking");
  host.stop();
});

test("replaced by another host with the same id: back off fully instead of trading the room every second", () => {
  const { net, makeHost, controls, logs } = setup();
  const a = makeHost();
  a.start();
  net.clock.advance(1000);
  const b = makeHost();
  b.start();
  net.clock.advance(1000);
  assert.equal(controls[0]!.readyState, 3, "a was replaced");
  assert.ok(logs.some((l) => /replaced by another connection with this server id/.test(l)));
  const count = controls.length;
  net.clock.advance(20_000);
  assert.equal(controls.length, count, "a waits rather than replacing b at once");
  a.stop();
  b.stop();
});
