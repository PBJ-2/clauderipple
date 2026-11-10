import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sessions } from "../src/sessions.ts";
import { BridgeClient, DesktopBlockedError } from "../src/bridge-client.ts";
import { setTimeout as delay } from "node:timers/promises";
import { PermissionQueue } from "../src/permissions.ts";
import { liveDesktopProcesses, type DesktopProcess } from "../src/desktop.ts";
import { ATTACHMENT_CAP, ATTACHMENT_COUNT } from "../src/protocol.ts";
import type { InputBlock } from "../src/images.ts";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const tick = () => new Promise(resolve => setImmediate(resolve));
const line = (value: unknown) => JSON.stringify(value) + "\n";

function fixture(t: import("node:test").TestContext, rejected = false, resumed: boolean | string = false, postGate?: Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-session-test-"));
  const projects = path.join(root, "projects");
  fs.mkdirSync(path.join(projects, "project"), { recursive: true });
  const file = path.join(projects, "project", `${id}.jsonl`);
  fs.writeFileSync(file, line({ type: "user", uuid: "old", cwd: root, message: { content: "old prompt" } }));
  const registry = new Map<string, DesktopProcess>([[id, { sessionId: id, pid: 42, status: "idle", bridgeSessionId: "bridge" }]]);
  const posts: Record<string, unknown>[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let queries = 0;
  let now = Date.now(), workerStatus = "idle", stateReads = 0, stateFailure = false;
  /** Stored session events (sort_order=asc): approvals requested before any stream connected. */
  const history: unknown[] = [];
  const client = new BridgeClient({ auth: () => ({ accessToken: "private-token", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
    if (options?.method === "POST") {
      posts.push(JSON.parse(String(options.body)));
      await postGate;
      return new Response("{}", { status: rejected ? 403 : 200 });
    }
    if (String(url).endsWith("/sessions/bridge")) {
      stateReads++;
      return stateFailure ? new Response("", { status: 503 }) : Response.json({ worker_status: workerStatus });
    }
    if (String(url).includes("/events?sort_order=asc")) return Response.json({ data: history });
    if (String(url).includes("/events?sort_order=desc")) return Response.json({ data: [] });
    assert.ok(String(url).includes("/events/stream?from_sequence_num="));
    return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; options?.signal?.addEventListener("abort", () => c.close(), { once: true }); } }));
  } });
  if (resumed) {
    fs.mkdirSync(path.join(root, "host"), { recursive: true });
    fs.writeFileSync(path.join(root, "host", "sessions.json"), JSON.stringify([{
      id: typeof resumed === "string" ? resumed : id, sdkSessionId: id, cwd: root, model: "claude-sonnet-4-5", effort: null, title: "resumed",
      createdAt: now, updatedAt: now, state: "idle", createdBy: "earlier", contextWindow: null, desktopHandoff: "excluded",
    }]));
  }
  const permissions = PermissionQueue.open(path.join(root, "permissions.json"));
  const sessions = new Sessions({ modOfferMs: 20, now: () => now, log() {}, dir: path.join(root, "host"), desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "", bridgeClient: client, permissions,
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } },
    queryFn: () => { queries++; return { async *[Symbol.asyncIterator]() {}, interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, close() {} }; }, onEvent() {}, onSessions() {} });
  t.after(async () => { sessions.shutdown(); await tick(); fs.rmSync(root, { recursive: true, force: true }); });
  let sequence = 0;
  const emit = (payload: unknown, source = "worker") => controller!.enqueue(new TextEncoder().encode(`event: client_event\ndata: ${JSON.stringify({ source, event_id: `e${++sequence}`, sequence_num: sequence, payload })}\n\n`));
  return { root, file, registry, sessions, posts, permissions, emit, history, queries: () => queries,
    stateReads: () => stateReads, advance: () => { now += 3000; }, status: (value: string) => { workerStatus = value; }, failState: () => { stateFailure = true; } };
}

