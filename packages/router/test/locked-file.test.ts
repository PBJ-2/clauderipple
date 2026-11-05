import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameWithRetry, writeJsonAtomic } from "../src/locked-file.ts";

const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename failed`), { code });

test("a Windows rename waits out a transient lock and then succeeds", () => {
  const waits: number[] = [];
  const codes = ["EPERM", "EACCES", "EBUSY"];
  let calls = 0;
  renameWithRetry("from", "to", "win32", () => {
    const code = codes[calls++];
    if (code) throw failure(code);
  }, (ms) => waits.push(ms), () => 0);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [10, 20, 40]);
});

test("a Windows rename gives up after about two seconds of retries", () => {
  const waits: number[] = [];
  let time = 0;
  let calls = 0;
  assert.throws(() => renameWithRetry("from", "to", "win32", () => {
    calls++;
    throw failure("EPERM");
  }, (ms) => { waits.push(ms); time += ms; }, () => time), { code: "EPERM" });
  assert.ok(calls > 5, "it keeps retrying while the budget lasts");
  assert.ok(time <= 2_000, "the budget is not exceeded");
  assert.deepEqual(waits.slice(0, 5), [10, 20, 40, 80, 160]);
  assert.ok(waits.every((wait) => wait <= 200), "backoff is capped");
});

test("other platforms and non-transient errors are never retried", () => {
  for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "ENOENT"], ["win32", "EINVAL"]] as const) {
    const waits: number[] = [];
    let calls = 0;
    assert.throws(() => renameWithRetry("from", "to", platform, () => {
      calls++;
      throw failure(code);
    }, (ms) => waits.push(ms), () => 0), { code });
    assert.equal(calls, 1, `${platform}: ${code}`);
    assert.deepEqual(waits, []);
  }
});

test("writeJsonAtomic still replaces the file through the retrying rename", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-locked-file-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "state.json");
  writeJsonAtomic(file, { first: 1 });
  writeJsonAtomic(file, { second: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { second: 2 });
  assert.deepEqual(fs.readdirSync(home), ["state.json"], "the temp file is gone");
});
