// Runs a command in the background with a deadline that really fires.
//
// `execFile`/`execFileSync` with `timeout` kill only the direct child and then wait for its stdio
// to close. A PowerShell that started a WMI helper (or anything else that inherited the pipes)
// keeps them open after the kill, so the sync call never returns and the async callback never
// runs: measured by two Windows users in 2026-11 as a router stalled for 19 minutes (#159) and a
// host that did not answer for 7-8 minutes (#162), with a 5 s timeout set.
//
// Here the deadline is our own timer. On expiry the whole process tree is killed, the child's
// pipes are destroyed, and the promise rejects at once without waiting for 'close'.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** What the helper needs from a spawned child; a `ChildProcess` satisfies it. */
export interface BoundedChild {
  pid?: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}
export type BoundedSpawn = (file: string, args: string[], options: SpawnOptions) => BoundedChild;

export interface BoundedExecOptions {
  /** The hard deadline. Required: a call with no bound is what this helper exists to prevent. */
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
  maxBuffer?: number;
  platform?: NodeJS.Platform;
  spawn?: BoundedSpawn;
  /** Ends the child and everything it started. Default: taskkill /T /F on Windows, the process group elsewhere. */
  killTree?: (child: BoundedChild) => void;
}

export interface BoundedExecError extends Error {
  code?: string | number | null;
  /** True when the deadline ended the call. */
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
}

/** Kills the child and its descendants without waiting for anything: the deadline must not wait on the kill. */
export function killProcessTree(child: BoundedChild, platform: NodeJS.Platform = process.platform, spawnFn: BoundedSpawn = nodeSpawn as unknown as BoundedSpawn): void {
  const pid = child.pid;
  try {
    if (platform === "win32" && pid) {
      const killer = spawnFn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, detached: true });
      killer.on("error", () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
      (killer as unknown as ChildProcess).unref?.();
      return;
    }
    if (pid) {
      // The child leads its own process group (spawned detached), so the group is the tree.
      process.kill(-pid, "SIGKILL");
      return;
    }
  } catch { /* fall through to the direct child */ }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

/**
 * Resolves with the child's stdout when it exits 0. Rejects when it exits non-zero, cannot start,
 * writes more than `maxBuffer`, or is still running at `timeoutMs` (then `timedOut` is true and
 * `code` is "ETIMEDOUT"). Settles exactly once, and never later than the deadline.
 */
export function execBounded(file: string, args: string[], options: BoundedExecOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawn ?? (nodeSpawn as unknown as BoundedSpawn);
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let child: BoundedChild | null = null;
    /** The direct child has exited (its pipes may still be held by something it started). */
    let exited = false;
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    let size = 0;

    const release = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const stream of [child?.stdout, child?.stderr]) (stream as { destroy?: () => void } | null | undefined)?.destroy?.();
    };
    const fail = (error: BoundedExecError, kill: boolean): void => {
      if (settled) return;
      settled = true;
      error.stdout = Buffer.concat(out).toString("utf8");
      error.stderr = Buffer.concat(errs).toString("utf8");
      // Windows may hand an exited child's PID to an unrelated process at once, so `taskkill /PID` is
      // sent only while the child itself runs; after it exits only its pipes are let go. A POSIX
      // group ID is not reused while any member of the group lives, so the group kill stays safe.
      if (kill && child && !(exited && platform === "win32")) (options.killTree ?? ((c: BoundedChild) => killProcessTree(c, platform, spawnFn)))(child);
      release();
      reject(error);
    };

    try {
      child = spawnFn(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: options.windowsHide ?? true,
        ...(options.env ? { env: options.env } : {}),
        // A group of its own on POSIX, so the deadline can end the whole tree; Windows uses taskkill /T.
        detached: platform !== "win32",
      });
    } catch (error) {
      fail(error as BoundedExecError, false);
      return;
    }
    timer = setTimeout(() => {
      const error: BoundedExecError = new Error(`${file} did not finish within ${options.timeoutMs} ms`);
      error.code = "ETIMEDOUT";
      error.timedOut = true;
      fail(error, true);
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBuffer) {
        const error: BoundedExecError = new Error(`${file} wrote more than ${maxBuffer} bytes`);
        error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        fail(error, true);
        return;
      }
      out.push(buf);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (settled || errs.reduce((n, b) => n + b.length, 0) > 64 * 1024) return;
      errs.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.on("exit", () => { exited = true; });
    child.on("error", (error: Error) => fail(error as BoundedExecError, false));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        const stdout = Buffer.concat(out).toString("utf8");
        release();
        resolve(stdout);
        return;
      }
      const error: BoundedExecError = new Error(`Command failed: ${file} ${args.join(" ")}${signal ? ` (${signal})` : ` (exit ${code})`}`);
      error.code = code;
      fail(error, false);
    });
  });
}
