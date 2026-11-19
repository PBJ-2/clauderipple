import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { agentEnded, BackgroundTasks, DesktopSessions, liveDesktopProcesses, liveExternalProcesses, processHasSession, transcriptEvents, type DesktopProcess } from "../src/desktop.ts";
import type { ProcessSnapshot } from "../src/processes.ts";
import { summarize, Sessions } from "../src/sessions.ts";
import { PermissionQueue } from "../src/permissions.ts";
import { FRAME_CAP } from "../src/protocol.ts";
import { BackgroundActivity } from "../src/background-activity.ts";
import { reduce } from "../web/timeline.ts";
import { activityOverview } from "../web/activity.ts";
import { BridgeClient } from "../src/bridge-client.ts";
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
  const registry = new Map<string, DesktopProcess>();
  const options: ConstructorParameters<typeof DesktopSessions>[0] = { projects, summarize, excluded: () => excluded, now: () => now, processes: () => "" };
  const desktop = new DesktopSessions(options);
  t.after(() => { desktop.close(); fs.rmSync(root, { recursive: true, force: true }); });
  /** The Claude app holds the conversation: what it started may still run. Until called, the registry is read from disk. */
  const live = (sessionId = id) => { options.registry = () => registry; registry.set(sessionId, { sessionId, pid: 42, status: "idle" }); };
  return { root, projects, project, desktop, excluded, registry, live, advance: () => { now += 6000; } };
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
  // A phone message the ripple mod submits as the person's starts a new turn too; another plugin's prompt does not.
  plan({ items: [{ content: "Ship it", status: "completed" }] });
  tasks.accept(line({ type: "user", timestamp: "2026-10-23T02:00:00.000Z", origin: { kind: "plugin", name: "other" }, message: { content: "note" } }));
  assert.equal(tasks.plan.length, 1);
  tasks.accept(line({ type: "user", timestamp: "2026-10-23T03:00:00.000Z", origin: { kind: "plugin", name: "ripple", asUser: true }, message: { content: "여긴 리플리모트" } }));
  assert.deepEqual(tasks.plan, []);
  assert.equal(tasks.turnStartedAt, Date.parse("2026-10-23T03:00:00.000Z"));
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
  f.live();
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
  // The summary compaction writes is hidden in the app, so it is not drawn on the phone either.
  assert.equal(transcriptEvents(line({ ...user, isCompactSummary: true, isVisibleInTranscriptOnly: true }), "", summarize).bodies.length, 0);
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
    assert.equal(sessions.summaryOf(id)?.queue?.[0]?.wait, "desktop_busy", "an open process without registry status waits safely");
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
const subagentEvents = (log: { tail: (n?: number) => { events: { kind: string }[] } }) => log.tail(1 << 20).events.filter(e => e.kind === "subagent") as unknown as { toolUseId: string; description: string; model: string | null; effort?: string; status: string; steps: number }[];

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
  // The effort comes from meta's model suffix (@medium) and the hook's prefix (Sol·medium); both say medium.
  assert.deepEqual(subagentEvents(f.desktop.log(id)).map(e => [e.toolUseId, e.model, e.description, e.status, e.effort ?? null]), [
    ["toolu_one", "deepseek-v4.1-flash", "Summarize the rules", "running", "medium"],
    ["toolu_two", "gpt-6.1-sol", "Long task", "running", "medium"],
    // Its transcript ends on its own answer with no notification line: the worker is done.
    ["toolu_one", "deepseek-v4.1-flash", "Summarize the rules", "done", "medium"],
  ]);
});

