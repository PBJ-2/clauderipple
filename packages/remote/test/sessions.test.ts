import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay, setImmediate as nextTick } from "node:timers/promises";
import { PermissionQueue } from "../src/permissions.ts";
import { MessageReceipts } from "../src/receipts.ts";
import { reduce, timelineItems } from "../web/timeline.ts";
import { sessionGroup, sidebarState } from "../web/sidebar.ts";
import { INLINE_CAP } from "../src/protocol.ts";
import type { Effort, SessionEvent } from "../src/protocol.ts";
import { Sessions, modelArg, nextAttention, summarize } from "../src/sessions.ts";
import { BridgeClient, CLI_NOT_LOGGED_IN, DESKTOP_BUSY, DESKTOP_WAITING, DesktopBlockedError } from "../src/bridge-client.ts";
import { transcriptEvents, type DesktopProcess, type SubagentState } from "../src/desktop.ts";
import type { CanUseTool, PermissionAnswer, QueryFn, SdkUserMessage, SessionsOptions } from "../src/sessions.ts";
import { posixPaths } from "../../../test/capabilities.ts";
import { claudeAppData } from "./app-data.ts";
import { signatureOf } from "./narration-signature.ts";

// Limits for a stalled test, not for a slow one: a passing test never waits them out. 4.5 s and 2 s
// ran out on a loaded Windows CI runner while the host was still answering (2026-10-29, #98).
const TEST_TIMEOUT = 15_000;
const WAIT_LIMIT = 10_000;

// Limits for a stalled test, not for a slow one: a passing test never waits them out. 4.5 s and 2 s
// ran out on a loaded Windows CI runner while the host was still answering (2026-10-29, #98).
const TEST_TIMEOUT = 15_000;
const WAIT_LIMIT = 10_000;

const router = {
  status: async () => ({ ok: true, proxyEnv: { HTTPS_PROXY: "http://127.0.0.1:1" } }),
  figures: async () => ({ effort: null, cachePct: null, contextPct: null, fiveHourPct: null, fiveHourResetAt: null, workers: [], at: Date.now() }),
  models: async () => [],
} satisfies SessionsOptions["router"] & { models: () => Promise<never[]> };

function scriptedQuery(script: { permission?: boolean; toolOutput?: unknown; images?: boolean; thinking?: boolean; narration?: boolean; sendFile?: string; failure?: { text: string; as: "result" | "throw" } } = {}, sdkId = "sdk-1") {
  const options: Record<string, unknown>[] = [];
  const users: SdkUserMessage[] = [];
  const answers: PermissionAnswer[] = [];
  const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "session" }];
  const spies = { modeError: null as Error | null, setPermissionMode: [] as import('../src/protocol.ts').PermissionMode[], interrupt: 0, setModel: [] as (string | undefined)[], close: 0 };
  const queryFn: QueryFn = params => {
    options.push(params.options);
    return {
      async *[Symbol.asyncIterator]() {
        let turn = 0;
        for await (const user of params.prompt) {
          users.push(user);
          if (turn++ === 0) yield { type: "system", subtype: "init", session_id: sdkId };
          const id = `m${turn}`;
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id } } };
          if (script.thinking) {
            // Two streamed indices, each finalized by an SDK message with local index zero.
            for (const index of [2, 4]) {
              const signature = script.narration && index === 4 ? signatureOf("narration") : "private signature";
              yield { type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "thinking" } } };
              yield { type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: `thought ${index}` } } };
              yield { type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "signature_delta", signature } } };
              yield { type: "assistant", message: { id, model: "x", content: [{ type: "thinking", thinking: `thought ${index} complete`, signature }] } };
            }
          }
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "po" } } };
          if (script.permission) {
            const fn = params.options.canUseTool;
            const abort = params.options.abortController;
            assert.equal(typeof fn, "function");
            assert.ok(abort instanceof AbortController);
            answers.push(await (fn as CanUseTool)("Bash", { command: "ls" }, { signal: abort.signal, suggestions, suppressAlwaysAllowRule: false }));
          }
          if (script.toolOutput !== undefined) {
            yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: script.toolOutput, is_error: false }] } };
          }
          const image = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("sdk image").toString("base64") } };
          if (script.images) yield { type: "user", uuid: "sdk-image-user", message: { content: [image] } };
          yield { type: "assistant", parent_tool_use_id: null, message: { id, model: "x", content: [{ type: "text", text: "pong" }, ...(script.images ? [image] : []), ...(script.sendFile ? [{ type: "tool_use", id: "suf-1", name: "SendUserFile", input: { files: [script.sendFile], caption: "shot", status: "normal" } }] : [])] } };
          if (script.failure?.as === "throw") throw new Error(script.failure.text);
          if (script.failure?.as === "result") {
            yield { type: "result", subtype: "error", is_error: true, result: script.failure.text, duration_ms: 1, num_turns: 0 };
            return;
          }
          yield { type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, modelUsage: { x: { contextWindow: 1000 } } };
        }
      },
      interrupt: async () => { spies.interrupt++; },
      setModel: async model => { spies.setModel.push(model); },
      setPermissionMode: async mode => { if (spies.modeError) throw spies.modeError; spies.setPermissionMode.push(mode); },
      close: () => { spies.close++; },
    };
  };
  return { queryFn, options, users, answers, suggestions, spies };
}

/** A query boundary whose input reading, result delivery and control replies are independent. */
function controlledQueries(readInputs = true, waitForExit = false) {
  const queries: { options: Record<string, unknown>; users: SdkUserMessage[]; emit: (event: Record<string, unknown>) => void; closed: boolean; exitReply: ReturnType<typeof Promise.withResolvers<void>>; interruptReply: ReturnType<typeof Promise.withResolvers<void>>; modeReply: ReturnType<typeof Promise.withResolvers<void>> | null; modes: string[] }[] = [];
  const queryFn: QueryFn = params => {
    let wake = Promise.withResolvers<void>();
    const events: Record<string, unknown>[] = [];
    const control = { options: params.options, users: [] as SdkUserMessage[], closed: false, exitReply: Promise.withResolvers<void>(),
      interruptReply: Promise.withResolvers<void>(), modeReply: null as ReturnType<typeof Promise.withResolvers<void>> | null, modes: [] as string[],
      emit: (event: Record<string, unknown>) => { events.push(event); wake.resolve(); },
    };
    queries.push(control);
    if (readInputs || queries.length > 1) void (async () => { for await (const user of params.prompt) control.users.push(user); })();
    return {
      async *[Symbol.asyncIterator]() {
        while (!control.closed) {
          const event = events.shift();
          if (event) { yield event; continue; }
          await wake.promise;
          wake = Promise.withResolvers<void>();
        }
      },
      ...(waitForExit ? { processExited: control.exitReply.promise } : {}),
      interrupt: () => control.interruptReply.promise,
      setModel: async () => {},
      setPermissionMode: async mode => { control.modes.push(mode); await control.modeReply?.promise; },
      close: () => { control.closed = true; wake.resolve(); },
    };
  };
  return { queryFn, queries };
}

function fixture(t: TestContext, script: Parameters<typeof scriptedQuery>[0] = {}, extra: Partial<Pick<SessionsOptions, "handoff" | "log" | "queryFn" | "desktopProjects" | "desktopRegistry" | "desktopProcesses" | "bridgeClient" | "desktopSidebar" | "now" | "onSessions" | "environmentRoot" | "environmentWaitMs" | "environmentPollMs" | "environmentModeMs" | "modOfferMs" | "modResultMs">> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-sessions-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const permissionsFile = path.join(dir, "permissions.json");
  const permissions = PermissionQueue.open(permissionsFile);
  const fake = scriptedQuery(script);
  const events: { session: string; event: SessionEvent }[] = [];
  const sessions = new Sessions({ dir, router, permissions, queryFn: fake.queryFn, coalesceMs: 5, ...extra,
    onEvent: (session, event) => events.push({ session, event }), onSessions: extra.onSessions ?? (() => {}),
  });
  const instances = [sessions];
  t.after(async () => {
    // Let aborted permission/iterator continuations finish before closing their logs.
    for (const instance of instances) for (const session of instance.list()) instance.stop(session.id);
    await nextTick();
    for (const instance of instances) instance.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const create = (clientMsgId = "create-1", model = "claude-test", effort: Effort | null = "high") =>
    sessions.create({ clientMsgId, cwd, model, effort, text: "ping" });
  return { dir, cwd, permissionsFile, permissions, fake, sessions, instances, events, create };
}

test("clear after handoff retains the stored restrictive choice despite an unknown app mode", async t => {
  for (const mode of ["plan", "default"] as const) {
    let calls = 0;
    const f = fixture(t, {}, { handoff: async () => { calls++; return "opened"; }, log() {} });
    const id = await f.sessions.create({ clientMsgId: "restrictive", cwd: f.cwd, model: "claude-test", effort: "high", text: "ping", permissionMode: mode });
    await waitFor(() => calls === 1);
    assert.equal(f.sessions.summaryOf(id)?.permissionMode, undefined);
    for (const command of ["/clear", "/new"]) {
      const fresh = await f.sessions.send(id, command, command);
      assert.equal(f.sessions.summaryOf(fresh)?.permissionMode, mode);
      await f.sessions.send(fresh, `first-${command}`, "continue");
      await waitFor(() => f.fake.options.length === (command === "/clear" ? 2 : 3));
      assert.equal(f.fake.options.at(-1)?.permissionMode, mode);
      assert.equal(f.fake.options.at(-1)?.allowDangerouslySkipPermissions, undefined);
    }
  }
});

function launchBackground(query: ReturnType<typeof controlledQueries>["queries"][number]): void {
  query.emit({ type: "system", subtype: "init", session_id: "sdk-background" });
  query.emit({ type: "assistant", message: { id: "launch", content: [{ type: "tool_use", id: "agent", name: "Agent", input: { description: "Review" } }] } });
  query.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent", content: '{"isAsync":true,"agentId":"worker"}' }] } });
  query.emit({ type: "result", subtype: "success" });
}

test("a dead previous SDK worker cannot block recovered handoff", async t => {
  const boundary = controlledQueries();
  let calls = 0;
  const handoff: NonNullable<SessionsOptions["handoff"]> = async () => { calls++; return "opened"; };
  const f = fixture(t, {}, { queryFn: boundary.queryFn, handoff, log() {} });
  const id = await f.create(); await waitFor(() => boundary.queries.length === 1);
  launchBackground(boundary.queries[0]!);
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(f.sessions.summaryOf(id)?.tasks, 1);
  assert.equal(calls, 0);
  f.sessions.shutdown();
  const recovered = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: boundary.queryFn, handoff, log() {}, onEvent() {}, onSessions() {} });
  f.instances.push(recovered); recovered.recover();
  assert.equal(recovered.summaryOf(id)?.tasks, 0);
  await recovered.pollDesktop(); await waitFor(() => calls === 1);
});

for (const model of ["claude-test", "claude-next"]) for (const completion of ["inventory", "notification"] as const) test(`deferred ${model} settings stay honest until background ${completion} permits restart`, async t => {
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  const id = await f.create(); await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  launchBackground(query);
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const result = await f.sessions.setModel(id, model, "max", "deferred-pick");
  assert.deepEqual(result, { status: "partial", model: "claude-test", effort: "high", pending: { model, effort: "max" } });
  assert.equal(f.sessions.summaryOf(id)?.model, "claude-test");
  assert.equal(f.sessions.summaryOf(id)?.effort, "high");
  assert.deepEqual(f.sessions.summaryOf(id)?.pendingSettings, { model, effort: "max" });
  const settingsEvent = f.sessions.log(id).tail().events.find(event => event.kind === "settings" && event.reqId === "deferred-pick");
  assert.ok(settingsEvent?.kind === "settings");
  assert.equal(settingsEvent.status, "partial");
  assert.deepEqual(settingsEvent.pending, { model, effort: "max" });
  await f.sessions.send(id, "during-pending", "keep working");
  await waitFor(() => query.users.length === 2);
  assert.equal(query.closed, false, "do not kill a genuinely running worker");
  assert.equal(query.options.effort, "high");
  const turn = f.sessions.log(id).tail().events.filter(event => event.kind === "turn").at(-1);
  assert.equal(turn?.effort, "high");
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  if (completion === "inventory") {
    const hooks = query.options.hooks as { Stop: { hooks: ((input: Record<string, unknown>) => Promise<unknown>)[] }[] };
    await hooks.Stop[0]!.hooks[0]!({ background_tasks: [], session_crons: [] });
  } else query.emit({ type: "user", message: { content: "<task-notification><task-id>worker</task-id><status>completed</status></task-notification>" } });
  await waitFor(() => query.closed);
  assert.equal(f.sessions.summaryOf(id)?.tasks, 0);
  assert.equal(f.sessions.summaryOf(id)?.pendingSettings, undefined);
  await f.sessions.send(id, "after-pending", "use max now");
  await waitFor(() => boundary.queries.length === 2);
  assert.equal(boundary.queries[1]!.options.model, model);
  assert.equal(boundary.queries[1]!.options.effort, "max");
});

test("all combined desktop terminal notifications close their own worker cards", () => {
  const state = new Map<string, SubagentState>();
  const resolve = () => ({ model: "test", steps: 1, description: "worker", terminal: null });
  const convert = (value: unknown) => transcriptEvents(JSON.stringify(value), "/isolated", () => "worker", undefined, { state, resolve });
  for (const id of ["one", "two"]) {
    convert({ type: "assistant", message: { content: [{ type: "tool_use", id: `tool-${id}`, name: "Agent", input: {} }] } });
    convert({ type: "user", toolUseResult: { isAsync: true, agentId: id }, message: { content: [{ type: "tool_result", tool_use_id: `tool-${id}`, content: "async launched" }] } });
  }
  const content = ["one", "two"].map(id => `<task-notification><task-id>${id}</task-id><status>stopped</status><result>${id} stopped</result></task-notification>`).join("\n");
  const result = convert({ type: "user", isMeta: true, message: { content } });
  assert.equal(state.size, 0);
  assert.deepEqual(result.bodies.filter(event => event.kind === "subagent").map(event => [event.toolUseId, event.status]), [["tool-one", "stopped"], ["tool-two", "stopped"]]);
  assert.deepEqual(result.bodies.filter(event => event.kind === "tool_result").map(event => event.text), ["one stopped", "two stopped"]);
});

test("an async SDK launch stays active until its own terminal notification, with stopped separate from failure", async t => {
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  const id = await f.create(); await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  query.emit({ type: "assistant", message: { id: "launch", model: "sol", content: [{ type: "tool_use", id: "agent", name: "Agent", input: { description: "Review" } }] } });
  query.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent", content: '{"isAsync":true,"agentId":"async-agent"}' }] } });
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(f.sessions.summaryOf(id)?.tasks, 1);
  assert.equal(reduce(f.sessions.log(id).readAfter(0).events).items.find(item => item.type === "subagent")?.status, "running");
  query.emit({ type: "user", message: { content: "<task-notification><task-id>async-agent</task-id><tool-use-id>agent</tool-use-id><status>killed</status></task-notification>" } });
  await waitFor(() => f.sessions.summaryOf(id)?.taskHistory?.[0]?.state === "stopped");
  assert.equal(f.sessions.summaryOf(id)?.tasks, 0);
  assert.equal(reduce(f.sessions.log(id).readAfter(0).events).items.find(item => item.type === "subagent")?.status, "stopped");
});

test("SDK Stop inventory exposes pending PR/CI subscriptions, monitors and scheduled wakeups in the session snapshot", async t => {
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  const hooks = query.options.hooks as { Stop: { hooks: ((input: Record<string, unknown>) => Promise<unknown>)[] }[] };
  await hooks.Stop[0]!.hooks[0]!({ background_tasks: [{ id: "ci", type: "pr_ci_subscription", status: "pending", description: "PR #3 CI subscription" }, { id: "monitor", type: "monitor", status: "running", description: "Build watch" }], session_crons: [{ id: "scheduled", schedule: "0 9 * * *", prompt: "Check CI", recurring: true }] });
  const summary = f.sessions.summaryOf(id)!;
  assert.equal(summary.backgroundKnown, true);
  assert.equal(summary.tasks, 3);
  assert.equal(summary.taskList?.find(task => task.id === "ci")?.kind, "subscription");
  assert.equal(summary.taskList?.find(task => task.id === "scheduled")?.schedule, "0 9 * * *");
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(f.sessions.summaryOf(id)?.tasks, 3, "a main result does not discard waiting subscriptions");
  assert.ok(f.sessions.log(id).readAfter(0).events.some(event => event.kind === "background"));
});

