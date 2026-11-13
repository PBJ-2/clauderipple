import test from "node:test";
import assert from "node:assert/strict";
import { activitySummary, changeCount, diffLines, numberedRead, toolDiffs, toolInput, toolVerb, webLinks, type FinishedAgent, type SummaryRow } from "../src/tool-details.ts";
import { reduce, timelineItems } from "../web/timeline.ts";
import type { EventBody, SessionEvent, SessionFile } from "../src/protocol.ts";

let serial = 0;
// Every call has its own id, as in a transcript: the app counts calls by id (a file by its path).
const tool = (name: string, input: Record<string, unknown> = {}, ok: boolean | null = true): SummaryRow => ({ type: "tool", tool: { id: `${name}#${++serial}`, name, summary: name, input: JSON.stringify(input), ...(ok === null ? {} : { result: { ok } }) } });
const read = (path: string, ok: boolean | null = true) => tool("Read", { file_path: path }, ok);
/** An Agent call and the worker it started, as the phone's group rows hold them. */
const worker = (status: "running" | "done" | "failed" | "stopped", input: Record<string, unknown> = {}): SummaryRow => ({
  type: "subagent", status, description: "Review", call: { id: `Agent#${++serial}`, name: "Agent", summary: "Review", input: JSON.stringify(input) },
});
const summary = (rows: SummaryRow[], language: "ko" | "en", running = false) => activitySummary(rows, running, language).text;
const edit = (path: string, old_string: string, new_string: string): SummaryRow => ({ type: "tool", tool: { id: path, name: "Edit", summary: path, input: JSON.stringify({ file_path: path, old_string, new_string }), result: { ok: true } } });
const events = (...bodies: EventBody[]): SessionEvent[] => bodies.map((body, i) => ({ ...body, seq: i + 1, at: i }));

test("a group of two edits and two commands yields the official summary line and its +/− badge", () => {
  // Two distinct files edited (+7/−2 then +2/−1 → +9/−3) and two Bash calls.
  const rows = [edit("a.ts", "a\nb", "1\n2\n3\n4\n5\n6\n7"), edit("b.ts", "x", "y\nz"), tool("Bash"), tool("Bash")];
  assert.deepEqual(activitySummary(rows, false, "ko"), { text: "편집함 파일 2개, 실행됨 명령 2개", added: 9, removed: 3, failed: false });
  // No edits or line changes: the summary carries no badge (added = removed = 0).
  assert.deepEqual(activitySummary([tool("Bash"), tool("Read")], false, "ko"), { text: "실행됨 명령 1개, 읽음 파일 1개", added: 0, removed: 0, failed: false });
});

// The Claude app's Code tab, 2026-11-13: a group of two reads, one call of the "easel" server and a
// background agent that had finished was headed "읽음 파일 2개, easel 사용함, 완료함 백그라운드 에이전트 1개".
test("a folded group reads exactly as the Claude app's Code tab words it", () => {
  const rows = [read("a.ts"), read("b.ts"), tool("mcp__easel__draw_shapes")];
  const ended: FinishedAgent[] = [{ id: "a1", status: "done", description: "Review" }];
  assert.equal(activitySummary(rows, false, "ko", ended).text, "읽음 파일 2개, easel 사용함, 완료함 백그라운드 에이전트 1개");
  assert.equal(activitySummary(rows, false, "en", ended).text, "Read 2 files, used easel, finished a background agent");
});

