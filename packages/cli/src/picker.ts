// `clauderipple picker on|off` — put real model names into Claude Desktop's model picker.
//
// on:  1. trust our CA in the login keychain (macOS asks the user for their password; we never see it)
//      2. point the app itself at the router: Config Library entry {egressProxyUrl} + _meta.json appliedId
//         (~/Library/Application Support/Claude-3p/configLibrary/ — the app keeps its managed-config
//         library under the "-3p" userData dir in BOTH deployment modes; read once at start, no MDM needed)
//      3. set picker.enabled in config.json
//      → the user restarts Claude Desktop.
// off: reverse all three.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CA_NAME = "ClaudeRipple local CA";

function appSupport(): string {
  // Verified in index.pre.js (AW()): userData + "-3p" regardless of 1P/3P mode. Not the plain "Claude" dir.
  return process.env.CLAUDE_APP_SUPPORT ?? path.join(os.homedir(), "Library", "Application Support", "Claude-3p");
}

export function configLibraryDir(): string {
  return path.join(appSupport(), "configLibrary");
}

function loginKeychain(): string {
  return path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");
}

export function caTrusted(): boolean {
  try {
    execFileSync("security", ["find-certificate", "-c", CA_NAME, loginKeychain()], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Adds the CA as a trusted root in the user's login keychain. macOS shows its own password dialog. */
export function trustCa(caPem: string): void {
  if (caTrusted()) return;
  execFileSync("security", ["add-trusted-cert", "-r", "trustRoot", "-k", loginKeychain(), caPem], { stdio: "inherit" });
}

export function untrustCa(caPem: string): boolean {
  if (!caTrusted()) return false;
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