test("SDK task snapshots normalize confirmed tools, survive turn completion and rebuild after restart", async t => {
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  const tool = (call: string, name: string, input: Record<string, unknown>, text: string) => {
    query.emit({ type: "assistant", message: { id: call, model: "sol", content: [{ type: "tool_use", id: call, name, input }] } });
    query.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: call, content: text }] } });
  };
  tool("create", "TaskCreate", { subject: "First\nexact subject" }, "Task #1 created successfully: First");
  tool("start", "TaskUpdate", { taskId: "1", status: "in_progress" }, "Updated task #1 status");
  await waitFor(() => f.sessions.summaryOf(id)?.plan?.[0]?.status === "in_progress");
  tool("done", "TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status");
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const expected = [{ id: "1", text: "First\nexact subject", status: "completed" }];
  assert.deepEqual(f.sessions.summaryOf(id)?.plan, expected);
  f.sessions.stop(id); await nextTick();
  const recovered = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: boundary.queryFn, onEvent() {}, onSessions() {} });
  f.instances.push(recovered);
  assert.deepEqual(recovered.summaryOf(id)?.plan, expected);
});

test("nested SDK workers publish launch, progress and terminal status only in their parent's log", async t => {
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  const launch = (parent: string | null, worker: string) => query.emit({ type: "assistant", parent_tool_use_id: parent, message: { id: `launch-${worker}`, model: "sol", content: [{ type: "tool_use", id: worker, name: "Agent", input: { description: worker, prompt: `${worker} exact instruction\nsecond line` } }] } });
  launch(null, "parent"); launch("parent", "child"); launch("child", "grandchild");
  query.emit({ type: "assistant", parent_tool_use_id: "grandchild", message: { id: "answer", model: "sol", content: [{ type: "text", text: "Exact answer" }] } });
  const finish = (parent: string | null, tool: string, failed = false) => query.emit({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: tool, is_error: failed, content: "result" }] } });
  finish("child", "grandchild", true); finish("parent", "child"); finish(null, "parent");
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const main = reduce(f.sessions.log(id).readAfter(0, 1 << 20).events);
  const parent = reduce(f.sessions.subLog(id, "sub-parent")!.readAfter(0, 1 << 20).events);
  const child = reduce(f.sessions.subLog(id, "sub-child")!.readAfter(0, 1 << 20).events);
  const workerStates = (view: ReturnType<typeof reduce>) => view.items.filter(i => i.type === "subagent").map(i => [i.sub, i.status, i.model, i.steps]);
  assert.deepEqual(workerStates(main), [["sub-parent", "done", "sol", 1]]);
  assert.deepEqual(workerStates(parent), [["sub-child", "done", "sol", 1]]);
  assert.deepEqual(workerStates(child), [["sub-grandchild", "failed", "sol", 1]]);
  assert.equal(parent.items.find(i => i.type === "assistant")?.tools[0]?.input, JSON.stringify({ description: "child", prompt: "child exact instruction\nsecond line" }, null, 2));
  assert.equal(f.sessions.subLog(id, "sub-grandchild")!.readAfter(0).events.find(e => e.kind === "assistant")?.text, "Exact answer");
  const exact = "긴 중첩 지시문\n".repeat(INLINE_CAP);
  const log = f.sessions.subLog(id, "sub-parent")!;
  log.append({ kind: "assistant", msg: "large", model: "sol", text: "", tools: [{ id: "large-child", name: "Agent", summary: "large", input: JSON.stringify({ prompt: exact }) }] });
  const large = log.tail().events.find(e => e.kind === "assistant" && e.msg === "large");
  const input = large?.kind === "assistant" ? large.tools[0]?.input : undefined;
  assert.ok(input && typeof input !== "string");
  assert.equal(JSON.parse(f.sessions.blob(id, input.blob)!).prompt, exact, "nested launch blobs are available through the same session-scoped transport");
});

test("a CLI without a login is told what to do, and the raw text stays in the host's log", async t => {
  for (const how of ["result", "throw"] as const) {
    const lines: string[] = [];
    const f = fixture(t, { failure: { text: "Not logged in · Please run /login", as: how } }, { log: (line: string) => lines.push(line) });
    const id = await f.create();
    await waitFor(() => f.sessions.summaryOf(id)?.state === "error");
    const stored = f.sessions.log(id).readAfter(0).events;
    const failed = stored.filter(e => e.kind === "result");
    assert.equal(failed.length, 1, how);
    assert.equal(failed[0]!.error, CLI_NOT_LOGGED_IN, how);
    assert.ok(lines.some((l) => l.includes("Not logged in")), `the raw CLI text is kept in the host log: ${lines.join(" | ")}`);
  }
});

test("another CLI error is left exactly as it was", async t => {
  const f = fixture(t, { failure: { text: "API Error: 500 internal error", as: "result" } });
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "error");
  const stored = f.sessions.log(id).readAfter(0).events;
  const failed = stored.filter(e => e.kind === "result");
  assert.equal(failed[0]!.error, "API Error: 500 internal error");
});

test("thinking streams finalize at original block indices without exposing signatures", async t => {
  const f = fixture(t, { thinking: true });
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const stored = f.sessions.log(id).readAfter(0).events;
  const thoughts = stored.filter(e => e.kind === "thinking");
  assert.deepEqual(thoughts.map(e => [e.block, e.text, e.delta === true]), [[2, "thought 2", true], [2, "thought 2 complete", false], [4, "thought 4", true], [4, "thought 4 complete", false]]);
  assert.ok(!JSON.stringify(stored).includes("private signature"));
  assert.deepEqual(reduce(stored).items.filter(i => i.type === "thinking").map(i => i.text), ["thought 2 complete", "thought 4 complete"]);
});

test("a narration block is stored as its own event and its streamed thinking tail does not stay on screen", async t => {
  const f = fixture(t, { thinking: true, narration: true });
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const stored = f.sessions.log(id).readAfter(0).events;
  const narrations = stored.filter(e => e.kind === "narration");
  assert.deepEqual(narrations.map(e => [e.block, e.text]), [[4, "thought 4 complete"]]);
  assert.ok(!JSON.stringify(stored).includes(signatureOf("narration")), "a signature never reaches the log");
  const view = reduce(stored);
  assert.deepEqual(view.items.filter(i => i.type === "thinking").map(i => [i.key, i.streaming]), [["hm1:2", false], ["hm1:4", false]]);
  const rows = timelineItems(view);
  assert.ok(rows.every(row => row.type !== "thinking"), "the thinking that narrated is not a live line");
  assert.ok(rows.some(row => row.type === "assistant" && row.text === "thought 4 complete"));
});

test("a model plus effort change waits for writer exit and carries inputs accepted during restart", async t => {
  const boundary = controlledQueries(true, true);
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const first = boundary.queries[0]!;
  first.emit({ type: "system", subtype: "init", session_id: "sdk-model-effort" });
  await nextTick();
  assert.deepEqual(await f.sessions.setModel(id, "claude-next", "max", "model-and-effort"), { status: "partial", model: "claude-test", effort: "high", pending: { model: "claude-next", effort: "max" } });
  await f.sessions.send(id, "next-turn", "use the new settings");
  first.emit({ type: "result", subtype: "success" });
  await waitFor(() => first.closed);
  await f.sessions.send(id, "while-exiting", "also preserve this input");
  await nextTick();
  assert.equal(boundary.queries.length, 1, "close is not process exit; no second writer may start yet");
  first.exitReply.resolve();
  await waitFor(() => boundary.queries.length === 2);
  const second = boundary.queries[1]!;
  assert.equal(second.options.model, "claude-next");
  assert.equal(second.options.effort, "max");
  assert.equal(second.options.resume, "sdk-model-effort");
  assert.equal(first.closed, true);
  assert.equal(second.options.allowDangerouslySkipPermissions, undefined);
  await waitFor(() => second.users.length === 2);
  assert.deepEqual(second.users.map(u => u.message.content), ["use the new settings", "also preserve this input"]);
  second.emit({ type: "result", subtype: "success" });
  second.emit({ type: "result", subtype: "success" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
});

test("unsupported Claude effort is rejected before changing the SDK model or saved next-turn setting", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  await assert.rejects(f.sessions.setModel(id, "claude-next", "ultra", "unsupported-effort"), /추론 강도를 지원하지 않습니다/);
  assert.equal(f.sessions.summaryOf(id)?.model, "claude-test");
  assert.equal(f.sessions.summaryOf(id)?.effort, "high");
  assert.deepEqual(f.fake.spies.setModel, []);
});

test("a stopped SDK session cannot gain a bypass launch flag through a mode change", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  f.sessions.stop(id);
  await assert.rejects(f.sessions.setMode(id, "bypassPermissions", "no-spawn-bypass"), /bypass_not_launched/);
  await f.sessions.send(id, "after-rejection", "continue");
  await waitFor(() => f.fake.options.length === 2);
  assert.equal(f.fake.options[1]!.allowDangerouslySkipPermissions, undefined);
});

test("an effort restart carries every accepted input, whether still in the inbox or prefetched by the SDK", async t => {
  for (const prefetch of [false, true]) {
    const boundary = controlledQueries(prefetch);
    const f = fixture(t, {}, { queryFn: boundary.queryFn });
    const id = await f.create();
    await waitFor(() => boundary.queries.length === 1);
    const first = boundary.queries[0]!;
    first.emit({ type: "system", subtype: "init", session_id: "sdk-restart" });
    await nextTick();
    await f.sessions.send(id, "second", "second input");
    await f.sessions.send(id, "third", "third input");
    await nextTick();
    assert.equal(first.users.length, prefetch ? 3 : 0);
    await f.sessions.setModel(id, "claude-test", "max");
    first.emit({ type: "result", subtype: "success" });
    await waitFor(() => boundary.queries.length === 2);
    const second = boundary.queries[1]!;
    await waitFor(() => second.users.length === 2);
    assert.equal(first.closed, true);
    assert.equal(second.options.resume, "sdk-restart");
    assert.equal(second.options.effort, "max");
    assert.deepEqual(second.users.map(u => u.message.content), ["second input", "third input"]);
    assert.equal(f.sessions.summaryOf(id)?.state, "running");
    const receipts = MessageReceipts.open(path.join(f.dir, "receipts.json"));
    for (const key of ["second", "third"]) {
      assert.equal(receipts.status(`send:${id}:${key}`), "completed");
      // A retry repeats the same words: an id names one message.
      assert.equal(await f.sessions.send(id, key, key === "second" ? "second input" : "third input"), id);
    }
    await nextTick();
    assert.equal(second.users.length, 2, "completed receipts cover the carried input, not a dropped message");
    assert.equal(f.sessions.log(id).tail().events.filter(e => e.kind === "user").length, 3);
    second.emit({ type: "result", subtype: "success" });
    second.emit({ type: "result", subtype: "success" });
    await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  }
});

test("a plan approval cancelled during the mode control restores plan mode and its original return mode", async t => {
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  await f.sessions.setMode(id, "bypassPermissions");
  await f.sessions.setMode(id, "plan");
  const query = boundary.queries[0]!;
  const callback = query.options.canUseTool as CanUseTool;
  const abort = new AbortController();
  const answer = callback("ExitPlanMode", { plan: "Implement" }, { signal: abort.signal });
  const permission = f.permissions.pending(id)[0]!;
  query.modeReply = Promise.withResolvers<void>();
  const deciding = f.sessions.decide(id, permission.id, "allow");
  await waitFor(() => query.modes.length === 3);
  abort.abort();
  query.modeReply.resolve();
  assert.equal(await deciding, false);
  assert.equal((await answer).behavior, "deny");
  assert.equal(f.permissions.get(permission.id)?.state, "expired");
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, "plan");
  assert.deepEqual(query.modes, ["bypassPermissions", "plan", "bypassPermissions", "plan"]);
  const again = callback("ExitPlanMode", { plan: "Revised" }, { signal: new AbortController().signal });
  assert.equal(await f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow"), true);
  assert.equal((await again).behavior, "allow");
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, "bypassPermissions");
});

for (const cancelled of [false, true]) test(`plan ${cancelled ? "rollback" : "approval"} stays ahead of a later pick and message in the lane`, async t => {
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  await f.sessions.setMode(id, "plan");
  const abort = new AbortController();
  const answer = (query.options.canUseTool as CanUseTool)("ExitPlanMode", { plan: "Implement" }, { signal: abort.signal });
  query.modeReply = Promise.withResolvers<void>();
  const approval = f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  const pick = f.sessions.setMode(id, "default", "after-plan");
  const send = f.sessions.orderedSend(id, "after-plan", "continue");
  await waitFor(() => query.modes.length === 2);
  assert.deepEqual(query.modes, ["plan", "acceptEdits"]);
  assert.equal(query.users.length, 1);
  if (cancelled) abort.abort();
  query.modeReply.resolve();
  assert.equal(await approval, !cancelled);
  assert.equal((await answer).behavior, cancelled ? "deny" : "allow");
  await pick;
  await send;
  await nextTick();
  assert.deepEqual(query.modes, cancelled ? ["plan", "acceptEdits", "plan", "default"] : ["plan", "acceptEdits", "default"]);
  const ordered = f.sessions.log(id).tail().events.filter(e => e.kind === "mode" || e.kind === "user");
  assert.deepEqual(ordered.slice(-2).map(e => e.kind === "mode" ? e.mode : e.clientMsgId), ["default", "after-plan"]);
  assert.equal(query.users.at(-1)?.message.content, "continue");
});

test("steer keeps the running query; interrupt closes it and withdraws unstarted inputs", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.send(id, 'steer', 'steering');
  assert.equal(f.fake.spies.interrupt, 0);
  assert.equal(f.fake.spies.close, 0);
  await f.sessions.interrupt(id);
  await nextTick();
  assert.equal(f.fake.spies.interrupt, 1);
  assert.equal(f.fake.spies.close, 1);
  assert.equal(f.fake.users.length, 1);
  assert.equal(f.sessions.summaryOf(id)?.state, 'idle');
  await f.sessions.send(id, 'replacement', 'replace', [], 'interrupt');
  await waitFor(() => f.fake.users.length === 2);
  assert.equal(f.fake.users[1]!.message.content, 'replace');
  assert.equal(f.fake.options.length, 2);
});

for (const controlFails of [false, true]) test(`sends during interrupt are rejected without receipts and retry once after control ${controlFails ? "failure" : "success"}`, async t => {
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  const id = await f.create();
  await nextTick();
  const first = boundary.queries[0]!;
  assert.deepEqual(first.users.map(user => user.message.content), ["ping"]);
  const interrupted = f.sessions.interrupt(id);
  const outcome = controlFails ? assert.rejects(interrupted, /control failed/) : interrupted;
  const before = f.sessions.log(id).lastSeq;
  for (let retry = 0; retry < 2; retry++) {
    assert.throws(() => f.sessions.send(id, "during-stop", "must not disappear"), /interrupt/i);
    assert.equal(MessageReceipts.open(path.join(f.dir, "receipts.json")).status(`send:${id}:during-stop`), null);
    assert.equal(f.sessions.log(id).lastSeq, before, "rejection must not record a user event or poison the seen index");
  }
  assert.equal(await f.sessions.send(id, "create-1", "ping"), id, "completed retries remain idempotent during Stop");
  await nextTick();
  assert.deepEqual(first.users.map(user => user.message.content), ["ping"]);
  if (controlFails) first.interruptReply.reject(new Error("control failed"));
  else first.interruptReply.resolve();
  await outcome;
  assert.equal(first.closed, true);
  assert.equal(f.sessions.summaryOf(id)?.state, "idle");
  const sends = await Promise.all([
    f.sessions.send(id, "during-stop", "must not disappear"),
    f.sessions.send(id, "during-stop", "must not disappear"),
  ]);
  assert.deepEqual(sends, [id, id]);
  await nextTick();
  assert.equal(boundary.queries.length, 2);
  assert.deepEqual(boundary.queries[1]!.users.map(user => user.message.content), ["must not disappear"]);
  assert.equal(MessageReceipts.open(path.join(f.dir, "receipts.json")).status(`send:${id}:during-stop`), "completed");
  assert.equal(f.sessions.log(id).tail().events.filter(event => event.kind === "user" && event.clientMsgId === "during-stop").length, 1);
  f.sessions.shutdown();
  const { recovered, fake } = reopen(t, f);
  assert.equal(await recovered.send(id, "during-stop", "must not disappear"), id);
  assert.equal(fake.options.length, 0, "the accepted retry also deduplicates after restart");
});