test("kinds are worded and counted as the app does, in the order they first appear", () => {
  const rows = [tool("Bash"), tool("Read"), tool("Bash")];
  assert.equal(summary(rows, "ko"), "실행됨 명령 2개, 읽음 파일 1개");
  assert.equal(summary(rows, "en"), "Ran 2 commands, read a file");
  assert.equal(summary([tool("Bash")], "en"), "Ran a command");
  // A tool with its own wording in the app, and the words of the plain kinds, one by one.
  assert.equal(summary([tool("Grep"), tool("Grep")], "ko"), "검색함 코드");
  assert.equal(summary([tool("Grep")], "en"), "Searched code");
  assert.equal(summary([tool("Glob")], "ko"), "검색함 파일");
  assert.equal(summary([tool("Glob")], "en"), "Searched for files");
  assert.equal(summary([tool("WebSearch"), tool("WebSearch")], "ko"), "검색함 웹 2회");
  assert.equal(summary([tool("WebSearch"), tool("WebSearch")], "en"), "Searched the web 2 times");
  assert.equal(summary([tool("WebSearch")], "ko"), "검색함 웹 1회");
  assert.equal(summary([tool("WebSearch")], "en"), "Searched the web");
  assert.equal(summary([tool("TodoWrite")], "ko"), "업데이트됨 할 일");
  assert.equal(summary([tool("TodoWrite")], "en"), "Updated todos");
  assert.equal(summary([tool("ExitPlanMode")], "ko"), "제안함 계획");
  assert.equal(summary([tool("ExitPlanMode")], "en"), "Proposed a plan");
  assert.equal(summary([tool("Write", { file_path: "w" }), tool("NotebookEdit", { notebook_path: "n" }), tool("NotebookEdit", { notebook_path: "m" })], "ko"), "생성됨 파일 1개, 편집함 노트북 2개");
  assert.equal(summary([tool("Write", { file_path: "w" }), tool("NotebookEdit", { notebook_path: "n" }), tool("NotebookEdit", { notebook_path: "m" })], "en"), "Created a file, edited 2 notebooks");
  // Pages are counted by call, not by address.
  assert.equal(summary([tool("WebFetch", { url: "https://a" }), tool("WebFetch", { url: "https://a" })], "ko"), "가져옴 페이지 2개");
  assert.equal(summary([tool("WebFetch", { url: "https://a" })], "en"), "Fetched a page");
  assert.equal(summary([tool("Agent"), tool("Task")], "ko"), "실행됨 에이전트 2개");
  assert.equal(summary([tool("Agent")], "en"), "Ran an agent");
  assert.deepEqual(activitySummary([], false, "en"), { text: "", added: 0, removed: 0, failed: false });
});

test("files are counted by path; one file alone is named, and its verbs join", () => {
  assert.equal(summary([read("a.ts"), read("a.ts"), read("b.ts")], "ko"), "읽음 파일 2개");
  assert.equal(summary([read("/src/app/a.ts"), read("/src/app/a.ts")], "ko"), "읽음 a.ts");
  assert.equal(summary([read("/src/app/a.ts")], "en"), "Read a.ts");
  assert.equal(summary([read("/src/a.ts"), tool("Edit", { file_path: "/src/a.ts" })], "ko"), "읽음 및 편집함 a.ts");
  assert.equal(summary([read("/src/a.ts"), tool("Edit", { file_path: "/src/a.ts" }), tool("Write", { file_path: "/src/a.ts" })], "en"), "Read, edited, and created a.ts");
  assert.equal(summary([tool("Bash"), read("a.ts"), tool("Grep")], "ko"), "실행됨 명령 1개, 읽음 a.ts, 검색함 코드");
  // A call whose path is not known (a large input) falls back to counting what the row says it touched.
  assert.equal(summary([tool("Read"), read("a.ts")], "ko"), "읽음 파일 2개");
});

test("tools without a counted phrase are worded by name, after the kinds and before the unnamed ones", () => {
  assert.equal(summary([tool("mcp__easel__draw_shapes"), read("a.ts"), read("b.ts")], "ko"), "읽음 파일 2개, easel 사용함");
  // The app capitalises the first word of the line in Korean too, so a Latin name that opens it is capitalised.
  assert.equal(summary([tool("mcp__easel__draw"), tool("mcp__easel__erase")], "ko"), "Easel 사용함 2회");
  assert.equal(summary([tool("mcp__easel__draw"), tool("mcp__easel__erase")], "en"), "Used easel 2 times");
  assert.equal(summary([tool("mcp__plugin_easel_easel__draw")], "ko"), "Easel 사용함");
  assert.equal(summary([tool("mcp__github__create_issue"), tool("mcp__easel__draw")], "en"), "Used github, used easel");
  assert.equal(summary([tool("Skill"), read("a.ts"), read("b.ts")], "ko"), "읽음 파일 2개, Skill 실행됨");
  assert.equal(summary([tool("Skill")], "en"), "Ran skill");
  assert.equal(summary([tool("ToolSearch")], "ko"), "도구 로드됨");
  assert.equal(summary([tool("ToolSearch")], "en"), "Loaded tools");
  assert.equal(summary([tool("AskUserQuestion")], "ko"), "질문함");
  assert.equal(summary([tool("KillShell")], "en"), "Stopped task");
  assert.equal(summary([tool("CustomTool")], "ko"), "Custom tool 사용함");
  assert.equal(summary([tool("CustomTool")], "en"), "Used custom tool");
  // A call still open is not named yet: it counts with the unnamed tools.
  assert.equal(summary([tool("mcp__easel__draw", {}, null), tool("Skill", {}, null), read("a.ts"), read("b.ts")], "ko"), "읽음 파일 2개, 사용함 도구 2개");
  assert.equal(summary([tool("mcp__easel__draw", {}, null)], "en"), "Used a tool");
  const kinds = [tool("mcp__x__y"), read("a.ts"), tool("Bash"), tool("Grep"), tool("Bash")];
  assert.equal(summary(kinds, "en"), "Read a.ts, ran 2 commands, searched code, used x");
});

