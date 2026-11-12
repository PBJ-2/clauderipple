// One OS process snapshot for transcript liveness. The desktop registry reads macOS and Windows.
import { execFileSync } from "node:child_process";
import { execBounded } from "../../cli/src/bounded-exec.ts";
import { windowsPowerShellEnv } from "../../cli/src/windows-powershell.ts";
export interface ProcessInfo { pid: number; command: string; started?: string }
export type ProcessExec = (file: string, args: string[]) => string;
export type ProcessExecAsync = (file: string, args: string[]) => Promise<string>;

/** 100 ns ticks from 1601-01-01 to 1970-01-01: a Windows FILETIME counts from 1601, Unix time from 1970. */
const FILETIME_UNIX_TICKS = 116444736000000000n;
/** A millisecond: the registry's own start time and the OS's CreationDate may differ by a hair. */
const FILETIME_TOLERANCE = 10_000n;

const exec: ProcessExec = (file, args) => execFileSync(file, args, {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 5000, windowsHide: true, env: windowsPowerShellEnv(), stdio: ["ignore", "pipe", "pipe"],
});
/**
 * The background read, bounded by its own deadline that also ends PowerShell's children: with
 * execFile's `timeout` a WMI helper holding the pipes kept the read alive for minutes (#162).
 * Windows gets longer than `ps` because Get-CimInstance is slow on a loaded machine.
 */
const READ_DEADLINE_MS = 15_000;
const execAsync: ProcessExecAsync = (file, args) => execBounded(file, args, {
  timeoutMs: file === "ps" ? 5000 : READ_DEADLINE_MS, windowsHide: true, env: windowsPowerShellEnv(),
});

/** The PowerShell that reads the Windows process table: pid, command line and start time. */
function windowsSnapshotArgs(): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,@{Name='CreationDate';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')}}})"];
}

export function listProcesses(platform = process.platform, run: ProcessExec = exec): ProcessInfo[] {
  if (platform === "win32") {
    const raw: unknown = JSON.parse(run("powershell.exe", windowsSnapshotArgs()));
    if (!Array.isArray(raw)) throw new Error("invalid Windows process snapshot");
    return raw.flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const p = value as Record<string, unknown>;
      return typeof p.ProcessId === "number" && typeof p.CommandLine === "string"
        ? [{ pid: p.ProcessId, command: p.CommandLine, ...(typeof p.CreationDate === "string" ? { started: p.CreationDate } : {}) }] : [];
    });
  }
  return run("ps", ["-axo", "pid,command"]).split(/\r?\n/).flatMap(line => {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), command: m[2]! }] : [];
  });
}

/** The same snapshot, read without blocking: the Windows path spawns PowerShell in the background. */
export function listProcessesAsync(platform = process.platform, run: ProcessExecAsync = execAsync): Promise<ProcessInfo[]> {
  if (platform === "win32") return run("powershell.exe", windowsSnapshotArgs()).then(output => listProcesses(platform, () => output));
  return run("ps", ["-axo", "pid,command"]).then(output => listProcesses(platform, () => output));
}

/**
 * A Windows process start as the FILETIME the Claude app writes into its desktop registry:
 * 100 ns ticks since 1601-01-01 UTC. The OS reports the same instant as an ISO string, so it
 * is converted here (issue #70).
 */
export function creationDateToFileTime(value: string): bigint | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = m;
  const seconds = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) / 1000;
  if (!Number.isFinite(seconds)) return null;
  let offset = 0;
  if (zone && zone !== "Z") {
    const parts = zone.slice(1).replace(":", "").match(/\d{2}/g) ?? [];
    offset = (zone[0] === "-" ? -1 : 1) * (Number(parts[0] ?? 0) * 60 + Number(parts[1] ?? 0)) * 60;
  }
  // The fraction is in seconds; its digits are the 100 ns ticks themselves.
  const ticks = BigInt(Math.round(seconds - offset)) * 10_000_000n + BigInt((fraction ?? "").padEnd(7, "0").slice(0, 7) || "0");
  return ticks + FILETIME_UNIX_TICKS;
}

