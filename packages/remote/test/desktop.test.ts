import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentEnded, BackgroundTasks, DesktopSessions, processHasSession, transcriptEvents } from "../src/desktop.ts";
import { summarize, Sessions } from "../src/sessions.ts";
import { PermissionQueue } from "../src/permissions.ts";
import { FRAME_CAP } from "../src/protocol.ts";
import { BackgroundActivity } from "../src/background-activity.ts";
import { reduce } from "../web/timeline.ts";
import { BridgeClient, DESKTOP_BUSY } from "../src/bridge-client.ts";
import { fileSymlinks } from "../../../test/capabilities.ts";
import { signatureOf } from "./narration-signature.ts";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const linked = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const line = (value: unknown): string => JSON.stringify(value) + "\n";
const user = { type: "user", uuid: "u1", cwd: "/synthetic/project", timestamp: "2026-10-12T01:00:00Z", message: { content: "First prompt" } };
const assistant = { type: "assistant", uuid: "a1", message: { id: "m1", model: "test-model", content: [{ type: "text", text: "Answer" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/synthetic/project/file.ts" } }] } };

function fixture(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-test-"));
  const projects = path.join(root, "projects");
  const project = path.join(projects, "project");
  fs.mkdirSync(project, { recursive: true });
  const excluded = new Set<string>();
  let now = Date.now();
  const desktop = new DesktopSessions({ projects, summarize, excluded: () => excluded, now: () => now, processes: () => "" });
  t.after(() => { desktop.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, projects, project, desktop, excluded, advance: () => { now += 6000; } };
}

test("background task list carries the launch description, command fallback and start time", () => {
  const tasks = new BackgroundTasks();
  tasks.accept(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", id: "a", input: { description: "Review diff", run_in_background: true } }] } }));
  tasks.accept(line({ type: "user", timestamp: "2026-10-13T01:00:00.000Z", toolUseResult: { isAsync: true, agentId: "w1" }, message: { content: [{ type: "tool_result", tool_use_id: "a", content: "launch" }] } }));
  tasks.accept(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "b", input: { command: "npm test", run_in_background: true } }] } }));
  tasks.accept(line({ type: "user", toolUseResult: { backgroundTaskId: "s1" }, message: { content: [{ type: "tool_result", tool_use_id: "b", content: "started" }] } }));
  assert.deepEqual(tasks.list, [
    { id: "w1", kind: "agent", label: "Review diff", startedAt: Date.parse("2026-10-13T01:00:00.000Z"), state: "running", sub: "sub-a" },
    { id: "s1", kind: "shell", label: "npm test", command: "npm test", startedAt: null, state: "running" },
  ]);
});

test("the turn's task list follows update_plan as the app applies it, and the next message clears it", () => {
  const tasks = new BackgroundTasks();
  let n = 0;
  const plan = (input: Record<string, unknown>, error = false) => {
    const id = `p${++n}`;
    tasks.accept(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__ccd_turn__update_plan", id, input }] } }));
    tasks.accept(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, ...(error ? { is_error: true } : {}), content: "Plan shown" }] } }));
  };
  const statuses = () => tasks.plan.map(step => step.status[0]).join("");
  assert.deepEqual(tasks.plan, []);
  plan({ advance: true });
  assert.deepEqual(tasks.plan, [], "an advance with no list changes nothing");
  plan({ scope: "first_task", items: [{ content: " Read the code ", status: "in_progress" }, { content: "", status: "pending" }, { content: "Fix it", status: "bogus" }, { content: "Test it", status: "pending" }] });
  assert.deepEqual(tasks.plan, [{ text: " Read the code ", status: "in_progress" }, { text: "Fix it", status: "pending" }, { text: "Test it", status: "pending" }]);
  plan({ advance: true });
  assert.equal(statuses(), "cip");
  plan({ done: [2, 9], start: 3 }, true);
  assert.equal(statuses(), "cip", "a refused call changes nothing");
  plan({ done: [2], start: 3 });
  assert.equal(statuses(), "cci");
  plan({ advance: "true" });
  assert.equal(statuses(), "ccc");
  plan({ items: Array.from({ length: 15 }, (_, i) => ({ content: `step ${i}`, status: "pending" })), scope: "continuation" });
  assert.equal(tasks.plan.length, 15);
  tasks.accept(line({ type: "user", timestamp: "2026-10-23T01:00:00.000Z", origin: { kind: "human" }, message: { content: "next" } }));
  assert.deepEqual(tasks.plan, []);
});

