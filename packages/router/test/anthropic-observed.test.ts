// Observed-login persistence uses an in-memory filesystem: no keychain, account files or network.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ObservedClaudeCodeAuth, OBSERVED_CLAUDE_CODE_TTL_MS } from "../src/providers/anthropic-observed.ts";

const FILE = "/mock/observed-claude.json";
const MINUTE = 60_000;

function storage(t: TestContext) {
  const files = new Map<string, string>();
  let writes = 0;
  let failRename = false;
  t.mock.method(fs, "readFileSync", (file: string) => {
    const value = files.get(file);
    if (value === undefined) throw new Error("missing mock file");
    return value;
  });
  t.mock.method(fs, "writeFileSync", (file: string, value: string, options: { mode: number }) => {
    assert.equal(options.mode, 0o600);
    writes++;
    files.set(file, value);
  });
  t.mock.method(fs, "renameSync", (from: string, to: string) => {
    if (failRename) throw new Error("mock rename failure");
    files.set(to, files.get(from)!);
    files.delete(from);
  });
  t.mock.method(fs, "rmSync", (file: string) => { files.delete(file); });
  return { files, writes: () => writes, failRename: (value: boolean) => { failRename = value; } };
}

for (const activity of ["observe", "noteUsed"] as const) {
  test(`continuous ${activity} activity checkpoints freshness and survives a restart`, t => {
    const disk = storage(t);
    const auth = new ObservedClaudeCodeAuth(FILE);
    const headers = ["Authorization", "Bearer mock-token", "anthropic-beta", "mock-beta"];
    auth.observe(headers, 0);
    for (let minute = 1; minute <= 13 * 60; minute++) {
      if (activity === "observe") auth.observe(headers, minute * MINUTE);
      else auth.noteUsed("bearer mock-token", minute * MINUTE);
    }
    const now = 13 * 60 * MINUTE;
    assert.equal(auth.getFresh(now)?.observedAt, now, "RAM freshness follows every use");
    const restarted = new ObservedClaudeCodeAuth(FILE);
    assert.ok(restarted.getFresh(now), "continuous use is not aged out by a restart");
    assert.deepEqual(restarted.getFresh(now)?.headers, { Authorization: "Bearer mock-token", "anthropic-beta": "mock-beta" });
    assert.equal(disk.writes(), 131, "one initial write, then at most one checkpoint per five minutes");
    const persistedAt = restarted.getFresh(now)!.observedAt;
    assert.equal(restarted.getFresh(persistedAt + OBSERVED_CLAUDE_CODE_TTL_MS), null);
    assert.equal(disk.files.has(FILE), false, "the idle guard still deletes expired storage");
  });
}

test("a loaded checkpoint sets the throttle baseline and a failed write is retried", t => {
  const disk = storage(t);
  const first = new ObservedClaudeCodeAuth(FILE);
  first.observe(["authorization", "Bearer mock-token"], 0);
  const restarted = new ObservedClaudeCodeAuth(FILE);
  restarted.noteUsed("Bearer mock-token", 5 * MINUTE);
  assert.equal(disk.writes(), 1, "the existing strict five-minute threshold is preserved");
  disk.failRename(true);
  restarted.noteUsed("Bearer mock-token", 5 * MINUTE + 1);
  assert.equal(disk.writes(), 2);
  disk.failRename(false);
  restarted.noteUsed("Bearer mock-token", 5 * MINUTE + 2);
  assert.equal(disk.writes(), 3, "a failed rename does not advance the saved checkpoint");
  assert.equal(new ObservedClaudeCodeAuth(FILE).getFresh(5 * MINUTE + 2)?.observedAt, 5 * MINUTE + 2);
});

test("token replacement and exact-token invalidation keep their generation guards", t => {
  const disk = storage(t);
  const auth = new ObservedClaudeCodeAuth(FILE);
  auth.observe(["authorization", "Bearer old-token"], 0);
  auth.observe(["authorization", "Bearer new-token"], 1);
  assert.equal(disk.writes(), 2, "a changed token is persisted immediately");
  auth.noteUsed("Bearer old-token", 10 * MINUTE);
  auth.forget("Bearer old-token");
  auth.noteUsed("Bearer new-token", 0);
  assert.equal(auth.getFresh(1)?.observedAt, 1, "old answers and backwards timestamps cannot move the new login");
  assert.equal(disk.writes(), 2);
  assert.equal(new ObservedClaudeCodeAuth(FILE).getFresh(1)?.authorization, "Bearer new-token");
  auth.forget("bearer new-token");
  auth.observe(["authorization", "Bearer new-token"], 2);
  auth.noteUsed("Bearer new-token", 10 * MINUTE);
  assert.equal(auth.getFresh(10 * MINUTE), null);
  assert.equal(disk.files.has(FILE), false, "a rejected token cannot recreate storage");
  auth.observe(["authorization", "Bearer replacement-token"], 10 * MINUTE);
  assert.equal(new ObservedClaudeCodeAuth(FILE).getFresh(10 * MINUTE)?.authorization, "Bearer replacement-token");
});
