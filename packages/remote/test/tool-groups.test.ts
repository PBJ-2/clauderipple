import test from "node:test";
import assert from "node:assert/strict";
import { timelineItems, reduce, type Item } from "../web/timeline.ts";
import { setLang, t } from "../web/i18n.ts";
import { item } from "../web/views.ts";
import type { UI } from "../web/views.ts";
import type { EventBody, SessionEvent } from "../src/protocol.ts";

const assistant = (key: string, text = "", names = ["Read"]): Item => ({ type: "assistant", key, ver: key, text, streaming: false, tools: names.map((name, i) => ({ id: `${key}-${i}`, name, summary: `${name} summary`, input: "input", result: { ok: true, text: "output" } })), model: "test", at: 1 });
const worker: Item = { type: "subagent", key: "worker", ver: "1", toolUseId: "agent-0", sub: "sub-agent", description: "Review files", model: null, status: "done", steps: 3 };

test("consecutive tools and workers collapse without counting Agent twice; text and permissions split runs", () => {
  const permission: Item = { type: "permission", key: "p", ver: "1", id: "p", tool: "Bash", title: "Approve", summary: "pwd", input: "pwd", canAlways: false, decision: null, at: 1 };
  const rows = timelineItems({ state: "idle", items: [assistant("a", "", ["Read", "Bash"]), worker, assistant("agent", "", ["Agent"]), assistant("b"), assistant("c", "Here is what I found"), permission, assistant("d")] });
  assert.deepEqual(rows.map(r => r.type), ["toolGroup", "assistant", "toolGroup", "permission", "toolGroup"]);
  const first = rows[0];
  assert.ok(first?.type === "toolGroup");
  assert.equal(first.tools, 3);
  assert.equal(first.workers, 1);
  assert.equal(first.rows.length, 4);
  assert.equal(first.running, false);
});

test("thinking, withheld or not, neither shows nor splits a run; only live thinking at the end shows", () => {
  const thinking = (key: string, text: string, streaming = false): Item => ({ type: "thinking", key, ver: key, text, streaming, msg: key, at: 1 });
  const rows = timelineItems({ state: "idle", items: [assistant("a"), thinking("h1", ""), assistant("b"), thinking("h2", "Checking the log"), assistant("c")] });
  assert.deepEqual(rows.map(r => r.type), ["toolGroup"]);
  assert.ok(rows[0]?.type === "toolGroup" && rows[0].tools === 3);
  const live = timelineItems({ state: "running", items: [assistant("a"), thinking("h1", "Checking", true), assistant("b"), thinking("h2", "", true)] });
  assert.deepEqual(live.map(r => r.type), ["toolGroup", "thinking"]);
  assert.equal(live[1]?.key, "h2");
});

test("a narration sentence splits tool runs; thinking still does not", () => {
  const event = (body: EventBody, seq: number): SessionEvent => ({ ...body, seq, at: seq });
  const rows = timelineItems(reduce([
    event({ kind: "thinking", msg: "m", block: 2, text: "Half a thought", delta: true }, 1),
    event({ kind: "assistant", msg: "m", model: "test", text: "", tools: [{ id: "t1", name: "Read", summary: "file.ts", input: "" }] }, 2),
    event({ kind: "narration", msg: "m", block: 2, text: "Now the tests" }, 3),
    event({ kind: "assistant", msg: "m2", model: "test", text: "", tools: [{ id: "t2", name: "Bash", summary: "npm test", input: "" }] }, 4),
  ]));
  assert.deepEqual(rows.map(r => r.type), ["toolGroup", "assistant", "toolGroup"]);
  assert.equal(rows[1]?.type === "assistant" && rows[1].text, "Now the tests");
  assert.equal(rows[1]?.type === "assistant" && rows[1].key, "nm:2");
});

test("worker event emitted before assistant text appears at its Agent call position", () => {
  const rows = timelineItems({ state: "idle", items: [worker, assistant("agent", "Delegating review", ["Agent"])] });
  assert.deepEqual(rows.map(r => r.type), ["assistant", "toolGroup"]);
  assert.ok(rows[1]?.type === "toolGroup");
  assert.equal(rows[1].workers, 1);
  assert.equal(rows[1].tools, 0);
  const desktop = timelineItems({ state: "idle", items: [assistant("desktop", "", ["Read", "Task"])] });
  assert.ok(desktop[0]?.type === "toolGroup");
  assert.equal(desktop[0].tools, 1);
  assert.equal(desktop[0].workers, 1);
});

test("active run shows latest summary and spinner, previous turns stay completed", () => {
  const result: Item = { type: "result", key: "r", ver: "1", ok: true, ms: 1, model: "test", effort: null };
  const rows = timelineItems({ state: "running", items: [assistant("a"), result, assistant("b", "", ["Read", "Bash"])] });
  assert.ok(rows[0]?.type === "toolGroup" && !rows[0].running);
  assert.ok(rows[2]?.type === "toolGroup" && rows[2].running);
  assert.equal(rows[2].latest, "Bash summary");
});