test("the main turn starts at the person's message, not a compaction summary or task notification", () => {
  const tasks = new BackgroundTasks();
  const user = (at: string, content: unknown, origin?: unknown) => tasks.accept(line({ type: "user", timestamp: at, ...(origin ? { origin } : {}), message: { content } }));
  user("2026-10-12T14:31:01.617Z", "Continuation record from the previous conversation");
  assert.equal(tasks.turnStartedAt, null);
  user("2026-10-12T14:31:39.041Z", "진짜 너무 촌스럽다", { kind: "human" });
  tasks.accept(line({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Read", id: "r", input: {} }] } }));
  user("2026-10-12T15:00:00.000Z", "<task-notification></task-notification>", { kind: "task-notification" });
  assert.equal(tasks.turnStartedAt, Date.parse("2026-10-12T14:31:39.041Z"));
  tasks.accept(line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }));
  assert.equal(tasks.turnStartedAt, null);
  user("2026-10-12T16:00:00.000Z", "again", { kind: "human" });
  user("2026-10-12T16:00:05.000Z", "[Request interrupted by user]");
  assert.equal(tasks.turnStartedAt, null);
});

test("background task lifecycle counts async Agent/Task and Bash, not synchronous or sidechain work", () => {
  const tasks = new BackgroundTasks();
  const launch = (name: string, id: string, result: Record<string, unknown>, background = false) => {
    tasks.accept(line({ type: "assistant", message: { content: [{ type: "tool_use", name, id, input: { run_in_background: background } }] } }));
    tasks.accept(line({ type: "user", toolUseResult: result, message: { content: [{ type: "tool_result", tool_use_id: id, content: "launch" }] } }));
  };
  assert.equal(tasks.count, 0);
  launch("Agent", "sync", { agentId: "sync" });
  assert.equal(tasks.count, 0);
  launch("Agent", "a", { isAsync: true, agentId: "agent" });
  launch("Task", "b", { isAsync: true, agentId: "agent" });
  launch("Bash", "c", { backgroundTaskId: "shell" }, true);
  assert.equal(tasks.count, 2);
  assert.deepEqual(tasks.list.map(task => [task.id, task.kind, task.label]), [["agent", "agent", "Task"], ["shell", "shell", "Bash"]]);
  tasks.accept(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "fallback", name: "Agent", input: {} }] } }));
  tasks.accept(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "fallback", content: "Async agent launched successfully. agentId: fallback-worker" }] } }));
  assert.equal(tasks.count, 3);
  tasks.accept(line({ type: "user", message: { content: "<task-notification><task-id>fallback-worker</task-id><status>killed</status></task-notification>" } }));
  tasks.accept(line({ type: "result", subtype: "success" }));
  assert.equal(tasks.count, 2, "main-turn completion does not complete background work");
  for (const status of ["running", "completed", "killed", "failed"]) {
    tasks.accept(line({ type: "user", isMeta: true, message: { content: `<task-notification><task-id>agent</task-id><status>${status}</status></task-notification>` } }));
    assert.equal(tasks.count, status === "running" ? 2 : 1);
  }
  tasks.accept(line({ type: "user", message: { content: [{ type: "text", text: "<task-notification><task-id>shell</task-id><status>failed</status></task-notification>" }] } }));
  launch("Agent", "late", { isAsync: true, agentId: "agent" });
  assert.equal(tasks.count, 0);
  tasks.accept("broken");
  tasks.accept(line({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", name: "Agent", id: "nested" }] } }));
  assert.equal(tasks.count, 0);
});

test("a background task ends on a queued notification and on TaskStop", () => {
  const tasks = new BackgroundTasks();
  const shell = (toolId: string, taskId: string) => {
    tasks.accept(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: toolId, input: { run_in_background: true, command: "sleep" } }] } }));
    tasks.accept(line({ type: "user", toolUseResult: { backgroundTaskId: taskId }, message: { content: [{ type: "tool_result", tool_use_id: toolId, content: "running" }] } }));
  };
  shell("t0", "said-stopped");
  tasks.accept(line({ type: "user", message: { content: "<task-notification>\n<task-id>said-stopped</task-id>\n<status>stopped</status>\n</task-notification>" } }));
  assert.equal(tasks.count, 0, "a stopped status ends the task");
  shell("t1", "queued-shell");
  shell("t2", "stopped-shell");
  assert.equal(tasks.count, 2);
  // Mid-turn, the notification is written only as a queued_command attachment.
  tasks.accept(line({ type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>queued-shell</task-id>\n<status>completed</status>\n</task-notification>" } }));
  assert.deepEqual(tasks.list.map(task => task.id), ["stopped-shell"]);
  tasks.accept(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "TaskStop", id: "s1", input: { task_id: "nobody" } }] } }));
  tasks.accept(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s1", is_error: true, content: "No task" }] } }));
  assert.equal(tasks.count, 1, "a failed TaskStop ends nothing");
  tasks.accept(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "TaskStop", id: "s2", input: { task_id: "stopped-shell" } }] } }));
  tasks.accept(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s2", content: "Successfully stopped task: stopped-shell" }] } }));
  assert.equal(tasks.count, 0);
});

test("background tasks survive bounded summary tails and incremental partial records", t => {
  const f = fixture(t);
  const file = path.join(f.project, `${id}.jsonl`);
  const launched = line({ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Agent", input: {} }] } }) +
    line({ type: "user", toolUseResult: { isAsync: true, agentId: "worker" }, message: { content: [{ type: "tool_result", tool_use_id: "a", content: "async" }] } });
  fs.writeFileSync(file, line(user) + launched + line({ type: "unknown", padding: "x".repeat(600_000) }));
  f.desktop.list();
  assert.equal(f.desktop.backgroundTasks(id), 1);
  const done = line({ type: "user", message: { content: "<task-notification><task-id>worker</task-id><status>completed</status></task-notification>" } });
  fs.appendFileSync(file, done.slice(0, -1));
  assert.equal(f.desktop.backgroundTasks(id), 1);
  fs.appendFileSync(file, "\n");
  assert.equal(f.desktop.backgroundTasks(id), 0);
});

test("defensive transcript conversion preserves users, tools, failure and result", () => {
  const lines = [line(user), "not json", "null", line({ type: "unknown" }), line({ ...user, isSidechain: true }), line({ type: "assistant", message: { content: [null, 5, { type: "thinking", thinking: "not shown" }, { type: "thinking", thinking: "Checking the tool output", signature: signatureOf("narration") }, { type: "thinking", thinking: "withheld", signature: signatureOf("thinking") }] } }), line(assistant), line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "failed" }] }] } }), line({ type: "result", subtype: "success", duration_ms: 23, num_turns: 1 })];
  const bodies = lines.flatMap(l => transcriptEvents(l, user.cwd, summarize).bodies);
  assert.deepEqual(bodies.map(b => b.kind), ["user", "thinking", "narration", "thinking", "assistant", "tool_result", "result"]);
  assert.deepEqual(bodies[1], { kind: "thinking", msg: "", block: 2, text: "not shown" });
  // Only the block whose signature says narration is shown; the one that says thinking stays hidden.
  assert.deepEqual(bodies[2], { kind: "narration", msg: "", block: 3, text: "Checking the tool output" });
  assert.deepEqual(bodies[3], { kind: "thinking", msg: "", block: 4, text: "withheld" });
  const a = bodies[4];
  assert.equal(a?.kind === "assistant" && a.tools[0]?.summary, "file.ts");
  const result = bodies[5];
  assert.equal(result?.kind === "tool_result" && result.ok, false);
  assert.deepEqual(transcriptEvents(line({ type: "system", subtype: "turn_duration", durationMs: 99 }), "", summarize).bodies, [{ kind: "result", ok: true, ms: 99, turns: 1 }]);
  assert.equal(transcriptEvents(line({ ...user, isMeta: true }), "", summarize).bodies.length, 0);
});

