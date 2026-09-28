// `clauderipple update`: bring this installation to the latest published version, the way it
// was installed.
//
// Until now an update meant running the install command again by hand, and the tray could not
// offer it (#39). What "again" means depends on how ClaudeRipple arrived:
//   * The install scripts put it under their own prefix (~/.clauderipple by default) with their own
//     command shims — a wrapper naming the Node they downloaded, and on Windows no .ps1. A plain
//     `npm install -g` would put npm's default shims back, which find no Node on a machine where
//     the script's Node is the only one. So a script install is updated by running its script.
//   * An `npm install -g` is updated by npm, into the same prefix.
//   * A packaged app or a source checkout is not updated from here.
// Either way `install` runs afterwards from the new files; it restarts a router still running
// the old version, which re-running the installer never did before.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsPowerShellEnv } from "./windows-powershell.ts";
import type { Runtime } from "./runtime.ts";

export const PACKAGE = "clauderipple";
const SCRIPT_BASE = "https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts";

export type InstallKind =
  | { kind: "script"; prefix: string }
  | { kind: "npm"; prefix: string }
  | { kind: "packaged" }
  | { kind: "checkout" }
  | { kind: "unknown"; root: string };

/** Numeric x.y.z comparison; a pre-release suffix is ignored. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split("-")[0]!.split(".").map((n) => Number(n) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** The default prefix of both install scripts, or the one they were told to use. */
export function scriptPrefix(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.CLAUDERIPPLE_PREFIX || path.join(home, ".clauderipple");
}

/**
 * How the running copy was installed, read from where its files are. A global npm package lives
 * at <prefix>/lib/node_modules/<name> on macOS and Linux and <prefix>\node_modules\<name> on Windows.
 */
export function installKind(rt: Pick<Runtime, "packaged" | "cli" | "repo">, opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): InstallKind {
  if (rt.packaged) return { kind: "packaged" };
  if (rt.cli.endsWith(".ts")) return { kind: "checkout" };
  const p = (opts.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
  const root = rt.repo;
  const modules = p.dirname(root);
  if (p.basename(modules) !== "node_modules") return { kind: "unknown", root };
  const parent = p.dirname(modules);
  const prefix = (opts.platform ?? process.platform) === "win32" ? parent : p.basename(parent) === "lib" ? p.dirname(parent) : null;
  if (!prefix) return { kind: "unknown", root };
  const same = (a: string, b: string) => (opts.platform ?? process.platform) === "win32" ? p.resolve(a).toLowerCase() === p.resolve(b).toLowerCase() : p.resolve(a) === p.resolve(b);
  return same(prefix, scriptPrefix(opts.env, opts.home)) ? { kind: "script", prefix } : { kind: "npm", prefix };
}

/** The version npm would install now. */
export async function latestVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`https://registry.npmjs.org/${PACKAGE}/latest`, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`npm registry answered HTTP ${res.status}`);
  const version = ((await res.json()) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error("npm registry answered without a version");
  return version;
}

/** The npm that came with the Node running us, as a script that same Node can run. */
function npmCli(): string | null {
  const candidates = [
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * Installs `spec` over this installation and runs `install` from the new files. Output goes to
 * our stdout as it happens, so the tray's dialog and a terminal show the installer's own lines.
 */
export function runUpdate(target: InstallKind & { kind: "script" | "npm" }, rt: Pick<Runtime, "node" | "env" | "cli">, spec: string): { ok: boolean; message: string } {
  const env = { ...process.env, CLAUDERIPPLE_PREFIX: target.prefix, CLAUDERIPPLE_PACKAGE: spec };
  if (target.kind === "script") {
    // A local path stands in for the published script when checking an update before release.
    const script = process.env.CLAUDERIPPLE_INSTALLER;
    const result = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script ? `& ${psQuote(script)}` : `irm ${SCRIPT_BASE}/install.ps1 | iex`], { env: { ...windowsPowerShellEnv(), ...env }, stdio: "inherit", windowsHide: true })
      : spawnSync("sh", ["-c", script ? `sh ${shQuote(script)}` : `curl -fsSL ${SCRIPT_BASE}/install.sh | sh`], { env, stdio: "inherit" });
    // The script ends by running `install` itself.
    return result.status === 0 ? { ok: true, message: "✓ updated" } : { ok: false, message: `the installer exited with ${result.status ?? result.signal}` };
  }
  const npm = npmCli();
  if (!npm) return { ok: false, message: `found no npm next to ${process.execPath}; update with: npm install -g ${PACKAGE}@latest` };
  const installed = spawnSync(process.execPath, [npm, "install", "--global", "--prefix", target.prefix, "--loglevel", "error", spec], { env, stdio: "inherit" });
  if (installed.status !== 0) return { ok: false, message: `npm could not install ${spec}` };
  const setup = spawnSync(rt.node, [rt.cli, "install"], { env: { ...process.env, ...rt.env }, stdio: "inherit" });
  return setup.status === 0 ? { ok: true, message: "✓ updated" } : { ok: false, message: "the new version is installed, but `clauderipple install` did not finish" };
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