test("Mac bridge mode switching waits for the worker before confirming the next turn", async t => {
  const f = fixture(t);
  const changing = f.sessions.setMode(id, 'plan', 'mode-plan');
  await tick(); await tick();
  const payload = (f.posts[0] as { events: { payload: { request_id: string; request: unknown } }[] }).events[0]!.payload;
  assert.deepEqual(payload.request, { subtype: 'set_permission_mode', mode: 'plan' });
  assert.notEqual(f.sessions.summaryOf(id)?.permissionMode, 'plan');
  f.emit({ type: 'control_response', response: { request_id: payload.request_id, subtype: 'success', response: {} } });
  assert.deepEqual(await changing, { status: 'applied', permissionMode: 'plan' });
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, 'plan');
  assert.equal(f.queries(), 0);
});

test("a desktop bridge summary carries the Claude app transcript's permission mode", async t => {
  const f = fixture(t);
  fs.appendFileSync(f.file, line({ type: "user", uuid: "p1", promptSource: "sdk", permissionMode: "bypassPermissions", message: { content: "run it" } }));
  f.sessions.log(id); // import as a Remote Control (bridge) record
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(id)!.permissionMode, "bypassPermissions");
});

test("a phone-created session opens desktop workers by its SDK id after the app takes over", async t => {
  const phoneId = "phone-session-id";
  const f = fixture(t, false, phoneId);
  const workers = path.join(path.dirname(f.file), id, "subagents");
  fs.mkdirSync(workers, { recursive: true });
  fs.writeFileSync(path.join(workers, "agent-task.meta.json"), JSON.stringify({ toolUseId: "desktop-worker", model: "sol" }));
  fs.writeFileSync(path.join(workers, "agent-task.jsonl"), line({ type: "assistant", isSidechain: true, message: { model: "sol", content: [{ type: "text", text: "desktop worker conversation" }] } }));
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(phoneId)?.desktopBridge, true);
  assert.equal(f.sessions.list().length, 1, "the SDK id is not listed as another session");
  const log = f.sessions.subLog(phoneId, "sub-desktop-worker");
  assert.ok(log);
  const answer = log.tail().events.find(e => e.kind === "assistant");
  assert.equal(answer?.text, "desktop worker conversation");
  assert.equal(f.queries(), 0);
});

test("a desktop model change updates the bridged record, summary, timeline and next turn", async t => {
  const f = fixture(t);
  fs.appendFileSync(f.file, line({ type: "assistant", uuid: "old-model", message: { model: "old-model", content: [{ type: "text", text: "old answer" }] } }));
  f.sessions.log(id);
  assert.equal(f.sessions.summaryOf(id)?.model, "old-model");
  fs.appendFileSync(f.file, line({ type: "assistant", uuid: "new-model", message: { model: "new-model", content: [{ type: "text", text: "new answer" }] } }) +
    line({ type: "assistant", isSidechain: true, message: { model: "worker-not-main", content: [{ type: "text", text: "worker" }] } }));
  f.advance();
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(id)?.model, "new-model");
  assert.equal(f.sessions.list()[0]?.model, "new-model");
  const newest = f.sessions.log(id).tail().events.filter(e => e.kind === "assistant").at(-1);
  assert.equal(newest?.model, "new-model");
  const records = JSON.parse(fs.readFileSync(path.join(f.root, "host", "sessions.json"), "utf8")) as { model: string }[];
  assert.equal(records[0]?.model, "new-model");
  await f.sessions.send(id, "after-model-change", "continue");
  assert.equal(f.sessions.log(id).tail().events.filter(e => e.kind === "turn").at(-1)?.model, "new-model");
});

test("bridge worker state overrides busy registry for listed and opened sessions, caches and falls back on failure", async t => {
  const f = fixture(t);
  f.registry.get(id)!.status = "busy";
  await Promise.all([f.sessions.pollDesktop(), f.sessions.pollDesktop()]);
  assert.equal(f.sessions.list()[0]!.state, "idle");
  assert.equal(f.stateReads(), 1);
  f.sessions.log(id);
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(id)!.state, "idle");
  assert.equal(f.stateReads(), 1);
  for (const [worker, state] of [["running", "running"], ["requires_action", "waiting"], ["idle", "idle"]]) {
    f.advance(); f.status(worker!);
    await f.sessions.pollDesktop();
    assert.equal(f.sessions.summaryOf(id)!.state, state);
  }
  f.advance(); f.failState();
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(id)!.state, "running");
});

