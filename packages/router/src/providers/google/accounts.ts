// Google Antigravity (Cloud Code Assist) accounts: several Google logins can be signed in, and a
// turn moves to the next one when the account it is on runs out.
//
// Stored in <home>/google-accounts.json (0600, cross-process lock, atomic write), the same shape as
// the ChatGPT pool. We refresh these; a refresh token Google has invalidated marks only that account
// for a new sign-in. Identity is the account email plus the discovered Cloud Code Assist project id.
//
// Nothing here has been measured against a live Google endpoint — there is no subscription in this
// environment. The wire facts (token endpoint shape, `invalid_grant`, project discovery) are taken
// from the reference implementation opencodex as a behavioral spec (src/oauth/google-antigravity.ts)
// and marked (assumption) in docs/ARCHITECTURE.md §4d.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../log.ts";
import type { Credential } from "../../pool.ts";
import { redactErrorText } from "../../redact.ts";
import { withFileLock, writeJsonAtomic } from "../../locked-file.ts";
import type { ProviderModel } from "../../config.ts";
import { GOOGLE_OAUTH, type FetchLike } from "./antigravity.ts";

export type { FetchLike };

export type GoogleAccount = {
  /** Local opaque id. Never an upstream id. */
  id: string;
  accessToken: string;
  refreshToken?: string;
  /** The Cloud Code Assist project this account streams under; sent in the request envelope. */
  projectId: string;
  email?: string;
  /** epoch ms */
  expiresAt: number;
  label: string;
  createdAt: string;
  updatedAt: string;
  /** Set when Google rejected the refresh token. Cleared by a successful refresh or sign-in. */
  needsReauth?: boolean;
  /** Left out of rotation by the user. */
  paused?: boolean;
};

export type GoogleAccountSummary = {
  id: string;
  label: string;
  email?: string;
  projectId: string;
  expiresAt: number;
  needsReauth: boolean;
  paused: boolean;
};

type AccountsFile = { version: 1; accounts: GoogleAccount[] };

export function googleAccountsPath(home: string): string {
  return path.join(home, "google-accounts.json");
}

function validAccount(value: unknown): value is GoogleAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as Partial<GoogleAccount>;
  return typeof a.id === "string" && a.id.length > 0
    && typeof a.accessToken === "string" && a.accessToken.length > 0
    && (a.refreshToken === undefined || typeof a.refreshToken === "string")
    && typeof a.projectId === "string" && a.projectId.length > 0
    && typeof a.expiresAt === "number" && Number.isFinite(a.expiresAt)
    && typeof a.label === "string" && a.label.length > 0
    && typeof a.createdAt === "string" && typeof a.updatedAt === "string"
    && (a.email === undefined || typeof a.email === "string")
    && (a.needsReauth === undefined || typeof a.needsReauth === "boolean")
    && (a.paused === undefined || typeof a.paused === "boolean");
}

/** The file's accounts; [] when absent, null when unreadable (so a mutation refuses to overwrite it). */
function parseAccountsFile(home: string): GoogleAccount[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(googleAccountsPath(home), "utf8")) as Partial<AccountsFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.accounts) || !parsed.accounts.every(validAccount)) return null;
    const seen = new Set<string>();
    return parsed.accounts.filter((account) => !seen.has(account.id) && seen.add(account.id)).map((account) => ({ ...account }));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

export function readGoogleAccounts(home: string): GoogleAccount[] {
  return parseAccountsFile(home) ?? [];
}

function readForMutation(home: string): GoogleAccount[] {
  const accounts = parseAccountsFile(home);
  if (accounts === null) throw new Error("Google account store is unreadable; refusing to overwrite it");
  return accounts;
}

function write(home: string, accounts: GoogleAccount[]): void {
  writeJsonAtomic(googleAccountsPath(home), { version: 1, accounts } satisfies AccountsFile);
}

function mutate<T>(home: string, change: (accounts: GoogleAccount[]) => { accounts?: GoogleAccount[]; result: T }): T {
  return withFileLock(googleAccountsPath(home), () => {
    const { accounts, result } = change(readForMutation(home));
    if (accounts) write(home, accounts);
    return result;
  });
}

