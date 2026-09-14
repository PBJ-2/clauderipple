// macOS supervisor: a per-user launchd agent that keeps the router alive.
// KeepAlive + ThrottleInterval 2 means a self-exit (code 75) is followed by a fresh
// process two seconds later, which is the whole point of the health self-exit.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LABEL = "com.clauderipple.router";

/** Test-only override; production always uses com.clauderipple.router. */
export function launchdLabel(): string {
  return process.env.CLAUDERIPPLE_LAUNCHD_LABEL ?? LABEL;
}

export function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${launchdLabel()}.plist`);
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

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.trim() };
  }
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function installAgent(opts: { program: string; args?: string[]; bundleId?: string; home: string; env?: Record<string, string> }): string {
  const file = plistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stdoutLog = path.join(opts.home, "logs", "launchd.log");
  fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });
  fs.writeFileSync(file, renderPlist({ ...opts, stdoutLog }));
  launchctl(["bootout", domain(), file]); // ignore result: may not be loaded
  const r = launchctl(["bootstrap", domain(), file]);
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out}`);
  return file;
}

export function removeAgent(): boolean {
  const file = plistPath();
  if (!fs.existsSync(file)) return false;
  launchctl(["bootout", domain(), file]);
  fs.unlinkSync(file);
  return true;
}

export function agentState(): "running" | "loaded" | "not-loaded" {
  const r = launchctl(["print", `${domain()}/${launchdLabel()}`]);
  if (!r.ok) return "not-loaded";
  return /state = running/.test(r.out) ? "running" : "loaded";
}

/** `force` adds -k, which SIGKILLs a running instance ~5s after SIGTERM. Only restart wants that. */
export function kickstart(opts: { force?: boolean } = {}): boolean {
  const args = ["kickstart", ...(opts.force ? ["-k"] : []), `${domain()}/${launchdLabel()}`];
  return launchctl(args).ok;
}

/**
 * Idempotent start. A router that is already up (or still coming up) is left alone: `kickstart -k`
 * used to be the "Start Router" path, so pressing it while launchd was still bringing the router
 * up killed it and started the wait over (observed 2026-09-14: three runs in the four minutes
 * after login). Re-bootstraps the plist when the agent was unloaded by `clauderipple stop`.
 */
export function startAgent(): "already-running" | "started" | "failed" {
  if (agentState() === "running") return "already-running";
  if (kickstart()) return "started";
  const file = plistPath();
  if (fs.existsSync(file) && launchctl(["bootstrap", domain(), file]).ok) return "started";
  return "failed";
}

export function agentPid(): number | null {
  const r = launchctl(["print", `${domain()}/${launchdLabel()}`]);
  if (!r.ok) return null;
  const m = /^\s*pid = (\d+)/m.exec(r.out);
  return m ? Number(m[1]) : null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Graceful restart. `launchctl kickstart -k` SIGKILLs about 5s after its SIGTERM (measured
 * 2026-09-13: the drain was cut and two in-flight model calls died), so instead we send
 * SIGTERM ourselves, let the router drain (up to 90s), wait for the process to exit, and let
 * launchd's KeepAlive relaunch it. Falls back to kickstart only if there is no pid or the
 * process ignores SIGTERM for longer than the drain budget.
 */
export function restartAgent(opts: { waitMs?: number; onProgress?: (msg: string) => void } = {}): "drained" | "kickstarted" | "failed" {
  const pid = agentPid();
  if (pid === null) return kickstart({ force: true }) ? "kickstarted" : "failed";
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return kickstart({ force: true }) ? "kickstarted" : "failed";
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
  if (!exited) return kickstart({ force: true }) ? "kickstarted" : "failed";
  // KeepAlive relaunches it; ThrottleInterval is 2s.
  const upBy = Date.now() + 15_000;
  while (Date.now() < upBy) {
    if (agentState() === "running" && agentPid() !== pid) return "drained";
    sleepSync(250);
  }
  return kickstart({ force: true }) ? "kickstarted" : "failed";
}

export function stopAgent(): boolean {
  const file = plistPath();
  return launchctl(["bootout", domain(), file]).ok;
}
