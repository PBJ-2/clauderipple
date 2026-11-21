// Anthropic's "limit resets": refills of a subscription's 5-hour and weekly limits that Anthropic
// grants to an account and that the account's owner may use once each, before the grant expires.
// Claude Desktop shows them under Settings → Limit resets and Claude Code runs them with
// `/limit-reset`; this lets the dashboard offer the same thing for every stored Claude account, so a
// reset can be used without signing that account in to Claude Desktop.
//
// Wire facts (measured 2026-11-20 against Claude Code 2.1.326's own client code, and a read-only
// lookup on one stored account; they are not an Anthropic guarantee, see docs/ARCHITECTURE.md §4b):
//   status  GET  /api/oauth/usage?cedar_ember=1&skip_spend=1   → body.cedar_ember
//   use     POST /api/organizations/<organization uuid>/reset_rate_limits
//                {"program":"cedar_ember","grant_id":"…","request_id":"…"}
//   The organization uuid is the `organization.uuid` of GET /api/oauth/profile.
// Using a grant is not undoable, so a claim is never retried and is only sent for a grant that a
// fresh status lookup shows as usable now.

import crypto from "node:crypto";
import { retryAfterMs, type Credential } from "../pool.ts";

const PROGRAM = "cedar_ember";
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ORGANIZATION_ID = /^[0-9a-fA-F-]{8,64}$/;
const WINDOWS = ["five_hour", "seven_day", "seven_day_overage_included", "seven_day_opus", "seven_day_sonnet", "seven_day_cowork", "seven_day_omelette", "seven_day_oauth_apps"] as const;
const CLAIM_RESULTS = ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"] as const;
/** The status lookup shares the usage endpoint's rate limit (it answered 429 with a one-hour wait), so it is kept briefly. */
const STATUS_TTL_MS = 30_000;
/** How long an organization uuid is kept: it does not change for a token, and this is only memory. */
const ORGANIZATION_TTL_MS = 6 * 60 * 60_000;
const CLAIM_TIMEOUT_MS = 25_000;
/** A 429 without `retry-after` is not asked again for this long. */
const DEFAULT_BLOCK_MS = 5 * 60_000;

export type ClaudeResetGrant = {
  id: string;
  label: string;
  type: "session" | "weekly" | "full" | null;
  /** Uses still available, and how many the grant started with. */
  left: number;
  total: number;
  startsAt: string | null;
  /** The last moment the grant can be used. */
  endsAt: string | null;
  /** The limit windows a use refills. */
  clears: string[];
  /** Percent used per window, 0..100, for the windows the grant names. */
  percentUsed: Record<string, number>;
  blocking: string[];
  paused: boolean;
  usableNow: boolean;
  /** True when Anthropic only lets this grant be used at a limit. */
  requiresLimit: boolean;
  givesBackWeekly: boolean;
  unavailableReason: string | null;
};

export type ClaudeResetStatus = {
  eligible: boolean;
  ineligibleReason: string | null;
  atLimit: boolean;
  exhausted: string[];
  grants: ClaudeResetGrant[];
  nextGrantId: string | null;
  weeklyResetsAt: string | null;
  cooldownUntil: string | null;
};

export type ClaudeResetClaimResult = typeof CLAIM_RESULTS[number] | "rate_limited" | "auth_error" | "error" | "unconfirmed" | "busy" | "not_usable";

export type ClaudeResetClaim = {
  result: ClaudeResetClaimResult;
  reason: string | null;
  /** Uses left on the grant after this claim, when Anthropic said. */
  resetsLeft: number | null;
  cleared: string[];
  weeklyResetsAt: string | null;
};

export type ClaudeResetsError = {
  kind: "unknown-account" | "needs-login" | "no-organization" | "http" | "network" | "unreadable";
  status?: number;
  retryAfterSeconds?: number;
};

export type ClaudeResetsOutcome<T> = { ok: true; value: T } | { ok: false; error: ClaudeResetsError };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type ClaudeResetsSource = {
  /** The credential of one stored account or of the current login, paused or not; null when it cannot be used. */
  credential(ownerId: string): Promise<Credential | null | "needs-login">;
};
export type ClaudeResetsOptions = {
  /** The Anthropic API host (`config.upstream`). */
  upstream: () => string;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  warn?: (message: string) => void;
  /** Test seam for the request id. */
  requestId?: () => string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function windowList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && (WINDOWS as readonly string[]).includes(name)) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function count(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function percentMap(value: unknown): Record<string, number> {
  const source = object(value);
  const out: Record<string, number> = {};
  if (!source) return out;
  for (const name of WINDOWS) {
    const percent = source[name];
    if (typeof percent === "number" && Number.isInteger(percent) && percent >= 0 && percent <= 100) out[name] = percent;
  }
  return out;
}

function grantFrom(value: unknown): ClaudeResetGrant | null {
  const grant = object(value);
  if (!grant) return null;
  const id = grant.id;
  const left = count(grant.resets_left, null);
  if (typeof id !== "string" || !GRANT_ID.test(id) || left === null) return null;
  const type = grant.type === "session" || grant.type === "weekly" || grant.type === "full" ? grant.type : null;
  return {
    id,
    label: typeof grant.label === "string" ? grant.label.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) : "",
    type,
    left,
    total: count(grant.resets_total, 0) ?? 0,
    startsAt: text(grant.starts_at),
    endsAt: text(grant.ends_at),
    clears: windowList(grant.clears),
    percentUsed: percentMap(grant.percent_used),
    blocking: windowList(grant.blocking),
    paused: grant.paused === true,
    usableNow: grant.usable_now === true,
    // Anthropic's own client assumes a use needs a limit until the grant says otherwise.
    requiresLimit: grant.use_requires_limit !== false,
    givesBackWeekly: grant.gives_back_weekly === true,
    unavailableReason: text(grant.unavailable_reason),
  };
}