test("background counts reach listed and opened bridge summaries independently of the main state", async t => {
  const f = fixture(t);
  // Only a process the registry calls busy can have background work running.
  f.registry.set(id, { ...f.registry.get(id)!, status: "busy" });
  fs.appendFileSync(f.file, line({ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Agent", input: {} }] } }) +
    line({ type: "user", toolUseResult: { isAsync: true, agentId: "worker" }, message: { content: [{ type: "tool_result", tool_use_id: "a", content: "async" }] } }));
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.list()[0]!.tasks, 1);
  assert.equal(f.sessions.list()[0]!.state, "idle");
  f.sessions.log(id);
  assert.equal(f.sessions.summaryOf(id)!.tasks, 1);
  fs.appendFileSync(f.file, line({ type: "user", message: { content: "<task-notification><task-id>worker</task-id><status>completed</status></task-notification>" } }));
  f.advance();
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(id)!.tasks, 0);
  assert.equal(f.sessions.summaryOf(id)!.state, "idle");
});

test("live registry verifies pid and procStart and ignores stale/non-desktop entries", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, `${process.pid}.json`);
  const value = { sessionId: id, pid: process.pid, entrypoint: "claude-desktop", status: "idle", bridgeSessionId: "bridge", cwd: "/moved/folder" };
  fs.writeFileSync(file, JSON.stringify(value));
  // The registry is a Mac Desktop's: named so the check also runs on the Linux CI runner.
  assert.equal(liveDesktopProcesses(root, 0, "darwin").get(id)?.bridgeSessionId, "bridge");
  assert.equal(liveDesktopProcesses(root, 0, "darwin").get(id)?.cwd, "/moved/folder");
  for (const override of [{ procStart: "wrong identity" }, { entrypoint: "sdk-cli" }, { pid: 1 }, { status: "unknown" }]) {
    fs.writeFileSync(file, JSON.stringify({ ...value, ...override }));
    assert.equal(liveDesktopProcesses(root, 0, "darwin").size, 0);
  }
});

