// How much prepaid credit a provider has left, for the status bar's limits row.
//
// Only vendors that sell credit and publish a read for it are read here; a subscription that counts
// windows (OpenCode Go, Claude, ChatGPT, Gemini, Grok) keeps its own reader. Two shapes:
//
//   sail        GET https://api.sailresearch.com/v2/usage/summary?range=30d
//               {"balance": 73795, "days_remaining": 12.3, ...} — `balance` is fractional USD
//               cents, so 73795 is $737.95. A body that says `balance_unavailable` is skipped
//               rather than read as a balance of zero. Source (behavioral only):
//               https://docs.sailresearch.com/usage-endpoints.md
//   OpenRouter  GET https://openrouter.ai/api/v1/credits
//               {"data": {"total_credits": 100, "total_usage": 20}} — remaining is the difference.
//               When that read fails, GET /api/v1/key's `limit_remaining` is the fallback (null there
//               means the key has no limit, which says nothing about a balance).
//               Source: openrouter.ai/docs/api/api-reference/credits/get-remaining-credits.md,
//               openrouter.ai/docs/api/api-reference/limits.md
//
// Measured 2026-10-21: `/api/v1/credits` answers 200 with an inference key although the docs name a
// management key, so the provider's own key is what is sent.
//
// Only the status is ever logged: a balance is money, and the key that asked for it stays where it
// already was. Nothing here runs on the request path: `/api/limits`, the key cards and the router's
// five-minute re-read of parked keys are the only callers.

import type { FetchLike } from "./google/antigravity.ts";

/** A provider's remaining credit. `low` is what the tile warns for. */
export type CreditBalance = { remaining_usd: number; days_remaining?: number; low: boolean };

/** A balance and when it was read (epoch ms), as `/api/limits` lists it. */
export type CreditLimit = { credit: CreditBalance; at: number };

/** The warning threshold: under $5 left, or under three days of it at the current rate. */
const LOW_USD = 5;
const LOW_DAYS = 3;

export function lowCredit(remainingUsd: number, daysRemaining?: number): boolean {
  return remainingUsd < LOW_USD || (daysRemaining !== undefined && daysRemaining < LOW_DAYS);
}

export type CreditVendor = "sail" | "openrouter";

/** The balance reader a provider's endpoint belongs to, or null when it sells no credit. */
export function creditVendor(p: object): CreditVendor | null {
  const url = (p as { url?: unknown }).url;
  if (typeof url !== "string") return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "api.sailresearch.com") return "sail";
    if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  } catch {
    return null;
  }
  return null;
}

