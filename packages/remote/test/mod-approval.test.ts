import test from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_FRESH_MS, APPROVAL_IDLE_MS, APPROVAL_STALE_MS, APPROVAL_WAIT_MS, Approvals } from "../src/mod-approval.ts";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test("an ask opens once, pending, and only the first settlement wins", () => {
  const c = clock();
  const a = new Approvals(c.now);
  assert.ok(a.open({ askId: "one", phoneId: "p", desktopId: "d", tool: "Bash" }));
  assert.equal(a.open({ askId: "one", phoneId: "p", desktopId: "d", tool: "Bash" }), null, "a repeated start is not a second ask");
  assert.equal(a.get("one")?.state, "pending");
  assert.equal(a.settle("one", "answered", { answer: { behavior: "allow" } }), true);
  assert.equal(a.settle("one", "local", { reason: "local" }), false, "the Mac cannot take an answered ask");
  assert.equal(a.settle("one", "expired", { reason: "stale" }), false);
  assert.deepEqual(a.get("one")?.answer, { behavior: "allow" });
  assert.equal(a.get("one")?.reason, undefined);
});

test("a wait resolves when the ask settles and on its own timeout", async () => {
  const a = new Approvals();
  a.open({ askId: "w", phoneId: "p", desktopId: "d", tool: "Bash" });
  const timed = await a.wait("w", 10);
  assert.equal(timed, undefined);
  const woken = a.wait("w", 5_000);
  a.settle("w", "expired", { reason: "x" });
  const started = Date.now();
  await woken;
  assert.ok(Date.now() - started < 1_000, "settling wakes the waiter at once");
  await a.wait("unknown", 1);
});

test("active lists what a session still owes an answer to: pending holds and local asks, never settled ones", () => {
  const a = new Approvals(clock().now);
  a.open({ askId: "held", phoneId: "p", desktopId: "d", tool: "Bash" });
  a.open({ askId: "mac", phoneId: "p", desktopId: "d", tool: "Edit" });
  a.open({ askId: "other", phoneId: "q", desktopId: "e", tool: "Bash" });
  a.settle("mac", "local", { reason: "local" });
  a.settle("other", "answered", { answer: { behavior: "deny", message: "no" } });
  assert.deepEqual(a.active("p").map(ask => ask.askId).sort(), ["held", "mac"]);
  assert.deepEqual(a.active("q"), []);
});

test("a hook that stops polling is stale; one that keeps polling is not", () => {
  const c = clock();
  const a = new Approvals(c.now);
  a.open({ askId: "polled", phoneId: "p", desktopId: "d", tool: "Bash" });
  a.open({ askId: "silent", phoneId: "p", desktopId: "d", tool: "Bash" });
  // A hook polls about once a second: each poll lands inside the window of the one before, so the hold is never fenced.
  for (let step = 0; step < APPROVAL_STALE_MS / 1_000 - 1; step++) { c.advance(1_000); a.touch("polled"); }
  c.advance(2_000);
  const stale = a.sweep(() => true);
  assert.deepEqual(stale.map(ask => ask.askId), ["silent"]);
  assert.equal(a.get("silent")?.state, "expired");
  assert.equal(a.get("silent")?.reason, "stale");
  assert.equal(a.get("polled")?.state, "pending");
});

test("a pending ask is fenced one freshness window after its last poll; each poll opens the window again", () => {
  const c = clock();
  const a = new Approvals(c.now);
  a.open({ askId: "fresh", phoneId: "p", desktopId: "d", tool: "Bash" });
  c.advance(APPROVAL_FRESH_MS - 1);
  assert.equal(a.fenced("fresh"), false, "inside the window the phone may still answer");
  c.advance(1);
  assert.equal(a.fenced("fresh"), true, "one window after the last poll the phone may not");
  a.open({ askId: "polled", phoneId: "p", desktopId: "d", tool: "Bash" });
  c.advance(APPROVAL_FRESH_MS - 1);
  a.touch("polled");
  c.advance(APPROVAL_FRESH_MS - 1);
  assert.equal(a.fenced("polled"), false, "a poll starts the window again");
  a.settle("polled", "answered", { answer: { behavior: "allow" } });
  c.advance(APPROVAL_FRESH_MS * 2);
  assert.equal(a.fenced("polled"), false, "a settled ask has nothing left to fence");
  assert.equal(a.fenced("unknown"), false);
});

