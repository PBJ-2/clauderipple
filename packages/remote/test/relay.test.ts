// The relay path: the end-to-end encryption, the relay's room (in process, with fake sockets),
// the host's never-give-up control socket under a fake clock, and a phone and a host talking
// through a room with every frame sealed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import nacl from "tweetnacl";
import { BOX_OVERHEAD, Channel, fromB64u, hostAccept, phoneFinish, phoneHello, toB64u } from "../src/e2ee.ts";
import { BACKOFF_CAP_MS, FRAME_CAP, PING_MS, READY_MS, RELAY_CLOSE, RELAY_FRAME_CAP, STALE_MS } from "../src/protocol.ts";
import { RelayHost, SecurePeer, relayBackoff } from "../src/relay.ts";
import type { WsLike } from "../src/relay.ts";
import type { Peer } from "../src/server.ts";
import { Room } from "../relay/room.ts";
import type { RoomCtx, Sock } from "../relay/room.ts";
import { RelaySocket } from "../web/secure.ts";
import type { RawSocket } from "../web/secure.ts";

// ---- e2ee ----------------------------------------------------------------------------------------

function pair(): { host: Channel; phone: Channel; hostKey: nacl.BoxKeyPair } {
  const hostKey = nacl.box.keyPair();
  const hello = phoneHello(nacl);
  const accepted = hostAccept(nacl, hostKey, hello.text);
  const phone = phoneFinish(nacl, hello.eph, hostKey.publicKey, accepted.text);
  return { host: accepted.channel, phone, hostKey };
}

test("handshake: both sides end with one key, and frames go both ways", () => {
  const { host, phone } = pair();
  assert.equal(host.open(phone.seal(`{"t":"hello","token":"секрет 토큰"}`)), `{"t":"hello","token":"секрет 토큰"}`);
  assert.equal(phone.open(host.seal("one")), "one");
  assert.equal(phone.open(host.seal("two")), "two");
  assert.equal(host.open(phone.seal("three")), "three");
});

test("handshake: an answer not made with the paired host's key is refused (the relay cannot stand in)", () => {
  const hostKey = nacl.box.keyPair();
  const impostor = nacl.box.keyPair();
  const hello = phoneHello(nacl);
  const forged = hostAccept(nacl, impostor, hello.text);
  assert.throws(() => phoneFinish(nacl, hello.eph, hostKey.publicKey, forged.text), /not from the paired host/);
  // A genuine answer to another phone's hello does not open for this phone either (replayed ready).
  const other = phoneHello(nacl);
  const replayed = hostAccept(nacl, hostKey, other.text);
  assert.throws(() => phoneFinish(nacl, hello.eph, hostKey.publicKey, replayed.text), /not from the paired host/);
  assert.throws(() => hostAccept(nacl, hostKey, `{"e2ee":"hello","v":1,"pk":"short"}`), /key/);
  assert.throws(() => hostAccept(nacl, hostKey, "not json"), /JSON/);
});

test("frames: altered, replayed, reordered or reflected frames do not open", () => {
  const { host, phone } = pair();
  const a = phone.seal("a");
  const flipped = a.slice();
  flipped[flipped.length - 1]! ^= 1;
  assert.throws(() => host.open(flipped), /did not open/);
  assert.equal(host.open(a), "a");
  assert.throws(() => host.open(a), /did not open/, "replay");
  const b = phone.seal("b");
  const c = phone.seal("c");
  assert.throws(() => host.open(c), /did not open/, "out of order");
  assert.equal(host.open(b), "b");
  // A host frame sent back to the host (direction byte differs) is refused.
  assert.throws(() => host.open(host.seal("x")), /did not open/);
});

test("frame cap: a FRAME_CAP plaintext seals under the relay's cap; base64url round-trips", () => {
  const { host, phone } = pair();
  const big = "x".repeat(FRAME_CAP);
  const sealed = host.seal(big);
  assert.equal(sealed.length, FRAME_CAP + BOX_OVERHEAD);
  assert.ok(sealed.length <= RELAY_FRAME_CAP);
  assert.equal(phone.open(sealed), big);
  const k = nacl.randomBytes(32);
  assert.deepEqual(fromB64u(toB64u(k)), k);
  assert.throws(() => fromB64u("a+b/"), /base64url/);
});

