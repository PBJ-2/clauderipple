// Linux supervisor: a per-user systemd service that keeps the router alive. No sudo, nothing
// machine-wide. Restart=always + RestartSec=2 is launchd's KeepAlive + ThrottleInterval 2: a
// self-exit (code 75) is followed by a fresh process two seconds later, and StartLimitIntervalSec=0
// keeps systemd from giving up on it after a burst of those.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HEADER = "[Unit]\nDescription=ClaudeRipple local model router\n";

/** Test-only override; production always uses clauderipple.service. */
export function unitName(): string {
  const name = process.env.CLAUDERIPPLE_SYSTEMD_UNIT ?? "clauderipple.service";
  if (!/^[A-Za-z0-9_.-]+\.service$/.test(name)) throw new Error(`invalid systemd unit name: ${name}`);
  return name;
}

export function unitPath(): string {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(config, "systemd", "user", unitName());
}

/**
 * One quoted unit-file word. `%` is a specifier and `$` an environment substitution in ExecStart
 * (systemd.service(5)), so a path containing either has to be escaped or it runs something else.
 */
function quote(value: string, dollar: boolean): string {
  if (/[\r\n\0]/.test(value)) throw new Error("newlines and NUL cannot appear in a systemd unit value");
  let s = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (dollar) s = s.replace(/\$/g, "$$$$");
  return `"${s}"`;
}

export function renderUnit(opts: { program: string; args?: string[]; home: string; env?: Record<string, string> }): string {
  if (!path.isAbsolute(opts.program)) throw new Error("the service program must be an absolute path");
  const env = { CLAUDERIPPLE_HOME: opts.home, ...(opts.env ?? {}) };
  const envLines = Object.entries(env).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid environment name: ${k}`);
    return `Environment=${quote(`${k}=${v}`, false)}`;
  });
  // TimeoutStopSec covers the router's 90s drain on SIGTERM (ARCHITECTURE §5) with room to spare;
  // KillMode=mixed sends that SIGTERM to the router alone and SIGKILLs only what outlives the budget.
  return `${HEADER}StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${[opts.program, ...(opts.args ?? [])].map((a) => quote(a, true)).join(" ")}
${envLines.join("\n")}
Restart=always
RestartSec=2
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=default.target
`;
}

function systemctl(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 150_000 });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return { ok: false, out: err.stderr?.toString().trim() || err.message || "systemctl failed" };
  }
}

function mustSystemctl(args: string[]): void {
  const r = systemctl(args);
  if (!r.ok) throw new Error(`systemctl --user ${args.join(" ")} failed: ${r.out}`);
}

export function installAgent(opts: { program: string; args?: string[]; home: string; env?: Record<string, string> }): string {
  // No user manager (an ssh login without lingering, a container) means nothing would ever start
  // the router: fail here, before any file is written.
  mustSystemctl(["show-environment"]);
  const file = unitPath();
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").startsWith(HEADER)) {
    throw new Error(`${file} exists and is not ClaudeRipple's; refusing to replace it`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderUnit(opts), { mode: 0o600 });
  mustSystemctl(["daemon-reload"]);
  mustSystemctl(["enable", unitName()]);
  return file;
}

export function removeAgent(): boolean {
  const file = unitPath();
  if (!fs.existsSync(file)) return false;
  mustSystemctl(["disable", "--now", unitName()]);
  fs.unlinkSync(file);
  mustSystemctl(["daemon-reload"]);
  return true;
}

export function agentState(): "running" | "loaded" | "not-loaded" {
  const r = systemctl(["show", unitName(), "--property=ActiveState", "--value"]);
  if (r.ok && r.out.trim() === "active") return "running";
  return fs.existsSync(unitPath()) ? "loaded" : "not-loaded";
}

export function agentPid(): number | null {
  const r = systemctl(["show", unitName(), "--property=MainPID", "--value"]);
  const pid = Number(r.out.trim());
  return r.ok && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Idempotent, like launchd's: a running router is left alone (ARCHITECTURE §5, "Start Router"). */
export function startAgent(): "already-running" | "started" | "failed" {
  if (agentState() === "running") return "already-running";
  return systemctl(["start", unitName()]).ok ? "started" : "failed";
}

export function stopAgent(): boolean {
  return systemctl(["stop", unitName()]).ok;
}

/**
 * systemd sends the SIGTERM, waits for the process to exit (up to TimeoutStopSec) and then starts
 * a new one, so the drain is never cut the way `launchctl kickstart -k` cut it.
 */
export function restartAgent(opts: { waitMs?: number; onProgress?: (msg: string) => void } = {}): "drained" | "failed" {
  opts.onProgress?.("waiting for in-flight model calls to finish (up to 120s)…");
  return systemctl(["restart", unitName()]).ok ? "drained" : "failed";
}