/**
 * The reset status in a `/api/oauth/usage` body. An account the program does not reach has no
 * `cedar_ember` block, which reads as "no resets right now"; a block that is not an object is
 * malformed and reads as null.
 */
export function claudeResetsFromBody(body: unknown): ClaudeResetStatus | null {
  const root = object(body);
  if (!root) return null;
  const block = root.cedar_ember;
  if (block === undefined || block === null) {
    return { eligible: false, ineligibleReason: null, atLimit: false, exhausted: [], grants: [], nextGrantId: null, weeklyResetsAt: null, cooldownUntil: null };
  }
  const status = object(block);
  if (!status) return null;
  const grants = (Array.isArray(status.grants) ? status.grants : []).map(grantFrom).filter((grant): grant is ClaudeResetGrant => grant !== null);
  const next = typeof status.next_grant_id === "string" && grants.some((grant) => grant.id === status.next_grant_id) ? status.next_grant_id : null;
  return {
    eligible: status.eligible === true,
    ineligibleReason: text(status.ineligible_reason),
    atLimit: status.at_limit === true,
    exhausted: windowList(status.exhausted),
    grants,
    nextGrantId: next,
    weeklyResetsAt: text(status.weekly_resets_at),
    cooldownUntil: text(status.cooldown_until),
  };
}

function authKey(headers: Record<string, string>): string {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") return crypto.createHash("sha256").update(value).digest("hex");
  }
  return "";
}

export class ClaudeLimitResets {
  private readonly source: ClaudeResetsSource;
  private readonly opts: ClaudeResetsOptions;
  private readonly statuses = new Map<string, { at: number; value: ClaudeResetStatus }>();
  private readonly blockedUntil = new Map<string, number>();
  private readonly organizations = new Map<string, { at: number; id: string }>();
  private readonly claiming = new Set<string>();