test("failed and stopped calls are told in brackets; calls that all failed use the unfinished wording", () => {
  assert.equal(summary([read("a.ts"), read("b.ts", false)], "ko"), "읽음 파일 2개 (1개 실패)");
  assert.equal(summary([read("a.ts"), read("b.ts", false)], "en"), "Read 2 files (1 failed)");
  assert.equal(summary([tool("Bash", {}, false), tool("Bash")], "ko"), "실행됨 명령 2개 (1개 실패)");
  assert.equal(summary([tool("mcp__easel__draw", {}, false)], "ko"), "Easel 사용 중 (1개 실패)");
  assert.equal(summary([tool("mcp__easel__draw", {}, false), tool("mcp__easel__draw")], "en"), "Used easel 2 times (1 failed)");
  assert.equal(summary([worker("stopped")], "ko"), "실행됨 에이전트 1개 (중지됨 1개)");
  assert.equal(summary([worker("stopped"), worker("failed"), worker("done")], "en"), "Ran 3 agents (1 failed, 1 stopped)");
  assert.equal(summary([worker("stopped"), worker("failed")], "ko"), "실행됨 에이전트 2개 (1개 실패, 1개 중지됨)");
  assert.equal(activitySummary([tool("Bash", {}, false)], false, "en").failed, true);
  assert.equal(activitySummary([worker("failed")], false, "ko").failed, true);
});

test("background agents: a started one is an agent run where it started; its end is counted where the notice arrived", () => {
  const background = { run_in_background: true };
  const end = (status: FinishedAgent["status"], id = "a1"): FinishedAgent => ({ id, status, description: "Review" });
  const finished = (rows: SummaryRow[], ends: FinishedAgent[], language: "ko" | "en") => activitySummary(rows, false, language, ends).text;
  // At its launch (asked for, or marked by the host) it is an agent run, whatever it goes on to do.
  assert.equal(summary([worker("running", background)], "ko"), "실행됨 에이전트 1개");
  assert.equal(summary([{ type: "subagent", status: "done", background: true, call: { id: "Agent#m", name: "Agent", summary: "Review", input: "{}" } }], "ko"), "실행됨 에이전트 1개");
  assert.equal(summary([worker("done", background), worker("done")], "ko"), "실행됨 에이전트 2개");
  assert.equal(finished([], [end("done"), end("done", "a2")], "en"), "Finished 2 background agents");
  assert.equal(finished([], [end("stopped")], "ko"), "완료함 백그라운드 에이전트 1개 (중지됨 1개)");
  // A failed one is told first, the rest close the line.
  assert.equal(finished([read("a.ts"), read("b.ts")], [end("failed")], "ko"), "완료함 백그라운드 에이전트 1개 (1개 실패), 읽음 파일 2개");
  assert.equal(finished([read("a.ts"), read("b.ts")], [end("failed")], "en"), "Finished a background agent (1 failed), read 2 files");
  assert.equal(finished([read("a.ts")], [end("done"), end("failed", "a2")], "ko"), "완료함 백그라운드 에이전트 2개 (1개 실패), 읽음 a.ts");
  // The failure shows on its own call when that call is in the group too: the notice then counts as a plain finish.
  assert.equal(finished([worker("failed", background)], [end("failed")], "ko"), "실행됨 에이전트 1개 (1개 실패), 완료함 백그라운드 에이전트 1개");
});

