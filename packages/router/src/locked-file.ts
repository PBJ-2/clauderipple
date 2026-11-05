// Secret-bearing JSON files that more than one process writes: the router refreshes tokens while a
// `clauderipple login` in another terminal adds an account. Every mutation holds a cross-process
// lock and replaces the file atomically, so a reader sees the old file or the new one, never half.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lockSync } from "proper-lockfile";

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 100;
const LOCK_TIMEOUT_MS = 2_000;

/** Run `mutate` while holding the lock for `file`. Waits up to two seconds for another writer. */
export function withFileLock<T>(file: string, mutate: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let release: () => void;
  for (;;) {
    try {
      release = lockSync(file, { realpath: false, stale: LOCK_STALE_MS, update: 10_000 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    return mutate();
  } finally {
    release!();
  }
}

const RENAME_RETRY_BUDGET_MS = 2_000;
const RENAME_RETRY_WAIT_MS = 10;
const RENAME_RETRY_WAIT_MAX_MS = 200;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows refuses a rename while another process has the target open (the old router reading its
 * state) or a virus scanner is inspecting it — EPERM/EACCES/EBUSY — and one refusal aborted a whole
 * GUI update (issue #125). Wait briefly and retry, about two seconds in total, then rethrow. Every
 * other platform and error is a single call with no retry. `now` is injectable so a test can run the
 * budget without sleeping.
 */
export function renameWithRetry(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  rename: (from: string, to: string) => void = fs.renameSync,
  sleep: (ms: number) => void = sleepSync,
  now: () => number = Date.now,
): void {
  if (platform !== "win32") return rename(from, to);
  const deadline = now() + RENAME_RETRY_BUDGET_MS;
  let wait = RENAME_RETRY_WAIT_MS;
  for (;;) {
    try {
      return rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || now() + wait > deadline) throw error;
      sleep(wait);
      wait = Math.min(wait * 2, RENAME_RETRY_WAIT_MAX_MS);
    }
  }
}

/**
 * Replace `file` with `value` as JSON (mode 0600): flushed temp file, then rename. Returns whether
 * the directory entry was also made durable — POSIX can fsync a directory, Windows cannot, and a
 * caller retiring an older copy of the same secret needs to know which it got.
 */
export function writeJsonAtomic(file: string, value: unknown): { directoryDurable: boolean } {
  const dirName = path.dirname(file);
  fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, file);
    let directoryDurable = false;
    try {
      const dir = fs.openSync(dirName, "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      directoryDurable = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
    }
    return { directoryDurable };
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