test("desktop Agent and Task calls preserve prompts behind compact descriptions", () => {
  for (const name of ["Agent", "Task"]) {
    const prompt = "First paragraph\nSecond line\n\n1. First step\n2. Second step";
    const parsed = transcriptEvents(line({ ...assistant, message: { ...assistant.message, content: [{ type: "tool_use", id: "worker", name, input: { description: "Review timeline", model: "sol", prompt } }] } }), user.cwd, summarize);
    const event = parsed.bodies[0];
    assert.equal(event?.kind, "assistant");
    if (event?.kind !== "assistant") throw new Error("missing assistant");
    assert.equal(event.text, "");
    assert.equal(event.tools[0]?.summary, "Review timeline · sol");
    assert.deepEqual(JSON.parse(String(event.tools[0]?.input)), { description: "Review timeline", model: "sol", prompt });
    const result = transcriptEvents(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "worker", content: prompt }] } }), user.cwd, summarize);
    const view = reduce([...parsed.bodies, ...result.bodies].map((b, i) => ({ ...b, seq: i + 1, at: 0 })));
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0]?.type === "assistant" && view.items[0].tools[0]?.result?.text, prompt);
    const notification = transcriptEvents(line({ type: "user", message: { content: `<task-notification>\n<tool-use-id>worker</tool-use-id>\n<status>completed</status>\n<result>${prompt}</result>\n</task-notification>` } }), user.cwd, summarize);
    assert.deepEqual(notification.bodies, [{ kind: "tool_result", toolUseId: "worker", ok: true, text: prompt }]);
    const completed = reduce([...parsed.bodies, ...notification.bodies].map((b, i) => ({ ...b, seq: i + 1, at: 0 })));
    assert.equal(completed.items.length, 1);
    assert.equal(completed.items[0]?.type === "assistant" && completed.items[0].tools[0]?.result?.text, prompt);
  }
});

test("listing uses bounded windows, own title, cwd and last model without importing", t => {
  const f = fixture(t);
  const file = path.join(f.project, `${id}.jsonl`);
  fs.writeFileSync(file, line(user) + line({ type: "unknown", padding: "x".repeat(600_000) }) + line(assistant) + line({ type: "custom-title", customTitle: "  Own title  " }) + "broken\n");
  const [s] = f.desktop.list();
  assert.equal(s?.title, "Own title");
  assert.equal(s?.cwd, user.cwd);
  assert.equal(s?.model, "test-model");
  assert.equal(s?.origin, "desktop");
  assert.equal(s?.readOnly, false);
  assert.equal(s?.lastSeq, 0);
  assert.equal(s?.epoch, "");
  const log = f.desktop.log(id);
  assert.deepEqual(log.tail().events.map(e => e.kind), ["user", "assistant"]);
  assert.equal(log.tail().events[0]?.at, Date.parse(user.timestamp));
  assert.equal(f.desktop.log(id), log);
  fs.appendFileSync(file, line({ ...user, uuid: "u2", message: { content: "Second prompt" } }));
  const updated = f.desktop.log(id);
  assert.notEqual(updated.epoch, log.epoch);
  assert.equal(updated.lastSeq, 3);
});

test("desktop summary takes the newest user prompt's permissionMode, ignoring unknown values", t => {
  const f = fixture(t);
  const third = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const prompt = (uuid: string, mode?: unknown) => line({ ...user, uuid, ...(mode === undefined ? {} : { permissionMode: mode }), message: { content: `prompt ${uuid}` } });
  const toolResult = (uuid: string) => line({ type: "user", uuid, message: { content: [{ type: "tool_result", tool_use_id: uuid, content: "ok" }] } });
  // A mid-session change (bypass → plan) followed by a tool result that carries no mode: the newest prompt wins and carries forward.
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), prompt("m1", "bypassPermissions") + line(assistant) + prompt("m2", "plan") + toolResult("t1"));
  // An unknown value is never surfaced; the last known mode stands.
  fs.writeFileSync(path.join(f.project, `${other}.jsonl`), prompt("m1", "default") + prompt("m2", "shinyNewMode"));
  // A transcript whose prompts never name a mode has none.
  fs.writeFileSync(path.join(f.project, `${third}.jsonl`), prompt("m1") + line(assistant));
  const byId = new Map(f.desktop.list().map(s => [s.id, s]));
  assert.equal(byId.get(id)?.permissionMode, "plan");
  assert.equal(byId.get(other)?.permissionMode, "default");
  assert.equal(byId.get(third)?.permissionMode, undefined);
});

