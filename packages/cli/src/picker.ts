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
import { execBounded } from "./bounded-exec.ts";
import { windowsPowerShellEnv } from "./windows-powershell.ts";
import { homeDir } from "../../router/src/config.ts";
import { withFileLock, writeJsonAtomic } from "../../router/src/locked-file.ts";
import { normalizeHome, sameHome } from "./ownership.ts";
import { readOwners } from "./owners.ts";
import { settingsPath } from "./settings.ts";
import { verifiedDesktopService, type DesktopServiceDeps } from "./desktop-service.ts";

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
function nssOurNicknames(run: (args: string[]) => string = certutil): string[] {
  const out = run(["-L"]);
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

/** Removes every ClaudeRipple CA, current or left over from an earlier install, or with `caPem` only that one. */
export function nssUntrust(caPem?: string): boolean {
  const names = caPem ? nssOurNicknames().filter(name => name === nssNickname(caPem)) : nssOurNicknames();
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
    env: windowsPowerShellEnv(),
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
export function caTrusted(caPem: string, opts: { platform?: NodeJS.Platform; run?: (command: string, args: string[]) => string } = {}): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform === "linux") return nssTrusted(caPem);
  const run = opts.run ?? ((command, args) => execFileSync(command, args, { env: windowsPowerShellEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString());
  try {
    const fingerprint = new X509Certificate(fs.readFileSync(caPem)).fingerprint.replace(/:/g, "");
    if (platform === "win32") {
      const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${fingerprint}' }).Count`]);
      return Number(out.trim()) > 0;
    }
    // User trust settings are keyed by the certificate's SHA-1, not its non-unique subject.
    // Presence alone is not trust: verify the current certificate against that keychain too.
    const settings = run("security", ["trust-settings-export", "/dev/stdout"]);
    if (!settings.toUpperCase().includes(`<KEY>${fingerprint}</KEY>`)) return false;
    // Trust settings outlive their certificate, and verify-cert passes on the file and them alone:
    // on 2026-10-25 a CA removed from the keychain still read as trusted, `picker on` skipped adding
    // it, and the app refused every claude.ai page (ERR_CERT_AUTHORITY_INVALID). The app needs the
    // certificate itself in the keychain.
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(new X509Certificate(fs.readFileSync(caPem)).subject)?.[1] ?? "";
    const held = run("security", ["find-certificate", "-a", "-Z", "-c", cn, loginKeychain()]);
    if (!held.toUpperCase().replace(/\s+/g, " ").includes(`SHA-1 HASH: ${fingerprint}`)) return false;
    run("security", ["verify-cert", "-c", caPem, "-p", "basic", "-k", loginKeychain()]);
    return true;
  } catch {
    return false;
  }
}

/**
 * `caTrusted` for a process that must not stop: the router's status route asks it in the background
 * (#159, a synchronous PowerShell on the router's event loop froze the proxy with it). Every child
 * runs under a deadline that ends its whole tree. Answers true or false as `caTrusted` does, and
 * null when a check ran out of time: that says nothing about the certificate, so a caller must not
 * report it as "not trusted".
 */
export async function caTrustedAsync(caPem: string, opts: { platform?: NodeJS.Platform; run?: (command: string, args: string[]) => Promise<string>; timeoutMs?: number } = {}): Promise<boolean | null> {
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const run = opts.run ?? ((command, args) => execBounded(command, args, { timeoutMs, env: windowsPowerShellEnv(), windowsHide: true }));
  const timedOut = (error: unknown): boolean => (error as { timedOut?: boolean } | null)?.timedOut === true;
  try {
    const cert = new X509Certificate(fs.readFileSync(caPem));
    const fingerprint = cert.fingerprint.replace(/:/g, "");
    if (platform === "linux") {
      const name = nssNickname(caPem);
      const certutilRun = (args: string[]): Promise<string> => run("certutil", ["-d", `sql:${nssDb()}`, ...args]);
      const installed = new X509Certificate(await certutilRun(["-L", "-n", name, "-a"]));
      if (installed.fingerprint256 !== cert.fingerprint256) return false;
      await certutilRun(["-V", "-n", name, "-u", "L"]);
      return true;
    }
    if (platform === "win32") {
      const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${fingerprint}' }).Count`]);
      return Number(out.trim()) > 0;
    }
    // The same three checks, in the same order, as caTrusted's macOS branch.
    const settings = await run("security", ["trust-settings-export", "/dev/stdout"]);
    if (!settings.toUpperCase().includes(`<KEY>${fingerprint}</KEY>`)) return false;
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1] ?? "";
    const held = await run("security", ["find-certificate", "-a", "-Z", "-c", cn, loginKeychain()]);
    if (!held.toUpperCase().replace(/\s+/g, " ").includes(`SHA-1 HASH: ${fingerprint}`)) return false;
    await run("security", ["verify-cert", "-c", caPem, "-p", "basic", "-k", loginKeychain()]);
    return true;
  } catch (error) {
    return timedOut(error) ? null : false;
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

/**
 * What a CA removal achieved: `absent` means there was nothing trusted to remove (a purge may
 * proceed), `failed` means the store could not be read or the user declined.
 */
export type CaRemoval = "removed" | "absent" | "missing" | "failed";

/** Missing local identity is not evidence that the certificate is absent from the trust store. */
function caFingerprint(caPem: string): { fingerprint: string } | { error: "missing" | "failed" } {
  try {
    return { fingerprint: new X509Certificate(fs.readFileSync(caPem)).fingerprint.replace(/:/g, "").toUpperCase() };
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed" };
  }
}

/** Whether Windows' CurrentUser Root store holds the certificate; null when that cannot be read. */
type CaCommand = (command: string, args: string[]) => string;
const runCaCommand: CaCommand = (command, args) => execFileSync(command, args, { env: windowsPowerShellEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).toString();

function windowsHasCa(fingerprint: string | null, byName: boolean, run: CaCommand = runCaCommand): boolean | null {
  const match = byName ? `$_.Subject -eq 'CN=${CA_NAME}'` : fingerprint ? `$_.Thumbprint -eq '${fingerprint}'` : null;
  if (!match) return false;
  try {
    const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { ${match} }).Count`]);
    const count = Number(out.trim());
    return Number.isSafeInteger(count) ? count > 0 : null;
  } catch {
    return null;
  }
}

/**
 * Whether the login keychain holds the certificate (trusted or not): true, false, or null when that
 * cannot be determined. Read-only — `security find-certificate` never prompts for a password.
 */
function keychainHasCa(fingerprint: string | null, byName: boolean, run: CaCommand = runCaCommand): boolean | null {
  const args = byName
    ? ["find-certificate", "-c", CA_NAME, loginKeychain()]
    : fingerprint
      ? ["find-certificate", "-a", "-Z", loginKeychain()]
      : null;
  if (!args) return false;
  try {
    const out = run("security", args);
    return byName || out.toUpperCase().includes(`SHA-1 HASH: ${fingerprint}`);
  } catch (error) {
    // errSecItemNotFound is the only failure that means "not there"; anything else is unknown.
    return (error as { status?: number }).status === 44 ? false : null;
  }
}

/**
 * `sweep` also removes CAs an earlier install of the same home left behind, found by name. Without
 * it only this `caPem` goes, by fingerprint: a second install (a release check under its own
 * CLAUDERIPPLE_HOME) shares the user's trust store with the real one, whose CA has the same name.
 * A certificate that is not there at all is `absent`, not a failure: an install that already lost
 * its CA must still be able to purge (D3, 2026-10-25).
 */
export function untrustCa(caPem: string, opts: { sweep?: boolean; platform?: NodeJS.Platform; run?: CaCommand; missingCaTrustRemoved?: boolean } = {}): CaRemoval {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCaCommand;
  const identity = caFingerprint(caPem);
  if ("error" in identity) {
    // Explicit recovery only: the user has checked the store and removed this installation's CA.
    // Never bypass permission, I/O or parsing failures, and never sweep by a non-unique name.
    return identity.error === "missing" && opts.missingCaTrustRemoved === true ? "absent" : identity.error;
  }
  const { fingerprint } = identity;
  if (platform === "linux") {
    try {
      const wanted = nssNickname(caPem);
      const nssRun = (args: string[]) => run("certutil", ["-d", `sql:${nssDb()}`, ...args]);
      const ours = () => nssOurNicknames(nssRun).filter(name => name === wanted);
      const names = ours();
      if (names.length === 0) return "absent";
      for (const name of names) nssRun(["-D", "-n", name]);
      return ours().length === 0 ? "removed" : "failed";
    } catch {
      return "failed";
    }
  }
  const sweep = opts.sweep === true;
  if (platform === "win32") {
    const before = windowsHasCa(fingerprint, sweep, run);
    if (before === false) return "absent";
    if (before === null) return "failed";
    const match = sweep ? `$_.Subject -eq 'CN=${CA_NAME}'` : `$_.Thumbprint -eq '${fingerprint}'`;
    try {
      const script = `Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { ${match} } | ForEach-Object { Remove-Item -Path $_.PSPath -Force }`;
      if (opts.run) run("powershell.exe", ["-NoProfile", "-Command", script]);
      else powershell(script, { stdio: "inherit", interactive: true });
    } catch {
      return "failed"; // The user may have declined; removal was not confirmed.
    }
    return windowsHasCa(fingerprint, sweep, run) === false ? "removed" : "failed";
  }
  // macOS: an untrusted copy can still be in the keychain, so presence and trust are asked apart.
  const present = sweep ? keychainHasCa(fingerprint, true, run) : keychainHasCa(fingerprint, false, run);
  if (present === false) return "absent";
  if (present === null) return "failed";
  try {
    const trust = run("security", ["trust-settings-export", "/dev/stdout"]);
    if (trust.toUpperCase().includes(`<KEY>${fingerprint}</KEY>`)) run("security", ["remove-trusted-cert", caPem]);
  } catch {
    return "failed";
  }
  try {
    run("security", ["delete-certificate", ...(sweep ? ["-c", CA_NAME] : ["-Z", fingerprint]), loginKeychain()]);
    return "removed";
  } catch {
    // Nothing left to delete means the removal is complete; a leftover is not confirmed.
    return (sweep ? keychainHasCa(fingerprint, true, run) : keychainHasCa(fingerprint, false, run)) === false ? "removed" : "failed";
  }
}

type Meta = { appliedId?: string; clauderipple?: { ourId?: string; previousAppliedId?: string | null; installationHome?: string } } & Record<string, unknown>;

function readMeta(): Meta {
  let text: string;
  try {
    text = fs.readFileSync(path.join(configLibraryDir(), "_meta.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Desktop proxy metadata is invalid; left untouched");
  return parsed as Meta;
}

const ENTRY_MARK = "clauderipple";

export function currentAppProxy(): { appliedId: string | null; egressProxyUrl: string | null; ours: boolean; installationHome?: string | undefined; previousAppliedId?: string | null | undefined } {
  const meta = readMeta();
  const id = typeof meta.appliedId === "string" ? meta.appliedId : null;
  if (!id) return { appliedId: null, egressProxyUrl: null, ours: false };
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(configLibraryDir(), `${id}.json`), "utf8")) as Record<string, unknown>;
    return { appliedId: id, egressProxyUrl: typeof entry.egressProxyUrl === "string" ? entry.egressProxyUrl : null, ours: meta[ENTRY_MARK]?.ourId === id, installationHome: meta.clauderipple?.installationHome, previousAppliedId: meta.clauderipple?.previousAppliedId };
  } catch (error) {
    throw new Error(`Desktop proxy entry ${id} could not be read; left untouched`, { cause: error });
  }
}

/**
 * Whose applied Config Library entry this is. A URL and a product marker identify neither the
 * installation that wrote it nor its home: two installations can use the same port. Legacy entries
 * without a home remain unknown, including on apply, rather than silently acquiring a new owner.
 */
export function appProxyOwner(current: ReturnType<typeof currentAppProxy>, home: string, proxyUrl?: string): "ours" | "other" | "unknown" {
  if (!current.ours) return "other";
  if (current.installationHome !== undefined) return sameHome(current.installationHome, home) ? "ours" : "other";
  return "unknown";
}

/** A legacy entry needs both a verified service and an unambiguous single-installation history. */
export function migrateLegacyAppProxy(proxyUrl: string, installationHome: string, deps: DesktopServiceDeps = {}): boolean {
  return withFileLock(path.join(configLibraryDir(), "_meta.json"), () => migrateLegacyAppProxyLocked(proxyUrl, installationHome, deps));
}

function migrateLegacyAppProxyLocked(proxyUrl: string, installationHome: string, deps: DesktopServiceDeps): boolean {
  const cur = currentAppProxy();
  if (!cur.ours || cur.installationHome !== undefined || cur.egressProxyUrl !== proxyUrl) return false;
  // A live service proves who uses the port now, not who wrote this historical entry. Every
  // recorded home counts, even when absent from disk; default/configured homes count when present.
  const owners = readOwners(settingsPath());
  const homes = [...Object.keys(owners.store.homes), ...[path.join(os.homedir(), ".clauderipple"), homeDir()].filter(home => fs.existsSync(home))];
  if (owners.error || homes.some(home => !sameHome(home, installationHome))) {
    throw new Error("구형 Claude Desktop 프록시를 어느 설치에서 설정했는지 확인할 수 없어 보존했습니다. 다른 ClaudeRipple 설치와 설치 소유권 기록을 확인한 뒤 프록시 설정을 직접 해제해 주세요.");
  }
  if (!verifiedDesktopService(installationHome, proxyUrl, deps)) return false;
  const meta = readMeta();
  writeJsonAtomic(path.join(configLibraryDir(), "_meta.json"), { ...meta, clauderipple: { ...meta.clauderipple, installationHome: normalizeHome(installationHome) } });
  return true;
}

/** Writes our Config Library entry and applies it. Remembers what was applied before so `off` can restore it. */
export function applyAppProxy(proxyUrl: string, installationHome = homeDir(), expected?: ReturnType<typeof currentAppProxy>, deps: DesktopServiceDeps = {}): { id: string; replaced: string | null } {
  return withFileLock(path.join(configLibraryDir(), "_meta.json"), () => applyAppProxyLocked(proxyUrl, installationHome, expected, deps));
}

function applyAppProxyLocked(proxyUrl: string, installationHome: string, expected: ReturnType<typeof currentAppProxy> | undefined, deps: DesktopServiceDeps): { id: string; replaced: string | null } {
  const dir = configLibraryDir();
  fs.mkdirSync(dir, { recursive: true });
  const meta = readMeta();
  const cur = currentAppProxy();
  if (expected && JSON.stringify(cur) !== JSON.stringify(expected)) throw new Error("Desktop proxy changed before restoration; left untouched");
  if (cur.ours && cur.appliedId) {
    let owner = appProxyOwner(cur, installationHome, proxyUrl);
    if (owner === "unknown" && migrateLegacyAppProxyLocked(proxyUrl, installationHome, deps)) owner = "ours";
    if (owner === "other") throw new Error("Desktop proxy ownership is unknown or belongs to another installation; left untouched");
    if (owner === "unknown") throw new Error("Desktop proxy ownership is unknown; left untouched");
    writeJsonAtomic(path.join(dir, `${cur.appliedId}.json`), { egressProxyUrl: proxyUrl });
    // Take over an entry an older version applied without recording a home: from here on its
    // ownership is evidenced like any other (D3).
    if (cur.installationHome === undefined || !sameHome(cur.installationHome, installationHome)) {
      const next: Meta = { ...meta, clauderipple: { ...meta.clauderipple, ourId: cur.appliedId, installationHome: normalizeHome(installationHome) } };
      writeJsonAtomic(path.join(dir, "_meta.json"), next);
    }
    return { id: cur.appliedId, replaced: null };
  }
  const id = crypto.randomUUID();
  // Only recognized keys in the entry: the app warns about and ignores unknown ones. Ownership lives in _meta.
  writeJsonAtomic(path.join(dir, `${id}.json`), { egressProxyUrl: proxyUrl });
  const previous = typeof meta.appliedId === "string" ? meta.appliedId : null;
  const next: Meta = { ...meta, appliedId: id, clauderipple: { ourId: id, previousAppliedId: previous, installationHome: normalizeHome(installationHome) } };
  writeJsonAtomic(path.join(dir, "_meta.json"), next);
  return { id, replaced: previous };
}

/** With `proxyUrl`, only an entry pointing there goes: another install's entry is not ours to remove. */
export function removeAppProxy(proxyUrl?: string, installationHome = homeDir()): boolean {
  return withFileLock(path.join(configLibraryDir(), "_meta.json"), () => removeAppProxyLocked(proxyUrl, installationHome));
}

function removeAppProxyLocked(proxyUrl: string | undefined, installationHome: string): boolean {
  const dir = configLibraryDir();
  const meta = readMeta();
  const cur = currentAppProxy();
  if (!cur.appliedId || appProxyOwner(cur, installationHome, proxyUrl) !== "ours") return false;
  if (proxyUrl !== undefined && cur.egressProxyUrl !== proxyUrl) return false;
  const previous = meta.clauderipple?.previousAppliedId ?? null;
  const next: Meta = { ...meta };
  delete next.clauderipple;
  if (previous) next.appliedId = previous;
  else delete next.appliedId;
  writeJsonAtomic(path.join(dir, "_meta.json"), next);
  fs.rmSync(path.join(dir, `${cur.appliedId}.json`), { force: true });
  return true;
}