test("five or more parts are cut to three and the rest counted", () => {
  const four = [tool("Bash"), tool("Grep"), tool("Glob"), tool("WebSearch")];
  assert.equal(summary(four, "ko"), "실행됨 명령 1개, 검색함 코드, 검색함 파일, 검색함 웹 1회");
  const five = [...four, tool("TodoWrite")];
  assert.equal(summary(five, "ko"), "실행됨 명령 1개, 검색함 코드, 검색함 파일, 그 외 작업 2개");
  assert.equal(summary(five, "en"), "Ran a command, searched code, searched for files, and 2 more actions");
  assert.equal(summary([...five, tool("Read", { file_path: "a" }), tool("Read", { file_path: "b" })], "en"), "Ran a command, searched code, searched for files, and 4 more actions");
  assert.equal(summary([...four.slice(0, 3), tool("TodoWrite", {}, false), tool("Skill")], "ko"), "실행됨 명령 1개, 검색함 코드, 검색함 파일, 그 외 작업 2개 (1개 실패)");
});

test("while a call runs the group wears that call's own words", () => {
  assert.equal(summary([read("a.ts"), tool("Read", { file_path: "/src/b.ts" }, null)], "ko", true), "읽는 중 b.ts");
  assert.equal(summary([tool("Read", { file_path: "/src/b.ts" }, null)], "en", true), "Reading b.ts");
  assert.equal(summary([tool("Bash", { description: "tests" }, null)], "en", true), "Running tests");
  assert.equal(summary([tool("Grep", { pattern: "foo" }, null)], "ko", true), "검색 중 foo");
  assert.equal(summary([tool("Write", { file_path: "/x/c.ts" }, null)], "en", true), "Creating c.ts");
  assert.equal(summary([tool("mcp__easel__draw_shapes", {}, null)], "ko", true), "easel: draw shapes 사용 중");
  assert.equal(summary([tool("mcp__easel__draw_shapes", {}, null)], "en", true), "Using easel: draw shapes");
  assert.equal(summary([worker("running")], "ko", true), "에이전트 실행 중 Review");
  // A background agent still running (or whose launch has no result yet) is a call still running, as in the app.
  assert.equal(summary([read("a.ts"), worker("running", { run_in_background: true })], "ko", true), "에이전트 실행 중 Review");
  assert.equal(summary([{ type: "tool", tool: { id: "Agent#x", name: "Agent", summary: "Review", input: JSON.stringify({ run_in_background: true }) } }], "en", true), "Running agent Review");
  // The line stands once nothing runs, or when the group is not live.
  assert.equal(summary([read("a.ts")], "ko", true), "읽음 a.ts");
  assert.equal(summary([tool("Read", { file_path: "/src/b.ts" }, null)], "ko", false), "읽음 b.ts");
});

test("a call row opens with the app's verb for how it went", () => {
  assert.equal(toolVerb("Read", "done", "ko"), "읽음");
  assert.equal(toolVerb("Read", "running", "ko"), "읽는 중");
  assert.equal(toolVerb("Read", "failed", "ko"), "읽기 실패");
  assert.equal(toolVerb("Bash", "done", "ko"), "실행함");
  assert.equal(toolVerb("Bash", "done", "en"), "Ran");
  assert.equal(toolVerb("Edit", "done", "ko"), "편집됨");
  assert.equal(toolVerb("Write", "done", "en"), "Created");
  assert.equal(toolVerb("Glob", "done", "ko"), "파일 검색됨");
  assert.equal(toolVerb("Agent", "done", "ko"), "에이전트 실행함");
  assert.equal(toolVerb("Agent", "failed", "en"), "Failed to run agent");
  assert.equal(toolVerb("TodoWrite", "done", "ko"), "할 일 업데이트됨");
  assert.equal(toolVerb("TodoWrite", "failed", "en"), "Failed");
  assert.equal(toolVerb("mcp__easel__draw_shapes", "done", "ko"), "easel: draw shapes 사용함");
  assert.equal(toolVerb("mcp__easel__draw_shapes", "running", "en"), "Using easel: draw shapes");
  assert.equal(toolVerb("mcp__easel__draw_shapes", "failed", "ko"), "easel: draw shapes 사용 실패");
  assert.equal(toolVerb("CustomTool", "failed", "en"), "Failed to use custom tool");
});

