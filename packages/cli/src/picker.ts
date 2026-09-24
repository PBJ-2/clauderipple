// `clauderipple picker on|off` — put real model names into Claude Desktop's model picker.
//
// on:  1. trust our CA for this user: login keychain (macOS asks for the password; we never see it),
//         Cert:\CurrentUser\Root (Windows shows a confirmation dialog), or the NSS database Chromium
//         reads on Linux (~/.pki/nssdb; no prompt, no sudo)
//      2. point the app itself at the router: Config Library entry {egressProxyUrl} + _meta.json appliedId
//         (~/Library/Application Support/Claude-3p/configLibrary/ — the app keeps its managed-config
//         library under the "-3p" userData dir in BOTH deployment modes; read once at start, no MDM needed)
//      3. set picker.enabled in config.json
//      → the user restarts Claude Desktop.
// off: reverse all three.

import { execFileSync } from "node:child_process";
import crypto, { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CA_NAME = "ClaudeRipple local CA";

function appSupport(): string {
  // Verified in index.pre.js (AW()): userData + "-3p" regardless of 1P/3P mode. Not the plain "Claude" dir.
  // Windows keeps userData under LOCALAPPDATA, not APPDATA — confirmed on Windows 11 (2026-09-14),
  // where the app had already created %LOCALAPPDATA%\Claude-3p and read a configLibrary we put there.
  if (process.env.CLAUDE_APP_SUPPORT) return process.env.CLAUDE_APP_SUPPORT;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Claude-3p");
  }
  // Linux userData is $XDG_CONFIG_HOME/Claude, so the same "-3p" rule gives ~/.config/Claude-3p
  // (Claude Desktop 2.2553.13's bundle: `${app.getPath("userData")}-3p`, no Linux special case).
  if (process.platform === "linux") return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude-3p");
  return path.join(os.homedir(), "Library", "Application Support", "Claude-3p");
}

export function configLibraryDir(): string {
  return path.join(appSupport(), "configLibrary");
}

function loginKeychain(): string {
  return path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");
}

const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

// ---- Linux: the NSS database ------------------------------------------------------------
//
// Chromium on Linux takes locally added roots from the user's NSS database, not from /etc/ssl,
// and Claude Desktop is Chromium: a CA only in the system bundle would leave the app a blank page
// behind the router. certutil comes from libnss3-tools, which a desktop install does not always have.

/** Test-only override; production always uses the database Chromium reads. */
export function nssDb(): string {
  return process.env.CLAUDERIPPLE_NSS_DB ?? path.join(os.homedir(), ".pki", "nssdb");
}

/**
 * The fingerprint is part of the name so a CA from an earlier install is never taken for the
 * current one: trusting the old one would pass a check by name and still fail every handshake.
 */
export function nssNickname(caPem: string): string {
  return `${CA_NAME} ${new X509Certificate(fs.readFileSync(caPem)).fingerprint256.replace(/:/g, "").slice(0, 24)}`;
}

