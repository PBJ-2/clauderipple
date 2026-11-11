// A plan provider's quota windows, read once per provider and kept when a read fails.
//
// Shared by every provider whose quota lives behind its own endpoint (OpenCode Go's `/usage`,
// MiniMax M Plan's `coding_plan/remains`): one request per provider per TTL, one request in
// flight at a time, and the last good windows kept rather than blanked when a read fails.

import { createHash } from "node:crypto";
import { credentialHeaderValues, redactErrorText } from "../redact.ts";
import type { FetchLike } from "./google/antigravity.ts";

/**
 * One window a plan's quota is read from. `read_at` (epoch milliseconds) is when the request for the
 * reading was sent. The cache stamps it; a reading kept after a failed lookup keeps its own time. It is
 * internal: `/api/limits` strips it, so the forecast judges a cached reading at the time it was taken.
 */
export type UsageWindow = { kind: "five_hour" | "seven_day" | "window"; used_percent: number; window_minutes?: number; reset_at?: number; read_at?: number };

export type UsageCacheOptions = {
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  warn?: (message: string) => void;
  /** What the warnings name the reader by ("opencode usage", "minimax usage"). */
  label: string;
};

type UsageEntry = {
  identity: string;
  last: UsageWindow[];
  at: number;
  inFlight?: Promise<UsageWindow[]>;
};

/**
 * Per-provider usage windows, fetched at most once per `ttlMs` per request identity. A failed lookup
 * keeps only that identity's last good windows; changing its endpoint or headers starts empty.
 */
export class UsageCache {
  private readonly entries = new Map<string, UsageEntry>();
  private readonly opts: UsageCacheOptions;

  constructor(opts: UsageCacheOptions) {
    this.opts = opts;
  }

  /**
   * The provider's windows, cached for `ttlMs`; the last good ones survive a failed lookup.
   * `parse` answers the windows the body carries, or null when it carries none.
   */
  windows(name: string, url: string, headers: Record<string, string>, parse: (body: unknown) => UsageWindow[] | null): Promise<UsageWindow[]> {
    // Keep only a digest, never the credential-bearing request. Header order/casing is immaterial.
    const identity = createHash("sha256").update(JSON.stringify([
      url,
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]).sort(),
    ])).digest("hex");
    let entry = this.entries.get(name);
    if (!entry || entry.identity !== identity) {
      entry = { identity, last: [], at: Number.NEGATIVE_INFINITY };
      this.entries.set(name, entry);
    }
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.ttlMs ?? 5 * 60_000;
    if (now - entry.at < ttl) return Promise.resolve(entry.last);
    if (entry.inFlight) return entry.inFlight;
    // A replaced entry may still finish for its original caller, but cannot mutate its successor.
    const current = entry;
    const task = this.fetchOne(name, url, headers, parse, current).finally(() => {
      current.at = (this.opts.now ?? Date.now)();
      delete current.inFlight;
    });
    current.inFlight = task;
    return task;
  }

  private async fetchOne(name: string, url: string, headers: Record<string, string>, parse: (body: unknown) => UsageWindow[] | null, entry: UsageEntry): Promise<UsageWindow[]> {
    const keep = () => entry.last;
    const readAt = (this.opts.now ?? Date.now)();
    try {
      const res = await (this.opts.fetch ?? fetch)(url, {
        method: "GET",
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        // The status alone: the body of an auth failure is not worth the risk of echoing.
        this.opts.warn?.(`${this.opts.label} ${name}: HTTP ${res.status}`);
        return keep();
      }
      const parsed = parse(await res.json());
      if (!parsed) return keep();
      const windows = parsed.map((w) => ({ ...w, read_at: readAt }));
      entry.last = windows;
      return windows;
    } catch (e) {
      const detail = redactErrorText((e as Error).message, credentialHeaderValues(Object.entries(headers)), 300);
      this.opts.warn?.(`${this.opts.label} ${name}: ${detail}`);
      return keep();
    }
  }
}
