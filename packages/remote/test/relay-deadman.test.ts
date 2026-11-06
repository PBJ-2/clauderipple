// The relay room's dead-man switch: while a host renews `watch`, the room keeps a Durable Object
// alarm; when the renewals stop it sends Expo exactly one fixed-copy push per outage, and on the
// host's next hello — or on the first renewal of a control socket that survived the outage — it
// says when it fired so the host can send the recovery notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WATCH_ALARM_MS, WATCH_TTL_S, WATCH_TOKENS_MAX, WATCH_RENEW_MS, outageBody } from "../src/protocol.ts";
import { Room } from "../relay/room.ts";
import type { OutagePush, RoomCtx, Sock } from "../relay/room.ts";

const HOST_KEY = "host-key-0123456789";
const KO = "ExpoPushToken[korean_device]";
const EN = "ExponentPushToken[english_device]";

class FakeSock implements Sock {
  sent: (string | ArrayBuffer | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readonly name: string;
  constructor(name: string) { this.name = name; }
  send(data: string | ArrayBuffer | Uint8Array): void { if (this.closed) throw new Error("closed"); this.sent.push(data); }
  close(code?: number, reason?: string): void { if (!this.closed) this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }; }
  texts(): string[] { return this.sent.filter((d): d is string => typeof d === "string"); }
}

function fakeRoom(start = 1_000_000) {
  const tags = new Map<FakeSock, string[]>();
  const store = new Map<string, string>();
  const posts: OutagePush[][] = [];
  let alarmAt: number | null = null;
  let now = start;
  let n = 0;
  const ctx: RoomCtx<FakeSock> = {
    accept: (ws, t) => { tags.set(ws, t); },
    sockets: (tag) => [...tags].filter(([ws, t]) => !ws.closed && t.includes(tag)).map(([ws]) => ws),
    tags: (ws) => tags.get(ws) ?? [],
    lastPing: () => null,
    now: () => now,
    get: async (k) => store.get(k),
    put: async (k, v) => { store.set(k, v); },
    setAlarm: async (at) => { alarmAt = at; },
    deleteAlarm: async () => { alarmAt = null; },
    postExpo: async (messages) => { posts.push(messages); },
    newId: () => `conn-${String(++n).padStart(4, "0")}`,
    sha256: async (s) => `h(${s})`,
  };
  const room = new Room(ctx);
  return {
    room, store, posts,
    alarm: () => alarmAt,
    advance: (ms: number) => { now += ms; },
    watchOf: () => {
      const raw = store.get("watch");
      return raw === undefined ? null : JSON.parse(raw) as { tokens: { token: string; lang: string }[]; host: string; firedAt?: number };
    },
    newHost: () => {
      const ws = new FakeSock("host");
      return ws;
    },
  };
}

const watchMsg = (tokens: { token: string; lang: "ko" | "en" }[], host = HOST_KEY) =>
  JSON.stringify({ t: "watch", tokens, host });

test("watch arms the alarm WATCH_ALARM_MS ahead, and every renewal moves it", async () => {
  const f = fakeRoom();
  const host = f.newHost();
  f.room.hostControl(host);
  await f.room.message(host, watchMsg([{ token: KO, lang: "ko" }]));
  assert.equal(f.alarm(), 1_000_000 + WATCH_ALARM_MS);
  f.advance(WATCH_RENEW_MS);
  await f.room.message(host, watchMsg([{ token: KO, lang: "ko" }]));
  assert.equal(f.alarm(), 1_000_000 + WATCH_RENEW_MS + WATCH_ALARM_MS, "renewal pushed the alarm out");
  assert.deepEqual(f.watchOf()?.tokens, [{ token: KO, lang: "ko" }]);
  assert.equal(f.watchOf()?.host, HOST_KEY);
  assert.equal(f.posts.length, 0, "no alert while the host keeps renewing");
});