  constructor(source: ClaudeResetsSource, opts: ClaudeResetsOptions) {
    this.source = source;
    this.opts = opts;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * The resets one account holds. Answered from memory for 30 seconds unless `force`; a 429 from
   * Anthropic is not asked again before its `retry-after`, even when forced.
   */
  async status(ownerId: string, options: { force?: boolean } = {}): Promise<ClaudeResetsOutcome<ClaudeResetStatus>> {
    const cached = this.statuses.get(ownerId);
    const now = this.now();
    if (!options.force && cached && now - cached.at < STATUS_TTL_MS) return { ok: true, value: cached.value };
    const blocked = this.blockedUntil.get(ownerId) ?? 0;
    if (blocked > now) return { ok: false, error: { kind: "http", status: 429, retryAfterSeconds: Math.ceil((blocked - now) / 1000) } };
    const credential = await this.source.credential(ownerId);
    if (credential === "needs-login") return { ok: false, error: { kind: "needs-login" } };
    if (!credential) return { ok: false, error: { kind: "unknown-account" } };
    let response: Response;
    try {
      response = await (this.opts.fetch ?? fetch)(`https://${this.opts.upstream()}/api/oauth/usage?cedar_ember=1&skip_spend=1`, {
        method: "GET",
        headers: { ...credential.headers, accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (e) {
      this.opts.warn?.(`claude resets ${ownerId.slice(0, 8)}: ${(e as Error).message}`);
      return { ok: false, error: { kind: "network" } };
    }
    if (!response.ok) {
      // The status alone: a failure body is not worth the risk of echoing.
      const retry = retryAfterMs(Object.fromEntries(response.headers.entries()));
      if (response.status === 429) this.blockedUntil.set(ownerId, now + (retry ?? DEFAULT_BLOCK_MS));
      this.opts.warn?.(`claude resets ${ownerId.slice(0, 8)}: HTTP ${response.status}`);
      return { ok: false, error: { kind: "http", status: response.status, ...(retry !== undefined ? { retryAfterSeconds: Math.ceil(retry / 1000) } : {}) } };
    }
    let status: ClaudeResetStatus | null = null;
    try {
      status = claudeResetsFromBody(await response.json());
    } catch {
      status = null;
    }
    if (!status) return { ok: false, error: { kind: "unreadable" } };
    this.blockedUntil.delete(ownerId);
    this.statuses.set(ownerId, { at: now, value: status });
    return { ok: true, value: status };
  }

  private async organization(ownerId: string, credential: Credential): Promise<string | null> {
    const key = `${ownerId}\0${authKey(credential.headers)}`;
    const now = this.now();
    const hit = this.organizations.get(key);
    if (hit && now - hit.at < ORGANIZATION_TTL_MS) return hit.id;
    try {
      const response = await (this.opts.fetch ?? fetch)(`https://${this.opts.upstream()}/api/oauth/profile`, {
        method: "GET",
        headers: { ...credential.headers, accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (!response.ok) return null;
      const id = object(object(await response.json())?.organization)?.uuid;
      if (typeof id !== "string" || !ORGANIZATION_ID.test(id)) return null;
      this.organizations.set(key, { at: now, id });
      if (this.organizations.size > 16) this.organizations.delete(this.organizations.keys().next().value as string);
      return id;
    } catch {
      return null;
    }
  }

  /**
   * Uses one reset of one grant. Anthropic refills the limits at once, and the use cannot be taken
   * back, so: only a grant a fresh lookup shows usable now is sent; one claim per account runs at a
   * time; the request is never retried. When no answer comes back the result is `unconfirmed` and
   * the caller shows a fresh status so the person can see whether the use counted.
   */
  async claim(ownerId: string, grantId: string): Promise<ClaudeResetsOutcome<{ claim: ClaudeResetClaim; status: ClaudeResetStatus | null }>> {
    if (!GRANT_ID.test(grantId)) return { ok: false, error: { kind: "unreadable" } };
    if (this.claiming.has(ownerId)) return { ok: true, value: { claim: this.refused("busy", null), status: null } };
    this.claiming.add(ownerId);
    try {
      const fresh = await this.status(ownerId, { force: true });
      if (!fresh.ok) return fresh;
      const grant = fresh.value.grants.find((candidate) => candidate.id === grantId);
      if (!grant) return { ok: true, value: { claim: this.refused("not_usable", "unknown_grant"), status: fresh.value } };
      if (grant.left < 1 || grant.paused || !grant.usableNow) {
        return { ok: true, value: { claim: this.refused("not_usable", grant.unavailableReason ?? (grant.left < 1 ? "already_used" : grant.paused ? "paused" : "not_usable")), status: fresh.value } };
      }
      const credential = await this.source.credential(ownerId);
      if (credential === "needs-login") return { ok: false, error: { kind: "needs-login" } };
      if (!credential) return { ok: false, error: { kind: "unknown-account" } };
      const organization = await this.organization(ownerId, credential);
      if (!organization) return { ok: false, error: { kind: "no-organization" } };
      const requestId = this.opts.requestId?.() ?? crypto.randomBytes(18).toString("base64url");
      if (!REQUEST_ID.test(requestId)) return { ok: false, error: { kind: "unreadable" } };
      const claim = await this.post(credential, organization, grantId, requestId);
      this.statuses.delete(ownerId);
      // A reset that went through, or one nobody could confirm, leaves a status that is worth reading again right away.
      const after = claim.result === "reset" || claim.result === "unconfirmed" ? await this.status(ownerId, { force: true }) : null;
      return { ok: true, value: { claim, status: after && after.ok ? after.value : null } };
    } finally {
      this.claiming.delete(ownerId);
    }
  }

  private refused(result: ClaudeResetClaimResult, reason: string | null): ClaudeResetClaim {
    return { result, reason, resetsLeft: null, cleared: [], weeklyResetsAt: null };
  }

  private async post(credential: Credential, organization: string, grantId: string, requestId: string): Promise<ClaudeResetClaim> {
    let response: Response;
    try {
      response = await (this.opts.fetch ?? fetch)(`https://${this.opts.upstream()}/api/organizations/${organization}/reset_rate_limits`, {
        method: "POST",
        headers: { ...credential.headers, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ program: PROGRAM, grant_id: grantId, request_id: requestId }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? CLAIM_TIMEOUT_MS),
      });
    } catch (e) {
      this.opts.warn?.(`claude resets claim: ${(e as Error).message}`);
      return this.refused("unconfirmed", null);
    }
    if (response.status === 429) return this.refused("rate_limited", null);
    if (response.status === 401 || response.status === 403) return this.refused("auth_error", null);
    let body: Record<string, unknown> | null = null;
    try {
      body = object(await response.json());
    } catch {
      body = null;
    }
    if (!response.ok) {
      this.opts.warn?.(`claude resets claim: HTTP ${response.status}`);
      return this.refused(response.status >= 500 ? "unconfirmed" : "error", null);
    }
    if (!body) return this.refused("unconfirmed", null);
    const result = (CLAIM_RESULTS as readonly string[]).includes(String(body.result)) ? body.result as typeof CLAIM_RESULTS[number] : "unavailable";
    return {
      result,
      reason: text(body.reason),
      resetsLeft: count(body.resets_left, null),
      cleared: windowList(body.cleared),
      weeklyResetsAt: text(body.weekly_resets_at),
    };
  }
}