/** Same person: the email when both have one, else the same Cloud Code Assist project. */
function sameIdentity(a: { email?: string; projectId: string }, b: { email?: string; projectId: string }): boolean {
  if (a.email && b.email) return a.email.toLowerCase() === b.email.toLowerCase();
  return a.projectId === b.projectId;
}

export type GoogleGrant = {
  accessToken: string;
  refreshToken?: string;
  projectId: string;
  email?: string;
  /** epoch ms */
  expiresAt: number;
};

/** Add a signed-in account, or replace the same one after a re-login. */
export function saveGoogleAccount(home: string, grant: GoogleGrant, now = new Date().toISOString()): GoogleAccountSummary & { added: boolean } {
  return mutate(home, (accounts) => {
    const key = { ...(grant.email ? { email: grant.email } : {}), projectId: grant.projectId };
    const index = accounts.findIndex((account) => sameIdentity(account, key));
    const previous = index >= 0 ? accounts[index] : undefined;
    const account: GoogleAccount = {
      id: previous?.id ?? crypto.randomUUID(),
      accessToken: grant.accessToken,
      ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
      projectId: grant.projectId,
      ...(grant.email ?? previous?.email ? { email: grant.email ?? previous!.email! } : {}),
      expiresAt: grant.expiresAt,
      label: previous?.label ?? grant.email ?? `Google account ${accounts.length + 1}`,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(previous?.paused ? { paused: true } : {}),
    };
    const next = [...accounts];
    if (index >= 0) next[index] = account;
    else next.push(account);
    return { accounts: next, result: { ...summarize(account), added: index < 0 } };
  });
}

/** Compare-and-swap a refreshed grant: an older concurrent refresh must not overwrite a newer one. */
export function replaceGoogleTokens(home: string, id: string, expectedRefreshToken: string, grant: GoogleGrant, now = new Date().toISOString()): boolean {
  return mutate(home, (accounts) => {
    const index = accounts.findIndex((account) => account.id === id && account.refreshToken === expectedRefreshToken);
    if (index < 0) return { result: false };
    const previous = accounts[index]!;
    const next = [...accounts];
    next[index] = {
      ...previous,
      accessToken: grant.accessToken,
      ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
      projectId: grant.projectId || previous.projectId,
      ...(grant.email ? { email: grant.email } : {}),
      expiresAt: grant.expiresAt,
      updatedAt: now,
      needsReauth: false,
    };
    return { accounts: next, result: true };
  });
}

/** Mark only the token generation that failed; a sign-in that landed meanwhile wins. */
export function markGoogleNeedsReauth(home: string, id: string, expectedAccessToken: string): boolean {
  return mutate(home, (accounts) => {
    const index = accounts.findIndex((account) => account.id === id && account.accessToken === expectedAccessToken);
    if (index < 0) return { result: false };
    const next = [...accounts];
    next[index] = { ...next[index]!, needsReauth: true, updatedAt: new Date().toISOString() };
    return { accounts: next, result: true };
  });
}

export function updateGoogleAccount(home: string, id: string, change: { label?: string; paused?: boolean }): boolean {
  const label = change.label?.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
  if (change.label !== undefined && !label) return false;
  return mutate(home, (accounts) => {
    const index = accounts.findIndex((account) => account.id === id);
    if (index < 0) return { result: false };
    const next = [...accounts];
    const { paused: _paused, ...rest } = next[index]!;
    next[index] = { ...rest, ...(label ? { label } : {}), ...((change.paused ?? next[index]!.paused) ? { paused: true } : {}), updatedAt: new Date().toISOString() };
    return { accounts: next, result: true };
  });
}

export function removeGoogleAccount(home: string, id: string): boolean {
  return mutate(home, (accounts) => {
    const next = accounts.filter((account) => account.id !== id);
    return next.length === accounts.length ? { result: false } : { accounts: next, result: true };
  });
}