test("the Code tab's own tools: the closing box waits for the turn's end, chapters divide, the task list stays in the dock", () => {
  const call = (key: string, name: string, input: unknown, text = ""): Item => ({ type: "assistant", key, ver: key, text, streaming: false, tools: [{ id: `${key}-0`, name, summary: "", input: JSON.stringify(input) }], model: "test", at: 1 });
  const result: Item = { type: "result", key: "r", ver: "1", ok: true, ms: 1, model: "test", effort: null };
  const user: Item = { type: "user", key: "u", ver: "1", text: "Yes, fix it", at: 2 };
  const wrap = call("w", "mcp__ccd_turn__wrap_up", { recap: "Found the leak.", ask: "Fix it now?", blocked: true, actions: [{ action: "commit" }, { label: "Yes, fix it", message: "Fix the leak." }, { label: "Not now" }, { label: "Third" }] });
  const rows = timelineItems({ state: "idle", items: [
    call("p", "mcp__ccd_turn__update_plan", { items: [{ content: "Look", status: "in_progress" }], scope: "first_task" }),
    call("c", "mcp__ccd_session__mark_chapter", { title: "Fix the leak", summary: "From finding it to the fix" }),
    assistant("a"), wrap, assistant("closing", "Here is what I found", []), result,
  ] });
  assert.deepEqual(rows.map(r => r.type), ["chapter", "toolGroup", "assistant", "wrapUp", "result"]);
  const box = rows[3];
  assert.ok(box?.type === "wrapUp");
  assert.deepEqual([box.recap, box.ask, box.blocked, box.answered], ["Found the leak.", "Fix it now?", true, false]);
  assert.deepEqual(box.replies, [{ label: "Yes, fix it", message: "Fix the leak." }, { label: "Not now", message: "Not now" }], "app buttons stay on the Mac; at most two replies");
  const later = timelineItems({ state: "idle", items: [wrap, result, user] });
  assert.ok(later[0]?.type === "wrapUp" && later[0].answered);
  const recapOnly = timelineItems({ state: "idle", items: [call("x", "mcp__ccd_turn__wrap_up", { recap: "Done." }), assistant("y", "All set", [])] });
  assert.deepEqual(recapOnly.map(r => r.type), ["assistant"], "a box without a question is not drawn");
  const unreadable = timelineItems({ state: "idle", items: [{ ...call("z", "mcp__ccd_turn__wrap_up", {}), tools: [{ id: "z-0", name: "mcp__ccd_turn__wrap_up", summary: "", input: { preview: "{", blob: "b" } }] } as Item] });
  assert.deepEqual(unreadable.map(r => r.type), ["toolGroup"], "an input that cannot be read stays a tool row");
});

test("group keeps individual input/output and localizes counts", () => {
  const group = timelineItems({ state: "idle", items: [assistant("a", "", ["Read", "Bash"])] })[0]!;
  assert.ok(group.type === "toolGroup");
  assert.equal(group.rows.length, 2);
  assert.ok(group.rows[0]?.type === "tool");
  assert.equal(group.rows[0].tool.input, "input");
  assert.equal(group.rows[0].tool.result?.text, "output");
  setLang("en");
  assert.equal(t("tool.group", { n: group.tools }), "Used 2 tools");
  assert.equal(t("tool.group", { n: 1 }), "Used 1 tool");
  assert.equal(t("tasks.running", { n: 1 }), "1 task running");
  assert.equal(t("tool.groupWorkers", { n: 1, w: 2 }), "1 tool · 2 workers");
  setLang("ko");
  assert.equal(t("tool.group", { n: group.tools }), "도구 2개 사용");
});

test("a thinking block and a tool's own detail are drawn from the state kept beside the row, not from the element", () => {
  // The app records a <details> toggle in `ui.expanded`; drawing from there is what survives the row
  // being replaced while its text streams, or the conversation being opened again.
  const ui = (keys: string[]): UI => ({ expanded: new Map(keys.map(key => [key, null])) } as unknown as UI);
  const thinking: Item = { type: "thinking", key: "h1", ver: "1", text: "Checking the log", streaming: true, msg: "m", at: 1 };
  assert.ok(item(thinking, ui([])).startsWith('<details class="tool-details" data-k="t:h1">'), "a closed block says where its state is kept");
  assert.ok(item(thinking, ui(["t:h1"])).startsWith('<details class="tool-details" data-k="t:h1" open>'), "an open one is drawn open");

  // Activity lives in a group: the group has to be open for its tool's own detail to be drawn.
  const run = timelineItems({ state: "idle", items: [assistant("b", "Here it is", ["Read"])] }).find(row => row.type === "toolGroup")!;
  assert.ok(run.type === "toolGroup");
  assert.ok(!item(run, ui([run.key])).includes("d:b-0"), "a closed group draws no detail block");
  assert.ok(item(run, ui([run.key, "b-0"])).includes('<details class="tool-details" data-k="d:b-0">'), "a tool's detail block starts closed");
  assert.ok(item(run, ui([run.key, "b-0", "d:b-0"])).includes('<details class="tool-details" data-k="d:b-0" open>'), "and opens where the person left it");
});