// ---- the relay's room, in process ---------------------------------------------------------------

class FakeSock implements Sock {
  sent: (string | Uint8Array | ArrayBuffer)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  peer: ((data: string | ArrayBuffer) => void) | null = null;
  readonly name: string;
  constructor(name: string) { this.name = name; }
  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(data);
    this.peer?.(typeof data === "string" ? data : data instanceof Uint8Array ? data.slice().buffer : data);
  }
  close(code?: number, reason?: string): void { if (!this.closed) this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }; this.onClose?.(); }
  onClose: (() => void) | null = null;
  texts(): string[] { return this.sent.filter((d): d is string => typeof d === "string"); }
}

function fakeRoom() {
  const tags = new Map<FakeSock, string[]>();
  const store = new Map<string, string>();
  let n = 0;
  const ctx: RoomCtx<FakeSock> = {
    accept: (ws, t) => { tags.set(ws, t); },
    sockets: (tag) => [...tags].filter(([ws, t]) => !ws.closed && t.includes(tag)).map(([ws]) => ws),
    tags: (ws) => tags.get(ws) ?? [],
    lastPing: () => null,
    now: () => Date.now(),
    get: async (k) => store.get(k),
    put: async (k, v) => { store.set(k, v); },
    newId: () => `conn-${String(++n).padStart(4, "0")}`,
    sha256: async (s) => `h(${s})`,
  };
  const room = new Room(ctx);
  // As the Durable Object does: a socket that closes is reported to the room.
  const track = (ws: FakeSock): FakeSock => { ws.onClose = () => room.closed(ws); return ws; };
  return { room, store, track };
}

test("room: the first host registers the server id; a different secret is refused", async () => {
  const { room, store } = fakeRoom();
  assert.equal(await room.hostAllowed("short"), false);
  const secret = "s".repeat(43);
  assert.equal(await room.hostAllowed(secret), true);
  assert.equal(store.get("secret"), `h(${secret})`, "only a hash is kept");
  assert.equal(await room.hostAllowed(secret), true);
  assert.equal(await room.hostAllowed("t".repeat(43)), false);
  assert.equal(await room.hostAllowed(null), false);
});

test("room: phone → connect to host → data socket → open; frames forwarded both ways; closes propagate", () => {
  const { room, track } = fakeRoom();
  const host = track(new FakeSock("host"));
  room.hostControl(host);
  assert.deepEqual(host.texts(), [`{"relay":"hello"}`]);
  const phone = track(new FakeSock("phone"));
  room.client(phone);
  const connect = JSON.parse(host.texts()[1]!) as { relay: string; conn: string };
  assert.equal(connect.relay, "connect");
  assert.equal(room.hasClient(connect.conn), true);
  assert.equal(room.hasClient("conn-nope"), false);
  const data = track(new FakeSock("data"));
  room.hostData(data, connect.conn);
  assert.deepEqual(phone.texts(), [`{"relay":"open","liveness":true}`]);
  room.message(phone, "hello from phone");
  const bin = new Uint8Array([1, 2, 3]).buffer;
  room.message(data, bin);
  assert.deepEqual(data.sent, ["hello from phone"]);
  assert.equal(phone.sent[1], bin);
  // The host's pings are answered (the Durable Object does this without waking, via auto-response).
  room.message(host, "ping");
  assert.equal(host.sent.at(-1), "pong");
  // Over the cap: the sender is closed with 1009, nothing is forwarded.
  room.message(phone, new Uint8Array(RELAY_FRAME_CAP + 1).buffer);
  assert.equal(phone.closed?.code, RELAY_CLOSE.tooBig);
  assert.equal(data.sent.length, 1);
  // The phone left: its data socket closes too.
  assert.ok(data.closed);
});

