// One supervisor interface, three implementations: launchd on macOS, Task Scheduler on Windows,
// a systemd user service on Linux.
// Everything outside this module talks to the router's lifecycle through here.

import { execFileSync, spawn } from "node:child_process";
import { homeDir } from "../../router/src/config.ts";
import { readInstallationId } from "../../router/src/installation-id.ts";
import * as launchd from "./launchd.ts";
import * as schtasks from "./schtasks.ts";
import * as systemd from "./systemd.ts";
import type { AgentRemove, AgentRestart, AgentStart, AgentStop, Ownership } from "./ownership.ts";
import { type RouterIdentity, adminUrl, awaitIdentity, routerIdentity } from "./router-state.ts";
import { runtime } from "./runtime.ts";
import { windowsPowerShellEnv } from "./windows-powershell.ts";

/** `unknown` is a lookup that failed: neither "loaded" nor "absent" may be claimed from it. */
export type AgentState = "running" | "loaded" | "not-loaded" | "unknown";
/** `direct` is a router that is up but was started outside its supervisor (see startRouter). */
export type StartResult = AgentStart | "started-directly";
export type RestartResult = AgentRestart;
export type StopResult = AgentStop;
export type RemoveResult = AgentRemove;

export const isWindows = process.platform === "win32";
export const isLinux = process.platform === "linux";
export const isSupported = isWindows || isLinux || process.platform === "darwin";

/** What the supervisor is called on this platform, for messages the user reads. */
export function supervisorName(): string {
  return isWindows ? "scheduled task" : isLinux ? "systemd user service" : "launchd agent";
}

export function installAgent(opts: { program: string; args?: string[]; bundleId?: string; home: string; env?: Record<string, string> }): string {
  return isWindows ? schtasks.installAgent(opts) : isLinux ? systemd.installAgent(opts) : launchd.installAgent(opts);
}

export function removeAgent(home: string = homeDir()): RemoveResult {
  return isWindows ? schtasks.removeAgent(schtasks.taskName(), { home }) : isLinux ? systemd.removeAgent(home) : launchd.removeAgent(home);
}

export function agentState(): AgentState {
  return isWindows ? schtasks.agentState() : isLinux ? systemd.agentState() : launchd.agentState();
}

/**
 * Who the service definition registered for this home belongs to, from the definition alone (no
 * service manager is asked). Uninstall reads it before removing anything, so a legacy Codex block
 * (an older version recorded no home) is taken only when this home's definition was the one
 * registered when the uninstall began (B03, 2026-10-25).
 */
export function serviceOwnership(home: string = homeDir()): Ownership {
  return isWindows ? schtasks.taskOwnership(home) : isLinux ? systemd.unitOwnership(home) : launchd.agentOwnership(home);
}

/**
 * How a start is asked for and how its result is judged. Injected so tests can model a supervisor
 * that accepts the request but never produces a process, without touching a real one.
 */
export type StartOps = {
  start(): AgentStart;
  /** True while the router's process exists — the same pid `stop` and `restart` look for. */
  up(): boolean;
  /** Starts the router without the supervisor; the new process's pid, or null. Absent where the
   * supervisor keeps the router alive by itself (launchd's KeepAlive, systemd's Restart): a router
   * started beside it would fight the one it relaunches for the port. */
  fallback?: () => number | null;
  /** True while `pid` is alive. */
  alive(pid: number): boolean;
  /** A bounded check of the router's admin API, used only for a direct fallback. */
  healthy?(timeoutMs: number): boolean;
  now(): number;
  sleep(ms: number): void;
};

/**
 * A start is done when the router is, not when the supervisor says so. Every supervisor answers
 * once the *request* is accepted — Task Scheduler on Start-ScheduledTask, launchd on kickstart,
 * systemd once the unit is activated — so a launcher that never runs the router, or a program that
 * exits at once, still reads as "started". On 2026-10-22 an update drained the router, the
 * scheduled task accepted the start, nothing came up, and the update ended "updated": Claude had
 * no router for 11h47m until the next sign-in (#80). So the process is waited for, and when it
 * never appears the router is started without the supervisor — unsupervised beats absent — and if
 * that fails too the answer is failure, never success.
 */
