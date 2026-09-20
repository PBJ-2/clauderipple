// ClaudeRipple-owned pool of Claude subscription OAuth accounts.
//
// Secrets live only in <home>/claude-accounts.json (0600). The upstream account UUID is never
// persisted or returned: a one-way hash is enough to replace the same human account on re-login.
// The old single-account claude-auth.json is imported atomically on the first pool write so existing
// installs keep working without keeping two mutable copies of one refresh token.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lockSync } from "proper-lockfile";
import { readClaudeAuthFile, removeClaudeAuthFile } from "./anthropic-token-file.ts";

export type ClaudeOAuthAccountGrant = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Upstream identity used only to derive subjectHash; never written verbatim. */
  accountId?: string;
  email?: string;
};

export type ClaudeOAuthAccount = {
  /** Local opaque id. Safe to use in routes and admin actions; it is not an upstream account id. */
  id: string;
  token: string;
  refreshToken: string;
  expiresAt: number;
  createdAt: string;
  updatedAt: string;
  label: string;
  /** sha256(upstream account UUID), used only to replace a re-login instead of duplicating it. */
  subjectHash?: string;
  email?: string;
  needsReauth?: boolean;
};

type ClaudeAccountsFile = { version: 1; accounts: ClaudeOAuthAccount[] };

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 100;
const LOCK_TIMEOUT_MS = 2_000;

function withAccountLock<T>(home: string, mutate: () => T): T {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let release: () => void;
  for (;;) {
    try {
      release = lockSync(claudeAccountsPath(home), {
        realpath: false,
        stale: LOCK_STALE_MS,
        update: 10_000,
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    return mutate();
  } finally {
    release!();
  }
}

export type ClaudeAccountSummary = {
  id: string;
  label: string;
  email?: string;
  expiresAt: number;
  needsReauth: boolean;
};

export function claudeAccountsPath(home: string): string {
  return path.join(home, "claude-accounts.json");
}

function validAccount(value: unknown): value is ClaudeOAuthAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as Partial<ClaudeOAuthAccount>;
  return typeof a.id === "string" && a.id.length > 0
    && typeof a.token === "string" && a.token.length > 0
    && typeof a.refreshToken === "string" && a.refreshToken.length > 0
    && typeof a.expiresAt === "number" && Number.isFinite(a.expiresAt)
    && typeof a.createdAt === "string" && typeof a.updatedAt === "string"
    && typeof a.label === "string" && a.label.length > 0
    && (a.subjectHash === undefined || (typeof a.subjectHash === "string" && /^[0-9a-f]{64}$/.test(a.subjectHash)))
    && (a.email === undefined || typeof a.email === "string")
    && (a.needsReauth === undefined || typeof a.needsReauth === "boolean");
}

function parseClaudeAccountsFile(home: string): ClaudeOAuthAccount[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeAccountsPath(home), "utf8")) as Partial<ClaudeAccountsFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.accounts) || !parsed.accounts.every(validAccount)) return null;
    const seen = new Set<string>();
    return parsed.accounts.filter((account) => !seen.has(account.id) && seen.add(account.id)).map((account) => ({ ...account }));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

/** Read only the multi-account file. Malformed secret storage fails closed as an empty pool. */
export function readClaudeAccountsFile(home: string): ClaudeOAuthAccount[] {
  return parseClaudeAccountsFile(home) ?? [];
}

/**
 * Read the pool plus a virtual import of the old single OAuth file. The legacy file is left alone on
 * reads; the next mutation writes it into the pool first and only then removes the old copy.
 */
function withLegacyOAuthAccount(home: string, accounts: ClaudeOAuthAccount[]): ClaudeOAuthAccount[] {
  const legacy = readClaudeAuthFile(home);
  if (legacy?.source !== "oauth") return accounts;
  // If a previous migration wrote the legacy account but crashed before unlinking, do not duplicate
  // it. The refresh token may already have rotated in the new pool, so the durable local id wins.
  if (accounts.some((account) => account.id === "legacy" || account.refreshToken === legacy.refreshToken)) return accounts;
  return [
    ...accounts,
    {
      id: "legacy",
      token: legacy.token,
      refreshToken: legacy.refreshToken,
      expiresAt: legacy.expiresAt,
      createdAt: legacy.createdAt,
      updatedAt: legacy.createdAt,
      label: "Claude account",
    },
  ];
}

export function readClaudeOAuthAccounts(home: string): ClaudeOAuthAccount[] {
  const accounts = parseClaudeAccountsFile(home);
  if (accounts === null) return [];
  // Once a valid pool file exists it is the single source of truth. A retained legacy file (for
  // example where directory fsync is unavailable) must not resurrect an account removed from it.
  return fs.existsSync(claudeAccountsPath(home)) ? accounts : withLegacyOAuthAccount(home, accounts);
}

function readClaudeOAuthAccountsForMutation(home: string): ClaudeOAuthAccount[] {
  const accounts = parseClaudeAccountsFile(home);
  if (accounts === null) throw new Error("Claude account store is unreadable; refusing to overwrite it");
  return fs.existsSync(claudeAccountsPath(home)) ? accounts : withLegacyOAuthAccount(home, accounts);
}

