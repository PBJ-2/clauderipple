// The router, not the optional tray, owns update scheduling. All process/time boundaries are injected.
import fs from "node:fs";
import { readHostUpdate, type HostUpdate } from "../../remote/src/host-update.ts";
import path from "node:path";
import { writeJsonAtomic } from "./locked-file.ts";
import { parseUpdateCheck, type CliResult, type DetachedCli, type UpdateCheck } from "./cli-control.ts";
import type { Activity } from "./awake.ts";

const MINUTE = 60_000;
export const UPDATE_TIMING = { first: 10 * MINUTE, interval: 12 * 60 * MINUTE, jitter: 30 * MINUTE, idle: 10 * MINUTE, poll: 5 * MINUTE, backoff: 24 * 60 * MINUTE };
type Attempt = { from: string; to: string; at: number; pid?: number };
type Saved = {
  available?: string;
  kind?: string;
  pending?: Attempt;
  completed?: Attempt;
  failures: Record<string, number>;
  lastError?: string;
};
export type AutoUpdateStatus = {
  hostUpdate?: HostUpdate;
  enabled: boolean;
  running: boolean;
  kind?: string;
  available?: string;
  lastUpdatedFrom?: string;
  lastUpdatedTo?: string;
  lastUpdatedAt?: number;
  lastError?: string;
};
export type UpdateClock = { now(): number; random(): number; later(fn: () => void, ms: number): () => void };
const realClock: UpdateClock = {
  now: Date.now, random: Math.random,
  later(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer); },
};
export type AutoUpdateDeps = {
  home: string;
  version: string;
  enabled(): boolean;
  activity(): Activity;
  log: { info(message: string): void };
  runCli(args: string[], timeout?: number): Promise<CliResult>;
  startCliDetached(args: string[], log: string, env?: NodeJS.ProcessEnv): DetachedCli | void;
  clock?: UpdateClock;
  alive?: (pid: number) => boolean;
};
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true; // Permission errors cannot prove that an installer stopped.
  }
}
function isAttempt(value: unknown): value is Attempt {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<Attempt>;
  return typeof a.from === "string" && typeof a.to === "string" && typeof a.at === "number" && Number.isFinite(a.at)
    && (a.pid === undefined || (Number.isInteger(a.pid) && a.pid > 0));
}
function load(file: string): Saved {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { failures: {} };
    throw error;
  }
  if (!raw || typeof raw !== "object") throw new Error("invalid update state");
  const s = raw as Partial<Saved>;
  if (!s.failures || typeof s.failures !== "object" || Array.isArray(s.failures)
    || Object.values(s.failures).some((t) => typeof t !== "number" || !Number.isFinite(t))
    || (s.pending !== undefined && !isAttempt(s.pending)) || (s.completed !== undefined && !isAttempt(s.completed))
    || [s.available, s.kind, s.lastError].some((v) => v !== undefined && typeof v !== "string")) throw new Error("invalid update state");
  return { ...s, failures: s.failures };
}

/**
 * Strict "x.y.z" order for host-update records (issue #125), returning null when either side is not
 * exactly three numbers. The CLI's `isNewer` reads a non-numeric part as 0 and drops the pre-release
 * suffix, which is fine for "is there a release?" but not for deciding to overwrite a host record:
 * anything this router cannot read exactly must leave the record alone.
 */
function compareVersions(a: string, b: string): number | null {
  const parts = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! > pb[i]! ? 1 : -1;
  return 0;
}

export class AutoUpdater {
  private readonly deps: AutoUpdateDeps;
  private readonly clock: UpdateClock;
  private readonly file: string;
  private readonly startedAt: number;
  private saved: Saved = { failures: {} };
  private blocked = false;
  private active = false;
  private cancel: (() => void) | undefined;
  private waiting: { check: UpdateCheck; until: number } | undefined;
  private childRunning = false;
  private cancelHost: (() => void) | undefined;
  private hostRefreshing = false;

  constructor(deps: AutoUpdateDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? realClock;
    this.startedAt = this.clock.now();
    this.file = path.join(deps.home, "auto-update.json");
    try {
      this.saved = load(this.file);
      const pending = this.saved.pending;
      if (pending?.to === deps.version) {
        this.saved.completed = { ...pending, at: this.clock.now() };
        delete this.saved.pending;
        delete this.saved.available;
        delete this.saved.lastError;
        delete this.saved.failures[pending.to];
        this.persist();
        this.info(`completed ${pending.from} -> ${pending.to}`);
      } else if (pending && !(pending.pid && (deps.alive ?? alive)(pending.pid))) {
        this.fail(pending, "previous update did not start the recorded target version");
      }
    } catch (error) {
      this.blocked = true; // Never overwrite unreadable state or install without durable intent.
      this.saved.lastError = String(error);
      this.info(`disabled installs: ${error}`);
    }
  }

