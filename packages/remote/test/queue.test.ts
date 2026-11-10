import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AWAIT_GIVE_UP_MS, QUEUE_CAP, SendQueue } from "../src/queue.ts";
import type { SessionEvent } from "../src/protocol.ts";

function dir(t: test.TestContext): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-queue-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const event = (seq: number, body: Record<string, unknown>): SessionEvent => ({ seq, at: seq, ...body }) as SessionEvent;

test("items, attachment bytes and the held flag survive a reopen; removing drops the files", t => {
  const d = dir(t);
  const q = SendQueue.open(d);
  assert.equal(q.add("s1", { id: "a", text: "one", attachments: [{ name: "p.png", mediaType: "image/png", data: "aGVsbG8=" }] }, 1, "desktop-1"), true);
  assert.equal(q.add("s1", { id: "a", text: "one", attachments: [] }, 2), false, "a resent id is not queued twice");
  q.add("s1", { id: "b", text: "two", attachments: [] }, 3);
  q.hold("s1");
  const again = SendQueue.open(d);
  assert.deepEqual(again.summary("s1"), { queue: [{ id: "a", text: "one", attachments: 1, at: 1 }, { id: "b", text: "two", attachments: 0, at: 3 }], queueHeld: true });
  const [first] = again.items("s1");
  assert.equal(again.data(first!.attachments[0]!), "aGVsbG8=");
  // The Claude app's band finds the count by the app's own session id.
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "queue.json"), "utf8")).s1.desktopId, "desktop-1");
  again.remove("s1", "a");
  assert.equal(fs.readdirSync(path.join(d, "queue")).length, 0);
  again.remove("s1", "b");
  assert.deepEqual(again.summary("s1"), {});
  assert.equal(again.held("s1"), false, "an emptied queue is no longer held");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, "queue.json"), "utf8")), {});
});

test("the queue holds twenty; a failure records why and holds; resume clears both", t => {
  const q = SendQueue.open(dir(t));
  for (let n = 0; n < QUEUE_CAP; n++) q.add("s", { id: `m${n}`, text: String(n), attachments: [] }, n);
  assert.throws(() => q.add("s", { id: "over", text: "x", attachments: [] }, 99), /at most 20/);
  q.fail("s", "m0", "Claude app is not open.");
  assert.equal(q.summary("s").queue![0]!.error, "Claude app is not open.");
  assert.equal(q.held("s"), true);
  assert.equal(q.resume("s"), true);
  assert.equal(q.summary("s").queue![0]!.error, undefined);
  assert.equal(q.held("s"), false);
});

test("a temporary obstacle is a wait code, not an error, survives reopen without holding, and Stop still wins", t => {
  const d = dir(t);
  const q = SendQueue.open(d);
  q.add("s", { id: "a", text: "original", attachments: [] }, 1);
  assert.equal(q.wait("s", "a", "desktop_busy"), true);
  assert.equal(q.wait("s", "a", "desktop_busy"), false);
  const again = SendQueue.open(d);
  assert.equal(again.held("s"), false);
  assert.deepEqual(again.summary("s").queue![0], { id: "a", text: "original", attachments: 0, at: 1, wait: "desktop_busy" }, "the wait is a code, never the error");
  again.hold("s");
  const stopped = SendQueue.open(d);
  stopped.retryFailures("desktop_busy", "desktop_waiting");
  assert.equal(stopped.held("s"), true, "a retry only releases a failure held by the host, not an explicit Stop");
});

test("a real failure replaces a wait, and a resume keeps a wait", t => {
  const q = SendQueue.open(dir(t));
  q.add("s", { id: "a", text: "x", attachments: [] }, 1);
  q.wait("s", "a", "desktop_waiting");
  q.fail("s", "a", "write outcome unknown");
  assert.deepEqual(q.summary("s").queue![0], { id: "a", text: "x", attachments: 0, at: 1, error: "write outcome unknown" });
  assert.equal(q.wait("s", "a", "desktop_busy"), true);
  assert.equal(q.summary("s").queue![0]!.error, undefined, "a wait clears the failure text it replaces");
});

test("legacy waits kept in error move to the wait code, and legacy automatic refusals recover without releasing an explicit Stop or other failures", t => {
  const d = dir(t);
  const q = SendQueue.open(d);
  for (const id of ["legacy", "stopped", "other", "busy"]) q.add(id, { id: "a", text: id, attachments: [] }, 1);
  q.fail("legacy", "a", "old desktop refusal");
  q.fail("stopped", "a", "old desktop refusal");
  q.hold("stopped");
  q.fail("other", "a", "write outcome unknown");
  q.fail("busy", "a", "Claude app busy sentence");
  const file = path.join(d, "queue.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  delete saved.legacy.heldBy; // Actual old format had no reason for its hold.
  fs.writeFileSync(file, JSON.stringify(saved));
  const again = SendQueue.open(d);
  again.retryFailures("old desktop refusal", "desktop_waiting");
  assert.equal(again.held("legacy"), false);
  assert.deepEqual(again.summary("legacy").queue![0], { id: "a", text: "legacy", attachments: 0, at: 1, wait: "desktop_waiting" });
  assert.equal(again.held("stopped"), true);
  assert.equal(again.held("other"), true);
  again.moveWaits("Claude app busy sentence", "desktop_busy");
  assert.deepEqual(again.summary("busy").queue![0], { id: "a", text: "busy", attachments: 0, at: 1, wait: "desktop_busy" });
  assert.equal(SendQueue.open(d).held("legacy"), false);
});

// A Claude app session reports no result, and its Remote Control state can still read idle for a
// few seconds after a message is sent: idle counts only after an answer.
test("a sent message's turn ends on a result, or on idle after an answer, or after long silence", t => {
  const q = SendQueue.open(dir(t));
  q.add("s", { id: "next", text: "next", attachments: [] }, 0);
  q.sent("s", 10, 1000);
  const user = event(11, { kind: "user", text: "x", clientMsgId: "c" });
  const running = event(12, { kind: "state", state: "running" });
  const staleIdle = event(13, { kind: "state", state: "idle" });
  const answer = event(14, { kind: "assistant", msg: "m", model: "x", text: "done", tools: [] });
  const idle = event(15, { kind: "state", state: "idle" });
  assert.equal(q.settle("s", [user, running, staleIdle], 2000), false, "idle before any answer is the stale read");
  assert.equal(q.settle("s", [user, running, staleIdle, answer], 2000), false, "answered, but still running");
  assert.equal(q.settle("s", [user, running, staleIdle, answer, idle], 2000), true);
  assert.equal(q.awaiting("s"), undefined);
  q.sent("s", 20, 1000);
  assert.equal(q.settle("s", [event(21, { kind: "result", ok: true, ms: 1, turns: 1 })], 2000), true, "a host session's result ends it");
  q.sent("s", 30, 1000);
  assert.equal(q.settle("s", [event(31, { kind: "state", state: "idle" })], 1000 + AWAIT_GIVE_UP_MS - 1), false);
  assert.equal(q.settle("s", [event(31, { kind: "state", state: "idle" })], 1000 + AWAIT_GIVE_UP_MS + 1), true, "a turn that never started does not hold the queue for good");
});