test("edit summaries count unique files and all supplied edits, including blob metadata", () => {
  const rows = [tool("Edit", { file_path: "a", old_string: "old\n", new_string: "new\n" }), tool("MultiEdit", { file_path: "a", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }), tool("Write", { file_path: "b", content: "" })];
  assert.deepEqual(activitySummary(rows, false, "ko"), { text: "편집함 파일 1개, 생성됨 파일 1개", added: 3, removed: 3, failed: false });
  assert.deepEqual(changeCount("Read", {}), { added: 0, removed: 0 });
  assert.deepEqual(changeCount("Write", { content: "a\nb\n" }), { added: 2, removed: 0 });
  assert.deepEqual(changeCount("Edit", { old_string: "a\nb\nc", new_string: "a\nx\nc" }), { added: 1, removed: 1 });
  const blob: SummaryRow = { type: "tool", tool: { id: "large", name: "Edit", summary: "large.ts", input: { blob: "b", preview: "{", bytes: 9000 }, changes: { added: 12, removed: 8 }, result: { ok: true } } };
  assert.deepEqual(activitySummary([blob], false, "en"), { text: "Edited a file", added: 12, removed: 8, failed: false });
});

test("unified diff preserves context, insertion/deletion line numbers and final newline changes", () => {
  assert.deepEqual(diffLines("a\nb\nc\n", "a\nx\nc\n"), [
    { kind: "context", text: "a", old: 1, next: 1 },
    { kind: "remove", text: "b", old: 2, next: null },
    { kind: "add", text: "x", old: null, next: 2 },
    { kind: "context", text: "c", old: 3, next: 3 },
  ]);
  assert.deepEqual(diffLines("", ""), []);
  assert.deepEqual(diffLines("a", ""), [{ kind: "remove", text: "a", old: 1, next: null }]);
  assert.equal(diffLines("", "a")[0]?.next, 1);
  assert.deepEqual(changeCount("Edit", { old_string: "a", new_string: "a\n" }), { added: 1, removed: 1 });
  assert.deepEqual(diffLines("a\r\nb\r\n", "a\nb\n").map(l => l.kind), ["context", "context"]);
  assert.equal(toolDiffs("MultiEdit", { file_path: "f", edits: [{ old_string: "", new_string: "x" }] })[0]?.header, "@@ -0,0 +1,1 @@");
  const before = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 1000\n", "changed\nextra\n");
  const diff = diffLines(before, after);
  assert.equal(diff.filter(l => l.kind !== "add").map(l => l.text).join("\n"), before);
  assert.equal(diff.filter(l => l.kind !== "remove").map(l => l.text).join("\n"), after);
});

test("Read offsets, legacy inputs and web titles survive presentation parsing", () => {
  assert.deepEqual(numberedRead("hello\nworld\n", { offset: 42 }), [{ number: 42, text: "hello" }, { number: 43, text: "world" }]);
  assert.deepEqual(numberedRead("  12→hello\n13\tworld", null), [{ number: 12, text: "hello" }, { number: 13, text: "world" }]);
  assert.equal(toolInput("legacy prompt"), null);
  assert.equal(toolInput("[]"), null);
  assert.deepEqual(webLinks(JSON.stringify({ results: [{ title: "Docs", url: "https://example.com/docs" }] })), [{ title: "Docs", url: "https://example.com/docs" }]);
  assert.deepEqual(webLinks("[Docs](https://example.com/docs) https://example.com/docs javascript:bad"), [{ title: "Docs", url: "https://example.com/docs" }]);
});

