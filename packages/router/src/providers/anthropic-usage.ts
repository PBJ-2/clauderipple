// How much of each Claude subscription account's limits is used, for the dashboard and the tray.
//
// Response headers would only describe the account that last answered, so an idle second account
// would never show a number. Claude Code's own `/usage` asks `GET /api/oauth/usage` with the
// account's OAuth headers instead, and so does this. Shape measured 2026-09-28 (CLI 2.1.281):
//   {"five_hour": {"utilization": 14.0, "resets_at": "2026-09-28T08:30:00.581181+00:00", …},
//    "seven_day": {"utilization": 10.0, "resets_at": "…"}, "seven_day_opus": null, …}
// `utilization` is a percentage. It is mapped onto the Codex snapshot shape
// (`rate_limits.primary/secondary` with `used_percent`, `window_minutes`, `reset_at` in seconds)
// so the GUI and the tray read one format for every account.

import { retryAfterMs, type Credential } from "../pool.ts";

type Window = { utilization?: unknown; resets_at?: unknown } | null | undefined;

/** One entry of the `/api/oauth/usage` body's `limits` array (shape measured 2026-10-15). */
type ScopedEntry = {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { id?: unknown; display_name?: unknown } | null } | null;
} | null | undefined;

const FIVE_HOURS = 5 * 60;
const WEEK = 7 * 24 * 60;
/** A refused usage lookup never waits longer than this before asking again. */
const MAX_BACKOFF_MS = 60 * 60_000;

export function claudeUsageFromBody(body: unknown, at = Date.now()): Record<string, unknown> | null {
  const b = body as { five_hour?: Window; seven_day?: Window; limits?: unknown } | null;
  const win = (w: Window, minutes: number): Record<string, number> | null => {
    if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) return null;
    const out: Record<string, number> = { used_percent: w.utilization, window_minutes: minutes };
    const at = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    if (Number.isFinite(at)) out.reset_at = Math.round(at / 1000);
    return out;
  };
  const primary = win(b?.five_hour, FIVE_HOURS);
  const secondary = win(b?.seven_day, WEEK);
  if (!primary && !secondary) return null;
  const scoped = scopedFromLimits(b?.limits);
  return {
    type: "claude.usage",
    rate_limits: { primary: primary ?? secondary, secondary: primary ? secondary : null },
    ...(scoped.length ? { scoped } : {}),
    at,
  };
}

/**
 * The same snapshot from a Claude Messages answer's unified limit headers, measured against the
 * installed CLI 2.1.317 (2026-11-05): `anthropic-ratelimit-unified-5h-utilization` and `-7d-utilization`
 * are fractions 0..1 (the CLI clamps them to that and shows percent), `-5h-reset` / `-7d-reset` are
 * epoch seconds, and the presence of `anthropic-ratelimit-unified-status` says the limiter ran. A
 * rate-limited answer carries these too, which is the only usage reading left while
 * GET /api/oauth/usage is being refused.
 */
export function claudeUsageFromHeaders(headers: Record<string, string | string[] | undefined>, at = Date.now()): Record<string, unknown> | null {
  const pick = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  if (pick("anthropic-ratelimit-unified-status") === undefined) return null;
  const window = (prefix: "5h" | "7d", minutes: number): Record<string, number> | null => {
    const raw = pick(`anthropic-ratelimit-unified-${prefix}-utilization`);
    if (raw === undefined || raw === "") return null;
    const fraction = Number(raw);
    if (!Number.isFinite(fraction)) return null;
    const out: Record<string, number> = { used_percent: Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 10, window_minutes: minutes };
    const reset = Number(pick(`anthropic-ratelimit-unified-${prefix}-reset`));
    if (Number.isFinite(reset) && reset * 1000 > at) out.reset_at = Math.round(reset);
    return out;
  };
  const primary = window("5h", FIVE_HOURS);
  const secondary = window("7d", WEEK);
  if (!primary && !secondary) return null;
  return { type: "claude.usage", rate_limits: { primary: primary ?? secondary, secondary: primary ? secondary : null }, at };
}

