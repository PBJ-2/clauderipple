import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay, setImmediate as nextTick } from "node:timers/promises";
import { WebSocket } from "ws";
import { PermissionQueue } from "../src/permissions.ts";
import { BridgeClient } from "../src/bridge-client.ts";
import type { DesktopProcess } from "../src/desktop.ts";
import { MessageReceipts, OutcomeUnknownError } from "../src/receipts.ts";
import { ATTACHMENT_CAP, CHUNK_MESSAGE_MAX, FRAME_CAP, PING_MS, STALE_MS } from "../src/protocol.ts";
import type { BlobChunk, BrowseResult, ClientMsg, HostMsg, SessionEvent } from "../src/protocol.ts";
import { FrameAssembler } from "../src/chunks.ts";
import { HostServer } from "../src/server.ts";
import type { Peer as ServerPeer, ServerOptions } from "../src/server.ts";
import { VISIBLE_MS } from "../src/push.ts";
import { windowsDrives } from "../src/folders.ts";
import { Sessions } from "../src/sessions.ts";
import type { QueryFn, SdkUserMessage } from "../src/sessions.ts";
import { bridgeFixture, bridgeId, tick } from "./bridge-fixture.ts";
import { claudeAppData } from "./app-data.ts";

// Limits for a stalled test, not for a slow one: a passing test never waits them out. 4.5 s and 2 s
// ran out on a loaded Windows CI runner while the host was still answering (2026-10-29, #98).
const TEST_TIMEOUT = 15_000;
const WAIT_LIMIT = 10_000;

const webDir = fileURLToPath(new URL("../web", import.meta.url));
const token = "remote-test-token-not-a-real-pairing-token";
const router = {
  status: async () => ({ ok: true, proxyEnv: { HTTPS_PROXY: "http://127.0.0.1:1" } }),
  figures: async () => ({ effort: null, cachePct: null, contextPct: null, fiveHourPct: null, fiveHourResetAt: null, workers: [], at: Date.now() }),
  models: async () => [],
};

function scriptedQuery(sdkId = "sdk-1") {
  const options: Record<string, unknown>[] = [];
  const users: SdkUserMessage[] = [];
  const spies = { interrupt: 0, setModel: [] as (string | undefined)[], close: 0 };
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
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "po" } } };
          yield { type: "assistant", parent_tool_use_id: null, message: { id, model: "x", content: [{ type: "text", text: "pong" }] } };
          yield { type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, modelUsage: { x: { contextWindow: 1000 } } };
        }
      },
      interrupt: async () => { spies.interrupt++; },
      setModel: async model => { spies.setModel.push(model); },
      setPermissionMode: async () => {},
      close: () => { spies.close++; },
    };
  };
  return { queryFn, options, users, spies };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + WAIT_LIMIT;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Timed out waiting for host or socket");
    await delay(5);
  }
  await nextTick();
}

type Frame = { msg: HostMsg; bytes: number };
type HostFrame<T extends HostMsg["t"]> = { msg: Extract<HostMsg, { t: T }>; bytes: number };

class Peer {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  readonly received: Frame[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private error: Error | null = null;
  private ping = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.closed = new Promise(resolve => this.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    this.ws.on("error", error => { this.error = error; });
    this.ws.on("message", data => {
      const text = data.toString();
      const frame = { msg: JSON.parse(text) as HostMsg, bytes: Buffer.byteLength(text) };
      this.frames.push(frame);
      this.received.push(frame);
    });
  }

  async open(): Promise<void> {
    await waitFor(() => this.ws.readyState === WebSocket.OPEN || this.error !== null);
    if (this.error) throw this.error;
  }

  send(msg: ClientMsg): void { this.ws.send(JSON.stringify(msg)); }

  async take<T extends HostMsg["t"]>(kind: T, matches: (msg: Extract<HostMsg, { t: T }>) => boolean = () => true): Promise<HostFrame<T>> {
    const index = () => this.frames.findIndex(frame => frame.msg.t === kind && matches(frame.msg as Extract<HostMsg, { t: T }>));
    await waitFor(() => index() !== -1 || this.error !== null);
    if (this.error) throw this.error;
    const frame = this.frames.splice(index(), 1)[0]!;
    assert.equal(frame.msg.t, kind);
    return frame as HostFrame<T>;
  }

  async barrier(): Promise<void> {
    const n = ++this.ping;
    this.send({ t: "ping", n });
    await this.take("pong", msg => msg.n === n);
  }

  eventFrames(): HostFrame<"events">[] {
    const frames = this.frames.filter(frame => frame.msg.t === "events") as HostFrame<"events">[];
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.msg.t === "events") this.frames.splice(i, 1);
    return frames;
  }
}

async function fixture(t: TestContext, extra: Partial<ServerOptions> = {}, desktopProjects?: string, desktopProcesses?: () => string, queryFn?: QueryFn, sidebarRoot?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-server-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const permissions = PermissionQueue.open(path.join(dir, "permissions.json"));
  const fake = scriptedQuery();
  const peers: Peer[] = [];
  const diagnostics: string[] = [];
  let server: HostServer | undefined;
  let closing = false;
  const sessions = new Sessions({ dir, router, permissions, queryFn: queryFn ?? fake.queryFn, coalesceMs: 5, ...(desktopProjects ? { desktopProjects, desktopProcesses: desktopProcesses ?? (() => ""), ...(extra.now ? { now: extra.now } : {}) } : {}),
    ...(sidebarRoot ? { desktopSidebar: { root: sidebarRoot } } : {}),
    onEvent: session => { if (!closing) server?.onEvent(session); },
    onSessions: () => { if (!closing) server?.onSessions(); },
  });
  t.after(async () => {
    closing = true;
    for (const peer of peers) peer.ws.terminate();
    await server?.close();
    for (const session of sessions.list()) sessions.stop(session.id);
    await nextTick();
    sessions.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions, router,
    hostName: "test-host", version: "test-version", recentCli: async () => [], log: line => diagnostics.push(line), ...extra,
  });
  await server.listen();
  const port = server.address().port;
  const connect = async () => {
    const peer = new Peer(`ws://127.0.0.1:${port}/ws`);
    peers.push(peer);
    await peer.open();
    return peer;
  };
  const auth = async () => {
    const peer = await connect();
    peer.send({ t: "hello", token, clientId: "test-client" });
    await peer.take("ready");
    return peer;
  };
  const create = async (clientMsgId = "create-1") => {
    const id = await sessions.create({ clientMsgId, cwd, model: "claude-test", effort: "high", text: "ping" });
    await waitFor(() => sessions.list().find(session => session.id === id)?.state === "idle");
    return id;
  };
  return { dir, cwd, sessions, fake, server, port, diagnostics, connect, auth, create };
}

test("idle refresh reservation refuses in-flight commands and blocks new turns and queued polling", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await fixture(t, { recentCli: async () => { entered.resolve(); await release.promise; return []; } });
  const peer = await f.auth();
  peer.send({ t: "req", reqId: "pending-folders", op: { op: "folders" } });
  await entered.promise;
  assert.equal(f.server.prepareRefresh(), false, "a create/folder/settings handler cannot be raced");
  release.resolve(); await peer.take("res", msg => msg.reqId === "pending-folders");
  await peer.barrier();
  assert.equal(f.server.prepareRefresh(), true);
  peer.send({ t: "create", clientMsgId: "after-reservation", cwd: f.cwd, model: "test", effort: null, text: "must not start" });
  const error = (await peer.take("error", msg => msg.clientMsgId === "after-reservation")).msg;
  assert.equal(error.code, "host_updating");
  assert.equal(f.fake.options.length, 0);
  t.mock.timers.tick(1000); await peer.barrier();
  assert.equal(f.sessions.list().length, 0);
});

test("refresh cannot race a queued bridge send before its running state is recorded", async t => {
  const f = bridgeFixture(t);
  const server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions: f.sessions, router,
    hostName: "test", version: "test", recentCli: async () => [] });
  await server.listen();
  t.after(() => server.close());
  f.sessions.enqueue(bridgeId, "queued-during-refresh", "must finish acceptance");
  assert.equal(server.prepareRefresh(), false, "a queue send awaiting upstream acceptance is not idle");
  await tick();
  assert.equal(f.posts.length, 1);
});

test("refresh freezes deferred internal queue drains before they start a new turn", async t => {
  const f = await fixture(t);
  const id = await f.create();
  assert.equal(f.server.prepareRefresh(), true);
  f.sessions.enqueue(id, "after-freeze", "must remain queued");
  await nextTick();
  await f.sessions.pollDesktop();
  assert.equal(f.fake.users.length, 1);
  assert.equal(f.sessions.summaryOf(id)?.queue?.[0]?.id, "after-freeze");
});

class MemoryPeer extends EventEmitter implements ServerPeer {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: HostMsg[] = [];
  send(text: string): void { this.frames.push(JSON.parse(text) as HostMsg); }
  close(): void { this.terminate(); }
  terminate(): void { this.readyState = 3; this.emit("close"); }
  receive(msg: ClientMsg): void { this.emit("message", JSON.stringify(msg)); }
  async take<T extends HostMsg["t"]>(kind: T): Promise<Extract<HostMsg, { t: T }>> {
    await nextTick();
    const index = this.frames.findIndex(frame => frame.t === kind);
    assert.notEqual(index, -1, `expected ${kind}, received ${JSON.stringify(this.frames)}`);
    return this.frames.splice(index, 1)[0] as Extract<HostMsg, { t: T }>;
  }
}

/**
 * Drains a peer's chunk frames through the shared decoder until `want` matches. `sizes` collects
 * each chunk's actual wire size, so a test can prove every slice fits FRAME_CAP.
 */
async function chunkedFrame(peer: MemoryPeer, want: (msg: HostMsg) => boolean, sizes: number[] = []): Promise<HostMsg> {
  const assembler = new FrameAssembler(Date.now);
  for (let attempt = 0; attempt < 500; attempt++) {
    await nextTick();
    for (const frame of peer.frames.splice(0)) {
      if (frame.t !== "chunk") { if (want(frame)) return frame; continue; }
      sizes.push(Buffer.byteLength(JSON.stringify(frame)));
      const result = assembler.push(frame);
      assert.notEqual(result.kind, "error", result.kind === "error" ? result.reason : "");
      if (result.kind !== "assembled") continue;
      const msg = JSON.parse(result.text) as HostMsg;
      if (want(msg)) return msg;
    }
  }
  throw new Error("no matching frame arrived");
}

/** A query that starts a turn and never ends it, so queued messages stay queued. */
function holdingQuery(users: string[]) {
  const hold = Promise.withResolvers<void>();
  const queryFn: QueryFn = params => ({
    async *[Symbol.asyncIterator]() {
      for await (const user of params.prompt) {
        users.push(String(user.message.content));
        await hold.promise;
      }
    },
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, close: () => { hold.resolve(); },
  });
  return { queryFn, hold };
}

