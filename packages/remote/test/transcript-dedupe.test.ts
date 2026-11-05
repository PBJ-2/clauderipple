import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sessions } from "../src/sessions.ts";
import { BridgeClient } from "../src/bridge-client.ts";
import { PermissionQueue } from "../src/permissions.ts";
import { EventLog } from "../src/eventlog.ts";
import type { DesktopProcess } from "../src/desktop.ts";
import { transcriptEvents, type SubagentState } from "../src/desktop.ts";

// Claude Desktop's Remote Control re-appends an already written block of the transcript, under the
// same uuids, right after a bridge-session line when it reconnects (issue #126). The host must not
// turn those copies into new events, must remember that across a restart, and must keep emitting
// lines that have no uuid or whose content really changed.

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const line = (value: unknown): string => JSON.stringify(value) + "\n";
const user = { type: "user", uuid: "u1", cwd: "/synthetic/project", timestamp: "2026-11-05T01:00:00Z", message: { content: "first prompt" } };
const assistant = { type: "assistant", uuid: "a1", timestamp: "2026-11-05T01:00:01Z", message: { id: "m1", model: "model", content: [{ type: "text", text: "answer" }] } };
const router = { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } };

function fixture(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-dedupe-"));
  const projects = path.join(root, "projects");
  fs.mkdirSync(path.join(projects, "project"), { recursive: true });
  const file = path.join(projects, "project", `${id}.jsonl`);
  fs.writeFileSync(file, line(user) + line(assistant));
  const registry = new Map<string, DesktopProcess>([[id, { sessionId: id, pid: 42, status: "idle", bridgeSessionId: "bridge" }]]);
  const posts: Record<string, unknown>[] = [];
  const now = Date.now();
  const host = () => {
    const client = new BridgeClient({ auth: () => ({ accessToken: "token", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
      if (options?.method === "POST") { posts.push(JSON.parse(String(options.body))); return new Response("{}", { status: 200 }); }
      if (/\/sessions\/[^/]+$/.test(String(url))) return Response.json({ worker_status: "idle" });
      if (String(url).includes("/events?sort_order=")) return Response.json({ data: [] });
      return new Response(new ReadableStream<Uint8Array>({ start(c) { options?.signal?.addEventListener("abort", () => { try { c.close(); } catch { /* already closed */ } }, { once: true }); } }));
    } });
    return new Sessions({ dir: path.join(root, "host"), now: () => now, desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "", bridgeClient: client,
      permissions: PermissionQueue.open(path.join(root, "permissions.json")), router, queryFn: () => { throw new Error("must not spawn the SDK"); }, onEvent() {}, onSessions() {} });
  };
  const hosts: Sessions[] = [];
  t.after(async () => {
    for (const sessions of hosts.splice(0)) sessions.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    file, registry, posts,
    open: () => { const sessions = host(); hosts.push(sessions); return sessions; },
    close: (sessions: Sessions) => { const i = hosts.indexOf(sessions); if (i >= 0) hosts.splice(i, 1); sessions.shutdown(); },
    events: (sessions: Sessions) => sessions.log(id).readAfter(0, 1 << 20).events,
  };
}

test("a re-appended block after a bridge-session line emits no duplicate events", async t => {
  const f = fixture(t);
  const sessions = f.open();
  sessions.log(id); // import the conversation as a Remote Control record
  assert.deepEqual(f.events(sessions).filter(e => e.kind === "user" || e.kind === "assistant").map(e => e.kind), ["user", "assistant"]);
  // The copies carry the same uuids but the bookkeeping the app rewrites, which must not matter.
  fs.appendFileSync(f.file,
    line({ type: "bridge-session" }) +
    line({ ...user, cwd: "/moved/project", slug: "moved", toolUseResult: { stdout: "" } }) +
    line({ ...assistant, cwd: "/moved/project", slug: "moved" }) +
    line({ type: "assistant", uuid: "a2", message: { id: "m2", model: "model", content: [{ type: "text", text: "new answer" }] } }));
  await sessions.pollDesktop();
  const events = f.events(sessions);
  assert.deepEqual(events.filter(e => e.kind === "assistant").map(e => e.kind === "assistant" && e.msg), ["a1", "a2"]);
  assert.equal(events.filter(e => e.kind === "user").length, 1, "the copied prompt is not shown twice");
});

test("the dedupe survives a host restart", async t => {
  const f = fixture(t);
  const first = f.open();
  first.log(id);
  f.close(first);
  // The reconnect happens while no host is tailing: the copies sit after the saved offset.
  fs.appendFileSync(f.file, line({ type: "bridge-session" }) + line(user) + line(assistant) +
    line({ type: "assistant", uuid: "a2", message: { id: "m2", model: "model", content: [{ type: "text", text: "appended while down" }] } }));
  const second = f.open();
  await second.pollDesktop();
  const events = f.events(second);
  assert.deepEqual(events.filter(e => e.kind === "assistant").map(e => e.kind === "assistant" && e.msg), ["a1", "a2"]);
  assert.equal(events.filter(e => e.kind === "user").length, 1);
});

test("an import of a transcript that already holds a re-appended block emits each line once", async t => {
  const f = fixture(t);
  fs.appendFileSync(f.file, line({ type: "bridge-session" }) + line({ ...user, cwd: "/moved/project" }) + line({ ...assistant, cwd: "/moved/project" }));
  const sessions = f.open();
  sessions.log(id);
  const events = f.events(sessions);
  assert.deepEqual(events.filter(e => e.kind === "assistant").map(e => e.kind === "assistant" && e.msg), ["a1"]);
  assert.equal(events.filter(e => e.kind === "user").length, 1);
});

test("lines without a uuid keep today's behaviour", async t => {
  const f = fixture(t);
  const sessions = f.open();
  sessions.log(id);
  fs.appendFileSync(f.file,
    line({ type: "bridge-session" }) +
    line({ type: "result", subtype: "success", duration_ms: 5, num_turns: 1 }) +
    line({ type: "result", subtype: "success", duration_ms: 6, num_turns: 1 }));
  await sessions.pollDesktop();
  assert.deepEqual(f.events(sessions).filter(e => e.kind === "result").map(e => e.kind === "result" && e.ms), [5, 6]);
});

test("a line rewritten under the same uuid with a different message still emits, and its copy does not", async t => {
  const f = fixture(t);
  const sessions = f.open();
  sessions.log(id);
  const rewritten = { ...assistant, message: { ...assistant.message, content: [{ type: "text", text: "streamed answer" }] } };
  fs.appendFileSync(f.file, line(rewritten));
  await sessions.pollDesktop();
  fs.appendFileSync(f.file, line(rewritten)); // the same rewrite appended again is a copy
  await sessions.pollDesktop();
  const assistants = f.events(sessions).filter(e => e.kind === "assistant");
  assert.deepEqual(assistants.map(e => e.kind === "assistant" && (typeof e.text === "string" ? e.text : "")), ["answer", "streamed answer"]);
});

test("a prompt sent from the phone is not shown again when the app re-appends its echo", async t => {
  const f = fixture(t);
  const sessions = f.open();
  sessions.log(id);
  await sessions.send(id, "phone-1", "hello from the phone");
  const uuid = (f.posts[0] as { events: { payload: { uuid: string } }[] }).events[0]!.payload.uuid;
  const echo = line({ type: "user", uuid, message: { content: "hello from the phone" } });
  fs.appendFileSync(f.file, echo);
  await sessions.pollDesktop();
  fs.appendFileSync(f.file, line({ type: "bridge-session" }) + echo);
  await sessions.pollDesktop();
  const users = f.events(sessions).filter(e => e.kind === "user");
  assert.equal(users.filter(e => e.kind === "user" && e.clientMsgId === "phone-1").length, 1, "the phone's own message stays a single item");
  assert.equal(users.some(e => e.kind === "user" && e.clientMsgId === uuid), false, "the transcript echo never becomes a second message");
});

test("both versions of one line replayed after a reconnect are copies, and a newer version still emits", async t => {
  const f = fixture(t);
  const sessions = f.open();
  sessions.log(id);
  const partial = { type: "assistant", uuid: "a3", timestamp: "2026-11-05T01:00:02Z", message: { id: "m3", model: "model", content: [{ type: "text", text: "half an answer" }] } };
  const completed = { ...partial, message: { ...partial.message, content: [{ type: "text", text: "half an answer, finished" }] } };
  fs.appendFileSync(f.file, line(partial) + line(completed));
  await sessions.pollDesktop();
  // A reconnect re-appends the same block: both versions were emitted once and neither is new.
  fs.appendFileSync(f.file, line({ type: "bridge-session" }) + line(partial) + line(completed));
  await sessions.pollDesktop();
  const texts = () => f.events(sessions).filter(e => e.kind === "assistant" && e.msg === "a3").map(e => e.kind === "assistant" ? e.text : "");
  assert.deepEqual(texts(), ["half an answer", "half an answer, finished"]);
  // A third version under that uuid is a real rewrite and is emitted.
  fs.appendFileSync(f.file, line({ ...partial, message: { ...partial.message, content: [{ type: "text", text: "the whole answer" }] } }));
  await sessions.pollDesktop();
  assert.deepEqual(texts(), ["half an answer", "half an answer, finished", "the whole answer"]);
});

test("a line is marked seen only by its last event, so a crash between them re-emits it", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eventlog-partial-line-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const uuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  // One assistant line contributing two events: a thinking block and then the answer text.
  const converted = line({ type: "assistant", uuid, timestamp: "2026-11-05T01:00:01Z", message: { id: "m1", model: "model", content: [{ type: "thinking", thinking: "pondering" }, { type: "text", text: "answer" }] } });
  const convert = (log: EventLog) => transcriptEvents(converted, "/synthetic/project", () => "", undefined, undefined, (src, hash) => log.lineSeen(src, hash));
  const first = EventLog.open({ dir });
  const bodies = convert(first).bodies;
  assert.deepEqual(bodies.map(body => body.kind), ["thinking", "assistant"]);
  assert.equal(bodies[0]!.src, undefined, "an earlier event must not mark the line seen");
  assert.equal(bodies[1]!.src, uuid);
  // The host stops after writing the first event; the rest of the line never reached the log.
  first.append(bodies[0]!);
  first.close();
  const reopened = EventLog.open({ dir });
  t.after(() => reopened.close());
  const replay = convert(reopened);
  assert.deepEqual(replay.bodies.map(body => body.kind), ["thinking", "assistant"], "the unfinished line is converted again");
  assert.ok(replay.srcHash !== undefined);
  assert.equal(reopened.lineSeen(uuid, replay.srcHash), false, "the line stays unseen until all of it is written");
  for (const body of replay.bodies) reopened.append(body);
  assert.equal(reopened.lineSeen(uuid, replay.srcHash), true, "writing the last event marks the line so a copy emits nothing");
});

test("a re-appended worker launch line does not disturb the running worker", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eventlog-seen-worker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = EventLog.open({ dir });
  t.after(() => log.close());
  const resolve = () => ({ model: "worker-model", steps: 2, description: "worker", terminal: null });
  const seen = (src: string, hash: number) => log.lineSeen(src, hash);
  const state = new Map<string, SubagentState>();
  const convert = (value: string) => transcriptEvents(value, "/synthetic/project", () => "", undefined, { state, resolve }, seen);
  const launch = line({ type: "assistant", uuid: "tool-line", timestamp: "2026-11-05T01:00:02Z", message: { id: "m2", model: "model", content: [
    { type: "tool_use", id: "worker-1", name: "Agent", input: { description: "worker", prompt: "go" } },
  ] } });
  for (const body of convert(launch).bodies) log.append(body);
  assert.deepEqual([...state.keys()], ["worker-1"]);
  // The result says the worker runs in the background under this task id; it is not done yet.
  const result = line({ type: "user", uuid: "result-line", timestamp: "2026-11-05T01:00:03Z", message: { content: [{ type: "tool_result", tool_use_id: "worker-1", content: "launched asynchronously" }] }, toolUseResult: { isAsync: true, agentId: "task-1" } });
  for (const body of convert(result).bodies) log.append(body);
  assert.equal(state.get("worker-1")?.taskId, "task-1");
  // A reconnect re-appends the launch line. Converting it again would replace the running worker
  // with a fresh entry and lose the task id its completion is matched by.
  const replay = transcriptEvents(launch, "/synthetic/project", () => "", () => { throw new Error("a copy must not write a blob"); }, { state, resolve }, seen);
  assert.deepEqual(replay.bodies, []);
  assert.equal(state.get("worker-1")?.taskId, "task-1", "the running worker keeps the task id");
  const notification = line({ type: "user", uuid: "notify-line", timestamp: "2026-11-05T01:00:04Z", message: { content: "<task-notification><task-id>task-1</task-id><status>completed</status><result>done</result></task-notification>" } });
  const final = convert(notification);
  assert.deepEqual(final.bodies.filter(body => body.kind === "subagent").map(body => body.kind === "subagent" && [body.toolUseId, body.status]), [["worker-1", "done"]], "the completion still finds its worker by task id, once");
});

