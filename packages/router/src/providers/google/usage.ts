// How much of each Antigravity (Cloud Code Assist) account's quota is left, for the dashboard and
// the status bar's limits row. One lookup per account and host: the accounts store already
// refreshes the OAuth token, so this only reads. The CLI User-Agent includes Argon's weekly group;
// an unreadable CLI answer falls back to the IDE answer for the existing Gemini/3P windows.
//
// Measured 2026-10-15 against a live Antigravity subscription:
//   POST {host}/v1internal:retrieveUserQuotaSummary
// The host must be one the requests go to (transport.ts antigravityBaseUrl). Each host keeps its own
// count: after 144 gemini-3.8-flash requests on daily, the prod host still answered
// remainingFraction 1 with a reset always five hours out, while daily answered 0.87 (5h) and 0.947
// (weekly) — the limits row read prod and showed 0% for a day of use (2026-10-20). So every host a
// selected model is sent to is read, and the row shows each window kind at the higher used percent.
//   headers: authorization: Bearer <accessToken>, content-type: application/json, user-agent
//   body:    {"project": "<projectId>"}
//   answer:  {"groups":[{"displayName":"Gemini Models","buckets":[
//              {"bucketId":"gemini-weekly","displayName":"Weekly","window":"weekly",
//               "resetTime":"…","remainingFraction":0.98},
//              {"bucketId":"gemini-5h","displayName":"5h","window":"5h",…}]},
//            {"displayName":"Claude and GPT models","buckets":[
//              {"bucketId":"3p-weekly",…},{"bucketId":"3p-5h",…}]}]}
// `remainingFraction` is what is left (1 = untouched), so used = (1 - remainingFraction) * 100. The
// older `retrieveUserQuota` returns meaningless values and is deliberately not used.

import type { GoogleCredential } from "./accounts.ts";
import { GOOGLE_OAUTH, antigravityCliUserAgent, antigravityUserAgent, type FetchLike, type LearnedCatalogue } from "./antigravity.ts";

/** The five-hour and weekly window lengths in minutes, for the limits row's `window_minutes`. */
const FIVE_HOURS = 5 * 60;
const WEEK = 7 * 24 * 60;

/** One quota bucket as the endpoint answers it. */
export type QuotaBucket = {
  bucketId: string;
  displayName: string;
  /** "5h" or "weekly", as the endpoint names it. */
  window: string;
  resetTime?: string;
  /** A disabled bucket is not positive evidence of remaining quota. */
  disabled?: boolean;
  /** 0..1 of the quota left; 1 = untouched. */
  remainingFraction: number;
};

/**
 * A quota group. `read_at` (epoch milliseconds) is set on the snapshot's groups only: when the request
 * that gave them was sent. Every group of one account carries the same time; an account whose later
 * lookups all fail keeps the time of its last good one. Internal: `/api/limits` strips it.
 */
export type QuotaGroup = { displayName: string; buckets: QuotaBucket[]; read_at?: number };

/**
 * Parse the `retrieveUserQuotaSummary` body into groups. A group or bucket missing the fields the
 * row reads is dropped rather than guessed; null when the body is not the shape at all (so the
 * caller keeps its last good answer instead of blanking).
 */