test("thinking deltas merge per message and block; final snapshots replace, not append", () => {
  const view = reduce(events(
    { kind: "state", state: "running" },
    { kind: "thinking", msg: "m", block: 2, text: "one", delta: true },
    { kind: "thinking", msg: "m", block: 2, text: " two", delta: true },
    { kind: "thinking", msg: "m", block: 3, text: "separate", delta: true },
    { kind: "thinking", msg: "m", block: 2, text: "complete" },
    { kind: "assistant", msg: "m", model: "test", text: "answer", tools: [] },
  ));
  assert.deepEqual(view.items.map(i => i.type), ["thinking", "thinking", "assistant"]);
  assert.ok(view.items[0]?.type === "thinking");
  assert.equal(view.items[0].text, "complete");
  assert.equal(view.items[0].streaming, false);
  assert.equal(view.items[1]?.type === "thinking" && view.items[1].text, "separate");
  const queued = reduce(events(
    { kind: "thinking", msg: "old", block: 0, text: "partial", delta: true },
    { kind: "result", ok: true, ms: 1, turns: 1 },
    { kind: "state", state: "running" },
    { kind: "thinking", msg: "new", block: 0, text: "new", delta: true },
  ));
  assert.equal(queued.items[0]?.type === "thinking" && queued.items[0].streaming, false);
  assert.equal(queued.items[2]?.type === "thinking" && queued.items[2].streaming, true);
});

test("open tool data tracks results through later assistant snapshots and worker grouping", () => {
  const call = { id: "agent", name: "Agent", summary: "Review", input: JSON.stringify({ prompt: "Review files" }) };
  const view = reduce(events(
    { kind: "assistant", msg: "m", model: "test", text: "", tools: [call] },
    { kind: "tool_result", toolUseId: "agent", ok: true, text: "first output" },
    { kind: "assistant", msg: "m", model: "test", text: "", tools: [call] },
    { kind: "tool_result", toolUseId: "agent", ok: false, text: "updated output" },
    { kind: "subagent", toolUseId: "agent", sub: "sub-agent", description: "Review", model: "test", status: "failed", steps: 2 },
  ));
  const group = timelineItems(view)[0];
  assert.ok(group?.type === "toolGroup");
  assert.equal(group.rows.length, 1);
  const row = group.rows[0];
  assert.ok(row?.type === "subagent");
  assert.equal(row.call?.input, call.input);
  assert.deepEqual(row.call?.result, { ok: false, text: "updated output" });
  assert.equal(activitySummary(group.rows, group.running, "en").text, "Ran an agent (1 failed)");
});

test("a widget call stands on its own between folded activity instead of joining the group", () => {
  const read = { id: "r", name: "Read", summary: "a.ts" };
  const widget = { id: "w", name: "mcp__visualize__show_widget", summary: "", input: JSON.stringify({ widget_code: "<svg></svg>" }) };
  const bash = { id: "b", name: "Bash", summary: "ls" };
  const items = timelineItems(reduce(events({ kind: "assistant", msg: "m", model: "test", text: "", tools: [read, widget, bash] })));
  assert.deepEqual(items.map(i => i.type), ["toolGroup", "assistant", "toolGroup"]);
  const shown = items[1];
  assert.ok(shown?.type === "assistant");
  assert.deepEqual(shown.tools.map(t => t.id), ["w"]);
  assert.equal(shown.text, "");
});

test("500 turns retain stable timeline keys when older pages are prepended", () => {
  const all = events(...Array.from({ length: 500 }, (_, i): EventBody[] => [
    { kind: "user", clientMsgId: `u${i}`, text: `question ${i}` },
    { kind: "assistant", msg: `a${i}`, model: "test", text: `answer ${i}`, tools: [] },
  ]).flat());
  const tail = timelineItems(reduce(all.slice(800)));
  const full = timelineItems(reduce(all));
  assert.deepEqual(full.slice(-tail.length).map(i => i.key), tail.map(i => i.key));
  assert.equal(full.length, 1000);
});

const sendFile = (files: SessionFile[], caption: string) => ({ id: "send", name: "SendUserFile", files, summary: caption, input: JSON.stringify({ files: files.map(f => f.name), ...(caption ? { caption } : {}) }) });
const picture: SessionFile = { id: "p1", name: "a.png", mediaType: "image/png", bytes: 3, status: "ready", blob: "blob-a" };
const missing: SessionFile = { id: "p2", name: "gone.pdf", mediaType: "application/pdf", bytes: 0, status: "missing" };

