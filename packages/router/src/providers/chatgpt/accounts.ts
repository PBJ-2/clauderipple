// ChatGPT subscription accounts: several can be signed in, and a turn moves to the next one when
// the account it is on runs out.
//
// Two kinds of account:
//   own     signed in through `clauderipple login`, stored in <home>/chatgpt-accounts.json (0600).
//           We refresh these. The old single-login file <home>/chatgpt-auth.json is imported on the
//           first write, the same way the Claude store retires its single-account file.
//   codex   the Codex CLI's own login in ~/.codex/auth.json. Read-only: its refresh token rotates,
//           and refreshing someone else's grant would sign Codex out. Takes part last.
//
// Identity is the ChatGPT workspace (`chatgpt_account_id`) plus the email: one person can be in
// several workspaces with separate limits, and several people can share one workspace. Signing in
// again as the same pair replaces that account instead of adding a duplicate.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../log.ts";
import type { Credential } from "../../pool.ts";
import { redactErrorText } from "../../redact.ts";
import { withFileLock, writeJsonAtomic } from "../../locked-file.ts";
import { legacyMigrationDurable } from "../anthropic-accounts.ts";
import { OAUTH, identityFromTokens, ownAuthPath, readBorrowed, readOwn, type Tokens } from "./auth.ts";

export type ChatGptAccount = {
  /** Local opaque id; "legacy" for the imported single-login file. Never an upstream id. */
  id: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** The workspace the tokens act for; sent as `chatgpt-account-id` on every request. */
  accountId: string;
  /** epoch ms */
  expiresAt: number;
  email?: string;
  planType?: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  /** Set when OpenAI rejected the refresh token. Cleared by a successful refresh or sign-in. */
  needsReauth?: boolean;
  /** Left out of rotation by the user. */
  paused?: boolean;
};

export type ChatGptAccountSummary = {
  id: string;
  label: string;
  email?: string;
  planType?: string;
  expiresAt: number;
  needsReauth: boolean;
  paused: boolean;
  /** "codex" for the Codex CLI's own login, which we only read. */
  source: "own" | "codex";
};

type AccountsFile = { version: 1; accounts: ChatGptAccount[] };

export function chatgptAccountsPath(home: string): string {
  return path.join(home, "chatgpt-accounts.json");
}

function validAccount(value: unknown): value is ChatGptAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as Partial<ChatGptAccount>;
  return typeof a.id === "string" && a.id.length > 0
    && typeof a.accessToken === "string" && a.accessToken.length > 0
    && (a.refreshToken === undefined || typeof a.refreshToken === "string")
    && (a.idToken === undefined || typeof a.idToken === "string")
    && typeof a.accountId === "string" && a.accountId.length > 0
    && typeof a.expiresAt === "number" && Number.isFinite(a.expiresAt)
    && typeof a.label === "string" && a.label.length > 0
    && typeof a.createdAt === "string" && typeof a.updatedAt === "string"
    && (a.email === undefined || typeof a.email === "string")
    && (a.planType === undefined || typeof a.planType === "string")
    && (a.needsReauth === undefined || typeof a.needsReauth === "boolean")
    && (a.paused === undefined || typeof a.paused === "boolean");
}

/** The file's accounts; [] when absent, null when unreadable (so a mutation refuses to overwrite it). */
function parseAccountsFile(home: string): ChatGptAccount[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(chatgptAccountsPath(home), "utf8")) as Partial<AccountsFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.accounts) || !parsed.accounts.every(validAccount)) return null;
    const seen = new Set<string>();
    return parsed.accounts.filter((account) => !seen.has(account.id) && seen.add(account.id)).map((account) => ({ ...account }));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

/** The single login file from before accounts, seen as one account until the first write imports it. */
function legacyAccount(home: string): ChatGptAccount | null {
  const own = readOwn(home);
  if (!own) return null;
  const at = (() => { try { return fs.statSync(ownAuthPath(home)).mtime.toISOString(); } catch { return new Date(0).toISOString(); } })();
  const identity = identityFromTokens(own);
  return {
    id: "legacy",
    accessToken: own.accessToken,
    ...(own.refreshToken ? { refreshToken: own.refreshToken } : {}),
    ...(own.idToken ? { idToken: own.idToken } : {}),
    accountId: own.accountId,
    expiresAt: own.expiresAt,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.planType ? { planType: identity.planType } : {}),
    label: identity.email ?? "ChatGPT account",
    createdAt: at,
    updatedAt: at,
  };
}

function withLegacy(home: string, accounts: ChatGptAccount[]): ChatGptAccount[] {
  const legacy = legacyAccount(home);
  if (!legacy) return accounts;
  // A migration that wrote the pool but crashed before retiring the old file must not duplicate it.
  if (accounts.some((account) => account.id === "legacy" || sameIdentity(account, legacy))) return accounts;
  return [...accounts, legacy];
}