export function parseQuotaSummary(body: unknown): QuotaGroup[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const groups = (body as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return null;
  const out: QuotaGroup[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object" || Array.isArray(g)) continue;
    const group = g as { displayName?: unknown; buckets?: unknown };
    if (typeof group.displayName !== "string" || !group.displayName) continue;
    const buckets: QuotaBucket[] = [];
    if (Array.isArray(group.buckets)) {
      for (const b of group.buckets) {
        if (!b || typeof b !== "object" || Array.isArray(b)) continue;
        const bucket = b as { bucketId?: unknown; displayName?: unknown; window?: unknown; resetTime?: unknown; remainingFraction?: unknown; disabled?: unknown };
        if (typeof bucket.remainingFraction !== "number" || !Number.isFinite(bucket.remainingFraction)) continue;
        if (typeof bucket.window !== "string" || !bucket.window) continue;
        buckets.push({
          bucketId: typeof bucket.bucketId === "string" ? bucket.bucketId : "",
          displayName: typeof bucket.displayName === "string" ? bucket.displayName : "",
          window: bucket.window,
          ...(typeof bucket.resetTime === "string" ? { resetTime: bucket.resetTime } : {}),
          ...(typeof bucket.disabled === "boolean" ? { disabled: bucket.disabled } : {}),
          remainingFraction: bucket.remainingFraction,
        });
      }
    }
    if (buckets.length) out.push({ displayName: group.displayName, buckets });
  }
  return out;
}

/** One window the `/api/limits` endpoint reads: the shape the mod's limits row instruments. */
export type GoogleWindow = {
  kind: "five_hour" | "seven_day" | "scoped" | "window";
  label?: string;
  used_percent: number;
  window_minutes?: number;
  /** epoch seconds */
  reset_at?: number;
};

/** The window length in minutes, from the endpoint's own name ("5h", "weekly"). */
function windowMinutes(window: string): number | undefined {
  if (window === "5h") return FIVE_HOURS;
  if (window === "weekly") return WEEK;
  return undefined;
}

const RANK: Record<string, number> = { five_hour: 0, seven_day: 1, scoped: 2, window: 3 };
/** Five-hour, then weekly, then the rest: the same order the row shows Claude's own windows in. */
function ordered(windows: GoogleWindow[]): GoogleWindow[] {
  return windows.map((w, i) => [w, i] as const).sort((a, b) => (RANK[a[0].kind]! - RANK[b[0].kind]!) || (a[1] - b[1])).map(([w]) => w);
}

/**
 * The endpoint's groups as windows the limits row reads. "Gemini Models" carries the plan's own
 * five-hour and weekly windows; "Gemini 4 Argon" has its own scoped weekly window. Other groups
 * (the measured "Claude and GPT models") are shown as `scoped` "3P" with their window length.
 */
export function googleWindowsFromGroups(groups: readonly QuotaGroup[]): GoogleWindow[] {
  const out: GoogleWindow[] = [];
  for (const group of groups) {
    const argon = group.displayName.trim().toLowerCase() === ARGON_GROUP.name;
    const gemini = /gemini/i.test(group.displayName);
    for (const bucket of group.buckets) {
      const minutes = windowMinutes(bucket.window);
      const used = Math.round((1 - bucket.remainingFraction) * 1000) / 10;
      const at = bucket.resetTime ? Math.round(Date.parse(bucket.resetTime) / 1000) : NaN;
      const reset = Number.isFinite(at) ? { reset_at: at } : {};
      if (argon) {
        const weekly = bucket.window === "weekly" && bucket.bucketId === ARGON_GROUP.ids.weekly;
        out.push({ kind: "scoped", label: weekly ? "Argon weekly" : "Argon", used_percent: used, ...(minutes !== undefined ? { window_minutes: minutes } : {}), ...reset });
      } else if (gemini) {
        const kind: GoogleWindow["kind"] = bucket.window === "5h" ? "five_hour" : bucket.window === "weekly" ? "seven_day" : "window";
        out.push({ kind, used_percent: used, ...(minutes !== undefined ? { window_minutes: minutes } : {}), ...reset });
      } else {
        out.push({ kind: "scoped", label: "3P", used_percent: used, ...(minutes !== undefined ? { window_minutes: minutes } : {}), ...reset });
      }
    }
  }
  return ordered(out);
}

/** What the last successful lookup of one account and host said, kept only to answer hasRemainingQuota. */
type HostEvidence = { observedAt: number; groups: QuotaGroup[] };
type QuotaEvidence = { projectId: string; hosts: Map<string, HostEvidence> };

/**
 * Merge the groups read from several hosts into one set for the limits row. Each host keeps its own
 * count, so the same window kind can read differently on each; when both hosts are in use the row
 * shows the **higher used percent** of the two (the lower remaining fraction), because that is the
 * quota a person is closest to running out of. The preferred host's bucket wins a tie.
 */
export function mergeHostGroups(perHost: readonly QuotaGroup[][]): QuotaGroup[] {
  const groups = new Map<string, Map<string, QuotaBucket>>();
  for (const hostGroups of perHost) {
    for (const group of hostGroups) {
      let buckets = groups.get(group.displayName);
      if (!buckets) groups.set(group.displayName, (buckets = new Map()));
      for (const bucket of group.buckets) {
        const key = `${bucket.window}\u0000${bucket.bucketId}`;
        const existing = buckets.get(key);
        if (!existing || bucket.remainingFraction < existing.remainingFraction) buckets.set(key, bucket);
      }
    }
  }
  return [...groups].map(([displayName, buckets]) => ({ displayName, buckets: [...buckets.values()] }));
}

/**
 * The whole body as groups, or null when ANY group or bucket is malformed. The display parser drops
 * what it cannot read; evidence must not, because a dropped bucket could be the exhausted one.
 */
function strictQuotaGroups(body: unknown): QuotaGroup[] | null {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(body) || !Array.isArray(body.groups)) return null;
  const out: QuotaGroup[] = [];
  for (const g of body.groups) {
    if (!isObject(g) || typeof g.displayName !== "string" || !g.displayName || !Array.isArray(g.buckets)) return null;
    const buckets: QuotaBucket[] = [];
    for (const b of g.buckets) {
      if (!isObject(b) || typeof b.bucketId !== "string" || typeof b.window !== "string" || !b.window) return null;
      if (typeof b.remainingFraction !== "number" || !Number.isFinite(b.remainingFraction)) return null;
      if (b.resetTime !== undefined && typeof b.resetTime !== "string") return null;
      if (b.disabled !== undefined && typeof b.disabled !== "boolean") return null;
      buckets.push({ bucketId: b.bucketId, displayName: typeof b.displayName === "string" ? b.displayName : "", window: b.window, ...(typeof b.resetTime === "string" ? { resetTime: b.resetTime } : {}), ...(typeof b.disabled === "boolean" ? { disabled: b.disabled } : {}), remainingFraction: b.remainingFraction });
    }
    out.push({ displayName: g.displayName, buckets });
  }
  return out;
}