test("room: a phone's plain ping is answered by the relay itself, never forwarded to the host", () => {
  const { room, track } = fakeRoom();
  const host = track(new FakeSock("host"));
  room.hostControl(host);
  const phone = track(new FakeSock("phone"));
  room.client(phone);
  const conn = (JSON.parse(host.texts().find((t) => t.includes(`"connect"`))!) as { conn: string }).conn;
  const data = track(new FakeSock("data"));
  room.hostData(data, conn);
  assert.deepEqual(JSON.parse(phone.texts()[0]!), { relay: "open", liveness: true }, "the relay says it answers liveness itself");
  const forwarded = data.sent.length;
  room.message(phone, "ping");
  assert.equal(phone.sent.at(-1), "pong", "answered without the host");
  assert.equal(data.sent.length, forwarded, "the ping never reaches the encrypted channel");
  room.message(phone, "pong");
  assert.equal(data.sent.length, forwarded, "a relay pong stops at the room too");
  // A stray plain frame on the host's data socket is answered in place, not handed to the phone.
  const toPhone = phone.sent.length;
  room.message(data, "ping");
  assert.equal(data.sent.at(-1), "pong");
  assert.equal(phone.sent.length, toPhone);
  // The host's control socket keeps its own liveness answer.
  room.message(host, "ping");
  assert.equal(host.sent.at(-1), "pong");
});

test("room: a phone with no host is told at once; a host that comes back is told about waiting phones", () => {
  const { room, track } = fakeRoom();
  const lonely = track(new FakeSock("phone"));
  room.client(lonely);
  assert.equal(lonely.closed?.code, RELAY_CLOSE.hostOffline);
  const host1 = track(new FakeSock("host1"));
  room.hostControl(host1);
  const phone = track(new FakeSock("phone2"));
  room.client(phone);
  // A newer host connection replaces the older one and learns of the phone still waiting for a data socket.
  const host2 = track(new FakeSock("host2"));
  room.hostControl(host2);
  assert.equal(host1.closed?.code, RELAY_CLOSE.replaced);
  assert.ok(host2.texts().some((t) => t.includes(`"connect"`)));
  // The host's data socket leaves: the phone is closed so it reconnects.
  const conn = (JSON.parse(host2.texts().find((t) => t.includes("connect"))!) as { conn: string }).conn;
  const data = track(new FakeSock("data"));
  room.hostData(data, conn);
  data.close(1000);
  assert.equal(phone.closed?.code, RELAY_CLOSE.peerGone);
});

// ---- the host's control socket, under a fake clock ----------------------------------------------

class Clock {
  now = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  set = (fn: () => void, ms: number): number => { const id = this.next++; this.timers.push({ at: this.now + ms, fn, id }); return id; };
  clear = (id: unknown): void => { this.timers = this.timers.filter((t) => t.id !== id); };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers[0];
      if (!t || t.at > end) break;
      this.timers.shift();
      this.now = t.at;
      t.fn();
    }
    this.now = end;
  }
}

class FakeWs extends EventEmitter implements WsLike {
  readyState = 0;
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  readonly url: string;
  readonly headers: Record<string, string>;
  constructor(url: string, headers: Record<string, string>) { super(); this.url = url; this.headers = headers; }
  open(): void { this.readyState = 1; this.emit("open"); }
  text(s: string): void { this.emit("message", Buffer.from(s), false); }
  send(data: string | Uint8Array): void { this.sent.push(data); }
  close(code?: number): void { if (this.readyState === 3) return; this.closedWith = code ?? 1000; this.readyState = 3; this.emit("close", code ?? 1000); }
  terminate(): void { this.close(1006); }
}

function relayHost(onPeer: (p: Peer) => void = () => {}) {
  const clock = new Clock();
  const sockets: FakeWs[] = [];
  const host = new RelayHost({
    relay: "https://relay.example", serverId: "server-id-0123456789", secret: "s".repeat(43), hostKey: nacl.box.keyPair(), nacl,
    makeSocket: (url, headers) => {
      const ws = new FakeWs(url, headers);
      // The host's route checks (a probe phone) are let through at once here; relay-reconnect.test.ts covers them.
      if (url.includes("/ws/client")) { clock.set(() => { ws.open(); ws.text(`{"relay":"open"}`); }, 1); return ws; }
      sockets.push(ws);
      return ws;
    },
    onPeer, now: () => clock.now, setTimer: clock.set, clearTimer: clock.clear,
  });
  return { clock, sockets, host };
}

