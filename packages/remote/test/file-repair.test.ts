import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopSessions } from "../src/desktop.ts";
import { EventLog } from "../src/eventlog.ts";
import { FILE_RULES, repairRefusedFiles, type Reconvert } from "../src/file-repair.ts";
import { summarize } from "../src/sessions.ts";
import type { SessionEvent, SessionFile } from "../src/protocol.ts";
import { reduce, timelineItems } from "../web/timeline.ts";
import { bridgeFixture, bridgeId, line } from "./bridge-fixture.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const inline = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const SID = "2b2b2c2d-2222-4333-8444-955566667777", OTHER = "2b2b2c2d-2222-4333-8444-000000000000";
const blocked = (name: string): SessionFile => ({ id: `id-${name}`, name, mediaType: "application/octet-stream", bytes: 0, status: "blocked" });

// A log written before the spare-folder fix: the SendUserFile screenshot and an image a tool result
// referenced were refused. The transcript still names both, and the files are on disk. `fill` events
// follow them in the log (a long conversation after the pictures were sent).
function fixture(t: TestContext, fill = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-repair-"));
  const base = path.join(fs.existsSync("/private/tmp") ? "/private/tmp" : "/tmp", `claude-${process.getuid!()}`);
  if (!fs.existsSync(base)) { fs.mkdirSync(base, { mode: 0o700 }); t.after(() => fs.rmSync(base, { recursive: true, force: true })); }
  const spare = path.join(base, `-ripple-repair-spare-${process.pid}-${fill}`);
  const cwd = path.join(root, "project");
  const projects = path.join(root, "projects");
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(spare, { recursive: true, force: true }); });
  const ok = path.join(spare, SID, "scratchpad", "01-side.png");
  const shot = path.join(spare, SID, "scratchpad", "02-shot.png");
  const foreign = path.join(spare, OTHER, "scratchpad", "x.png");
  const gone = path.join(spare, SID, "scratchpad", "gone.png");
  for (const file of [ok, shot, foreign]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, png); }
  fs.mkdirSync(cwd, { recursive: true });
  const send = { type: "assistant", uuid: "line-send", sessionId: SID, cwd, message: { id: "m1", content: [{ type: "text", text: "비교입니다." }, { type: "tool_use", id: "toolu_send", name: "SendUserFile", input: { files: [ok, foreign, gone], caption: "왼쪽이 원본" } }] } };
  // The read result also carries an inline picture: it is not a file anyone refused, and its bytes must not be stored again.
  const read = { type: "user", uuid: "line-read", sessionId: SID, cwd, message: { content: [{ type: "tool_result", tool_use_id: "toolu_read", content: [{ type: "text", text: `[Image: source: ${shot}]` }, { type: "image", source: { type: "base64", media_type: "image/png", data: inline.toString("base64") } }] }] } };
  const other = { type: "assistant", uuid: "line-other", sessionId: SID, cwd, message: { id: "m2", content: [{ type: "text", text: "끝." }] } };
  fs.mkdirSync(path.join(projects, "p"), { recursive: true });
  fs.writeFileSync(path.join(projects, "p", `${SID}.jsonl`), [send, read, other].map(l => JSON.stringify(l)).join("\n") + "\n");
  const desktop = new DesktopSessions({ projects, summarize, excluded: () => new Set(), processes: () => "", registry: () => new Map() });
  t.after(() => desktop.close());
  const dir = path.join(root, "log");
  const log = EventLog.open({ dir, now: () => 1000 });
  t.after(() => log.close());
  // The events as the old host persisted them: names only, every file refused, no message-level images.
  log.append({ kind: "user", text: "보내 줘", clientMsgId: "c1" });
  log.append({ kind: "assistant", msg: "line-send", model: "m", text: "비교입니다.", images: [], files: [], tools: [
    { id: "toolu_send", name: "SendUserFile", summary: "01-side.png", files: [blocked("01-side.png"), blocked("x.png"), blocked("gone.png")], input: JSON.stringify({ files: ["01-side.png", "x.png", "gone.png"], caption: "왼쪽이 원본" }) },
    { id: "toolu_read", name: "Read", summary: "02-shot.png" }], src: "line-send", srcHash: 1 });
  log.append({ kind: "tool_result", toolUseId: "toolu_read", ok: true, text: "", images: [], files: [blocked("02-shot.png")], src: "line-read", srcHash: 2 });
  log.append({ kind: "assistant", msg: "line-other", model: "m", text: "끝.", images: [], files: [], tools: [], src: "line-other", srcHash: 3 });
  // Each one 4 KB: the pictures end up beyond what the host's tail page holds and beyond 120 events.
  for (let i = 0; i < fill; i++) log.append({ kind: "user", text: `${i} ${"가".repeat(1300)}`, clientMsgId: `fill-${i}` });
  const reconvert: Reconvert = (want, epoch, onLine) => desktop.reconvertFiles(SID, want, cwd, epoch, onLine);
  return { log, dir, reconvert, ok, desktop, shot };
}
const events = (log: EventLog): SessionEvent[] => log.readAfter(0).events;
function sentTool(list: SessionEvent[]) {
  const item = reduce(list).items.find(i => i.type === "assistant" && i.tools.some(tool => tool.id === "toolu_send"));
  assert.ok(item?.type === "assistant");
  return item;
}
const statuses = (event: SessionEvent | undefined) => event?.kind === "assistant" ? event.tools[0]?.files?.map(f => f.status) : undefined;

