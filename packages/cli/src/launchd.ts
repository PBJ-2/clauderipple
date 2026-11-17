// macOS supervisor: a per-user launchd agent that keeps the router alive.
// KeepAlive + ThrottleInterval 2 means a self-exit (code 75) is followed by a fresh
// process two seconds later, which is the whole point of the health self-exit.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir } from "../../router/src/config.ts";
import { BUNDLE_ID, launcherPath } from "./bundle.ts";
import { type AgentRemove, type AgentRestart, type AgentStart, type AgentStop, type Ownership, ownerOf, plistEnvironment } from "./ownership.ts";
import { type IdentityWait, type RouterIdentity, awaitIdentity, routerIdentity } from "./router-state.ts";
import { withServiceFile } from "./service-definition.ts";

/** Whose router answers this installation's admin port. Injected in tests that must not probe. */
export type IdentityCheck = (expectedPid: number | null) => RouterIdentity;

export const LABEL = "com.clauderipple.router";

/** Test-only override; production always uses com.clauderipple.router. */
export function launchdLabel(): string {
  return process.env.CLAUDERIPPLE_LAUNCHD_LABEL ?? LABEL;
}

/** Test-only override (CLAUDERIPPLE_LAUNCH_AGENTS_DIR); production always uses ~/Library/LaunchAgents. */
export function plistPath(): string {
  return agentPlistPath(launchdLabel());
}

function agentPlistPath(label: string): string {
  const dir = process.env.CLAUDERIPPLE_LAUNCH_AGENTS_DIR ?? path.join(os.homedir(), "Library", "LaunchAgents");
  return path.join(dir, `${label}.plist`);
}

export function trayLaunchdLabel(): string {
  return process.env.CLAUDERIPPLE_TRAY_LAUNCHD_LABEL
    ?? (process.env.CLAUDERIPPLE_LAUNCHD_LABEL ? `${launchdLabel()}.tray` : "com.clauderipple.tray");
}

export function trayPlistPath(): string {
  return agentPlistPath(trayLaunchdLabel());
}

/** macOS cannot launch an npm tray by opening its bare Electron bundle without a script. */
export function trayLoginItemDecision(opts: { platform: NodeJS.Platform; packaged: boolean; initialized: boolean; electronOpenAtLogin: boolean }): { removeElectronItem: boolean; enableAgent: boolean } | null {
  if (opts.platform !== "darwin" || opts.packaged) return null;
  return { removeElectronItem: opts.electronOpenAtLogin, enableAgent: !opts.initialized || opts.electronOpenAtLogin };
}

