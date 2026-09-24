// One supervisor interface, three implementations: launchd on macOS, Task Scheduler on Windows,
// a systemd user service on Linux.
// Everything outside this module talks to the router's lifecycle through here.

import { execFileSync } from "node:child_process";
import { ConfigStore, configPath } from "../../router/src/config.ts";
import { adminPort } from "../../router/src/admin.ts";
import * as launchd from "./launchd.ts";
import * as schtasks from "./schtasks.ts";
import * as systemd from "./systemd.ts";

export type AgentState = "running" | "loaded" | "not-loaded";
export type RestartResult = "drained" | "kickstarted" | "failed";

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

export function removeAgent(): boolean {
  return isWindows ? schtasks.removeAgent() : isLinux ? systemd.removeAgent() : launchd.removeAgent();
}

export function agentState(): AgentState {
  return isWindows ? schtasks.agentState() : isLinux ? systemd.agentState() : launchd.agentState();
}

export function agentPid(): number | null {
  return isWindows ? schtasks.agentPid() : isLinux ? systemd.agentPid() : launchd.agentPid();
}

export function startAgent(): "already-running" | "started" | "failed" {
  return isWindows ? schtasks.startAgent() : isLinux ? systemd.startAgent() : launchd.startAgent();
}

export function stopAgent(): boolean {
  if (isLinux) return systemd.stopAgent();
  if (!isWindows) return launchd.stopAgent();
  // Ask the router to drain first: a clean exit also ends the launcher's supervision loop, so the
  // task does not relaunch it. Then stop the task itself to clear anything left behind.
  askShutdown();
  waitForExit(schtasks.agentPid(), 120_000);
  return schtasks.stopAgent();
}

/** Blocking POST to the router's shutdown endpoint. Returns false if it did not answer. */
function askShutdown(): boolean {
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Invoke-RestMethod -Method Post -Uri '${adminUrl()}/api/shutdown' -TimeoutSec 10 | Out-Null`],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

/** Waits for `pid` to disappear. Returns true if it exited within the budget. */
function waitForExit(pid: number | null, budgetMs: number, onProgress?: (msg: string) => void): boolean {
  if (pid === null) return true;
  const t0 = Date.now();
  let lastTick = 0;
  while (Date.now() - t0 < budgetMs) {
    const now = schtasks.agentPid();
    if (now === null || now !== pid) return true;
    const s = Math.floor((Date.now() - t0) / 1000);
    if (s >= 5 && s !== lastTick && s % 5 === 0) {
      lastTick = s;
      onProgress?.(`draining… ${s}s (waiting for in-flight model calls)`);
    }
    sleepSync(1000);
  }
  return false;
}

/** Where the router's admin API is listening, per the current config. */
function adminUrl(): string {
  const cfg = new ConfigStore(configPath()).get();
  return `http://127.0.0.1:${adminPort(cfg)}`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows restart. There is no SIGTERM here — `process.kill(pid, "SIGTERM")` terminates the target
 * outright, which is exactly the drain-cutting behaviour launchd's `kickstart -k` was fixed for on
 * macOS — so ask the router to drain over its admin API, wait for the process to go, then start the
 * task again. The launcher's supervision loop treats a clean exit as "stay stopped", so the restart
 * has to be explicit.
 */
function restartWindows(opts: { waitMs?: number; onProgress?: (msg: string) => void }): RestartResult {
  const pid = schtasks.agentPid();
  if (pid === null) return schtasks.startAgent() === "failed" ? "failed" : "kickstarted";

  if (!askShutdown()) opts.onProgress?.("router did not answer /api/shutdown; waiting for it to exit anyway");
  const exited = waitForExit(pid, opts.waitMs ?? 120_000, opts.onProgress);
  if (!exited) return "failed";
  // A clean drain ends the launcher loop too, so the task has to be started again.
  return schtasks.startAgent() === "failed" ? "failed" : "drained";
}

export function restartAgent(opts: { waitMs?: number; onProgress?: (msg: string) => void } = {}): RestartResult {
  return isWindows ? restartWindows(opts) : isLinux ? systemd.restartAgent(opts) : launchd.restartAgent(opts);
}

/** Path to the supervisor's own definition, for status output. */
export function agentDefinitionPath(): string {
  return isWindows ? `Task Scheduler\\${schtasks.taskName()}` : isLinux ? systemd.unitPath() : launchd.plistPath();
}