/** The measured group names and their required bucket ids; Argon on Pro has only a weekly bucket. */
const GEMINI_GROUP = { name: "gemini models", ids: { "5h": "gemini-5h", weekly: "gemini-weekly" } };
const THIRD_PARTY_GROUP = { name: "claude and gpt models", ids: { "5h": "3p-5h", weekly: "3p-weekly" } };
const ARGON_GROUP = { name: "gemini 4 argon", ids: { weekly: "gemini-argon-wtu-weekly" } };

/**
 * The quota group a model draws on, as a pool scope (pool.ts): `argon` for gemini-4-argon*,
 * `hydrogen` for gemini-4-hydrogen* (a scope without a measured summary group),
 * `gemini` for other gemini-*, `3p` for claude-* and gpt-oss*, undefined otherwise. A Gemini model
 * that the provider's catalogue (`learned`) showed to be served to the CLI family alone has a scope
 * of its own, named for its family (`LearnedCatalogue.cliScope`), with no summary group either. A
 * base id and every wire id it resolves to share one scope, so a turn's scope does not depend on
 * which of them it is asked by. A spent group rests only its own models.
 */
export function antigravityQuotaScope(model: string, learned?: LearnedCatalogue): string | undefined {
  const id = model.toLowerCase().replace(/@[^@]*$/, "");
  // The CLI quota summary reports a separate "Gemini 4 Argon" weekly bucket on Pro (measured
  // 2026-10-28). Keep Argon's cooldown isolated; missing summary evidence never proves shared
  // Gemini quota or an Ultra plan. Catalogue quotaInfo is not quota evidence.
  if (/^gemini-4-argon(?:-|$)/.test(id)) return "argon";
  // Gemini 4 Hydrogen has a scope of its own and no summary group: the summary (measured
  // 2026-11-13, both hosts, CLI UA, one Pro account) reports none for it, and which bucket it draws
  // on is not measured. So a spent Hydrogen rests only Hydrogen, a spent Gemini group does not hide
  // it, and the ordinary Gemini windows are never its positive-quota evidence (`groupFor` knows no
  // group for this scope).
  if (/^gemini-4-hydrogen(?:-|$)/.test(id)) return "hydrogen";
  // The lists keep an id as Google wrote it, so they are asked by the id as given, not lowercased.
  const own = learned?.cliScope(model.replace(/@[^@]*$/, ""));
  if (own) return own;
  if (/^gemini-/.test(id)) return "gemini";
  if (/^claude-/.test(id) || /^gpt-oss(-|$)/.test(id)) return "3p";
  return undefined;
}

