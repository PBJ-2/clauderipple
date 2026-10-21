// How much of an OpenCode Go subscription is used, for the status bar's limits row.
//
// One request per provider: GET {provider.url}/usage (measured 2026-10-15: https://opencode.ai/zen/go/v1/usage)
// with the provider's own config headers (the bearer key) and the same default User-Agent Node's
// fetch sends elsewhere — Cloudflare answers 403 `error 1010` to a request carrying no User-Agent
// and no browser fingerprint, but accepts Node's fetch as it is. Source of the route (behavioral
// only, no code copied): anomalyco/opencode packages/console/app/src/routes/zen/go/v1/usage.ts and
// lib/inference-proxy.ts (the `GET /zen/go/v1/usage` → `/go/v1/usage` mapping).
//
// Measured answer:
//   {"usage":{"rolling":{"status":"ok","percent":3,"resetsAt":"2026-10-15T05:39:48Z"},
//             "weekly":{"status":"ok","percent":52,"resetsAt":"2026-10-19T00:00:00Z"},
//             "monthly":{"status":"ok","percent":92,"resetsAt":"2026-10-18T05:43:30Z"}}}
// `rolling` is the five-hour window, `weekly` the week, `monthly` roughly 30 days.

import type { FetchLike } from "./google/antigravity.ts";
import { MAX_COOLDOWN_MS } from "../pool.ts";

/** The five-hour, weekly and ~monthly window lengths in minutes. */
const FIVE_HOURS = 5 * 60;
const WEEK = 7 * 24 * 60;
const MONTH = 30 * 24 * 60;

/** One window the `/api/limits` endpoint reads. */
export type OpenCodeWindow = { kind: "five_hour" | "seven_day" | "window"; used_percent: number; window_minutes?: number; reset_at?: number };

/** One credential's windows: the account entry `/api/limits` lists for it. */
export type OpenCodeLimit = { id: string; label?: string; windows: OpenCodeWindow[] };

/**
 * One key as the dashboard's account card shows it (`GET /api/opencode-accounts`). Ids and labels
 * only; the headers that carry the key are never rendered or logged. (The config endpoint still
 * serves the provider's `credentials` as it always has; that is not what this shape is for.)
 *
 * - `in-use` — the key new conversations go to right now (first usable in configured order)
 * - `standby` — usable, with another key ahead of it
 * - `cooling` — a usage window is full or the vendor refused it; `cooldown_seconds` counts to the reset
 * - `paused` — taken out of rotation from the dashboard
 * - `quarantined` — the vendor rejected it as an auth failure
 * - `unknown` — its usage has never been read, so nothing can be said about it yet
 */
export type OpenCodeAccountState = {
  id: string;
  label?: string;
  state: "in-use" | "standby" | "cooling" | "paused" | "quarantined" | "unknown";
  cooldown_seconds?: number;
  /** When the usage snapshot was taken, epoch ms; 0 when there is none. */
  at: number;
  windows: OpenCodeWindow[];
};

/** The window lengths and read order of the endpoint's three keys. */
const KEYS: { key: string; kind: OpenCodeWindow["kind"]; window_minutes: number }[] = [
  { key: "rolling", kind: "five_hour", window_minutes: FIVE_HOURS },
  { key: "weekly", kind: "seven_day", window_minutes: WEEK },
  { key: "monthly", kind: "window", window_minutes: MONTH },
];

/**
 * Parse the `/usage` body into windows. A window missing a finite percent is dropped; null when the
 * body carries no `usage` object at all (so the caller keeps its last good answer instead of
 * blanking).
 */
export function opencodeWindowsFromBody(body: unknown): OpenCodeWindow[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const source = usage as Record<string, unknown>;
  const out: OpenCodeWindow[] = [];
  for (const { key, kind, window_minutes } of KEYS) {
    const w = source[key];
    if (!w || typeof w !== "object" || Array.isArray(w)) continue;
    const win = w as { percent?: unknown; resetsAt?: unknown };
    if (typeof win.percent !== "number" || !Number.isFinite(win.percent)) continue;
    const at = typeof win.resetsAt === "string" ? Date.parse(win.resetsAt) : NaN;
    out.push({ kind, used_percent: win.percent, window_minutes, ...(Number.isFinite(at) ? { reset_at: Math.round(at / 1000) } : {}) });
  }
  return out.length ? out : null;
}