test("inside the window a restatement is appended too, and the released timeline shows the picture in place", { skip: process.platform === "win32" }, async t => {
  const { log, dir, reconvert } = fixture(t);
  const file = path.join(dir, "events-000001.jsonl");
  const before = fs.readFileSync(file);
  const lastBefore = log.lastSeq;
  const cardBefore = sentTool(events(log));
  assert.equal(cardBefore.images?.length, 0);
  assert.deepEqual(cardBefore.tools[0]?.files?.map(f => f.status), ["blocked", "blocked", "blocked"]);

  const done = await repairRefusedFiles(log, dir, reconvert);
  assert.equal(done?.appended.length, 2);
  assert.equal(done?.substituted, 2);

  // Appended only: the old bytes are untouched, the new events take the next seqs, at the original time.
  assert.ok(fs.readFileSync(file).subarray(0, before.length).equals(before));
  const added = events(log).slice(lastBefore);
  assert.deepEqual(added.map(e => [e.seq, e.kind]), [[lastBefore + 1, "assistant"], [lastBefore + 2, "tool_result"]]);
  assert.deepEqual(added.map(e => e.at), [1000, 1000]);

  // A fresh tail carries the fixed original at its own seq, and the restatement after it.
  const tail = log.tail().events;
  assert.deepEqual(statuses(tail.find(e => e.seq === 2)), ["ready", "blocked", "blocked"]);
  assert.equal(tail.length, events(log).length);
  assert.deepEqual(statuses(log.readAfter(1).events[0]), ["ready", "blocked", "blocked"]);
  // The same reducer the app shares replaces the message by its `msg` and keeps its place.
  const view = reduce(events(log));
  const keys = view.items.map(i => i.key);
  assert.equal(new Set(keys).size, keys.length);
  const item = sentTool(events(log));
  assert.deepEqual(item.tools[0]?.files?.map(f => [f.name, f.status]), [["01-side.png", "ready"], ["x.png", "blocked"], ["gone.png", "blocked"]]);
  assert.equal(item.images?.length, 1);
  assert.equal(log.blob(item.images![0]!.blob!), png.toString("base64"));
  // The refused ones stay refused (still one card each, the delivered one no longer a card).
  assert.deepEqual(item.files?.map(f => f.name), []);
  assert.equal(view.items.findIndex(i => i.key === item.key), view.items.findIndex(i => i.type === "assistant"));
  // The tool result's referenced picture is delivered too.
  const read = view.items.flatMap(i => i.type === "assistant" ? i.tools : []).find(tool => tool.id === "toolu_read");
  assert.equal(read?.result?.images?.length, 1);
  assert.deepEqual(read?.result?.files?.map(f => f.status), ["ready"]);
  assert.ok(timelineItems(view).length > 0);
});