test("only recent top-level UUID files, no symlinks, host transcripts or traversal", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), line(user));
  fs.mkdirSync(path.join(f.project, "subagents"));
  fs.writeFileSync(path.join(f.project, "subagents", `${other}.jsonl`), line(user));
  fs.writeFileSync(path.join(f.project, "not-a-session.jsonl"), line(user));
  const old = path.join(f.project, `${other}.jsonl`);
  fs.writeFileSync(old, line(user));
  fs.utimesSync(old, new Date(0), new Date(0));
  const outside = path.join(f.root, "outside.jsonl");
  fs.writeFileSync(outside, line(user));
  if (fileSymlinks) fs.symlinkSync(outside, path.join(f.project, "cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl"));
  const linkedProject = path.join(f.root, "linked-project-target");
  fs.mkdirSync(linkedProject);
  fs.writeFileSync(path.join(linkedProject, `${linked}.jsonl`), line(user));
  fs.symlinkSync(linkedProject, path.join(f.projects, "linked-project"), "junction");
  assert.deepEqual(f.desktop.list().map(s => s.id), [id]);
  assert.equal(f.desktop.has("../../outside"), false);
  assert.throws(() => f.desktop.log("../../outside"), /no such session/);
  f.excluded.add(id);
  f.advance();
  assert.deepEqual(f.desktop.list(), []);
});

test("recent listing is sorted and capped at 50", t => {
  const f = fixture(t);
  for (let i = 0; i < 55; i++) {
    const file = path.join(f.project, `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}.jsonl`);
    fs.writeFileSync(file, line(user));
    const at = new Date(Date.now() - i * 1000);
    fs.utimesSync(file, at, at);
  }
  const list = f.desktop.list();
  assert.equal(list.length, 50);
  assert.ok(list[0]!.updatedAt > list[49]!.updatedAt);
});

test("large timeline outputs are blobs and paged below the frame cap", t => {
  const f = fixture(t);
  let data = line(user);
  for (let i = 0; i < 20; i++) data += line({ ...assistant, uuid: `a${i}`, message: { ...assistant.message, content: [{ type: "text", text: "한".repeat(100_000) }, ...assistant.message.content.slice(1)] } });
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), data + line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(100_000) }] } }) + "{unfinished");
  const log = f.desktop.log(id);
  let count = 0;
  let before = log.lastSeq + 1;
  for (;;) {
    const page = log.before(before, 2000);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < FRAME_CAP);
    count += page.events.length;
    for (const e of page.events) if ((e.kind === "assistant" || e.kind === "tool_result") && typeof e.text !== "string") assert.ok(log.blob(e.text.blob)!.length >= 100_000);
    if (!page.hasOlder) break;
    before = page.events[0]!.seq;
  }
  assert.equal(count, 22);
});

test("a fresh desktop process read bypasses the registry cache", { skip: process.platform !== "darwin" }, t => {
  const f = fixture(t);
  const registry = path.join(f.root, "sessions");
  fs.mkdirSync(registry);
  const file = path.join(registry, `${process.pid}.json`);
  const write = (status: string) => fs.writeFileSync(file, JSON.stringify({ pid: process.pid, entrypoint: "claude-desktop", sessionId: id, status }));
  write("idle");
  assert.equal(f.desktop.liveProcess(id)?.status, "idle");
  write("busy");
  assert.equal(f.desktop.liveProcess(id)?.status, "idle", "the normal read uses the cached snapshot");
  assert.equal(f.desktop.liveProcess(id, 0)?.status, "busy", "the fresh read observes the changed registry");
});

test("open detection matches exact session flags in fake ps output", () => {
  for (const flag of [`--resume=${id}`, `--session-id ${id}`, `--session-id=${id}`, `--resume ${id}`]) {
    assert.equal(processHasSession(` PID COMMAND\n 42 /path with spaces/claude ${flag} --model test\n`, id), true);
  }
  for (const args of [`--resume=${other}`, `--resume=${id}x`, `--prompt ${id}`, `--other=${id}`, ""]) {
    assert.equal(processHasSession(`42 claude ${args}`, id), false);
  }
  assert.equal(processHasSession(`42 claude --resume=invalid`, "invalid"), false);
});

test("live desktop states use fake ps and bounded cached filesystem reads", t => {
  const f = fixture(t);
  let now = Date.now();
  let ps = `42 claude --resume=${id}`;
  let calls = 0;
  const desktop = new DesktopSessions({ projects: f.projects, summarize, excluded: () => f.excluded,
    now: () => now, processes: () => { calls++; return ps; } });
  t.after(() => desktop.close());
  const file = path.join(f.project, `${id}.jsonl`);
  const write = (records: unknown[], age = 20_000) => {
    fs.writeFileSync(file, records.map(line).join(""));
    fs.utimesSync(file, new Date(now - age), new Date(now - age));
    now += 3000;
  };
  const completed = { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } };
  write([user, completed], 0);
  assert.equal(desktop.list()[0]?.state, "running");
  assert.equal(calls, 1);
  const reads = t.mock.method(fs, "readSync");
  assert.equal(desktop.poll(), false);
  assert.equal(calls, 1);
  now += 8000;
  assert.equal(desktop.poll(), true);
  assert.equal(desktop.list()[0]?.state, "stopped");
  assert.equal(reads.mock.callCount(), 0, "unchanged transcripts are not read");
  for (const records of [[user], [user, assistant], [user, assistant, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }],
    [user, { type: "assistant", message: { stop_reason: null, content: [{ type: "text", text: "partial" }] } }]]) {
    write([...records, { type: "cost-state" }, { type: "bridge-session" }]);
    desktop.poll();
    assert.equal(desktop.list()[0]?.state, "running");
  }
  for (const ending of [completed, { type: "system", subtype: "turn_duration" }, { type: "result", subtype: "success" },
    { type: "system", subtype: "stop_hook_summary", preventedContinuation: false },
    { type: "user", message: { content: "[Request interrupted by user]" } }]) {
    write([user, assistant, ending, { type: "custom-title", customTitle: "new title" }, { ...user, isSidechain: true }, { ...user, isMeta: true }]);
    desktop.poll();
    assert.equal(desktop.list()[0]?.state, "stopped");
    assert.equal(desktop.list()[0]?.title, "new title");
  }
  write([user], 0);
  ps = "";
  desktop.poll();
  assert.equal(desktop.list()[0]?.state, "stopped", "recent and unfinished is not working without an open process");
  ps = `42 claude --session-id ${id}`;
  now += 3000;
  assert.equal(desktop.poll(), true);
  assert.equal(desktop.list()[0]?.state, "running");
  fs.unlinkSync(file);
  now += 3000;
  assert.equal(desktop.poll(), true);
  assert.deepEqual(desktop.list(), []);
});