/** Whether a provider is an OpenCode Go subscription: its preset, or an OpenCode Go endpoint. */
export function isOpenCodeGo(p: { type: string; url?: string; preset?: string }): boolean {
  if (p.type === "openai-compatible" && p.preset === "opencode-go") return true;
  if (typeof p.url !== "string") return false;
  try {
    const url = new URL(p.url);
    return url.hostname === "opencode.ai" && /^\/zen\/go\/v1(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

/** How long a full window with no stated reset parks a key: one usage-cache period. */
const STALE_MS = 5 * 60_000;

/**
 * When a refused request may be repeated, in epoch ms, from what the vendor stated: a `retry-after`
 * already read from the headers, or a reset field in the body.
 *
 * OpenCode Go's own console proxies the inference backend's response through unchanged (see the
 * module comment), so the body of a 429 is the backend's, and no single shape is documented. Rather
 * than guess one, every field that vendors use for this is read, at any depth of a small JSON body.
 * Nothing here is invented: with no usable field the answer is undefined and the caller falls back
 * to its own delay.
 */
/**
 * A refusal's reset as epoch ms, never further away than the pool's own ceiling: a refusal is about
 * this key right now, and a reset days out that it claims is more likely a misread field than a real
 * wait. (A usage window's own reset is a different matter and is not clamped here — see
 * `spentWindowReset`.)
 */
export function refusalResetAt(body: string, now: number, headerMs?: number): number | undefined {
  if (headerMs !== undefined && headerMs > 0) return clampReset(now + headerMs, now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const keys = new Set(["resetsat", "reset_at", "resets_at", "resetat", "reset", "retry_after", "retryafter", "retry_after_seconds"]);
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): number | undefined => {
    if (!value || typeof value !== "object" || depth > 3 || seen.has(value)) return undefined;
    seen.add(value);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(key.toLowerCase().replace(/[- ]/g, "_"))) {
        const at = moment(entry, now);
        if (at !== undefined) return at;
      }
      if (entry && typeof entry === "object") {
        const nested = walk(entry, depth + 1);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  };
  const found = walk(parsed, 0);
  return found === undefined ? undefined : clampReset(found, now);
}

/** A reset further away than the pool would ever cool for is held to that ceiling instead. */
function clampReset(at: number, now: number): number {
  return Math.min(at, now + MAX_COOLDOWN_MS);
}

/**
 * A reset field as epoch ms: an ISO date, epoch seconds/ms, or a number of seconds from now.
 *
 * A numeric *string* is the same thing as the number — the fields these APIs use are sometimes
 * quoted in JSON. Reading it with `Date.parse` instead was not a small mistake: `"3600"` parses as
 * the year 3600, and that key was parked until then.
 */
function moment(value: unknown, now: number): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return moment(Number(trimmed), now);
    const at = Date.parse(trimmed);
    return Number.isFinite(at) && at > now ? at : undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // A magnitude decides the unit: these APIs state epoch seconds or milliseconds, and a small
  // number is a delay in seconds (the `retry_after` convention). An epoch already behind `now` is
  // the same stale snapshot the ISO branch refuses: it is not a wait, and returning it made the
  // key look parked at a moment that had passed.
  if (value > 1e12) return value > now ? value : undefined;
  if (value > 1e9) return value * 1000 > now ? value * 1000 : undefined;
  return now + value * 1000;
}

/**
 * When a spent key becomes usable again, or null when no window in this snapshot is full.
 * `percent` is what the account has already used, and Go's own docs say a request is refused once a
 * window is at its limit (5-hour = 20% of the monthly limit, weekly = 50%, monthly = 100%). The key
 * reopens when the last full window resets: a weekly window at 100% keeps a key out even after its
 * five-hour window has rolled over. A full window with no reset time cannot be planned around, so it
 * parks the key for one usage-cache period — the next read either finds it cleared or states the
 * time. A reset already in the past is a stale snapshot: it says nothing about right now.
 */
export function spentWindowReset(windows: readonly OpenCodeWindow[], now: number): number | null {
  let until = 0;
  for (const w of windows) {
    if (w.used_percent < 100) continue;
    const reset = w.reset_at !== undefined ? w.reset_at * 1000 : now + STALE_MS;
    if (reset > now && reset > until) until = reset;
  }
  return until > now ? until : null;
}

type UsageOptions = { fetch?: FetchLike; now?: () => number; ttlMs?: number; timeoutMs?: number; warn?: (message: string) => void };

/**
 * Per-provider usage windows, fetched at most once per `ttlMs` per provider. A failed lookup keeps
 * the last good windows rather than blanking them — a blank answer would read as "this key is fine"
 * in the account cards, which is the opposite of what a failed read says — and only the status code
 * is logged.
 */
export class OpenCodeUsage {
  private readonly last = new Map<string, OpenCodeWindow[]>();
  /** When the last *good* snapshot was taken: a failed read keeps the old windows and their age. */
  private readonly goodAt = new Map<string, number>();
  private readonly at = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<OpenCodeWindow[]>>();
  private readonly opts: UsageOptions;

  constructor(opts: UsageOptions) {
    this.opts = opts;
  }

  /** The provider's windows, cached for `ttlMs`; the last good ones survive a failed lookup. */
  windows(name: string, url: string, headers: Record<string, string>): Promise<OpenCodeWindow[]> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.ttlMs ?? 5 * 60_000;
    if (now - (this.at.get(name) ?? Number.NEGATIVE_INFINITY) < ttl) return Promise.resolve(this.last.get(name) ?? []);
    const running = this.inFlight.get(name);
    if (running) return running;
    const task = this.fetchOne(name, url, headers).finally(() => {
      this.at.set(name, (this.opts.now ?? Date.now)());
      this.inFlight.delete(name);
    });
    this.inFlight.set(name, task);
    return task;
  }

  /**
   * The last answer for this key, without ever fetching. This is what a request path may look at:
   * a turn must not wait on a second request to answer whether a key is spent.
   */
  peek(name: string): OpenCodeWindow[] | undefined {
    return this.last.get(name);
  }

  /** When that same last answer was taken, or 0 when this key has never been read successfully. */
  readAt(name: string): number {
    return this.goodAt.get(name) ?? 0;
  }

  /**
   * Read one key's usage again now, ignoring the cache but not doubling a lookup already running.
   * Used when the vendor has just refused a key with a 429: the cached snapshot is by definition the
   * one that said this key was fine, so only a fresh one can say when it comes back.
   */
  refresh(name: string, url: string, headers: Record<string, string>): Promise<OpenCodeWindow[]> {
    const running = this.inFlight.get(name);
    if (running) return running;
    const task = this.fetchOne(name, url, headers).finally(() => {
      this.at.set(name, (this.opts.now ?? Date.now)());
      this.inFlight.delete(name);
    });
    this.inFlight.set(name, task);
    return task;
  }

  private async fetchOne(name: string, url: string, headers: Record<string, string>): Promise<OpenCodeWindow[]> {
    const keep = () => this.last.get(name) ?? [];
    try {
      const res = await (this.opts.fetch ?? fetch)(`${url.replace(/\/+$/, "")}/usage`, {
        method: "GET",
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        // The status alone: the body of an auth failure is not worth the risk of echoing.
        this.opts.warn?.(`opencode usage ${name}: HTTP ${res.status}`);
        return keep();
      }
      const windows = opencodeWindowsFromBody(await res.json());
      if (!windows) return keep();
      this.last.set(name, windows);
      this.goodAt.set(name, (this.opts.now ?? Date.now)());
      return windows;
    } catch (e) {
      this.opts.warn?.(`opencode usage ${name}: ${(e as Error).message}`);
      return keep();
    }
  }
}