test("bridge prompts, transcript echo, permission allow/cancel and interrupt never spawn SDK", async t => {
  const f = fixture(t);
  assert.equal(f.sessions.list()[0]?.state, "idle");
  await Promise.all([f.sessions.send(id, "phone-uuid", "hello"), f.sessions.send(id, "phone-uuid", "hello")]);
  assert.equal(f.posts.length, 1);
  // The API rejects (400) any event uuid that is not a UUID; phones send short random ids.
  assert.match(String((f.posts[0] as { events: { payload: { uuid: string } }[] }).events[0]!.payload.uuid), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(f.queries(), 0);
  fs.appendFileSync(f.file, line({ type: "user", uuid: "phone-uuid", message: { content: "hello" } }) + line({ type: "assistant", uuid: "reply", message: { model: "model", content: [{ type: "text", text: "reply" }] } }));
  f.sessions.pollDesktop();
  const events = f.sessions.log(id).tail().events;
  assert.equal(events.filter(e => e.kind === "user" && e.clientMsgId === "phone-uuid").length, 1);
  assert.ok(events.some(e => e.kind === "assistant"));
  const request = { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tool", input: { command: "true" } } };
  f.emit(request, "client");
  await tick();
  assert.equal(f.permissions.pending().length, 0);
  f.emit(request);
  await tick();
  const permission = f.permissions.pending()[0]!;
  assert.equal(f.sessions.log(id).tail().events.find(e => e.kind === "permission")?.kind, "permission");
  assert.equal(await f.sessions.decide(id, permission.id, "allow"), true);
  const response = f.posts[1] as { events: { payload: { response: unknown } }[] };
  assert.deepEqual(response.events[0]?.payload.response, { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { command: "true" }, toolUseID: "tool" } });
  f.emit({ ...request, request_id: "r2" });
  await tick();
  const cancelled = f.permissions.pending()[0]!;
  f.emit({ type: "control_cancel_request", request_id: "r2" });
  await tick();
  assert.equal(await f.sessions.decide(id, cancelled.id, "allow"), false);
  assert.equal(f.posts.length, 2);
  await f.sessions.interrupt(id);
  assert.equal(f.posts.length, 3);
  assert.equal(f.queries(), 0);
  f.registry.clear();
  f.sessions.pollDesktop();
  await f.sessions.send(id, "closed-phone", "resume closed");
  await tick();
  assert.equal(f.queries(), 1);
});

test("bridge photos survive rebase and transcript echoes leave exactly one image-bearing user event", async t => {
  const f = fixture(t, false, true);
  const before = f.sessions.log(id);
  const photos = ["image/png", "image/jpeg", "image/gif", "image/webp"].map((mediaType, index) => {
    const data = Buffer.from(`synthetic photo ${index}`).toString("base64");
    return { data, attachment: { blob: before.image(data), name: `photo-${index}`, mediaType } };
  });
  const attachments = photos.map(photo => photo.attachment);
  await Promise.all([
    f.sessions.send(id, "photo-phone", "Look at these", attachments),
    f.sessions.send(id, "photo-phone", "Look at these", attachments),
  ]);
  const log = f.sessions.log(id);
  assert.notEqual(log.epoch, before.epoch, "the resumed host record really rebased");
  assert.equal(f.posts.length, 1);
  const payload = (f.posts[0] as { events: { payload: { uuid: string; message: { content: InputBlock[] } } }[] }).events[0]!.payload;
  assert.deepEqual(payload.message.content, [
    ...photos.map(photo => ({ type: "image", source: { type: "base64", media_type: photo.attachment.mediaType, data: photo.data } })),
    { type: "text", text: "Look at these" },
  ]);
  const users = () => log.tail().events.filter(event => event.kind === "user" && ["photo-phone", payload.uuid].includes(event.clientMsgId));
  assert.equal(users().length, 1);
  const event = users()[0]!;
  assert.ok(event.kind === "user");
  assert.equal(event.images?.length, photos.length);
  event.images!.forEach((image, index) => {
    assert.ok(image.blob);
    assert.equal(log.blob(image.blob), photos[index]!.data);
  });
  fs.appendFileSync(f.file, line({ type: "user", uuid: payload.uuid, promptSource: "sdk", message: payload.message }));
  await f.sessions.pollDesktop();
  await f.sessions.pollDesktop();
  await f.sessions.send(id, "photo-phone", "Look at these", attachments);
  assert.equal(users().length, 1, "the UUID transcript echo and phone resend add no second message");
  assert.equal(f.posts.length, 1);
  assert.deepEqual(users()[0], event);
  assert.equal(f.queries(), 0);
});

test("bridge rejects non-photos and excessive attachment counts without posting or logging a user", async t => {
  const f = fixture(t);
  const log = f.sessions.log(id);
  const blob = log.image(Buffer.from("synthetic attachment").toString("base64"));
  for (const mediaType of ["text/plain", "application/pdf", "image/svg+xml"]) {
    await assert.rejects(async () => f.sessions.send(id, `file-${mediaType}`, "file", [{ blob, mediaType, name: "file" }]),
      { message: "Only photos can be attached to Claude app sessions for now." });
  }
  await assert.rejects(async () => f.sessions.send(id, "too-many", "photos", Array.from({ length: ATTACHMENT_COUNT + 1 }, () => ({ blob, mediaType: "image/png", name: "photo" }))), /At most/);
  assert.equal(f.posts.length, 0);
  assert.equal(log.tail().events.filter(event => event.kind === "user").length, 1, "only the imported old prompt remains");
  assert.equal(fs.existsSync(path.join(f.root, ".ripple-attachments")), false);
  assert.equal(f.queries(), 0);
});

test("bridge caps total base64 at ATTACHMENT_COUNT times ATTACHMENT_CAP, inclusive", async t => {
  const f = fixture(t);
  const log = f.sessions.log(id);
  const exact = Buffer.alloc(ATTACHMENT_CAP / 4 * 3).toString("base64");
  const over = exact + "AAAA";
  const attachments = (data: string) => {
    const blob = log.image(data);
    return Array.from({ length: ATTACHMENT_COUNT }, () => ({ blob, mediaType: "image/png", name: "photo" }));
  };
  await assert.rejects(async () => f.sessions.send(id, "over-size", "", attachments(over)), { message: "Photo payload is too large." });
  assert.equal(f.posts.length, 0);
  await f.sessions.send(id, "at-size", "", attachments(exact));
  assert.equal(f.posts.length, 1);
  const content = (f.posts[0] as { events: { payload: { message: { content: InputBlock[] } } }[] }).events[0]!.payload.message.content;
  assert.equal(content.filter(block => block.type === "image").reduce((size, block) => size + block.source.data.length, 0), ATTACHMENT_COUNT * ATTACHMENT_CAP);
  assert.deepEqual(content.at(-1), { type: "text", text: "Please inspect these images." });
  assert.equal(f.queries(), 0);
});

test("a bridge send accepted after its lane deadline still logs the message and completes its receipt", async t => {
  const gate = Promise.withResolvers<void>();
  const f = fixture(t, false, false, gate.promise);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sending = f.sessions.orderedSend(id, "slow-accept", "slow words");
  await tick();
  assert.equal(f.posts.length, 1);
  t.mock.timers.tick(15_000);
  gate.resolve();
  assert.equal(await sending, id);
  assert.equal(f.sessions.log(id).tail().events.filter(e => e.kind === "user" && e.clientMsgId === "slow-accept").length, 1);
  assert.equal(await f.sessions.orderedSend(id, "slow-accept", "slow words"), id);
  assert.equal(f.posts.length, 1, "the completed receipt answers a resend without posting again");
});

test("a rejected live bridge send fails each attempt without logging the user or starting a writer", async t => {
  const f = fixture(t, true);
  await assert.rejects(Promise.resolve(f.sessions.send(id, "phone", "not accepted")), /받지 않았습니다/);
  await assert.rejects(Promise.resolve(f.sessions.send(id, "phone", "not accepted")), /받지 않았습니다/);
  assert.equal(f.posts.length, 2);
  assert.equal(f.queries(), 0);
  assert.equal(f.sessions.log(id).tail().events.some(e => e.kind === "user" && e.clientMsgId === "phone"), false);
});

test("attach replays approvals requested before the stream connected, skipping answered ones", async t => {
  const f = fixture(t);
  const requested = (request_id: string, command: string) => ({ payload: { type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: `tool-${request_id}`, input: { command } } } });
  // Requested while no stream was up: latest() sees nothing, so the stream alone would miss these.
  f.history.push(
    requested("early", "early"),
    { payload: { type: "control_response", request_id: "early", response: { subtype: "success" } } },
    requested("waiting", "stale"),
  );
  await f.sessions.syncBridge(id);
  await tick();
  const pending = f.permissions.pending();
  assert.equal(pending.length, 1, "the answered request stays silent, the open one cards");
  assert.equal(pending[0]!.tool, "Bash");
  const card = f.sessions.log(id).tail().events.find(e => e.kind === "permission" && e.id === pending[0]!.id);
  assert.ok(card?.kind === "permission" && card.input === "stale");
  // The listed state follows the worker: requires_action reads as waiting.
  f.status("requires_action");
  f.advance();
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(id)!.state, "waiting");
  // A second sync (or a live duplicate of the same request) cards nothing twice.
  await f.sessions.syncBridge(id);
  await tick();
  assert.equal(f.permissions.pending().length, 1);
  assert.equal(f.sessions.log(id).tail().events.filter(e => e.kind === "permission").length, 1);
  assert.equal(await f.sessions.decide(id, pending[0]!.id, "deny"), true);
  assert.equal(f.posts.length, 1);
  assert.equal(await f.sessions.decide(id, pending[0]!.id, "deny"), false, "the second answer resolves nothing again");
});