/** No listener, real SDK, router, credentials or desktop sessions; only owned temporary storage. */
async function memoryHost(t: TestContext, queryFn: QueryFn = scriptedQuery().queryFn, status = router.status) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-memory-host-"));
  const sessions = new Sessions({ dir, router: { ...router, status }, permissions: PermissionQueue.open(path.join(dir, "permissions.json")), queryFn,
    onEvent: () => {}, onSessions: () => {} });
  const server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions, router,
    hostName: "test", version: "test", recentCli: async () => [] });
  const peer = new MemoryPeer();
  t.after(async () => {
    await server.close();
    for (const session of sessions.list()) sessions.stop(session.id);
    await nextTick();
    sessions.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const id = await sessions.create({ clientMsgId: "empty", cwd: dir, model: "test", effort: null, text: "" });
  server.connected(peer);
  peer.receive({ t: "hello", token, clientId: "memory-phone" });
  await peer.take("ready");
  const upload = async (data: string, uploadId = "attachment", chunkSize = 60_000) => {
    let response: Extract<HostMsg, { t: "res" }>;
    let offset = 0;
    do {
      const chunk = data.slice(offset, offset + chunkSize);
      const done = offset + chunk.length === data.length;
      const reqId = `upload-${uploadId}-${offset}`;
      peer.receive({ t: "req", reqId, op: { op: "upload", session: id, uploadId, offset, data: chunk, done } });
      response = await peer.take("res");
      assert.equal(response.reqId, reqId);
      if (!response.ok) return response;
      if (!done) assert.equal(response.data, null);
      offset += chunk.length;
    } while (offset < data.length);
    return response;
  };
  return { dir, sessions, peer, id, upload, server };
}

for (const size of [4 * 1024 * 1024, ATTACHMENT_CAP - 2, ATTACHMENT_CAP - 1, ATTACHMENT_CAP]) {
  test(`attachment upload accepts ${size} bytes and preserves the entire blob`, async t => {
    const f = await memoryHost(t);
    const bytes = Buffer.alloc(size, 173);
    const data = bytes.toString("base64");
    const response = await f.upload(data);
    assert.ok(response.ok, response.ok ? "" : response.error);
    const result = response.data as { blob: string };
    assert.equal(f.sessions.blob(f.id, result.blob), data);
    assert.deepEqual(Buffer.from(f.sessions.blob(f.id, result.blob)!, "base64"), bytes);
  });
}

test("attachment validation rejects malformed characters, lengths and padding without storing a blob", async t => {
  const f = await memoryHost(t);
  const malformed = ["", "A", "AA", "AAA", "AAAAA", "=AAA", "A=AA", "AA=A", "A===", "====", "AA==AAAA", "AAA=AAAA",
    "AA==\n", "AAAA\r\n", "AAAA ", "AA-_", "AAéA", "AA\u0000A", "ＡAAA", "AA===" ];
  for (const data of malformed) {
    const response = await f.upload(data, "malformed", 3);
    assert.equal(response.ok, false, JSON.stringify(data));
    if (!response.ok) assert.match(response.error, /Invalid attachment (chunk|bytes)\./);
  }
  assert.equal(fs.existsSync(path.join(f.dir, "sessions", f.id, "blobs")), false);
  for (const data of ["AA==", "AAA=", "AAAA", "+/8="]) {
    const response = await f.upload(data, "retry", 3);
    assert.ok(response.ok);
    assert.equal(f.sessions.blob(f.id, (response.data as { blob: string }).blob), data);
  }
});

for (const suffix of ["=AAA", "AA=A", "A==="]) test(`attachment upload rejects large malformed padding ${suffix} without overflowing`, async t => {
  const f = await memoryHost(t);
  const response = await f.upload("A".repeat(4 * 1024 * 1024) + suffix);
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error, "Invalid attachment bytes.");
  assert.equal(fs.existsSync(path.join(f.dir, "sessions", f.id, "blobs")), false);
  assert.equal((await f.upload("AA==")).ok, true, "a rejected final chunk releases its upload id");
});

for (const excess of [1, 2]) test(`attachment upload rejects ${excess} bytes over the decoded cap`, async t => {
  const f = await memoryHost(t);
  const response = await f.upload(Buffer.alloc(ATTACHMENT_CAP + excess).toString("base64"));
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error, excess === 1 ? "Invalid attachment bytes." : "Attachment exceeds 8 MB.");
  assert.equal(fs.existsSync(path.join(f.dir, "sessions", f.id, "blobs")), false);
  assert.equal((await f.upload("AAA=")).ok, true);
});

test("a send racing Stop receives a correlated error, then its retry is acknowledged and delivered once", async t => {
  const control = Promise.withResolvers<void>();
  const endTurn = Promise.withResolvers<void>();
  const users: string[] = [];
  let interrupts = 0;
  const f = await memoryHost(t, params => ({
    async *[Symbol.asyncIterator]() {
      for await (const user of params.prompt) {
        users.push(String(user.message.content));
        if (users.length === 1) await endTurn.promise;
        yield { type: "result", subtype: "success" };
      }
    },
    interrupt: () => { interrupts++; return control.promise; },
    setModel: async () => {}, setPermissionMode: async () => {}, close: () => { endTurn.resolve(); },
  }));
  await f.sessions.send(f.id, "first", "first");
  await nextTick();
  f.peer.receive({ t: "interrupt", session: f.id, reqId: "stop" });
  const send: ClientMsg = { t: "send", session: f.id, clientMsgId: "racing", text: "keep this" };
  f.peer.receive(send);
  const error = await f.peer.take("error");
  assert.equal(error.code, "send");
  assert.equal(error.clientMsgId, "racing");
  assert.equal(error.session, f.id);
  assert.equal(f.peer.frames.some(frame => frame.t === "ack"), false);
  assert.equal(interrupts, 1);
  assert.deepEqual(users, ["first"]);
  control.resolve();
  const stopped = await f.peer.take("res");
  assert.equal(stopped.reqId, "stop");
  assert.equal(stopped.ok, true);
  f.peer.receive(send);
  f.peer.receive(send);
  for (let i = 0; i < 2; i++) assert.deepEqual(await f.peer.take("ack"), { t: "ack", session: f.id, clientMsgId: "racing" });
  assert.deepEqual(users, ["first", "keep this"]);
});

test("attachment upload is chunked, checks offsets, and sends image blocks", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const peer = await f.auth();
  const data = Buffer.from('uploaded photo').toString('base64');
  peer.send({ t: 'req', reqId: 'bad-offset', op: { op: 'upload', session: id, uploadId: 'photo', offset: 4, data: data.slice(4), done: true } });
  assert.equal((await peer.take('res', m => m.reqId === 'bad-offset')).msg.ok, false);
  peer.send({ t: 'req', reqId: 'chunk-1', op: { op: 'upload', session: id, uploadId: 'photo', offset: 0, data: data.slice(0, 4), done: false } });
  assert.equal((await peer.take('res', m => m.reqId === 'chunk-1')).msg.ok, true);
  peer.send({ t: 'req', reqId: 'chunk-2', op: { op: 'upload', session: id, uploadId: 'photo', offset: 4, data: data.slice(4), done: true } });
  const response = (await peer.take('res', m => m.reqId === 'chunk-2')).msg;
  assert.ok(response.ok);
  const { blob } = response.data as { blob: string };
  assert.equal(f.sessions.log(id).blob(blob), data);
  peer.send({ t: 'send', session: id, clientMsgId: 'photo-send', text: 'look', attachments: [{ blob, name: 'photo.png', mediaType: 'image/png' }] });
  await peer.take('ack', m => m.clientMsgId === 'photo-send');
  await waitFor(() => f.fake.users.length === 2);
  assert.deepEqual(f.fake.users[1]!.message.content, [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }]);
});

test("Stop holds the queue before the result arrives and its late control reply cannot stop a newer query", async t => {
  const endTurn = Promise.withResolvers<void>();
  const interruptReply = Promise.withResolvers<void>();
  const secondTurn = Promise.withResolvers<void>();
  const users: string[] = [];
  const closed: number[] = [];
  let queries = 0;
  const queryFn: QueryFn = params => {
    const generation = ++queries;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const user of params.prompt) {
          users.push(String(user.message.content));
          yield { type: "system", subtype: "init", session_id: "sdk-stop" };
          await (generation === 1 ? endTurn.promise : secondTurn.promise);
          yield { type: "result", subtype: "success" };
        }
      },
      interrupt: async () => { endTurn.resolve(); await interruptReply.promise; },
      setModel: async () => {}, setPermissionMode: async () => {},
      close: () => { closed.push(generation); },
    };
  };
  const f = await fixture(t, {}, undefined, undefined, queryFn);
  const id = await f.sessions.create({ clientMsgId: "stop-create", cwd: f.cwd, model: "test", effort: null, text: "first" });
  await waitFor(() => users.length === 1);
  f.sessions.enqueue(id, "queued-after-stop", "must remain queued");
  const peer = await f.auth();
  peer.send({ t: "interrupt", session: id, reqId: "stop" });
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(f.sessions.summaryOf(id)?.queueHeld, true, "the result could not drain the queue before the interrupt reply");
  assert.deepEqual(users, ["first"]);
  peer.send({ t: "send", session: id, clientMsgId: "new-query", text: "replacement" });
  await peer.take("ack", m => m.clientMsgId === "new-query");
  await waitFor(() => users.length === 2);
  interruptReply.resolve();
  assert.equal((await peer.take("res", m => m.reqId === "stop")).msg.ok, true);
  assert.deepEqual(closed, [1], "the late completion never closes generation two");
  assert.equal(f.sessions.summaryOf(id)?.state, "running");
  assert.deepEqual(users, ["first", "replacement"]);
  f.sessions.holdQueue(id);
  secondTurn.resolve();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
});

test("worker text and images use the existing session-scoped blob operation for host and desktop logs", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-blob-wire-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const desktopId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const workers = path.join(project, desktopId, "subagents");
  fs.mkdirSync(workers, { recursive: true });
  const text = "worker body ".repeat(4000);
  const image = Buffer.from("worker image").toString("base64");
  fs.writeFileSync(path.join(project, `${desktopId}.jsonl`), JSON.stringify({ type: "user", cwd: project, message: { content: "parent" } }) + "\n");
  fs.writeFileSync(path.join(workers, "agent-worker.meta.json"), JSON.stringify({ toolUseId: "tool-worker" }));
  fs.writeFileSync(path.join(workers, "agent-worker.jsonl"), JSON.stringify({ type: "assistant", isSidechain: true, message: { model: "worker", content: [
    { type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
  ] } }) + "\n");
  const f = await fixture(t, {}, root);
  const hostId = await f.create();
  const hostWorker = f.sessions.subLog(hostId, "sub-tool-worker")!;
  hostWorker.append({ kind: "assistant", msg: "host-worker", model: "worker", text, tools: [], images: [{ type: "image", blob: hostWorker.image(image), mediaType: "image/png" }] });
  const peer = await f.auth();
  for (const session of [hostId, desktopId]) {
    peer.send({ t: "req", reqId: `sub-${session}`, op: { op: "sub", session, sub: "sub-tool-worker" } });
    const page = (await peer.take("res", m => m.reqId === `sub-${session}`)).msg;
    assert.ok(page.ok);
    const event = (page.data as { events: SessionEvent[] }).events.find(e => e.kind === "assistant");
    assert.ok(event?.kind === "assistant" && typeof event.text !== "string");
    for (const [blob, expected] of [[event.text.blob, text], [event.images![0]!.blob!, image]]) {
      peer.send({ t: "req", reqId: blob!, op: { op: "blob", session, id: blob! } });
      const response = (await peer.take("res", m => m.reqId === blob)).msg;
      assert.ok(response.ok);
      assert.equal((response.data as BlobChunk).text, expected);
    }
    const foreign = session === hostId ? desktopId : hostId;
    peer.send({ t: "req", reqId: `foreign-${session}`, op: { op: "blob", session: foreign, id: event.text.blob } });
    assert.equal((await peer.take("res", m => m.reqId === `foreign-${session}`)).msg.ok, false, "another session's worker is not searched");
  }
});

test("session file blobs use capped chunks, reject foreign sessions and never accept a path as an id", async t => {
  const f = await fixture(t);
  const id = await f.create(), foreign = await f.create("foreign-files");
  const { sessionFiles } = await import("../src/images.ts");
  const bytes = Buffer.from("한글 파일 내용\n".repeat(12_000));
  fs.writeFileSync(path.join(f.cwd, "보고서.txt"), bytes);
  const log = f.sessions.log(id);
  const [file] = sessionFiles(["보고서.txt"], { cwd: f.cwd }, value => log.image(value));
  assert.ok(file?.blob);
  log.append({ kind: "assistant", msg: "delivered-file", model: "test", text: "완료", tools: [{ id: "files", name: "SendUserFile", summary: "보고서.txt", files: [file] }] });
  const peer = await f.auth();
  peer.send({ t: "attach", session: id });
  const events = await peer.take("events");
  const delivered = events.msg.events.find(event => event.kind === "assistant" && event.msg === "delivered-file");
  assert.ok(delivered?.kind === "assistant");
  assert.deepEqual(delivered.tools[0]?.files, [file]);
  assert.ok(!JSON.stringify(delivered).includes(f.cwd));
  fs.unlinkSync(path.join(f.cwd, "보고서.txt"));
  let offset: number | null = 0, combined = "", chunks = 0;
  while (offset !== null) {
    const reqId = `file-${++chunks}`;
    peer.send({ t: "req", reqId, op: { op: "blob", session: id, id: file.blob, offset } });
    const frame = await peer.take("res", msg => msg.reqId === reqId);
    assert.ok(frame.msg.ok && frame.bytes <= FRAME_CAP);
    const chunk = frame.msg.data as BlobChunk;
    combined += chunk.text; offset = chunk.next;
  }
  assert.ok(chunks > 1);
  assert.deepEqual(Buffer.from(combined, "base64"), bytes);
  const requests = [
    { op: "blob" as const, session: foreign, id: file.blob },
    { op: "blob" as const, session: id, id: path.join(f.cwd, "보고서.txt") },
    { op: "blob" as const, session: id, id: file.blob, offset: -1 },
    { op: "blob" as const, session: id, id: file.blob, offset: 0.5 },
    { op: "blob" as const, session: id, id: file.blob, offset: combined.length + 1 },
  ];
  for (const [index, op] of requests.entries()) {
    const reqId = `reject-file-${index}`;
    peer.send({ t: "req", reqId, op });
    assert.equal((await peer.take("res", msg => msg.reqId === reqId)).msg.ok, false);
  }
});