test("phone images reach SDK blocks and files are written under cwd", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === 'idle');
  const data = Buffer.from('photo bytes').toString('base64');
  const blob = f.sessions.log(id).image(data);
  await f.sessions.send(id, 'image-input', 'look', [{ blob, name: 'photo.png', mediaType: 'image/png' }]);
  await waitFor(() => f.fake.users.length === 2);
  assert.deepEqual(f.fake.users[1]!.message.content, [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }]);
  const fileBlob = f.sessions.log(id).image(Buffer.from('file bytes').toString('base64'));
  await f.sessions.send(id, 'file-input', 'read', [{ blob: fileBlob, name: '../../notes.txt', mediaType: 'text/plain' }]);
  await waitFor(() => f.fake.users.length === 3);
  const files = fs.readdirSync(path.join(f.cwd, '.ripple-attachments'));
  assert.equal(files.length, 1);
  assert.equal(fs.readFileSync(path.join(f.cwd, '.ripple-attachments', files[0]!), 'utf8'), 'file bytes');
  assert.match(String(f.fake.users[2]!.message.content), /Attached file:/);
  assert.throws(() => f.sessions.send(id, 'missing-file', 'read', [{ blob: 'missing', name: 'a', mediaType: 'text/plain' }]), /missing/);
});

test("a live SDK SendUserFile image joins the assistant event through the blob transport", async t => {
  const f = fixture(t, { sendFile: "shot.png" });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fs.writeFileSync(path.join(f.cwd, "shot.png"), bytes);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const assistant = f.sessions.log(id).readAfter(0).events.filter(e => e.kind === "assistant").at(-1);
  assert.ok(assistant?.kind === "assistant");
  const image = assistant.images?.[0];
  assert.ok(image?.blob);
  assert.equal(image.mediaType, "image/png");
  assert.equal(f.sessions.log(id).blob(image.blob!), bytes.toString("base64"));
  assert.equal(assistant.tools.find(tool => tool.name === "SendUserFile")?.summary, "shot.png, shot");
});

test("SDK main and worker file deliveries share the session boundary and never drop surrounding events", async t => {
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  fs.writeFileSync(path.join(f.cwd, "결과.md"), "# 결과\n\n완료");
  fs.writeFileSync(path.join(f.cwd, ".env"), "API_TOKEN=private");
  fs.writeFileSync(path.join(f.dir, "outside.txt"), "outside");
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  const content = [
    { type: "text", text: "파일을 확인해 주세요." },
    { type: "tool_use", id: "files", name: "SendUserFile", input: { files: ["결과.md", ".env", path.join(f.dir, "outside.txt")], additionalDirectories: [f.dir] } },
  ];
  for (const parent of [null, "worker"]) query.emit({ type: "assistant", parent_tool_use_id: parent, message: { id: parent ?? "main", model: "test", content } });
  query.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "files", content: `kept [Image: source: ${f.dir}/outside.txt]` }] } });
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const main = f.sessions.log(id).readAfter(0).events;
  const worker = f.sessions.subLog(id, "sub-worker")!.readAfter(0).events;
  for (const events of [main, worker]) {
    const assistant = events.find(event => event.kind === "assistant");
    assert.ok(assistant?.kind === "assistant");
    assert.equal(assistant.text, "파일을 확인해 주세요.");
    const files = assistant.tools[0]!.files!;
    assert.deepEqual(files.map(file => file.status), ["ready", "blocked", "blocked"]);
    assert.equal(files[0]!.name, "결과.md");
    assert.equal(files[0]!.mediaType, "text/markdown");
    assert.equal(Buffer.from(f.sessions.blob(id, files[0]!.blob!)!, "base64").toString(), "# 결과\n\n완료");
    assert.ok(!JSON.stringify(assistant.tools[0]).includes(f.dir));
  }
  const result = main.find(event => event.kind === "tool_result");
  assert.ok(result?.kind === "tool_result");
  assert.equal(result.text, "kept ");
  assert.equal(result.files?.[0]?.status, "blocked");
  assert.ok(main.some(event => event.kind === "result" && event.ok));
});

test("clear and new preserve the title in a fresh empty session, retries and restart snapshots", async t => {
  const f = fixture(t);
  const id = await f.sessions.create({ clientMsgId: 'original', cwd: f.cwd, model: 'routed', effort: 'high', permissionMode: 'plan', text: 'ping' });
  await waitFor(() => f.sessions.summaryOf(id)?.state === 'idle');
  const freshIds: string[] = [];
  for (const command of ['/clear', '/new']) {
    const fresh = await f.sessions.send(id, command, command);
    freshIds.push(fresh);
    assert.notEqual(fresh, id);
    const s = f.sessions.summaryOf(fresh)!;
    assert.deepEqual([s.cwd, s.model, s.effort, s.permissionMode, s.state], [f.cwd, 'routed', 'high', 'plan', 'idle']);
    assert.equal(s.title, 'ping');
    assert.equal(s.attention, null);
    assert.equal(f.sessions.log(fresh).before(Number.MAX_SAFE_INTEGER).events.some(e => e.kind === 'user'), false);
    assert.equal(await f.sessions.send(id, command, command), fresh);
  }
  assert.equal(f.fake.options.length, 1, 'clear creates metadata, not a new running query');
  const snapshot = f.sessions.list();
  f.sessions.shutdown();
  const { recovered, fake } = reopen(t, f);
  recovered.recover();
  assert.deepEqual(recovered.list(), snapshot, 'reconnection after restart retains titles and fresh ids');
  const fresh = await recovered.send(id, '/clear', '/clear');
  assert.equal(fresh, freshIds[0]);
  assert.equal(recovered.list().length, 3, 'a replayed clear does not create another session');
  await recovered.send(fresh, 'after-clear', 'A new context');
  await waitFor(() => fake.options.length === 1);
  assert.equal(fake.options[0]?.title, 'ping', 'the original title reaches the SDK, not just the list');
  assert.equal(fake.options[0]?.resume, undefined, 'clear does not resume the old conversation');
});

test("creation carries permission mode, enables bypass explicitly, and defaults to auto", async t => {
  const f = fixture(t);
  for (const mode of [undefined, 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
    const id = await f.sessions.create({ clientMsgId: `mode-${mode}`, cwd: f.cwd, model: 'test', effort: null, text: 'ping', ...(mode ? { permissionMode: mode } : {}) });
    await waitFor(() => f.fake.options.length > 0 && f.sessions.summaryOf(id)?.state === 'idle');
    const options = f.fake.options.at(-1)!;
    assert.equal(options.permissionMode, mode ?? 'auto');
    assert.equal(options.allowDangerouslySkipPermissions, mode === 'bypassPermissions' ? true : undefined);
    assert.equal(f.sessions.summaryOf(id)?.permissionMode, mode ?? 'auto');
  }
});

test("set_mode applies during a turn and stores mode for a stopped session", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  await f.sessions.setMode(id, 'plan');
  assert.deepEqual(f.fake.spies.setPermissionMode, ['plan']);
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, 'plan');
  assert.ok(f.events.some(e => e.event.kind === 'mode' && e.event.mode === 'plan'));
  f.sessions.stop(id);
  await nextTick();
  await f.sessions.setMode(id, 'acceptEdits');
  f.sessions.send(id, 'resume-mode', 'again');
  await waitFor(() => f.fake.options.length === 2);
  assert.equal(f.fake.options[1]!.permissionMode, 'acceptEdits');
});

for (const original of ['auto', 'bypassPermissions'] as const) test(`plan implementation returns from ${original}`, async t => {
  const f = fixture(t);
  const id = await f.sessions.create({ clientMsgId: 'plan', cwd: f.cwd, model: 'test', effort: null, text: 'ping', permissionMode: original });
  await waitFor(() => f.fake.options.length === 1);
  await f.sessions.setMode(id, 'plan');
  const callback = f.fake.options[0]!.canUseTool as CanUseTool;
  const answer = callback('ExitPlanMode', { plan: '# Plan\nImplement it' }, { signal: new AbortController().signal });
  const pending = f.permissions.pending(id)[0]!;
  assert.ok(f.events.some(e => e.event.kind === 'permission' && e.event.requestKind === 'plan' && e.event.input === '# Plan\nImplement it'));
  assert.equal(await f.sessions.decide(id, pending.id, 'allow'), true);
  assert.equal((await answer).behavior, 'allow');
  assert.equal(f.fake.spies.setPermissionMode.at(-1), original === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits');
});

test("mode and plan approval failures stay visible and leave the permission pending", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.fake.options.length === 1);
  f.fake.spies.modeError = new Error('mode rejected');
  await assert.rejects(f.sessions.setMode(id, 'plan'), /mode rejected/);
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, 'auto');
  f.fake.spies.modeError = null;
  await f.sessions.setMode(id, 'plan');
  const callback = f.fake.options[0]!.canUseTool as CanUseTool;
  const answer = callback('ExitPlanMode', { plan: 'Work' }, { signal: new AbortController().signal });
  const pending = f.permissions.pending(id)[0]!;
  f.fake.spies.modeError = new Error('mode rejected');
  await assert.rejects(Promise.resolve(f.sessions.decide(id, pending.id, 'allow')), /mode rejected/);
  assert.equal(f.permissions.get(pending.id)?.state, 'pending');
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, 'plan');
  await f.sessions.decide(id, pending.id, 'deny', 'Revise the plan');
  assert.deepEqual(await answer, { behavior: 'deny', message: 'Revise the plan' });
});

test("AskUserQuestion passes answers keyed by question text in updatedInput", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.fake.options.length === 1);
  const callback = f.fake.options[0]!.canUseTool as CanUseTool;
  const input = { questions: [{ question: 'Which?', header: 'Choice', multiSelect: true, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] };
  const answer = callback('AskUserQuestion', input, { signal: new AbortController().signal });
  const pending = f.permissions.pending(id)[0]!;
  assert.throws(() => f.sessions.decide(id, pending.id, 'allow'), /Answer every question/);
  const answers = { 'Which?': 'A, B, custom' };
  assert.equal(await f.sessions.decide(id, pending.id, 'allow', undefined, answers), true);
  assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { ...input, answers } });
});

test("a new SDK message denies pending approvals before delivering the message", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.send(id, 'supersede', 'new instructions');
  await waitFor(() => f.fake.users.length === 2);
  assert.deepEqual(f.fake.answers[0], { behavior: 'deny', message: 'superseded by a new message from the user' });
  assert.equal(f.fake.users[1]!.message.content, 'new instructions');
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + WAIT_LIMIT;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Timed out waiting for scripted query");
    await delay(5);
  }
  await nextTick();
}

test("SDK user, assistant and tool-result image blocks retain chunked blob references", async t => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("sdk image").toString("base64") } };
  const f = fixture(t, { images: true, toolOutput: [image] });
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  const events = f.sessions.log(id).readAfter(0).events.filter(e => e.images?.length);
  assert.deepEqual(events.map(e => e.kind).sort(), ["assistant", "tool_result", "user"]);
  for (const event of events) assert.equal(f.sessions.log(id).blob(event.images![0]!.blob!), image.source.data);
});

function eventLabels(events: SessionEvent[]): string[] {
  return events.filter(event => event.kind !== "figures").map(event => event.kind === "state" ? `state ${event.state}` : event.kind);
}

for (const { model, effort, expected } of [
  { model: "claude-test", effort: "high" as const, expected: { model: "claude-test", effort: "high" } },
  { model: "gpt-test", effort: "max" as const, expected: { model: "gpt-test@max" } },
  { model: "opus", effort: "high" as const, expected: { model: "opus", effort: "high" } },
]) {
  test(`create uses cwd, proxy env and modelArg for ${model}, and emits an ordered turn`, { timeout: TEST_TIMEOUT }, async t => {
    const f = fixture(t);
    const id = await f.create("create-1", model, effort);
    await waitFor(() => f.sessions.list().find(session => session.id === id)?.state === "idle");
    assert.equal(f.fake.options.length, 1);
    const options = f.fake.options[0]!;
    assert.equal(options.cwd, f.cwd);
    assert.equal(options.model, expected.model);
    if ("effort" in expected) assert.equal(options.effort, expected.effort);
    else assert.ok(!Object.hasOwn(options, "effort"));
    assert.deepEqual(modelArg(model, effort), expected);
    const env = options.env;
    assert.ok(env !== null && typeof env === "object");
    assert.equal(Reflect.get(env, "HTTPS_PROXY"), "http://127.0.0.1:1");
    assert.ok(!Object.hasOwn(env, "ANTHROPIC_BASE_URL"));
    assert.ok(!Object.hasOwn(options, "resume"));
    assert.deepEqual(eventLabels(f.events.filter(row => row.session === id).map(row => row.event)), [
      "state starting", "user", "turn", "state running", "delta", "assistant", "result", "state idle",
    ]);
    const delta = f.events.find(row => row.event.kind === "delta")?.event;
    assert.ok(delta?.kind === "delta");
    assert.equal(delta.text, "po");
    const stored = f.sessions.log(id).readAfter(0).events;
    const assistant = stored.find(event => event.kind === "assistant");
    assert.ok(assistant?.kind === "assistant");
    assert.equal(assistant.text, "pong");
    assert.deepEqual(stored.find(event => event.kind === "result"), {
      kind: "result", ok: true, ms: 5, turns: 1, seq: stored.find(event => event.kind === "result")!.seq,
      at: stored.find(event => event.kind === "result")!.at,
    });
    assert.equal(f.fake.users[0]?.message.content, "ping");
  });
}

test("sequential create and send retries with the same clientMsgId are idempotent", { timeout: TEST_TIMEOUT }, async t => {
  const f = fixture(t);
  const id = await f.create();
  assert.equal(await f.create(), id);
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  assert.equal(f.fake.options.length, 1);
  f.sessions.send(id, "send-1", "again");
  f.sessions.send(id, "send-1", "again");
  await waitFor(() => f.fake.users.length === 2 && f.sessions.list()[0]?.state === "idle");
  const users = f.sessions.log(id).readAfter(0).events.filter(event => event.kind === "user");
  assert.deepEqual(users.map(event => event.clientMsgId), ["create-1", "send-1"]);
  assert.deepEqual(f.fake.users.map(user => user.message.content), ["ping", "again"]);
  assert.equal(f.fake.options.length, 1);
});

test("concurrent create retries with the same clientMsgId start only one query", {
  timeout: TEST_TIMEOUT,
}, async t => {
  const f = fixture(t);
  const ids = await Promise.all([f.create(), f.create()]);
  await waitFor(() => f.fake.options.length > 0);
  assert.equal(ids[0], ids[1]);
  assert.equal(f.sessions.list().length, 1);
  assert.equal(f.fake.options.length, 1);
});

for (const decision of ["allow", "allow_always", "deny"] as const) {
  test(`permission ${decision} waits, rejects another session and returns the SDK answer`, { timeout: TEST_TIMEOUT }, async t => {
    const f = fixture(t, { permission: true });
    const id = await f.create();
    const otherId = await f.create("other-session");
    await waitFor(() => f.permissions.pending(id).length === 1 && f.permissions.pending(otherId).length === 1);
    const pending = f.permissions.pending(id)[0]!;
    const permission = f.events.find(row => row.session === id && row.event.kind === "permission")?.event;
    assert.ok(permission?.kind === "permission");
    assert.equal(permission.id, pending.id);
    assert.equal(permission.tool, "Bash");
    assert.equal(permission.input, "ls");
    assert.equal(permission.canAlways, true);
    assert.equal(f.sessions.list().find(session => session.id === id)?.state, "waiting");
    const labels = eventLabels(f.events.filter(row => row.session === id).map(row => row.event));
    assert.deepEqual(labels.slice(-3), ["delta", "permission", "state waiting"]);
    assert.equal(f.sessions.decide(otherId, pending.id, decision), false);
    assert.equal(f.permissions.pending(id).length, 1);
    assert.equal(f.sessions.decide(id, pending.id, decision), true);
    await waitFor(() => f.sessions.list().find(session => session.id === id)?.state === "idle");
    assert.equal(f.sessions.decide(id, pending.id, decision), false);
    const decided = f.sessions.log(id).readAfter(0).events.find(event => event.kind === "permission_decided");
    assert.ok(decided?.kind === "permission_decided");
    assert.equal(decided.id, pending.id);
    assert.equal(decided.decision, decision);
    const answer = f.fake.answers[0]!;
    assert.equal(answer.behavior, decision === "deny" ? "deny" : "allow");
    if (answer.behavior === "allow") {
      assert.deepEqual(answer.updatedInput, { command: "ls" });
      if (decision === "allow_always") assert.deepEqual(answer.updatedPermissions, f.fake.suggestions);
      else assert.ok(!Object.hasOwn(answer, "updatedPermissions"));
    } else assert.match(answer.message, /denied/);
    // Resolve the unrelated query too, so shutdown cannot race a permission continuation.
    assert.equal(f.sessions.decide(otherId, f.permissions.pending(otherId)[0]!.id, "deny"), true);
    await waitFor(() => f.sessions.list().every(session => session.state === "idle"));
  });
}