test("a Mac session's worker effort reaches the background list, the timeline and the overview row, and is never guessed", t => {
  const f = fixture(t);
  f.live();
  subagent(f.project, "effort", { toolUseId: "toolu_effort", model: "gpt-6.1-sol@high", description: "Sol·high · Review the diff" }, [
    assistantTurn("gpt-6.1-sol", "tool_use", [{ type: "tool_use", id: "t", name: "Read", input: {} }]),
  ]);
  subagent(f.project, "plain", { toolUseId: "toolu_plain", model: "gpt-6.1-sol", description: "Plain task" }, [
    assistantTurn("gpt-6.1-sol", "tool_use", [{ type: "tool_use", id: "t", name: "Read", input: {} }]),
  ]);
  const launch = (tid: string, agentId: string): string => [
    line({ type: "assistant", message: { id: `m-${tid}`, model: "gpt-6.1-sol", content: [{ type: "tool_use", id: tid, name: "Agent", input: { description: tid, run_in_background: true } }] } }),
    line({ type: "user", toolUseResult: { isAsync: true, agentId }, message: { content: [{ type: "tool_result", tool_use_id: tid, content: "Async agent launched successfully" }] } }),
  ].join("");
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), line(user) + launch("toolu_effort", "effort") + launch("toolu_plain", "plain"));
  f.desktop.list();
  // The raw-transcript scanner: the task list a Desktop-bridged session's summary carries.
  const taskList = f.desktop.backgroundTaskList(id);
  assert.deepEqual(taskList.map(task => [task.sub, task.effort ?? null]), [["sub-toolu_effort", "high"], ["sub-toolu_plain", null]]);
  // The timeline reduction of the same session's events.
  const view = reduce(f.desktop.log(id).tail(1 << 20).events);
  assert.deepEqual(view.items.flatMap(item => item.type === "subagent" ? [[item.sub, item.effort ?? null]] : []), [["sub-toolu_effort", "high"], ["sub-toolu_plain", null]]);
  // The overview row the phone's sheet and the web both read.
  const rows = activityOverview(view.items, taskList, f.desktop.backgroundTaskHistory(id)).active;
  assert.deepEqual(rows.map(task => [task.sub, task.model, task.effort ?? null]), [["sub-toolu_effort", "gpt-6.1-sol", "high"], ["sub-toolu_plain", "gpt-6.1-sol", null]]);
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
    f.live();
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

test("a tail seeded from a handoff skips a later copy of a seeded worker launch (#126)", t => {
  // An SDK handoff's log holds its events without transcript-line identities, so only the seed's own
  // record can tell that a line after the offset is a copy of one before it.
  const f = fixture(t);
  const file = path.join(f.project, `${id}.jsonl`);
  const launch = { type: "assistant", uuid: "launch", timestamp: "2026-11-05T01:00:02Z", message: { id: "lm", model: "model", content: [
    { type: "tool_use", id: "worker-1", name: "Agent", input: { description: "worker", prompt: "go" } },
  ] } };
  const launched = { type: "user", uuid: "launched", timestamp: "2026-11-05T01:00:03Z", toolUseResult: { isAsync: true, agentId: "task-1" },
    message: { content: [{ type: "tool_result", tool_use_id: "worker-1", content: "launched asynchronously" }] } };
  fs.writeFileSync(file, line(user) + line(launch) + line(launched));
  f.desktop.list();
  const events: import("../src/protocol.ts").EventBody[] = [];
  let offset = f.desktop.tail(id, fs.statSync(file).size, body => events.push(body));
  fs.appendFileSync(file, line({ ...launch, cwd: "/moved/project" }));
  offset = f.desktop.tail(id, offset, body => events.push(body));
  assert.deepEqual(events.filter(e => e.kind === "assistant" || e.kind === "subagent"), [], "the copy emits nothing");
  fs.appendFileSync(file, line({ type: "user", uuid: "notify", timestamp: "2026-11-05T01:00:04Z",
    message: { content: "<task-notification><task-id>task-1</task-id><status>completed</status><result>done</result></task-notification>" } }));
  f.desktop.tail(id, offset, body => events.push(body));
  assert.deepEqual(events.filter(e => e.kind === "subagent").map(e => e.kind === "subagent" && [e.toolUseId, e.status]), [["worker-1", "done"]]);
});

test("processHasSession answers every session from one tokenization of the listing, exactly as per-line matching would", () => {
  const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444", "55555555-5555-5555-5555-555555555555"];
  const legacy = (output: string, id: string): boolean => output.split("\n").some(line => {
    const args = line.trim().split(/\s+/).map(arg => arg.replace(/^"|"$/g, ""));
    return args.some((arg, i) => arg === `--resume=${id}` || arg === `--session-id=${id}` || ((arg === "--session-id" || arg === "--resume") && args[i + 1] === id));
  });
  const outputs = [
    `1 claude --resume=${ids[0]}\n2 claude --session-id ${ids[1]} --model x\n3 claude "--resume=${ids[2]}"\n4 claude --prompt ${ids[3]}`,
    `1 claude --resume\n${ids[0]}\n2 claude --session-id=${ids[1]}x\n3 claude --model ${ids[2]} --resume ${ids[4]}`,
    `  5 claude   --resume   ${ids[0]}  \n6 claude --resume ${ids[1]} --resume=${ids[2]}\n7 claude --other=--resume=${ids[3]}`,
    `1 claude --resume "${ids[4]}"\n2 claude --resume=`,
    "",
  ];
  for (const output of outputs) for (const id of ids) assert.equal(processHasSession(output, id), legacy(output, id), `${JSON.stringify(output)} / ${id}`);
  // A new listing replaces the memoized one.
  assert.equal(processHasSession(`1 claude --resume=${ids[0]}`, ids[0]!), true);
  assert.equal(processHasSession(`1 claude --resume=${ids[1]}`, ids[0]!), false);
});