/** Match exactly one known group, without substituting general Gemini quota for absent Argon quota. */
function groupFor(groups: readonly QuotaGroup[], model: string, learned?: LearnedCatalogue): { group: QuotaGroup; ids: Record<string, string> } | undefined {
  const scope = antigravityQuotaScope(model, learned);
  const known = scope === "argon" ? ARGON_GROUP : scope === "gemini" ? GEMINI_GROUP : scope === "3p" ? THIRD_PARTY_GROUP : undefined;
  if (!known) return undefined;
  const found = groups.filter((g) => g.displayName.trim().toLowerCase() === known.name);
  return found.length === 1 ? { group: found[0]!, ids: known.ids } : undefined;
}

/** Exactly the required enabled buckets, each with finite 0 < fraction <= 1 and a future reset. */
function groupHasQuota(group: QuotaGroup, ids: Record<string, string>, now: number): boolean {
  const required = Object.entries(ids);
  if (group.buckets.length !== required.length) return false;
  return required.every(([window, id]) => {
    const matches = group.buckets.filter((b) => b.window === window && b.bucketId === id);
    const bucket = matches[0];
    if (matches.length !== 1 || !bucket || bucket.disabled) return false;
    if (!Number.isFinite(bucket.remainingFraction) || bucket.remainingFraction <= 0 || bucket.remainingFraction > 1) return false;
    const reset = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN;
    return Number.isFinite(reset) && reset > now;
  });
}

type UsageSource = { credentials(): Promise<GoogleCredential[]> };
type UsageOptions = {
  /** The Cloud Code Assist host the requests go to by default (transport.ts antigravityBaseUrl). */
  baseUrl?: string;
  /**
   * Every host whose quota the limits row reads, in preference order: the hosts the selected models
   * live on. Each host counts its own quota (measured 2026-10-20), so one host's numbers say nothing
   * about the other's. Read fresh on each refresh; defaults to just `baseUrl`.
   */
  hosts?: () => readonly string[];
  /** What the provider's catalogue showed about models outside the tables, for `hasRemainingQuota`'s scope. */
  learned?: LearnedCatalogue;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  warn?: (message: string) => void;
};

/**
 * Per-account quota groups, fetched at most once per `ttlMs` per account and host. A failed lookup of
 * one host keeps that host's last good groups rather than blanking them, and only the status code is
 * logged.
 */
export class GoogleUsage {
  private readonly last = new Map<string, QuotaGroup[]>();
  /** Per account, only the last SUCCESSFUL lookup of each host; dropped as soon as that lookup fails. */
  private readonly evidence = new Map<string, QuotaEvidence>();
  private inFlight: Promise<Record<string, QuotaGroup[]>> | null = null;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private readonly source: UsageSource;
  private readonly opts: UsageOptions;

  constructor(source: UsageSource, opts: UsageOptions) {
    this.source = source;
    this.opts = opts;
  }

  /** The hosts to read: those a selected model is sent to, else the default host alone. */
  private hosts(): string[] {
    const configured = this.opts.hosts?.() ?? [];
    return configured.length ? [...configured] : [this.opts.baseUrl ?? GOOGLE_OAUTH.dailyApi];
  }

