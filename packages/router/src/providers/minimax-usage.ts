// How much of a MiniMax M Plan subscription is used, for the status bar's limits row.
//
// One request per provider: GET {origin}/v1/api/openplatform/coding_plan/remains (measured
// 2026-11-08 with a real M Plan key: https://api.minimax.io/v1/api/openplatform/coding_plan/remains)
// with the plan's own key as `Authorization: Bearer <key>` — the key the Anthropic-compatible
// provider sends as `x-api-key`. The origin comes from the provider's url, so the China region
// (api.minimaxi.com) reads its own host. The endpoint is undocumented by MiniMax; the shape below
// is what it answered.
//
// Measured answer:
//   {"model_remains":[{"start_time":1794108007151,"end_time":1794126007151,"remains_time":16502432,
//     "current_interval_total_count":0,"current_interval_usage_count":0,"model_name":"general",
//     "current_weekly_total_count":0,"current_weekly_usage_count":0,"weekly_start_time":1794108007151,
//     "weekly_end_time":1794712807151,"weekly_remains_time":603302432,"current_interval_status":1,
//     "current_interval_remaining_percent":91,"current_weekly_status":1,"current_weekly_remaining_percent":99}],
//    "base_resp":{"status_code":0,"status_msg":"success"}}
// The plan counts time, not calls: the *_count fields are 0, so the share used comes from the
// *_remaining_percent fields. `current_interval_*` is the five-hour window, `current_weekly_*` the
// week, and `end_time`/`weekly_end_time` (epoch milliseconds) are their resets.

import { createHash } from "node:crypto";
import type { FetchLike } from "./google/antigravity.ts";
import { UsageCache, type UsageWindow } from "./usage-cache.ts";

/** The five-hour and weekly window lengths in minutes. */
const FIVE_HOURS = 5 * 60;
const WEEK = 7 * 24 * 60;

/** One window the `/api/limits` endpoint reads. */
export type MiniMaxWindow = UsageWindow;

/** The path the plan's remaining quota is read from, on the provider's own origin. */
const REMAINS_PATH = "/v1/api/openplatform/coding_plan/remains";

/**
 * The plan's key, read from the provider's own headers: the `x-api-key` the Anthropic-compatible
 * wire sends, or the token inside an `authorization: Bearer …` header. Never logged.
 */
export function minimaxKey(headers: Record<string, string>): string | undefined {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const apiKey = lower.get("x-api-key")?.trim();
  if (apiKey) return apiKey;
  const auth = lower.get("authorization")?.trim();
  if (!auth) return undefined;
  // The bearer prefix comes off before the value is trimmed, so a header that carries the prefix
  // and no token is no key at all.
  const bearer = /^bearer\b\s*(.*)$/i.exec(auth);
  const token = (bearer ? bearer[1]! : auth).trim();
  return token || undefined;
}

/**
 * The request that reads the plan's remaining quota: the provider's own origin plus the remains
 * path, with the key as a bearer. Null when the url is not an address or the headers carry no key
 * (a provider without a key has no plan to read).
 */
export function minimaxQuotaRequest(providerUrl: string, headers: Record<string, string>): { url: string; headers: Record<string, string> } | null {
  let origin: string;
  try {
    origin = new URL(providerUrl).origin;
  } catch {
    return null;
  }
  const key = minimaxKey(headers);
  if (!key) return null;
  // The key goes out as the bearer the endpoint wants, whichever header the provider keeps it in.
  return { url: `${origin}${REMAINS_PATH}`, headers: { authorization: `Bearer ${key}` } };
}

/**
 * Parse the remains body into windows. The plan's own answer carries no `usage` object: the
 * windows are the share left of the five-hour and weekly quotas, so the share used is what is left
 * of a hundred. A body that carries no finite share (a refused request, a pay-as-you-go key that
 * is on no plan) gives null, so the caller keeps its last good answer instead of blanking it.
 */
export function minimaxWindowsFromBody(body: unknown): UsageWindow[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const source = body as { base_resp?: unknown; model_remains?: unknown };
  const resp = source.base_resp;
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return null;
  if ((resp as { status_code?: unknown }).status_code !== 0) return null;
  if (!Array.isArray(source.model_remains)) return null;
  const entries = source.model_remains.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry));
  if (!entries.length) return null;
  // The plan's own entry is the general one; a body without it answers for its first entry.
  const entry = entries.find((e) => e.model_name === "general") ?? entries[0]!;
  const five = windowFrom(entry, "current_interval_remaining_percent", "end_time", "five_hour", FIVE_HOURS);
  const weekly = windowFrom(entry, "current_weekly_remaining_percent", "weekly_end_time", "seven_day", WEEK);
  if (!five || !weekly) return null;
  return [five, weekly];
}

/** One window: the share used of the share left, and when it resets (epoch seconds). */
function windowFrom(entry: Record<string, unknown>, percentKey: string, endKey: string, kind: UsageWindow["kind"], window_minutes: number): UsageWindow | null {
  const remaining = entry[percentKey];
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  const end = entry[endKey];
  const reset = typeof end === "number" && Number.isFinite(end) ? Math.round(end / 1000) : undefined;
  return {
    kind,
    used_percent: Math.max(0, Math.min(100, 100 - remaining)),
    window_minutes,
    ...(reset !== undefined ? { reset_at: reset } : {}),
  };
}

/**
 * Whether a provider is a MiniMax plan: an Anthropic-compatible provider built from the MiniMax
 * preset, or one pointing at a MiniMax Anthropic endpoint (the China region answers on
 * api.minimaxi.com).
 */
export function isMiniMaxPlan(p: { type: string; url?: string; preset?: string }): boolean {
  if (p.type !== "anthropic-compatible") return false;
  if (p.preset === "minimax") return true;
  if (typeof p.url !== "string") return false;
  try {
    const url = new URL(p.url);
    return (url.hostname === "api.minimax.io" || url.hostname === "api.minimaxi.com") && /^\/anthropic(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

export type MiniMaxUsageOptions = { fetch?: FetchLike; now?: () => number; ttlMs?: number; timeoutMs?: number; warn?: (message: string) => void };

/**
 * Each MiniMax plan provider's usage windows, fetched at most once per `ttlMs` per provider. A
 * failed lookup keeps the last good windows rather than blanking them, and only the status code is
 * logged.
 */
export class MiniMaxUsage {
  private readonly cache: UsageCache;

  constructor(opts: MiniMaxUsageOptions) {
    this.cache = new UsageCache({ ...opts, label: "minimax usage" });
  }

  /** The provider's windows, cached for `ttlMs`; the last good ones survive a failed lookup. */
  windows(name: string, providerUrl: string, headers: Record<string, string>): Promise<UsageWindow[]> {
    const request = minimaxQuotaRequest(providerUrl, headers);
    if (!request) return Promise.resolve([]);
    // Cached per key, not only per provider: a key replaced in the dashboard (a plan for a
    // pay-as-you-go key, say) must not keep the old key's windows, which a no-plan answer would
    // otherwise preserve as the last good one. Only a digest of the key is kept.
    const keyId = createHash("sha256").update(request.headers.authorization!).digest("hex").slice(0, 16);
    return this.cache.windows(`${name}#${keyId}`, request.url, request.headers, minimaxWindowsFromBody);
  }
}