for (const damage of ["duplicate-seq", "invalid-json", "unreadable"] as const) test(`recovery skips only a ${damage} session and preserves its files`, async t => {
  const f = fixture(t);
  const bad = await f.create("bad");
  const good = await f.create("good");
  await waitFor(() => f.sessions.list().every(s => s.state === "idle"));
  const seq = f.sessions.log(bad).lastSeq;
  f.permissions.request({ session: bad, tool: "Bash", title: "", summary: "ls", input: {} });
  f.sessions.shutdown();
  const file = path.join(f.dir, "sessions.json");
  const records = JSON.parse(fs.readFileSync(file, "utf8")) as { id: string; state: string }[];
  fs.writeFileSync(file, JSON.stringify(records.map(r => ({ ...r, state: r.id === good ? "running" : "idle" }))));
  const segment = path.join(f.dir, "sessions", bad, "events-000001.jsonl");
  if (damage === "duplicate-seq") {
    fs.appendFileSync(segment, [
      { seq: seq + 1, at: 1, kind: "notice", code: "host_restarted" },
      { seq: seq + 2, at: 1, kind: "state", state: "stopped" },
      { seq: seq + 1, at: 2, kind: "user", text: "original writer" },
    ].map(e => JSON.stringify(e) + "\n").join(""));
  } else if (damage === "invalid-json") fs.appendFileSync(segment, "invalid json\n{}\n");
  else { fs.unlinkSync(segment); fs.mkdirSync(segment); }
  const before = damage === "unreadable" ? null : fs.readFileSync(segment);
  const lines: string[] = [];
  const recovered = new Sessions({ dir: f.dir, router, permissions: PermissionQueue.open(f.permissionsFile),
    queryFn: f.fake.queryFn, log: line => lines.push(line), onEvent: () => {}, onSessions: () => {} });
  f.instances.push(recovered);
  recovered.recover();
  assert.deepEqual(recovered.list().map(s => [s.id, s.state]), [[good, "stopped"]]);
  assert.equal(recovered.has(bad), false);
  assert.throws(() => recovered.log(bad), /unreadable/);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes(bad) && lines[0]!.includes("session files preserved"));
  await recovered.send(good, "continue-good", "continue");
  await waitFor(() => recovered.summaryOf(good)?.state === "idle");
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { id: string }[];
  assert.ok(saved.some(r => r.id === bad), "healthy saves retain the skipped record");
  if (before) assert.deepEqual(fs.readFileSync(segment), before);
  else assert.ok(fs.statSync(segment).isDirectory());
});

test("recover expires persisted permissions, stops a mid-turn session and resumes sdk-1", { timeout: TEST_TIMEOUT }, async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  f.sessions.stop(id);
  await nextTick();
  const file = path.join(f.dir, "sessions.json");
  const records = JSON.parse(fs.readFileSync(file, "utf8")) as { id: string; state: string; sdkSessionId: string | null }[];
  assert.equal(records[0]?.sdkSessionId, "sdk-1");
  fs.writeFileSync(file, JSON.stringify(records.map(record => ({ ...record, state: "running" }))));
  f.sessions.log(id).append({ kind: "state", state: "running" });
  const pending = f.permissions.request({ session: id, tool: "Bash", title: "", summary: "ls", input: { command: "ls" } });
  f.sessions.log(id).append({ kind: "permission", id: pending.record.id, tool: "Bash", title: "", summary: "ls", input: "ls", canAlways: true });
  const epoch = f.sessions.log(id).epoch;
  const before = f.sessions.log(id).lastSeq;
  f.sessions.shutdown();

  const permissions = PermissionQueue.open(f.permissionsFile);
  const fake = scriptedQuery();
  const recovered = new Sessions({ dir: f.dir, router, permissions, queryFn: fake.queryFn, coalesceMs: 5, onEvent: () => {}, onSessions: () => {} });
  f.instances.push(recovered);
  recovered.recover();
  assert.equal(recovered.log(id).epoch, epoch);
  assert.equal(permissions.pending().length, 0);
  assert.deepEqual(recovered.log(id).readAfter(before).events.map(({ seq: _seq, at: _at, ...event }) => event), [
    { kind: "permission_decided", id: pending.record.id, decision: "expired", reason: "host_restarted" },
    { kind: "notice", code: "host_restarted", text: "호스트가 다시 시작되어 이 턴이 중단되었습니다" },
    { kind: "state", state: "stopped" },
  ]);
  assert.equal(recovered.list()[0]?.state, "stopped");
  recovered.send(id, "after-restart", "continue");
  await waitFor(() => recovered.list()[0]?.state === "idle");
  assert.equal(fake.options.length, 1);
  assert.equal(fake.options[0]?.resume, "sdk-1");
  assert.equal(fake.options[0]?.cwd, f.cwd);
  assert.equal(fake.users[0]?.session_id, "sdk-1");
});

test("large SDK tool output is stored as a BlobRef and round-trips in full", { timeout: TEST_TIMEOUT }, async t => {
  const text = "界😀\n".repeat(INLINE_CAP);
  const f = fixture(t, { toolOutput: text });
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  const result = f.sessions.log(id).readAfter(0).events.find(event => event.kind === "tool_result");
  assert.ok(result?.kind === "tool_result");
  assert.equal(result.toolUseId, "tool-1");
  assert.equal(result.ok, true);
  assert.ok(typeof result.text !== "string");
  assert.equal(result.text.bytes, Buffer.byteLength(text));
  assert.equal(result.text.preview, text.slice(0, 400));
  assert.equal(f.sessions.log(id).blob(result.text.blob), text);
});

test("desktop handoff waits for idle, holds new input, persists once and names the SDK session", async t => {
  const calls: { sessionId: string; title: string; cwd: string }[] = [];
  let finish: (() => void) | undefined;
  const logs: string[] = [];
  const f = fixture(t, { permission: true }, {
    handoff: async request => { calls.push(request); await new Promise<void>(resolve => { finish = resolve; }); return "opened"; },
    log: line => logs.push(line),
  });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  assert.equal(calls.length, 0);
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls[0], { sessionId: "sdk-1", title: "ping", cwd: f.cwd });
  assert.equal(f.fake.options[0]?.title, "ping");
  f.sessions.send(id, "during-handoff", "again");
  await nextTick();
  assert.equal(f.fake.users.length, 1);
  finish!();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(f.fake.users.length, 2);
  assert.equal(calls.length, 1);
  assert.match(logs[0]!, /opened/);
  f.sessions.shutdown();
  const recovered = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: f.fake.queryFn,
    handoff: async request => { calls.push(request); return "opened"; }, onEvent: () => {}, onSessions: () => {} });
  f.instances.push(recovered);
  recovered.send(id, "after-handoff-restart", "continue");
  await waitFor(() => f.permissions.pending(id).length === 1);
  recovered.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => recovered.summaryOf(id)?.state === "idle");
  assert.equal(calls.length, 1);
});

for (const owner of ["new", "open", "bridge"] as const) test(`desktop handoff preserves active background work with ${owner} ownership`, async t => {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-background-"));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  const sdkId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const registry = new Map<string, DesktopProcess>();
  const boundary = controlledQueries();
  let calls = 0;
  const bridgeClient = new BridgeClient({ auth: () => ({ accessToken: "fake", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async () => Response.json({ data: [], worker_status: "idle" }) });
  const f = fixture(t, {}, { queryFn: boundary.queryFn, desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "", bridgeClient,
    handoff: async () => { calls++; return "opened"; }, log() {} });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  query.emit({ type: "system", subtype: "init", session_id: sdkId });
  query.emit({ type: "assistant", message: { id: "launch", content: [{ type: "tool_use", id: "agent", name: "Agent", input: { description: "Review", run_in_background: true } }] } });
  query.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent", content: '{"isAsync":true,"agentId":"worker"}' }] } });
  if (owner !== "new") registry.set(sdkId, { sessionId: sdkId, pid: 42, status: "idle", ...(owner === "bridge" ? { bridgeSessionId: "bridge" } : {}) });
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  await f.sessions.pollDesktop(); await nextTick();
  assert.equal(query.closed, false, "main result and desktop adoption must not abort the worker");
  assert.equal(calls, 0);
  query.emit({ type: "user", message: { content: "<task-notification><task-id>worker</task-id><tool-use-id>agent</tool-use-id><status>completed</status><result>Review finished</result></task-notification>" } });
  await waitFor(() => f.sessions.summaryOf(id)?.tasks === 0);
  await f.sessions.pollDesktop();
  await waitFor(() => query.closed);
  assert.equal(calls, owner === "new" ? 1 : 0);
  assert.equal(reduce(f.sessions.log(id).readAfter(0).events).items.find(item => item.type === "subagent")?.status, "done");
});

test("a deferred handoff rechecks background activity before closing the SDK", async t => {
  const boundary = controlledQueries();
  let calls = 0;
  const f = fixture(t, {}, { queryFn: boundary.queryFn, handoff: async () => { calls++; return "opened"; }, log() {} });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  query.emit({ type: "system", subtype: "init", session_id: "sdk-race" });
  query.emit({ type: "result", subtype: "success" });
  query.emit({ type: "assistant", message: { id: "late-launch", content: [{ type: "tool_use", id: "agent", name: "Agent", input: { description: "Late worker", run_in_background: true } }] } });
  query.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent", content: '{"isAsync":true,"agentId":"worker"}' }] } });
  await waitFor(() => f.sessions.summaryOf(id)?.tasks === 1);
  assert.equal(query.closed, false);
  assert.equal(calls, 0);
  query.emit({ type: "user", message: { content: "<task-notification><task-id>worker</task-id><status>stopped</status></task-notification>" } });
  await waitFor(() => f.sessions.summaryOf(id)?.tasks === 0);
  await f.sessions.pollDesktop();
  await waitFor(() => calls === 1);
  assert.equal(reduce(f.sessions.log(id).readAfter(0).events).items.find(item => item.type === "subagent")?.status, "stopped");
});

test("settings restart waits for background work before closing the SDK", async t => {
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  query.emit({ type: "assistant", message: { id: "launch", content: [{ type: "tool_use", id: "agent", name: "Agent", input: { description: "Review" } }] } });
  query.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent", content: '{"isAsync":true,"agentId":"worker"}' }] } });
  await waitFor(() => f.sessions.summaryOf(id)?.tasks === 1);
  await f.sessions.setModel(id, "claude-test", "max");
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(query.closed, false);
  query.emit({ type: "user", message: { content: "<task-notification><task-id>worker</task-id><status>completed</status></task-notification>" } });
  await waitFor(() => f.sessions.summaryOf(id)?.tasks === 0);
  await f.sessions.pollDesktop();
  await waitFor(() => query.closed);
});

for (const toolId of [true, false]) test(`a handed-off SDK worker's stopped transcript notification closes its existing card (${toolId ? "tool id" : "task id"})`, async t => {
  const f = await modFixture(t);
  const file = path.join(f.projects, "project", `${f.sdkId}.jsonl`);
  const launch = { type: "assistant", message: { id: "launch", content: [{ type: "tool_use", id: "agent", name: "Agent", input: { description: "Review", run_in_background: true } }] } };
  const started = { type: "user", toolUseResult: { isAsync: true, agentId: "worker" }, message: { content: [{ type: "tool_result", tool_use_id: "agent", content: '{"isAsync":true,"agentId":"worker"}' }] } };
  // Reproduce a pre-fix host record whose worker was handed off while still running.
  f.sessions.log(f.id).append({ kind: "subagent", toolUseId: "agent", sub: "sub-agent", description: "Review", model: "sol", status: "running", steps: 3 });
  f.sessions.log(f.id).append({ kind: "assistant", msg: "launch", model: "sol", text: "", tools: [{ id: "agent", name: "Agent", summary: "Review", input: JSON.stringify(launch.message.content[0]!.input) }] });
  f.sessions.log(f.id).append({ kind: "tool_result", toolUseId: "agent", ok: true, text: started.message.content[0]!.content });
  fs.appendFileSync(file, transcriptLine(launch) + transcriptLine(started));
  // Starting the tail after the SDK's launch lines must still remember that worker.
  const records = JSON.parse(fs.readFileSync(path.join(f.dir, "sessions.json"), "utf8")) as { transcriptOffset?: number }[];
  f.sessions.shutdown();
  records[0]!.transcriptOffset = fs.statSync(file).size;
  fs.writeFileSync(path.join(f.dir, "sessions.json"), JSON.stringify(records));
  const active = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: f.boundary.queryFn, desktopProjects: f.projects, desktopRegistry: () => f.registry, desktopProcesses: () => "", onEvent() {}, onSessions() {} });
  f.instances.push(active);
  fs.appendFileSync(file, transcriptLine({ type: "user", isMeta: true, message: { content: `<task-notification><task-id>worker</task-id>${toolId ? "<tool-use-id>agent</tool-use-id>" : ""}<status>stopped</status><result>didn't finish before the previous session ended</result></task-notification>` } }));
  await active.pollDesktop();
  assert.equal(reduce(active.log(f.id).readAfter(0).events).items.find(item => item.type === "subagent")?.status, "stopped");
  assert.equal(active.summaryOf(f.id)?.tasks, 0);
  assert.equal(active.summaryOf(f.id)?.taskHistory?.[0]?.state, "stopped");
});

test("desktop handoff waits until already queued turns finish", async t => {
  const counts: number[] = [];
  const f = fixture(t, { permission: true }, { handoff: async () => { counts.push(f.fake.users.length); return "opened"; }, log: () => {} });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.send(id, "queued", "second turn");
  assert.equal(f.permissions.pending(id).length, 0);
  await waitFor(() => f.fake.users.length === 2 && f.permissions.pending(id).length === 1);
  assert.deepEqual(counts, []);
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => counts.length === 1);
  assert.deepEqual(counts, [2]);
});

test("desktop handoff failures persist and retry only at a later idle, at most three times across restarts", async t => {
  let calls = 0;
  const logs: string[] = [];
  const handoff = async () => { calls++; throw new Error("timeout"); };
  const f = fixture(t, {}, { handoff, log: line => logs.push(line) });
  const id = await f.create();
  await waitFor(() => logs.length === 1);
  const saved = () => (JSON.parse(fs.readFileSync(path.join(f.dir, "sessions.json"), "utf8")) as { desktopHandoff: string; desktopHandoffAttempts: number; desktopHandoffError: string }[])[0]!;
  assert.deepEqual([saved().desktopHandoff, saved().desktopHandoffAttempts, saved().desktopHandoffError], ["failed", 1, "timeout"]);
  for (let i = 0; i < 5; i++) await f.sessions.pollDesktop();
  assert.equal(calls, 1, "polls without a new turn do not spin retries");
  await f.sessions.send(id, "retry-turn", "again");
  await waitFor(() => logs.length === 2);
  assert.equal(saved().desktopHandoffAttempts, 2);
  f.sessions.shutdown();
  const recovered = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: f.fake.queryFn,
    handoff, log: line => logs.push(line), onEvent: () => {}, onSessions: () => {} });
  f.instances.push(recovered);
  recovered.recover();
  await recovered.send(id, "retry-after-restart", "again");
  await waitFor(() => logs.length === 3);
  await recovered.send(id, "past-limit", "again");
  await waitFor(() => f.fake.users.length === 4 && recovered.summaryOf(id)?.state === "idle");
  assert.equal(calls, 3);
  assert.equal(saved().desktopHandoffAttempts, 3);
  assert.match(logs[0]!, /failed: timeout/);
  assert.match(logs[2]!, /attempt 3\/3/);
  assert.ok(recovered.log(id).tail().events.some(e => e.kind === "notice" && e.code === "desktop_handoff_failed"));
});