test("legacy clients get an error for partial settings; negotiated clients retain structured results", async t => {
  const f = bridgeFixture(t);
  const server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions: f.sessions, router,
    hostName: "test", version: "test", recentCli: async () => [] });
  await server.listen();
  t.after(() => server.close());
  const peers: Peer[] = [];
  t.after(() => peers.forEach(p => p.ws.terminate()));
  for (const features of [undefined, ["settingsResult"]]) {
    const peer = new Peer(`ws://127.0.0.1:${server.address().port}/ws`);
    peers.push(peer); await peer.open();
    peer.ws.send(JSON.stringify({ t: "hello", token, clientId: "compat", features }));
    await peer.take("ready");
    const reqId = features ? "modern-settings" : "legacy-settings";
    const start = f.posts.length;
    peer.send({ t: "set_model", session: bridgeId, model: "claude-sonnet-test", effort: "high", reqId });
    await waitFor(() => f.posts.length > start);
    const control = (index: number) => (f.posts[index] as { events: { payload: { request_id: string } }[] }).events[0]!.payload.request_id;
    f.emit({ type: "control_response", response: { request_id: control(start), subtype: "success", response: {} } });
    await waitFor(() => f.posts.length > start + 1);
    f.emit({ type: "control_response", response: { request_id: control(start + 1), subtype: "error", error: "effort rejected" } });
    const response = (await peer.take("res", m => m.reqId === reqId)).msg;
    assert.equal(response.ok, !!features);
    if (response.ok) assert.deepEqual(response.data, { status: "partial", model: "claude-sonnet-test", errors: { effort: "effort rejected" } });
    else assert.match(response.error, /effort rejected/);
  }
});

test("scoped approvals are hidden and refused for legacy clients; sent is never reported as always applied", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const log = f.sessions.log(id);
  log.append({ kind: "permission", id: "scoped", tool: "Bash", title: "", summary: "git status", input: "git status", canAlways: true, alwaysAllow: { scope: "session", summary: "Bash(git status:*)" } });
  log.append({ kind: "permission_decided", id: "scoped", decision: "allow_always", ruleStatus: "sent" });
  const old = await f.auth();
  old.send({ t: "attach", session: id });
  const events = (await old.take("events")).msg.events;
  assert.equal(events.find(e => e.kind === "permission")?.canAlways, false);
  assert.equal(events.find(e => e.kind === "permission_decided")?.decision, "allow");
  old.send({ t: "decide", session: id, id: "scoped", decision: "allow_always", reqId: "unsafe-old" });
  const denied = (await old.take("res", m => m.reqId === "unsafe-old")).msg;
  assert.ok(!denied.ok && /업데이트/.test(denied.error));
  const modern = await f.connect();
  modern.ws.send(JSON.stringify({ t: "hello", token, clientId: "modern", features: ["scopedAlways"] }));
  await modern.take("ready"); modern.send({ t: "attach", session: id });
  assert.deepEqual((await modern.take("events")).msg.events, log.tail().events);
  assert.equal(log.tail().events.find(e => e.kind === "permission")?.canAlways, true, "storage is never downgraded");
});

test("missing image-only rows keep legacy placeholders in tail, history, replay and subagent pages", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const log = f.sessions.log(id);
  const { messageContent } = await import("../src/images.ts");
  const content = messageContent("[Image: source: missing.png]", data => log.image(data), { cwd: f.cwd });
  assert.equal(content.images.length, 0);
  const event = log.append({ kind: "assistant", msg: "missing-image", model: "test", tools: [], ...content });
  const sub = f.sessions.subLog(id, "sub-missing")!;
  sub.append({ kind: "assistant", msg: "missing-image", model: "test", tools: [], ...content });
  const old = await f.auth();
  old.send({ t: "attach", session: id });
  const check = (events: SessionEvent[]) => {
    const row = events.find(e => e.kind === "assistant" && e.msg === "missing-image");
    assert.deepEqual(row?.images, [{ type: "image", mediaType: "image/png" }]);
    assert.equal(JSON.stringify(row).includes(f.cwd), false);
  };
  check((await old.take("events")).msg.events);
  old.send({ t: "history", session: id, beforeSeq: event.seq + 1, reqId: "images-history" });
  check((await old.take("history")).msg.events);
  old.send({ t: "attach", session: id, epoch: log.epoch, afterSeq: event.seq - 1 });
  check((await old.take("events")).msg.events);
  old.send({ t: "req", reqId: "images-sub", op: { op: "sub", session: id, sub: "sub-missing" } });
  const page = (await old.take("res", m => m.reqId === "images-sub")).msg;
  assert.ok(page.ok); check((page.data as { events: SessionEvent[] }).events);
  const modern = await f.connect();
  modern.ws.send(JSON.stringify({ t: "hello", token, clientId: "files", features: ["sessionFiles", "unknown-future-feature"] }));
  await modern.take("ready"); modern.send({ t: "attach", session: id });
  assert.deepEqual((await modern.take("events")).msg.events.find(e => e.seq === event.seq), event);
});

test("legacy missing-image pages retain every row within the frame cap", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const log = f.sessions.log(id);
  for (let index = 0; index < 2200; index++) log.append({ kind: "assistant", msg: `missing-${index}`, model: "test", text: "", tools: [],
    files: [{ id: `file-${index}`, name: "missing.png", bytes: 0, mediaType: "image/png", status: "missing" }] });
  const old = await f.auth();
  old.send({ t: "attach", session: id });
  const tail = await old.take("events");
  let page = tail.msg.events, hasOlder = tail.msg.tail!.hasOlder;
  const seen = [...page];
  while (hasOlder) {
    const beforeSeq = page[0]!.seq;
    old.send({ t: "history", session: id, beforeSeq, reqId: `missing-${beforeSeq}` });
    const history = (await old.take("history")).msg;
    page = history.events; hasOlder = history.hasOlder;
    seen.unshift(...page);
  }
  assert.equal(seen.filter(event => event.kind === "assistant" && event.msg.startsWith("missing-")).length, 2200);
  assert.ok(seen.filter(event => event.files?.some(file => file.status !== "ready")).length === 0);
  assert.ok(old.received.every(frame => frame.bytes <= FRAME_CAP));
  assert.deepEqual(f.diagnostics, []);
});

test("set_mode returns correlated success/error and broadcasts the mode event", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const peer = await f.auth();
  peer.send({ t: 'attach', session: id });
  await peer.take('events');
  peer.send({ t: 'set_mode', reqId: 'mode-ok', sessionId: id, mode: 'plan' });
  assert.deepEqual((await peer.take('res', m => m.reqId === 'mode-ok')).msg, { t: 'res', reqId: 'mode-ok', ok: true, data: { status: 'applied', permissionMode: 'plan' } });
  await peer.take('events', m => m.events.some(e => e.kind === 'mode' && e.mode === 'plan'));
  peer.send({ t: 'set_mode', reqId: 'mode-error', sessionId: 'missing', mode: 'auto' });
  assert.equal((await peer.take('res', m => m.reqId === 'mode-error')).msg.ok, false);
});

test("a legal queue over one frame arrives chunked, exact, and edit and send read the original", async t => {
  const users: string[] = [];
  const { queryFn, hold } = holdingQuery(users);
  const f = await memoryHost(t, queryFn);
  f.peer.receive({ t: "send", session: f.id, clientMsgId: "busy", text: "hold the turn" });
  await f.peer.take("ack");
  const korean = "가".repeat(70_000); // 210,000 UTF-8 bytes
  const ascii = "a".repeat(140_000);
  f.sessions.enqueue(f.id, "queued-0", korean);
  f.sessions.enqueue(f.id, "queued-1", ascii);
  f.sessions.holdQueue(f.id);
  const chunked = new MemoryPeer();
  f.server.connected(chunked);
  chunked.receive({ t: "hello", token, clientId: "chunked", features: ["chunkedFrames"] });
  const sizes: number[] = [];
  const ready = await chunkedFrame(chunked, msg => msg.t === "ready", sizes) as Extract<HostMsg, { t: "ready" }>;
  assert.ok(sizes.length > 1, "the list did not fit one frame");
  assert.ok(sizes.every(size => size <= FRAME_CAP), `${Math.max(...sizes)} bytes`);
  const listed = ready.sessions.find(session => session.id === f.id)!;
  assert.deepEqual(listed.queue?.map(row => row.id), ["queued-0", "queued-1"]);
  assert.equal(listed.queue?.[0]?.text, korean, "the whole text, not a preview");
  assert.equal(listed.queue?.[1]?.text, ascii);
  assert.equal(listed.queueHeld, true);
  // The sessions broadcast takes the same path.
  f.server.onSessions();
  t.mock.timers.tick(150);
  const broadcast = await chunkedFrame(chunked, msg => msg.t === "sessions") as Extract<HostMsg, { t: "sessions" }>;
  assert.equal(broadcast.sessions.find(session => session.id === f.id)?.queue?.[1]?.text, ascii);
  // A single row whose JSON escaping outgrows a frame is chunked too and comes back whole.
  const escapes = "\u0000".repeat(44_000);
  f.sessions.enqueue(f.id, "escaped", escapes);
  chunked.receive({ t: "req", reqId: "edit", op: { op: "queue_remove", session: f.id, id: "escaped" } });
  const edit = await chunkedFrame(chunked, msg => msg.t === "res" && msg.reqId === "edit") as Extract<HostMsg, { t: "res" }>;
  assert.ok(edit.ok);
  if (edit.ok) assert.equal((edit.data as { text: string }).text, escapes);
  // Sending hands the stored text to the model unchanged.
  chunked.receive({ t: "req", reqId: "send-now", op: { op: "queue_send", session: f.id, id: "queued-1" } });
  const sent = await chunkedFrame(chunked, msg => msg.t === "res" && msg.reqId === "send-now") as Extract<HostMsg, { t: "res" }>;
  assert.ok(sent.ok, sent.ok ? "" : sent.error);
  hold.resolve();
  for (let i = 0; i < 50 && !users.includes(ascii); i++) await nextTick();
  assert.ok(users.includes(ascii), "the queued message reached the SDK whole");
});

test("an old client keeps the old wire while a requesting one gets the same list chunked", async t => {
  const { queryFn } = holdingQuery([]);
  const f = await memoryHost(t, queryFn);
  f.peer.receive({ t: "send", session: f.id, clientMsgId: "busy", text: "hold" });
  await f.peer.take("ack");
  f.sessions.enqueue(f.id, "q0", "a".repeat(140_000));
  f.sessions.enqueue(f.id, "q1", "b".repeat(140_000));
  const old = new MemoryPeer();
  f.server.connected(old);
  old.receive({ t: "hello", token, clientId: "old" });
  assert.equal((await old.take("error")).code, "too_large");
  assert.equal(old.frames.some(frame => frame.t === "ready" || frame.t === "chunk"), false, "no chunk is sent unasked");
  const fresh = new MemoryPeer();
  f.server.connected(fresh);
  fresh.receive({ t: "hello", token, clientId: "new", features: ["chunkedFrames"] });
  const ready = await chunkedFrame(fresh, msg => msg.t === "ready") as Extract<HostMsg, { t: "ready" }>;
  assert.equal(ready.sessions.find(session => session.id === f.id)?.queue?.length, 2);
});