/** Windows has no directory fsync, so a flushed file plus successful atomic rename completes migration there. */
export function legacyMigrationDurable(directoryDurable: boolean, platform = process.platform): boolean {
  return directoryDurable || platform === "win32";
}

function writeClaudeAccountsFile(home: string, accounts: ClaudeOAuthAccount[]): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = claudeAccountsPath(home);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, accounts } satisfies ClaudeAccountsFile, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    // Persist the directory entry where the filesystem supports it. POSIX keeps the legacy refresh
    // token unless that succeeds; Windows has no directory fsync, so the flushed file + rename is its
    // durability boundary and must complete migration rather than resurrect a removed legacy account.
    let directoryDurable = false;
    try {
      const dir = fs.openSync(home, "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      directoryDurable = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
    }
    const legacy = readClaudeAuthFile(home);
    if (legacyMigrationDurable(directoryDurable) && legacy?.source === "oauth") removeClaudeAuthFile(home);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function subjectHash(accountId: string | undefined): string | undefined {
  return accountId ? crypto.createHash("sha256").update(accountId).digest("hex") : undefined;
}

function defaultLabel(accounts: readonly ClaudeOAuthAccount[], email?: string): string {
  if (email) return email;
  return `Claude account ${accounts.length + 1}`;
}

/** Add a distinct account, or atomically replace the same upstream account after re-login. */
export function saveClaudeOAuthAccount(home: string, grant: ClaudeOAuthAccountGrant, now = new Date().toISOString()): ClaudeAccountSummary {
  return withAccountLock(home, () => {
    const accounts = readClaudeOAuthAccountsForMutation(home);
    const hash = subjectHash(grant.accountId);
    const index = hash ? accounts.findIndex((account) => account.subjectHash === hash) : -1;
    const previous = index >= 0 ? accounts[index] : undefined;
    const account: ClaudeOAuthAccount = {
      id: previous?.id ?? crypto.randomUUID(),
      token: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      label: previous?.label ?? defaultLabel(accounts, grant.email),
      ...(hash ? { subjectHash: hash } : previous?.subjectHash ? { subjectHash: previous.subjectHash } : {}),
      ...(grant.email ? { email: grant.email } : previous?.email ? { email: previous.email } : {}),
    };
    if (index >= 0) accounts[index] = account;
    else accounts.push(account);
    writeClaudeAccountsFile(home, accounts);
    return summarize(account);
  });
}

/** Compare-and-swap a refreshed grant so an older concurrent refresh cannot overwrite a newer one. */
export function replaceClaudeOAuthAccount(
  home: string,
  id: string,
  expectedRefreshToken: string,
  grant: ClaudeOAuthAccountGrant,
  now = new Date().toISOString(),
): boolean {
  return withAccountLock(home, () => {
    const accounts = readClaudeOAuthAccountsForMutation(home);
    const index = accounts.findIndex((account) => account.id === id && account.refreshToken === expectedRefreshToken);
    if (index < 0) return false;
    const previous = accounts[index]!;
    accounts[index] = {
      ...previous,
      token: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
      updatedAt: now,
      needsReauth: false,
      ...(grant.email ? { email: grant.email } : {}),
    };
    writeClaudeAccountsFile(home, accounts);
    return true;
  });
}

/** Mark only the generation that actually failed; a simultaneous successful login wins. */
export function markClaudeAccountNeedsReauth(home: string, id: string, expectedRefreshToken: string): boolean {
  return withAccountLock(home, () => {
    const accounts = readClaudeOAuthAccountsForMutation(home);
    const index = accounts.findIndex((account) => account.id === id && account.refreshToken === expectedRefreshToken);
    if (index < 0) return false;
    accounts[index] = { ...accounts[index]!, needsReauth: true, updatedAt: new Date().toISOString() };
    writeClaudeAccountsFile(home, accounts);
    return true;
  });
}

export function renameClaudeAccount(home: string, id: string, label: string): boolean {
  const clean = label.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
  if (!clean) return false;
  return withAccountLock(home, () => {
    const accounts = readClaudeOAuthAccountsForMutation(home);
    const index = accounts.findIndex((account) => account.id === id);
    if (index < 0) return false;
    accounts[index] = { ...accounts[index]!, label: clean, updatedAt: new Date().toISOString() };
    writeClaudeAccountsFile(home, accounts);
    return true;
  });
}

export function removeClaudeAccount(home: string, id: string): boolean {
  return withAccountLock(home, () => {
    const accounts = readClaudeOAuthAccountsForMutation(home);
    const next = accounts.filter((account) => account.id !== id);
    if (next.length === accounts.length) return false;
    writeClaudeAccountsFile(home, next);
    return true;
  });
}

export function removeAllClaudeAccounts(home: string): boolean {
  return withAccountLock(home, () => {
    let removed = removeClaudeAuthFile(home);
    try {
      fs.unlinkSync(claudeAccountsPath(home));
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return removed;
  });
}

export function summarize(account: ClaudeOAuthAccount): ClaudeAccountSummary {
  return {
    id: account.id,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    expiresAt: account.expiresAt,
    needsReauth: account.needsReauth === true,
  };
}

export function listClaudeAccounts(home: string): ClaudeAccountSummary[] {
  return readClaudeOAuthAccounts(home).map(summarize);
}