test("handoff closes an idle SDK writer and waits for real process exit before invoking the runner", async t => {
  const exited = Promise.withResolvers<void>();
  const boundary = controlledQueries();
  let calls = 0;
  const f = fixture(t, {}, { queryFn: params => ({ ...boundary.queryFn(params), processExited: exited.promise }),
    handoff: async () => { assert.equal(boundary.queries[0]!.closed, true); calls++; return "opened"; }, log: () => {} });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const first = boundary.queries[0]!;
  first.emit({ type: "system", subtype: "init", session_id: "sdk-exiting" });
  first.emit({ type: "result", subtype: "success" });
  await waitFor(() => first.closed);
  assert.equal(calls, 0, "close() alone must not permit a second writer");
  await f.sessions.send(id, "while-exiting", "kept until exit");
  await nextTick();
  assert.equal(boundary.queries.length, 1);
  exited.resolve();
  await waitFor(() => calls === 1 && boundary.queries.length === 2);
  await waitFor(() => boundary.queries[1]!.users.length === 1);
  assert.equal(boundary.queries[1]!.users[0]!.message.content, "kept until exit");
  boundary.queries[1]!.emit({ type: "result", subtype: "success" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(calls, 1);
});

for (const reachable of [true, false]) test(`input accepted during handoff ${reachable ? "uses the new app bridge" : "resumes through the SDK once the app is idle"}, never a second concurrent writer`, async t => {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-app-projects-"));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  const sdkId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const registry = new Map<string, DesktopProcess>();
  const posts: string[] = [];
  const bridgeClient = new BridgeClient({ auth: () => ({ accessToken: "fixture-token", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
    if (options?.method === "POST") { posts.push(String(options.body)); return Response.json({}); }
    if (String(url).includes("/events/stream")) return new Response(new ReadableStream({ start(controller) { options?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }));
    return Response.json({ data: [], worker_status: "idle" });
  } });
  const boundary = controlledQueries();
  const finish = Promise.withResolvers<void>();
  let called = false;
  const f = fixture(t, {}, { queryFn: boundary.queryFn, desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "", bridgeClient,
    handoff: async () => { called = true; await finish.promise; return "opened"; }, log: () => {} });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  fs.mkdirSync(path.join(projects, "project"));
  fs.writeFileSync(path.join(projects, "project", `${sdkId}.jsonl`), JSON.stringify({ type: "user", uuid: "first", cwd: f.cwd, message: { content: "ping" } }) + "\n");
  const first = boundary.queries[0]!;
  first.emit({ type: "system", subtype: "init", session_id: sdkId });
  first.emit({ type: "result", subtype: "success" });
  await waitFor(() => called);
  const photo = Buffer.from("photo accepted during handoff").toString("base64");
  const attachments = [{ blob: f.sessions.log(id).image(photo), name: "photo.png", mediaType: "image/png" }];
  await f.sessions.send(id, "during-app-handoff", "accepted during handoff", attachments);
  await f.sessions.send(id, "during-app-handoff", "accepted during handoff", attachments, "interrupt");
  assert.equal(await f.sessions.sendQueued(id, "during-app-handoff"), id, "send-now cannot bypass the writer-exit barrier");
  assert.deepEqual(f.sessions.summaryOf(id)?.queue?.map(item => item.id), ["during-app-handoff"]);
  assert.equal(MessageReceipts.open(path.join(f.dir, "receipts.json")).status(`send:${id}:during-app-handoff`), null, "queued acceptance does not pretend the input reached a worker");
  registry.set(sdkId, { sessionId: sdkId, pid: 42, status: "idle", ...(reachable ? { bridgeSessionId: "bridge" } : {}) });
  finish.resolve();
  if (!reachable) {
    // Issue #102: the app only holds the handed-off session open, so the host resumes it itself.
    await waitFor(() => boundary.queries.length === 2 && boundary.queries[1]!.users.length === 1);
    assert.equal(first.closed, true, "the first writer exited before the resume");
    assert.equal(boundary.queries[1]!.options.resume, sdkId);
    assert.ok(JSON.stringify(boundary.queries[1]!.users[0]).includes(photo), "queue-owned photo bytes reach the resumed turn");
    assert.equal(posts.length, 0);
    await waitFor(() => f.sessions.summaryOf(id)?.queue === undefined);
    await f.sessions.send(id, "during-app-handoff", "accepted during handoff", attachments);
    assert.equal(boundary.queries[1]!.users.length, 1, "the original phone id completes exactly once");
    return;
  }
  await waitFor(() => posts.length === 1);
  assert.equal(first.closed, true);
  assert.equal(boundary.queries.length, 1);
  assert.match(posts[0]!, /accepted during handoff/);
  assert.equal(f.sessions.summaryOf(id)?.desktopBridge, true);
  assert.equal(f.sessions.list().length, 1);
  await f.sessions.send(id, "during-app-handoff", "accepted during handoff", attachments);
  await f.sessions.pollDesktop();
  assert.ok(posts[0]!.includes(photo), "queue-owned photo bytes survive the Desktop log rebase");
  assert.equal(posts.length, 1, "the original phone id completes exactly once");
  assert.equal(boundary.queries.length, 1);
});

test("a handed-off session waits while the app runs a turn, across a host restart, then resumes once", async t => {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-busy-"));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  const sdkId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const registry = new Map<string, DesktopProcess>();
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn, desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "",
    handoff: async () => { registry.set(sdkId, { sessionId: sdkId, pid: 7, status: "busy" }); return "opened"; }, log: () => {} });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  fs.mkdirSync(path.join(projects, "project"));
  fs.writeFileSync(path.join(projects, "project", `${sdkId}.jsonl`), JSON.stringify({ type: "user", uuid: "first", cwd: f.cwd, message: { content: "ping" } }) + "\n");
  boundary.queries[0]!.emit({ type: "system", subtype: "init", session_id: sdkId });
  boundary.queries[0]!.emit({ type: "result", subtype: "success" });
  await waitFor(() => registry.has(sdkId) && boundary.queries[0]!.closed);
  await f.sessions.send(id, "while-app-works", "sent while the app works");
  f.sessions.pollQueued();
  await waitFor(() => f.sessions.summaryOf(id)?.queue?.[0]?.error === DESKTOP_BUSY);
  assert.equal(boundary.queries.length, 1, "no second writer while the app is busy");
  f.sessions.shutdown();
  const active = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: boundary.queryFn, desktopProjects: projects,
    desktopRegistry: () => registry, desktopProcesses: () => "", modOfferMs: 5, onEvent() {}, onSessions() {}, log() {} });
  f.instances.push(active);
  active.recover();
  active.pollQueued();
  assert.equal(boundary.queries.length, 1, "still busy after the restart");
  registry.get(sdkId)!.status = "idle";
  active.pollQueued();
  await waitFor(() => boundary.queries.length === 2 && boundary.queries[1]!.users.length === 1);
  assert.equal(boundary.queries[1]!.options.resume, sdkId);
  active.pollQueued();
  await waitFor(() => active.summaryOf(id)?.queue === undefined);
  assert.equal(boundary.queries.length, 2, "sent exactly once");
});

test("a successful later handoff clears the durable failure and is not attempted again", async t => {
  let calls = 0;
  const lines: string[] = [];
  const f = fixture(t, {}, { handoff: async () => { if (++calls === 1) throw new Error("app unavailable"); return "opened"; }, log: line => lines.push(line) });
  const id = await f.create();
  await waitFor(() => lines.length === 1);
  await f.sessions.send(id, "retry-success", "again");
  await waitFor(() => lines.length === 2);
  const record = (JSON.parse(fs.readFileSync(path.join(f.dir, "sessions.json"), "utf8")) as Record<string, unknown>[])[0]!;
  assert.equal(record.desktopHandoff, "attempted");
  assert.equal(record.desktopHandoffAttempts, 2);
  assert.equal(record.desktopHandoffError, undefined);
  await f.sessions.send(id, "after-success", "again");
  await waitFor(() => f.fake.users.length === 3 && f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(calls, 2);
});

test("handoff does not reopen a conversation already owned by Desktop with RC off", async t => {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-existing-"));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  const registry = new Map<string, DesktopProcess>();
  let calls = 0;
  const f = fixture(t, { permission: true }, { desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "",
    handoff: async () => { calls++; return "opened"; }, modOfferMs: 5, log() {} });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  registry.set("sdk-1", { sessionId: "sdk-1", pid: 42, status: "idle" });
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  await f.sessions.pollDesktop();
  assert.equal(calls, 0);
  assert.equal(f.fake.spies.close, 1, "the idle SDK stops rather than remaining a second writer");
  await f.sessions.send(id, "after-adoption", "the phone keeps going while the app is idle");
  await waitFor(() => f.fake.users.length === 2);
});

for (const status of ["pending", "opening"]) test(`a ${status} Desktop handoff recovers and retries without a new phone turn`, async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  f.sessions.shutdown();
  const file = path.join(f.dir, "sessions.json");
  const records: { desktopHandoff: string; desktopHandoffAttempts: number }[] = JSON.parse(fs.readFileSync(file, "utf8"));
  records[0]!.desktopHandoff = status;
  records[0]!.desktopHandoffAttempts = status === "opening" ? 1 : 0;
  fs.writeFileSync(file, JSON.stringify(records));
  let now = Date.now(), calls = 0;
  const requests: string[] = [];
  const recovered = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: () => { throw new Error("must not spawn another SDK writer"); }, now: () => now,
    handoff: async request => { requests.push(request.sessionId); if (++calls === 1) throw new Error("temporary launcher failure"); return "opened"; }, log() {}, onEvent() {}, onSessions() {} });
  f.instances.push(recovered);
  recovered.recover();
  await recovered.pollDesktop();
  await nextTick(); await nextTick();
  assert.equal(calls, 1);
  assert.ok(recovered.log(id).tail().events.some(e => e.kind === "notice" && e.code === "desktop_handoff_retry"));
  await recovered.pollDesktop();
  assert.equal(calls, 1, "retry has a delay, not a tight poll loop");
  now += 30_000;
  await recovered.pollDesktop();
  await nextTick(); await nextTick();
  assert.equal(calls, 2);
  assert.deepEqual(requests, ["sdk-1", "sdk-1"], "the same transcript is handed over, never a fork");
  assert.ok(recovered.log(id).tail().events.some(e => e.kind === "notice" && e.code === "desktop_handoff_requested"));
  assert.equal(recovered.log(id).tail().events.filter(e => e.kind === "user").length, 1);
  now += 60_000;
  await recovered.pollDesktop();
  assert.equal(calls, 2, "a confirmed launcher request is not repeated");
});

test("attention: a permission request is set, survives `seen`, and clears when the approval is answered", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  assert.equal(f.sessions.summaryOf(id)?.attention?.reason, "permission");
  // Looking at the session (seen) must NOT clear a permission request.
  assert.equal(f.sessions.markSeen(id), false);
  assert.equal(f.sessions.summaryOf(id)?.attention?.reason, "permission");
  // Answering it clears the permission attention; the turn then finishes unseen, so "finished" appears.
  await f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.notEqual(f.sessions.summaryOf(id)?.attention?.reason, "permission");
});

test("real host transitions classify identically in home sections and switcher glyphs", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  const state = () => {
    const snapshot = f.sessions.list().find(s => s.id === id)!;
    return [sessionGroup(snapshot), sidebarState(snapshot)];
  };
  assert.deepEqual(state(), ["working", "running"]);
  await waitFor(() => f.permissions.pending(id).length === 1);
  assert.deepEqual(state(), ["input", "waiting"]);
  f.sessions.markSeen(id);
  assert.deepEqual(state(), ["input", "waiting"], "looking does not answer an approval");
  await f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.deepEqual(state(), ["review", "unread"]);
  f.sessions.markSeen(id);
  assert.deepEqual(state(), ["done", "read"]);
});

test("attention: a finished turn is marked unseen, cleared by seen, and restorable", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(f.sessions.summaryOf(id)?.attention?.reason, "finished");
  assert.equal(f.sessions.markSeen(id), true);
  assert.equal(f.sessions.summaryOf(id)?.attention, null);
  assert.equal(f.sessions.markUnread(id).reason, "finished");
  assert.equal(f.sessions.summaryOf(id)?.attention?.reason, "finished");
});

test("a session read on the phone loses the app's unread dot until newer activity, and that survives a restart", async t => {
  let now = 3_000_000;
  const cliId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const app = claudeAppData(t, cliId);
  const sends: number[] = [];
  const f = fixture(t, {}, { queryFn: scriptedQuery({}, cliId).queryFn, now: () => now, desktopSidebar: { root: app.root }, onSessions: () => sends.push(now) });
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const listed = (instance = f.sessions) => instance.list().find(s => s.id === id);
  const listState = () => JSON.parse(fs.readFileSync(path.join(f.dir, "list-state.json"), "utf8")) as { readAt: Record<string, number> };
  assert.equal(listed()?.unread, true, "the app lists the session as unread and nobody read it yet");
  // A look after the last activity clears the dot and records the activity it covered, not a later clock.
  const before = sends.length;
  assert.equal(f.sessions.markSeen(id), true);
  assert.equal(listed()?.unread, false);
  assert.equal(listState().readAt[id], 3_000_000);
  assert.ok(sends.length > before, "clearing the dot resends the list");
  // A presence ping that finds nothing new neither rewrites the file nor resends the list.
  const recorded = listState().readAt[id], resent = sends.length;
  now += 1000;
  assert.equal(f.sessions.markSeen(id), false);
  assert.equal(listState().readAt[id], recorded);
  assert.equal(sends.length, resent);
  // A restart keeps what the phone read.
  const restored = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: scriptedQuery({}, cliId).queryFn, now: () => now,
    desktopSidebar: { root: app.root }, onEvent() {}, onSessions() {}, log() {} });
  f.instances.push(restored);
  assert.equal(listed(restored)?.unread, false, "the read record is durable");
  // Newer activity in the app is unread again (the sidebar snapshot is cached for 3 s).
  app.row(3_001_000); now += 3001;
  assert.equal(listed(restored)?.unread, true);
  assert.equal(listed()?.unread, true);
  assert.equal(f.sessions.markSeen(id), true);
  assert.equal(listed()?.unread, false);
  // Mark unread forgets the record, so the app's unread set can show the dot again.
  f.sessions.markUnread(id);
  assert.equal(listed()?.unread, true);
  assert.equal(Object.hasOwn(listState().readAt, id), false);
});

test("nextAttention maps a state change to the right reason", () => {
  const at = 100;
  assert.deepEqual(nextAttention(null, "running", "waiting", at), { reason: "permission", at });
  assert.deepEqual(nextAttention(null, "starting", "error", at), { reason: "failed", at });
  assert.deepEqual(nextAttention(null, "running", "idle", at), { reason: "finished", at });
  assert.equal(nextAttention(null, "starting", "idle", at), null); // a fresh session that never ran
  assert.equal(nextAttention({ reason: "finished", at }, "idle", "running", at), null);
  assert.equal(nextAttention({ reason: "permission", at }, "waiting", "idle", at)?.reason, "finished");
  // No transition keeps what is there.
  assert.deepEqual(nextAttention({ reason: "failed", at }, "error", "error", at), { reason: "failed", at });
});

test("archive: the flag round-trips, /exit archives, and nothing is deleted", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(f.sessions.summaryOf(id)?.archived, undefined);
  const seq = f.sessions.log(id).lastSeq;
  assert.equal(f.sessions.setArchived(id, true), true);
  assert.equal(f.sessions.summaryOf(id)?.archived, true);
  assert.equal(f.sessions.list().find(x => x.id === id)?.archived, true);
  assert.equal(f.sessions.setArchived(id, true), false, "archiving twice changes nothing");
  assert.equal(f.sessions.log(id).lastSeq, seq, "archiving touches no log");
  assert.equal(f.sessions.setArchived(id, false), true);
  assert.equal(f.sessions.summaryOf(id)?.archived, undefined);
  // /exit is the composer's archive path: it sets the flag and sends no turn.
  f.sessions.send(id, "exit-1", "/exit");
  assert.equal(f.sessions.summaryOf(id)?.archived, true);
  assert.equal(f.sessions.log(id).lastSeq, seq, "no turn is sent for /exit");
  // Durable: the flag is in list-state.json, so a restart keeps it.
  assert.ok((JSON.parse(fs.readFileSync(path.join(f.dir, "list-state.json"), "utf8")) as { archived: string[] }).archived.includes(id));
});

test("summarize uses Bash's first line, cwd-relative Read paths and Grep pattern plus path", () => {
  const cwd = path.resolve(os.tmpdir(), "summary-project");
  assert.equal(summarize("Bash", { command: "ls -la\npwd" }, cwd), "ls -la");
  assert.equal(summarize("Bash", { command: "\n\nls\npwd" }, cwd), "ls");
  assert.equal(summarize("Read", { file_path: path.join(cwd, "src", "index.ts") }, cwd), path.join("src", "index.ts"));
  if (!posixPaths) {
    const forward = path.join(cwd, "src", "index.ts").replaceAll("\\", "/");
    const drive = forward[0]!;
    const otherDriveCase = (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + forward.slice(1);
    assert.equal(summarize("Read", { file_path: otherDriveCase }, cwd), path.join("src", "index.ts"));
  }
  assert.equal(summarize("Read", { file_path: cwd }, cwd), ".");
  const outside = `${cwd}-other/file.ts`;
  assert.equal(summarize("Read", { file_path: outside }, cwd), outside);
  assert.equal(summarize("Grep", { pattern: "needle", path: path.join(cwd, "src") }, cwd), "needle  src");
  assert.equal(summarize("Grep", { pattern: "needle" }, cwd), "needle");
});

test("receipts go pending to completed on disk, and a completed resend never re-runs", { timeout: TEST_TIMEOUT }, async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  const stored = JSON.parse(fs.readFileSync(path.join(f.dir, "receipts.json"), "utf8")) as { key: string; state: string }[];
  assert.ok(stored.some(r => r.key === "create:create-1" && r.state === "completed"), "create receipt completed on disk");
  assert.ok(stored.some(r => r.key === `send:${id}:create-1` && r.state === "completed"), "send receipt completed on disk");
  const users = f.fake.users.length;
  assert.equal(await f.sessions.send(id, "create-1", "ping"), id);
  f.sessions.send(id, "send-1", "again");
  await waitFor(() => f.fake.users.length === users + 1);
  assert.equal(await f.sessions.send(id, "send-1", "again"), id);
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  assert.equal(f.fake.users.length, users + 1, "completed resends ack without running again");
});