test("small answers stay one frame for a client that asked for chunks", async t => {
  const f = await memoryHost(t);
  const peer = new MemoryPeer();
  f.server.connected(peer);
  peer.receive({ t: "hello", token, clientId: "small", features: ["chunkedFrames"] });
  const ready = await peer.take("ready");
  assert.ok(Buffer.byteLength(JSON.stringify(ready)) <= FRAME_CAP);
  assert.equal(peer.frames.some(frame => frame.t === "chunk"), false);
});

test("many sessions with full queues still arrive chunked, in order and exact", async t => {
  const { queryFn } = holdingQuery([]);
  const f = await memoryHost(t, queryFn);
  const whole = ["가".repeat(70_000), "b".repeat(140_000)];
  const ids: string[] = [];
  for (let n = 0; n < 4; n++) {
    const id = await f.sessions.create({ clientMsgId: `many-${n}`, cwd: f.dir, model: "test", effort: null, text: "" });
    f.sessions.send(id, `hold-${n}`, "hold");
    f.sessions.enqueue(id, `m${n}-0`, whole[0]!);
    f.sessions.enqueue(id, `m${n}-1`, whole[1]!);
    ids.push(id);
  }
  const peer = new MemoryPeer();
  f.server.connected(peer);
  peer.receive({ t: "hello", token, clientId: "many", features: ["chunkedFrames"] });
  const sizes: number[] = [];
  const ready = await chunkedFrame(peer, msg => msg.t === "ready", sizes) as Extract<HostMsg, { t: "ready" }>;
  assert.ok(sizes.length > 1);
  assert.ok(sizes.every(size => size <= FRAME_CAP));
  assert.equal(ready.sessions.length, ids.length + 1, "the fixture's own session plus four");
  for (const [n, id] of ids.entries()) {
    const session = ready.sessions.find(candidate => candidate.id === id);
    assert.deepEqual(session?.queue?.map(row => row.id), [`m${n}-0`, `m${n}-1`]);
    assert.equal(session?.queue?.[0]?.text, whole[0]);
    assert.equal(session?.queue?.[1]?.text, whole[1]);
  }
});

test("a message past the chunk bound is not split; the existing too_large answer stands", async t => {
  const sessions = { list: () => [], groups: () => undefined, watchAttached: () => {}, pollDesktop: async () => {}, pollQueued: () => {}, prepareRefresh: () => true } as never;
  const server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions, router,
    hostName: "x".repeat(CHUNK_MESSAGE_MAX + 1), version: "0", recentCli: async () => [] });
  await server.listen();
  t.after(() => server.close());
  const peer = new MemoryPeer();
  server.connected(peer);
  peer.receive({ t: "hello", token, clientId: "oversized", features: ["chunkedFrames"] });
  assert.equal((await peer.take("error")).code, "too_large");
  assert.equal(peer.frames.some(frame => frame.t === "chunk"), false);
});

test("queued desktop sends catch a one-second idle gap with no phone and no full or network poll", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = bridgeFixture(t);
  f.registry.get(bridgeId)!.status = "busy";
  f.status("running");
  await f.sessions.pollDesktop();
  f.sessions.enqueue(bridgeId, "short-idle", "send in the idle gap");
  f.sessions.enqueue(bridgeId, "next-idle", "wait for my own turn too");
  const reads = f.stateReads();
  const server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions: f.sessions, router,
    hostName: "fixture", version: "fixture", recentCli: async () => [],
  });
  await server.listen();
  t.after(() => server.close());
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(f.posts.length, 0);
  f.registry.get(bridgeId)!.status = "idle";
  // Still "running" in the Remote Control cache: only the local registry sees this brief gap.
  t.mock.timers.tick(1000);
  await tick(); await tick();
  assert.equal(f.posts.length, 1, "the queued send did not wait for a phone or a 3/15-second poll");
  assert.equal(f.stateReads(), reads, "the queue tick made no Remote Control state request");
  assert.equal(f.sessions.summaryOf(bridgeId)?.queue?.[0]?.id, "next-idle");
  assert.ok(f.posts[0] && JSON.stringify(f.posts[0]).includes("send in the idle gap"));
  assert.equal(f.sessions.summaryOf(bridgeId)?.state, "running");
  // A stale idle registry cannot immediately send the next queued item before this turn answers.
  f.sessions.pollQueued();
  await tick();
  assert.equal(f.posts.length, 1);
});

test("desktop polling runs on its own timer with no phone connected, so completion is detected", { timeout: 15_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-live-wire-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const file = path.join(project, `${id}.jsonl`);
  let now = Date.now();
  let processes = "";
  let calls = 0;
  fs.writeFileSync(file, JSON.stringify({ type: "user", cwd: project, message: { content: "synthetic prompt" } }) + "\n");
  const f = await fixture(t, { now: () => now }, root, () => { calls++; return processes; });
  const baseline = calls;
  processes = `42 claude --resume=${id}`;
  now += 3000;
  await delay(3100);
  assert.ok(calls > baseline, "no phone connected: the desktop poll still runs on its timer");
  assert.ok(f.sessions.list().some(s => s.id === id && s.state === "running"), "a Mac turn is detected with no clients");
  const peer = await f.auth();
  // A connected observer reports visibility, which intentionally restores the three-second cadence.
  peer.send({ t: "presence", visible: true });
  await peer.barrier();
  processes = "";
  now += 6000;
  await delay(3100);
  assert.ok(f.sessions.list().some(s => s.id === id && s.state === "stopped"), "completion is detected on the next visible-client poll");
  const changed = await peer.take("sessions", msg => msg.sessions.some(s => s.id === id && s.state === "stopped"));
  assert.equal(changed.msg.sessions[0]?.pending, 0);
});

test("desktop sessions use ready, history, blobs and continue through a same-session ACK", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-wire-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const lines = [{ type: "user", cwd: "/synthetic", uuid: "u1", message: { content: "Wire prompt" } }];
  let data = lines.map(r => JSON.stringify(r) + "\n").join("");
  for (let i = 0; i < 30; i++) data += JSON.stringify({ type: "assistant", uuid: `a${i}`, message: { model: "test", content: [{ type: "text", text: "a".repeat(20_000) }] } }) + "\n";
  data += JSON.stringify({ type: "assistant", uuid: "large", message: { model: "test", content: [{ type: "text", text: "z".repeat(100_000) }] } }) + "\n";
  fs.writeFileSync(path.join(project, `${id}.jsonl`), data);
  const f = await fixture(t, {}, root);
  const peer = await f.connect();
  peer.send({ t: "hello", token, clientId: "desktop-reader" });
  const ready = await peer.take("ready");
  assert.equal(ready.msg.sessions[0]?.readOnly, false);
  peer.send({ t: "attach", session: id });
  const tail = await peer.take("events");
  assert.equal(tail.msg.tail?.hasOlder, true);
  assert.ok(tail.bytes <= FRAME_CAP);
  peer.send({ t: "history", session: id, beforeSeq: tail.msg.events[0]!.seq, reqId: "older" });
  const history = await peer.take("history");
  assert.ok(history.msg.events.at(-1)!.seq < tail.msg.events[0]!.seq);
  assert.ok(history.bytes <= FRAME_CAP);
  const large = tail.msg.events.at(-1)!;
  assert.ok(large.kind === "assistant" && typeof large.text !== "string");
  peer.send({ t: "req", reqId: "blob", op: { op: "blob", session: id, id: large.text.blob } });
  const blob = await peer.take("res");
  assert.equal(blob.msg.ok && (blob.msg.data as BlobChunk).text, "z".repeat(60_000));
  peer.send({ t: "send", session: id, clientMsgId: "continue-wire", text: "continue" });
  const ack = await peer.take("ack");
  assert.equal(ack.msg.session, id);
  peer.send({ t: "attach", session: ack.msg.session });
  const continued = await peer.take("events", msg => msg.session === ack.msg.session && !!msg.tail);
  assert.ok(continued.msg.events.some(e => e.kind === "notice" && e.code === "desktop_resumed"));
  const imported = continued.msg.events.find(e => e.kind === "assistant" && e.msg === "large");
  assert.ok(imported?.kind === "assistant" && typeof imported.text !== "string");
  peer.send({ t: "req", reqId: "continued-blob", op: { op: "blob", session: ack.msg.session, id: imported.text.blob } });
  const copiedBlob = await peer.take("res", msg => msg.reqId === "continued-blob");
  assert.equal(copiedBlob.msg.ok && (copiedBlob.msg.data as BlobChunk).text, "z".repeat(60_000));
  peer.send({ t: "send", session: id, clientMsgId: "continue-wire", text: "continue" });
  assert.equal((await peer.take("ack")).msg.session, ack.msg.session);
  await waitFor(() => f.fake.users.length === 1);
  assert.equal(f.fake.options.length, 1);
  assert.equal(f.fake.options[0]?.resume, id);
  assert.equal(f.fake.options[0]?.forkSession, undefined);
  assert.equal(f.sessions.list().length, 1);
  assert.equal(fs.readFileSync(path.join(project, `${id}.jsonl`), "utf8"), data);
});

function get(port: number, target: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: target, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"] ?? "", body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("HTTP test request timed out")));
  });
}

function readAll(sessions: Sessions, id: string): SessionEvent[] {
  const log = sessions.log(id);
  const events: SessionEvent[] = [];
  let cursor = 0;
  for (;;) {
    const page = log.readAfter(cursor);
    events.push(...page.events);
    if (!page.more) return events;
    assert.ok(page.events.length > 0);
    cursor = page.events.at(-1)!.seq;
  }
}

function seedLargeLog(sessions: Sessions, id: string): SessionEvent[] {
  const log = sessions.log(id);
  let bytes = 0;
  for (let i = 0; i < 120; i++) {
    const event = log.append({ kind: "tool_result", toolUseId: `tool-${i}`, ok: true, text: `${i}:` + "x".repeat(20 * 1024) });
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
  }
  assert.ok(bytes >= 2 * 1024 * 1024, "Fixture must actually contain at least 2 MiB of inline events");
  return readAll(sessions, id);
}

test("hello denies and closes a wrong token, and returns ready with sessions for the right token", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  const wrong = await f.connect();
  wrong.send({ t: "hello", token: "wrong", clientId: "wrong-client" });
  assert.deepEqual((await wrong.take("denied")).msg, { t: "denied", reason: "token" });
  assert.deepEqual(await wrong.closed, { code: 4003, reason: "denied" });
  const right = await f.connect();
  right.send({ t: "hello", token, clientId: "right-client" });
  const ready = (await right.take("ready")).msg;
  // `queue`: this host keeps what the phone queues, so the app hands it over instead of holding it.
  // `diffScope`: the diff pane may ask for uncommitted work or the branch, not only the host's order.
  assert.deepEqual(ready.host, { name: "test-host", version: "test-version", routerOk: true, queue: true, capabilities: { sessionFiles: true, folderFiles: true, diffScope: true } });
  assert.deepEqual(ready.sessions, f.sessions.list());
  assert.equal(ready.sessions[0]?.id, id);
});

test("static serves HTML, strips app TypeScript, exposes only the shared protocol and rejects traversal", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const index = await get(f.port, "/");
  assert.equal(index.status, 200);
  assert.match(index.type, /^text\/html/);
  assert.match(index.body, /<!doctype html>/i);
  const source = fs.readFileSync(path.join(webDir, "app.ts"), "utf8");
  assert.ok(source.includes("submit(text: string): boolean"), "Known TypeScript signature must exist in the source");
  const app = await get(f.port, "/app.ts");
  assert.equal(app.status, 200);
  assert.match(app.type, /^text\/javascript/);
  assert.match(app.body, /submit\(text\s*\)\s*\{/);
  assert.ok(!app.body.includes("submit(text: string): boolean"));
  assert.ok(!app.body.includes(": string"));
  const protocol = await get(f.port, "/src/protocol.ts");
  assert.equal(protocol.status, 200);
  assert.match(protocol.type, /^text\/javascript/);
  assert.match(protocol.body, /export const FRAME_CAP/);
  assert.ok(!protocol.body.includes("export interface"));
  // The relay's encryption, the chunk codec and tweetnacl are the other shared files; the service
  // worker is an app file.
  assert.match((await get(f.port, "/src/e2ee.ts")).body, /export function phoneHello/);
  const chunks = await get(f.port, "/src/chunks.ts");
  assert.equal(chunks.status, 200);
  assert.match(chunks.type, /^text\/javascript/);
  assert.match(chunks.body, /export class FrameAssembler/, "the browser link loads the same decoder");
  assert.ok(!chunks.body.includes("export interface"));
  const naclJs = await get(f.port, "/vendor/nacl-fast.min.js");
  assert.equal(naclJs.status, 200);
  assert.match(naclJs.type, /^text\/javascript/);
  const sw = await get(f.port, "/sw.ts");
  assert.match(sw.type, /^text\/javascript/);
  assert.match(sw.body, /showNotification/);
  assert.ok(!sw.body.includes("interface SwScope"));
  // node:http preserves the literal path; fetch/URL would normalize ../ before sending it.
  for (const target of ["/../src/sessions.ts", "/src/sessions.ts", "/%2e%2e%2fsrc/sessions.ts"]) {
    assert.equal((await get(f.port, target)).status, 404, target);
  }
});