export function startRouter(ops: StartOps, opts: { budgetMs?: number; pollMs?: number; onProgress?: (msg: string) => void } = {}): StartResult {
  if (ops.up()) return "already-running";
  let asked: AgentStart = "failed";
  try {
    asked = ops.start();
  } catch {
    // A supervisor whose call throws has not started anything; the direct path below is the answer.
    asked = "failed";
  }
  // Another installation owns the registered definition: this one must not start a second router
  // beside it, and must not start one unsupervised either (B01).
  if (asked === "other-installation" || asked === "ownership-unknown") return asked;
  if (asked !== "failed" && waitUntil(ops, () => ops.up(), opts)) return asked;
  if (!ops.fallback) return "failed";
  opts.onProgress?.(`the ${supervisorName()} did not bring the router up; starting it directly`);
  const pid = ops.fallback();
  if (pid === null) return "failed";
  const startedAt = ops.now();
  const deadline = startedAt + (opts.budgetMs ?? 20_000);
  while (ops.now() < deadline) {
    if (!ops.alive(pid)) return "failed";
    const remaining = deadline - ops.now();
    // An exit(42) child can exist at the first poll. Require a full second of survival, then
    // an actual router response, and check survival again after that blocking health request.
    if (ops.now() - startedAt >= 1_000 && ops.healthy?.(Math.min(3_000, remaining)) && ops.now() <= deadline && ops.alive(pid)) return "started-directly";
    ops.sleep(Math.min(opts.pollMs ?? 500, Math.max(0, deadline - ops.now())));
  }
  return "failed";
}