function reopen(t: TestContext, f: ReturnType<typeof fixture>) {
  const permissions = PermissionQueue.open(f.permissionsFile);
  const fake = scriptedQuery();
  const recovered = new Sessions({ dir: f.dir, router, permissions, queryFn: fake.queryFn, coalesceMs: 5, onEvent: () => {}, onSessions: () => {} });
  f.instances.push(recovered);
  return { permissions, fake, recovered };
}

test("a send resend orphaned by a restart answers outcome_unknown without running", { timeout: TEST_TIMEOUT }, async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  // The first attempt wrote pending, then the host died before completing it.
  MessageReceipts.open(path.join(f.dir, "receipts.json")).begin(`send:${id}:orphan-1`, id);
  f.sessions.shutdown();
  const { fake, recovered } = reopen(t, f);
  assert.throws(() => recovered.send(id, "orphan-1", "lost turn"), /전송 결과를 확인할 수 없음/);
  assert.equal(fake.users.length, 0, "nothing reached the SDK");
  assert.equal(fake.options.length, 0);
  assert.equal(recovered.log(id).readAfter(0).events.filter(e => e.kind === "user" && e.clientMsgId === "orphan-1").length, 0);
});

test("a create resend orphaned by a restart answers outcome_unknown", { timeout: TEST_TIMEOUT }, async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  MessageReceipts.open(path.join(f.dir, "receipts.json")).begin("create:orphan-create", "");
  f.sessions.shutdown();
  const { fake, recovered } = reopen(t, f);
  assert.throws(() => recovered.create({ clientMsgId: "orphan-create", cwd: f.cwd, model: "x", effort: null, text: "lost session" }), /전송 결과를 확인할 수 없음/);
  assert.equal(fake.options.length, 0);
  assert.equal(recovered.list().length, 1, "no duplicate session was started");
  void id;
});

// 2026-10-22: a message queued on the phone during a 25-minute turn was still on the phone three
// minutes after the turn ended — the app was asleep in a pocket. The host holds the queue now.
test("a queued message waits for the turn, then goes one at a time with no phone attached", { timeout: TEST_TIMEOUT }, async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.enqueue(id, "q-1", "first queued");
  f.sessions.enqueue(id, "q-2", "second queued");
  f.sessions.enqueue(id, "q-1", "first queued");
  assert.equal(f.fake.users.length, 1, "nothing goes while the turn waits on a permission");
  assert.deepEqual(f.sessions.summaryOf(id)?.queue?.map(item => [item.id, item.text]), [["q-1", "first queued"], ["q-2", "second queued"]], "a resent id is queued once");
  assert.equal(f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow"), true);
  await waitFor(() => f.fake.users.length === 2);
  assert.equal(f.fake.users[1]!.message.content, "first queued");
  // The second waits for the turn the first started, which is now waiting on its own permission.
  await waitFor(() => f.permissions.pending(id).length === 1);
  await delay(30);
  assert.equal(f.fake.users.length, 2);
  assert.deepEqual(f.sessions.summaryOf(id)?.queue?.map(item => item.id), ["q-2"]);
  assert.equal(f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow"), true);
  await waitFor(() => f.fake.users.length === 3);
  assert.equal(f.fake.users[2]!.message.content, "second queued");
  assert.equal(f.sessions.summaryOf(id)?.queue, undefined);
  // The queue's sends are ordinary user messages in the log, under the phone's ids.
  const users = f.sessions.log(id).readAfter(0).events.filter(e => e.kind === "user").map(e => e.kind === "user" ? e.clientMsgId : "");
  assert.deepEqual(users.slice(-2), ["q-1", "q-2"]);
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "deny");
});

test("an idle session takes a queued message at once; Stop holds the queue until a send or resume", { timeout: TEST_TIMEOUT }, async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.enqueue(id, "held-1", "after the stop");
  await f.sessions.interrupt(id);
  f.sessions.holdQueue(id);
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  await delay(30);
  assert.equal(f.fake.users.length, 1, "a held queue does not go when the turn ends");
  assert.equal(f.sessions.summaryOf(id)?.queueHeld, true);
  // Edit: the text comes back and the item is gone.
  assert.deepEqual(f.sessions.removeQueued(id, "held-1"), { text: "after the stop", attachments: [] });
  assert.equal(f.sessions.summaryOf(id)?.queue, undefined);
  assert.equal(f.sessions.summaryOf(id)?.queueHeld, undefined);
  f.sessions.enqueue(id, "held-2", "again");
  f.sessions.holdQueue(id);
  await delay(30);
  assert.equal(f.fake.users.length, 2, "an idle, unheld session took held-2 at once");
  assert.equal(f.fake.users[1]!.message.content, "again");
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.enqueue(id, "held-3", "resumed");
  f.sessions.holdQueue(id);
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  await delay(30);
  assert.equal(f.fake.users.length, 2);
  f.sessions.resumeQueue(id);
  await waitFor(() => f.fake.users.length === 3);
  assert.equal(f.fake.users[2]!.message.content, "resumed");
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "deny");
});

test("taking a queued message back restores upload-shaped attachments and retains bytes until the edited send", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  const photo = Buffer.from("editing photo").toString("base64");
  const file = Buffer.from("editing document").toString("base64");
  const attachments = [
    { blob: f.sessions.log(id).image(photo), name: "photo.png", mediaType: "image/png" },
    { blob: f.sessions.log(id).image(file), name: "notes.txt", mediaType: "text/plain" },
  ];
  f.sessions.enqueue(id, "edit-queued", "original", attachments);
  const removed = f.sessions.removeQueued(id, "edit-queued");
  assert.deepEqual(removed, { text: "original", attachments });
  assert.equal(f.sessions.summaryOf(id)?.queue, undefined);
  assert.equal(fs.readdirSync(path.join(f.dir, "queue")).length, 2, "removing the queue item did not delete its draft files");
  assert.equal(f.sessions.removeQueued(id, "edit-queued"), null);
  // A desktop rebase can discard upload blobs after the item was returned to the composer.
  fs.rmSync(path.join(f.dir, "sessions", id, "blobs"), { recursive: true });
  assert.equal(f.sessions.blob(id, attachments[0]!.blob), photo);
  assert.equal(f.sessions.blob(id, attachments[1]!.blob), file);
  const retained = (await import("../src/queue.ts")).SendQueue.open(f.dir);
  assert.equal(retained.editingBlob(id, attachments[0]!.blob), photo, "the editing bytes also survive a host restart");
  await f.sessions.send(id, "edited-new-id", "edited", removed!.attachments);
  await waitFor(() => f.fake.users.length === 2);
  const content = f.fake.users[1]!.message.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.find(block => block.type === "image")?.source.data, photo);
  const files = fs.readdirSync(path.join(f.cwd, ".ripple-attachments"));
  assert.equal(fs.readFileSync(path.join(f.cwd, ".ripple-attachments", files[0]!), "utf8"), "editing document");
  assert.equal(fs.readdirSync(path.join(f.dir, "queue")).length, 0, "the accepted edited send releases draft files");
  assert.equal(f.sessions.log(id).blob(attachments[0]!.blob), photo, "the event keeps its own image bytes");
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
});

test("an edited photo retained across a new epoch is published under its new snapshot id", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  const photo = Buffer.from("retained photo").toString("base64");
  const old = f.sessions.log(id);
  const blob = old.image(photo);
  f.sessions.enqueue(id, "edit-across-epoch", "original", [{ blob, name: "photo.png", mediaType: "image/png" }]);
  const edited = f.sessions.removeQueued(id, "edit-across-epoch")!;
  f.sessions.stop(id);
  await nextTick();
  f.sessions.shutdown();
  fs.rmSync(path.join(f.dir, "sessions", id), { recursive: true, force: true });
  const { recovered } = reopen(t, f);
  recovered.recover();
  assert.notEqual(recovered.log(id).epoch, old.epoch);
  await recovered.send(id, "edited-in-new-epoch", edited.text, edited.attachments);
  const event = recovered.log(id).tail().events.find(e => e.kind === "user" && e.clientMsgId === "edited-in-new-epoch");
  assert.ok(event?.images?.[0]?.blob);
  assert.notEqual(event.images[0].blob, blob);
  assert.equal(recovered.blob(id, event.images[0].blob), photo);
  assert.equal(recovered.blob(id, blob), null, "the old draft id is released after the accepted send");
});

test("send-now puts a queued message into the running turn; the queue survives a host restart", { timeout: TEST_TIMEOUT }, async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.enqueue(id, "now-1", "steer this in");
  f.sessions.enqueue(id, "later-1", "kept on disk");
  await f.sessions.sendQueued(id, "now-1");
  // Sent at once into the running query (the scripted one reads it when its turn ends).
  assert.ok(f.sessions.log(id).readAfter(0).events.some(e => e.kind === "user" && e.clientMsgId === "now-1"));
  assert.deepEqual(f.sessions.summaryOf(id)?.queue?.map(item => item.id), ["later-1"]);
  await assert.rejects(f.sessions.sendQueued(id, "gone"), /no longer queued/);
  // A new host over the same directory still holds what was queued.
  const reopened = JSON.parse(fs.readFileSync(path.join(f.dir, "queue.json"), "utf8"));
  assert.deepEqual(reopened[id].items.map((item: { id: string }) => item.id), ["later-1"]);
  assert.throws(() => f.sessions.enqueue("missing", "x-1", "text"), /no such session/);
  assert.throws(() => f.sessions.enqueue(id, "bad id!", "text"), /Invalid message id/);
  assert.throws(() => f.sessions.enqueue(id, "x-2", "  "), /Nothing to queue/);
  f.sessions.removeQueued(id, "later-1");
  await waitFor(() => f.permissions.pending(id).length >= 1);
  for (const p of f.permissions.pending(id)) f.sessions.decide(id, p.id, "deny");
});

test("one message id keeps one content: a reused id with other words is refused, the same words are acknowledged", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const first = f.sessions.send(id, "same-id", "first words");
  await Promise.resolve(first);
  await waitFor(() => f.sessions.log(id).readAfter(0).events.some(e => e.kind === "user" && e.clientMsgId === "same-id"));
  // A retry of the same message is answered without running again.
  assert.equal(f.sessions.send(id, "same-id", "first words"), id);
  // Different words under that id are a new message wearing a used id: say so instead of a false success.
  assert.throws(() => f.sessions.send(id, "same-id", "other words"), /같은 메시지 ID에 다른 내용이 이미 접수되었습니다/);
  const users = () => f.sessions.log(id).readAfter(0).events.filter(e => e.kind === "user" && e.clientMsgId === "same-id");
  assert.equal(users().length, 1, "the refused reuse never becomes a second message");
  // An attachment change is a content change too.
  assert.throws(() => f.sessions.send(id, "same-id", "first words", [{ blob: "b", name: "photo.png", mediaType: "image/png" }]), /같은 메시지 ID에 다른 내용이 이미 접수되었습니다/);
});

test("environment creation attaches once, sends once, and adopts the desktop CLI identity without duplicate rows", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-app-"));
  const projects = path.join(root, "projects"); fs.mkdirSync(projects);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new Map<string, DesktopProcess>();
  const calls: string[] = [];
  let reads = 0, handoffs = 0;
  const client = new BridgeClient({ auth: () => ({ accessToken: "fake", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
    const target = String(url);
    if (options?.method === "POST" && target.endsWith("/sessions")) { calls.push("create"); return Response.json({ session: { id: "cse_abc" } }); }
    if (options?.method === "POST") { calls.push("send"); return Response.json({}); }
    if (target.endsWith("/cse_abc")) { calls.push("read"); return Response.json(++reads < 3 ? {} : { worker_status: "idle" }); }
    if (target.includes("/stream")) return new Response(new ReadableStream({ start(controller) { options?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }));
    return Response.json({ data: [] });
  } });
  client.control = async (_id, _requestId, request) => { calls.push(request.subtype); };
  const f = fixture(t, {}, { environmentRoot: root, environmentWaitMs: 500, environmentPollMs: 1, desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "", bridgeClient: client, handoff: async () => { handoffs++; return "opened"; }, log() {} });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ lastKnownAccountUuid: "account" }));
  fs.writeFileSync(path.join(root, "remote-control-state.json"), JSON.stringify({ identities: { "org:account": { serve: "on", folders: { [f.cwd]: { environmentId: "env_abc" } } } } }));
  const id = await f.create();
  assert.deepEqual(calls.filter(call => ["create", "read", "send"].includes(call)), ["create", "read", "read", "read", "send"]);
  assert.ok(calls.includes("set_model") && calls.includes("apply_flag_settings") && calls.includes("set_permission_mode"));
  assert.equal(f.fake.options.length, 0); assert.equal(handoffs, 0);
  assert.equal(await f.create(), id);
  assert.equal(await f.sessions.send(id, "create-1", "ping"), id);
  assert.equal(calls.filter(call => call === "send").length, 1);
  const cli = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  fs.mkdirSync(path.join(projects, "project"));
  fs.writeFileSync(path.join(projects, "project", `${cli}.jsonl`), JSON.stringify({ type: "user", uuid: "first", cwd: f.cwd, message: { content: "ping" } }) + "\n" +
    JSON.stringify({ type: "assistant", uuid: "first-answer", message: { model: "claude-test", content: [{ type: "text", text: "first answer" }] } }) + "\n");
  const scope = path.join(root, "claude-code-sessions", "account", "org"); fs.mkdirSync(scope, { recursive: true });
  fs.writeFileSync(path.join(scope, "local_target.json"), JSON.stringify({ cliSessionId: cli, model: "sonnet", effort: "xhigh" }));
  registry.set(cli, { sessionId: cli, pid: 42, status: "idle", bridgeSessionId: "session_abc" });
  await waitFor(() => f.events.some(row => row.session === id && row.event.kind === "assistant" && row.event.text === "first answer"));
  assert.equal(f.sessions.list().length, 1);
  assert.equal((JSON.parse(fs.readFileSync(path.join(f.dir, "sessions.json"), "utf8")) as { sdkSessionId: string }[])[0]!.sdkSessionId, cli);
  assert.deepEqual(f.sessions.settingsJobs.pending("local_helper").map(job => [job.model, job.effort]), [["claude-test", "high"]]);
});

// The app starts these sessions in acceptEdits: a stricter mode must be confirmed before the first message.
for (const applied of [false, true]) test(`environment plan mode ${applied ? "confirmed sends" : "unconfirmed holds"} the first message`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-app-"));
  const projects = path.join(root, "projects"); fs.mkdirSync(projects);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sends = 0;
  const client = new BridgeClient({ auth: () => ({ accessToken: "fake", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
    const target = String(url);
    if (options?.method === "POST" && target.endsWith("/sessions")) return Response.json({ session: { id: "cse_abc" } });
    if (options?.method === "POST") { sends++; return Response.json({}); }
    if (target.endsWith("/cse_abc")) return Response.json({ worker_status: "idle" });
    if (target.includes("/stream")) return new Response(new ReadableStream({ start(controller) { options?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }));
    return Response.json({ data: [] });
  } });
  client.control = async (_id, _requestId, request) => {
    if (request.subtype === "set_permission_mode" && !applied) throw new Error("refused");
  };
  const f = fixture(t, {}, { environmentRoot: root, environmentWaitMs: 500, environmentPollMs: 1, environmentModeMs: 50, desktopProjects: projects, desktopRegistry: () => new Map(), desktopProcesses: () => "", bridgeClient: client, handoff: async () => "opened", log() {} });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ lastKnownAccountUuid: "account" }));
  fs.writeFileSync(path.join(root, "remote-control-state.json"), JSON.stringify({ identities: { "org:account": { serve: "on", folders: { [f.cwd]: { environmentId: "env_abc" } } } } }));
  const id = await f.sessions.create({ clientMsgId: "create-1", cwd: f.cwd, model: "claude-test", effort: "high", text: "ping", permissionMode: "plan" });
  assert.equal(sends, applied ? 1 : 0);
  const queued = f.sessions.summaryOf(id)?.queue ?? [];
  if (applied) assert.equal(queued.length, 0);
  else assert.match(queued[0]?.error ?? "", /권한 모드를 Claude 앱에 적용하지 못해/);
});