test("a transcript the host was told of is listed at once, not at the next 30 s rediscovery", t => {
  const f = fixture(t);
  const moved = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), line(user));
  assert.deepEqual(f.desktop.list().map(s => s.id), [id]);
  f.advance();
  fs.writeFileSync(path.join(f.project, `${moved}.jsonl`), line(user));
  assert.deepEqual(f.desktop.list().map(s => s.id), [id], "the scan waits out its 30 s");
  f.desktop.rediscover(moved);
  assert.deepEqual(f.desktop.list().map(s => s.id).sort(), [id, moved].sort());
  f.desktop.rediscover("not-a-session");
  assert.deepEqual(f.desktop.list().map(s => s.id).sort(), [id, moved].sort(), "an id that is not a session is ignored");
});

test("a named transcript stays listed while the app's sidebar lags, and is dropped after ten minutes without it", t => {
  const f = fixture(t);
  const listed = new Set([id]);
  let now = Date.now();
  const desktop = new DesktopSessions({ projects: f.projects, summarize, excluded: () => f.excluded, now: () => now, processes: () => "", sidebarIds: () => listed });
  t.after(() => desktop.close());
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), line(user));
  assert.deepEqual(desktop.list().map(s => s.id), [id]);
  fs.writeFileSync(path.join(f.project, `${other}.jsonl`), line(user));
  desktop.rediscover(other);
  assert.deepEqual(desktop.list().map(s => s.id).sort(), [id, other].sort(), "named at once, before the sidebar lists it");
  now += 60_000;
  assert.deepEqual(desktop.list().map(s => s.id).sort(), [id, other].sort(), "still named on a later scan");
  now += 10 * 60_000;
  assert.deepEqual(desktop.list().map(s => s.id), [id], "named for ten minutes only, then the sidebar alone decides");
});

test("once the sidebar lists a named transcript, the sidebar alone keeps it", t => {
  const f = fixture(t);
  const listed = new Set([id]);
  let now = Date.now();
  const desktop = new DesktopSessions({ projects: f.projects, summarize, excluded: () => f.excluded, now: () => now, processes: () => "", sidebarIds: () => listed });
  t.after(() => desktop.close());
  fs.writeFileSync(path.join(f.project, `${id}.jsonl`), line(user));
  fs.writeFileSync(path.join(f.project, `${other}.jsonl`), line(user));
  desktop.rediscover(other);
  listed.add(other);
  assert.deepEqual(desktop.list().map(s => s.id).sort(), [id, other].sort(), "the sidebar names it");
  listed.delete(other);
  now += 60_000;
  assert.deepEqual(desktop.list().map(s => s.id), [id], "no longer named, and the sidebar no longer lists it");
});

// ---- a Claude Code CLI alive outside the Claude app (issue #171) ---------------------------------

const outside = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
/** A DesktopSessions with the sidebar present and the registries injected, the way the host builds one. */
function withSidebar(t: import("node:test").TestContext, sidebar: Set<string>) {
  const f = fixture(t);
  const external = new Map<string, DesktopProcess>();
  let now = Date.now();
  const desktop = new DesktopSessions({ projects: f.projects, summarize, excluded: () => f.excluded, now: () => now, processes: () => "",
    sidebarIds: () => sidebar, registry: () => new Map(), externalRegistry: () => external });
  t.after(() => desktop.close());
  const cli = (sessionId: string, status: DesktopProcess["status"] = "idle") => external.set(sessionId, { sessionId, pid: 4242, status, external: true });
  return { f, desktop, external, cli, rescan: () => { now += 31_000; } };
}