function certutil(args: string[]): string {
  return execFileSync("certutil", ["-d", `sql:${nssDb()}`, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Every ClaudeRipple CA in the database, including ones left by an earlier install. */
function nssOurNicknames(): string[] {
  let out: string;
  try {
    out = certutil(["-L"]);
  } catch {
    return [];
  }
  // One line per certificate: the nickname, then its trust flags ("C,,") as the last column.
  return out
    .split("\n")
    .map((line) => /^(.*\S)\s+\S*,\S*,\S*\s*$/.exec(line)?.[1])
    .filter((name): name is string => !!name && name.startsWith(CA_NAME));
}

export function nssTrusted(caPem: string): boolean {
  try {
    const name = nssNickname(caPem);
    const installed = new X509Certificate(certutil(["-L", "-n", name, "-a"]));
    if (installed.fingerprint256 !== new X509Certificate(fs.readFileSync(caPem)).fingerprint256) return false;
    // Validated as an SSL CA (-u L): that is the trust a handshake needs, not mere presence.
    certutil(["-V", "-n", name, "-u", "L"]);
    return true;
  } catch {
    return false;
  }
}

export function nssTrust(caPem: string): void {
  if (nssTrusted(caPem)) return;
  try {
    fs.mkdirSync(nssDb(), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(nssDb(), "cert9.db"))) certutil(["-N", "--empty-password"]);
    certutil(["-A", "-n", nssNickname(caPem), "-t", "C,,", "-i", caPem]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("certutil not found. Install it (Ubuntu/Debian: `sudo apt install libnss3-tools`, Fedora: `sudo dnf install nss-tools`), then run `clauderipple picker on` again");
    }
    throw e;
  }
}

/** Removes every ClaudeRipple CA, current or left over from an earlier install. */
export function nssUntrust(): boolean {
  const names = nssOurNicknames();
  for (const name of names) {
    try {
      certutil(["-D", "-n", name]);
    } catch {
      /* already gone */
    }
  }
  return names.length > 0;
}

/** Single-quoted PowerShell literal; the only escape inside one is a doubled quote. */
function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `interactive` drops -NonInteractive and lets a window show. Trusting (and untrusting) a root
 * certificate is a UI operation: Windows puts up its own confirmation dialog with the fingerprint,
 * and under -NonInteractive the call fails outright with "this operation cannot use the UI"
 * (observed 2026-09-14 — the dialog never appeared and picker mode stopped there).
 */
function powershell(script: string, opts: { stdio?: "ignore" | "inherit" | "pipe"; interactive?: boolean } = {}): string {
  const stdio = opts.stdio ?? "pipe";
  const args = ["-NoProfile", ...(opts.interactive ? [] : ["-NonInteractive"]), "-Command", script];
  return execFileSync("powershell.exe", args, {
    stdio: stdio === "pipe" ? ["ignore", "pipe", "pipe"] : stdio,
    windowsHide: !opts.interactive,
  })?.toString() ?? "";
}

/**
 * Every platform trusts the CA for the current user only — never machine-wide, which would need
 * administrator rights and would affect everyone on the box.
 *   macOS   : login keychain, and the OS asks for the account password.
 *   Windows : Cert:\CurrentUser\Root, and the OS shows a confirmation dialog with the fingerprint.
 *   Linux   : the user's NSS database (see nssDb), with no prompt at all.
 * Measured on Windows 11 (2026-09-14) as a standard user: the import succeeded with no UAC prompt,
 * only that dialog. Removal shows a second confirmation, so `picker off` prompts the user too.
 */
export function caTrusted(caPem: string): boolean {
  if (isLinux) return nssTrusted(caPem);
  try {
    if (isWindows) {
      const out = powershell(`@(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Subject -eq 'CN=${CA_NAME}' }).Count`);
      return Number(out.trim()) > 0;
    }
    execFileSync("security", ["find-certificate", "-c", CA_NAME, loginKeychain()], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Adds the CA as a trusted root for the current user. The OS shows its own prompt; we never see a password. */
export function trustCa(caPem: string): void {
  if (isLinux) return nssTrust(caPem);
  if (caTrusted(caPem)) return;
  if (isWindows) {
    // stdio inherit: the confirmation dialog is the OS's, but errors should reach the user's terminal.
    powershell(`Import-Certificate -FilePath ${ps(caPem)} -CertStoreLocation Cert:\\CurrentUser\\Root -ErrorAction Stop | Out-Null`, { stdio: "inherit", interactive: true });
    return;
  }
  execFileSync("security", ["add-trusted-cert", "-r", "trustRoot", "-k", loginKeychain(), caPem], { stdio: "inherit" });
}

export function untrustCa(caPem: string): boolean {
  if (isLinux) return nssUntrust();
  if (!caTrusted(caPem)) return false;
  if (isWindows) {
    try {
      powershell(
        `Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Subject -eq 'CN=${CA_NAME}' } | ForEach-Object { Remove-Item -Path $_.PSPath -Force }`,
        { stdio: "inherit", interactive: true },
      );
    } catch {
      /* the user may have declined the removal dialog */
    }
    return true;
  }
  try {
    execFileSync("security", ["remove-trusted-cert", caPem], { stdio: "inherit" });
  } catch {
    /* trust settings may already be gone */
  }
  try {
    execFileSync("security", ["delete-certificate", "-c", CA_NAME, loginKeychain()], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  return true;
}

type Meta = { appliedId?: string; clauderipple?: { ourId?: string; previousAppliedId?: string | null } } & Record<string, unknown>;

function readMeta(): Meta {
  try {
    return JSON.parse(fs.readFileSync(path.join(configLibraryDir(), "_meta.json"), "utf8")) as Meta;
  } catch {
    return {};
  }
}

const ENTRY_MARK = "clauderipple";

export function currentAppProxy(): { appliedId: string | null; egressProxyUrl: string | null; ours: boolean } {
  const meta = readMeta();
  const id = typeof meta.appliedId === "string" ? meta.appliedId : null;
  if (!id) return { appliedId: null, egressProxyUrl: null, ours: false };
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(configLibraryDir(), `${id}.json`), "utf8")) as Record<string, unknown>;
    return { appliedId: id, egressProxyUrl: typeof entry.egressProxyUrl === "string" ? entry.egressProxyUrl : null, ours: meta[ENTRY_MARK]?.ourId === id };
  } catch {
    return { appliedId: id, egressProxyUrl: null, ours: false };
  }
}

/** Writes our Config Library entry and applies it. Remembers what was applied before so `off` can restore it. */
export function applyAppProxy(proxyUrl: string): { id: string; replaced: string | null } {
  const dir = configLibraryDir();
  fs.mkdirSync(dir, { recursive: true });
  const meta = readMeta();
  const cur = currentAppProxy();
  if (cur.ours && cur.appliedId) {
    fs.writeFileSync(path.join(dir, `${cur.appliedId}.json`), JSON.stringify({ egressProxyUrl: proxyUrl }, null, 2) + "\n");
    return { id: cur.appliedId, replaced: null };
  }
  const id = crypto.randomUUID();
  // Only recognized keys in the entry: the app warns about and ignores unknown ones. Ownership lives in _meta.
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ egressProxyUrl: proxyUrl }, null, 2) + "\n");
  const previous = typeof meta.appliedId === "string" ? meta.appliedId : null;
  const next: Meta = { ...meta, appliedId: id, clauderipple: { ourId: id, previousAppliedId: previous } };
  fs.writeFileSync(path.join(dir, "_meta.json"), JSON.stringify(next, null, 2) + "\n");
  return { id, replaced: previous };
}

export function removeAppProxy(): boolean {
  const dir = configLibraryDir();
  const meta = readMeta();
  const cur = currentAppProxy();
  if (!cur.ours || !cur.appliedId) return false;
  const previous = meta.clauderipple?.previousAppliedId ?? null;
  const next: Meta = { ...meta };
  delete next.clauderipple;
  if (previous) next.appliedId = previous;
  else delete next.appliedId;
  fs.writeFileSync(path.join(dir, "_meta.json"), JSON.stringify(next, null, 2) + "\n");
  fs.rmSync(path.join(dir, `${cur.appliedId}.json`), { force: true });
  return true;
}