test("a re-appended worker launch line does not drop the task id the restart seed recovered", async t => {
  const f = fixture(t);
  const launch = { type: "assistant", uuid: "launch", timestamp: "2026-11-05T01:00:02Z", message: { id: "lm", model: "model", content: [
    { type: "tool_use", id: "worker-1", name: "Agent", input: { description: "worker", prompt: "go" } },
  ] } };
  const launched = { type: "user", uuid: "launched", timestamp: "2026-11-05T01:00:03Z", toolUseResult: { isAsync: true, agentId: "task-1" },
    message: { content: [{ type: "tool_result", tool_use_id: "worker-1", content: "launched asynchronously" }] } };
  fs.writeFileSync(f.file, line(user) + line(launch) + line(launched));
  const first = f.open();
  first.log(id); // the host imports the conversation and starts tailing at its end
  // Remote Control reconnects while the host runs: the tail skips the copy, but the saved offset
  // moves past it, so a restart's seed scan finds it inside the span it rebuilds from.
  fs.appendFileSync(f.file, line({ ...launch, cwd: "/moved/project", slug: "moved" }));
  await first.pollDesktop();
  f.close(first);
  // A completion arrives after the restart: the seed must still know the worker's task id.
  fs.appendFileSync(f.file, line({ type: "user", uuid: "notify", timestamp: "2026-11-05T01:00:04Z",
    message: { content: "<task-notification><task-id>task-1</task-id><status>completed</status><result>done</result></task-notification>" } }));
  const second = f.open();
  await second.pollDesktop();
  const done = () => f.events(second).filter(e => e.kind === "subagent" && e.toolUseId === "worker-1" && e.status === "done");
  assert.equal(done().length, 1, "the completion finds its worker by the task id");
  await second.pollDesktop();
  assert.equal(done().length, 1, "the completion is emitted once");
});