test("presence: a phone that reported visible within 30 s counts as looking; hidden, gone or silent does not", { timeout: TEST_TIMEOUT }, async t => {
  let now = 1_000_000;
  const subscribed: { clientId: string; endpoint: string; lang: string }[] = [];
  const unsubscribed: string[] = [];
  const native: { clientId: string; token: string; lang: string }[] = [];
  const nativeRemoved: string[] = [];
  const f = await fixture(t, {
    now: () => now,
    push: { publicKey: "BPUBLICKEY", subscribe: (clientId, sub, lang) => { subscribed.push({ clientId, endpoint: sub.endpoint, lang }); }, unsubscribe: (id) => { unsubscribed.push(id); } },
    expoPush: { subscribe: (clientId, token, lang) => { native.push({ clientId, token, lang }); }, unsubscribe: id => { nativeRemoved.push(id); } },
  });
  const looking = (): boolean => f.server.someoneLooking();
  const peer = await f.auth();
  assert.equal(looking(), false, "connected is not looking");
  peer.send({ t: "presence", visible: true });
  await peer.barrier();
  assert.equal(looking(), true);
  now += VISIBLE_MS - 1;
  assert.equal(looking(), true);
  now += 2;
  assert.equal(looking(), false, "no fresh report: the app may be frozen in the background");
  peer.send({ t: "presence", visible: true });
  await peer.barrier();
  peer.send({ t: "presence", visible: false });
  await peer.barrier();
  assert.equal(looking(), false, "hidden");
  peer.send({ t: "presence", visible: true });
  await peer.barrier();
  // Push requests carry the device id from hello.
  peer.send({ t: "req", reqId: "k", op: { op: "push_key" } });
  assert.deepEqual((await peer.take("res", m => m.reqId === "k")).msg, { t: "res", reqId: "k", ok: true, data: { publicKey: "BPUBLICKEY" } });
  peer.send({ t: "req", reqId: "s", op: { op: "push_subscribe", subscription: { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }, lang: "ko" } });
  await peer.take("res", m => m.reqId === "s");
  assert.deepEqual(subscribed, [{ clientId: "test-client", endpoint: "https://push.example/1", lang: "ko" }]);
  peer.send({ t: "req", reqId: "u", op: { op: "push_unsubscribe" } });
  await peer.take("res", m => m.reqId === "u");
  assert.deepEqual(unsubscribed, ["test-client"]);
  peer.send({ t: "req", reqId: "native", op: { op: "expo_push_subscribe", token: "ExpoPushToken[test]", lang: "en" } });
  assert.equal((await peer.take("res", m => m.reqId === "native")).msg.ok, true);
  assert.deepEqual(native, [{ clientId: "test-client", token: "ExpoPushToken[test]", lang: "en" }]);
  peer.send({ t: "req", reqId: "native-off", op: { op: "expo_push_unsubscribe" } });
  await peer.take("res", m => m.reqId === "native-off");
  assert.deepEqual(nativeRemoved, ["test-client"]);
  peer.ws.close();
  await waitFor(() => !looking());
});

test("seen requires fresh visible presence and an attached session, including reconnects", async t => {
  let now = 1_000_000;
  const f = await fixture(t, { now: () => now });
  const id = await f.create();
  const peer = await f.auth();
  const reason = () => f.sessions.summaryOf(id)?.attention?.reason;
  peer.send({ t: "attach", session: id });
  await peer.take("events");
  peer.send({ t: "seen", session: id });
  await peer.barrier();
  assert.equal(reason(), "finished");
  assert.equal(f.server.sessionSeenRecently(id), false, "a background attach is not a look");
  peer.send({ t: "presence", visible: true });
  peer.send({ t: "seen", session: id });
  await peer.barrier();
  assert.equal(reason(), undefined);
  f.sessions.markUnread(id);
  peer.send({ t: "presence", visible: false });
  peer.send({ t: "seen", session: id });
  await peer.barrier();
  assert.equal(reason(), "finished", "an older phone's background seen is ignored");
  const reconnected = await f.auth();
  reconnected.send({ t: "attach", session: id });
  reconnected.send({ t: "seen", session: id });
  await reconnected.barrier();
  assert.equal(reason(), "finished");
  reconnected.send({ t: "presence", visible: true });
  await reconnected.barrier();
  now += VISIBLE_MS;
  reconnected.send({ t: "seen", session: id });
  await reconnected.barrier();
  assert.equal(reason(), "finished", "a stale presence cannot clear attention");
  reconnected.send({ t: "presence", visible: true });
  reconnected.send({ t: "detach", session: id });
  reconnected.send({ t: "seen", session: id });
  await reconnected.barrier();
  assert.equal(reason(), "finished", "a different focused screen cannot acknowledge this session");
  reconnected.send({ t: "attach", session: id });
  reconnected.send({ t: "seen", session: id });
  await reconnected.barrier();
  assert.equal(reason(), undefined);
});

test("a session read on a visible phone loses the app's unread dot in the next list, and a background seen cannot clear it", async t => {
  const cliId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const app = claudeAppData(t, cliId);
  const f = await fixture(t, {}, undefined, undefined, scriptedQuery(cliId).queryFn, app.root);
  const id = await f.create();
  const unread = () => f.sessions.list().find(s => s.id === id)?.unread === true;
  assert.equal(unread(), true, "the Claude app still lists the session as unread");
  const peer = await f.auth();
  peer.send({ t: "attach", session: id });
  await peer.take("events");
  peer.send({ t: "presence", visible: true });
  peer.send({ t: "seen", session: id });
  const frame = await peer.take("sessions", m => m.sessions.some(s => s.id === id && s.unread === false));
  assert.equal(frame.msg.sessions.find(s => s.id === id)?.unread, false, "reading it on the phone resends the list without the dot");
  peer.send({ t: "unread", session: id });
  await peer.barrier();
  assert.equal(unread(), true, "mark-unread brings the dot back");
  peer.send({ t: "presence", visible: false });
  peer.send({ t: "seen", session: id });
  await peer.barrier();
  assert.equal(unread(), true, "a background seen cannot mark the app's dot read");
});

test("WebSocket upgrade refuses an evil Origin", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: f.port, path: "/ws", agent: false,
      headers: { Origin: "http://evil.example", Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": Buffer.alloc(16).toString("base64") },
    });
    t.after(() => req.destroy());
    req.on("upgrade", (_res, socket) => { socket.destroy(); reject(new Error("Cross-origin upgrade was accepted")); });
    req.on("response", res => { res.resume(); reject(new Error(`Expected refused upgrade, received HTTP ${res.statusCode}`)); });
    req.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") { reject(error); return; }
      resolve();
    });
    req.setTimeout(2000, () => req.destroy(new Error("Upgrade test timed out")));
    req.end();
  });
});

test("attach tails without a cursor, replays exactly after epoch/seq, and tails for a wrong epoch", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  const first = await f.auth();
  first.send({ t: "attach", session: id });
  const tail = (await first.take("events")).msg;
  assert.deepEqual(tail.tail, { hasOlder: false });
  assert.deepEqual(tail.events, readAll(f.sessions, id));
  const afterSeq = tail.events.at(-1)!.seq;
  f.sessions.send(id, "next-user", "second turn");
  await waitFor(() => f.fake.users.length === 2 && f.sessions.list()[0]?.state === "idle");
  await first.barrier();
  const live = first.eventFrames().flatMap(frame => frame.msg.events);
  assert.ok(live.some(event => event.kind === "user" && event.clientMsgId === "next-user"));
  assert.equal(new Set(live.map(event => event.seq)).size, live.length);

  const second = await f.auth();
  second.send({ t: "attach", session: id, epoch: tail.epoch, afterSeq });
  await second.barrier();
  const replay = second.eventFrames();
  assert.ok(replay.length > 0);
  assert.ok(replay.every(frame => !Object.hasOwn(frame.msg, "tail")));
  const expected = readAll(f.sessions, id).filter(event => event.seq > afterSeq);
  assert.deepEqual(replay.flatMap(frame => frame.msg.events), expected);
  const seqs = replay.flatMap(frame => frame.msg.events.map(event => event.seq));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.ok(seqs.every(seq => seq > afterSeq));
  second.send({ t: "detach", session: id });
  second.send({ t: "attach", session: id, epoch: "wrong-epoch", afterSeq });
  const wrongEpoch = (await second.take("events")).msg;
  assert.equal(wrongEpoch.epoch, tail.epoch);
  assert.deepEqual(wrongEpoch.tail, { hasOlder: false });
  assert.deepEqual(wrongEpoch.events, readAll(f.sessions, id));
});

for (const { textSize, count, poll } of [{ textSize: 20, count: 120, poll: false }, { textSize: 3000, count: 120, poll: false }, { textSize: 20, count: 20, poll: true }]) test(`connected clients receive the rebuilt desktop epoch as a tail (${count} events, ${textSize} characters, ${poll ? "poll" : "send"})`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-rebase-wire-"));
  const projects = path.join(root, "projects", "project");
  const dir = path.join(root, "host");
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(projects, `${id}.jsonl`), Array.from({ length: count }, (_, i) =>
    JSON.stringify({ type: "user", uuid: `desktop-${i}`, cwd: root, message: { content: `${i}:` + "x".repeat(textSize) } }) + "\n").join(""));
  fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify([{ id, sdkSessionId: id, cwd: root, model: "test", effort: null,
    title: "test", createdAt: 1, updatedAt: 1, state: "idle", createdBy: "old", contextWindow: null, desktopHandoff: "excluded" }]));
  const registry = new Map<string, DesktopProcess>([[id, { sessionId: id, pid: 42, status: "idle" }]]);
  const bridge = new BridgeClient({ auth: () => ({ accessToken: "test", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
    if (options?.method === "POST") return Response.json({});
    if (String(url).includes("/events/stream")) return new Response(new ReadableStream<Uint8Array>({ start(controller) { options?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }));
    if (String(url).includes("/events?")) return Response.json({ data: [] });
    return Response.json({ worker_status: "idle" });
  } });
  let server: HostServer;
  const sessions = new Sessions({ dir, desktopProjects: path.dirname(projects), desktopRegistry: () => registry, desktopProcesses: () => "", bridgeClient: bridge,
    permissions: PermissionQueue.open(path.join(root, "permissions.json")), router, queryFn: () => { throw new Error("unexpected SDK query"); },
    onEvent: session => server.onEvent(session), onSessions: () => server.onSessions() });
  server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions, router, hostName: "test", version: "test", recentCli: async () => [] });
  const peers = [new MemoryPeer(), new MemoryPeer()];
  t.after(async () => { await server.close(); sessions.shutdown(); await nextTick(); fs.rmSync(root, { recursive: true, force: true }); });
  const oldLog = sessions.log(id);
  for (let i = 0; i < 100; i++) oldLog.append({ kind: "user", text: `old-${i}`, clientMsgId: `old-${i}` });
  for (const peer of peers) {
    server.connected(peer);
    peer.receive({ t: "hello", token, clientId: "epoch-phone" });
    await peer.take("ready");
    peer.receive({ t: "attach", session: id });
    assert.equal((await peer.take("events")).events.at(-1)?.seq, 100);
  }
  registry.get(id)!.bridgeSessionId = "bridge";
  if (poll) await sessions.pollDesktop();
  else await sessions.send(id, "new-phone-message", "continue");
  const log = sessions.log(id);
  assert.notEqual(log.epoch, oldLog.epoch);
  assert.ok(log.lastSeq >= count);
  if (poll) await waitFor(() => peers.every(peer => peer.frames.some(frame => frame.t === "events")));
  for (const peer of peers) {
    const frame = await peer.take("events");
    assert.equal(frame.epoch, log.epoch);
    assert.deepEqual(frame.tail, { hasOlder: textSize === 3000 });
    assert.deepEqual(frame.events, log.before(frame.events.at(-1)!.seq + 1).events);
    let events = frame.events;
    let hasOlder = frame.tail!.hasOlder;
    while (hasOlder) {
      peer.receive({ t: "history", session: id, beforeSeq: events[0]!.seq, reqId: `older-${events[0]!.seq}` });
      const page = await peer.take("history");
      events = [...page.events, ...events];
      hasOlder = page.hasOlder;
    }
    assert.deepEqual(events, readAll(sessions, id).filter(event => event.seq <= frame.events.at(-1)!.seq));
    assert.deepEqual(events.map(event => event.seq), Array.from({ length: frame.events.at(-1)!.seq }, (_, i) => i + 1));
  }
  const appended = log.append({ kind: "user", text: "same epoch", clientMsgId: "same-epoch" });
  server.onEvent(id);
  for (const peer of peers) {
    const frames = peer.frames.filter((frame): frame is Extract<HostMsg, { t: "events" }> => frame.t === "events");
    assert.ok(frames.every(frame => frame.epoch === log.epoch && !frame.tail));
    assert.equal(frames.flatMap(frame => frame.events).filter(event => event.seq === appended.seq).length, 1);
  }
});

