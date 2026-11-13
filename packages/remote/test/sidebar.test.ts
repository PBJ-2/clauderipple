import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopSidebar, PHONE_GROUP, UNGROUPED, windowsSidebarRoot } from "../src/sidebar.ts";
import { SidebarStorage } from "../src/sidebar-storage.ts";
import { sidebarSections, sidebarState } from "../web/sidebar.ts";
import type { SessionSummary } from "../src/protocol.ts";

const account = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", org = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const id = "cccccccc-cccc-cccc-cccc-cccccccccccc", other = "dddddddd-dddd-dddd-dddd-dddddddddddd";
function vint(n: number): Buffer { const out: number[] = []; do { out.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Buffer.from(out); }
const field = (b: Buffer) => Buffer.concat([vint(b.length), b]);
function wal(value: unknown, sequence = 1n): Buffer {
  const header = Buffer.alloc(12); header.writeBigUInt64LE(sequence); header.writeUInt32LE(1, 8);
  const batch = Buffer.concat([header, Buffer.from([1]), field(Buffer.from("_https://claude.ai\0\x01epitaxy-unread-v1")), field(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value))]))]);
  const record = Buffer.alloc(7); record.writeUInt16LE(batch.length, 4); record[6] = 1;
  return Buffer.concat([record, batch]);
}
function summary(sessionId: string, origin: "host" | "desktop" = "desktop"): SessionSummary {
  return { id: sessionId, origin, title: "transcript title", cwd: "/fixture", model: "test", effort: null, state: "idle", pending: 0, createdAt: 1, updatedAt: 1, lastSeq: 0, epoch: "" };
}
function fixture(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "claude-code-sessions", account, org), storage = path.join(root, "Local Storage", "leveldb");
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(storage, { recursive: true });
  const write = (file: string, value: unknown) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  write("config.json", { lastKnownAccountUuid: account });
  const scope = `${account}/${org}`;
  const config = { preferences: { epitaxyPrefs: {
    "dframe-group-scopes": { [scope]: { groups: [{ id: "g", name: "사용자 그룹" }], assignments: { [`code:local_${id}`]: "g", [`code:local_${other}`]: "g" }, order: { g: [`code:local_${id}`, `code:local_${other}`] } } },
    "dframe-code-sections": { [scope]: { sections: [{ id: "sessions", kind: "sessions", order: 2 }, { id: "g", kind: "manual", name: "사용자 그룹", order: 1, sortBy: "recency" }] } },
  } } };
  write("claude_desktop_config.json", config);
  const session = (cli: string, activity: number, extra = {}) => write(`claude-code-sessions/${scope}/local_${cli}.json`, { sessionId: `local_${cli}`, cliSessionId: cli, title: `앱 제목 ${cli[0]}`, lastActivityAt: activity, lastFocusedAt: 1, ...extra });
  session(id, 100); session(other, 200);
  fs.writeFileSync(path.join(storage, "000001.log"), wal({ state: { unreadIds: [`local_${id}`] } }));
  let now = 0;
  return { root, dir, storage, config, write, session, sidebar: new DesktopSidebar({ root, now: () => now }), advance: () => { now += 3001; } };
}
test("a session the app re-keyed by a /clear names the ids it left, malformed ones and its own id left out", t => {
  const f = fixture(t);
  const old = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  f.session(id, 100, { priorCliSessionIds: [old, "not-an-id", 7, id] });
  f.advance();
  const listed = f.sidebar.join([summary(id), summary(old), summary(other)], v => v);
  assert.deepEqual(listed.find(s => s.id === id)?.supersedes, [old]);
  assert.equal(listed.some(s => s.id === old), false, "the left id is not listed");
  assert.equal(listed.find(s => s.id === other)?.supersedes, undefined, "a session that never moved names nothing");
});

test("Windows sidebar discovers only one complete, verified packaged-app layout", t => {
  const f = fixture(t);
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-appdata-"));
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  assert.equal(windowsSidebarRoot(appData), undefined);
  const root = path.join(appData, "Claude-Data", "claude_package");
  fs.cpSync(f.root, root, { recursive: true });
  assert.equal(windowsSidebarRoot(appData), root);
  assert.deepEqual(new DesktopSidebar({ root: windowsSidebarRoot(appData)! }).read().groups, f.sidebar.read().groups);
  fs.cpSync(f.root, path.join(appData, "Claude-Data", "claude_other"), { recursive: true });
  assert.equal(windowsSidebarRoot(appData), undefined, "ambiguous app profiles are not guessed");
  fs.rmSync(path.join(root, "claude_desktop_config.json"));
  fs.rmSync(path.join(appData, "Claude-Data", "claude_other"), { recursive: true });
  assert.equal(windowsSidebarRoot(appData), undefined, "incomplete data does not enable the sidebar");
});