test("a CLI alive outside the app is listed while the sidebar is present, read-only and in its live state", t => {
  const w = withSidebar(t, new Set([id]));
  fs.writeFileSync(path.join(w.f.project, `${id}.jsonl`), line(user));
  fs.writeFileSync(path.join(w.f.project, `${outside}.jsonl`), line(user));
  assert.deepEqual(w.desktop.list().map(s => s.id), [id], "no process holds it: the sidebar alone decides, as before");
  w.cli(outside, "busy");
  w.rescan();
  const rows = w.desktop.list();
  assert.deepEqual(rows.map(s => s.id).sort(), [id, outside].sort());
  const row = rows.find(s => s.id === outside)!;
  assert.deepEqual([row.state, row.readOnly, row.ownedExternally, row.origin], ["running", true, true, "desktop"]);
  assert.equal(rows.find(s => s.id === id)!.readOnly, false, "the app's own session stays replyable");
  w.cli(outside, "waiting");
  w.rescan();
  assert.equal(w.desktop.list().find(s => s.id === outside)!.state, "waiting");
  w.cli(outside, "idle");
  w.rescan();
  assert.equal(w.desktop.list().find(s => s.id === outside)!.state, "idle");
});

test("a rediscovery that rebuilds an outside CLI's summary inside the live-update throttle keeps it read-only", t => {
  const w = withSidebar(t, new Set([id]));
  let now = Date.now();
  const desktop = new DesktopSessions({ projects: w.f.projects, summarize, excluded: () => w.f.excluded, now: () => now, processes: () => "",
    sidebarIds: () => new Set([id]), registry: () => new Map(), externalRegistry: () => w.external });
  t.after(() => desktop.close());
  fs.writeFileSync(path.join(w.f.project, `${id}.jsonl`), line(user));
  fs.writeFileSync(path.join(w.f.project, `${outside}.jsonl`), line(user));
  w.cli(outside);
  assert.equal(desktop.list().find(s => s.id === outside)?.readOnly, true);
  now += 28_000;
  desktop.list(); // a live update, no rediscovery yet
  fs.appendFileSync(path.join(w.f.project, `${outside}.jsonl`), line(user));
  now += 2_500; // rediscovery is due, the live update is still throttled
  const row = desktop.list().find(s => s.id === outside)!;
  assert.deepEqual([row.readOnly, row.ownedExternally], [true, true]);
});

test("an outside CLI row disappears on the next scan after its process exits", t => {
  const w = withSidebar(t, new Set([id]));
  fs.writeFileSync(path.join(w.f.project, `${id}.jsonl`), line(user));
  fs.writeFileSync(path.join(w.f.project, `${outside}.jsonl`), line(user));
  w.cli(outside);
  w.rescan();
  assert.ok(w.desktop.list().some(s => s.id === outside));
  w.external.clear(); // the PID is gone
  w.rescan();
  assert.deepEqual(w.desktop.list().map(s => s.id), [id]);
});

test("a session the sidebar lists and an outside CLI holds is one row, read-only", t => {
  const w = withSidebar(t, new Set([id]));
  fs.writeFileSync(path.join(w.f.project, `${id}.jsonl`), line(user));
  w.cli(id, "busy");
  w.rescan();
  const rows = w.desktop.list();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.readOnly, rows[0]!.state], [true, "running"], "a second resume on a held session would fork it");
  w.external.clear();
  w.rescan();
  assert.deepEqual(w.desktop.list().map(s => [s.id, s.readOnly, s.ownedExternally]), [[id, false, undefined]], "released: replyable again");
});

test("the id a /clear left behind is not listed: only the id a live process holds is", t => {
  const w = withSidebar(t, new Set([id]));
  fs.writeFileSync(path.join(w.f.project, `${id}.jsonl`), line(user));
  fs.writeFileSync(path.join(w.f.project, `${outside}.jsonl`), line(user));
  fs.writeFileSync(path.join(w.f.project, `${other}.jsonl`), line(user)); // the CLI's earlier conversation
  w.cli(outside);
  w.rescan();
  assert.deepEqual(w.desktop.list().map(s => s.id).sort(), [id, outside].sort());
});

test("the registry reader sorts live CLIs outside the app from the app's own writers", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const entry = (pid: number, sessionId: string, over: Record<string, unknown>) =>
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: "/synthetic", status: "idle", kind: "interactive", ...over }));
  entry(process.pid, outside, { entrypoint: "sdk-cli" });
  entry(dead, other, { entrypoint: "cli" });
  entry(process.ppid, linked, { entrypoint: "claude-desktop", startedAt: 1794992681859 });
  const headless = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  t.after(() => { headless.kill(); });
  entry(headless.pid!, id, { entrypoint: "sdk-cli", kind: "headless" });
  const none = { current: () => [] } as unknown as ProcessSnapshot;
  const external = liveExternalProcesses(dir, 0, "darwin", none);
  assert.deepEqual([...external.keys()], [outside], "a dead pid, a headless run and the app's writer are not listed");
  assert.equal(external.get(outside)?.external, true);
  assert.deepEqual([...liveDesktopProcesses(dir, 0, "darwin", none).keys()], [linked], "the app's registry read holds the app's writer only");
  assert.equal(liveDesktopProcesses(dir, 0, "darwin", none).get(linked)?.startedAt, 1794992681859, "the process's own start time is read from its registry entry (#176)");
});