for (const outcome of ["missing", "mismatch", "ambiguous", "account-mismatch", "4xx", "5xx", "network", "timeout", "send-unknown"] as const) test(`environment ${outcome} follows the safe creation path`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-app-"));
  const projects = path.join(root, "projects"); fs.mkdirSync(projects);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let posts = 0, sends = 0, handoffs = 0;
  const client = new BridgeClient({ auth: () => ({ accessToken: "fake", organizationUuid: "org", ...(outcome === "account-mismatch" ? { accountUuid: "other" } : {}), expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
    const target = String(url);
    if (options?.method === "POST" && target.endsWith("/sessions")) {
      posts++;
      if (outcome === "network") throw new Error("network");
      if (outcome === "4xx" || outcome === "5xx") return new Response(null, { status: outcome === "4xx" ? 400 : 503 });
      return Response.json({ id: "cse_abc" });
    }
    if (options?.method === "POST") { sends++; if (outcome === "send-unknown") throw new Error("network"); return Response.json({}); }
    if (target.endsWith("/cse_abc")) return Response.json(outcome === "timeout" ? {} : { worker_status: "idle" });
    if (target.includes("/stream")) return new Response(new ReadableStream({ start(controller) { options?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }));
    return Response.json({ data: [] });
  } });
  client.control = async () => {};
  const f = fixture(t, {}, { environmentRoot: root, environmentWaitMs: 5, environmentPollMs: 1, desktopProjects: projects, desktopRegistry: () => new Map(), desktopProcesses: () => "", bridgeClient: client, handoff: async () => { handoffs++; return "opened"; }, log() {} });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ lastKnownAccountUuid: "account" }));
  if (outcome !== "missing") fs.writeFileSync(path.join(root, "remote-control-state.json"), JSON.stringify({ identities: { "org:account": { serve: "on", folders: { [outcome === "mismatch" ? `${f.cwd}-other` : f.cwd]: { environmentId: "env_abc" } } }, ...(outcome === "ambiguous" ? { "org:other": { serve: "on", folders: {} } } : {}) } }));
  const id = await f.create();
  if (["missing", "mismatch", "ambiguous", "account-mismatch", "4xx"].includes(outcome)) {
    await waitFor(() => f.fake.options.length === 1);
    assert.equal(posts, outcome === "4xx" ? 1 : 0);
    assert.equal(f.sessions.summaryOf(id)?.queue, undefined);
  } else {
    assert.equal(posts, 1); assert.equal(f.fake.options.length, 0); assert.equal(handoffs, 0);
    assert.equal(f.sessions.summaryOf(id)?.state, "error");
    assert.equal(f.sessions.summaryOf(id)?.queue?.[0]?.text, "ping");
    assert.equal(f.sessions.summaryOf(id)?.queueHeld, true);
    assert.ok(f.sessions.log(id).tail().events.some(event => event.kind === "result" && !event.ok));
    assert.equal(await f.create(), id);
    assert.equal(posts, 1);
    if (outcome === "send-unknown") {
      assert.equal(sends, 1);
      await assert.rejects(f.sessions.sendQueued(id, "create-1"), /전송 결과를 확인할 수 없음/);
      assert.equal(sends, 1);
    }
  }
});

async function modFixture(t: TestContext, modOfferMs = 100, modResultMs = 100, waitForExit = false, appRoot?: string) {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "mod-inbox-projects-"));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  const sdkId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const registry = new Map<string, DesktopProcess>();
  const boundary = controlledQueries(true, waitForExit);
  const f = fixture(t, {}, { queryFn: boundary.queryFn, desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "", modOfferMs, modResultMs,
    ...(appRoot ? { desktopSidebar: { root: appRoot } } : {}),
    handoff: async () => { registry.set(sdkId, { sessionId: sdkId, pid: 42, status: "idle" }); return "opened"; }, log() {} });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  fs.mkdirSync(path.join(projects, "project"));
  fs.writeFileSync(path.join(projects, "project", `${sdkId}.jsonl`), JSON.stringify({ type: "user", uuid: "first", cwd: f.cwd, message: { content: "ping" } }) + "\n");
  boundary.queries[0]!.emit({ type: "system", subtype: "init", session_id: sdkId });
  boundary.queries[0]!.emit({ type: "result", subtype: "success" });
  if (waitForExit) { await waitFor(() => boundary.queries[0]!.closed); boundary.queries[0]!.exitReply.resolve(); }
  await waitFor(() => registry.has(sdkId) && boundary.queries[0]!.closed);
  return { ...f, id, sdkId, boundary, registry, projects };
}

const transcriptLine = (value: unknown) => JSON.stringify(value) + "\n";

function appNativeModFixture(t: TestContext, modOfferMs = 500) {
  const id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const app = claudeAppData(t, id);
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "app-native-mod-"));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  const registry = new Map<string, DesktopProcess>([[id, { sessionId: id, pid: 42, status: "idle" }]]);
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn, desktopProjects: projects, desktopRegistry: () => registry,
    desktopProcesses: () => "", desktopSidebar: { root: app.root }, modOfferMs, modResultMs: 500, log() {} });
  fs.mkdirSync(path.join(projects, "project"));
  const file = path.join(projects, "project", `${id}.jsonl`);
  fs.writeFileSync(file, transcriptLine({ type: "user", uuid: "first", cwd: f.cwd, message: { content: "From the app" } }));
  assert.equal(f.sessions.summaryOf(id)?.origin, "desktop");
  return { ...f, id, registry, boundary, file };
}

for (const order of ["report-first", "transcript-first"] as const) test(`an app-created session delivers through the mod exactly once with ${order}`, async t => {
  const f = appNativeModFixture(t);
  f.sessions.watchAttached(new Set([f.id]));
  assert.equal(await f.sessions.send(f.id, "native-send", "Phone message"), f.id);
  assert.deepEqual(f.sessions.modInbox.pending(f.id).map(offer => [offer.itemId, offer.text]), [["native-send", "Phone message"]]);
  assert.equal(f.sessions.modInbox.claim("native-send"), true);
  const write = async () => {
    fs.appendFileSync(f.file, transcriptLine({ type: "user", uuid: "app-echo", cwd: f.cwd, message: { content: "Phone message" } }) +
      transcriptLine({ type: "assistant", uuid: "app-answer", message: { model: "test", content: [{ type: "text", text: "App response" }] } }));
    await f.sessions.pollDesktop();
  };
  if (order === "transcript-first") await write();
  assert.equal(f.sessions.modInbox.result("native-send", "submitted"), true);
  assert.equal(MessageReceipts.open(path.join(f.dir, "receipts.json")).status(`send:${f.id}:native-send`), "completed");
  if (order === "report-first") await write();
  assert.equal(f.sessions.summaryOf(f.id)?.queue, undefined);
  const events = f.sessions.log(f.id).readAfter(0).events;
  const view = reduce(events);
  assert.equal(view.items.filter(item => item.type === "user" && item.text === "Phone message").length, 1);
  assert.ok(view.items.some(item => item.type === "assistant" && item.text === "App response"));
  assert.ok(f.events.some(row => row.session === f.id), "transcript growth notifies the phone to refresh its snapshot");
  // The phone clears its own "sending" copy only on a user event carrying its id.
  const phoneIds = () => f.sessions.log(f.id).readAfter(0).events.flatMap(e => e.kind === "user" && e.text === "Phone message" ? [e.clientMsgId] : []);
  assert.deepEqual(phoneIds(), ["native-send"]);
  const epoch = f.sessions.log(f.id).epoch;
  assert.equal(await f.sessions.send(f.id, "native-send", "Phone message"), f.id);
  assert.deepEqual(f.sessions.modInbox.pending(f.id), []);
  fs.appendFileSync(f.file, transcriptLine({ type: "assistant", uuid: "more", message: { model: "test", content: [{ type: "text", text: "More response" }] } }));
  await f.sessions.pollDesktop();
  assert.notEqual(f.sessions.log(f.id).epoch, epoch);
  assert.deepEqual(phoneIds(), ["native-send"], "a rebuild keeps the phone's id on the same line");
  assert.equal(f.sessions.summaryOf(f.id)?.origin, "desktop", "delivery never creates a host-owned record");
  assert.equal(fs.existsSync(path.join(f.dir, "sessions.json")), false);
  assert.equal(f.boundary.queries.length, 0);
});

test("an app-created session queues while busy and offers once the registry becomes idle", async t => {
  const f = appNativeModFixture(t);
  f.registry.get(f.id)!.status = "busy";
  await f.sessions.send(f.id, "busy-native", "Wait for idle");
  assert.equal(f.sessions.summaryOf(f.id)?.queue?.[0]?.error, DESKTOP_BUSY);
  assert.deepEqual(f.sessions.modInbox.pending(f.id), []);
  f.sessions.pollQueued();
  assert.equal(f.boundary.queries.length, 0);
  f.registry.get(f.id)!.status = "idle";
  f.sessions.pollQueued();
  await waitFor(() => f.sessions.modInbox.pending(f.id).length === 1);
  assert.equal(f.sessions.modInbox.claim("busy-native"), true);
  assert.equal(f.sessions.modInbox.result("busy-native", "submitted"), true);
  assert.equal(f.boundary.queries.length, 0);
});

test("an unclaimed app-created offer stays queued with Remote Control guidance, including send-now", async t => {
  const f = appNativeModFixture(t, 20);
  await f.sessions.send(f.id, "unclaimed-native", "Keep this message");
  await waitFor(() => f.sessions.summaryOf(f.id)?.queue?.[0]?.error === DESKTOP_WAITING);
  assert.equal(f.sessions.modInbox.claim("unclaimed-native"), false);
  assert.equal(MessageReceipts.open(path.join(f.dir, "receipts.json")).status(`send:${f.id}:unclaimed-native`), null);
  await assert.rejects(f.sessions.sendQueued(f.id, "unclaimed-native"), DesktopBlockedError);
  assert.equal(f.sessions.summaryOf(f.id)?.queue?.[0]?.text, "Keep this message");
  assert.equal(f.boundary.queries.length, 0);
  assert.equal(f.sessions.removeQueued(f.id, "unclaimed-native")?.text, "Keep this message");
});

for (const kind of ["attachment", "slash", "clear", "interrupt"] as const) test(`an app-created ${kind} send remains blocked`, async t => {
  const f = appNativeModFixture(t);
  const attachments = kind === "attachment" ? [{ blob: f.sessions.log(f.id).image(Buffer.from("photo").toString("base64")), name: "photo.png", mediaType: "image/png" }] : [];
  for (const status of ["idle", "busy"] as const) {
    f.registry.get(f.id)!.status = status;
    assert.throws(() => f.sessions.send(f.id, `blocked-${kind}-${status}`, kind === "slash" ? "/help" : kind === "clear" ? "/clear" : "Phone message", attachments, kind === "interrupt" ? "interrupt" : "steer"), DesktopBlockedError);
  }
  assert.deepEqual(f.sessions.modInbox.pending(f.id), []);
  assert.equal(f.boundary.queries.length, 0);
});

test("a closed app-created session can still continue on the host", async t => {
  const f = appNativeModFixture(t);
  f.registry.delete(f.id);
  await f.sessions.send(f.id, "closed-native", "Continue here");
  await waitFor(() => f.boundary.queries.length === 1);
  assert.equal(f.boundary.queries[0]!.options.resume, f.id);
  assert.equal(f.sessions.summaryOf(f.id)?.origin, "host");
});

test("an idle handed-off session tails app turns without a phone attached", async t => {
  const f = await modFixture(t, 500, 500);
  const file = path.join(f.projects, "project", `${f.sdkId}.jsonl`);
  fs.appendFileSync(file, transcriptLine({ type: "user", uuid: "app-user", cwd: f.cwd, message: { content: "From the app" } }) +
    transcriptLine({ type: "assistant", uuid: "app-answer", message: { model: "test", content: [{ type: "text", text: "App answer" }] } }));
  await f.sessions.pollDesktop();
  const events = f.sessions.log(f.id).readAfter(0).events;
  assert.ok(events.some(e => e.kind === "user" && e.text === "From the app"));
  assert.ok(events.some(e => e.kind === "assistant" && e.text === "App answer"));
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.log(f.id).readAfter(0).events.filter(e => e.kind === "assistant" && e.text === "App answer").length, 1);
});

test("handoff stops reporting the SDK's stored permission mode, including after restart", async t => {
  const boundary = controlledQueries();
  let calls = 0;
  const f = fixture(t, {}, { queryFn: boundary.queryFn, handoff: async () => { calls++; return "opened"; }, log() {} });
  const id = await f.sessions.create({ clientMsgId: "bypass-handoff", cwd: f.cwd, model: "claude-test", effort: "high", text: "ping", permissionMode: "bypassPermissions" });
  await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  query.emit({ type: "system", subtype: "init", session_id: "sdk-bypass", permissionMode: "bypassPermissions" });
  await f.sessions.setMode(id, "bypassPermissions");
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, "bypassPermissions");
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => calls === 1);
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, undefined, "the launcher did not confirm the app's permission mode");
  f.sessions.shutdown();
  const recovered = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: boundary.queryFn, onEvent() {}, onSessions() {} });
  f.instances.push(recovered);
  assert.equal(recovered.summaryOf(id)?.permissionMode, undefined);
  await recovered.send(id, "host-again", "resume on host");
  await waitFor(() => boundary.queries.length === 2);
  assert.equal(boundary.queries[1]!.options.permissionMode, "bypassPermissions", "keep the user's choice for an actual SDK resume");
  assert.equal(recovered.summaryOf(id)?.permissionMode, "bypassPermissions");
});

test("adopting an already open desktop session discards SDK-confirmed permission settings", async t => {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "permission-adoption-"));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  const sdkId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const registry = new Map<string, DesktopProcess>();
  const boundary = controlledQueries();
  const f = fixture(t, {}, { queryFn: boundary.queryFn, desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "", handoff: async () => "opened", log() {} });
  const id = await f.create();
  await waitFor(() => boundary.queries.length === 1);
  const query = boundary.queries[0]!;
  query.emit({ type: "system", subtype: "init", session_id: sdkId });
  await nextTick();
  await f.sessions.setMode(id, "bypassPermissions");
  registry.set(sdkId, { sessionId: sdkId, pid: 42, status: "idle" });
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => query.closed);
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, undefined);
});

test("desktop bridge adoption replaces SDK permission confirmation with desktop evidence", async t => {
  const f = await modFixture(t);
  const file = path.join(f.projects, "project", `${f.sdkId}.jsonl`);
  // A historical SDK confirmation must not outrank the new desktop transcript.
  f.sessions.shutdown();
  const recordsFile = path.join(f.dir, "sessions.json");
  const records = JSON.parse(fs.readFileSync(recordsFile, "utf8")) as { confirmedSettings?: { permissionMode: string } }[];
  records[0]!.confirmedSettings = { permissionMode: "bypassPermissions" };
  fs.writeFileSync(recordsFile, JSON.stringify(records));
  fs.appendFileSync(file, transcriptLine({ type: "user", cwd: f.cwd, uuid: "desktop-prompt", permissionMode: "plan", message: { content: "From desktop" } }));
  f.registry.get(f.sdkId)!.bridgeSessionId = "bridge";
  const client = new BridgeClient({ auth: () => ({ accessToken: "fake", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
    if (String(url).includes("/stream")) return new Response(new ReadableStream({ start(controller) { options?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }));
    return Response.json({ data: [], worker_status: "idle" });
  } });
  client.control = async () => {};
  const active = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: f.boundary.queryFn, desktopProjects: f.projects, desktopRegistry: () => f.registry, desktopProcesses: () => "", bridgeClient: client, onEvent() {}, onSessions() {} });
  f.instances.push(active);
  await active.pollDesktop();
  assert.equal(active.summaryOf(f.id)?.desktopBridge, true);
  assert.equal(active.summaryOf(f.id)?.permissionMode, "plan");
  await active.setMode(f.id, "default");
  assert.equal(active.summaryOf(f.id)?.permissionMode, "default", "a desktop-confirmed control can still override historical transcript settings");
});

test("a handed-off session the app is running shows the app's state, and a stop says to use the app", async t => {
  const f = await modFixture(t, 500, 500);
  assert.equal(f.sessions.summaryOf(f.id)?.state, "idle");
  await f.sessions.interrupt(f.id);
  f.registry.set(f.sdkId, { sessionId: f.sdkId, pid: 42, status: "busy" });
  assert.equal(f.sessions.summaryOf(f.id)?.state, "running");
  await assert.rejects(f.sessions.interrupt(f.id), /Claude 앱에서 직접 중지해 주세요/);
  f.registry.set(f.sdkId, { sessionId: f.sdkId, pid: 42, status: "waiting" });
  assert.equal(f.sessions.summaryOf(f.id)?.state, "waiting");
});

