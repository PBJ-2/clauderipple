// The host side of the dead-man switch: when work is active the host renews its room's watch, and
// after two idle minutes it takes it away; the recovery notice is sent once per outage, and the
// expired-login notice once per occurrence, both to every native/web subscriber.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopProblemAlert, RelayWatch } from "../src/watch.ts";
import type { WatchDeps } from "../src/watch.ts";
import { WATCH_RENEW_MS, WATCH_TOKENS_MAX, outageBody, recoveredBody } from "../src/protocol.ts";
import type { HostControlMsg } from "../src/protocol.ts";

const TOKENS = [
  { token: "ExpoPushToken[one]", lang: "ko" as const },
  { token: "ExpoPushToken[two]", lang: "en" as const },
];

function fakeWatch(overrides: Partial<WatchDeps> = {}) {
  let now = 5_000_000;
  let active = true;
  const sent: HostControlMsg[] = [];
  const recovered: number[] = [];
  const watch = new RelayWatch({
    active: () => active,
    targets: () => TOKENS,
    host: "host-key",
    send: (msg) => { sent.push(msg); return true; },
    recover: (minutes) => { recovered.push(minutes); },
    now: () => now,
    ...overrides,
  });
  return {
    watch, sent, recovered,
    setActive: (next: boolean) => { active = next; },
    advance: (ms: number) => { now += ms; },
    now: () => now,
    tick: () => watch.tick(),
  };
}

test("while work is active the watch is sent and renewed each minute; idle work takes it away at once", () => {
  const f = fakeWatch();
  f.tick();
  assert.deepEqual(f.sent, [{ t: "watch", tokens: TOKENS, host: "host-key" }]);
  f.advance(WATCH_RENEW_MS - 1_000);
  f.tick();
  assert.equal(f.sent.length, 1, "no renewal before the interval");
  f.advance(1_000);
  f.tick();
  assert.equal(f.sent.length, 2, "renewed at the interval");
  assert.deepEqual(f.sent[1], f.sent[0]);

  // `active` is Sessions.workActive, which itself stays true for two idle minutes after a run.
  f.setActive(false);
  f.tick();
  assert.deepEqual(f.sent.at(-1), { t: "unwatch" }, "idle work takes the watch away");
  f.advance(WATCH_RENEW_MS * 3);
  f.tick();
  assert.equal(f.sent.length, 3, "nothing more is sent until work starts again");

  f.setActive(true);
  f.tick();
  assert.deepEqual(f.sent.at(-1), f.sent[0], "work re-arms the watch immediately");
});

test("a host that starts idle clears a stale watch left by its previous process", () => {
  const f = fakeWatch();
  f.setActive(false);
  f.tick();
  assert.deepEqual(f.sent, [{ t: "unwatch" }], "the first control frame always clears the room");
  f.tick();
  assert.equal(f.sent.length, 1);
});

test("with no native device there is nothing to watch, so no watch is left behind", () => {
  const f = fakeWatch({ targets: () => [] });
  f.tick();
  assert.deepEqual(f.sent, [{ t: "unwatch" }]);
  f.advance(WATCH_RENEW_MS);
  f.tick();
  assert.equal(f.sent.length, 1);
});

test("at most WATCH_TOKENS_MAX devices travel in a watch", () => {
  const many = Array.from({ length: WATCH_TOKENS_MAX + 3 }, (_, i) => ({ token: `ExpoPushToken[d${i}]`, lang: "ko" as const }));
  const f = fakeWatch({ targets: () => many });
  f.tick();
  const first = f.sent[0];
  assert.equal(first?.t, "watch");
  assert.equal(first?.t === "watch" ? first.tokens.length : 0, WATCH_TOKENS_MAX);
});

test("the recovery notice is sent once per outage with whole minutes, and is cleared with the room", () => {
  const f = fakeWatch();
  f.setActive(false);
  const firedAt = f.now() - 5 * 60_000 - 20_000;
  f.watch.hello(firedAt);
  assert.deepEqual(f.recovered, [5], "rounded to whole minutes");
  assert.deepEqual(f.sent.filter((m) => m.t === "cleared"), [{ t: "cleared", firedAt }]);
  assert.deepEqual(f.sent.at(-1), { t: "unwatch" }, "the idle hello also states that nothing is watched");
  // The room repeats the fired moment until its clear is heard: no second notice, but the clear goes again.
  f.watch.hello(firedAt);
  assert.deepEqual(f.recovered, [5]);
  assert.equal(f.sent.filter((m) => m.t === "cleared").length, 2);
  // A different outage is a new notice; under a minute still says one.
  const recent = f.now() - 5_000;
  f.watch.hello(recent);
  assert.deepEqual(f.recovered, [5, 1]);
});