test("outside the window nothing is appended, and the tail, an older page and a catch-up all serve the fixed event at its own seq", { skip: process.platform === "win32" }, async t => {
  const { log, dir, reconvert } = fixture(t, 150);
  const last = log.lastSeq;
  const unfixedTail = reduce(log.tail().events).items.length;
  assert.equal(log.tail().events.some(e => e.seq === 2), false, "the pictures are beyond the tail");
  assert.deepEqual(statuses(log.readAfter(1).events[0]), ["blocked", "blocked", "blocked"]);

  const done = await repairRefusedFiles(log, dir, reconvert);
  assert.equal(done?.appended.length, 0);
  assert.equal(done?.substituted, 2);
  assert.equal(log.lastSeq, last, "no event is added at the end");

  const fixed = (list: SessionEvent[]) => {
    const send = list.find(e => e.seq === 2);
    assert.ok(send?.kind === "assistant");
    assert.equal(send.msg, "line-send");
    assert.deepEqual(statuses(send), ["ready", "blocked", "blocked"]);
    assert.equal(send.images?.length, 1);
    assert.equal(send.at, 1000);
    const result = list.find(e => e.seq === 3);
    assert.ok(result?.kind === "tool_result");
    assert.equal(result.images?.length, 1);
    assert.deepEqual(result.files?.map(f => f.status), ["ready"]);
  };
  // A fresh tail has none of them, so nothing new can appear at its end.
  const tail = log.tail();
  assert.equal(tail.events.at(-1)?.seq, last);
  assert.equal(reduce(tail.events).items.length, unfixedTail);
  // An older page that covers them.
  const page = log.before(40);
  fixed(page.events);
  // The released reducer puts the picture where the message was said, with nothing added at the end.
  const view = reduce(page.events);
  assert.equal(sentTool(page.events).images?.length, 1);
  assert.equal(view.items.findIndex(i => i.type === "assistant"), view.items.findIndex(i => i.key === sentTool(page.events).key));
  assert.equal(view.items.length, reduce(log.before(40).events).items.length);
  // A catch-up from before them.
  fixed(log.readAfter(1).events);
  // The blocked original is still what the log file says.
  const stored = fs.readFileSync(path.join(dir, "events-000001.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as SessionEvent);
  assert.deepEqual(statuses(stored[1]), ["blocked", "blocked", "blocked"]);
});

test("a served event is counted at its own size, and the tail starts where the substitutes put it", { skip: process.platform === "win32" }, async t => {
  const { log, dir, reconvert } = fixture(t, 3);
  const before = log.tailStart(1200);
  await repairRefusedFiles(log, dir, reconvert);
  assert.ok(log.tailStart(1200) >= before);
  const page = log.before(log.lastSeq + 1, 1200);
  assert.ok(page.events.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e)) + 1, 0) <= 1200 + Buffer.byteLength(JSON.stringify(page.events[0])), "within the budget, but for the first event");
  assert.equal(page.events[0]?.seq, log.tailStart(1200));
});

test("a repaired log is not repaired again, not even after a reopen, and the substitutes survive it", { skip: process.platform === "win32" }, async t => {
  const { log, dir, reconvert } = fixture(t, 150);
  assert.equal((await repairRefusedFiles(log, dir, reconvert))?.substituted, 2);
  const last = log.lastSeq;
  assert.equal((await repairRefusedFiles(log, dir, reconvert))?.substituted, 0);
  log.close();
  const reopened = EventLog.open({ dir, now: () => 1000 });
  t.after(() => reopened.close());
  assert.deepEqual(statuses(reopened.readAfter(1).events[0]), ["ready", "blocked", "blocked"], "served fixed after a restart");
  assert.equal((await repairRefusedFiles(reopened, dir, reconvert))?.appended.length, 0);
  assert.equal(reopened.lastSeq, last);
  // Without the kept verdicts the substituted events are not asked again.
  fs.rmSync(path.join(dir, "file-repair.json"));
  assert.equal(reopened.refusedEvents().length, 0);
  assert.equal((await repairRefusedFiles(reopened, dir, reconvert))?.substituted, 0);
  assert.equal(reopened.lastSeq, last);
  // Verdicts made under other rules are asked again; nothing new is gained, so nothing changes.
  fs.writeFileSync(path.join(dir, "file-repair.json"), JSON.stringify({ rules: FILE_RULES - 1, seen: {} }));
  assert.equal((await repairRefusedFiles(reopened, dir, reconvert))?.substituted, 0);
});