test("a held ask whose session stays idle loses its turn after the idle grace; a busy turn keeps it", () => {
  const c = clock();
  const a = new Approvals(c.now);
  a.open({ askId: "turn", phoneId: "p", desktopId: "d", tool: "Bash" });
  assert.deepEqual(a.sweep(() => false), [], "the first idle reading only starts the clock");
  c.advance(APPROVAL_IDLE_MS - 1_000);
  assert.deepEqual(a.sweep(() => true), [], "busy again: the clock stops");
  c.advance(APPROVAL_IDLE_MS);
  assert.deepEqual(a.sweep(() => false), [], "a new idle reading starts it again");
  c.advance(APPROVAL_IDLE_MS + 1);
  assert.deepEqual(a.sweep(() => false).map(ask => ask.askId), ["turn"]);
  assert.equal(a.get("turn")?.state, "expired");
});

test("a local ask is forgotten once its turn is no longer busy, after a short grace; answered asks age out", () => {
  const c = clock();
  const a = new Approvals(c.now);
  a.open({ askId: "dialog", phoneId: "p", desktopId: "d", tool: "Bash" });
  a.settle("dialog", "local", { reason: "local" });
  a.sweep(() => false);
  assert.ok(a.get("dialog"), "inside the grace the Mac's registry may still lag");
  c.advance(APPROVAL_WAIT_MS + 1);
  a.sweep(() => true);
  assert.ok(a.get("dialog"), "while the turn runs, the dialog stays");
  a.sweep(() => false);
  assert.equal(a.get("dialog"), undefined, "the turn ended: forgotten");
  a.open({ askId: "answered", phoneId: "p", desktopId: "d", tool: "Bash" });
  a.settle("answered", "answered", { answer: { behavior: "allow" } });
  c.advance(2 * 60_000 + 1);
  a.sweep(() => true);
  assert.equal(a.get("answered"), undefined);
});

test("a poll is dated by when the hook sent it: a late arrival does not extend the window, and a future send time counts as the arrival", () => {
  const c = clock();
  const a = new Approvals(c.now);
  const start = c.now();
  a.open({ askId: "late", phoneId: "p", desktopId: "d", tool: "Bash" });
  c.advance(6_000);
  assert.equal(a.touch("late", start), true, "sent at the start, delivered 6 s later: still held");
  c.advance(APPROVAL_FRESH_MS - 6_000 - 1);
  assert.equal(a.fenced("late"), false, "the window runs from the send, not from the arrival");
  c.advance(1);
  assert.equal(a.fenced("late"), true, "one window after the send the phone may not answer");
  assert.equal(a.touch("late", start), false, "a poll sent at the start but delivered after its window revives nothing");
  assert.equal(a.get("late")?.state, "pending", "the caller closes the hold; touch itself settles nothing");

  a.open({ askId: "future", phoneId: "p", desktopId: "d", tool: "Bash" });
  assert.equal(a.touch("future", c.now() + 60_000), true);
  c.advance(APPROVAL_FRESH_MS - 1);
  assert.equal(a.fenced("future"), false, "a send time in the future is clamped to the arrival");
  c.advance(1);
  assert.equal(a.fenced("future"), true);
});

test("a poll never moves the heartbeat back, and a poll without a send time is dated by its arrival", () => {
  const c = clock();
  const a = new Approvals(c.now);
  const start = c.now();
  a.open({ askId: "beat", phoneId: "p", desktopId: "d", tool: "Bash" });
  c.advance(7_000);
  assert.equal(a.touch("beat", start + 7_000), true);
  c.advance(2_000);
  assert.equal(a.touch("beat", start + 3_000), true, "an older poll arriving late is still a hold this side of its window");
  c.advance(APPROVAL_FRESH_MS - 2_000 - 1);
  assert.equal(a.fenced("beat"), false, "the heartbeat stays at the newest send time, 7 s");
  c.advance(1);
  assert.equal(a.fenced("beat"), true);

  a.open({ askId: "older", phoneId: "p", desktopId: "d", tool: "Bash" });
  c.advance(5_000);
  assert.equal(a.touch("older"), true, "no send time: the arrival dates it, as before");
  assert.equal(a.touch("older", Number.NaN), true);
  assert.equal(a.touch("older", -1), true, "a send time that is not a time is ignored");
  c.advance(APPROVAL_FRESH_MS - 1);
  assert.equal(a.fenced("older"), false);
  assert.equal(a.touch("older"), true, "an arriving poll inside the window holds it");
  c.advance(APPROVAL_FRESH_MS);
  assert.equal(a.touch("older"), false, "a poll after a full window is fenced");
  assert.equal(a.touch("settled-or-unknown"), true, "nothing to fence");
});

test("forget ends a wait early and removes the ask", async () => {
  const a = new Approvals();
  a.open({ askId: "gone", phoneId: "p", desktopId: "d", tool: "Bash" });
  const waiting = a.wait("gone", 5_000);
  a.forget("gone");
  await waiting;
  assert.equal(a.get("gone"), undefined);
});