test("history rebuild reports its epoch and sends the replacement tail to every attached reader", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-epoch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const file = path.join(project, `${id}.jsonl`);
  const transcript = (prefix: string) => Array.from({ length: 120 }, (_, i) => JSON.stringify({ type: "user", uuid: `${prefix}-${i}`, cwd: root, message: { content: `${prefix}-${i} ${"x".repeat(3000)}` } }) + "\n").join("");
  fs.writeFileSync(file, transcript("old"));
  const f = await fixture(t, {}, root);
  const peers = [new MemoryPeer(), new MemoryPeer()];
  for (const peer of peers) {
    f.server.connected(peer);
    peer.receive({ t: "hello", token, clientId: "history-reader" });
    await peer.take("ready");
    peer.receive({ t: "attach", session: id });
  }
  const first = await peers[0]!.take("events");
  await peers[1]!.take("events");
  fs.writeFileSync(file, transcript("newer"));
  peers[0]!.emit("message", JSON.stringify({ t: "history", session: id, beforeSeq: first.events[0]!.seq, reqId: "old-page", epoch: first.epoch }));
  const response = await peers[0]!.take("history");
  assert.notEqual(response.epoch, first.epoch);
  assert.deepEqual(response.events, []);
  for (const peer of peers) {
    const tail = await peer.take("events");
    assert.equal(tail.epoch, response.epoch);
    assert.ok(tail.tail);
    assert.ok(tail.events.some(event => event.kind === "user" && event.text.startsWith("newer")));
  }
  peers[0]!.receive({ t: "history", session: id, beforeSeq: first.events[0]!.seq, reqId: "legacy" });
  const legacy = await peers[0]!.take("history");
  assert.equal(legacy.epoch, response.epoch);
  assert.ok(legacy.events.length > 0);
});

test("backpressured tail updates coalesce and deliver the latest snapshot after drain", async t => {
  const f = await memoryHost(t);
  const log = f.sessions.log(f.id);
  f.peer.bufferedAmount = 2 * 1024 * 1024;
  f.peer.receive({ t: "attach", session: f.id });
  for (let i = 0; i < 10; i++) {
    log.append({ kind: "user", text: `update-${i}`, clientMsgId: `update-${i}` });
    f.peer.receive({ t: "attach", session: f.id });
  }
  assert.equal(f.peer.frames.filter(frame => frame.t === "events").length, 0);
  t.mock.timers.tick(1000);
  assert.equal(f.peer.frames.filter(frame => frame.t === "events").length, 0);
  f.peer.bufferedAmount = 0;
  t.mock.timers.tick(200);
  const tail = await f.peer.take("events");
  assert.ok(tail.tail);
  assert.equal(tail.events.at(-1)?.seq, log.lastSeq);
  assert.equal(f.peer.frames.filter(frame => frame.t === "events").length, 0);
});

/** Script only the SDK boundary: observe the model when each input is actually read. */
function orderedQuery() {
  const modelReply = Promise.withResolvers<void>();
  const calls: string[] = [];
  const users: { text: string; model: string }[] = [];
  const queryFn: QueryFn = params => {
    let model = String(params.options.model);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const user of params.prompt) {
          users.push({ text: String(user.message.content), model });
          yield { type: "result", subtype: "success" };
        }
      },
      interrupt: async () => {}, close: () => {},
      setPermissionMode: async mode => { calls.push(`mode:${mode}`); },
      setModel: async next => {
        calls.push(`model:${next}`);
        if (next === "slow" || next === "hung") await modelReply.promise;
        model = next!;
      },
    };
  };
  return { queryFn, modelReply, calls, users };
}

for (const separateReads of [false, true]) test(`model pick then immediate send uses the new model (${separateReads ? "separate reads" : "same read"})`, async t => {
  const sdk = orderedQuery();
  const f = await memoryHost(t, sdk.queryFn);
  await f.sessions.send(f.id, "warmup", "warmup");
  await nextTick();
  f.peer.receive({ t: "set_model", session: f.id, reqId: "pick", model: "slow", effort: null });
  if (separateReads) await nextTick();
  f.peer.receive({ t: "send", session: f.id, clientMsgId: "after-pick", text: "after pick" });
  await nextTick();
  assert.equal(sdk.users.length, 1);
  assert.equal(f.peer.frames.some(frame => frame.t === "ack"), false);
  sdk.modelReply.resolve();
  await f.peer.take("ack");
  assert.deepEqual(sdk.users.at(-1), { text: "after pick", model: "slow" });
});

test("send then pick dispatches with the old model before applying the pick", async t => {
  const sdk = orderedQuery();
  const f = await memoryHost(t, sdk.queryFn);
  await f.sessions.send(f.id, "warmup", "warmup");
  await nextTick();
  f.peer.receive({ t: "send", session: f.id, clientMsgId: "before-pick", text: "old model" });
  f.peer.receive({ t: "set_model", session: f.id, reqId: "pick", model: "next", effort: null });
  await f.peer.take("ack");
  await f.peer.take("res");
  assert.deepEqual(sdk.users.at(-1), { text: "old model", model: "test" });
  assert.deepEqual(sdk.calls, ["model:next"]);
  assert.equal(f.sessions.summaryOf(f.id)?.model, "next");
});

test("a hung pick releases the next pick and send at 15 seconds, and its late answer records nothing", async t => {
  const sdk = orderedQuery();
  const f = await memoryHost(t, sdk.queryFn);
  await f.sessions.send(f.id, "warmup", "warmup");
  await nextTick();
  const hung = f.sessions.setModel(f.id, "hung", null, "hung-pick");
  const next = f.sessions.setModel(f.id, "next", null, "next-pick");
  f.peer.receive({ t: "send", session: f.id, clientMsgId: "after-hung", text: "after hung" });
  await nextTick();
  t.mock.timers.tick(14_999);
  await nextTick();
  assert.deepEqual(sdk.calls, ["model:hung"]);
  t.mock.timers.tick(1);
  assert.deepEqual(await hung, { status: "unknown" });
  assert.deepEqual(await next, { status: "applied", model: "next", effort: null });
  await f.peer.take("ack");
  assert.deepEqual(sdk.users.at(-1), { text: "after hung", model: "next" });
  const before = f.sessions.log(f.id).lastSeq;
  sdk.modelReply.resolve();
  await nextTick(); await nextTick();
  assert.equal(f.sessions.log(f.id).lastSeq, before);
  assert.equal(f.sessions.summaryOf(f.id)?.model, "next");
  assert.deepEqual(await f.sessions.setModel(f.id, "hung", null, "hung-pick"), { status: "unknown" });
});

test("an expired mode waiting for SDK readiness makes no outgoing call when readiness arrives", async t => {
  const sdk = orderedQuery();
  const ready = Promise.withResolvers<Awaited<ReturnType<typeof router.status>>>();
  const f = await memoryHost(t, sdk.queryFn, () => ready.promise);
  await f.sessions.send(f.id, "warmup", "warmup");
  const first = f.sessions.setMode(f.id, "plan", "old-mode");
  const second = f.sessions.setMode(f.id, "default", "new-mode");
  await nextTick();
  t.mock.timers.tick(15_000);
  assert.deepEqual(await first, { status: "unknown" });
  await nextTick();
  ready.resolve(await router.status());
  assert.deepEqual(await second, { status: "applied", permissionMode: "default" });
  assert.deepEqual(sdk.calls, ["mode:default"]);
  assert.equal(f.sessions.summaryOf(f.id)?.permissionMode, "default");
  assert.equal(f.sessions.log(f.id).tail().events.some(e => e.kind === "mode" && e.mode === "plan"), false);
});

test("each queued pick gets 15 seconds from its own start, not from arrival", async t => {
  const sdk = orderedQuery();
  const f = await memoryHost(t, sdk.queryFn);
  await f.sessions.send(f.id, "warmup", "warmup");
  await nextTick();
  const first = f.sessions.setModel(f.id, "hung", null, "first");
  const second = f.sessions.setModel(f.id, "slow", null, "second");
  await nextTick();
  t.mock.timers.tick(15_000);
  assert.deepEqual(await first, { status: "unknown" });
  await nextTick();
  assert.deepEqual(sdk.calls, ["model:hung", "model:slow"]);
  t.mock.timers.tick(14_999);
  let done = false;
  void second.then(() => { done = true; });
  await nextTick();
  assert.equal(done, false);
  sdk.modelReply.resolve();
  assert.deepEqual(await second, { status: "applied", model: "slow", effort: null });
});

test("a message in the same read as a setting change still waits for it", async t => {
  const f = await memoryHost(t);
  let release!: () => void;
  (f.sessions as unknown as { changeMode: () => Promise<void> }).changeMode = () => new Promise<void>(resolve => { release = resolve; });
  f.peer.frames.length = 0;
  f.peer.receive({ t: "set_mode", reqId: "mode-1", sessionId: f.id, mode: "plan" });
  f.peer.receive({ t: "send", session: f.id, clientMsgId: "same-read", text: "hello", behavior: "steer" });
  await nextTick(); await nextTick();
  assert.equal(f.peer.frames.some(frame => frame.t === "ack"), false, "the message waits for the mode change before it");
  release();
  for (let i = 0; i < 5 && !f.peer.frames.some(frame => frame.t === "ack"); i++) await nextTick();
  assert.equal(f.peer.frames.some(frame => frame.t === "ack"), true);
});

for (const stopped of [false, true]) test(`a queued message waits for a setting change, then ${stopped ? "stays queued after a Stop" : "goes out"}`, async t => {
  const sdk = orderedQuery();
  const f = await memoryHost(t, sdk.queryFn);
  await f.sessions.send(f.id, "warmup", "warmup");
  await nextTick();
  const changing = f.sessions.setModel(f.id, "slow", null, "pick");
  f.peer.receive({ t: "req", reqId: "enqueue-1", op: { op: "enqueue", session: f.id, clientMsgId: "queued-1", text: "after the pick" } });
  await nextTick();
  assert.equal(sdk.users.length, 1, "the drain waits for the pick before it");
  if (stopped) f.sessions.holdQueue(f.id);
  sdk.modelReply.resolve();
  await changing;
  for (let i = 0; i < 10; i++) await nextTick();
  assert.equal(sdk.users.length, stopped ? 1 : 2);
  if (!stopped) assert.deepEqual(sdk.users.at(-1), { text: "after the pick", model: "slow" });
});

test("a setting change that arrives after a waiting message runs after it", async t => {
  const f = await memoryHost(t);
  const order: string[] = [];
  let release!: () => void;
  (f.sessions as unknown as { changeMode: (id: string, mode: string) => Promise<void> }).changeMode = (_id, mode) => {
    order.push(`mode:${mode}`);
    return mode === "plan" ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  };
  const send = f.sessions.send.bind(f.sessions);
  f.sessions.send = ((...args: Parameters<typeof send>) => { order.push("send"); return send(...args); }) as typeof send;
  f.peer.receive({ t: "set_mode", reqId: "mode-a", sessionId: f.id, mode: "plan" });
  f.peer.receive({ t: "send", session: f.id, clientMsgId: "between", text: "hello", behavior: "steer" });
  f.peer.receive({ t: "set_mode", reqId: "mode-b", sessionId: f.id, mode: "default" });
  for (let i = 0; i < 5; i++) await nextTick();
  assert.deepEqual(order, ["mode:plan"]);
  release();
  for (let i = 0; i < 20 && order.length < 3; i++) await nextTick();
  assert.deepEqual(order, ["mode:plan", "send", "mode:default"], "the message runs in plan mode, as picked when it was sent");
});