  /** Groups by account owner id, from the store's own account ids. */
  snapshot(): Promise<Record<string, QuotaGroup[]>> {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.fetchedAt < (this.opts.ttlMs ?? 5 * 60_000)) return Promise.resolve(Object.fromEntries(this.last));
    this.inFlight ??= this.fetchAll().finally(() => {
      this.fetchedAt = (this.opts.now ?? Date.now)();
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Whether the cached quota still shows room for `model` on this account and project, **on the host
   * the model's requests are sent to**. Reads the cache only (never fetches), and is true only when
   * the last refresh of that account and host succeeded within the TTL, the model's group is
   * recognized, and every required bucket (weekly alone for Argon, 5h and weekly otherwise) is
   * enabled with a remaining fraction in (0, 1] and a future reset. Everything else is false:
   * this is positive evidence, not a guess, so "false"
   * means "unknown or spent", not "refused".
   */
  hasRemainingQuota(credential: Pick<GoogleCredential, "ownerId" | "projectId">, model: string, host?: string, learned: LearnedCatalogue | undefined = this.opts.learned): boolean {
    const evidence = this.evidence.get(credential.ownerId);
    if (!evidence || evidence.projectId !== credential.projectId) return false;
    const target = evidence.hosts.get(host ?? this.opts.baseUrl ?? GOOGLE_OAUTH.dailyApi);
    if (!target) return false;
    const now = (this.opts.now ?? Date.now)();
    const age = now - target.observedAt;
    if (!(age >= 0 && age < (this.opts.ttlMs ?? 5 * 60_000))) return false;
    const match = groupFor(target.groups, model, learned);
    return !!match && groupHasQuota(match.group, match.ids, now);
  }

  private async fetchAll(): Promise<Record<string, QuotaGroup[]>> {
    let credentials: GoogleCredential[];
    try {
      credentials = await this.source.credentials();
    } catch (e) {
      this.opts.warn?.(`google usage: no credentials: ${(e as Error).message}`);
      this.evidence.clear();
      return Object.fromEntries(this.last);
    }
    const hosts = this.hosts();
    // Each host keeps its own count, so every host is read; a host that fails leaves its last good
    // numbers on screen but voids its own evidence.
    await Promise.all(credentials.map(async (credential) => {
      // Each account keeps its own read time: one account's lookup can fail while another's succeeds.
      const readAt = (this.opts.now ?? Date.now)();
      const fetched = await Promise.all(hosts.map(async (host) => [host, await this.fetchOne(credential, host)] as const));
      const shown = new Map<string, QuotaGroup[]>();
      const proven = new Map<string, HostEvidence>();
      for (const [host, answer] of fetched) {
        if (!answer) continue;
        shown.set(host, answer.groups);
        if (answer.strict) proven.set(host, { observedAt: (this.opts.now ?? Date.now)(), groups: answer.strict });
      }
      if (shown.size > 0) this.last.set(credential.ownerId, mergeHostGroups([...shown.values()]).map((g) => ({ ...g, read_at: readAt })));
      if (proven.size > 0) this.evidence.set(credential.ownerId, { projectId: credential.projectId, hosts: proven });
      // The displayed numbers stay but prove nothing when no host answered.
      else this.evidence.delete(credential.ownerId);
    }));
    // An account that was removed must not keep its old numbers on the screen.
    const owners = new Set(credentials.map((c) => c.ownerId));
    for (const owner of [...this.last.keys()]) if (!owners.has(owner)) this.last.delete(owner);
    for (const owner of [...this.evidence.keys()]) if (!owners.has(owner)) this.evidence.delete(owner);
    return Object.fromEntries(this.last);
  }

  private async fetchOne(credential: GoogleCredential, host: string): Promise<{ groups: QuotaGroup[]; strict: QuotaGroup[] | null } | null> {
    const cli = await this.fetchAs(credential, host, antigravityCliUserAgent());
    if (cli) return cli;
    const ide = await this.fetchAs(credential, host, antigravityUserAgent());
    if (!ide) return null;
    // The IDE response does not establish Argon's quota. Keep the other groups for existing
    // accounts, but never carry an older CLI answer or infer shared quota from the missing group.
    const withoutArgon = (g: QuotaGroup) => g.displayName.trim().toLowerCase() !== ARGON_GROUP.name;
    return { groups: ide.groups.filter(withoutArgon), strict: ide.strict?.filter(withoutArgon) ?? null };
  }

  private async fetchAs(credential: GoogleCredential, host: string, userAgent: string): Promise<{ groups: QuotaGroup[]; strict: QuotaGroup[] | null } | null> {
    const owner = credential.ownerId.slice(0, 8);
    try {
      const res = await (this.opts.fetch ?? fetch)(`${host}/${GOOGLE_OAUTH.apiVersion}:retrieveUserQuotaSummary`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential.accessToken}`, "content-type": "application/json", accept: "*/*", "user-agent": userAgent },
        body: JSON.stringify({ project: credential.projectId }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        // The status alone: the body of an auth failure is not worth the risk of echoing.
        this.opts.warn?.(`google usage ${owner}: HTTP ${res.status} on ${new URL(host).host}`);
        return null;
      }
      const body: unknown = await res.json();
      const groups = parseQuotaSummary(body);
      return groups ? { groups, strict: strictQuotaGroups(body) } : null;
    } catch (e) {
      this.opts.warn?.(`google usage ${owner}: ${(e as Error).message}`);
      return null;
    }
  }
}
