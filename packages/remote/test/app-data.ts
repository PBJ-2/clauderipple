// A Claude app data root the host only reads: one sidebar scope with one Mac session row, and the
// app's unread set in Chromium Local Storage. The host must never write these files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

const account = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", org = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const vint = (n: number): Buffer => { const out: number[] = []; do { out.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Buffer.from(out); };
const field = (b: Buffer) => Buffer.concat([vint(b.length), b]);
/** One LevelDB write-ahead-log record holding `epitaxy-unread-v1`. */
function unreadWal(ids: string[]): Buffer {
  const header = Buffer.alloc(12); header.writeBigUInt64LE(1n); header.writeUInt32LE(1, 8);
  const batch = Buffer.concat([header, Buffer.from([1]), field(Buffer.from("_https://claude.ai\0\x01epitaxy-unread-v1")),
    field(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ state: { unreadIds: ids } }))]))]);
  const record = Buffer.alloc(7); record.writeUInt16LE(batch.length, 4); record[6] = 1;
  return Buffer.concat([record, batch]);
}

/** A Claude app data root for one Mac session. `row(at)` rewrites its last activity. */
export function claudeAppData(t: TestContext, cliSessionId: string, activity = 2_000_000): { root: string; row: (activity: number, cli?: string) => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-app-data-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = `${account}/${org}`, dir = path.join(root, "claude-code-sessions", scope), storage = path.join(root, "Local Storage", "leveldb");
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(storage, { recursive: true });
  const write = (file: string, value: unknown) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  write("config.json", { lastKnownAccountUuid: account });
  write("claude_desktop_config.json", { preferences: { epitaxyPrefs: {
    "dframe-code-sections": { [scope]: { sections: [{ id: "sessions", kind: "sessions" }] } },
  } } });
  // `cli` moves the row to another CLI id, as the app does after a /clear in place.
  const row = (at: number, cli = cliSessionId) => write(`claude-code-sessions/${scope}/local_${cliSessionId}.json`,
    { sessionId: `local_${cliSessionId}`, cliSessionId: cli, title: "앱 세션", lastActivityAt: at, lastFocusedAt: 1 });
  row(activity);
  fs.writeFileSync(path.join(storage, "000001.log"), unreadWal([`local_${cliSessionId}`]));
  return { root, row };
}