test("an appended restatement is not repaired again after a reopen", { skip: process.platform === "win32" }, async t => {
  const { log, dir, reconvert } = fixture(t);
  assert.equal((await repairRefusedFiles(log, dir, reconvert))?.appended.length, 2);
  const last = log.lastSeq;
  log.close();
  const reopened = EventLog.open({ dir, now: () => 1000 });
  t.after(() => reopened.close());
  // The restated message still lists two refused files: it is the newest of its key, and the only candidate.
  fs.rmSync(path.join(dir, "file-repair.json"));
  assert.equal(reopened.refusedEvents().length, 1);
  assert.equal((await repairRefusedFiles(reopened, dir, reconvert))?.appended.length, 0);
  assert.equal(reopened.lastSeq, last);
});

test("a torn last line of the sidecar is dropped and the rest still serves", { skip: process.platform === "win32" }, async t => {
  const { log, dir, reconvert } = fixture(t, 150);
  await repairRefusedFiles(log, dir, reconvert);
  log.close();
  fs.appendFileSync(path.join(dir, "substitutes.jsonl"), '{"kind":"assistant","seq":2,"ms');
  const reopened = EventLog.open({ dir, now: () => 1000 });
  t.after(() => reopened.close());
  assert.deepEqual(statuses(reopened.readAfter(1).events[0]), ["ready", "blocked", "blocked"]);
  assert.ok(fs.readFileSync(path.join(dir, "substitutes.jsonl"), "utf8").endsWith("\n"));
  // A substitute that no longer matches the event at its seq (leftover of another log) is ignored.
  reopened.close();
  const lines = fs.readFileSync(path.join(dir, "substitutes.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as SessionEvent);
  fs.writeFileSync(path.join(dir, "substitutes.jsonl"), JSON.stringify({ ...lines[0], msg: "someone-else" }) + "\n");
  const again = EventLog.open({ dir, now: () => 1000 });
  t.after(() => again.close());
  assert.deepEqual(statuses(again.readAfter(1).events[0]), ["blocked", "blocked", "blocked"]);
});

test("only the bytes of a file that is delivered now are stored, not an inline picture of the same line", { skip: process.platform === "win32" }, async t => {
  const { log, dir, reconvert } = fixture(t);
  await repairRefusedFiles(log, dir, reconvert);
  const blobs = fs.readdirSync(path.join(dir, "blobs"));
  const fileBlob = log.imageId(png.toString("base64"));
  assert.deepEqual(blobs, [`${fileBlob}.txt`]);
  assert.equal(fs.existsSync(path.join(dir, "blobs", `${log.imageId(inline.toString("base64"))}.txt`)), false);
});

test("the repair reads in the background: nothing is read or changed until the transcript is, and a turn that starts in the meantime holds the writes back", { skip: process.platform === "win32" }, async t => {
  const { log, dir, reconvert } = fixture(t, 150);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let idle = true;
  const slow: Reconvert = async (want, epoch, onLine) => { await gate; return reconvert(want, epoch, onLine); };
  const last = log.lastSeq;
  const pending = repairRefusedFiles(log, dir, slow, () => idle);
  // The call came back with a promise; the log is as it was.
  assert.ok(pending instanceof Promise);
  assert.equal(log.lastSeq, last);
  assert.deepEqual(statuses(log.readAfter(1).events[0]), ["blocked", "blocked", "blocked"]);
  assert.equal(fs.existsSync(path.join(dir, "substitutes.jsonl")), false);
  idle = false;
  release();
  assert.equal(await pending, null, "a turn is running: nothing is written");
  assert.deepEqual(statuses(log.readAfter(1).events[0]), ["blocked", "blocked", "blocked"]);
  assert.equal(fs.existsSync(path.join(dir, "file-repair.json")), false);
  // Later, idle again: it goes through.
  idle = true;
  assert.equal((await repairRefusedFiles(log, dir, reconvert, () => idle))?.substituted, 2);
});

test("the background scan lets the event loop run between chunks of a large transcript", { skip: process.platform === "win32" }, async t => {
  const { log, dir, reconvert } = fixture(t, 150);
  const transcript = path.join(path.dirname(dir), "projects", "p", `${SID}.jsonl`);
  // 40 MB of lines that are not wanted, ahead of the wanted ones.
  const junk = JSON.stringify({ type: "assistant", uuid: "x", message: { content: [{ type: "text", text: "y".repeat(500_000) }] } }) + "\n";
  fs.writeFileSync(transcript, junk.repeat(80) + fs.readFileSync(transcript, "utf8"));
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const done = await repairRefusedFiles(log, dir, reconvert);
  clearInterval(timer);
  assert.equal(done?.substituted, 2);
  assert.ok(ticks > 3, `the loop ran ${ticks} times while the transcript was read`);
});

test("nothing is written when the transcript is gone or the file no longer exists", { skip: process.platform === "win32" }, async t => {
  const { log, dir, ok, shot, reconvert } = fixture(t);
  assert.equal((await repairRefusedFiles(log, dir, async () => false))?.substituted, 0);
  assert.equal(fs.existsSync(path.join(dir, "file-repair.json")), false);
  // A file the session named that is gone from the disk is not delivered, so the call stays as it was.
  fs.rmSync(ok);
  fs.rmSync(shot);
  assert.equal((await repairRefusedFiles(log, dir, reconvert))?.substituted, 0);
  assert.equal(sentTool(events(log)).images?.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "substitutes.jsonl")), false);
});