test("app group order, recency, exact titles and unread IDs (unless focused since the last activity)", t => {
  const f = fixture(t), snapshot = f.sidebar.read();
  assert.deepEqual(snapshot.groups.map(g => g.name), ["사용자 그룹", UNGROUPED]);
  assert.deepEqual(snapshot.groups[0]?.sessions, [other, id]);
  const joined = f.sidebar.join([summary(id), summary(other), summary("phone", "host")], s => s);
  assert.equal(joined[0]?.title, "앱 제목 c"); assert.equal(joined[0]?.unread, true);
  assert.equal(joined[1]?.unread, false); assert.equal(joined[2]?.group, PHONE_GROUP);
  // Focused in the app after its last activity: read, though the stored set (saved late) lists it.
  f.session(id, 100, { lastFocusedAt: 150 }); f.advance(); f.sidebar.read();
  assert.equal(f.sidebar.join([summary(id)], s => s)[0]?.unread, false);
  f.session(id, 100); f.advance(); f.sidebar.read();
  // Long after the last activity: only the unread one is "recent", lifted out of its group.
  const later = sidebarSections(joined, snapshot.groups.map(g => g.name), Number.MAX_SAFE_INTEGER);
  assert.deepEqual(later.map(g => g.name), ["최근", "사용자 그룹", "휴대폰에서 시작"]);
  assert.deepEqual(later[0]?.sessions.map(s => s.id), [id]);
  assert.deepEqual(later[1]?.sessions.map(s => s.id), [other]);
  // Within the hour every session is recent.
  const now = Math.max(...joined.map(s => s.updatedAt)) + 1;
  assert.equal(sidebarSections(joined, snapshot.groups.map(g => g.name), now)[0]?.sessions.length, 3);
  assert.equal(sidebarState(joined[0]!), "unread"); assert.equal(sidebarState(joined[1]!), "read");
  assert.equal(sidebarState({ ...joined[1]!, state: "running" }), "running");
  assert.equal(sidebarState({ ...joined[0]!, state: "error" }), "error");
  // Current Desktop precedence: active work outranks unread completion. A background-only
  // turn has its own working glyph; a stale transcript task count alone is not liveness.
  assert.equal(sidebarState({ ...joined[0]!, state: "running" }), "running");
  assert.equal(sidebarState({ ...joined[1]!, state: "idle", background: true }), "background");
  assert.equal(sidebarState({ ...joined[1]!, state: "idle", tasks: 2 }), "read");
});
test("mtime cache obeys three-second gate; archived rows reach the phone and SDK IDs join phone handoffs", t => {
  const f = fixture(t); f.sidebar.read();
  f.session(id, 300, { title: "새 이름", isArchived: true });
  assert.equal(f.sidebar.read().sessions.get(id)?.title, "앱 제목 c");
  f.write(`claude-code-sessions/${account}/${org}/archived-sessions.idx`, { v: 1, archived: [`local_${other}`] });
  f.advance();
  const archived = f.sidebar.join([summary(id), { ...summary(other, "host"), desktopBridge: true }], s => s);
  assert.deepEqual(archived.map(s => [s.id, s.archived]), [[id, true], [other, true]]);
  assert.equal(archived[0]?.title, "새 이름");
  assert.equal(f.sidebar.join([{ ...summary("host-id", "host"), desktopBridge: true }], () => id)[0]?.archived, true);
  f.session(id, 400, { title: "휴대폰 전달" }); f.advance();
  const joined = f.sidebar.join([summary("host-id", "host")], () => id);
  assert.equal(joined[0]?.id, "host-id"); assert.equal(joined[0]?.group, "사용자 그룹"); assert.equal(joined[0]?.title, "휴대폰 전달");
});
test("manual ordering and newest WAL sequence survive partial append, deletion and compaction", t => {
  const f = fixture(t);
  f.config.preferences.epitaxyPrefs["dframe-code-sections"][`${account}/${org}`]!.sections[1]!.sortBy = "manual";
  f.write("claude_desktop_config.json", f.config);
  assert.deepEqual(f.sidebar.read().groups[0]?.sessions, [id, other]);
  const reader = new SidebarStorage(f.storage);
  assert.deepEqual(reader.read("epitaxy-unread-v1"), { state: { unreadIds: [`local_${id}`] } });
  const latest = wal({ state: { unreadIds: [] } }, 20n);
  fs.writeFileSync(path.join(f.storage, "000002.log"), latest.subarray(0, -3));
  assert.deepEqual(reader.read("epitaxy-unread-v1"), { state: { unreadIds: [`local_${id}`] } });
  fs.appendFileSync(path.join(f.storage, "000002.log"), latest.subarray(-3));
  assert.deepEqual(reader.read("epitaxy-unread-v1"), { state: { unreadIds: [] } });
  fs.unlinkSync(path.join(f.storage, "000002.log"));
  assert.deepEqual(reader.read("epitaxy-unread-v1"), { state: { unreadIds: [`local_${id}`] } });
});
test("hidden routines do not leak into No group; visible routines keep their own section", t => {
  const f = fixture(t);
  f.session(other, 200, { scheduledTaskId: "routine" });
  const sections: Record<string, unknown>[] = f.config.preferences.epitaxyPrefs["dframe-code-sections"][`${account}/${org}`]!.sections;
  sections.push({ id: "routines", kind: "routines", order: 0, shown: false });
  f.write("claude_desktop_config.json", f.config);
  assert.deepEqual(f.sidebar.join([summary(id), summary(other)], s => s).map(s => s.id), [id]);
  sections[2]!.shown = true; f.write("claude_desktop_config.json", f.config); f.advance();
  assert.equal(f.sidebar.read().groups[0]?.name, "sidebar:routines");
  assert.equal(f.sidebar.join([summary(other)], s => s)[0]?.group, "sidebar:routines");
});