/** The registry's own start time, in the same FILETIME. A JSON number has lost its last digits already. */
export function parseFileTime(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^\d{1,20}$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/** The same process start: the same instant, or within a millisecond of it. */
export function sameFileTime(a: bigint, b: bigint): boolean {
  const diff = a > b ? a - b : b - a;
  return diff <= FILETIME_TOLERANCE;
}

export interface ProcessSnapshotOptions {
  platform?: NodeJS.Platform;
  /** How long a snapshot is served before a new one is read. */
  ttlMs?: number;
  now?: () => number;
  /** The synchronous read: the first one only. */
  exec?: ProcessExec;
  /** Every later read, in the background. */
  execAsync?: ProcessExecAsync;
  /** A background read that failed. Reported once per run of failures. */
  onError?: (error: unknown) => void;
  /**
   * The longest a background read may keep later reads from starting, whatever the reader does.
   * `execAsync` has its own deadline; this one is the snapshot's own guarantee that a reader that
   * never settles cannot freeze the refresh for good.
   */
  readTimeoutMs?: number;
}

/**
 * The host's view of the running processes. On Windows PowerShell costs hundreds of
 * milliseconds, so the snapshot is refreshed in the background and read from memory: the host's
 * event loop never waits for it again (2026-10-12, one keychain read per request blocked the
 * relay pings). The first read is `prime()`, which the host awaits once, bounded, before it
 * starts serving, so the desktop registry is not empty when it is asked for (issue #70).
 * On Windows nothing reads synchronously, ever: a PowerShell that did not return held the host
 * for 4+ minutes despite a 5 s timeout (#162), so a first `current()` without `prime()` serves an
 * empty list and starts a background read.
 *
 * macOS reads the same way. A synchronous `ps` there is ~50 ms, but Sessions.list asks once per
 * closed Claude app session (sessionControls → isOpen), so every list ran dozens of them and
 * stalled the host for 5–14 s at a time: pushes went out late and relay pings ran late (2026-10-24).
 *
 * The registry is read synchronously — Sessions.list, summary and isOpen all are — so the
 * snapshot cannot be awaited everywhere without making the whole session list asynchronous.
 * One bounded wait at startup is the price; every later read is a map lookup. Off Windows a
 * `current()` before any `prime()` still reads `ps` synchronously, once (tests, other entry points).
 */
export class ProcessSnapshot {
  private processes: ProcessInfo[] = [];
  private at = 0;
  private read = false;
  private pending: Promise<void> | null = null;
  private failed = false;
  private readonly platform: NodeJS.Platform;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly run: ProcessExec;
  private readonly runAsync: ProcessExecAsync;
  private readonly onError: (error: unknown) => void;
  private readonly readTimeoutMs: number;
  constructor(options: ProcessSnapshotOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.ttlMs = options.ttlMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.run = options.exec ?? exec;
    this.runAsync = options.execAsync ?? execAsync;
    this.onError = options.onError ?? (error => console.error("[process snapshot]", error instanceof Error ? error.message : String(error)));
    this.readTimeoutMs = options.readTimeoutMs ?? 20_000;
  }
  /**
   * Reads the first snapshot in the background and resolves when it landed, failed, or `waitMs`
   * passed, whichever is first; never rejects. A read that outlives the wait keeps running and
   * fills the snapshot when it lands.
   */
  prime(waitMs = 10_000): Promise<void> {
    this.read = true;
    this.refresh();
    const pending = this.pending ?? Promise.resolve();
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
      void pending.then(() => { clearTimeout(timer); resolve(); });
    });
  }
  /** The processes known now: what the last read found. */
  current(): ProcessInfo[] {
    if (!this.read) {
      this.read = true;
      // Windows never waits for PowerShell on the host's own thread; the host primed this before it
      // started serving, and a caller that did not gets an empty list until the read lands.
      if (this.platform === "win32") { this.refresh(); return this.processes; }
      // Elsewhere `ps` is fast, and this is the one read a caller cannot do without: it waits, once.
      try { this.processes = listProcesses(this.platform, this.run); this.at = this.now(); this.failed = false; }
      catch { this.refresh(); }
      return this.processes;
    }
    if (this.now() - this.at >= this.ttlMs) this.refresh();
    return this.processes;
  }
  /** Reads a new snapshot in the background; the current one is served until it lands. */
  private refresh(): void {
    if (this.pending) return;
    let timer: NodeJS.Timeout | undefined;
    const giveUp = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`process snapshot read did not finish within ${this.readTimeoutMs} ms`)), this.readTimeoutMs);
      timer.unref?.();
    });
    const run = listProcessesAsync(this.platform, this.runAsync);
    run.catch(() => {}); // the race below reports it; a late failure after the give-up is not news
    // A read that never settles must not hold `pending` forever: once given up on, its late result is ignored.
    this.pending = Promise.race([run, giveUp]).then(processes => {
      this.processes = processes;
      this.at = this.now();
      this.failed = false;
    }).catch(error => {
      // The snapshot stays as it was; a run of failures is reported once, not every read.
      if (!this.failed) { this.failed = true; this.onError(error); }
    }).finally(() => { clearTimeout(timer); this.pending = null; });
  }
}

/** The snapshot the host reads. One per process, so every reader sees the same processes. */
export const processSnapshot = new ProcessSnapshot();
export function processCommands(): string { return processSnapshot.current().map(p => `${p.pid} ${p.command}`).join("\n"); }