function waitUntil(ops: Pick<StartOps, "now" | "sleep">, ok: () => boolean, opts: { budgetMs?: number; pollMs?: number }): boolean {
  const deadline = ops.now() + (opts.budgetMs ?? 20_000);
  while (ops.now() < deadline) {
    if (ok()) return true;
    ops.sleep(opts.pollMs ?? 500);
  }
  return ok();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The router started outside its supervisor: the last resort that still leaves Claude working when
 * the supervisor will not. It runs unsupervised until the next logon or `clauderipple repair`.
 */
function startRouterDirectly(): number | null {
  try {
    const rt = runtime();
    const child = spawn(rt.node, [rt.router], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...rt.env } });
    // A spawn failure (ENOENT) arrives as an event; it must surface as "no pid", not as a crash.
    child.on("error", () => {});
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the supervisor's own job for this installation has a process. This is a start decision
 * (is a router already up?) and never a shutdown one: the job/unit is keyed by a definition whose
 * owner is checked here, and on Windows the pid is only used to answer "already running" — the
 * drain request is gated by the installation id instead (see WindowsRouterOps).
 */
function ownsRunningRouter(home: string): boolean {
  if (isWindows) return schtasks.agentPid(schtasks.taskName(), { home, expectedRouter: runtime().router }) !== null;
  if (isLinux) return systemd.unitOwnership(home).state === "ours" && systemd.agentPid() !== null;
  return launchd.agentOwnership(home).state === "ours" && launchd.agentPid() !== null;
}

function realStartOps(home: string): StartOps {
  return {
    start: () => (isWindows ? schtasks.startAgent(schtasks.taskName(), { home }) : isLinux ? systemd.startAgent(home) : launchd.startAgent(home)),
    up: () => ownsRunningRouter(home),
    // Only the Windows launcher stops for good after a drain (#80); the others relaunch the router.
    ...(isWindows ? { fallback: startRouterDirectly } : {}),
    alive: isAlive,
    // The direct fallback's health check uses the id, so a foreign responder on a shared admin
    // port is not taken for a router this installation just started.
    healthy: (timeoutMs) => routerIdentity(home, { timeoutMs }) === "ours",
    now: () => Date.now(),
    sleep: sleepSync,
  };
}

export function startAgent(opts: { onProgress?: (msg: string) => void; home?: string } = {}): StartResult {
  return startRouter(realStartOps(opts.home ?? homeDir()), opts);
}

export function stopAgent(home: string = homeDir()): StopResult {
  if (isLinux) return systemd.stopAgent(home);
  if (!isWindows) return launchd.stopAgent(home);
  return stopWindowsRouter(windowsOps(home));
}

/**
 * Windows stop and restart, with every step injected so its decisions can be tested without Task
 * Scheduler, PowerShell or a running router. Two separate proofs are used: the task definition
 * says which installation registered the task, and the status's installation id says which
 * installation is answering the admin port. A drain request is sent only when both are ours — a
 * shared admin port or a foreign HTTP server can never be mistaken for this installation (B01/D6).
 */
export type WindowsRouterOps = {
  /** Who the registered task belongs to, read fresh at each decision. */
  owner(): Ownership;
  /** The router process under this task's own launcher, or null when that cannot be proven. */
  targetPid(): number | null;
  /** Whose instance is answering, checked against the pid this caller would act on. */
  identity(expectedPid: number | null): RouterIdentity;
  /** Whether the registered task has a running instance. */
  running(): boolean;
  /** POST /api/shutdown on this installation's admin port. */
  shutdown(): boolean;
  stopTask(): StopResult;
  /** This home's launcher PowerShell, the one process the #131 bridge may end; null if not proven. */
  launcherPid(): number | null;
  /** Ends that one launcher process; false when it no longer matches or cannot be ended. */
  stopLauncher(pid: number): boolean;
  start(): StartResult;
  now(): number;
  sleep(ms: number): void;
};

/** Waits until the identity of the instance we asked to drain satisfies `done`. */
function waitForRouter(ops: Pick<WindowsRouterOps, "identity" | "now" | "sleep">, expectedPid: number, done: (id: RouterIdentity) => boolean, budgetMs: number, onProgress?: (msg: string) => void): boolean {
  const t0 = ops.now();
  let lastTick = 0;
  while (ops.now() - t0 < budgetMs) {
    if (done(ops.identity(expectedPid))) return true;
    const s = Math.floor((ops.now() - t0) / 1000);
    if (s >= 5 && s !== lastTick && s % 5 === 0) {
      lastTick = s;
      onProgress?.(`draining… ${s}s (waiting for in-flight model calls)`);
    }
    ops.sleep(1_000);
  }
  return done(ops.identity(expectedPid));
}

/** Waits for the task's own instance to be gone (after a stop), bounded. */
function waitForTask(ops: Pick<WindowsRouterOps, "running" | "now" | "sleep">, budgetMs = 10_000): boolean {
  const t0 = ops.now();
  while (ops.now() - t0 < budgetMs) {
    if (!ops.running()) return true;
    ops.sleep(200);
  }
  return !ops.running();
}

function restartResult(started: StartResult): RestartResult {
  if (started === "failed" || started === "other-installation" || started === "ownership-unknown") return started;
  return started === "started-directly" ? "direct" : "drained";
}

/** A drain request that fails, or an instance that will not exit, never becomes a forced stop. */
export function stopWindowsRouter(ops: WindowsRouterOps, waitMs = 120_000): StopResult {
  const owner = ops.owner();
  if (owner.state === "absent") return "not-loaded";
  if (owner.state === "other") return "other-installation";
  if (owner.state === "unknown") return "ownership-unknown";
  // Only the instance under this task's own launcher can be ours; the same home's direct router
  // answering the port (pid mismatch) or another home's process is not.
  const targetPid = ops.targetPid();
  const identity = ops.identity(targetPid);
  if (identity === "other") return "other-installation";
  if (identity === "absent") return ops.running() ? "identity-unknown" : "not-loaded";
  if (targetPid === null) return "identity-unknown";
  if (!ops.shutdown()) return "failed";
  if (!waitForRouter(ops, targetPid, (id) => id !== "ours", waitMs)) return "failed";
  // The task may have been replaced while we waited: re-read before touching it.
  const again = ops.owner();
  if (again.state === "other") return "other-installation";
  if (again.state === "unknown") return "ownership-unknown";
  if (again.state === "absent") return "not-loaded";
  const replacement = ops.targetPid();
  if (replacement !== null) return ops.identity(replacement) === "other" ? "other-installation" : "identity-unknown";
  // A clean launcher exits with its router. Never stop a replacement task merely because the old
  // admin endpoint stopped answering (a timeout is not evidence of process exit).
  return waitForTask(ops) ? "stopped" : "identity-unknown";
}

/** How long a replacement router is given to answer before its identity stands as unknown. */
const SUCCESSOR_BUDGET_MS = 15_000;

export function restartWindowsRouter(ops: WindowsRouterOps, opts: { waitMs?: number; onProgress?: (msg: string) => void } = {}): RestartResult {
  const owner = ops.owner();
  if (owner.state === "other") return "other-installation";
  if (owner.state === "unknown") return "ownership-unknown";
  const targetPid = ops.targetPid();
  const identity = ops.identity(targetPid);
  // Something answers our admin port but cannot be proven ours: starting or stopping could collide
  // with another installation, so nothing is done and the reason is reported (as on launchd/systemd).
  if (identity === "other") return "other-installation";
  if (identity === "absent") {
    // A task instance we cannot identify is not restarted; nothing to stop and nothing to start.
    if (ops.running()) return "identity-unknown";
    return restartResult(ops.start());
  }
  if (targetPid === null) return "identity-unknown";
  if (!ops.shutdown()) return "failed";
  // Still draining: a second router would only fight it for the port, so this is a failure.
  if (!waitForRouter(ops, targetPid, (id) => id !== "ours", opts.waitMs ?? 120_000, opts.onProgress)) return "failed";
  const again = ops.owner();
  if (again.state === "other") return "other-installation";
  if (again.state === "unknown") return "ownership-unknown";
  const replacement = ops.targetPid();
  if (replacement !== null) {
    // The launcher has only just started it: wait for the admin port's answer (see awaitIdentity).
    const answer = awaitIdentity(ops.identity, replacement, () => ops.targetPid(), { budgetMs: SUCCESSOR_BUDGET_MS, now: ops.now, sleep: ops.sleep });
    if (answer.state === "other") return "other-installation";
    return answer.pid !== targetPid && answer.state === "ours" ? "drained" : "identity-unknown";
  }
  // #131: a launcher written before the fix waits for its child, the installer, and the installer
  // waits for this task to end. The router is drained, so ending only that launcher lets the task
  // leave Running; the start below then runs it again, with the current launcher.
  if (!waitForTask(ops) && !(endStuckLauncher(ops) && waitForTask(ops))) return "identity-unknown";
  return restartResult(ops.start());
}

/**
 * Ends this home's launcher after the router has drained, when nothing answers this installation's
 * admin port and the task is still Running (#131). Ownership is read again here, and `identity(null)`
 * is "absent" only when nothing answers at all. False whenever any of that is not proven.
 */
function endStuckLauncher(ops: Pick<WindowsRouterOps, "owner" | "identity" | "launcherPid" | "stopLauncher">): boolean {
  if (ops.owner().state !== "ours") return false;
  if (ops.identity(null) !== "absent") return false;
  const pid = ops.launcherPid();
  return pid !== null && ops.stopLauncher(pid);
}

function windowsOps(home: string): WindowsRouterOps {
  // Nothing is snapshotted: every gate reads the task and its process again, so a registration
  // replaced while we drain cannot be acted on from stale evidence.
  return {
    owner: () => schtasks.taskOwnership(home),
    targetPid: () => schtasks.taskRouterPid(schtasks.taskName(), { home }),
    identity: (expectedPid) => routerIdentity(home, { expectedPid }),
    running: () => schtasks.agentState(schtasks.taskName()) === "running",
    shutdown: () => askShutdown(home),
    stopTask: () => schtasks.stopAgent(schtasks.taskName(), { home }),
    launcherPid: () => schtasks.launcherProcessPid(home),
    stopLauncher: pid => schtasks.stopLauncherProcess(pid, home),
    start: () => startAgent({ home }),
    now: () => Date.now(),
    sleep: sleepSync,
  };
}

/** Blocking POST to the router's shutdown endpoint, naming this installation. */
function askShutdown(home: string): boolean {
  const id = readInstallationId(home);
  const headers = id ? ` -Headers @{ 'x-clauderipple-install-id' = '${id}' }` : "";
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Invoke-RestMethod -Method Post -Uri '${adminUrl(home)}/api/shutdown'${headers} -TimeoutSec 10 | Out-Null`],
      { env: windowsPowerShellEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function restartAgent(opts: { waitMs?: number; onProgress?: (msg: string) => void; home?: string } = {}): RestartResult {
  const home = opts.home ?? homeDir();
  // launchd and systemd relaunch the router themselves, so a failure there is reported as one: a
  // router started beside them would fight their next relaunch for the port.
  if (isWindows) return restartWindowsRouter(windowsOps(home), opts);
  return isLinux ? systemd.restartAgent(home, opts) : launchd.restartAgent(home, opts);
}

/** Path to the supervisor's own definition, for status output. */
export function agentDefinitionPath(): string {
  return isWindows ? `Task Scheduler\\${schtasks.taskName()}` : isLinux ? systemd.unitPath() : launchd.plistPath();
}