test("relay host: backoff is min(30 s, n × 1 s) and never stops", () => {
  assert.deepEqual([0, 1, 2, 5, 29, 30, 31, 500].map(relayBackoff), [1000, 1000, 2000, 5000, 29000, 30000, 30000, 30000]);
  const { clock, sockets, host } = relayHost();
  host.start();
  assert.equal(sockets[0]!.url, "wss://relay.example/ws/host?server=server-id-0123456789");
  assert.equal(sockets[0]!.headers["x-ripple-host-secret"], "s".repeat(43));
  // Each attempt is refused at once; the waits between attempts grow by a second up to the cap.
  const waits: number[] = [];
  for (let i = 0; i < 35; i++) {
    const before = sockets.length;
    sockets.at(-1)!.close(1006);
    const start = clock.now;
    while (sockets.length === before) clock.advance(100);
    waits.push(Math.round((clock.now - start) / 1000) * 1000);
  }
  assert.deepEqual(waits.slice(0, 4), [1000, 2000, 3000, 4000]);
  assert.ok(waits.slice(29).every((w) => w === BACKOFF_CAP_MS));
  assert.equal(host.state, "connecting");
  // A good connection resets the count.
  const ws = sockets.at(-1)!;
  ws.open();
  ws.text(`{"relay":"hello"}`);
  assert.equal(host.state, "open");
  assert.equal(host.attempt, 0);
  host.stop();
});

test("relay host: a socket not ready in 8 s is abandoned; a silent one is dropped after 30 s; pings every 10 s", () => {
  const { clock, sockets, host } = relayHost();
  host.start();
  sockets[0]!.open(); // opens, but the relay never says hello
  clock.advance(READY_MS + 1);
  assert.equal(sockets[0]!.closedWith, 1006);
  clock.advance(1000);
  assert.equal(sockets.length, 2);
  const ws = sockets[1]!;
  ws.open();
  ws.text(`{"relay":"hello"}`);
  clock.advance(PING_MS);
  assert.deepEqual(ws.sent, ["ping"]);
  ws.text("pong");
  // Half-open from here: nothing at all comes back.
  const lastRx = clock.now;
  clock.advance(PING_MS);
  assert.deepEqual(ws.sent, ["ping", "ping"]);
  while (ws.closedWith === null) clock.advance(1000);
  assert.ok(clock.now - lastRx > STALE_MS && clock.now - lastRx <= STALE_MS + PING_MS, `dropped ${clock.now - lastRx} ms after the last frame`);
  clock.advance(1000);
  assert.equal(sockets.length, 3, "and it reconnects");
  host.stop();
});

// ---- phone ↔ host through a room, every frame sealed --------------------------------------------

/** A browser WebSocket stand-in for the phone side (web/secure.ts). */
class FakeBrowserWs implements RawSocket {
  binaryType = "blob";
  readyState = 1;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  out: (data: string | Uint8Array) => void = () => {};
  send(data: string | Uint8Array): void { this.out(data); }
  close(code?: number): void { this.readyState = 3; this.onclose?.({ code }); }
}