test("SST internal sequence, Snappy literal blocks and WAL deletion select the latest key", t => {
  const f = fixture(t);
  const key = Buffer.from("_https://claude.ai\0\x01epitaxy-unread-v1");
  const tag = Buffer.alloc(8); tag.writeBigUInt64LE((50n << 8n) | 1n);
  const internal = Buffer.concat([key, tag]);
  const value = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ state: { unreadIds: ["local_sst"] } }))]);
  const block = (k: Buffer, v: Buffer) => Buffer.concat([vint(0), vint(k.length), vint(v.length), k, v, Buffer.from([0, 0, 0, 0, 1, 0, 0, 0])]);
  const raw = block(internal, value);
  // A raw Snappy literal with a two-byte length, rather than an uncompressed SST block.
  const literal = Buffer.alloc(3); literal[0] = 61 << 2; literal.writeUInt16LE(raw.length - 1, 1);
  const compressed = Buffer.concat([vint(raw.length), literal, raw]);
  const data = Buffer.concat([compressed, Buffer.from([1, 0, 0, 0, 0])]);
  const index = block(Buffer.from("index"), Buffer.concat([vint(0), vint(compressed.length)]));
  const footer = Buffer.alloc(48), handles = Buffer.concat([vint(0), vint(0), vint(data.length), vint(index.length)]);
  handles.copy(footer); footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  fs.writeFileSync(path.join(f.storage, "000003.ldb"), Buffer.concat([data, index, Buffer.alloc(5), footer]));
  const reader = new SidebarStorage(f.storage);
  assert.deepEqual(reader.read("epitaxy-unread-v1"), { state: { unreadIds: ["local_sst"] } });
  const batch = Buffer.alloc(12); batch.writeBigUInt64LE(60n); batch.writeUInt32LE(1, 8);
  const deletion = Buffer.concat([batch, Buffer.from([0]), field(key)]), header = Buffer.alloc(7);
  header.writeUInt16LE(deletion.length, 4); header[6] = 1;
  fs.writeFileSync(path.join(f.storage, "000004.log"), Buffer.concat([header, deletion]));
  assert.equal(reader.read("epitaxy-unread-v1"), null);
});

test("missing desktop data preserves legacy list; invalid JSON is surfaced, not guessed unread", t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, "claude_desktop_config.json"));
  assert.deepEqual(f.sidebar.join([summary(id)], s => s), [summary(id)]);
  fs.writeFileSync(path.join(f.root, "claude_desktop_config.json"), "broken"); f.advance();
  assert.throws(() => f.sidebar.read(), SyntaxError);
});
test("a CLI id the app session has moved on from is not listed beside it", t => {
  const f = fixture(t), old = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  f.session(id, 100, { priorCliSessionIds: [old] }); f.advance();
  const joined = f.sidebar.join([summary(id, "host"), summary(old, "host"), summary("phone", "host")], s => s);
  assert.deepEqual(joined.map(s => s.id), [id, "phone"]);
});
test("desktop CLI id rotation keeps the app title, and blank app metadata falls back to the transcript", t => {
  const f = fixture(t), next = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  assert.equal(f.sidebar.join([summary(id)], s => s)[0]?.title, "앱 제목 c");
  f.session(id, 300, { cliSessionId: next }); f.advance();
  const joined = f.sidebar.join([{ ...summary(id), desktopBridge: true }, summary(next)], s => s);
  assert.deepEqual(joined.map(s => [s.id, s.title]), [[next, "앱 제목 c"]]);
  for (const title of ["", "  \t\n"]) {
    f.session(id, 400, { cliSessionId: next, title }); f.advance();
    assert.equal(f.sidebar.join([summary(next)], s => s)[0]?.title, "transcript title");
  }
});

test("a /clear names no prior id: an app session's record that no app session holds is not listed", t => {
  const f = fixture(t), cleared = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const joined = f.sidebar.join([{ ...summary(id, "host"), desktopBridge: true }, { ...summary(cleared, "host"), desktopBridge: true }, summary("phone", "host")], s => s);
  assert.deepEqual(joined.map(s => s.id), [id, "phone"], "a phone session has no app row and stays");
});