for (const action of ["hold", "remove", "replace"] as const) test(`send-now rechecks ${action} after waiting for settings`, async t => {
  const sdk = orderedQuery();
  const f = await memoryHost(t, sdk.queryFn);
  await f.sessions.send(f.id, "warmup", "warmup");
  await nextTick();
  // A pending pick keeps the drain on the first item, ahead of send-now's chosen item.
  const changing = f.sessions.setModel(f.id, "slow", null, "pick");
  f.sessions.enqueue(f.id, "first", "first");
  f.sessions.holdQueue(f.id);
  f.sessions.enqueue(f.id, "queued-now", "original");
  const sent = f.sessions.sendQueued(f.id, "queued-now");
  const refused = assert.rejects(sent, action === "hold" ? /대기열이 멈춰/ : /no longer queued/);
  if (action === "hold") f.sessions.holdQueue(f.id);
  else {
    f.sessions.removeQueued(f.id, "queued-now");
    if (action === "replace") {
      f.sessions.enqueue(f.id, "queued-now", "original");
      f.sessions.holdQueue(f.id);
    }
  }
  sdk.modelReply.resolve();
  await changing;
  await refused;
  assert.equal(sdk.users.some(user => user.text === "original"), false);
  f.sessions.holdQueue(f.id);
});

test("\"send now\" takes its place among setting changes as it arrives", async t => {
  const f = await memoryHost(t);
  const order: string[] = [];
  let release!: () => void;
  (f.sessions as unknown as { changeMode: (id: string, mode: string) => Promise<void> }).changeMode = (_id, mode) => {
    order.push(`mode:${mode}`);
    return mode === "plan" ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  };
  const deliver = (f.sessions as unknown as { deliver: (...args: unknown[]) => unknown }).deliver.bind(f.sessions);
  (f.sessions as unknown as { deliver: (...args: unknown[]) => unknown }).deliver = (...args) => { order.push("send"); return deliver(...args); };
  f.peer.receive({ t: "set_mode", reqId: "mode-a", sessionId: f.id, mode: "plan" });
  // Queued behind mode A (the drain waits for it), then sent now from another phone.
  f.peer.receive({ t: "req", reqId: "enqueue-1", op: { op: "enqueue", session: f.id, clientMsgId: "queued-now", text: "now" } });
  await nextTick();
  const sent = f.sessions.sendQueued(f.id, "queued-now");
  f.peer.receive({ t: "set_mode", reqId: "mode-b", sessionId: f.id, mode: "default" });
  for (let i = 0; i < 5; i++) await nextTick();
  release();
  await sent;
  for (let i = 0; i < 10 && order.length < 3; i++) await nextTick();
  assert.deepEqual(order, ["mode:plan", "send", "mode:default"]);
});

test("\"send now\" holds its place while the app considers it, with nothing before it", async t => {
  const f = await memoryHost(t);
  const order: string[] = [];
  const host = f.sessions as unknown as {
    changeMode: (id: string, mode: string) => Promise<void>;
    modEligible: () => boolean;
    offerMod: () => Promise<"expired">;
    deliver: (...args: unknown[]) => unknown;
  };
  host.changeMode = async (_id, mode) => { order.push(`mode:${mode}`); };
  let lapse!: () => void;
  host.modEligible = () => true;
  host.offerMod = () => new Promise(resolve => { lapse = () => resolve("expired"); });
  const deliver = host.deliver.bind(f.sessions);
  host.deliver = (...args) => { order.push("send"); return deliver(...args); };
  // Left in the queue while a turn ran (as the drain would, it skips one that is held).
  (f.sessions as unknown as { sendQueue: { add(session: string, item: { id: string; text: string; attachments: [] }, at: number): boolean } }).sendQueue.add(f.id, { id: "queued-now", text: "now", attachments: [] }, Date.now());
  f.sessions.holdQueue(f.id);
  const sent = f.sessions.sendQueued(f.id, "queued-now");
  f.peer.receive({ t: "set_mode", reqId: "mode-after", sessionId: f.id, mode: "plan" });
  for (let i = 0; i < 5; i++) await nextTick();
  assert.deepEqual(order, [], "the pick made after it waits while the app has the offer");
  lapse();
  await sent;
  for (let i = 0; i < 10 && order.length < 2; i++) await nextTick();
  assert.deepEqual(order, ["send", "mode:plan"]);
});

test("queuing an id still being sent answers with that send", async t => {
  const f = await memoryHost(t);
  const host = f.sessions as unknown as {
    receipts: { begin(key: string, session: string): void };
    sending: Map<string, Promise<string>>;
  };
  let fail!: (error: Error) => void;
  const send = new Promise<string>((_, reject) => { fail = reject; });
  host.receipts.begin(`send:${f.id}:in-flight`, f.id);
  host.sending.set(`send:${f.id}:in-flight`, send);
  const queued = f.sessions.enqueue(f.id, "in-flight", "hello");
  assert.ok(queued, "not an \"it is queued\" while nothing holds it");
  fail(new Error("upstream refused"));
  await assert.rejects(queued, /upstream refused/);
});

test("a message id already sent is not queued again", async t => {
  const f = await memoryHost(t);
  const receipts = (f.sessions as unknown as { receipts: { begin(key: string, session: string): void; complete(key: string, session?: string): void } }).receipts;
  receipts.begin(`send:${f.id}:taken`, f.id);
  receipts.complete(`send:${f.id}:taken`, f.id);
  // The app took it last time; it would take this one too, with no receipt check on its way.
  const offered: string[] = [];
  const host = f.sessions as unknown as { modEligible: () => boolean; offerMod: (id: string, desktopId: string, item: { id: string }) => null };
  host.modEligible = () => true;
  host.offerMod = (_id, _desktopId, item) => { offered.push(item.id); return null; };
  f.sessions.enqueue(f.id, "taken", "hello");
  await nextTick();
  assert.deepEqual(offered, [], "the app would run it a second time");
  assert.equal(f.sessions.summaryOf(f.id)?.queue, undefined);
});

test("an attach already up to date is answered, so a saved copy can tell it is current", async t => {
  const f = await memoryHost(t);
  const log = f.sessions.log(f.id);
  log.append({ kind: "user", text: "one", clientMsgId: "one" });
  f.peer.frames.length = 0;
  f.peer.receive({ t: "attach", session: f.id, epoch: log.epoch, afterSeq: log.lastSeq });
  const frame = await f.peer.take("events");
  assert.deepEqual(frame.events, []);
  assert.equal(frame.epoch, log.epoch);
});

test("session lists wait for a backed-up connection to drain and only the newest goes out", async t => {
  const f = await memoryHost(t);
  f.peer.frames.length = 0;
  f.peer.bufferedAmount = 2 * 1024 * 1024;
  for (let i = 0; i < 8; i++) {
    f.server.onSessions();
    t.mock.timers.tick(150);
  }
  t.mock.timers.tick(1000);
  assert.equal(f.peer.frames.filter(frame => frame.t === "sessions").length, 0);
  f.peer.bufferedAmount = 0;
  t.mock.timers.tick(200);
  assert.equal(f.peer.frames.filter(frame => frame.t === "sessions").length, 1);
});

test("desktop snapshot updates wait for drain and send only the newest tail", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-tail-pressure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const file = path.join(project, `${id}.jsonl`);
  const line = (i: number) => JSON.stringify({ type: "user", uuid: `p-${i}`, cwd: root, message: { content: `update-${i}` } }) + "\n";
  fs.writeFileSync(file, line(0));
  const f = await fixture(t, {}, root);
  const peer = new MemoryPeer();
  f.server.connected(peer);
  peer.receive({ t: "hello", token, clientId: "slow-desktop-reader" });
  await peer.take("ready");
  peer.receive({ t: "attach", session: id });
  await peer.take("events");
  peer.bufferedAmount = 2 * 1024 * 1024;
  for (let i = 1; i <= 10; i++) {
    fs.appendFileSync(file, line(i));
    f.server.onEvent(id);
  }
  assert.equal(peer.frames.filter(frame => frame.t === "events").length, 0);
  peer.bufferedAmount = 0;
  await waitFor(() => peer.frames.some(frame => frame.t === "events"));
  const tail = await peer.take("events");
  assert.ok(tail.tail);
  assert.ok(tail.events.some(event => event.kind === "user" && event.text === "update-10"));
  assert.equal(peer.frames.filter(frame => frame.t === "events").length, 0);
});

test("history pages a >=2 MiB log back to seq 1 with bounded frames and every visible seq exactly once", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  const expected = seedLargeLog(f.sessions, id);
  const peer = await f.auth();
  peer.send({ t: "attach", session: id });
  const tail = await peer.take("events");
  assert.ok(tail.bytes <= FRAME_CAP);
  assert.ok(tail.msg.tail?.hasOlder);
  let events = tail.msg.events;
  let hasOlder: boolean = tail.msg.tail.hasOlder;
  let seen = events.slice();
  let pages = 0;
  while (hasOlder) {
    assert.ok(++pages < 100, "History cursor must advance");
    assert.ok(events.length > 0);
    const beforeSeq = events[0]!.seq;
    const reqId = `history-${pages}`;
    peer.send({ t: "history", session: id, beforeSeq, reqId });
    const frame = await peer.take("history", msg => msg.reqId === reqId);
    assert.ok(frame.bytes <= FRAME_CAP, `History frame has ${frame.bytes} bytes`);
    assert.equal(frame.msg.session, id);
    assert.ok(frame.msg.events.every(event => event.seq < beforeSeq));
    events = frame.msg.events;
    seen = [...events, ...seen];
    hasOlder = frame.msg.hasOlder;
  }
  assert.ok(pages > 4);
  assert.equal(seen[0]?.seq, 1);
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen.map(event => event.seq)).size, seen.length);
  assert.ok(peer.received.every(frame => frame.bytes <= FRAME_CAP));
  assert.deepEqual(f.diagnostics, []);
});

test("large catch-up from afterSeq=1 sends a tail rather than replaying a >=2 MiB log", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  seedLargeLog(f.sessions, id);
  const log = f.sessions.log(id);
  const peer = await f.auth();
  peer.send({ t: "attach", session: id, epoch: log.epoch, afterSeq: 1 });
  await peer.barrier();
  const frames = peer.eventFrames();
  assert.equal(frames.length, 1);
  const frame = frames[0]!;
  assert.ok(frame.bytes <= FRAME_CAP);
  assert.deepEqual(frame.msg.tail, { hasOlder: true });
  assert.equal(frame.msg.more, false);
  assert.deepEqual(frame.msg.events, log.tail().events);
  assert.ok(frame.msg.events[0]!.seq > 2);
});

test("sequential socket create retries ack the same session and start one query", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const peer = await f.auth();
  const request: ClientMsg = { t: "create", clientMsgId: "socket-create", cwd: f.cwd, model: "claude-test", effort: "high", text: "ping" };
  peer.send(request);
  const first = (await peer.take("ack")).msg;
  peer.send(request);
  const second = (await peer.take("ack")).msg;
  assert.equal(first.clientMsgId, "socket-create");
  assert.deepEqual(second, first);
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  assert.equal(f.sessions.list().length, 1);
  assert.equal(f.fake.options.length, 1);
});

test("concurrent socket create retries ack the same session and start one query", {
  timeout: TEST_TIMEOUT,
}, async t => {
  const f = await fixture(t);
  const peer = await f.auth();
  const request: ClientMsg = { t: "create", clientMsgId: "socket-create", cwd: f.cwd, model: "claude-test", effort: "high", text: "ping" };
  peer.send(request);
  peer.send(request);
  const first = (await peer.take("ack")).msg;
  const second = (await peer.take("ack")).msg;
  assert.deepEqual(second, first);
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  assert.equal(f.sessions.list().length, 1);
  assert.equal(f.fake.options.length, 1);
});