export function renderTrayPlist(home: string): string {
  const log = path.join(home, "logs", "launcher.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(trayLaunchdLabel())}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(launcherPath(home))}</string>
    <string>tray</string>
  </array>
  <key>AssociatedBundleIdentifiers</key>
  <array><string>${BUNDLE_ID}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>CLAUDERIPPLE_HOME</key><string>${esc(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}

/** Reads a plist's recorded home; `null` when the file is missing or records none. */
function recordedHome(file: string): string | null {
  try {
    return plistEnvironment(fs.readFileSync(file, "utf8")).CLAUDERIPPLE_HOME ?? null;
  } catch {
    return null;
  }
}

/** Who the router agent registered under this label belongs to (B01). */
export function agentOwnership(home: string = homeDir()): Ownership {
  if (!fs.existsSync(plistPath())) return { state: "absent", home: null };
  return ownerOf(recordedHome(plistPath()), home);
}

/** Who the tray agent registered under this label belongs to (B01). */
export function trayOwnership(home: string = homeDir()): Ownership {
  if (!fs.existsSync(trayPlistPath())) return { state: "absent", home: null };
  return ownerOf(recordedHome(trayPlistPath()), home);
}

/** Refuses to write over a definition that belongs to another installation (B01). */
function refuseForeign(file: string, home: string, what: string): void {
  if (!fs.existsSync(file)) return;
  const owner = ownerOf(recordedHome(file), home);
  if (owner.state === "other") {
    throw new Error(`${what} (${file}) belongs to another ClaudeRipple installation (${owner.home}); remove it with that installation's uninstall, or use its own label for this one`);
  }
  if (owner.state === "unknown") {
    throw new Error(`${what} (${file}) does not record an installation, so it cannot be identified; refusing to replace it`);
  }
}

/** Next login only: never bootstrap, bootout or kickstart the tray's one-shot agent. */
export function installTrayAgent(home: string): string {
  const file = trayPlistPath();
  return withServiceFile(file, () => {}, guard => {
    refuseForeign(file, home, "the tray agent");
    fs.mkdirSync(path.join(home, "logs"), { recursive: true });
    guard.write(renderTrayPlist(home));
    return file;
  });
}

export function removeTrayAgent(home: string = homeDir()): AgentRemove {
  return withServiceFile(trayPlistPath(), () => {}, guard => {
    const file = trayPlistPath();
    const owner = trayOwnership(home);
    if (owner.state === "absent") return "absent";
    if (owner.state === "other") return "other-installation";
    if (owner.state === "unknown") return "ownership-unknown";
    try {
      guard.remove();
      return "removed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return "absent";
    }
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(opts: { program: string; args?: string[]; bundleId?: string; home: string; stdoutLog: string; env?: Record<string, string> }): string {
  const args = opts.args ?? [];
  const env = { CLAUDERIPPLE_HOME: opts.home, ...(opts.env ?? {}) };
  const bundle = opts.bundleId
    ? `  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${esc(opts.bundleId)}</string>
  </array>
`
    : "";
  const environment = Object.entries(env)
    .map(([key, value]) => `    <key>${esc(key)}</key><string>${esc(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(opts.program)}</string>
${args.map((arg) => `    <string>${esc(arg)}</string>`).join("\n")}
  </array>
${bundle}  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>ExitTimeOut</key><integer>120</integer>
  <!-- Interactive, not Background: launchd.plist(5) says Background jobs get their CPU and I/O
       bandwidth throttled, and an unset ProcessType still gets "light resource limits". In picker
       mode Claude Desktop sends *all* of its traffic through this proxy, so until it listens the
       app cannot reach anything at all — its responsiveness depends on us, which is exactly the
       case the man page reserves Interactive for. (2026-09-14: 26s from exec to listening after
       a reboot, with the app showing ERR_PROXY_CONNECTION_FAILED the whole time.) -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(opts.stdoutLog)}</string>
  <key>StandardErrorPath</key><string>${esc(opts.stdoutLog)}</string>
</dict>
</plist>
`;
}

/** One launchctl invocation. Injectable so recovery tests never reach the real launchd. */
export type Launchctl = (args: string[]) => { ok: boolean; out: string; code?: number | null };

/**
 * The real launchctl, with a timeout: the menu-bar app runs doctor/repair and must get an answer.
 * CLAUDERIPPLE_LAUNCHCTL is a test-only override naming a fake binary for end-to-end CLI tests.
 */
export const launchctl: Launchctl = (args) => {
  try {
    // bootout waits for the router to exit, and a router drains for up to 90s (ExitTimeOut 120):
    // that one call keeps a budget the drain fits in, so `stop` never reports a drain as a failure.
    const timeout = args[0] === "bootout" ? 150_000 : 20_000;
    const out = execFileSync(process.env.CLAUDERIPPLE_LAUNCHCTL ?? "launchctl", args, { stdio: ["ignore", "pipe", "pipe"], timeout }).toString();
    return { ok: true, out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string; status?: number | null };
    return {
      ok: false,
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.trim() || (err.message ?? "launchctl failed"),
      code: typeof err.status === "number" ? err.status : null,
    };
  }
};

/** Exit 113 is launchd's "no such service", with or without a message (measured on macOS 27). */
function missingService(r: { ok: boolean; out: string; code?: number | null }): boolean {
  return r.code === 113 || /could not find service|service .*not found/i.test(r.out);
}

/**
 * Whether a finished bootout left the job unloaded. macOS 27 answers a bootout of a job that is
 * already gone with exit 5 "Input/output error" instead of 113, so a failed bootout is judged by
 * asking launchd whether the job is still there. Only a definite "no such service" counts: any
 * other answer keeps the failure, so a job that is still loaded is never reported as stopped.
 */
function bootedOut(run: Launchctl, r: { ok: boolean; out: string; code?: number | null }): boolean {
  if (r.ok || missingService(r)) return true;
  const state = run(["print", `${domain()}/${launchdLabel()}`]);
  return !state.ok && missingService(state);
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function installAgent(opts: { program: string; args?: string[]; bundleId?: string; home: string; env?: Record<string, string> }, run: Launchctl = launchctl, identity: IdentityCheck = (expectedPid) => routerIdentity(opts.home, { expectedPid })): string {
  return withServiceFile(plistPath(), run, guard => {
    run = guard.run;
    const file = plistPath();
    // Before the write: after it there is nothing left to compare with (B01).
    refuseForeign(file, opts.home, "the launchd agent");
    // Prove the loaded instance before changing its definition, not just before bootout: a refused
    // repair must not silently replace the program a different instance will run at its next start.
    const pid = agentPid(run);
    if (pid !== null && identity(pid) !== "ours") {
      throw new Error(`a router is already running that cannot be verified as this installation's; it was left running. Stop it, then run install again`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stdoutLog = path.join(opts.home, "logs", "launchd.log");
    fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });
    guard.write(renderPlist({ ...opts, stdoutLog }));
    run(["bootout", domain(), file]); // ignore result: may not be loaded (including a loaded, idle job)
    const r = run(["bootstrap", domain(), file]);
    if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out}`);
    return file;
  });
}

export function removeAgent(home: string = homeDir(), run: Launchctl = launchctl, identity: IdentityCheck = (expectedPid) => routerIdentity(home, { expectedPid })): AgentRemove {
  return withServiceFile(plistPath(), run, guard => {
    run = guard.run;
    const file = plistPath();
    const owner = agentOwnership(home);
    if (owner.state === "absent") return "absent";
    if (owner.state === "other") return "other-installation";
    if (owner.state === "unknown") return "ownership-unknown";
    // Removing unloads the job, which terminates its process. A loaded job is not proof that the
    // process is this installation's (the plist can have been replaced under it), so a running job
    // is only unloaded when its own id proves it. A job with no process terminates nothing.
    const pid = agentPid(run);
    if (pid !== null) {
      const who = identity(pid);
      if (who === "other") return "other-installation";
      if (who !== "ours") return "identity-unknown";
    }
    const definition = fs.readFileSync(file, "utf8");
    const stopped = run(["bootout", domain(), file]);
    if (!bootedOut(run, stopped)) throw new Error(`launchd bootout failed: ${stopped.out}; definition preserved`);
    if (agentOwnership(home).state !== "ours" || fs.readFileSync(file, "utf8") !== definition) return "ownership-unknown";
    try {
      guard.remove();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return "removed";
  });
}

export function agentState(run: Launchctl = launchctl): "running" | "loaded" | "not-loaded" {
  const r = run(["print", `${domain()}/${launchdLabel()}`]);
  if (!r.ok) {
    if (missingService(r)) return "not-loaded";
    throw new Error(`launchd state lookup failed: ${r.out}`);
  }
  return /state = running/.test(r.out) ? "running" : "loaded";
}

/** `force` adds -k, which SIGKILLs a running instance ~5s after SIGTERM. Only restart wants that. */
export function kickstart(opts: { force?: boolean } = {}, run: Launchctl = launchctl): boolean {
  const args = ["kickstart", ...(opts.force ? ["-k"] : []), `${domain()}/${launchdLabel()}`];
  return run(args).ok;
}

/**
 * Idempotent start. A router that is already up (or still coming up) is left alone: `kickstart -k`
 * used to be the "Start Router" path, so pressing it while launchd was still bringing the router
 * up killed it and started the wait over (observed 2026-09-14: three runs in the four minutes
 * after login). Re-bootstraps the plist when the agent was unloaded by `clauderipple stop`.
 *
 * `kickstart` succeeding only means launchd accepted the request; a plist whose program is gone
 * fails after that, silently. So the pid is waited for, as on Windows (#80).
 */
export function startAgent(home: string = homeDir(), run: Launchctl = launchctl, opts: { waitMs?: number } = {}): AgentStart {
  return withServiceFile(plistPath(), run, guard => {
    run = guard.run;
    const owner = agentOwnership(home);
    if (owner.state === "other") return "other-installation";
    if (owner.state === "unknown") return "ownership-unknown";
    if (agentState(run) === "running") return "already-running";
    const budget = opts.waitMs ?? START_BUDGET_MS;
    if (kickstart({}, run)) return waitForPid(run, budget) ? "started" : "failed";
    const file = plistPath();
    if (fs.existsSync(file) && run(["bootstrap", domain(), file]).ok && waitForPid(run, budget)) return "started";
    return "failed";
  });
}

export function agentPid(run: Launchctl = launchctl): number | null {
  const r = run(["print", `${domain()}/${launchdLabel()}`]);
  if (!r.ok) {
    if (missingService(r)) return null;
    throw new Error(`launchd PID lookup failed: ${r.out}; no control operation performed`);
  }
  const m = /^\s*pid = (\d+)/m.exec(r.out);
  if (!m) {
    if (/state = running|\bpid\s*=/.test(r.out) || !/state = \S+/.test(r.out)) throw new Error("launchd PID response is unreadable; no control operation performed");
    return null;
  }
  const pid = Number(m[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("launchd PID response is invalid; no control operation performed");
  return pid;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How long a job launchd accepted is given to produce a process before it counts as a failure. */
const START_BUDGET_MS = 15_000;

function waitForPid(run: Launchctl, budgetMs: number, pollMs = 250): boolean {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (agentPid(run) !== null) return true;
    sleepSync(pollMs);
  }
  return agentPid(run) !== null;
}

/**
 * Graceful restart. `launchctl kickstart -k` SIGKILLs about 5s after its SIGTERM (measured
 * 2026-09-13: the drain was cut and two in-flight model calls died), so instead we send
 * SIGTERM ourselves, let the router drain (up to 90s), wait for the process to exit, and let
 * launchd's KeepAlive relaunch it. Falls back to kickstart only if there is no pid or the
 * process ignores SIGTERM for longer than the drain budget.
 */
export function restartAgent(home: string = homeDir(), opts: { waitMs?: number; onProgress?: (msg: string) => void; identityWait?: IdentityWait } = {}, run: Launchctl = launchctl, identity: IdentityCheck = (expectedPid) => routerIdentity(home, { expectedPid })): AgentRestart {
  return withServiceFile(plistPath(), run, guard => {
    run = guard.run;
    const owner = agentOwnership(home);
    if (owner.state === "other") return "other-installation";
    if (owner.state === "unknown") return "ownership-unknown";
    const startIdle = (): AgentRestart => {
      const again = agentOwnership(home);
      if (again.state === "other") return "other-installation";
      if (again.state !== "ours") return "ownership-unknown";
      const current = agentPid(run);
      if (current !== null) {
        if (current === pid) return "failed";
        // The relaunched process has not opened its admin port yet: wait for its answer instead of
        // reporting a healthy restart as unverifiable (2026-10-26).
        const answer = awaitIdentity(identity, current, () => agentPid(run), opts.identityWait);
        return answer.state === "ours" ? "drained" : answer.state === "other" ? "other-installation" : "identity-unknown";
      }
      return kickstart({}, run) && waitForPid(run, START_BUDGET_MS) ? "kickstarted" : "failed";
    };
    const pid = agentPid(run);
    // Verify the exact pid below, not a fresh lookup that might name its replacement.
    if (pid !== null) {
      const who = identity(pid);
      if (who === "other") return "other-installation";
      if (who !== "ours") return "identity-unknown";
    }
    if (pid === null) return startIdle();
    guard.check();
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return startIdle();
    }
    const t0 = Date.now();
    const deadline = t0 + (opts.waitMs ?? 120_000);
    let lastTick = 0;
    let exited = false;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        exited = true;
        break;
      }
      const s = Math.floor((Date.now() - t0) / 1000);
      if (s >= 5 && s !== lastTick && s % 5 === 0) {
        lastTick = s;
        opts.onProgress?.(`draining… ${s}s (waiting for in-flight model calls)`);
      }
      sleepSync(250);
    }
    if (!exited) return "failed";
    // KeepAlive relaunches it; ThrottleInterval is 2s.
    const upBy = Date.now() + 15_000;
    while (Date.now() < upBy) {
      if (agentState(run) === "running" && agentPid(run) !== pid) return startIdle();
      sleepSync(250);
    }
    return startIdle();
  });
}

export function stopAgent(home: string = homeDir(), run: Launchctl = launchctl, identity: IdentityCheck = (expectedPid) => routerIdentity(home, { expectedPid })): AgentStop {
  return withServiceFile(plistPath(), run, guard => {
    run = guard.run;
    const owner = agentOwnership(home);
    // No definition, no evidence: a loaded job nobody recorded is not ours to stop (B01).
    if (owner.state === "absent") return "not-loaded";
    if (owner.state === "other") return "other-installation";
    if (owner.state === "unknown") return "ownership-unknown";
    // bootout terminates the job's process; a running job is stopped only when its own id proves it.
    const pid = agentPid(run);
    if (pid !== null) {
      const who = identity(pid);
      if (who === "other") return "other-installation";
      if (who !== "ours") return "identity-unknown";
    }
    const result = run(["bootout", domain(), plistPath()]);
    if (result.ok) return "stopped";
    return bootedOut(run, result) ? "not-loaded" : "failed";
  });
}