for (const order of ["report-first", "transcript-first"] as const) test(`mod echo is shown once with ${order}`, async t => {
  const f = await modFixture(t, 500, 500);
  const file = path.join(f.projects, "project", `${f.sdkId}.jsonl`);
  await f.sessions.send(f.id, "mod-echo", "same prompt");
  assert.equal(f.sessions.modInbox.claim("mod-echo"), true);
  const write = () => fs.appendFileSync(file, transcriptLine({ type: "user", uuid: "different", cwd: f.cwd, message: { content: "different prompt" } }) +
    transcriptLine({ type: "user", uuid: "app-echo", cwd: f.cwd, message: { content: "same prompt" } }));
  if (order === "report-first") { f.sessions.modInbox.result("mod-echo", "submitted"); write(); await f.sessions.pollDesktop(); }
  else { write(); await f.sessions.pollDesktop(); f.sessions.modInbox.result("mod-echo", "submitted"); }
  const users = f.sessions.log(f.id).readAfter(0).events.filter(e => e.kind === "user");
  assert.equal(users.filter(e => e.text === "same prompt").length, 1);
  assert.equal(users.find(e => e.text === "same prompt")?.clientMsgId, "mod-echo");
  assert.equal(users.filter(e => e.text === "different prompt").length, 1);
  fs.appendFileSync(file, transcriptLine({ type: "user", uuid: "later", cwd: f.cwd, message: { content: "same prompt" } }));
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.log(f.id).readAfter(0).events.filter(e => e.kind === "user" && e.text === "same prompt").length, 2, "a later genuine message is not an echo");
});

test("an app message with an attachment is not mistaken for a text-only mod echo", async t => {
  const f = await modFixture(t, 500, 500);
  const file = path.join(f.projects, "project", `${f.sdkId}.jsonl`);
  await f.sessions.send(f.id, "text-only", "same words");
  assert.equal(f.sessions.modInbox.claim("text-only"), true);
  assert.equal(f.sessions.modInbox.result("text-only", "submitted"), true);
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("photo").toString("base64") } };
  fs.appendFileSync(file, transcriptLine({ type: "user", uuid: "with-image", cwd: f.cwd, message: { content: [{ type: "text", text: "same words" }, image] } }) +
    transcriptLine({ type: "user", uuid: "actual-echo", cwd: f.cwd, message: { content: "same words" } }));
  await f.sessions.pollDesktop();
  const users = f.sessions.log(f.id).readAfter(0).events.filter(e => e.kind === "user" && e.text === "same words");
  assert.equal(users.length, 2);
  assert.ok(users.some(e => e.kind === "user" && e.images?.length === 1 && e.clientMsgId === "with-image"));
  assert.ok(users.some(e => e.kind === "user" && e.clientMsgId === "text-only"));
});

test("an old handed-off record starts tailing at the current end", async t => {
  const f = await modFixture(t);
  f.sessions.shutdown();
  const recordsFile = path.join(f.dir, "sessions.json");
  const records = JSON.parse(fs.readFileSync(recordsFile, "utf8")) as { transcriptOffset?: number }[];
  delete records[0]!.transcriptOffset;
  fs.writeFileSync(recordsFile, JSON.stringify(records));
  const file = path.join(f.projects, "project", `${f.sdkId}.jsonl`);
  fs.appendFileSync(file, transcriptLine({ type: "assistant", uuid: "old", message: { model: "test", content: [{ type: "text", text: "old answer" }] } }));
  const active = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: f.boundary.queryFn, desktopProjects: f.projects, desktopRegistry: () => f.registry, desktopProcesses: () => "", onEvent() {}, onSessions() {} });
  f.instances.push(active);
  await active.pollDesktop();
  assert.equal(active.log(f.id).readAfter(0).events.some(e => e.kind === "assistant" && e.text === "old answer"), false);
  fs.appendFileSync(file, transcriptLine({ type: "assistant", uuid: "new", message: { model: "test", content: [{ type: "text", text: "new answer" }] } }));
  await active.pollDesktop();
  assert.equal(active.log(f.id).readAfter(0).events.filter(e => e.kind === "assistant" && e.text === "new answer").length, 1);
});

test("host turns are not tailed while running or replayed after the writer exits", async t => {
  const f = await modFixture(t, 10, 500);
  const file = path.join(f.projects, "project", `${f.sdkId}.jsonl`);
  await f.sessions.send(f.id, "host-turn", "/help");
  await waitFor(() => f.boundary.queries.length === 2);
  const query = f.boundary.queries[1]!;
  fs.appendFileSync(file, transcriptLine({ type: "user", uuid: "host-echo", cwd: f.cwd, message: { content: "/help" } }) +
    transcriptLine({ type: "assistant", uuid: "host-answer", message: { model: "test", content: [{ type: "text", text: "host answer" }] } }));
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.log(f.id).readAfter(0).events.some(e => e.kind === "assistant" && e.text === "host answer"), false);
  query.emit({ type: "assistant", message: { id: "sdk-answer", model: "test", content: [{ type: "text", text: "host answer" }] } });
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => query.closed);
  await f.sessions.pollDesktop();
  const events = f.sessions.log(f.id).readAfter(0).events;
  assert.equal(events.filter(e => e.kind === "assistant" && e.text === "host answer").length, 1);
  assert.equal(events.filter(e => e.kind === "user" && e.text === "/help").length, 1);
  fs.appendFileSync(file, transcriptLine({ type: "assistant", uuid: "next", message: { model: "test", content: [{ type: "text", text: "next app answer" }] } }));
  await f.sessions.pollDesktop();
  assert.ok(f.sessions.log(f.id).readAfter(0).events.some(e => e.kind === "assistant" && e.text === "next app answer"));
});

test("tailing waits for the SDK process exit and includes its final transcript write in the boundary", async t => {
  const f = await modFixture(t, 500, 500, true);
  const file = path.join(f.projects, "project", `${f.sdkId}.jsonl`);
  await f.sessions.send(f.id, "closing-turn", "/help");
  await waitFor(() => f.boundary.queries.length === 2);
  const query = f.boundary.queries[1]!;
  query.emit({ type: "result", subtype: "success" });
  await waitFor(() => query.closed);
  fs.appendFileSync(file, transcriptLine({ type: "assistant", uuid: "late-host", message: { model: "test", content: [{ type: "text", text: "late host write" }] } }));
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.log(f.id).readAfter(0).events.some(e => e.kind === "assistant" && e.text === "late host write"), false);
  query.exitReply.resolve();
  await nextTick();
  fs.appendFileSync(file, transcriptLine({ type: "assistant", uuid: "app-after-exit", message: { model: "test", content: [{ type: "text", text: "after exit" }] } }));
  await f.sessions.pollDesktop();
  const events = f.sessions.log(f.id).readAfter(0).events;
  assert.equal(events.some(e => e.kind === "assistant" && e.text === "late host write"), false);
  assert.equal(events.filter(e => e.kind === "assistant" && e.text === "after exit").length, 1);
});

test("mod claim persists before success, refuses queue actions, and submitted is idempotent", async t => {
  const f = await modFixture(t, 500, 500);
  await f.sessions.send(f.id, "mod-one", "private message");
  assert.equal(f.sessions.modInbox.pending("other").length, 0);
  assert.deepEqual(f.sessions.modInbox.pending(f.sdkId).map(offer => [offer.itemId, offer.text]), [["mod-one", "private message"]]);
  assert.equal(f.sessions.modInbox.claim("mod-one"), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "queue.json"), "utf8"))[f.id].items[0].claimedBy, "mod");
  assert.equal(f.sessions.modInbox.claim("mod-one"), false);
  assert.throws(() => f.sessions.removeQueued(f.id, "mod-one"), /처리하고 있습니다/);
  await assert.rejects(f.sessions.sendQueued(f.id, "mod-one"), /처리하고 있습니다/);
  f.sessions.resumeQueue(f.id); f.sessions.pollQueued();
  assert.equal(f.boundary.queries.length, 1);
  assert.equal(f.sessions.modInbox.result("mod-one", "submitted"), true);
  assert.equal(f.sessions.modInbox.result("mod-one", "submitted"), false);
  assert.equal(f.sessions.summaryOf(f.id)?.queue, undefined);
  assert.equal(await f.sessions.send(f.id, "mod-one", "private message"), f.id);
  assert.equal(f.boundary.queries.length, 1);
  assert.equal(f.sessions.log(f.id).tail().events.filter(e => e.kind === "user" && e.clientMsgId === "mod-one").length, 1);
});

// 2026-10-27 on the person's Mac: the message after a mod-delivered turn sat in the queue with the app idle
// (an app-run turn writes no result here to settle on), and the queue showed each message on its way in.
test("after a mod-delivered turn the next message is offered at once, and offered messages are not shown as queued", async t => {
  const f = await modFixture(t, 500, 500);
  await f.sessions.send(f.id, "first", "first words");
  assert.equal(f.sessions.summaryOf(f.id)?.queue, undefined, "an offered message is not listed as queued");
  assert.equal(f.sessions.modInbox.claim("first"), true);
  assert.equal(f.sessions.summaryOf(f.id)?.queue, undefined, "a claimed message is not listed as queued");
  assert.equal(f.sessions.modInbox.result("first", "submitted"), true);
  await f.sessions.send(f.id, "second", "second words");
  await waitFor(() => f.sessions.modInbox.pending(f.sdkId).some(offer => offer.itemId === "second"));
  assert.equal(f.boundary.queries.length, 1, "the host did not run either message");
});

// 2026-10-27, the second time: a queue.json written by the earlier build kept an "awaiting" mark from
// an app-run turn, which settles only on a result or on a state after the answer, and the app's
// turns wrote neither here. The next phone message sat queued with the app idle.
test("an awaiting mark left by an app-run turn settles once the app is idle, and the next message is offered", async t => {
  const f = await modFixture(t, 500, 500);
  const file = path.join(f.projects, "project", `${f.sdkId}.jsonl`);
  (f.sessions as unknown as { sendQueue: { sent(id: string, seq: number, at: number): void } }).sendQueue.sent(f.id, f.sessions.log(f.id).lastSeq, Date.now());
  // The app's turn starts and ends between two polls: the host never sees it busy.
  fs.appendFileSync(file, transcriptLine({ type: "user", uuid: "app-turn", cwd: f.cwd, message: { content: "earlier" } }) +
    transcriptLine({ type: "assistant", uuid: "app-answer", message: { model: "test", content: [{ type: "text", text: "earlier answer" }] } }));
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(f.id)?.state, "idle");
  await f.sessions.send(f.id, "next", "next words");
  await waitFor(() => f.sessions.modInbox.pending(f.sdkId).some(offer => offer.itemId === "next"));
  assert.equal(f.sessions.summaryOf(f.id)?.queue, undefined);
});

test("the app's busy and idle show on the phone for a handed-off session the host follows", async t => {
  const f = await modFixture(t, 500, 500);
  f.registry.set(f.sdkId, { sessionId: f.sdkId, pid: 42, status: "busy" });
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(f.id)?.state, "running");
  f.registry.set(f.sdkId, { sessionId: f.sdkId, pid: 42, status: "idle" });
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(f.id)?.state, "idle");
});

test("pressing send on a queued message offers it to the app's mod first", async t => {
  const f = await modFixture(t, 500, 500);
  // Queued while the app was busy, then the app went idle and the person pressed send.
  f.registry.set(f.sdkId, { sessionId: f.sdkId, pid: 42, status: "busy" });
  f.sessions.enqueue(f.id, "held", "held words");
  assert.equal(f.sessions.modInbox.pending(f.sdkId).length, 0);
  f.registry.set(f.sdkId, { sessionId: f.sdkId, pid: 42, status: "idle" });
  const sending = f.sessions.sendQueued(f.id, "held");
  await waitFor(() => f.sessions.modInbox.pending(f.sdkId).some(offer => offer.itemId === "held"));
  assert.equal(f.sessions.modInbox.claim("held"), true);
  assert.equal(await sending, f.id);
  assert.equal(f.boundary.queries.length, 1, "the host did not run it");
});

for (const answer of ["claimed", "expired", "deadline"] as const) test(`send-now holds a later pick until the app offer is ${answer}, not until its two-minute result`, async t => {
  const app = claudeAppData(t, "dddddddd-dddd-dddd-dddd-dddddddddddd");
  const f = await modFixture(t, answer === "expired" ? 6000 : 120_000, 120_000, false, app.root);
  f.registry.get(f.sdkId)!.status = "busy";
  f.sessions.enqueue(f.id, "ordered-offer", "offer words");
  await nextTick();
  f.registry.get(f.sdkId)!.status = "idle";
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const sending = f.sessions.sendQueued(f.id, "ordered-offer");
  const outcome = answer === "deadline" ? assert.rejects(sending, /전송 결과를 확인할 수 없음/) : sending;
  const pick = f.sessions.setModel(f.id, "next-model", null, "after-offer");
  await nextTick();
  assert.equal(f.sessions.modInbox.pending(f.sdkId).length, 1);
  assert.equal(f.sessions.summaryOf(f.id)?.model, "claude-test");
  t.mock.timers.tick(answer === "deadline" ? 14_999 : 5999);
  await nextTick();
  assert.equal(f.sessions.summaryOf(f.id)?.model, "claude-test", "the later pick still waits");
  if (answer === "claimed") assert.equal(f.sessions.modInbox.claim("ordered-offer"), true);
  else t.mock.timers.tick(1);
  await outcome;
  assert.deepEqual(await pick, { status: "applied", model: "next-model", effort: null });
  if (answer === "claimed") {
    assert.equal(f.boundary.queries.length, 1, "the host never dispatched a claimed message");
    assert.equal(f.sessions.modInbox.result("ordered-offer", "submitted"), true, "the later result remains tracked independently");
  }
  if (answer === "deadline") {
    t.mock.timers.tick(120_000);
    await nextTick();
    assert.equal(f.boundary.queries.length, 1, "an expired lane item cannot dispatch after its offer expires");
  }
});

test("an unclaimed offer expires before the host runs it; late claims lose", async t => {
  const f = await modFixture(t, 20);
  await f.sessions.send(f.id, "fallback", "fallback text");
  await waitFor(() => f.boundary.queries.length === 2 && f.boundary.queries[1]!.users.length === 1);
  assert.equal(f.sessions.modInbox.claim("fallback"), false);
  assert.equal(f.boundary.queries[1]!.users[0]!.message.content, "fallback text");
});

for (const outcome of ["failed", "timeout", "restart"] as const) test(`a mod claim with ${outcome} is held as uncertain and never runs on the host`, async t => {
  const f = await modFixture(t, 100, 30);
  await f.sessions.send(f.id, "uncertain", "check first");
  assert.equal(f.sessions.modInbox.claim("uncertain"), true);
  let active = f.sessions;
  if (outcome === "failed") assert.equal(active.modInbox.result("uncertain", "failed"), true);
  if (outcome === "timeout") await waitFor(() => !!active.summaryOf(f.id)?.queueHeld);
  if (outcome === "restart") {
    active.shutdown();
    active = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: f.boundary.queryFn, desktopProjects: f.projects, desktopRegistry: () => f.registry, desktopProcesses: () => "", modOfferMs: 10, onEvent() {}, onSessions() {} });
    f.instances.push(active); active.recover();
  }
  assert.equal(active.summaryOf(f.id)?.queueHeld, true);
  assert.match(active.summaryOf(f.id)?.queue?.[0]?.error ?? "", /전송되었는지 확인할 수 없습니다/);
  active.pollQueued(); await delay(40);
  assert.equal(f.boundary.queries.length, 1);
  assert.equal(active.modInbox.result("uncertain", "submitted"), false);
});

test("withdrawing an offer for editing or send-now never runs the original offer", async t => {
  const f = await modFixture(t, 100);
  await f.sessions.send(f.id, "edit", "edit me");
  assert.equal(f.sessions.removeQueued(f.id, "edit")?.text, "edit me");
  assert.equal(f.sessions.modInbox.claim("edit"), false);
  await delay(110);
  assert.equal(f.boundary.queries.length, 1);
  await f.sessions.send(f.id, "now", "send now");
  await f.sessions.sendQueued(f.id, "now");
  await waitFor(() => f.boundary.queries.length === 2 && f.boundary.queries[1]!.users.length === 1);
  await delay(110);
  assert.equal(f.boundary.queries.length, 2);
  assert.equal(f.sessions.modInbox.claim("now"), false);
});

for (const kind of ["attachment", "slash", "steer", "interrupt"] as const) test(`${kind} bypasses the mod inbox`, async t => {
  const f = await modFixture(t, 100);
  const attachments = kind === "attachment" ? [{ blob: f.sessions.log(f.id).image(Buffer.from("photo").toString("base64")), name: "photo.png", mediaType: "image/png" }] : [];
  await f.sessions.send(f.id, `bypass-${kind}`, kind === "slash" ? "/help" : "direct", attachments, kind === "steer" || kind === "interrupt" ? kind : undefined);
  await waitFor(() => f.boundary.queries.length === 2);
  assert.deepEqual(f.sessions.modInbox.pending(f.sdkId), []);
});

test("a new session keeps one idempotent create per content", async t => {
  const f = fixture(t);
  const first = await f.create("create-content");
  assert.equal(await f.create("create-content"), first);
  await assert.rejects(f.create("create-content", "claude-other"), /같은 메시지 ID에 다른 내용이 이미 접수되었습니다/);
});
