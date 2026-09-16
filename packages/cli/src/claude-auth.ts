// `claude setup-token` invocation for a ClaudeRipple-owned, 0600 token file.
// The token is never echoed, logged, or returned from this module.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeClaudeAuthFile, saveClaudeAuthFile } from "../../router/src/providers/anthropic-token-file.ts";

function isSetupToken(value: string): boolean {
  return /^sk-ant-oat01-[A-Za-z0-9._~-]{16,}$/.test(value);
}

export function parseSetupToken(stdout: string): string | null {
  const matches = stdout.match(/sk-ant-oat01-[A-Za-z0-9._~-]{16,}/g) ?? [];
  const unique = [...new Set(matches)];
  return unique.length === 1 && isSetupToken(unique[0]!) ? unique[0]! : null;
}

const isWindows = process.platform === "win32";

/** Launcher names on PATH. Windows has no extensionless one: npm writes .cmd, the app ships .exe. */
const BINARY_NAMES = isWindows ? ["claude.exe", "claude.cmd", "claude.bat"] : ["claude"];

/** Where Claude Desktop caches the CLI it downloads, per platform. */
export function desktopClaudeCodeDirs(): string[] {
  if (!isWindows) return [path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code")];
  const roots = [
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  ];
  return roots.map((root) => path.join(root, "Claude", "claude-code"));
}

/** Launcher inside one cached version directory. The macOS build nests an .app bundle. */
function versionBinaries(versionDir: string): string[] {
  return isWindows
    ? BINARY_NAMES.map((name) => path.join(versionDir, name))
    : [path.join(versionDir, "claude.app", "Contents", "MacOS", "claude")];
}

export function latestDesktopClaude(): string | null {
  for (const directory of desktopClaudeCodeDirs()) {
    try {
      const versions = fs.readdirSync(directory)
        .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      for (const version of versions.reverse()) {
        const binary = versionBinaries(path.join(directory, version)).find((candidate) => fs.existsSync(candidate));
        if (binary) return binary;
      }
    } catch {
      // Try the next root; a missing directory just means the app has not cached a CLI there.
    }
  }
  return null;
}

export function claudeBinary(pathValue = process.env.PATH): string | null {
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of BINARY_NAMES) {
      const binary = path.join(directory, name);
      try {
        // X_OK is not meaningful on Windows; existence of a named launcher is the real test.
        fs.accessSync(binary, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
        return binary;
      } catch {
        // Continue to the next name, then the bundled Desktop CLI.
      }
    }
  }
  return latestDesktopClaude();
}

function needsTerminal(): string {
  return (
    `Claude sign-in needs a terminal: run \`clauderipple claude-login\` in ${isWindows ? "PowerShell" : "Terminal"}. ` +
    "If Claude Code is already signed in on this computer, its login is reused automatically and this step is not needed."
  );
}

export function claudeLogin(home: string, options: { binary?: string; pathValue?: string; run?: (binary: string) => string; interactive?: boolean } = {}): void {
  const binary = options.binary ?? claudeBinary(options.pathValue);
  if (!binary) throw new Error("Claude Code CLI not found; install Claude Code or open Claude Desktop once");
  // `claude setup-token` is an interactive terminal flow (it opens the browser and waits for the
  // code to be pasted back). From the tray app or the GUI there is no terminal: it cannot succeed,
  // and left to run it waits for input that never comes (the tray has no timeout at all). Refuse
  // before spawning and say where it works (reported as a bare "setup-token failed", 2026-09-15).
  if (!options.run && !(options.interactive ?? process.stdin.isTTY)) throw new Error(needsTerminal());
  let stdout: string;
  try {
    // A .cmd/.bat launcher cannot be spawned directly on Windows; it needs a shell, and then the
    // path must carry its own quotes because the shell re-parses the whole command line.
    const viaShell = /\.(cmd|bat)$/i.test(binary);
    const spawn = (): string => viaShell
      ? execFileSync(`"${binary}"`, ["setup-token"], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], shell: true })
      : execFileSync(binary, ["setup-token"], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
    stdout = options.run ? options.run(binary) : spawn();
  } catch (error) {
    const detail = (error as { stderr?: string | Buffer }).stderr;
    const text = typeof detail === "string" ? detail : Buffer.isBuffer(detail) ? detail.toString("utf8") : "";
    if (/unknown command|unknown option|setup-token/i.test(text)) throw new Error("This Claude Code version does not support `claude setup-token`; update Claude Code and try again");
    const reason = text.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!(options.interactive ?? process.stdin.isTTY)) throw new Error(`${needsTerminal()}${reason ? ` (claude setup-token said: ${reason})` : ""}`);
    throw new Error(`Claude Code setup-token failed${reason ? `: ${reason}` : ""}`);
  }
  const token = parseSetupToken(stdout);
  if (!token) throw new Error("Claude Code did not return a recognizable setup token; no credential was saved");
  saveClaudeAuthFile(home, token);
}

export function claudeLogout(home: string): boolean {
  return removeClaudeAuthFile(home);
}