/** Every stored account. Once the pool file exists it is the only source: a stale legacy file cannot resurrect a removed login. */
export function readChatGptAccounts(home: string): ChatGptAccount[] {
  const accounts = parseAccountsFile(home);
  if (accounts === null) return [];
  return fs.existsSync(chatgptAccountsPath(home)) ? accounts : withLegacy(home, accounts);
}

function readForMutation(home: string): ChatGptAccount[] {
  const accounts = parseAccountsFile(home);
  if (accounts === null) throw new Error("ChatGPT account store is unreadable; refusing to overwrite it");
  return fs.existsSync(chatgptAccountsPath(home)) ? accounts : withLegacy(home, accounts);
}

function write(home: string, accounts: ChatGptAccount[]): void {
  const { directoryDurable } = writeJsonAtomic(chatgptAccountsPath(home), { version: 1, accounts } satisfies AccountsFile);
  if (legacyMigrationDurable(directoryDurable) && fs.existsSync(ownAuthPath(home))) fs.rmSync(ownAuthPath(home), { force: true });
}

function mutate<T>(home: string, change: (accounts: ChatGptAccount[]) => { accounts?: ChatGptAccount[]; result: T }): T {
  return withFileLock(chatgptAccountsPath(home), () => {
    const { accounts, result } = change(readForMutation(home));
    if (accounts) write(home, accounts);
    return result;
  });
}

/** Same person in the same workspace. A missing email on either side counts as a match. */
function sameIdentity(a: { accountId: string; email?: string }, b: { accountId: string; email?: string }): boolean {
  if (a.accountId !== b.accountId) return false;
  return !a.email || !b.email || a.email.toLowerCase() === b.email.toLowerCase();
}

export type ChatGptGrant = Omit<Tokens, "source">;

