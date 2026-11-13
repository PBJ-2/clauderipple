// Where a background worker's "finished" chip lands, and how the chip-only rows are keyed.
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "../src/protocol.ts";
import { dropItems, reduce, timelineItems, type TimelineItem } from "../web/timeline.ts";

const launch: SessionEvent = { seq: 1, at: 1, kind: "assistant", msg: "launch", model: "m", text: "Started a worker.", tools: [{ id: "agent", name: "Agent", summary: "Review", input: JSON.stringify({ description: "Review", run_in_background: true }) }] };
const worker = (seq: number, status: "running" | "done"): SessionEvent => ({ seq, at: seq, kind: "subagent", toolUseId: "agent", sub: "sub", description: "Review", model: "w", status, steps: 0, background: true });
const photo = { type: "image" as const, blob: "a", mediaType: "image/png" };
const finishedIn = (items: TimelineItem[]) => items.flatMap(item => item.type === "toolGroup" && item.finished ? [{ key: item.key, ids: item.finished.map(f => f.id) }] : []);

test("dropping an item before an end keeps the chip where it was", () => {
  const events: SessionEvent[] = [
    launch, worker(2, "running"),
    { seq: 3, at: 3, kind: "user", clientMsgId: "echo", text: "", images: [photo] },
    { seq: 4, at: 4, kind: "assistant", msg: "wait", model: "m", text: "Waiting for the worker.", tools: [] },
    worker(5, "done"),
  ];
  const view = reduce(events);
  const echo = (item: { type: string }) => item.type === "user";
  const unfiltered = finishedIn(timelineItems({ state: "idle", items: view.items.filter(item => !echo(item)) }));
  assert.equal(unfiltered.length, 0, "a plain filter leaves the position one item too far: the chip vanishes");
  const items = timelineItems({ state: "idle", items: dropItems(view.items, echo) });
  const chips = finishedIn(items);
  assert.equal(chips.length, 1, "the chip is kept");
  assert.equal(items.at(-1)?.type, "toolGroup", "after the waiting message, as a row of its own");
  assert.deepEqual(chips[0]!.ids, ["agent"]);
});

test("dropping an item leaves the other items and their ends alone", () => {
  const view = reduce([launch, worker(2, "running"), worker(3, "done")]);
  assert.deepEqual(dropItems(view.items, () => false), view.items);
});

test("two chip-only rows of one worker have distinct keys, each leading to its own end", () => {
  const events: SessionEvent[] = [
    launch, worker(2, "running"),
    { seq: 3, at: 3, kind: "assistant", msg: "wait", model: "m", text: "Waiting.", tools: [] },
    worker(4, "done"),
    { seq: 5, at: 5, kind: "assistant", msg: "next", model: "m", text: "Anything else?", tools: [] },
    worker(6, "done"),
  ];
  const rows = timelineItems(reduce(events)).filter(item => item.type === "toolGroup" && item.rows.length === 0);
  assert.equal(rows.length, 2, "an end before and an end after the text");
  assert.equal(new Set(rows.map(row => row.key)).size, 2, "keys are distinct");
  // Re-reducing with more events later keeps the first row's key.
  const again = timelineItems(reduce([...events, { seq: 7, at: 7, kind: "state", state: "idle" }])).filter(item => item.type === "toolGroup" && item.rows.length === 0);
  assert.deepEqual(again.map(row => row.key), rows.map(row => row.key));
});