for (const mode of ["resume", "process", "recent"] as const) test(`desktop continuation: ${mode}`, async t => {
  const f = fixture(t);
  const file = path.join(f.project, `${id}.jsonl`);
  fs.writeFileSync(file, line(user) + line(assistant));
  if (mode !== "recent") fs.utimesSync(file, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const original = fs.readFileSync(file, "utf8");
  const options: Record<string, unknown>[] = [];
  let handoffs = 0;
  let turns = 0;
  const sessions = new Sessions({ dir: f.root, desktopProjects: f.projects, desktopProcesses: () => mode === "process" ? `42 claude --resume=${id}` : "", permissions: PermissionQueue.open(path.join(f.root, "permissions.json")), router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } }, queryFn: params => {
    options.push(params.options);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: params.options.sessionId ?? params.options.resume ?? id };
        for await (const input of params.prompt) {
          turns++;
          yield { type: "assistant", message: { id: `reply-${turns}`, model: "test-model", content: [{ type: "text", text: input.message.content }] } };
          yield { type: "result", subtype: "success", num_turns: 1 };
        }
      }, interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, close: () => {},
    };
  }, handoff: async () => { handoffs++; return "unexpected"; }, onEvent: () => {}, onSessions: () => {} });
  t.after(async () => { for (const s of sessions.list()) sessions.stop(s.id); await new Promise(resolve => setImmediate(resolve)); sessions.shutdown(); });
  assert.equal(sessions.list()[0]?.origin, "desktop");
  assert.deepEqual(reduce(sessions.log(id).tail().events).items.map(item => item.type), ["user", "assistant"]);
  if (mode === "process") {
    await assert.rejects(sessions.setModel(id, "chosen-model", "high"), /Claude 앱/);
    assert.equal(sessions.send(id, "first-phone", "continue"), id);
    assert.equal(sessions.summaryOf(id)?.queue?.[0]?.error, DESKTOP_BUSY, "an open process without registry status waits safely");
    assert.equal(options.length, 0);
    assert.equal(sessions.log(id).tail().events.some(e => e.kind === "user" && e.clientMsgId === "first-phone"), false);
    return;
  }
  await sessions.setModel(id, "chosen-model", "high");
  const host = sessions.send(id, "first-phone", "continue");
  assert.equal(sessions.send(id, "first-phone", "continue"), host);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(options[0]?.resume, id);
  assert.equal(handoffs, 0, "desktop continuations are never handed off again");
  assert.equal(options[0]?.cwd, user.cwd);
  assert.equal(options[0]?.model, "chosen-model@high");
  assert.equal(options[0]?.forkSession, undefined);
  assert.equal(options[0]?.sessionId, undefined);
  assert.equal(host, id);
  assert.equal(turns, 1);
  assert.deepEqual(sessions.list().map(s => s.origin), ["host"]);
  const events = sessions.log(host).tail().events;
  assert.deepEqual(events.slice(0, 2).map(e => e.kind), ["user", "assistant"]);
  assert.equal(events[0]?.at, Date.parse(user.timestamp));
  assert.ok(events.some(e => e.kind === "notice" && e.code === "desktop_resumed"));
  assert.equal(fs.readFileSync(file, "utf8"), original);
  sessions.stop(host);
  await new Promise(resolve => setImmediate(resolve));
  sessions.send(host, "second-phone", "again");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(options[1]?.resume, host);
  assert.equal(options[1]?.forkSession, undefined);
  assert.throws(() => sessions.log("../../escape"), /no such session/);
  sessions.stop(host);
  await new Promise(resolve => setImmediate(resolve));
  const restored = new Sessions({ dir: f.root, desktopProjects: f.projects, desktopProcesses: () => "", permissions: PermissionQueue.open(path.join(f.root, "permissions.json")), router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } }, queryFn: () => { throw new Error("retry must not start SDK"); }, onEvent: () => {}, onSessions: () => {} });
  try {
    assert.equal(restored.send(id, "first-phone", "continue"), host);
    assert.deepEqual(restored.list().map(s => s.origin), ["host"]);
  } finally { restored.shutdown(); }
});

test("the phone's slash menu drops the commands the init marks terminal-only", async () => {
  const { slashCommands } = await import("../src/bridge-client.ts");
  // Measured 2026-10-13 on a Mac session's Remote Control init: 85 commands, terminal_slash_commands ["focus"].
  assert.deepEqual(slashCommands({ slash_commands: ["compact", "focus", "context", 3, ""], terminal_slash_commands: ["focus"] }), ["compact", "context"]);
  assert.equal(slashCommands({}), null);
});