for (const bridgeAppears of [true, false]) test(`a completed Desktop session without RC waits, then sends once when ${bridgeAppears ? "RC appears" : "the Desktop writer exits"}`, async t => {
  const f = fixture(t);
  f.registry.set(id, { sessionId: id, pid: 42, status: "idle" });
  assert.throws(() => f.sessions.send(id, "direct-blocked", "/help"), DesktopBlockedError);
  f.sessions.enqueue(id, "waiting-rc", "원문\n" + "긴 메시지 😀".repeat(1000));
  await delay(40);
  assert.equal(f.sessions.summaryOf(id)?.queueHeld, undefined);
  assert.equal(f.sessions.summaryOf(id)?.queue?.[0]?.wait, "desktop_waiting", "a wait is a code, not the failure text");
  assert.equal(f.sessions.summaryOf(id)?.queue?.[0]?.error, undefined);
  assert.equal(f.queries(), 0);
  assert.equal(f.posts.length, 0);
  if (bridgeAppears) f.registry.get(id)!.bridgeSessionId = "bridge";
  else f.registry.clear();
  f.sessions.pollQueued();
  await tick(); await tick();
  assert.equal(f.sessions.summaryOf(id)?.queue, undefined);
  assert.equal(f.queries(), bridgeAppears ? 0 : 1);
  assert.equal(f.posts.length, bridgeAppears ? 1 : 0);
  if (bridgeAppears) assert.equal((f.posts[0] as { events: { payload: { message: { content: string } } }[] }).events[0]!.payload.message.content, "원문\n" + "긴 메시지 😀".repeat(1000));
  f.sessions.pollQueued();
  await f.sessions.pollDesktop();
  await tick();
  assert.equal(f.queries() + f.posts.length, 1, "no repeated input on subsequent polls");
});

