// macOS supervisor: a per-user launchd agent that keeps the router alive.
// KeepAlive + ThrottleInterval 2 means a self-exit (code 75) is followed by a fresh
// process two seconds later, which is the whole point of the health self-exit.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LABEL = "com.clauderipple.router";

export function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(opts: { launcher: string; bundleId: string; home: string; stdoutLog: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(opts.launcher)}</string>
  </array>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${esc(opts.bundleId)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDERIPPLE_HOME</key><string>${esc(opts.home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>ProcessType</key><string>Background</string>
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

export function installAgent(opts: { launcher: string; bundleId: string; home: string }): string {
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
  const r = launchctl(["print", `${domain()}/${LABEL}`]);
  if (!r.ok) return "not-loaded";
  return /state = running/.test(r.out) ? "running" : "loaded";
}

export function kickstart(): boolean {
  return launchctl(["kickstart", "-k", `${domain()}/${LABEL}`]).ok;
}

export function stopAgent(): boolean {
  const file = plistPath();
  return launchctl(["bootout", domain(), file]).ok;
}