test("a background agent whose transcript ends on its answer is done without a notification", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ended-"));
  const file = path.join(dir, "agent-x.jsonl");
  assert.equal(agentEnded(file), false, "no transcript yet");
  fs.writeFileSync(file, line({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } }));
  assert.equal(agentEnded(file), false, "still calling tools");
  fs.appendFileSync(file, line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }));
  assert.equal(agentEnded(file), false, "waiting for the model");
  fs.appendFileSync(file, line({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }));
  assert.equal(agentEnded(file), true);
});

/** A worker's own transcript and its meta.json, beside the session file. */
function subagent(project: string, agentId: string, meta: Record<string, unknown>, records: string[]): void {
  const dir = path.join(project, id, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), records.join(""));
}
const assistantTurn = (model: string, stop: string, content: unknown[]): string => line({ isSidechain: true, type: "assistant", message: { model, stop_reason: stop, content } });
const subagentEvents = (log: { tail: (n?: number) => { events: { kind: string }[] } }) => log.tail(1 << 20).events.filter(e => e.kind === "subagent") as unknown as { toolUseId: string; description: string; model: string | null; status: string; steps: number }[];

test("a Mac session opens a worker with the model its own transcript answered on", t => {
  const f = fixture(t);
  subagent(f.project, "one", { toolUseId: "toolu_one", model: "gpt-6.1-sol@medium", description: "Sol·medium · Summarize the rules" }, [
    line({ isSidechain: true, type: "user", message: { content: "do it" } }),
    assistantTurn("deepseek-v4.1-flash", "end_turn", [{ type: "text", text: "ok" }]),
  ]);
  // No model in its transcript yet, and no tool description: meta's model (minus @effort) and stripped description stand.
  subagent(f.project, "two", { toolUseId: "toolu_two", model: "gpt-6.1-sol@medium", description: "Sol·medium · Long task" }, [
    assistantTurn("", "tool_use", [{ type: "tool_use", id: "t", name: "Read", input: {} }]),
  ]);
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), line(user) + line({ type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_one", name: "Agent", input: { description: "Summarize the rules" } },
    { type: "tool_use", id: "toolu_two", name: "Task", input: {} },
  ] } }));
  assert.deepEqual(subagentEvents(f.desktop.log(id)).map(e => [e.toolUseId, e.model, e.description, e.status]), [
    ["toolu_one", "deepseek-v4.1-flash", "Summarize the rules", "running"],
    ["toolu_two", "gpt-6.1-sol", "Long task", "running"],
    // Its transcript ends on its own answer with no notification line: the worker is done.
    ["toolu_one", "deepseek-v4.1-flash", "Summarize the rules", "done"],
  ]);
});

test("a Mac session's worker status follows its result, its notification, a queued notification, and agentEnded", t => {
  const f = fixture(t);
  const file = path.join(f.project, `${id}.jsonl`);
  let stamp = 2_000_000_000_000;
  const run = (records: string[]) => {
    fs.writeFileSync(file, [line(user), ...records].join(""));
    const at = new Date(stamp += 1000);
    fs.utimesSync(file, at, at);
    return subagentEvents(f.desktop.log(id)).map(e => [e.toolUseId, e.status]);
  };
  const toolUse = (tid: string) => line({ type: "assistant", message: { id: `m-${tid}`, model: "m", content: [{ type: "tool_use", id: tid, name: "Agent", input: { description: tid } }] } });
  const launch = (tid: string) => line({ type: "user", toolUseResult: { isAsync: true, agentId: "w" }, message: { content: [{ type: "tool_result", tool_use_id: tid, content: "Async agent launched successfully" }] } });
  const notice = (tid: string, status: string, queued = false) => {
    const prompt = `<task-notification>\n<tool-use-id>${tid}</tool-use-id>\n<status>${status}</status>\n</task-notification>`;
    return queued ? line({ type: "attachment", attachment: { type: "queued_command", prompt } }) : line({ type: "user", message: { content: prompt } });
  };
  assert.deepEqual(run([toolUse("a"), launch("a")]), [["a", "running"]], "an async launch is not an end");
  assert.deepEqual(run([toolUse("a"), launch("a"), notice("a", "completed")]), [["a", "running"], ["a", "done"]]);
  assert.deepEqual(run([toolUse("b"), launch("b"), notice("b", "completed", true)]), [["b", "running"], ["b", "done"]], "a queued notification ends it");
  assert.deepEqual(run([toolUse("c"), launch("c"), notice("c", "killed")]), [["c", "running"], ["c", "stopped"]]);
  const sync = (tid: string, error = false) => line({ type: "user", toolUseResult: { agentId: "w" }, message: { content: [{ type: "tool_result", tool_use_id: tid, is_error: error, content: "answer" }] } });
  assert.deepEqual(run([toolUse("d"), sync("d")]), [["d", "running"], ["d", "done"]], "a synchronous worker ends at its result");
  assert.deepEqual(run([toolUse("e"), sync("e", true)]), [["e", "running"], ["e", "failed"]]);
});