  private info(message: string): void { this.deps.log.info(`auto-update: ${message}`); }
  private persist(): void {
    try { writeJsonAtomic(this.file, this.saved); } catch (error) {
      this.blocked = true;
      this.saved.lastError = String(error);
      this.info(`cannot persist state; disabled installs: ${error}`);
      throw error;
    }
  }
  private completedInstallerRunning(): boolean {
    const completed = this.saved.completed;
    if (!completed?.pid) return false;
    if ((this.deps.alive ?? alive)(completed.pid)) return true;
    // The CLI may install the tray runtime AFTER the new router starts. Retire its PID once gone
    // so a later, unrelated process reusing that PID cannot suppress updates indefinitely.
    delete completed.pid;
    try { if (!this.blocked) this.persist(); } catch { /* persist logs and disables installs */ }
    return false;
  }
  private pendingRunning(): boolean {
    const pending = this.saved.pending;
    if (!pending) return this.completedInstallerRunning();
    if (this.childRunning || (pending.pid && (this.deps.alive ?? alive)(pending.pid))) return true;
    if (this.clock.now() - pending.at < UPDATE_TIMING.first) return true;
    this.fail(pending, "update did not restart the router at the target version");
    return false;
  }
  status(): AutoUpdateStatus {
    const completed = this.saved.completed;
    const hostUpdate = this.hostState();
    if (this.active && !this.cancelHost && (hostUpdate?.status === "pending" || this.hostBehind(hostUpdate))) this.scheduleHost();
    return {
      ...(hostUpdate ? { hostUpdate } : {}),
      enabled: this.deps.enabled(), running: !!this.saved.pending || this.completedInstallerRunning(),
      ...(this.saved.kind ? { kind: this.saved.kind } : {}),
      ...(this.saved.available ? { available: this.saved.available } : {}),
      ...(completed ? { lastUpdatedFrom: completed.from, lastUpdatedTo: completed.to, lastUpdatedAt: completed.at } : {}),
      ...(this.saved.lastError ? { lastError: this.saved.lastError } : {}),
    };
  }
  observe(check: UpdateCheck): void {
    this.saved.kind = check.kind;
    if (check.newer && check.latest) this.saved.available = check.latest;
    else delete this.saved.available;
    if (!this.blocked) this.persist();
  }
  running(): boolean { return this.pendingRunning(); }