export function removeAllGoogleAccounts(home: string): number {
  return withFileLock(googleAccountsPath(home), () => {
    const count = readGoogleAccounts(home).length;
    fs.rmSync(googleAccountsPath(home), { force: true });
    return count;
  });
}

export function summarize(account: GoogleAccount): GoogleAccountSummary {
  return {
    id: account.id,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    projectId: account.projectId,
    expiresAt: account.expiresAt,
    needsReauth: account.needsReauth === true,
    paused: account.paused === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Runtime

/** Refresh this long before expiry. A turn never waits for it while the old token still works. */
const REFRESH_LEAD_MS = GOOGLE_OAUTH.refreshLeadMs;

export class GoogleRefreshError extends Error {
  readonly terminal: boolean;
  constructor(message: string, terminal: boolean) {
    super(message);
    this.terminal = terminal;
  }
}

/**
 * Whether a refused refresh means "sign in again". Only Google's `invalid_grant` counts; a 5xx whose
 * body happens to mention "expired" must not retire a working account. Prose is read only when the
 * body carries no `error` code at all and only for a 400/401.
 */
export function refreshRejectionIsTerminal(status: number, body: string): boolean {
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    if (typeof parsed.error === "string") code = parsed.error;
  } catch {
    /* not JSON */
  }
  if (code) return code === "invalid_grant";
  return (status === 400 || status === 401) && /\binvalid_grant\b/i.test(body);
}

/**
 * Exchange a refresh token for a new grant. Google's token endpoint takes a form-encoded body with
 * the client id and secret (this is a public installed-app client). Throws GoogleRefreshError.
 * Source: opencodex `postToken` / `refreshAntigravityToken`.
 */
export async function refreshGoogleGrant(refreshToken: string, previous: { projectId: string; email?: string }, fetchImpl: FetchLike = fetch, now = Date.now): Promise<GoogleGrant> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: GOOGLE_OAUTH.clientId, client_secret: GOOGLE_OAUTH.clientSecret, refresh_token: refreshToken }).toString(),
      signal: AbortSignal.timeout(GOOGLE_OAUTH.requestTimeoutMs),
    });
  } catch (error) {
    throw new GoogleRefreshError(`token refresh unreachable: ${(error as Error).message}`, false);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new GoogleRefreshError(`token refresh failed: HTTP ${res.status} ${redactErrorText(text, [refreshToken], 200)}`, refreshRejectionIsTerminal(res.status, text));
  let j: { access_token?: string; refresh_token?: string; expires_in?: number };
  try { j = JSON.parse(text) as typeof j; } catch { throw new GoogleRefreshError("token refresh answered with something other than JSON", false); }
  if (!j.access_token) throw new GoogleRefreshError("token refresh answered without an access token", false);
  const expiresIn = typeof j.expires_in === "number" && Number.isFinite(j.expires_in) && j.expires_in > 0 ? j.expires_in : 3600;
  // The project was settled at sign-in (an account cannot be stored without one), so a refresh does
  // not ask again: discovery can poll `onboardUser` for seconds, once an hour, for an answer it has.
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? refreshToken,
    projectId: previous.projectId,
    ...(previous.email ? { email: previous.email } : {}),
    expiresAt: now() + expiresIn * 1000,
  };
}

/** One refresh per token generation across every adapter in this process. */
const refreshing = new Map<string, Promise<void>>();

/** The credential one account presents, as the shared CredentialPool sees it. */
export type GoogleCredential = Credential & { ownerId: string; accessToken: string; projectId: string };

function credentialOf(ownerId: string, label: string, accessToken: string, projectId: string): GoogleCredential {
  // The runtime id is the account itself, not its token: a usage limit belongs to the account, and a
  // refresh must not bring a spent account back early.
  return { id: ownerId, ownerId, label, accessToken, projectId, headers: { authorization: `Bearer ${accessToken}` } };
}

export type GoogleAccountPoolOptions = {
  home: string;
  log: Pick<Logger, "info" | "warn">;
  fetch?: FetchLike;
  now?: () => number;
};

/**
 * The Antigravity accounts one google provider may use. Refreshes what is due without holding a turn
 * up, and can force a refresh when the backend refuses a token that has not expired yet.
 */