test("a running worker with a known model emits progress as only its own transcript grows", t => {
  const f = fixture(t);
  const worker = "toolu_progress";
  subagent(f.project, "progress", { toolUseId: worker, model: "sol@high" }, [
    assistantTurn("sol", "tool_use", [{ type: "tool_use", id: "read", name: "Read", input: {} }]),
  ]);
  const file = path.join(f.project, `${id}.jsonl`);
  fs.writeFileSync(file, line(user) + line({ type: "assistant", message: { content: [{ type: "tool_use", id: worker, name: "Agent", input: { run_in_background: true } }] } }) +
    line({ type: "user", toolUseResult: { isAsync: true, agentId: "progress" }, message: { content: [{ type: "tool_result", tool_use_id: worker, content: "launched asynchronously" }] } }));
  f.desktop.list();
  const events: import("../src/protocol.ts").EventBody[] = [];
  const imported = f.desktop.importInto(id, path.join(f.root, "opened-timeline"), Date.now);
  assert.equal(imported.tail().events.find(e => e.kind === "subagent")?.model, "sol");
  imported.close();
  const offset = fs.statSync(file).size;
  const workerFile = path.join(f.project, id, "subagents", "agent-progress.jsonl");
  fs.appendFileSync(workerFile, line({ isSidechain: true, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "read output" }] } }));
  assert.equal(f.desktop.tail(id, offset, body => events.push(body)), offset, "the parent transcript did not grow");
  assert.deepEqual(events.map(e => e.kind === "subagent" ? [e.model, e.steps, e.status] : e.kind), [["sol", 1, "running"]]);
  events.length = 0;
  f.desktop.tail(id, offset, body => events.push(body));
  assert.equal(events.length, 0, "an unchanged worker emits nothing");
  fs.appendFileSync(workerFile, assistantTurn("sol", "end_turn", [{ type: "text", text: "finished" }]));
  f.desktop.tail(id, offset, body => events.push(body));
  assert.deepEqual(events.map(e => e.kind === "subagent" ? [e.model, e.steps, e.status] : e.kind), [["sol", 2, "done"]]);
  assert.equal(f.desktop.subLog(id, `sub-${worker}`)?.tail().events.at(-1)?.kind, "assistant");
});

for (const content of ["[Request interrupted by user]", [{ type: "text", text: "[Request interrupted by user for tool use]" }]]) {
  test(`an interrupted worker closes without a notification (${typeof content}) on import, tail and reconnect`, t => {
    const f = fixture(t);
    const worker = "interrupted";
    const file = path.join(f.project, `${id}.jsonl`);
    const workerFile = path.join(f.project, id, "subagents", `agent-${worker}.jsonl`);
    const launch = line({ type: "assistant", message: { content: [{ type: "tool_use", id: worker, name: "Agent", input: { run_in_background: true } }] } });
    const launched = line({ type: "user", toolUseResult: { isAsync: true, agentId: worker }, message: { content: [{ type: "tool_result", tool_use_id: worker, content: "Async agent launched" }] } });
    subagent(f.project, worker, { toolUseId: worker }, [assistantTurn("sol", "tool_use", [{ type: "tool_use", id: "read", name: "Read", input: {} }])]);
    fs.writeFileSync(file, line(user) + launch + launched);
    const before = f.desktop.log(id);
    assert.equal(f.desktop.backgroundTasks(id), 1);
    fs.appendFileSync(workerFile, line({ type: "user", isSidechain: true, message: { content } }));
    assert.equal(agentEnded(workerFile), true);
    const events: import("../src/protocol.ts").EventBody[] = [];
    f.desktop.tail(id, fs.statSync(file).size, body => events.push(body));
    assert.deepEqual(events.filter(e => e.kind === "subagent").map(e => e.status), ["stopped"]);
    assert.equal(f.desktop.backgroundTasks(id), 0);
    assert.equal(f.desktop.backgroundTaskHistory(id).find(task => task.id === worker)?.state, "stopped");
    const after = f.desktop.log(id);
    assert.notEqual(after, before, "worker-only changes invalidate the parent snapshot");
    assert.equal(subagentEvents(after).at(-1)?.status, "stopped");
    const replay = new BackgroundActivity();
    for (const event of after.tail(1 << 20).events) replay.accept(event, text => typeof text === "string" ? text : after.blob(text.blob) ?? "");
    assert.equal(replay.active.length, 0);
    assert.equal(replay.history[0]?.state, "stopped");
    const restarted = new DesktopSessions({ projects: f.projects, summarize, excluded: () => new Set(), processes: () => "" });
    t.after(() => restarted.close());
    assert.equal(subagentEvents(restarted.log(id)).at(-1)?.status, "stopped");
    assert.equal(restarted.backgroundTasks(id), 0);
  });
}

test("only an exact final interruption record stops a worker, never inactivity or the parent's interruption", t => {
  const f = fixture(t);
  const file = path.join(f.project, `${id}.jsonl`);
  const launch = (tool: string) => line({ type: "assistant", message: { content: [{ type: "tool_use", id: tool, name: "Agent", input: {} }] } });
  const running = assistantTurn("sol", "tool_use", [{ type: "tool_use", id: "read", name: "Read", input: {} }]);
  const interrupted = line({ type: "user", isSidechain: true, message: { content: "[Request interrupted by user for tool use]" } });
  const endings = [
    running,
    interrupted + running,
    line({ type: "user", message: { content: "[Request interrupted by user] quoted instruction" } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    interrupted.slice(0, -1),
    interrupted + '{"type":"assistant"',
    line({ type: "user", message: { content: [{ type: "tool_result", content: "[Request interrupted by user]" }] } }),
  ];
  endings.forEach((ending, index) => subagent(f.project, `guard-${index}`, { toolUseId: `guard-${index}` }, [running, ending]));
  fs.writeFileSync(file, line(user) + endings.map((_, index) => launch(`guard-${index}`)).join("") +
    line({ type: "user", message: { content: "[Request interrupted by user]" } }));
  f.advance();
  assert.ok(subagentEvents(f.desktop.log(id)).every(e => e.status === "running"));
  endings.forEach((_, index) => assert.equal(agentEnded(path.join(f.project, id, "subagents", `agent-guard-${index}.jsonl`)), false));
});

test("a nested worker's interruption refreshes its unchanged parent's cached worker log", t => {
  const f = fixture(t);
  subagent(f.project, "parent", { toolUseId: "parent" }, [assistantTurn("sol", "tool_use", [{ type: "tool_use", id: "child", name: "Agent", input: {} }])]);
  subagent(f.project, "child", { toolUseId: "child" }, [assistantTurn("sol", "tool_use", [{ type: "tool_use", id: "read", name: "Read", input: {} }])]);
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), line(user));
  f.desktop.list();
  const before = f.desktop.subLog(id, "sub-parent")!;
  assert.equal(subagentEvents(before).at(-1)?.status, "running");
  fs.appendFileSync(path.join(f.project, id, "subagents", "agent-child.jsonl"), line({ type: "user", isSidechain: true, message: { content: "[Request interrupted by user for tool use]" } }));
  const after = f.desktop.subLog(id, "sub-parent")!;
  assert.notEqual(after, before);
  assert.equal(subagentEvents(after).at(-1)?.status, "stopped");
});