test("a user-paused RC wait remains paused after the bridge appears", async t => {
  const f = fixture(t);
  f.registry.set(id, { sessionId: id, pid: 42, status: "idle" });
  f.sessions.enqueue(id, "stopped-wait", "kept");
  await tick();
  f.sessions.holdQueue(id);
  f.registry.get(id)!.bridgeSessionId = "bridge";
  f.sessions.pollQueued();
  await f.sessions.pollDesktop();
  await tick();
  assert.equal(f.posts.length, 0);
  assert.equal(f.sessions.summaryOf(id)?.queueHeld, true);
  f.sessions.resumeQueue(id);
  await tick(); await tick();
  assert.equal(f.posts.length, 1);
});

test("a definite bridge refusal keeps its queued original visible and requires explicit retry", async t => {
  const f = fixture(t, true);
  f.sessions.enqueue(id, "refused-queue", "keep the original");
  await tick(); await tick();
  assert.equal(f.sessions.summaryOf(id)?.queueHeld, true);
  assert.equal(f.sessions.summaryOf(id)?.queue?.[0]?.text, "keep the original");
  f.sessions.pollQueued();
  await f.sessions.pollDesktop();
  await tick();
  assert.equal(f.posts.length, 1);
});

// The queue for a Claude app session goes over Remote Control when the app says the turn ended,
// and the next only after the turn the last one started has answered and ended.
test("a queued message for a Mac session goes when its turn ends, the next after that turn's answer", async t => {
  const f = fixture(t);
  f.status("running");
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.list()[0]!.state, "running");
  f.sessions.enqueue(id, "q-mac-1", "after this turn");
  f.sessions.enqueue(id, "q-mac-2", "then this");
  await tick();
  assert.equal(f.posts.length, 0, "nothing goes while the Mac turn runs");
  assert.equal(f.sessions.list()[0]!.queue?.length, 2);
  f.advance(); f.status("idle");
  await f.sessions.pollDesktop();
  await tick(); await tick();
  assert.equal(f.posts.length, 1, "the turn ended: the head went");
  assert.match(JSON.stringify(f.posts[0]), /after this turn/);
  // Remote Control can still read idle before the new turn starts: the second waits for an answer.
  f.advance();
  await f.sessions.pollDesktop();
  await tick(); await tick();
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.sessions.summaryOf(id)!.queue?.map(item => item.id), ["q-mac-2"]);
  fs.appendFileSync(f.file, line({ type: "user", uuid: "q-mac-1", message: { content: "after this turn" } }) + line({ type: "assistant", uuid: "reply-1", message: { model: "model", content: [{ type: "text", text: "done" }] } }));
  f.advance(); f.status("running");
  await f.sessions.pollDesktop();
  f.advance(); f.status("idle");
  await f.sessions.pollDesktop();
  await tick(); await tick();
  assert.equal(f.posts.length, 2);
  assert.match(JSON.stringify(f.posts[1]), /then this/);
  assert.equal(f.sessions.summaryOf(id)!.queue, undefined);
  assert.equal(f.queries(), 0, "never an SDK query of the host's own");
});