test("end to end in process: the phone's token reaches the host only sealed, and answers come back", () => {
  const { room, track } = fakeRoom();
  const peers: Peer[] = [];
  const { sockets, host } = relayHost((p) => peers.push(p));
  const relayCopy: (string | ArrayBuffer)[] = [];

  // Wire the host's fake ws sockets to room sockets.
  host.start();
  const control = sockets[0]!;
  const controlInRoom = track(new FakeSock("control"));
  controlInRoom.peer = (d) => control.text(String(d));
  control.open();
  room.hostControl(controlInRoom);
  assert.equal(host.state, "open");

  // The phone connects through the room.
  const hostKey = (host as unknown as { deps: { hostKey: nacl.BoxKeyPair } }).deps.hostKey;
  const browser = new FakeBrowserWs();
  const phoneInRoom = track(new FakeSock("phone"));
  phoneInRoom.peer = (d) => browser.onmessage?.({ data: d });
  browser.out = (d) => { const v = typeof d === "string" ? d : d.slice().buffer; relayCopy.push(v); room.message(phoneInRoom, v); };
  const phone = new RelaySocket(browser, { url: "https://relay.example", server: "server-id-0123456789", hpk: toB64u(hostKey.publicKey) }, nacl);
  let opened = false;
  const got: string[] = [];
  phone.onopen = () => { opened = true; };
  phone.onmessage = (ev) => got.push(String(ev.data));
  room.client(phoneInRoom);

  // The relay told the host; the host opened a data socket; wire it into the room.
  const data = sockets[1]!;
  assert.match(data.url, /\/ws\/host-data\?server=server-id-0123456789&conn=conn-0001$/);
  const dataInRoom = track(new FakeSock("data"));
  dataInRoom.peer = (d) => data.emit("message", typeof d === "string" ? Buffer.from(d) : Buffer.from(d), typeof d !== "string");
  data.send = (d) => { const v = typeof d === "string" ? d : d.slice().buffer; relayCopy.push(v); room.message(dataInRoom, v); };
  data.open();
  room.hostData(dataInRoom, "conn-0001");

  assert.equal(opened, true, "handshake done");
  assert.equal(peers.length, 1);
  const hostSide: string[] = [];
  peers[0]!.on("message", (d) => hostSide.push(String(d)));
  phone.send(`{"t":"hello","token":"the-pairing-token"}`);
  assert.deepEqual(hostSide, [`{"t":"hello","token":"the-pairing-token"}`]);
  peers[0]!.send(`{"t":"ready"}`);
  assert.deepEqual(got, [`{"t":"ready"}`]);
  // What the relay saw: the handshake in the clear (public keys only), then bytes without the token.
  const seen = relayCopy.map((d) => (typeof d === "string" ? d : Buffer.from(d).toString("latin1"))).join("\n");
  assert.doesNotMatch(seen, /the-pairing-token/);
  assert.doesNotMatch(seen, /\{"t":"ready"\}/);

  // A frame the relay altered ends the phone's socket rather than being believed.
  const forged = new Uint8Array(40);
  browser.onmessage?.({ data: forged.buffer });
  assert.equal(phone.readyState, 3);
  host.stop();
});

test("SecurePeer refuses plaintext after the handshake", () => {
  const { host } = pair();
  const ws = new FakeWs("x", {});
  ws.open();
  const peer = new SecurePeer(ws, host);
  let closed = false;
  peer.on("close", () => { closed = true; });
  ws.emit("message", Buffer.from(`{"t":"hello"}`), false);
  assert.equal(closed, true);
  assert.equal(ws.closedWith, 4400);
});

test("RelaySocket beats only after the relay says it answers a plain ping", () => {
  const hostKey = nacl.box.keyPair();
  const open = (frame: string) => {
    const sent: (string | Uint8Array)[] = [];
    const got: unknown[] = [];
    const raw = new FakeBrowserWs();
    raw.out = (data) => {
      sent.push(data);
      if (typeof data === "string" && data.startsWith(`{"e2ee":"hello"`)) {
        // The paired host's answer to the phone's handshake.
        raw.onmessage?.({ data: hostAccept(nacl, hostKey, data).text });
      }
    };
    const socket = new RelaySocket(raw, { url: "https://relay.example", server: "server-id-0123456789", hpk: toB64u(hostKey.publicKey) }, nacl);
    let closed = false;
    socket.onmessage = (ev) => got.push(ev.data);
    socket.onclose = () => { closed = true; };
    raw.onmessage?.({ data: frame });
    return { socket, raw, sent, got, closed: () => closed };
  };
  // The current relay: it answers the plain ping itself, so the phone may beat.
  const modern = open(`{"relay":"open","liveness":true}`);
  assert.equal(modern.socket.liveness, true);
  assert.equal(modern.socket.readyState, 1, "handshake done");
  modern.socket.heartbeat();
  assert.equal(modern.closed(), false);
  assert.equal(modern.got.length, 0, "the plain ping is not a host frame");
  modern.raw.onmessage?.({ data: "pong" });
  assert.deepEqual(modern.got, ["pong"], "the relay's answer is delivered as traffic");
  // An older relay: it never said it answers the ping, and forwarding one would break the channel.
  const older = open(`{"relay":"open"}`);
  assert.equal(older.socket.liveness, false);
  older.socket.heartbeat();
  assert.equal(older.sent.filter((d) => d === "ping").length, 0);
});