  /** Shared by POST /api/update and the scheduler. Persists intent BEFORE launching anything. */
  install(check: UpdateCheck): string {
    if (this.blocked) throw new Error("update state is unreadable; refusing to install");
    if (check.kind !== "script" && check.kind !== "npm") throw new Error(`install kind ${check.kind} cannot auto-install`);
    if (!check.newer || !check.latest || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(check.latest)) throw new Error("no valid newer version to install");
    if (this.pendingRunning()) throw new Error("an update is already running");
    const attempt: Attempt = { from: this.deps.version, to: check.latest, at: this.clock.now() };
    const log = path.join(this.deps.home, "logs", "update.log");
    this.saved.pending = attempt;
    delete this.saved.lastError;
    this.persist();
    this.info(`install ${attempt.from} -> ${attempt.to}; output ${log}`);
    let child: DetachedCli | void;
    try {
      // Pin the version that was recorded, even if npm's latest tag changes while waiting for idle.
      child = this.deps.startCliDetached(["update"], log, { CLAUDERIPPLE_PACKAGE: `clauderipple@${attempt.to}` });
    } catch (error) {
      this.fail(attempt, String(error));
      throw error;
    }
    if (child) {
      this.childRunning = true;
      void child.completion.then((result) => {
        this.childRunning = false;
        if (!result.ok) this.fail(attempt, result.output);
        else this.info(`CLI finished ${attempt.to}; awaiting target router startup`);
      }, (error: unknown) => {
        this.childRunning = false;
        this.fail(attempt, String(error));
      }).catch((error: unknown) => {
        this.blocked = true;
        this.info(`cannot persist failure; disabled installs: ${error}`);
      });
      if (child.pid !== undefined) {
        attempt.pid = child.pid;
        try { this.persist(); } catch (error) {
          // The installer is already alive: never clear its intent and allow a second launch.
          this.blocked = true;
          this.saved.lastError = String(error);
          this.info(`cannot persist installer PID; disabled installs: ${error}`);
        }
      }
    }
    return log;
  }
  private fail(attempt: Attempt, error: string): void {
    if (this.saved.pending?.at !== attempt.at || this.saved.pending.to !== attempt.to) return;
    this.saved.failures[attempt.to] = this.clock.now();
    this.saved.lastError = error.slice(-2000);
    delete this.saved.pending;
    this.persist();
    this.info(`failed ${attempt.to}; back off 24h: ${this.saved.lastError}`);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.info("first check in 10 minutes");
    this.schedule(UPDATE_TIMING.first);
    this.scheduleHost();
  }
  stop(): void { this.active = false; this.cancel?.(); this.cancelHost?.(); this.cancelHost = undefined; this.waiting = undefined; this.info("scheduler stopped"); }
  private hostState(): HostUpdate | null {
    try { return readHostUpdate(this.deps.home); }
    catch (error) { return { version: this.deps.version, status: "pending", retryAt: 0, error: `cannot read host update state: ${error}` }; }
  }
  /**
   * The record names a version this router is past: the install that wrote it never got its own
   * request in, so the host is still serving the older build (issue #125). A record at or ahead of
   * this router is left alone — an old router still running during an update must not overwrite a
   * newer request — and one whose version cannot be compared exactly is left alone too.
   */
  private hostBehind(host: HostUpdate | null): boolean {
    if (!host) return false;
    const order = compareVersions(host.version, this.deps.version);
    return order !== null && order < 0;
  }
  private scheduleHost(): void {
    if (!this.active || this.cancelHost || this.hostRefreshing) return;
    const host = this.hostState();
    if (host?.status !== "pending" && !this.hostBehind(host)) return;
    this.cancelHost = this.clock.later(() => { this.cancelHost = undefined; void this.refreshHost(); }, MINUTE);
  }
  private async refreshHost(): Promise<void> {
    this.hostRefreshing = true;
    try {
      const host = readHostUpdate(this.deps.home);
      if (host?.status === "pending" && host.version === this.deps.version) {
        if (this.clock.now() >= host.retryAt && !this.pendingRunning()) {
          const result = await this.deps.runCli(["remote", "refresh", "--pending"], 45_000);
          if (!result.ok) this.info(`host application pending: ${result.output.slice(-1000)}`);
        }
      } else if (this.hostBehind(host) && !this.pendingRunning()) {
        // No `--pending`: the current CLI writes the request for its own version first, which is the
        // step the interrupted install skipped.
        const result = await this.deps.runCli(["remote", "refresh"], 45_000);
        if (!result.ok) this.info(`host is behind ${this.deps.version}: ${result.output.slice(-1000)}`);
      }
    } catch (error) { this.info(`host application pending: ${error}`); }
    finally { this.hostRefreshing = false; this.scheduleHost(); }
  }
  private schedule(ms: number): void {
    this.cancel?.();
    if (this.active) this.cancel = this.clock.later(() => { void this.tick(); }, ms);
  }
  private nextCycle(): void {
    this.waiting = undefined;
    const ms = UPDATE_TIMING.interval + (this.clock.random() * 2 - 1) * UPDATE_TIMING.jitter;
    this.info(`next check in ${Math.round(ms / MINUTE)} minutes`);
    this.schedule(ms);
  }
  private async tick(): Promise<void> {
    try {
      if (this.pendingRunning()) { this.info("installer still running; skip cycle"); this.nextCycle(); return; }
      if (!this.waiting) {
        this.info("checking via CLI");
        const result = await this.deps.runCli(["update", "--check", "--json"], 30_000);
        if (!this.active) return;
        const check = result.ok ? parseUpdateCheck(result.output) : null;
        if (!check) throw new Error(`update check failed: ${result.output.slice(-1000)}`);
        this.observe(check);
        if (!check.newer || !check.latest) { this.info("no newer version"); this.nextCycle(); return; }
        this.waiting = { check, until: this.clock.now() + UPDATE_TIMING.backoff };
      }
      const { check, until } = this.waiting;
      if (this.blocked || !this.deps.enabled()) { this.info("automatic installation disabled"); this.nextCycle(); return; }
      if (check.kind !== "script" && check.kind !== "npm") { this.info(`skip install kind ${check.kind}`); this.nextCycle(); return; }
      const failedAt = this.saved.failures[check.latest!];
      if (failedAt !== undefined && this.clock.now() - failedAt < UPDATE_TIMING.backoff) { this.info(`backoff ${check.latest}`); this.nextCycle(); return; }
      if (this.clock.now() >= until) { this.info("gave up waiting for idle after 24h"); this.nextCycle(); return; }
      const activity = this.deps.activity();
      const last = Math.max(this.startedAt, activity.lastStartedAt ?? 0, activity.lastEndedAt ?? 0);
      if (activity.inFlight !== 0 || this.clock.now() - last < UPDATE_TIMING.idle) {
        this.info("waiting for zero in-flight requests and 10 minutes idle; recheck in 5 minutes");
        this.schedule(UPDATE_TIMING.poll);
        return;
      }
      this.install(check);
      this.nextCycle();
    } catch (error) {
      this.saved.lastError = String(error).slice(-2000);
      this.info(`cycle failed: ${error}`);
      try { if (!this.blocked) this.persist(); } catch (saveError) { this.blocked = true; this.info(`cannot persist state: ${saveError}`); }
      this.nextCycle();
    }
  }
}