test("a SendUserFile is words, not a tool row: its caption is text, its pictures and files stand under it, and it counts in no group", () => {
  const view = reduce(events(
    { kind: "assistant", msg: "m1", model: "t", text: "", tools: [{ id: "r", name: "Read", summary: "a.ts", input: JSON.stringify({ file_path: "a.ts" }) }, sendFile([picture, missing], "왼쪽이 원본입니다.")], images: [{ type: "image", mediaType: "image/png", blob: "blob-a" }], files: [missing] },
    { kind: "tool_result", toolUseId: "send", ok: true, text: "2 files delivered to user." },
  ));
  const items = timelineItems(view);
  assert.deepEqual(items.map(item => item.type), ["toolGroup", "assistant"]);
  const [group, said] = items;
  assert.equal(group?.type === "toolGroup" && group.rows.length, 1, "only the read is in the group");
  assert.equal(group?.type === "toolGroup" && activitySummary(group.rows, false, "ko").text, "읽음 a.ts");
  assert.ok(said?.type === "assistant");
  assert.equal(said.text, "왼쪽이 원본입니다.");
  assert.deepEqual(said.images?.map(image => image.blob), ["blob-a"]);
  assert.deepEqual(said.files?.map(file => file.id), ["p2"]);
  assert.deepEqual(said.tools, []);
});

test("a SendUserFile with no caption and no result, or one that failed, stays a row, and one that finished with files is words", () => {
  const call = (caption: string) => sendFile([picture], caption);
  const rowOnly = timelineItems(reduce(events({ kind: "assistant", msg: "m1", model: "t", text: "", tools: [call("")], images: [{ type: "image", mediaType: "image/png", blob: "blob-a" }] })));
  assert.deepEqual(rowOnly.map(item => item.type), ["assistant", "toolGroup"], "not yet words: the call is a row, its pictures stay with the message");
  const failed = timelineItems(reduce(events({ kind: "assistant", msg: "m1", model: "t", text: "", tools: [call("설명")] }, { kind: "tool_result", toolUseId: "send", ok: false, text: "no" })));
  assert.deepEqual(failed.map(item => item.type), ["toolGroup"]);
  const bare = timelineItems(reduce(events({ kind: "assistant", msg: "m1", model: "t", text: "", tools: [call("")], images: [{ type: "image", mediaType: "image/png", blob: "blob-a" }] }, { kind: "tool_result", toolUseId: "send", ok: true, text: "1 file delivered" })));
  assert.deepEqual(bare.map(item => item.type), ["assistant"]);
  assert.equal(bare[0]?.type === "assistant" && bare[0].images?.length, 1);
});

test("a background worker's end is counted by the group open when it arrives; a synchronous worker's end is not an arrival", () => {
  const launch = (id: string, input: object) => ({ kind: "assistant", msg: `m-${id}`, model: "t", text: "", tools: [{ id, name: "Agent", summary: "Review", input: JSON.stringify(input) }] }) as EventBody;
  const worker = (id: string, status: "running" | "done", extra: object = {}) => ({ kind: "subagent", toolUseId: id, sub: `sub-${id}`, description: "Review", model: null, status, steps: 0, ...extra }) as EventBody;
  const read = { kind: "assistant", msg: "m-read", model: "t", text: "", tools: [{ id: "r", name: "Read", summary: "a.ts", input: JSON.stringify({ file_path: "a.ts" }) }] } as EventBody;
  const lines = (view: ReturnType<typeof reduce>) => timelineItems(view).map(item => item.type === "toolGroup" ? activitySummary(item.rows, false, "ko", item.finished).text : item.type);
  // Started without being asked in the input: the host's mark is what says so.
  assert.deepEqual(lines(reduce(events(launch("a", {}), worker("a", "running"), read, worker("a", "done", { background: true })))), ["실행됨 에이전트 1개, 읽음 a.ts, 완료함 백그라운드 에이전트 1개"]);
  // Asked for in the input: no mark needed.
  assert.deepEqual(lines(reduce(events(launch("a", { run_in_background: true }), worker("a", "running"), worker("a", "done")))), ["실행됨 에이전트 1개, 완료함 백그라운드 에이전트 1개"]);
  // A worker that ran in the foreground ended at its call: nothing arrived.
  assert.deepEqual(lines(reduce(events(launch("a", {}), worker("a", "running"), worker("a", "done")))), ["실행됨 에이전트 1개"]);
  // The end is told again each time the worker stops: another finish, where that one arrived.
  assert.deepEqual(lines(reduce(events(launch("a", {}), worker("a", "running", { background: true }), worker("a", "done", { background: true }), worker("a", "done", { background: true })))), ["실행됨 에이전트 1개, 완료함 백그라운드 에이전트 2개"]);
});