test("a Mac session's worker log is readable and grows with its transcript", t => {
  const f = fixture(t);
  subagent(f.project, "grow", { toolUseId: "toolu_grow", model: "sol@high", description: "sol·high · Task" }, [
    assistantTurn("sol", "tool_use", [{ type: "tool_use", id: "t", name: "Read", input: {} }]),
  ]);
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), line(user));
  f.desktop.list();
  const first = f.desktop.subLog(id, "sub-toolu_grow");
  assert.ok(first);
  assert.ok(first.lastSeq >= 1);
  assert.deepEqual(first!.readAfter(0, 1 << 20).events.map(e => e.kind), ["assistant"]);
  const before = first!.lastSeq;
  fs.appendFileSync(path.join(f.project, id, "subagents", "agent-grow.jsonl"), assistantTurn("sol", "end_turn", [{ type: "text", text: "done" }]));
  const second = f.desktop.subLog(id, "sub-toolu_grow");
  assert.ok(second!.lastSeq > before, "the worker log grows as its transcript does");
  assert.equal(f.desktop.subLog(id, "sub-toolu_missing"), null, "an unknown worker has no log");
});

test("sidechain records open children only inside their own worker conversation", () => {
  const nested = line({ isSidechain: true, type: "assistant", message: { model: "sol", content: [{ type: "tool_use", id: "nested", name: "Agent", input: { description: "nested" } }] } });
  const resolve = () => ({ model: "sol", steps: 1, description: "", terminal: null });
  // The parent pass skips sidechain records entirely.
  assert.deepEqual(transcriptEvents(nested, "/x", summarize).bodies, []);
  // Its own conversation exposes the child, retaining the launch call beside the lifecycle event.
  const own = transcriptEvents(nested, "/x", summarize, undefined, { allowSidechain: true, state: new Map(), resolve });
  assert.deepEqual(own.bodies.map(b => b.kind), ["subagent", "assistant"]);
});

test("desktop workers expose children and grandchildren without leaking them into the main conversation", t => {
  const f = fixture(t);
  const launch = (tool: string, prompt: string) => assistantTurn("sol", "tool_use", [{ type: "tool_use", id: tool, name: "Agent", input: { description: tool, prompt } }]);
  const result = (tool: string, failed = false) => line({ type: "user", isSidechain: true, message: { content: [{ type: "tool_result", tool_use_id: tool, is_error: failed, content: "result" }] } });
  subagent(f.project, "parent", { toolUseId: "parent" }, [launch("child", "Child instruction\nnot a summary")]);
  subagent(f.project, "child", { toolUseId: "child" }, [launch("grandchild", "Grandchild instruction"), result("grandchild", true)]);
  subagent(f.project, "grandchild", { toolUseId: "grandchild" }, [assistantTurn("sol", "end_turn", [{ type: "text", text: "Grandchild answer" }])]);
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), line(user) + line({ type: "assistant", message: { content: [{ type: "tool_use", id: "parent", name: "Agent", input: { prompt: "Parent instruction" } }] } }));
  const main = reduce(f.desktop.log(id).readAfter(0, 1 << 20).events);
  assert.deepEqual(main.items.filter(i => i.type === "subagent").map(i => i.sub), ["sub-parent"]);
  const parent = f.desktop.subLog(id, "sub-parent")!;
  const parentView = reduce(parent.readAfter(0, 1 << 20).events);
  assert.deepEqual(parentView.items.filter(i => i.type === "subagent").map(i => [i.sub, i.status]), [["sub-child", "running"]]);
  const childView = reduce(f.desktop.subLog(id, "sub-child")!.readAfter(0, 1 << 20).events);
  assert.deepEqual(childView.items.filter(i => i.type === "subagent").map(i => [i.sub, i.status]), [["sub-grandchild", "failed"]]);
  assert.equal(f.desktop.subLog(id, "sub-grandchild")!.readAfter(0).events.find(e => e.kind === "assistant")?.text, "Grandchild answer");
  fs.appendFileSync(path.join(f.project, id, "subagents", "agent-child.jsonl"), assistantTurn("sol", "end_turn", [{ type: "text", text: "Child done" }]));
  const refreshed = f.desktop.subLog(id, "sub-parent")!;
  assert.notEqual(refreshed, parent, "child progress invalidates a cached parent even when its own file is unchanged");
  assert.equal(reduce(refreshed.readAfter(0, 1 << 20).events).items.find(i => i.type === "subagent")?.status, "done");
  assert.equal(f.desktop.subLog(id, "sub-../../outside"), null);
});