test("a missed renewal sends one Expo POST with fixed copy per device and no session", async () => {
  const f = fakeRoom();
  const host = f.newHost();
  f.room.hostControl(host);
  await f.room.message(host, watchMsg([{ token: KO, lang: "ko" }, { token: EN, lang: "en" }]));
  assert.equal(f.alarm(), 1_000_000 + WATCH_ALARM_MS);
  f.advance(WATCH_ALARM_MS);
  await f.room.alarm();
  assert.equal(f.posts.length, 1, "exactly one POST");
  assert.deepEqual(f.posts[0], [
    { to: KO, title: "Ripple Remote", body: "PC와의 연결이 끊어졌습니다. 진행 중이던 작업이 중단되었을 수 있으니 PC의 네트워크와 전원 상태를 확인해 주세요.", data: { session: "", host: HOST_KEY }, sound: "default", ttl: WATCH_TTL_S },
    { to: EN, title: "Ripple Remote", body: outageBody("disconnected", "en"), data: { session: "", host: HOST_KEY }, sound: "default", ttl: WATCH_TTL_S },
  ]);
  assert.ok(f.watchOf()?.firedAt, "the outage moment is recorded");
  await f.room.alarm();
  assert.equal(f.posts.length, 1, "a retried alarm never alerts twice");
});

test("unwatch takes the alarm away, so a later alarm sends nothing", async () => {
  const f = fakeRoom();
  const host = f.newHost();
  f.room.hostControl(host);
  await f.room.message(host, watchMsg([{ token: KO, lang: "ko" }]));
  assert.notEqual(f.alarm(), null);
  await f.room.message(host, JSON.stringify({ t: "unwatch" }));
  assert.equal(f.alarm(), null);
  assert.equal(f.watchOf()?.tokens.length, 0);
  f.advance(WATCH_ALARM_MS);
  await f.room.alarm();
  assert.equal(f.posts.length, 0);
});

test("a host that reconnects after a fire is told firedAt; cleared forgets it; a new watch fires again", async () => {
  const f = fakeRoom();
  const first = f.newHost();
  f.room.hostControl(first);
  await f.room.message(first, watchMsg([{ token: KO, lang: "ko" }]));
  f.advance(WATCH_ALARM_MS);
  await f.room.alarm();
  const firedAt = f.watchOf()!.firedAt!;
  first.close(1006);

  const second = f.newHost();
  const told = await f.room.alertedAt();
  assert.equal(told, firedAt);
  f.room.hostControl(second, told);
  assert.deepEqual(second.texts().map((t) => JSON.parse(t)), [
    { relay: "hello" },
    { relay: "fired", firedAt },
  ]);

  await f.room.message(second, JSON.stringify({ t: "cleared", firedAt }));
  assert.equal(await f.room.alertedAt(), undefined, "the room forgets the outage once the host says so");
  assert.notEqual(f.alarm(), null, "the cleared watch is armed again for the host that is back");

  await f.room.message(second, watchMsg([{ token: KO, lang: "ko" }]));
  assert.notEqual(f.alarm(), null, "a renewal after recovery arms the alarm again");
  f.advance(WATCH_ALARM_MS);
  await f.room.alarm();
  assert.equal(f.posts.length, 2, "a second outage is a second alert");
});

test("a renewal on the control socket that survived the outage re-announces the fire and re-arms", async () => {
  const f = fakeRoom();
  const host = f.newHost();
  f.room.hostControl(host);
  await f.room.message(host, watchMsg([{ token: KO, lang: "ko" }]));
  f.advance(WATCH_ALARM_MS);
  await f.room.alarm();
  const firedAt = f.watchOf()!.firedAt!;
  assert.equal(f.posts.length, 1);

  // The computer slept past the alarm and resumed on the same WebSocket: its renewal is the first
  // it hears of the outage, so the room says so on that socket and keeps an alarm.
  host.sent.length = 0;
  f.advance(WATCH_RENEW_MS);
  await f.room.message(host, watchMsg([{ token: KO, lang: "ko" }]));
  assert.deepEqual(host.texts().map((t) => JSON.parse(t)), [{ relay: "fired", firedAt }], "the surviving socket is told");
  assert.notEqual(f.alarm(), 1_000_000 + WATCH_ALARM_MS, "the alarm moved on with the renewal");
  assert.ok(f.alarm() !== null, "and stays armed for the next outage");
  assert.equal(f.watchOf()?.firedAt, firedAt, "still the same outage until the host clears it");
  assert.equal(f.posts.length, 1, "no second alert for one outage");

  // Renewing again is the same outage: said again (the host dedupes by firedAt), never re-pushed.
  host.sent.length = 0;
  await f.room.message(host, watchMsg([{ token: KO, lang: "ko" }]));
  assert.deepEqual(host.texts().map((t) => JSON.parse(t)), [{ relay: "fired", firedAt }]);
  assert.equal(f.posts.length, 1);

  // The host's clear ends it; ordinary renewals are silent again and still move the alarm.
  await f.room.message(host, JSON.stringify({ t: "cleared", firedAt }));
  assert.equal(f.watchOf()?.firedAt, undefined);
  host.sent.length = 0;
  await f.room.message(host, watchMsg([{ token: KO, lang: "ko" }]));
  assert.deepEqual(host.texts(), [], "no fired frame after the clear");
  assert.ok(f.alarm() !== null);
});