/**
 * How long a rejected Claude answer says its account must rest, from the same unified limit headers
 * (`anthropic-ratelimit-unified-status`, measured against CLI 2.1.317, 2026-11-05). A 429 without
 * `retry-after` used to cool the account for a minute even when `-5h-utilization` read 100% and the
 * reset was hours away (2026-11-07), so every turn of that window re-tried a spent subscription.
 *
 * Undefined unless the limiter itself says the account is rejected and names a future reset for a
 * window that is actually spent: an ordinary per-minute 429, or a body simulator that echoes the
 * status without the window, keeps the pool's ordinary rate-limit wait. The soonest spent window is
 * returned — the first moment asking again can work — and the pool's 6 h clamp still bounds it.
 * `used_percent`/`reset_at` stay display facts of `claudeUsageFromHeaders`; this is the wait.
 */
export function claudeLimitResetMs(headers: Record<string, string | string[] | undefined>, at = Date.now()): number | undefined {
  const pick = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  if (pick("anthropic-ratelimit-unified-status") !== "rejected") return undefined;
  let soonest: number | undefined;
  for (const prefix of ["5h", "7d"] as const) {
    const used = Number(pick(`anthropic-ratelimit-unified-${prefix}-utilization`));
    const reset = Number(pick(`anthropic-ratelimit-unified-${prefix}-reset`));
    if (!Number.isFinite(used) || used < 1 || !Number.isFinite(reset)) continue;
    const wait = reset * 1000 - at;
    if (wait <= 0) continue;
    soonest = soonest === undefined ? wait : Math.min(soonest, wait);
  }
  return soonest;
}

/**
 * Per-model weekly windows from the same body: entries of `limits` with kind `weekly_scoped`
 * carry the model in `scope.model.display_name` (measured 2026-10-15:
 * `{"kind":"weekly_scoped","group":"weekly","percent":2,…,"scope":{"model":{"id":null,
 * "display_name":"Fable"},"surface":null},"is_active":false}`). They ride beside
 * `rate_limits` (which the GUI and the tray read) so those readers keep working unchanged.
 */
function scopedFromLimits(limits: unknown): Record<string, number | string>[] {
  if (!Array.isArray(limits)) return [];
  const out: Record<string, number | string>[] = [];
  for (const entry of limits as ScopedEntry[]) {
    if (!entry || typeof entry !== "object" || entry.kind !== "weekly_scoped") continue;
    const name = entry.scope?.model?.display_name;
    const percent = entry.percent;
    if (typeof name !== "string" || !name || typeof percent !== "number" || !Number.isFinite(percent)) continue;
    const w: Record<string, number | string> = { name, used_percent: percent, window_minutes: WEEK };
    const at = typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) : NaN;
    if (Number.isFinite(at)) w.reset_at = Math.round(at / 1000);
    out.push(w);
  }
  return out;
}

/**
 * The model family of a Claude model id or a usage window's display name ("claude-fable-5-1",
 * "Fable"), which is what a per-model weekly window is scoped to. Undefined for anything else, and
 * the caller then keeps the account-wide behaviour.
 */
export function claudeModelFamily(model: string): "fable" | "opus" | "sonnet" | "haiku" | undefined {
  const match = /(?:^|[^a-z])(fable|opus|sonnet|haiku)(?![a-z])/.exec(model.toLowerCase());
  return match?.[1] as "fable" | "opus" | "sonnet" | "haiku" | undefined;
}

/** The account a credential spends, keyed as the pool keys its health (pool.ts): a token refresh keeps it. */
function durableAccount(credential: Credential): string {
  return credential.healthKey ?? credential.ownerId ?? credential.id;
}

type UsageSource = { credentials(): Promise<Credential[]> };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type UsageOptions = {
  /** The Anthropic API host (`config.upstream`). */
  upstream: () => string;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  warn?: (message: string) => void;
};

type UsageFailure = { status: number; retryAfterMs?: number };
type FetchOutcome = { ok: true; snapshot: Record<string, unknown> | null } | { ok: false; failure: UsageFailure };

/**
 * Per-account snapshots, fetched at most once per `ttlMs` per account. The GUI polls the status
 * every five seconds and the tray as often; a limit that moves by a percent in minutes does not
 * need more. A failed lookup keeps the last good numbers rather than blanking them, and says on
 * the snapshot that it failed, so an old reading is never mistaken for a current one.
 */
