// One supervisor interface, two implementations: launchd on macOS, Task Scheduler on Windows.
// Everything outside this module talks to the router's lifecycle through here.

import { execFileSync } from "node:child_process";
import { ConfigStore, configPath } from "../../router/src/config.ts";
import { adminPort } from "../../router/src/admin.ts";
import * as launchd from "./launchd.ts";
import * as schtasks from "./schtasks.ts";

export type AgentState = "running" | "loaded" | "not-loaded";
export type RestartResult = "drained" | "kickstarted" | "failed";

export const isWindows = process.platform === "win32";
export const isSupported = isWindows || process.platform === "darwin";

/** What the supervisor is called on this platform, for messages the user reads. */
export function supervisorName(): string {
  return isWindows ? "scheduled task" : "launchd agent";
}

export function installAgent(opts: { program: string; args?: string[]; bundleId?: string; home: string; env?: Record<string, string> }): string {
  return isWindows ? schtasks.installAgent(opts) : launchd.installAgent(opts);
}

export function removeAgent(): boolean {
  return isWindows ? schtasks.removeAgent() : launchd.removeAgent();
}

export function agentState(): AgentState {
  return isWindows ? schtasks.agentState() : launchd.agentState();
}

export function agentPid(): number | null {
  return isWindows ? schtasks.agentPid() : launchd.agentPid();
}

export function startAgent(): "already-running" | "started" | "failed" {
  return isWindows ? schtasks.startAgent() : launchd.startAgent();
}

export function stopAgent(): boolean {
  return isWindows ? schtasks.stopAgent() : launchd.stopAgent();
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
 * task again. A scheduled task only auto-restarts on a *non-zero* exit, and a drain exits 0.
 */
function restartWindows(opts: { waitMs?: number; onProgress?: (msg: string) => void }): RestartResult {
  const pid = schtasks.agentPid();
  if (pid === null) return schtasks.startAgent() === "failed" ? "failed" : "kickstarted";

  const asked = (() => {
    try {
      // Node's fetch is async; this path is synchronous CLI code, so use a blocking request.
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Invoke-RestMethod -Method Post -Uri '${adminUrl()}/api/shutdown' -TimeoutSec 10 | Out-Null; 'ok'`],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      return true;
    } catch {
      return false;
    }
  })();
  if (!asked) opts.onProgress?.("router did not answer /api/shutdown; waiting for it to exit anyway");

  const t0 = Date.now();
  const deadline = t0 + (opts.waitMs ?? 120_000);
  let lastTick = 0;
  let exited = false;
  while (Date.now() < deadline) {
    if (schtasks.agentPid() === null || schtasks.agentPid() !== pid) {
      exited = true;
      break;
    }
    const s = Math.floor((Date.now() - t0) / 1000);
    if (s >= 5 && s !== lastTick && s % 5 === 0) {
      lastTick = s;
      opts.onProgress?.(`draining… ${s}s (waiting for in-flight model calls)`);
    }
    sleepSync(1000);
  }
  if (!exited) return "failed";
  return schtasks.startAgent() === "failed" ? "failed" : "drained";
}

export function restartAgent(opts: { waitMs?: number; onProgress?: (msg: string) => void } = {}): RestartResult {
  return isWindows ? restartWindows(opts) : launchd.restartAgent(opts);
}

/** Path to the supervisor's own definition, for status output. */
export function agentDefinitionPath(): string {
  return isWindows ? `Task Scheduler\\${schtasks.taskName()}` : launchd.plistPath();
}