test("an idle host that slept through the alarm is told on unwatch, and its clear still ends it", async () => {
  const f = fakeRoom();
  const host = f.newHost();
  f.room.hostControl(host);
  await f.room.message(host, watchMsg([{ token: KO, lang: "ko" }]));
  f.advance(WATCH_ALARM_MS);
  await f.room.alarm();
  const firedAt = f.watchOf()!.firedAt!;
  assert.equal(f.posts.length, 1);

  // The computer slept past the alarm and woke idle: the watch goes away before any renewal, so
  // the unwatch is the only frame the room gets. It must still say what happened, on this socket,
  // or the recovery notice is never sent and the phone is left with only the disconnect push.
  host.sent.length = 0;
  await f.room.message(host, JSON.stringify({ t: "unwatch" }));
  assert.deepEqual(host.texts().map((t) => JSON.parse(t)), [{ relay: "fired", firedAt }], "the unwatching socket is told");
  assert.equal(f.watchOf()?.firedAt, firedAt, "kept until the host's clear, so a reconnect still hears it");
  assert.equal(f.watchOf()?.tokens.length, 0);
  assert.equal(f.alarm(), null, "unwatched: disarmed, so no new outage can be pushed");
  f.advance(WATCH_ALARM_MS);
  await f.room.alarm();
  assert.equal(f.posts.length, 1, "an unwatched room never pushes");

  // The host sent its recovery notice and clears the outage; with no watch, nothing is re-armed.
  await f.room.message(host, JSON.stringify({ t: "cleared", firedAt }));
  assert.equal(f.watchOf()?.firedAt, undefined);
  assert.equal(f.alarm(), null, "an unwatched clear does not arm again");
});

test("tokens are validated, capped, and an invalid-only watch leaves no alarm behind", async () => {
  const f = fakeRoom();
  const host = f.newHost();
  f.room.hostControl(host);
  const many = Array.from({ length: WATCH_TOKENS_MAX + 2 }, (_, i) => ({ token: `ExpoPushToken[device_${i}]`, lang: "ko" as const }));
  await f.room.message(host, watchMsg(many));
  assert.equal(f.watchOf()?.tokens.length, WATCH_TOKENS_MAX);
  await f.room.message(host, watchMsg([{ token: "not-a-token", lang: "ko" }, { token: "https://evil.example", lang: "en" }]));
  assert.deepEqual(f.watchOf()?.tokens, []);
  assert.equal(f.alarm(), null, "nothing valid to tell, so no alarm is kept");
  await f.room.message(host, watchMsg([{ token: KO, lang: "ko" }, { token: "nope", lang: "ko" }]));
  assert.deepEqual(f.watchOf()?.tokens, [{ token: KO, lang: "ko" }], "valid tokens beside bad ones are kept");
  assert.notEqual(f.alarm(), null);
});

test("a replaced host socket cannot keep a watch alive", async () => {
  const f = fakeRoom();
  const first = f.newHost();
  f.room.hostControl(first);
  await f.room.message(first, watchMsg([{ token: KO, lang: "ko" }]));
  const second = f.newHost();
  f.room.hostControl(second); // replaces the first
  first.closed = null; // its close never completed, so the runtime still lists it
  await f.room.message(second, JSON.stringify({ t: "unwatch" }));
  assert.equal(f.alarm(), null);
  await f.room.message(first, watchMsg([{ token: KO, lang: "ko" }]));
  assert.deepEqual(f.watchOf()?.tokens, [], "only the newest host may arm the switch");
  assert.equal(f.alarm(), null);
});

test("an unauthenticated phone socket cannot arm or clear a watch", async () => {
  const f = fakeRoom();
  const host = f.newHost();
  f.room.hostControl(host);
  const phone = new FakeSock("phone");
  f.room.client(phone); // let through: the host is live
  await f.room.message(phone, watchMsg([{ token: KO, lang: "ko" }]));
  assert.equal(f.watchOf(), null, "the phone's frame never reaches control handling");
  assert.equal(f.alarm(), null);
  await f.room.message(phone, JSON.stringify({ t: "cleared", firedAt: 1 }));
  assert.equal(f.watchOf(), null);
});