export class ClaudeUsage {
  private readonly last = new Map<string, Record<string, unknown>>();
  /** Consecutive refusals per account, for the doubling wait after a 429 without `retry-after`. */
  private readonly failures = new Map<string, number>();
  /** Per-account "do not ask again before", from a 429 or its `retry-after`. */
  private readonly blockedUntil = new Map<string, number>();
  /**
   * The per-model weekly windows of each account's latest body reading. Kept apart from `last`
   * because a header reading replaces that snapshot and carries no per-model window, while a spent
   * weekly window stays spent until its stated reset whatever replaced the display. Each reading names
   * the durable account it was read on: the current login keeps the owner "current" across a switch
   * to another account, and one account's spent window must not rest the next one.
   */
  private readonly scopedReadings = new Map<string, { account: string; windows: Record<string, number | string>[] }>();
  /** Accounts whose current snapshot came from answer headers, so a later answer may correct it. */
  private readonly fromHeaders = new Set<string>();
  /** Header readings stored per account. A refresh captures this before it collects credentials and
   * a failure compares it: timestamps tie within one millisecond, so this is what orders them (2026-11-05). */
  private readonly readings = new Map<string, number>();
  private inFlight: Promise<Record<string, Record<string, unknown>>> | null = null;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private readonly source: UsageSource;
  private readonly opts: UsageOptions;

  constructor(source: UsageSource, opts: UsageOptions) {
    this.source = source;
    this.opts = opts;
  }