test("an Artifact call's result carries the published page, and its row reads as the title", () => {
  const call = line({ type: "assistant", uuid: "a1", message: { id: "m1", content: [{ type: "tool_use", id: "art", name: "Artifact", input: { file_path: "C:\\work\\report.html", description: "Sales report", icon: "chart" } }] } });
  const result = (toolUseResult: unknown, isError = false) => line({ type: "user", uuid: "u1", toolUseResult, message: { content: [{ type: "tool_result", tool_use_id: "art", is_error: isError, content: "Published" }] } });
  const published = { artifact_id: "abc", url: "https://claude.ai/artifact/abc", title: "Q3 sales", icon: "chart", version: 2, audience: "private", path: "C:\\work\\report.html" };
  const events = (text: string) => transcriptEvents(text, "C:\\work", summarize).bodies;

  const [assistant] = events(call);
  assert.equal(assistant?.kind === "assistant" && assistant.tools[0]?.summary, "Sales report", "never the local path");
  const [done] = events(result(published));
  assert.deepEqual(done?.kind === "tool_result" && done.artifact, { title: "Q3 sales", url: "https://claude.ai/artifact/abc", icon: "chart", version: 2 });
  const rows = reduce([assistant!, done!].map((b, i) => ({ ...b, seq: i + 1, at: 0 }))).items;
  const item = rows.find(i => i.type === "assistant");
  assert.equal(item?.type === "assistant" && item.tools[0]?.summary, "Q3 sales");
  assert.equal(item?.type === "assistant" && item.tools[0]?.result?.artifact?.url, "https://claude.ai/artifact/abc");

  const withoutOptional = events(result({ artifact_id: "abc", url: "https://claude.ai/artifact/abc", title: "T" }))[0];
  assert.deepEqual(withoutOptional?.kind === "tool_result" && withoutOptional.artifact, { title: "T", url: "https://claude.ai/artifact/abc" });
  const none = (value: unknown, error = false) => { const body = events(result(value, error))[0]; return body?.kind === "tool_result" && !("artifact" in body); };
  assert.ok(none({ ...published, url: "http://claude.ai/artifact/abc" }), "plain http");
  assert.ok(none({ ...published, url: "https://claude.ai.evil.example/artifact/abc" }), "look-alike host");
  assert.ok(none({ ...published, url: "https://user@claude.ai/artifact/abc" }), "credentials");
  assert.ok(none({ ...published, url: "javascript:alert(1)" }), "script address");
  assert.ok(none({ ...published, url: "file:///C:/work/report.html" }), "local file");
  assert.ok(none({ ...published, title: "  " }), "no title");
  assert.ok(none({ url: "https://claude.ai/chat/1", title: "WebFetch page" }), "another tool's result");
  assert.ok(none(published, true), "a failed call");
  assert.ok(none(undefined), "no structured result");
});