export class GoogleAccountPool {
  private readonly home: string;
  private readonly log: Pick<Logger, "info" | "warn">;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => number;

  constructor(options: GoogleAccountPoolOptions) {
    this.home = options.home;
    this.log = options.log;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
  }

  ownAccounts(): GoogleAccount[] {
    return readGoogleAccounts(this.home);
  }

  /** Accounts that could be sent right now, without network I/O. */
  peekCredentials(): GoogleCredential[] {
    const out: GoogleCredential[] = [];
    for (const account of this.ownAccounts()) {
      if (account.paused || account.needsReauth || this.now() >= account.expiresAt) continue;
      out.push(credentialOf(account.id, account.label, account.accessToken, account.projectId));
    }
    return out;
  }

  /** Accounts for one turn. Waits for a refresh only when nothing could be sent otherwise. */
  async credentials(): Promise<GoogleCredential[]> {
    const ready = this.peekCredentials();
    const due = this.refreshDue();
    if (ready.length > 0) {
      void due.catch((error: Error) => this.log.warn(`google account refresh task failed: ${error.message}`));
      return ready;
    }
    await due;
    return this.peekCredentials();
  }

  /** Refresh every stored account inside its lead window. */
  async refreshDue(): Promise<void> {
    const due = this.ownAccounts().filter((account) => !account.needsReauth && account.refreshToken && this.now() >= account.expiresAt - REFRESH_LEAD_MS);
    await Promise.all(due.map((account) => this.refresh(account)));
  }

  /** The project id for an owner, from the store. */
  projectFor(ownerId: string): string | undefined {
    return this.ownAccounts().find((account) => account.id === ownerId)?.projectId;
  }

  /**
   * The backend refused this account's token before it expired. One refresh; true when a new token
   * is in place.
   */
  async forceRefresh(ownerId: string): Promise<boolean> {
    const account = this.ownAccounts().find((candidate) => candidate.id === ownerId);
    if (!account?.refreshToken || account.needsReauth) return false;
    const before = account.accessToken;
    await this.refresh(account);
    const after = this.ownAccounts().find((candidate) => candidate.id === ownerId);
    return !!after && !after.needsReauth && after.accessToken !== before;
  }

  /** A token the backend refused after a refresh: that account needs a new sign-in. */
  reject(credential: GoogleCredential): void {
    if (markGoogleNeedsReauth(this.home, credential.ownerId, credential.accessToken)) {
      this.log.warn(`google account ${credential.ownerId.slice(0, 8)}: token refused; sign-in required`);
    }
  }

  private refresh(account: GoogleAccount): Promise<void> {
    const refreshToken = account.refreshToken!;
    const key = `${this.home}\0${account.id}\0${crypto.createHash("sha256").update(refreshToken).digest("hex")}`;
    const running = refreshing.get(key);
    if (running) return running;
    const task = refreshGoogleGrant(refreshToken, account, this.fetchImpl, this.now).then(
      (grant) => {
        if (replaceGoogleTokens(this.home, account.id, refreshToken, grant)) {
          this.log.info(`google account ${account.id.slice(0, 8)}: token refreshed, valid until ${new Date(grant.expiresAt).toISOString()}`);
        }
      },
      (error: Error) => {
        if (error instanceof GoogleRefreshError && error.terminal) {
          markGoogleNeedsReauth(this.home, account.id, account.accessToken);
          this.log.warn(`google account ${account.id.slice(0, 8)}: refresh rejected; sign-in required`);
        } else {
          this.log.warn(`google account ${account.id.slice(0, 8)}: refresh failed: ${redactErrorText(error.message, [account.accessToken, refreshToken], 300)}`);
        }
      },
    ).finally(() => refreshing.delete(key));
    refreshing.set(key, task);
    return task;
  }

  summaries(): GoogleAccountSummary[] {
    return this.ownAccounts().map(summarize);
  }

  /** Whether anything is signed in at all, expired or not — the "log in first" check. */
  signedIn(): boolean {
    return this.ownAccounts().length > 0;
  }
}