  /** Snapshots by account owner id ("current" for the Claude Code login). */
  snapshot(): Promise<Record<string, Record<string, unknown>>> {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.fetchedAt < (this.opts.ttlMs ?? 5 * 60_000)) return Promise.resolve(Object.fromEntries(this.last));
    this.inFlight ??= this.fetchAll().finally(() => {
      this.fetchedAt = (this.opts.now ?? Date.now)();
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * One account's windows from a Messages answer's unified limit headers. The body source is
   * richer (it also carries per-model weeklies), so it wins while it is fresh; the headers fill in
   * exactly when it cannot be read — a 429 there used to leave the last reading on screen as if it
   * were current while the account was at its limit (issue #123, 2026-11-05).
   *
   * A snapshot taken from headers keeps taking newer header readings until a body read arrives:
   * the header reading drops `stale`, so refusing every later answer after the first one froze the
   * display at that first value for the whole backoff.
   *
   * A body reading is fresh for one refresh interval and no longer: once the next refresh is due but
   * has not run yet (nobody polls), it is as old as a failed lookup's, so an answer's headers replace
   * it (2026-11-05).
   */
  observeAnswer(owner: string, headers: Record<string, string | string[] | undefined>): void {
    const now = (this.opts.now ?? Date.now)();
    const snapshot = claudeUsageFromHeaders(headers, now);
    if (!snapshot) return;
    const previous = this.last.get(owner);
    const readAt = typeof previous?.at === "number" ? previous.at : Number.NEGATIVE_INFINITY;
    const aged = now - readAt >= (this.opts.ttlMs ?? 5 * 60_000);
    if (previous && previous.stale !== true && !aged && !this.fromHeaders.has(owner)) return;
    this.last.set(owner, snapshot);
    this.readings.set(owner, (this.readings.get(owner) ?? 0) + 1);
    this.fromHeaders.add(owner);
  }

  private async fetchAll(): Promise<Record<string, Record<string, unknown>>> {
    // Capture the counters before the first await: a Messages answer can store a header reading while
    // the credential list is still being collected, and the refusal that follows must not mark that
    // newer reading stale. An owner not in this map had no reading then, so it starts at 0
    // (2026-11-05).
    // Capture the counters before the first await: a Messages answer can store a header reading while
    // the credential list is still being collected, and the refusal that follows must not mark that
    // newer reading stale. An owner not in this map had no reading then, so it starts at 0
    // (2026-11-05).
    const readingsAtStart = new Map(this.readings);
    let credentials: Credential[];
    try {
      credentials = await this.source.credentials();
    } catch (e) {
      this.opts.warn?.(`claude usage: no credentials: ${(e as Error).message}`);
      return Object.fromEntries(this.last);
    }
    const now = (this.opts.now ?? Date.now)();
    await Promise.all(credentials.map(async (credential) => {
      const owner = credential.ownerId ?? credential.id;
      // A 429 stops only the account it refused; the others keep their normal schedule.
      if ((this.blockedUntil.get(owner) ?? 0) > now) return;
      const outcome = await this.fetchOne(credential, now);
      if (outcome.ok) {
        if (outcome.snapshot) {
          this.last.set(owner, outcome.snapshot);
          this.scopedReadings.set(owner, {
            account: durableAccount(credential),
            windows: (outcome.snapshot.scoped as Record<string, number | string>[] | undefined) ?? [],
          });
          // A fresh body reading wins over headers and stays until it goes stale.
          this.fromHeaders.delete(owner);
        }
        this.failures.delete(owner);
        this.blockedUntil.delete(owner);
      } else this.noteFailure(owner, outcome.failure, now, readingsAtStart.get(owner) ?? 0);
    }));
    // An account that was removed must not keep its old numbers on the screen.
    const owners = new Set(credentials.map((c) => c.ownerId ?? c.id));
    for (const owner of [...this.last.keys()]) {
      if (owners.has(owner)) continue;
      this.last.delete(owner);
      this.failures.delete(owner);
      this.blockedUntil.delete(owner);
      this.fromHeaders.delete(owner);
      this.readings.delete(owner);
      this.scopedReadings.delete(owner);
    }
    return Object.fromEntries(this.last);
  }

  /**
   * How long until a model family's weekly window resets, when the account's latest body reading
   * says that window is spent (100% or more) and names a reset still ahead. Undefined otherwise.
   * Reads what is already cached and asks nothing: an old reading cannot be wrong about a window
   * that was spent with its reset in the future, because a window only resets at its reset. A reading
   * taken on another account under the same owner (the current login after a switch) says nothing.
   */
  spentScopeResetMs(credential: Credential, family: string): number | undefined {
    const reading = this.scopedReadings.get(credential.ownerId ?? credential.id);
    if (!reading || reading.account !== durableAccount(credential)) return undefined;
    const now = (this.opts.now ?? Date.now)();
    let soonest: number | undefined;
    for (const window of reading.windows) {
      if (typeof window.name !== "string" || claudeModelFamily(window.name) !== family) continue;
      if (typeof window.used_percent !== "number" || window.used_percent < 100) continue;
      if (typeof window.reset_at !== "number") continue;
      const wait = window.reset_at * 1000 - now;
      if (wait <= 0) continue;
      soonest = soonest === undefined ? wait : Math.min(soonest, wait);
    }
    return soonest;
  }

  /**
   * A refused lookup keeps the last good numbers but records that they are old, and a 429 stops
   * the next asks for as long as its `retry-after` says (or a doubling wait without one). A
   * restart used to empty the caches, every account's check went out at once, and the endpoint
   * then refused the current login for hours while its card still read like a live number
   * (issue #123, 2026-11-05).
   */
  private noteFailure(owner: string, failure: UsageFailure, at: number, readingsAtStart: number): void {
    const count = (this.failures.get(owner) ?? 0) + 1;
    this.failures.set(owner, count);
    if (failure.status === 429) {
      const base = this.opts.ttlMs ?? 5 * 60_000;
      const backoff = failure.retryAfterMs ?? Math.min(MAX_BACKOFF_MS, base * 2 ** (count - 1));
      this.blockedUntil.set(owner, at + backoff);
    }
    const previous = this.last.get(owner);
    // Mark the last reading stale only when no header reading replaced it since this refresh
    // started. A Messages answer can store one while the lookup is in flight and then the lookup
    // returns 429: stamping that newer snapshot with an earlier failure would claim a live reading
    // is old. The timestamps tie within the same millisecond, so the per-account count of stored
    // readings is what orders them (issue #123, 2026-11-05).
    if (previous && (this.readings.get(owner) ?? 0) === readingsAtStart) this.last.set(owner, { ...previous, stale: true, failed_at: at, failed_status: failure.status });
  }

  private async fetchOne(credential: Credential, at: number): Promise<FetchOutcome> {
    const owner = (credential.ownerId ?? credential.id).slice(0, 8);
    try {
      const res = await (this.opts.fetch ?? fetch)(`https://${this.opts.upstream()}/api/oauth/usage`, {
        method: "GET",
        headers: { ...credential.headers, accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        // The status alone: the body of an auth failure is not worth the risk of echoing. The
        // vendor's own wait is worth logging, because it explains an hours-long stale reading.
        const retry = retryAfterMs(Object.fromEntries(res.headers.entries()));
        this.opts.warn?.(`claude usage ${owner}: HTTP ${res.status}${retry !== undefined ? ` (retry after ${Math.ceil(retry / 1000)}s)` : ""}`);
        return { ok: false, failure: { status: res.status, ...(retry !== undefined ? { retryAfterMs: retry } : {}) } };
      }
      return { ok: true, snapshot: claudeUsageFromBody(await res.json(), at) };
    } catch (e) {
      this.opts.warn?.(`claude usage ${owner}: ${(e as Error).message}`);
      return { ok: false, failure: { status: 0 } };
    }
  }
}