test("a background task begun before the live process started is no longer running; one begun after it stays (#176)", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-test-"));
  const projects = path.join(root, "projects");
  const project = path.join(projects, "project");
  fs.mkdirSync(project, { recursive: true });
  const registry = new Map<string, DesktopProcess>();
  const desktop = new DesktopSessions({ projects, summarize, excluded: () => new Set(), now: Date.now, processes: () => "", registry: () => registry });
  t.after(() => { desktop.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const processStart = Date.parse("2026-11-18T09:00:00.000Z");
  const launch = (tool: string, tid: string, taskId: string, when: string, input: Record<string, unknown>, result: Record<string, unknown>): string => [
    line({ type: "assistant", timestamp: when, message: { id: `m-${tid}`, model: "test-model", content: [{ type: "tool_use", id: tid, name: tool, input }] } }),
    line({ type: "user", timestamp: when, toolUseResult: result, message: { content: [{ type: "tool_result", tool_use_id: tid, content: `started ${taskId}` }] } }),
  ].join("");
  fs.writeFileSync(path.join(project, `${id}.jsonl`), line(user)
    + launch("Monitor", "old-monitor", "mon-old", "2026-11-12T01:00:00.000Z", { description: "Old watch", command: "tail -f x" }, { taskId: "mon-old" })
    + launch("Bash", "old-shell", "sh-old", "2026-11-18T08:59:59.000Z", { command: "sleep 9999", run_in_background: true }, { backgroundTaskId: "sh-old" })
    + launch("Monitor", "new-monitor", "mon-new", "2026-11-18T09:30:00.000Z", { description: "New watch", command: "tail -f y" }, { taskId: "mon-new" }));
  desktop.list();
  // The registry names no start time: nothing can be said, so the transcript's tasks stay as read.
  registry.set(id, { sessionId: id, pid: 42, status: "idle", bridgeSessionId: "cse_x" });
  assert.deepEqual(desktop.backgroundTaskList(id).map(task => task.id), ["mon-old", "sh-old", "mon-new"]);
  registry.set(id, { sessionId: id, pid: 42, status: "idle", bridgeSessionId: "cse_x", startedAt: processStart });
  assert.deepEqual(desktop.backgroundTaskList(id).map(task => task.id), ["mon-new"], "only the current process's task is running");
  assert.deepEqual(desktop.backgroundTaskHistory(id).map(task => [task.id, task.state]), [["sh-old", "unknown"], ["mon-old", "unknown"]]);
  const summary = desktop.list().find(s => s.id === id);
  assert.deepEqual(summary?.taskList?.map(task => task.id), ["mon-new"]);
  assert.equal(summary?.tasks, 1);
  assert.deepEqual(summary?.taskHistory?.map(task => task.id), ["sh-old", "mon-old"]);
});

test("the history keeps the real outcomes ahead of the work the app lost, however old (#176)", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-test-"));
  const projects = path.join(root, "projects");
  const project = path.join(projects, "project");
  fs.mkdirSync(project, { recursive: true });
  const registry = new Map<string, DesktopProcess>();
  const desktop = new DesktopSessions({ projects, summarize, excluded: () => new Set(), now: Date.now, processes: () => "", registry: () => registry });
  t.after(() => { desktop.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const processStart = Date.parse("2026-11-18T09:00:00.000Z");
  const launch = (tid: string, taskId: string, when: string): string => [
    line({ type: "assistant", timestamp: when, message: { id: `m-${tid}`, model: "test-model", content: [{ type: "tool_use", id: tid, name: "Bash", input: { command: `job ${taskId}`, run_in_background: true } }] } }),
    line({ type: "user", timestamp: when, toolUseResult: { backgroundTaskId: taskId }, message: { content: [{ type: "tool_result", tool_use_id: tid, content: `started ${taskId}` }] } }),
  ].join("");
  const finish = (taskId: string, when: string): string => line({ type: "user", timestamp: when, message: { content: `<task-notification><task-id>${taskId}</task-id><status>completed</status></task-notification>` } });
  const minute = (n: number): string => new Date(Date.parse("2026-11-18T10:00:00.000Z") + n * 60_000).toISOString();
  let transcript = line(user);
  // Two jobs begun before the process started and never ended: the app lost them.
  transcript += launch("lost-1", "lost-1", "2026-11-17T08:00:00.000Z") + launch("lost-2", "lost-2", "2026-11-18T08:59:00.000Z");
  // Forty-one jobs that ended after it started, one a minute, the first of them already done before the lost one began.
  for (let n = 0; n < 41; n++) transcript += launch(`job-${n}`, `job-${n}`, minute(n)) + finish(`job-${n}`, minute(n));
  // A worker launched long before the process started and finished: its end is known only from its own
  // transcript, so it has no endedAt. It must not be ranked by its launch time and cut by the cap.
  transcript += line({ type: "assistant", timestamp: "2026-11-18T06:00:00.000Z", message: { id: "m-w", model: "test-model", content: [{ type: "tool_use", id: "w", name: "Agent", input: { run_in_background: true } }] } })
    + line({ type: "user", timestamp: "2026-11-18T06:00:00.000Z", toolUseResult: { isAsync: true, agentId: "w" }, message: { content: [{ type: "tool_result", tool_use_id: "w", content: "Async agent launched" }] } });
  subagent(project, "w", { toolUseId: "w" }, [assistantTurn("sol", "end_turn", [{ type: "text", text: "done" }])]);
  fs.writeFileSync(path.join(project, `${id}.jsonl`), transcript);
  desktop.list();
  registry.set(id, { sessionId: id, pid: 42, status: "idle", bridgeSessionId: "cse_x", startedAt: processStart });
  const history = desktop.backgroundTaskHistory(id);
  assert.equal(history.length, 40);
  assert.deepEqual(history.map(task => task.id), ["w", ...Array.from({ length: 39 }, (_, n) => `job-${40 - n}`)], "the worker finished by its own transcript leads, then the newest real outcomes; the lost ones come after them and fall off");
  assert.ok(history.every(task => task.state !== "unknown"));
  // With room for them, the lost work follows the real outcomes, newest first (all began before the process).
  fs.writeFileSync(path.join(project, `${id}.jsonl`), line(user) + launch("lost-3", "lost-3", "2026-11-18T08:59:00.000Z")
    + launch("old", "old", "2026-11-18T07:00:00.000Z") + finish("old", "2026-11-18T08:00:00.000Z") + launch("new", "new", minute(0)) + finish("new", minute(1)));
  assert.deepEqual(desktop.backgroundTaskHistory(id).map(task => [task.id, task.state]), [["new", "done"], ["old", "done"], ["lost-3", "unknown"]]);
});

test("a busy the registry set before the main turn ended is background work: the session reads idle, its work still counts", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-test-"));
  const projects = path.join(root, "projects");
  const project = path.join(projects, "project");
  fs.mkdirSync(project, { recursive: true });
  const registry = new Map<string, DesktopProcess>();
  const desktop = new DesktopSessions({ projects, summarize, excluded: () => new Set(), now: Date.now, processes: () => "", registry: () => registry });
  t.after(() => { desktop.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(project, `${id}.jsonl`);
  const prompt = (at: string, text: string) => line({ type: "user", timestamp: at, origin: { kind: "human" }, message: { content: text } });
  const answer = (at: string) => line({ type: "assistant", timestamp: at, message: { id: `m-${at}`, model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } })
    + line({ type: "system", subtype: "stop_hook_summary", timestamp: at });
  fs.writeFileSync(file, line(user) + answer("2026-11-19T12:40:00.000Z"));
  desktop.list();
  const busySince = Date.parse("2026-11-19T12:36:00.000Z");
  registry.set(id, { sessionId: id, pid: 42, status: "busy", bridgeSessionId: "cse_x", statusAt: busySince });
  const live = desktop.liveProcess(id);
  assert.equal(live?.status, "idle", "the turn ended after the busy was set");
  assert.equal(live?.backgroundOnly, true);
  assert.equal(desktop.list().find(s => s.id === id)?.turnStartedAt, null);
  // A busy set after the turn ended is a new turn, even before its prompt reaches the transcript.
  registry.set(id, { sessionId: id, pid: 42, status: "busy", bridgeSessionId: "cse_x", statusAt: Date.parse("2026-11-19T12:41:00.000Z") });
  assert.equal(desktop.liveProcess(id)?.status, "busy");
  // The busy stays set across a new prompt while background agents run: the open turn is real work.
  registry.set(id, { sessionId: id, pid: 42, status: "busy", bridgeSessionId: "cse_x", statusAt: busySince });
  fs.appendFileSync(file, prompt("2026-11-19T12:50:00.000Z", "Next"));
  assert.equal(desktop.liveProcess(id)?.status, "busy");
  // No status time in the registry: nothing can be said, so busy stays busy.
  fs.appendFileSync(file, answer("2026-11-19T12:55:00.000Z"));
  registry.set(id, { sessionId: id, pid: 42, status: "busy", bridgeSessionId: "cse_x" });
  assert.equal(desktop.liveProcess(id)?.status, "busy");
});

test("an assistant's final reply is not the turn's end until its Stop hook reports, or a minute passes without it", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-test-"));
  const projects = path.join(root, "projects");
  const project = path.join(projects, "project");
  fs.mkdirSync(project, { recursive: true });
  const registry = new Map<string, DesktopProcess>();
  let now = Date.parse("2026-11-19T12:40:10.000Z");
  const desktop = new DesktopSessions({ projects, summarize, excluded: () => new Set(), now: () => now, processes: () => "", registry: () => registry });
  t.after(() => { desktop.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(project, `${id}.jsonl`);
  fs.writeFileSync(file, line(user) + line({ type: "assistant", timestamp: "2026-11-19T12:40:00.000Z", message: { id: "m-1", model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } }));
  desktop.list();
  registry.set(id, { sessionId: id, pid: 42, status: "busy", bridgeSessionId: "cse_x", statusAt: Date.parse("2026-11-19T12:36:00.000Z") });
  assert.equal(desktop.liveProcess(id)?.status, "busy", "the Stop hook may still send the turn on");
  now = Date.parse("2026-11-19T12:41:01.000Z");
  assert.equal(desktop.liveProcess(id)?.status, "idle", "a minute without the hook's summary");
  now = Date.parse("2026-11-19T12:40:10.000Z");
  fs.appendFileSync(file, line({ type: "system", subtype: "stop_hook_summary", timestamp: "2026-11-19T12:40:05.000Z" }));
  assert.equal(desktop.liveProcess(id)?.status, "idle", "the hook let the turn end");
  assert.equal(desktop.liveProcess(id)?.turnEndedAt, Date.parse("2026-11-19T12:40:05.000Z"));
});

test("a wakeup past its time has fired, and a conversation no process holds runs nothing it started", t => {
  const f = fixture(t);
  const file = path.join(f.project, `${id}.jsonl`);
  const call = (tool: string, tid: string, when: string, input: Record<string, unknown>, result: Record<string, unknown>): string => [
    line({ type: "assistant", timestamp: when, message: { id: `m-${tid}`, model: "test-model", content: [{ type: "tool_use", id: tid, name: tool, input }] } }),
    line({ type: "user", timestamp: when, toolUseResult: result, message: { content: [{ type: "tool_result", tool_use_id: tid, content: "ok" }] } }),
  ].join("");
  const wakeAt = Date.now() - 30_000;
  fs.writeFileSync(file, line(user)
    + call("ScheduleWakeup", "wake", new Date(wakeAt - 60_000).toISOString(), { reason: "Waiting on the publish job", prompt: "check" }, { scheduledFor: wakeAt })
    + call("Monitor", "mon", new Date(wakeAt).toISOString(), { description: "Rank check", command: "tail -f x" }, { taskId: "mon-1" })
    + call("CronCreate", "cron", new Date(wakeAt).toISOString(), { prompt: "daily", cron: "0 9 * * *" }, { id: "cron-1" }));
  f.desktop.list();
  f.live();
  // The turn that scheduled it still runs: its prompt waits for that turn, so it has not fired.
  assert.deepEqual(f.desktop.backgroundTaskList(id).map(task => task.id), ["dynamic-wakeup", "mon-1", "cron-1"]);
  const at = (ms: number) => new Date(wakeAt + ms).toISOString();
  const end = (when: string, hook = true) => line({ type: "assistant", timestamp: when, message: { id: `m-${when}`, model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } })
    + (hook ? line({ type: "system", subtype: "stop_hook_summary", timestamp: when }) : "");
  fs.appendFileSync(file, end(at(0)));
  assert.ok(f.desktop.backgroundTaskList(id).some(task => task.id === "dynamic-wakeup"), "that turn began before the wakeup was due; its prompt has not run");
  // The wakeup's prompt runs as the next turn; until its Stop hook reports, the turn may go on.
  fs.appendFileSync(file, line({ type: "user", timestamp: at(1000), message: { content: "check" } }) + end(at(2000), false));
  assert.ok(f.desktop.backgroundTaskList(id).some(task => task.id === "dynamic-wakeup"));
  fs.appendFileSync(file, line({ type: "system", subtype: "stop_hook_summary", timestamp: at(2000) }));
  assert.deepEqual(f.desktop.backgroundTaskList(id).map(task => task.id), ["mon-1", "cron-1"], "the fired wakeup left; the live process may still run the rest");
  // A later turn does not bring it back.
  fs.appendFileSync(file, line({ type: "user", timestamp: at(3000), origin: { kind: "human" }, message: { content: "Next" } }));
  assert.deepEqual(f.desktop.backgroundTaskList(id).map(task => task.id), ["mon-1", "cron-1"]);
  assert.deepEqual(f.desktop.backgroundTaskHistory(id).map(task => [task.id, task.state]), [["dynamic-wakeup", "done"]]);
  f.registry.delete(id);
  assert.deepEqual(f.desktop.backgroundTaskList(id).map(task => task.id), ["cron-1"], "a durable schedule outlives its process");
  // With the process gone, nothing says the wakeup fired: its outcome is unknown, however late it is.
  assert.deepEqual(f.desktop.backgroundTaskHistory(id).map(task => [task.id, task.state]), [["mon-1", "unknown"], ["dynamic-wakeup", "unknown"]]);
});