test("a reported outage survives a host restart, so the same notice is not sent twice", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-state-"));
  try {
    const stateFile = path.join(dir, "watch.json");
    const first = fakeWatch({ stateFile });
    first.setActive(false);
    first.watch.hello(1_000_000);
    assert.deepEqual(first.recovered, [67]);

    const second = fakeWatch({ stateFile });
    second.setActive(false);
    second.watch.hello(1_000_000);
    assert.deepEqual(second.recovered, [], "the new process remembers it already reported this outage");
    assert.ok(second.sent.some((m) => m.t === "cleared"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a fired frame is handled after the watch was taken away, so the recovery notice is not lost", () => {
  const f = fakeWatch();
  f.tick();
  f.setActive(false);
  f.tick();
  assert.deepEqual(f.sent.at(-1), { t: "unwatch" }, "the idle host dropped its watch on the same socket");
  // The room answers that unwatch with what it did while the computer slept. Nothing is being
  // watched now, but the notice still goes out — once — and the room is cleared.
  const firedAt = f.now() - 4 * 60_000;
  f.watch.hello(firedAt);
  assert.deepEqual(f.recovered, [4]);
  assert.ok(f.sent.some((m) => m.t === "cleared" && m.firedAt === firedAt), "the outage is acknowledged");
  assert.deepEqual(f.sent.at(-1), { t: "unwatch" }, "the idle hello states it again on the new socket");
  assert.equal(f.sent.filter((m) => m.t === "watch").length, 1, "an idle host does not re-arm");
  f.watch.hello(firedAt);
  assert.deepEqual(f.recovered, [4], "the same outage is not reported twice");
});

test("a hello while work is active renews the watch at once on the new socket", () => {
  const f = fakeWatch();
  f.tick();
  f.advance(WATCH_RENEW_MS / 2);
  f.watch.hello();
  assert.equal(f.sent.filter((m) => m.t === "watch").length, 2, "reconnected: renewed ahead of the interval");
});

test("a hello states the current state even when the host believes the room already heard it", () => {
  const f = fakeWatch();
  f.tick();
  assert.equal(f.sent.at(-1)?.t, "watch");
  f.setActive(false);
  f.tick();
  assert.deepEqual(f.sent.at(-1), { t: "unwatch" }, "the idle tick sent an unwatch on the old socket");
  // That send returned true, yet the socket died with the frame: the room still holds the watch.
  // The next control socket must be told outright, or an idle connected PC trips the alarm.
  f.watch.hello();
  assert.deepEqual(f.sent.at(-1), { t: "unwatch" }, "the new socket is told, not trusted");
  assert.equal(f.sent.filter((m) => m.t === "unwatch").length, 2);
  // And an active host re-sends its watch even though it believes its earlier one is still held.
  f.setActive(true);
  f.watch.hello();
  assert.deepEqual(f.sent.at(-1), f.sent[0], "the active hello renews the watch on the new socket");
});

test("the fixed Korean copy is the owner's, with whole minutes in the recovery line", () => {
  assert.equal(outageBody("disconnected", "ko"), "PC와의 연결이 끊어졌습니다. 진행 중이던 작업이 중단되었을 수 있으니 PC의 네트워크와 전원 상태를 확인해 주세요.");
  assert.equal(recoveredBody("ko", 1), "PC가 다시 연결되었습니다. 약 1분 동안 연결이 끊어져 있었습니다.");
  assert.equal(recoveredBody("ko", 12), "PC가 다시 연결되었습니다. 약 12분 동안 연결이 끊어져 있었습니다.");
  assert.equal(outageBody("loginExpired", "ko"), "PC의 Claude 로그인이 만료되어 작업을 계속 진행할 수 없습니다. PC에서 다시 로그인해 주세요.");
  assert.equal(recoveredBody("en", 1), "The PC is connected again. It was disconnected for about 1 minute.");
});

test("the expired-login notice goes out once each time the problem starts while work is active", () => {
  let active = true;
  let pushes = 0;
  const alert = new DesktopProblemAlert(() => active, () => { pushes++; });
  assert.equal(alert.update(null), false);
  assert.equal(alert.update("로그인이 만료되었습니다"), true);
  assert.equal(alert.update("로그인이 만료되었습니다"), false, "still the same occurrence");
  assert.equal(alert.update("another auth message"), false, "a changed message is the same occurrence");
  assert.equal(pushes, 1);
  alert.update(null);
  active = false;
  assert.equal(alert.update("로그인이 만료되었습니다"), false, "not while nothing is running");
  assert.equal(pushes, 1);
  active = true;
  alert.update(null);
  assert.equal(alert.update("로그인이 만료되었습니다"), true, "a new expiry after a clear is a new notice");
  assert.equal(pushes, 2);
});

test("a login problem first seen while idle notifies when work starts while it persists", () => {
  let active = false;
  let pushes = 0;
  const alert = new DesktopProblemAlert(() => active, () => { pushes++; });
  assert.equal(alert.update("로그인이 만료되었습니다"), false, "nothing is running: the notice waits");
  assert.equal(pushes, 0);
  // Work starts while the problem persists: the re-check on the session update notifies once.
  active = true;
  assert.equal(alert.update("로그인이 만료되었습니다"), true, "the first moment problem and work meet");
  assert.equal(alert.update("로그인이 만료되었습니다"), false, "later re-checks do not repeat it");
  assert.equal(alert.update("another auth message"), false, "a changed message is the same occurrence");
  assert.equal(pushes, 1);
  // A clear ends the occurrence, and the next problem is a new one.
  alert.update(null);
  assert.equal(alert.update("로그인이 만료되었습니다"), true);
  assert.equal(pushes, 2);
});