/** Add a signed-in account, or replace the same one after a re-login. Returns the stored account's summary. */
export function saveChatGptAccount(home: string, grant: ChatGptGrant, now = new Date().toISOString()): ChatGptAccountSummary & { added: boolean } {
  const identity = identityFromTokens(grant);
  return mutate(home, (accounts) => {
    const index = accounts.findIndex((account) => sameIdentity(account, { accountId: grant.accountId, ...(identity.email ? { email: identity.email } : {}) }));
    const previous = index >= 0 ? accounts[index] : undefined;
    const account: ChatGptAccount = {
      id: previous?.id ?? crypto.randomUUID(),
      accessToken: grant.accessToken,
      ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
      ...(grant.idToken ? { idToken: grant.idToken } : {}),
      accountId: grant.accountId,
      expiresAt: grant.expiresAt,
      ...(identity.email ?? previous?.email ? { email: identity.email ?? previous!.email! } : {}),
      ...(identity.planType ?? previous?.planType ? { planType: identity.planType ?? previous!.planType! } : {}),
      label: previous?.label ?? identity.email ?? `ChatGPT account ${accounts.length + 1}`,
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
export function replaceChatGptTokens(home: string, id: string, expectedRefreshToken: string, grant: ChatGptGrant, now = new Date().toISOString()): boolean {
  const identity = identityFromTokens(grant);
  return mutate(home, (accounts) => {
    const index = accounts.findIndex((account) => account.id === id && account.refreshToken === expectedRefreshToken);
    if (index < 0) return { result: false };
    const previous = accounts[index]!;
    const next = [...accounts];
    next[index] = {
      ...previous,
      accessToken: grant.accessToken,
      ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
      ...(grant.idToken ? { idToken: grant.idToken } : {}),
      expiresAt: grant.expiresAt,
      ...(identity.planType ? { planType: identity.planType } : {}),
      updatedAt: now,
      needsReauth: false,
    };
    return { accounts: next, result: true };
  });
}

/** Mark only the token generation that failed; a sign-in that landed meanwhile wins. */
export function markChatGptNeedsReauth(home: string, id: string, expectedAccessToken: string): boolean {
  return mutate(home, (accounts) => {
    const index = accounts.findIndex((account) => account.id === id && account.accessToken === expectedAccessToken);
    if (index < 0) return { result: false };
    const next = [...accounts];
    next[index] = { ...next[index]!, needsReauth: true, updatedAt: new Date().toISOString() };
    return { accounts: next, result: true };
  });
}

export function updateChatGptAccount(home: string, id: string, change: { label?: string; paused?: boolean }): boolean {
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

export function removeChatGptAccount(home: string, id: string): boolean {
  return mutate(home, (accounts) => {
    const next = accounts.filter((account) => account.id !== id);
    return next.length === accounts.length ? { result: false } : { accounts: next, result: true };
  });
}

/** `clauderipple logout`: every account we signed in, and the pre-accounts file. The Codex CLI's login is not ours. */
export function removeAllChatGptAccounts(home: string): number {
  return withFileLock(chatgptAccountsPath(home), () => {
    const count = readChatGptAccounts(home).length;
    fs.rmSync(chatgptAccountsPath(home), { force: true });
    fs.rmSync(ownAuthPath(home), { force: true });
    return count;
  });
}

export function summarize(account: ChatGptAccount): ChatGptAccountSummary {
  return {
    id: account.id,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    ...(account.planType ? { planType: account.planType } : {}),
    expiresAt: account.expiresAt,
    needsReauth: account.needsReauth === true,
    paused: account.paused === true,
    source: "own",
  };
}

// ---------------------------------------------------------------------------------------------
// Runtime

/** Refresh this long before expiry. A turn never waits for it while the old token still works. */
const REFRESH_LEAD_MS = 5 * 60_000;
/** The owner id the Codex CLI's login goes by; never collides with a UUID or "legacy". */
export const CODEX_LOGIN_ID = "codex";

/** Refresh-token rejections that will not heal: the account needs a new sign-in. */
const TERMINAL_REFRESH_CODES = new Set(["invalid_grant", "refresh_token_invalidated", "refresh_token_expired", "refresh_token_reused"]);

export class ChatGptRefreshError extends Error {
  readonly terminal: boolean;
  constructor(message: string, terminal: boolean) {
    super(message);
    this.terminal = terminal;
  }
}

/**
 * Whether a refused refresh means "sign in again". Decided on the structured error code only: a
 * 5xx whose body happens to mention "invalid" must not retire a working account. Prose is read
 * only when the answer carries no code at all, and only for a 400 or 401.
 */
export function refreshRejectionIsTerminal(status: number, body: string): boolean {
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
    const e = parsed.error;
    code = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : typeof parsed.code === "string" ? parsed.code : undefined;
  } catch {
    /* not JSON */
  }
  if (code) return TERMINAL_REFRESH_CODES.has(code);
  return (status === 400 || status === 401) && /\b(invalid_grant|revoked|invalidated|expired|reused)\b/i.test(body);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Exchange a refresh token for a new grant. Throws ChatGptRefreshError. */
export async function refreshChatGptGrant(refreshToken: string, previous: { accountId: string }, fetchImpl: FetchLike = fetch, now = Date.now): Promise<ChatGptGrant> {
  let res: Response;
  try {
    res = await fetchImpl(OAUTH.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: OAUTH.clientId }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ChatGptRefreshError(`token refresh unreachable: ${(error as Error).message}`, false);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ChatGptRefreshError(`token refresh failed: HTTP ${res.status} ${redactErrorText(text, [refreshToken], 200)}`, refreshRejectionIsTerminal(res.status, text));
  let j: { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
  try { j = JSON.parse(text) as typeof j; } catch { throw new ChatGptRefreshError("token refresh answered with something other than JSON", false); }
  if (!j.access_token) throw new ChatGptRefreshError("token refresh answered without an access token", false);
  const identity = identityFromTokens({ accessToken: j.access_token, ...(j.id_token ? { idToken: j.id_token } : {}) });
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? refreshToken,
    ...(j.id_token ? { idToken: j.id_token } : {}),
    accountId: identity.accountId ?? previous.accountId,
    expiresAt: j.expires_in ? now() + j.expires_in * 1000 : identity.expiresAt ?? now() + 3600_000,
  };
}

/** One refresh per token generation across every adapter in this process. */
const refreshing = new Map<string, Promise<void>>();

/** The credential one account presents, as the shared CredentialPool sees it. */
export type ChatGptCredential = Credential & { ownerId: string; accountId: string; accessToken: string };

function credentialOf(ownerId: string, label: string, accessToken: string, accountId: string): ChatGptCredential {
  // The runtime id is the account itself, not its token: a usage limit belongs to the account, and
  // a refresh must not bring a spent account back early. Whether an account needs a new sign-in is
  // kept in the store (needsReauth), never as a pool quarantine that a new token would have to undo.
  return {
    id: ownerId,
    ownerId,
    label,
    accountId,
    accessToken,
    headers: { authorization: `Bearer ${accessToken}`, "chatgpt-account-id": accountId },
  };
}

export type ChatGptAccountPoolOptions = {
  home: string;
  mode: "own" | "borrow-codex" | "auto";
  log: Pick<Logger, "info" | "warn">;
  fetch?: FetchLike;
  now?: () => number;
};

/**
 * The accounts one chatgpt provider may use, in order: ours as listed, then the Codex CLI's login.
 * Refreshes what is due without holding a turn up, and can force a refresh when the backend
 * refuses a token that has not expired yet.
 */
export class ChatGptAccountPool {
  private readonly home: string;
  private readonly mode: "own" | "borrow-codex" | "auto";
  private readonly log: Pick<Logger, "info" | "warn">;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => number;

  constructor(options: ChatGptAccountPoolOptions) {
    this.home = options.home;
    this.mode = options.mode;
    this.log = options.log;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
  }

  /** Stored accounts this provider may use (paused and needs-sign-in included, for display). */
  ownAccounts(): ChatGptAccount[] {
    return this.mode === "borrow-codex" ? [] : readChatGptAccounts(this.home);
  }

  /** The Codex CLI's login, when this provider may use it and it is not one of ours already. */
  codexLogin(): Tokens | null {
    if (this.mode === "own") return null;
    const borrowed = readBorrowed();
    if (!borrowed) return null;
    const identity = identityFromTokens(borrowed);
    const key = { accountId: borrowed.accountId, ...(identity.email ? { email: identity.email } : {}) };
    if (this.ownAccounts().some((account) => sameIdentity(account, key))) return null;
    return borrowed;
  }

  /** Accounts that could be sent right now, without network I/O. */
  peekCredentials(): ChatGptCredential[] {
    const out: ChatGptCredential[] = [];
    for (const account of this.ownAccounts()) {
      if (account.paused || account.needsReauth || this.now() >= account.expiresAt) continue;
      out.push(credentialOf(account.id, account.label, account.accessToken, account.accountId));
    }
    const codex = this.codexLogin();
    if (codex && this.now() < codex.expiresAt) out.push(credentialOf(CODEX_LOGIN_ID, identityFromTokens(codex).email ?? "Codex CLI login", codex.accessToken, codex.accountId));
    return out;
  }

  /** Accounts for one turn. Waits for a refresh only when nothing could be sent otherwise. */
  async credentials(): Promise<ChatGptCredential[]> {
    const ready = this.peekCredentials();
    const due = this.refreshDue();
    if (ready.length > 0) {
      void due.catch((error: Error) => this.log.warn(`chatgpt account refresh task failed: ${error.message}`));
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

  /**
   * The backend refused this account's token before it expired (revoked elsewhere, or a clock
   * that disagrees). One refresh; true when a new token is in place. The Codex CLI's login is not
   * ours to refresh.
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
  reject(credential: ChatGptCredential): void {
    if (credential.ownerId === CODEX_LOGIN_ID) return;
    if (markChatGptNeedsReauth(this.home, credential.ownerId, credential.accessToken)) {
      this.log.warn(`chatgpt account ${credential.ownerId.slice(0, 8)}: token refused; sign-in required`);
    }
  }

  private refresh(account: ChatGptAccount): Promise<void> {
    const refreshToken = account.refreshToken!;
    const key = `${this.home}\0${account.id}\0${crypto.createHash("sha256").update(refreshToken).digest("hex")}`;
    const running = refreshing.get(key);
    if (running) return running;
    const task = refreshChatGptGrant(refreshToken, account, this.fetchImpl, this.now).then(
      (grant) => {
        if (replaceChatGptTokens(this.home, account.id, refreshToken, grant)) {
          this.log.info(`chatgpt account ${account.id.slice(0, 8)}: token refreshed, valid until ${new Date(grant.expiresAt).toISOString()}`);
        }
      },
      (error: Error) => {
        if (error instanceof ChatGptRefreshError && error.terminal) {
          markChatGptNeedsReauth(this.home, account.id, account.accessToken);
          this.log.warn(`chatgpt account ${account.id.slice(0, 8)}: refresh rejected; sign-in required`);
        } else {
          this.log.warn(`chatgpt account ${account.id.slice(0, 8)}: refresh failed: ${redactErrorText(error.message, [account.accessToken, refreshToken], 300)}`);
        }
      },
    ).finally(() => refreshing.delete(key));
    refreshing.set(key, task);
    return task;
  }

  /** Every account for the dashboard: ours, then the Codex CLI's login. Metadata only. */
  summaries(): ChatGptAccountSummary[] {
    const out = this.ownAccounts().map(summarize);
    const codex = this.codexLogin();
    if (codex) {
      const identity = identityFromTokens(codex);
      out.push({
        id: CODEX_LOGIN_ID,
        label: identity.email ?? "Codex CLI login",
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.planType ? { planType: identity.planType } : {}),
        expiresAt: codex.expiresAt,
        needsReauth: this.now() >= codex.expiresAt,
        paused: false,
        source: "codex",
      });
    }
    return out;
  }

  /** Whether anything is signed in at all, expired or not — the "log in first" check. */
  signedIn(): boolean {
    return this.ownAccounts().length > 0 || this.codexLogin() !== null || (this.mode !== "own" && readBorrowed() !== null);
  }
}
