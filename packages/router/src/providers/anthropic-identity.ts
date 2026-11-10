// Who the current Claude login is, so the dashboard can tell it apart from a stored copy of itself.
//
// The current login (Claude Desktop or the terminal) and the ClaudeRipple account pool are two
// stores describing one person: `/api/claude-accounts` would list the same account twice. The login
// answers `/api/oauth/profile` with the headers `/api/oauth/usage` already takes:
//   {"account": {"uuid": "…", "email": "…", …}, "organization": {…}, …}   (measured 2026-10-23)
// Only the email and a one-way hash of the UUID leave this module; the body is never logged.

import crypto from "node:crypto";
import type { Credential } from "../pool.ts";
import { subjectHash } from "./anthropic-accounts.ts";

export type ClaudeLoginIdentity = { email: string; subjectHash: string };

/** The two fields the dashboard compares, or null when the body does not describe an account. */
export function claudeIdentityFromBody(body: unknown): ClaudeLoginIdentity | null {
  const account = (body as { account?: unknown } | null)?.account;
  if (!account || typeof account !== "object" || Array.isArray(account)) return null;
  const { uuid, email } = account as { uuid?: unknown; email?: unknown };
  if (typeof uuid !== "string" || !uuid || typeof email !== "string" || !email) return null;
  const hash = subjectHash(uuid);
  return hash ? { email, subjectHash: hash } : null;
}

/**
 * The login's email for a request's log row, read within `ms`. Past the bound the row keeps no
 * email rather than holding the turn, so it then names no person; a lookup that fails names none.
 */
export async function loginEmailWithin(lookup: () => Promise<{ email: string } | null>, ms = 1_500): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const identity = await Promise.race([
      lookup(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
    return identity?.email;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

type IdentitySource = { credentials(): Promise<Credential[]> };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type IdentityOptions = {
  /** The Anthropic API host (`config.upstream`). */
  upstream: () => string;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  warn?: (message: string) => void;
};

/** The account's own auth header, the value a new token changes. Null when there is none to send. */
function authHeaderValue(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key") return value;
  }
  return null;
}

/**
 * The current login's identity, asked at most once per `ttlMs` (ten minutes) per token. The cache
 * is keyed on a hash of the auth header rather than on time alone, so a fresh login asks again
 * immediately; a failure is cached the same way and retried when the cache expires, never on every
 * poll of the dashboard.
 */
export class ClaudeCurrentIdentity {
  // A few tokens at once: the pool's copy and a client's own sign-in may differ, and one entry would ask again on each turn.
  private readonly cache = new Map<string, { at: number; value: ClaudeLoginIdentity | null }>();
  private readonly source: IdentitySource;
  private readonly opts: IdentityOptions;

  constructor(source: IdentitySource, opts: IdentityOptions) {
    this.source = source;
    this.opts = opts;
  }

  /** The identity of the pool's own copy of the current login. */
  async identify(): Promise<ClaudeLoginIdentity | null> {
    let headers: Record<string, string> | undefined;
    try {
      headers = (await this.source.credentials()).find((credential) => credential.ownerId === "current")?.headers;
    } catch (e) {
      this.opts.warn?.(`claude identity: no credentials: ${(e as Error).message}`);
      return null;
    }
    if (!headers) return null;
    return this.identifyWith(headers);
  }

  /**
   * The identity behind these auth headers. A request answered on the client's own sign-in names
   * that login, which need not be the pool's copy, so the caller passes the headers it sent.
   */
  async identifyWith(headers: Record<string, string>): Promise<ClaudeLoginIdentity | null> {
    const auth = authHeaderValue(headers);
    if (!auth) return null;
    const key = crypto.createHash("sha256").update(auth).digest("hex");
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (this.opts.ttlMs ?? 10 * 60_000)) return hit.value;
    const value = await this.fetchProfile(headers);
    this.cache.delete(key);
    this.cache.set(key, { at: now, value });
    if (this.cache.size > 8) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return value;
  }

  private async fetchProfile(headers: Record<string, string>): Promise<ClaudeLoginIdentity | null> {
    try {
      const res = await (this.opts.fetch ?? fetch)(`https://${this.opts.upstream()}/api/oauth/profile`, {
        method: "GET",
        // The same headers the usage lookup sends for the current login.
        headers: { ...headers, accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      // The status alone: a failure body is not worth the risk of echoing.
      if (!res.ok) {
        this.opts.warn?.(`claude identity: HTTP ${res.status}`);
        return null;
      }
      return claudeIdentityFromBody(await res.json());
    } catch (e) {
      this.opts.warn?.(`claude identity: ${(e as Error).message}`);
      return null;
    }
  }
}
