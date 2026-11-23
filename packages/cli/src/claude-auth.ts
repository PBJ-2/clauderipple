// `claude setup-token` invocation for a ClaudeRipple-owned, 0600 token file.
// The token is never echoed, logged, or returned from this module.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveClaudeAuthFile } from "../../router/src/providers/anthropic-token-file.ts";
import { removeAllClaudeAccounts } from "../../router/src/providers/anthropic-accounts.ts";
import { windowsDesktopRoots } from "../../remote/src/desktop-paths.ts";

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
  return cacheDirs(false);
}

/**
 * Every directory Claude Desktop may cache a CLI in, for removing stale entries from a PATH. Unlike
 * `desktopClaudeCodeDirs` it still lists them when several Desktop profiles make the choice
 * ambiguous: a stale entry is stale whichever profile it belonged to.
 */
export function desktopClaudeCacheRoots(): string[] {
  return cacheDirs(true);
}

function cacheDirs(allProfiles: boolean): string[] {
  // Linux: Electron's userData is $XDG_CONFIG_HOME/Claude (seen with Claude Desktop 2.2553.13 on
  // Ubuntu 24.04: ~/.config/Claude/claude-code/2.1.280/claude, a plain executable).
  if (process.platform === "linux") return [path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude", "claude-code")];
  if (!isWindows) return [path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code")];
  const roots = [
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  ];
  const desktops = windowsDesktopRoots(roots[0]);
  if (desktops.length > 1 && !allProfiles) return []; // Do not silently fall back to an unrelated legacy account.
  return [...desktops.map(root => path.join(root, "claude-code")), ...roots.map(root => path.join(root, "Claude", "claude-code"))];
}

/**
 * Whether `dir` is one of Claude Desktop's CLI cache roots or inside one. Those directories are
 * versioned (claude-code\2.1.304\<hash>) and the app deletes the old version after an update, so a
 * PATH entry that points into one goes stale. The platform picks the path rules (case and separators
 * on Windows); nothing is read from the disk.
 */
export function insideDesktopClaudeCache(dir: string, roots: readonly string[] = desktopClaudeCacheRoots(), platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  const entry = dir.trim().replace(/^"(.*)"$/, "$1");
  if (!entry || !p.isAbsolute(entry)) return false;
  return roots.some((root) => {
    const relative = p.relative(root, entry);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
  });
}

/** `pathValue` without the entries that point into Claude Desktop's CLI cache; the rest keep their order and spelling. */
export function withoutDesktopClaudeCache(pathValue: string, roots: readonly string[] = desktopClaudeCacheRoots(), platform: NodeJS.Platform = process.platform): string {
  const delimiter = platform === "win32" ? ";" : ":";
  return pathValue.split(delimiter).filter((entry) => !insideDesktopClaudeCache(entry, roots, platform)).join(delimiter);
}

/** Launcher inside one cached version directory. The macOS build nests an .app bundle. */
function versionBinaries(versionDir: string): string[] {
  if (process.platform === "linux") return [path.join(versionDir, "claude")];
  return isWindows
    ? BINARY_NAMES.map((name) => path.join(versionDir, name))
    : [path.join(versionDir, "claude.app", "Contents", "MacOS", "claude")];
}

/**
 * The launcher of one cached version: in the version directory itself, else one directory below it,
 * newest first. Claude Desktop 2.19675 on Windows caches CLI 2.1.286 as <version>\<12 hex>\claude.exe
 * beside .payload and .verified files, and moved the 2.1.284 it already had into the same shape, so
 * no version directory held a launcher directly any more (2026-10-02).
 */
function cachedBinary(versionDir: string): string | null {
  const flat = versionBinaries(versionDir).find((candidate) => fs.existsSync(candidate));
  if (flat) return flat;
  try {
    const subdirectories = fs.readdirSync(versionDir)
      .flatMap((entry) => {
        const directory = path.join(versionDir, entry);
        try {
          const stat = fs.statSync(directory);
          return stat.isDirectory() ? [{ directory, mtimeMs: stat.mtimeMs }] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const { directory } of subdirectories) {
      const binary = versionBinaries(directory).find((candidate) => fs.existsSync(candidate));
      if (binary) return binary;
    }
  } catch {
    // A missing or unreadable version directory has no usable binary.
  }
  return null;
}

export function latestDesktopClaude(): string | null {
  for (const directory of desktopClaudeCodeDirs()) {
    try {
      const versions = fs.readdirSync(directory)
        .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      for (const version of versions.reverse()) {
        const binary = cachedBinary(path.join(directory, version));
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

// ---- does the Claude Code CLI itself have a login? -------------------------------------------
//
// The Ripple Remote host drives Claude Code through the Agent SDK and passes no credential of its
// own, so every turn needs the CLI's own login. Where only the Claude desktop app is used, that
// login never exists and the CLI answers "Not logged in · Please run /login" (issue #71).
//
// This asks whether the login is there. It never reads, returns or logs a secret: the keychain
// item is looked up by name only (without -w, so the password is never fetched) and the
// credential file is only parsed for the shape of its content.
//
// The router reads the same two stores for its own `claude-code` provider
// (router/src/providers/anthropic.ts:41-74). That reader is not reused here: it returns the
// secret, and it parses a login as present only when it is also unexpired — this asks for
// presence, and for a home directory of the caller's choosing.

/** The keychain service the CLI keeps its OAuth grant in (the router names it the same way). */
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export type ClaudeCodeLogin = { ok: boolean; where: string };

export type ClaudeCodeLoginOptions = {
  env?: NodeJS.ProcessEnv;
  /** The home directory that holds `.claude`; defaults to this user's. */
  home?: string;
  platform?: NodeJS.Platform;
  /** macOS only: is the keychain item there? The default is a child process; tests inject one. */
  keychain?: () => Promise<boolean>;
};

/** Where the CLI keeps its credential file. */
export function claudeCredentialsFile(home = os.homedir()): string {
  return path.join(home, ".claude", ".credentials.json");
}

/**
 * True when the file holds a `claudeAiOauth` block: a Claude Code login of its own. A file that
 * only holds an `mcpOAuth` block is not one (that is what an MCP server's OAuth flow writes), and
 * an empty access token is a login that was emptied rather than one that is there.
 */
export function hasClaudeAiOauth(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: unknown };
    const oauth = parsed.claudeAiOauth;
    if (oauth === null || typeof oauth !== "object" || Array.isArray(oauth)) return false;
    const accessToken = (oauth as { accessToken?: unknown }).accessToken;
    return accessToken === undefined || (typeof accessToken === "string" && accessToken.length > 0);
  } catch {
    return false;
  }
}

/** macOS: the CLI's keychain item, looked up by name. The secret itself is never read. */
async function keychainHasCredentials(): Promise<boolean> {
  try {
    // Without -w the password is never fetched, so what comes back is the item's attributes only.
    await execFile("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], { timeout: 5_000, windowsHide: true });
    return true;
  } catch {
    // No item, or the keychain would not answer: there is no login to count.
    return false;
  }
}

/**
 * Whether the Claude Code CLI has a login of its own, and where it is. Presence only: no secret
 * is read, returned or logged. The environment is checked first because it costs nothing, and the
 * keychain probe (a child process) runs only when nothing cheaper answered.
 */
export async function claudeCodeLogin(options: ClaudeCodeLoginOptions = {}): Promise<ClaudeCodeLogin> {
  const env = options.env ?? process.env;
  const tokens: [string, string][] = [
    ["CLAUDE_CODE_OAUTH_TOKEN", "the CLAUDE_CODE_OAUTH_TOKEN environment variable"],
    ["ANTHROPIC_API_KEY", "the ANTHROPIC_API_KEY environment variable"],
    ["ANTHROPIC_AUTH_TOKEN", "the ANTHROPIC_AUTH_TOKEN environment variable"],
  ];
  for (const [key, where] of tokens) if (env[key]) return { ok: true, where };

  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const probe = options.keychain ?? keychainHasCredentials;
    if (await probe()) return { ok: true, where: `the macOS keychain (${KEYCHAIN_SERVICE})` };
  }

  const home = options.home ?? os.homedir();
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(claudeCredentialsFile(home), "utf8");
  } catch {
    raw = null;
  }
  if (hasClaudeAiOauth(raw)) return { ok: true, where: `${claudeCredentialsFile(home)} (claudeAiOauth)` };
  return { ok: false, where: "no Claude Code login: no token in the environment, no keychain item, no credential file" };
}

/** What a person whose Claude Code CLI has no login is told to do. */
export function claudeLoginHint(binary: string | null): string {
  return binary
    ? `Run the Claude Code CLI once and log in with /login: ${binary}`
    : "Run the Claude Code CLI once and log in with /login (install Claude Code if it is not on this computer)";
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
  return removeAllClaudeAccounts(home);
}