test("a re-appended older prompt does not start a turn or clear the running plan", async t => {
  const f = fixture(t);
  const older = { type: "user", uuid: "older", cwd: "/synthetic/project", timestamp: "2026-11-05T01:00:00Z", origin: { kind: "human" }, message: { content: "earlier prompt" } };
  const current = { type: "user", uuid: "current", cwd: "/synthetic/project", timestamp: "2026-11-05T02:00:00Z", origin: { kind: "human" }, message: { content: "the prompt in progress" } };
  const planCall = { type: "assistant", uuid: "plan-call", timestamp: "2026-11-05T02:00:01Z", message: { id: "pm", model: "model", content: [
    { type: "tool_use", id: "plan-1", name: "mcp__ccd_turn__update_plan", input: { scope: "first_task", items: [
      { content: "Read the code", status: "in_progress" },
      { content: "Fix it", status: "pending" },
    ] } },
  ] } };
  const planResult = { type: "user", uuid: "plan-result", timestamp: "2026-11-05T02:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "plan-1", content: "Plan shown" }] } };
  fs.writeFileSync(f.file, line(older) + line(current) + line(planCall) + line(planResult));
  f.registry.get(id)!.status = "busy"; // a working turn is when its start is shown
  const sessions = f.open();
  sessions.log(id);
  await sessions.pollDesktop();
  const running = sessions.summaryOf(id)!;
  assert.deepEqual(running.plan, [{ text: "Read the code", status: "in_progress" }, { text: "Fix it", status: "pending" }]);
  assert.equal(running.turnStartedAt, Date.parse("2026-11-05T02:00:00Z"));
  // The reconnect re-appends the older prompt under its old uuid, with only bookkeeping changed.
  fs.appendFileSync(f.file, line({ ...older, cwd: "/moved/project", slug: "moved" }));
  await sessions.pollDesktop();
  const after = sessions.summaryOf(id)!;
  assert.deepEqual(after.plan, running.plan, "the per-turn plan survives the copy");
  assert.equal(after.turnStartedAt, running.turnStartedAt, "the turn start does not move back to the copied line");
});

test("the transcript line record is bounded and rebuilt from the log on open", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eventlog-lines-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = EventLog.open({ dir, lineCap: 3 });
  for (const src of ["a", "b", "c", "d"]) log.append({ kind: "result", ok: true, ms: 1, turns: 1, src, srcHash: 1 });
  assert.equal(log.lineSeen("a", 1), false, "the oldest line is evicted");
  assert.equal(log.lineSeen("d", 1), true);
  // A different fingerprint is a changed line, not a copy.
  assert.equal(log.lineSeen("d", 2), false);
  log.append({ kind: "result", ok: true, ms: 1, turns: 1, src: "d", srcHash: 2 });
  assert.equal(log.lineSeen("d", 2), true);
  assert.equal(log.lineSeen("d", 1), true, "every version already emitted is a copy when replayed");
  assert.equal(log.lineSeen("d", 3), false);
  log.close();
  t.after(() => { try { log.close(); } catch { /* already closed */ } });
  const reopened = EventLog.open({ dir, lineCap: 3 });
  t.after(() => reopened.close());
  assert.equal(reopened.lineSeen("d", 2), true, "the record comes back from the events on disk");
  assert.equal(reopened.lineSeen("b", 1), true);
  assert.equal(reopened.lineSeen("a", 1), false);
});