/** A finite number, or the number a JSON string spells, or null. */
function numberIn(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function objectIn(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Sail's usage summary as a balance in USD, or null when it does not state one. */
export function sailBalanceFromBody(body: unknown): CreditBalance | null {
  const o = objectIn(body);
  if (!o || o.balance_unavailable) return null;
  const cents = numberIn(o.balance);
  if (cents === null) return null;
  // Fractional cents to dollars, rounded to the cent.
  const remaining = Math.round(cents) / 100;
  const days = numberIn(o.days_remaining);
  return { remaining_usd: remaining, ...(days !== null ? { days_remaining: days } : {}), low: lowCredit(remaining, days ?? undefined) };
}

/** OpenRouter's credits read as a balance, or null when it does not state both totals. */
export function openRouterCreditsFromBody(body: unknown): CreditBalance | null {
  const data = objectIn(objectIn(body)?.data);
  if (!data) return null;
  const total = numberIn(data.total_credits);
  const used = numberIn(data.total_usage);
  if (total === null || used === null) return null;
  const remaining = Math.round((total - used) * 100) / 100;
  return { remaining_usd: remaining, low: lowCredit(remaining) };
}

/** OpenRouter's key read as a balance, when the key has a stated limit. */
export function openRouterKeyFromBody(body: unknown): CreditBalance | null {
  const data = objectIn(objectIn(body)?.data);
  if (!data) return null;
  const remaining = numberIn(data.limit_remaining);
  if (remaining === null) return null;
  const rounded = Math.round(remaining * 100) / 100;
  return { remaining_usd: rounded, low: lowCredit(rounded) };
}

type CreditOptions = { fetch?: FetchLike; now?: () => number; ttlMs?: number; timeoutMs?: number; warn?: (message: string) => void };

/**
 * Per-provider credit balance, fetched at most once per `ttlMs` per provider. A failed read keeps
 * the last good balance — a blank one would read to the tile as "no credit", which is a different
 * thing from "could not read it" — and only the status code is logged.
 */
export class CreditBalances {
  private readonly last = new Map<string, CreditBalance>();
  /** When the last *good* read was taken; a failed read does not move it. */
  private readonly goodAt = new Map<string, number>();
  private readonly at = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<CreditBalance | null>>();
  private readonly opts: CreditOptions;

  constructor(opts: CreditOptions) {
    this.opts = opts;
  }

  /** The provider's balance, cached for `ttlMs`; the last good one survives a failed read. */
  balance(name: string, vendor: CreditVendor, headers: Record<string, string>): Promise<CreditBalance | null> {
    return this.read(name, vendor, headers, false);
  }

  /**
   * The next read even when the cached one is still fresh. For the parked-key re-read: a key is held
   * out for exactly one cache period, and asking for the same cached "nothing left" would never be
   * able to release it. Still one read at a time per key.
   */
  refresh(name: string, vendor: CreditVendor, headers: Record<string, string>): Promise<CreditBalance | null> {
    return this.read(name, vendor, headers, true);
  }

  private read(name: string, vendor: CreditVendor, headers: Record<string, string>, force: boolean): Promise<CreditBalance | null> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.ttlMs ?? 5 * 60_000;
    if (!force && now - (this.at.get(name) ?? Number.NEGATIVE_INFINITY) < ttl) return Promise.resolve(this.last.get(name) ?? null);
    const running = this.inFlight.get(name);
    if (running) return running;
    const task = this.fetchOne(name, vendor, headers).finally(() => {
      this.at.set(name, (this.opts.now ?? Date.now)());
      this.inFlight.delete(name);
    });
    this.inFlight.set(name, task);
    return task;
  }

  /** The last balance for this provider without fetching, or undefined. */
  peek(name: string): CreditBalance | undefined {
    return this.last.get(name);
  }

  /** When that balance was read, or 0 when this provider has never been read successfully. */
  readAt(name: string): number {
    return this.goodAt.get(name) ?? 0;
  }

  /** How long an answer is trusted. Callers that park a key on an empty balance need to know when
   * the next read — the one that could release it — is due. */
  ttlMs(): number {
    return this.opts.ttlMs ?? 5 * 60_000;
  }

  private async fetchOne(name: string, vendor: CreditVendor, headers: Record<string, string>): Promise<CreditBalance | null> {
    const keep = () => this.last.get(name) ?? null;
    const get = (url: string) => (this.opts.fetch ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
    });
    try {
      const urls = vendor === "sail"
        ? ["https://api.sailresearch.com/v2/usage/summary?range=30d"]
        : ["https://openrouter.ai/api/v1/credits", "https://openrouter.ai/api/v1/key"];
      for (const [index, url] of urls.entries()) {
        let balance: CreditBalance | null = null;
        try {
          const res = await get(url);
          if (!res.ok) {
            // The status alone: a body from a vendor can carry anything, including the key.
            this.opts.warn?.(`credit balance ${name}: HTTP ${res.status}`);
          } else {
            const body: unknown = await res.json();
            balance = vendor === "sail"
              ? sailBalanceFromBody(body)
              : index === 0 ? openRouterCreditsFromBody(body) : openRouterKeyFromBody(body);
          }
        } catch (e) {
          this.opts.warn?.(`credit balance ${name}: ${(e as Error).message}`);
        }
        if (balance) {
          this.last.set(name, balance);
          this.goodAt.set(name, (this.opts.now ?? Date.now)());
          return balance;
        }
      }
      return keep();
    } catch {
      return keep();
    }
  }
}