test("an event without a transcript line id is found again by its call's id", { skip: process.platform === "win32" }, async t => {
  const { log, dir, reconvert } = fixture(t);
  const other = EventLog.open({ dir: path.join(path.dirname(dir), "log2"), now: () => 5 });
  t.after(() => other.close());
  const old = events(log).find(e => e.kind === "assistant" && e.msg === "line-send");
  assert.ok(old?.kind === "assistant");
  const { seq: _seq, at: _at, src: _src, srcHash: _hash, ...body } = old;
  other.append({ ...body, msg: "api-message-id" });
  assert.equal((await repairRefusedFiles(other, path.dirname(dir) + "/log2", reconvert))?.appended.length, 1);
  const item = reduce(events(other)).items.find(i => i.type === "assistant");
  assert.ok(item?.type === "assistant");
  assert.equal(item.images?.length, 1);
  assert.equal(item.text, "비교입니다.");
});

// The whole path through the host: a Claude app session whose transcript names a file that was missing
// when its log was written, and is there now.
test("a session's attach starts the repair and returns; the fixed event reaches the phone later, as a live event", { skip: process.platform === "win32" }, async t => {
  const base = path.join(fs.existsSync("/private/tmp") ? "/private/tmp" : "/tmp", `claude-${process.getuid!()}`);
  if (!fs.existsSync(base)) { fs.mkdirSync(base, { mode: 0o700 }); t.after(() => fs.rmSync(base, { recursive: true, force: true })); }
  const spare = path.join(base, `-ripple-repair-host-${process.pid}`);
  t.after(() => fs.rmSync(spare, { recursive: true, force: true }));
  const shot = path.join(spare, bridgeId, "scratchpad", "late.png");
  const seen: SessionEvent[] = [];
  const f = bridgeFixture(t, { onEvent: (_id, event) => { if (event) seen.push(event); } });
  fs.appendFileSync(f.file, line({ type: "assistant", uuid: "sent", sessionId: bridgeId, cwd: f.root, message: { id: "m", content: [{ type: "tool_use", id: "toolu_late", name: "SendUserFile", input: { files: [shot] } }] } }));
  const log = f.sessions.log(bridgeId); // imported now: the file does not exist yet
  const sent = () => log.tail().events.find(e => e.kind === "assistant" && e.msg === "sent");
  assert.deepEqual(statuses(sent()), ["blocked"]);
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, png);

  f.sessions.repairFiles(bridgeId);
  // Back already, and nothing has changed yet.
  assert.deepEqual(statuses(sent()), ["blocked"]);
  for (let i = 0; i < 500 && !seen.some(e => e.kind === "assistant" && e.msg === "sent" && e.tools[0]?.files?.[0]?.status === "ready"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const live = seen.find(e => e.kind === "assistant" && e.msg === "sent" && e.tools[0]?.files?.[0]?.status === "ready");
  assert.ok(live, "the restated message came as a live event");
  assert.equal(sent()?.kind === "assistant" ? sent()!.images?.length : 0, 1);
});

// ---- the restatement is news only to a phone that can hold the original ----------------------------------

/** The timeline reducer as released (8315becc), from a temp copy whose imports point at this tree's src. */
async function releasedReduce(t: TestContext): Promise<typeof reduce | null> {
  let source: string;
  try { source = execFileSync("git", ["show", "8315becc:packages/remote/web/timeline.ts"], { cwd: import.meta.dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-released-reducer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = pathToFileURL(path.join(import.meta.dirname, "..", "src") + path.sep).href;
  const file = path.join(dir, "timeline.ts");
  fs.writeFileSync(file, source.replaceAll('"../src/', `"${src}`));
  return (await import(pathToFileURL(file).href) as { reduce: typeof reduce }).reduce;
}
/** A fresh tail that starts at `seq`: the budget is found without reading anything. */
function tailFrom(log: EventLog, seq: number): SessionEvent[] {
  for (let bytes = 1; bytes < 50_000; bytes++) if (log.tailStart(bytes) === seq) return log.tail(bytes).events;
  assert.fail(`no tail starts at ${seq}`);
}
const isInert = (e: SessionEvent): boolean => e.kind === "tool_result" && /^repair:\d+$/.test(e.toolUseId) && e.ok && e.text === "";
const shape = (list: SessionEvent[], view: typeof reduce) => { const v = view(list); return { keys: v.items.map(i => i.key), state: v.state, turnStartedAt: v.turnStartedAt }; };

// Repaired with the original (seq 2, 3) inside the window: the restatements are seq 5 and 6.
async function repaired(t: TestContext) {
  const f = fixture(t);
  const cached = events(f.log);
  const done = await repairRefusedFiles(f.log, f.dir, f.reconvert);
  assert.deepEqual(done?.appended.map(e => e.seq), [5, 6]);
  return { ...f, cached };
}

test("a fresh tail that starts between the original and its restatement shows nothing misplaced, with the released reducer and today's", { skip: process.platform === "win32" }, async t => {
  const { log } = await repaired(t);
  const released = await releasedReduce(t);
  const tail = tailFrom(log, 4);
  assert.deepEqual(tail.map(e => e.seq), [4, 5, 6]);
  assert.deepEqual(tail.slice(1).map(isInert), [true, true], "both restatements are inert at their own seqs");
  assert.deepEqual(tail.slice(1).map(e => e.seq), [5, 6]);
  // The reply the restatement is of is not in this tail at all: no reducer may show it, nor a tool's result.
  for (const view of released ? [reduce, released] : [reduce]) {
    const keys = view(tail).items.map(i => i.key);
    assert.deepEqual(keys, view(tail.slice(0, 1)).items.map(i => i.key), "the inert events add nothing");
    assert.equal(keys.includes("aline-send"), false);
    assert.equal(view(tail).items.flatMap(i => i.type === "assistant" ? i.tools : []).length, 0);
  }
  // The same events with the restatement as itself (what a catch-up carries) would be misplaced: this is the defect.
  const real = log.readAfter(3).events;
  assert.ok(reduce(real).items.some(i => i.key === "aline-send"));
  if (released) assert.ok(released(real).items.some(i => i.key === "aline-send"));
});

test("a catch-up from before the restatement carries it as itself, and a phone holding the original shows the fixed item in place", { skip: process.platform === "win32" }, async t => {
  const { log, cached } = await repaired(t);
  const released = await releasedReduce(t);
  const catchUp = log.readAfter(4).events;
  assert.deepEqual(catchUp.map(e => [e.seq, e.kind]), [[5, "assistant"], [6, "tool_result"]]);
  assert.equal(catchUp.some(isInert), false);
  for (const view of released ? [reduce, released] : [reduce]) {
    // The phone cached the blocked events before the repair; the catch-up is all it is sent.
    const before = view(cached);
    const old = before.items.find(i => i.key === "aline-send");
    assert.ok(old?.type === "assistant");
    assert.equal(old.images?.length ?? 0, 0);
    const after = view([...cached, ...catchUp]);
    const item = after.items.find(i => i.key === "aline-send");
    assert.ok(item?.type === "assistant");
    assert.equal(item.images?.length, 1);
    assert.deepEqual(item.tools[0]?.files?.map(f => f.status), ["ready", "blocked", "blocked"]);
    assert.equal(after.items.findIndex(i => i.key === "aline-send"), before.items.findIndex(i => i.key === "aline-send"), "in place");
    assert.deepEqual(after.items.map(i => i.key), before.items.map(i => i.key));
    const read = after.items.flatMap(i => i.type === "assistant" ? i.tools : []).find(tool => tool.id === "toolu_read");
    assert.equal(read?.result?.images?.length, 1);
  }
  // From before the original, both arrive: the original is the substitute, the restatement is itself.
  const all = log.readAfter(0).events;
  assert.deepEqual(statuses(all[1]), ["ready", "blocked", "blocked"]);
  assert.equal(all.some(isInert), false);
  const keys = reduce(all).items.map(i => i.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("an older page that covers the original and the restatement shows the original fixed and the restatement inert", { skip: process.platform === "win32" }, async t => {
  const { log } = await repaired(t);
  const released = await releasedReduce(t);
  const page = log.before(log.lastSeq + 1).events;
  assert.deepEqual(page.map(e => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(statuses(page[1]), ["ready", "blocked", "blocked"]);
  assert.deepEqual(page.slice(4).map(isInert), [true, true]);
  assert.equal(page[2]?.kind === "tool_result" ? page[2].images?.length : 0, 1);
  for (const view of released ? [reduce, released] : [reduce]) {
    const items = view(page).items;
    const send = items.find(i => i.key === "aline-send");
    assert.ok(send?.type === "assistant");
    assert.equal(send.images?.length, 1);
    assert.deepEqual(items.map(i => i.key), view(page.slice(0, 4)).items.map(i => i.key), "nothing is added at the end");
  }
  // A page that holds only the restatements: nothing to show.
  assert.equal(reduce(log.before(log.lastSeq + 1, 1).events).items.length, 0);
});

test("an inert restatement changes neither the turn's state nor the last answer, and the host's own readers never see an answer in it", { skip: process.platform === "win32" }, async t => {
  const { log, cached } = await repaired(t);
  const tail = log.tail().events;
  assert.deepEqual(shape(tail.filter(e => !isInert(e)), reduce), shape(tail, reduce));
  // The last assistant text of a turn is the closing "끝.", not the restated message after it.
  assert.equal(log.lastAssistantText(), "끝.");
  assert.equal(log.lastAssistantText(log.lastSeq + 1), "끝.");
  // The host's own reads (queue, task tracking) are given the inert form: no assistant event after the message sent.
  const own = log.readAfter(4, undefined, "inert").events;
  assert.deepEqual(own.map(isInert), [true, true]);
  assert.equal(own.some(e => e.kind === "assistant"), false);
  assert.ok(cached.length === 4);
  // An inert event is well formed for the phone's saved copy of the session (history-cache's `wellFormed`).
  assert.ok(own.every(e => typeof e.seq === "number" && e.kind === "tool_result" && typeof e.toolUseId === "string" && typeof e.text === "string"));
});

test("the marking survives a host restart, and a marker that does not fit its events is ignored", { skip: process.platform === "win32" }, async t => {
  const { log, dir } = await repaired(t);
  const side = fs.readFileSync(path.join(dir, "substitutes.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(side.filter(l => l.includes('"restates"')).length, 2);
  const stored = fs.readFileSync(path.join(dir, "events-000001.jsonl"), "utf8");
  log.close();
  const reopened = EventLog.open({ dir, now: () => 1000 });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.tail().events.slice(4).map(isInert), [true, true]);
  assert.deepEqual(reopened.readAfter(4).events.map(e => e.kind), ["assistant", "tool_result"]);
  assert.equal(reopened.lastAssistantText(), "끝.");
  assert.equal(reopened.tailStart(), 1);
  // Markers for the wrong pair (another message, an original that comes later, a seq that is not there) mark nothing.
  reopened.close();
  fs.appendFileSync(path.join(dir, "substitutes.jsonl"), [{ seq: 5, of: 4, at: 1 }, { seq: 6, of: 6, at: 1 }, { seq: 4, of: 2, at: 1 }, { seq: 99, of: 2, at: 1 }].map(restates => JSON.stringify({ restates }) + "\n").join(""));
  const again = EventLog.open({ dir, now: () => 1000 });
  t.after(() => again.close());
  assert.deepEqual(again.tail().events.map(isInert), [false, false, false, false, true, true]);
  assert.equal(again.tail().events[3]?.kind, "assistant");
  // The log files were only appended to, never rewritten.
  assert.ok(fs.readFileSync(path.join(dir, "events-000001.jsonl"), "utf8").startsWith(stored.split("\n").slice(0, 4).join("\n")));
  assert.throws(() => again.restate({ kind: "user", text: "x", clientMsgId: "z" }, 1, 1), RangeError);
  assert.throws(() => again.restate({ kind: "assistant", msg: "other", model: "m", text: "", tools: [] }, 2, 1), RangeError);
});