test("a send resend of a completed id acks without re-running; an orphaned one answers outcome_unknown", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  const peer = await f.auth();
  peer.send({ t: "send", session: id, clientMsgId: "socket-send", text: "again" });
  const first = (await peer.take("ack")).msg;
  assert.equal(first.clientMsgId, "socket-send");
  await waitFor(() => f.fake.users.length === 2);
  peer.send({ t: "send", session: id, clientMsgId: "socket-send", text: "again" });
  assert.deepEqual((await peer.take("ack")).msg, first);
  assert.equal(f.fake.users.length, 2, "completed resend acks without running again");
});

test("a send orphaned by a host restart answers outcome_unknown over the socket without running", { timeout: TEST_TIMEOUT }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-restart-wire-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const permissionsFile = path.join(dir, "permissions.json");
  const fake = scriptedQuery();
  const peers: Peer[] = [];
  let sessions = new Sessions({ dir, router, permissions: PermissionQueue.open(permissionsFile), queryFn: fake.queryFn, coalesceMs: 5, onEvent: () => {}, onSessions: () => {} });
  let server: HostServer | undefined;
  t.after(async () => {
    for (const peer of peers) peer.ws.terminate();
    await server?.close();
    for (const session of sessions.list()) sessions.stop(session.id);
    await nextTick();
    sessions.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const id = await sessions.create({ clientMsgId: "restart-1", cwd, model: "claude-test", effort: "high", text: "ping" });
  await waitFor(() => sessions.list()[0]?.state === "idle");
  // The first attempt wrote pending, then the host died before completing it.
  MessageReceipts.open(path.join(dir, "receipts.json")).begin(`send:${id}:lost-1`, id);
  sessions.shutdown();
  sessions = new Sessions({ dir, router, permissions: PermissionQueue.open(permissionsFile), queryFn: fake.queryFn, coalesceMs: 5, onEvent: () => {}, onSessions: () => {} });
  server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions, router, hostName: "test-host", version: "test-version", recentCli: async () => [], log: () => {} });
  await server.listen();
  const peer = new Peer(`ws://127.0.0.1:${server.address().port}/ws`);
  peers.push(peer);
  await peer.open();
  peer.send({ t: "hello", token, clientId: "restart-client" });
  await peer.take("ready");
  peer.send({ t: "send", session: id, clientMsgId: "lost-1", text: "lost turn" });
  const unknown = await peer.take("error", m => m.clientMsgId === "lost-1");
  assert.equal(unknown.msg.code, "outcome_unknown");
  assert.equal(unknown.msg.message, "전송 결과를 확인할 수 없음");
  assert.equal(fake.users.length, 1, "the orphaned turn never reached the SDK again");
  peer.send({ t: "send", session: id, clientMsgId: "fresh-1", text: "new turn" });
  await peer.take("ack", m => m.clientMsgId === "fresh-1");
  await waitFor(() => fake.users.length === 2);
});

// B16: a message the host will not take must name itself, or the phone cannot keep it for a retry.
// `no_session` itself is only ever answered to `attach` (no message involved); a send to a session
// that is gone comes back as `send`, which carries the clientMsgId.
test("a send to a session that no longer exists names the message so the phone can keep it", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const peer = await f.auth();
  peer.send({ t: "send", session: "gone-session", clientMsgId: "keep-me", text: "이 지시는 사라지면 안 됩니다" });
  const error = await peer.take("error", m => m.clientMsgId === "keep-me");
  assert.deepEqual(error.msg, { t: "error", code: "send", message: "no such session", clientMsgId: "keep-me", session: "gone-session" });
  assert.equal(f.fake.users.length, 0, "nothing ran, so only the person's retry (same id) should send it");
});

test("answering the same approval twice resolves once; the second answer gets 이미 처리됨", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  await f.create();
  const peer = await f.auth();
  peer.send({ t: "decide", session: "missing", id: "unknown", decision: "allow", reqId: "twice-1" });
  assert.deepEqual((await peer.take("res", m => m.reqId === "twice-1")).msg, { t: "res", reqId: "twice-1", ok: false, error: "이미 처리됨" });
  peer.send({ t: "decide", session: "missing", id: "unknown", decision: "allow" });
  const error = await peer.take("error");
  assert.equal(error.msg.code, "permission");
  assert.equal(error.msg.message, "이미 처리됨");
});

test("a looked-at session suppresses push for 180 s; other sessions are unaffected", { timeout: TEST_TIMEOUT }, async t => {
  let now = 1_000_000;
  const f = await fixture(t, { now: () => now });
  const id = await f.create();
  const peer = await f.auth();
  assert.equal(f.server.sessionSeenRecently(id), false);
  peer.send({ t: "presence", visible: true });
  peer.send({ t: "attach", session: id });
  await peer.take("events");
  await peer.barrier();
  assert.equal(f.server.sessionSeenRecently(id), true);
  now += 179_000;
  assert.equal(f.server.sessionSeenRecently(id), true);
  now += 2_000;
  assert.equal(f.server.sessionSeenRecently(id), false, "180 s with no look: push goes out");
  peer.send({ t: "presence", visible: true });
  await peer.barrier();
  assert.equal(f.server.sessionSeenRecently(id), true, "visible presence while attached refreshes the look");
  assert.equal(f.server.sessionSeenRecently("other-session"), false);
});

test("a client silent after hello is terminated after STALE_MS using virtual Date and intervals", { timeout: TEST_TIMEOUT }, async t => {  // Node's public timer mocks cover both Date.now() and the host's periodic reaper;
  // network I/O and the test's promise-based deadlines still use real time.
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
  const f = await fixture(t);
  const peer = await f.auth();
  t.mock.timers.tick(STALE_MS - 1);
  await nextTick();
  assert.equal(peer.ws.readyState, WebSocket.OPEN);
  t.mock.timers.tick(PING_MS + 2);
  const closed = await peer.closed;
  assert.equal(closed.code, 1006);
  assert.equal(peer.ws.readyState, WebSocket.CLOSED);
});

test("blob req chunks round-trip full Unicode output with next offsets until null", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  const text = "界😀\n".repeat(45_000);
  const event = f.sessions.log(id).append({ kind: "tool_result", toolUseId: "large-output", ok: true, text });
  assert.ok(event.kind === "tool_result" && typeof event.text !== "string");
  const peer = await f.auth();
  let offset: number | null = 0;
  let combined = "";
  let chunks = 0;
  while (offset !== null) {
    assert.ok(++chunks < 20, "Blob cursor must advance");
    const reqId = `blob-${chunks}`;
    peer.send({ t: "req", reqId, op: { op: "blob", session: id, id: event.text.blob, offset } });
    const frame = await peer.take("res", msg => msg.reqId === reqId);
    assert.ok(frame.bytes <= FRAME_CAP);
    assert.equal(frame.msg.ok, true);
    const chunk = frame.msg.data as BlobChunk;
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.bytes, Buffer.byteLength(text));
    assert.ok(chunk.text.length > 0);
    combined += chunk.text;
    if (chunk.next !== null) assert.equal(chunk.next, offset + chunk.text.length);
    offset = chunk.next;
  }
  assert.ok(chunks > 1);
  assert.equal(combined, text);
});

test("large image blobs round-trip in capped frames without inlining bytes in events", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const bytes = Buffer.alloc(700_000, 173);
  const data = bytes.toString("base64");
  const blob = f.sessions.log(id).image(data);
  const event = f.sessions.log(id).append({ kind: "user", text: "", clientMsgId: "image-user", images: [{ type: "image", blob, mediaType: "image/png" }] });
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 1024);
  const peer = await f.auth();
  let offset: number | null = 0, combined = "", chunks = 0;
  while (offset !== null) {
    const reqId = `image-${++chunks}`;
    peer.send({ t: "req", reqId, op: { op: "blob", session: id, id: blob, offset } });
    const frame = await peer.take("res", msg => msg.reqId === reqId);
    assert.ok(frame.bytes <= FRAME_CAP);
    assert.ok(frame.msg.ok);
    const chunk = frame.msg.data as BlobChunk;
    assert.equal(chunk.offset, offset);
    combined += chunk.text; offset = chunk.next;
  }
  assert.ok(chunks > 10);
  assert.deepEqual(Buffer.from(combined, "base64"), bytes);
});

test("browse req lists drives, then only visible subdirectories in sorted order", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const dir = path.join(f.dir, "browse");
  fs.mkdirSync(dir);
  for (const name of ["zeta", "folder10", "Alpha", "folder2", ".hidden"]) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, "not-a-directory.txt"), "file");
  const peer = await f.auth();
  peer.send({ t: "req", reqId: "browse", op: { op: "browse", path: dir } });
  const response = (await peer.take("res", msg => msg.reqId === "browse")).msg;
  assert.equal(response.ok, true);
  const result = response.data as BrowseResult;
  assert.equal(result.path, dir);
  assert.equal(result.parent, f.dir);
  assert.equal(result.truncated, false);
  const drives = (await windowsDrives()).filter(root => root.toLowerCase() !== dir.toLowerCase()).map(root => ({ name: root, path: root }));
  const folders = ["Alpha", "folder2", "folder10", "zeta"].map(name => ({ name, path: path.join(dir, name) }));
  assert.deepEqual(result.entries, [...drives, ...folders]);
});

test("host info carries the mod's status, refreshes limits once a minute, and reaches connected phones when it changes", { timeout: 6000 }, async t => {
  let clock = 1_792_380_000_000;
  const calls = { limits: 0, settings: 0 };
  let activeMode = "m1", failLimits = false, routerOk = true;
  const limits = () => ({ providers: [{ provider: "anthropic", type: "anthropic", title: "Claude", accounts: [{ account: 0, windows: [{ kind: "five_hour", used_percent: 38, window_minutes: 300, reset_at: Math.round((clock + 600_000) / 1000) }] }] }] });
  const modRouter = {
    ...router,
    status: async () => ({ ok: routerOk, ...(routerOk ? {} : { problem: "down" }), proxyEnv: {} }),
    limits: async () => { calls.limits++; if (failLimits) throw new Error("limits down"); return limits(); },
    modSettings: async () => { calls.settings++; return { settings: { activeMode, effortAuto: true, floor: "low", ceiling: "max", modes: [{ id: "m1", name: "Saver" }, { id: "m2", name: "Maxing" }] } }; },
  };
  const f = await fixture(t, { router: modRouter, now: () => clock });
  const check = () => (f.server as unknown as { checkRouter(): Promise<void> }).checkRouter();
  await check();
  const peer = await f.auth();
  const ready = peer.received.find(frame => frame.msg.t === "ready")!.msg as Extract<HostMsg, { t: "ready" }>;
  assert.equal(ready.host.ripple?.mode?.name, "Saver", "ready carries the status");
  assert.deepEqual(ready.host.ripple?.limits.map(l => [l.provider, l.usedPct]), [["anthropic", 38]]);

  const limitsBefore = calls.limits;
  clock += 20_000; await check(); await peer.barrier();
  assert.equal(calls.limits, limitsBefore, "limits are not read again inside a minute");
  assert.equal(peer.frames.filter(frame => frame.msg.t === "host").length, 0, "nothing changed, so nothing is sent (the `at` moving is not a change)");

  activeMode = "m2";
  clock += 20_000; await check();
  const changed = (await peer.take("host")).msg;
  assert.equal(changed.host.ripple?.mode?.name, "Maxing", "a changed mode reaches a connected phone without reconnecting");

  clock += 61_000; failLimits = true; await check();
  assert.equal(calls.limits, limitsBefore + 1, "a minute on, limits are read again");
  assert.equal(peer.frames.filter(frame => frame.msg.t === "host").length, 0, "a failed read keeps the last good limits, so nothing changes");
  await peer.barrier();
  clock += 600_000; await check();
  const expired = (await peer.take("host")).msg;
  assert.deepEqual(expired.host.ripple?.limits, [], "the kept window's reset has passed by now and it is dropped");

  routerOk = false; await check();
  const down = (await peer.take("host")).msg;
  assert.equal(down.host.routerOk, false);
  assert.equal("ripple" in down.host, false, "with the router down there is no status to show");
});

test("the context window the SDK reports for a model is kept for Mac sessions on that model", { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  await f.create();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, "context-windows.json"), "utf8")), { x: 1000 });
});
