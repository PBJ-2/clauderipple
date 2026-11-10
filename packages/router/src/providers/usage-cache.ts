// A plan provider's quota windows, read once per provider and kept when a read fails.
//
// Shared by every provider whose quota lives behind its own endpoint (OpenCode Go's `/usage`,
// MiniMax M Plan's `coding_plan/remains`): one request per provider per TTL, one request in
// flight at a time, and the last good windows kept rather than blanked when a read fails.

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

/**
 * Per-provider usage windows, fetched at most once per `ttlMs` per provider. A failed lookup keeps
 * the last good windows rather than blanking them, and only the status code is logged.
 */
export class UsageCache {
  private readonly last = new Map<string, UsageWindow[]>();
  private readonly at = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<UsageWindow[]>>();
  private readonly opts: UsageCacheOptions;

  constructor(opts: UsageCacheOptions) {
    this.opts = opts;
  }

  /**
   * The provider's windows, cached for `ttlMs`; the last good ones survive a failed lookup.
   * `parse` answers the windows the body carries, or null when it carries none.
   */
  windows(name: string, url: string, headers: Record<string, string>, parse: (body: unknown) => UsageWindow[] | null): Promise<UsageWindow[]> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.ttlMs ?? 5 * 60_000;
    if (now - (this.at.get(name) ?? Number.NEGATIVE_INFINITY) < ttl) return Promise.resolve(this.last.get(name) ?? []);
    const running = this.inFlight.get(name);
    if (running) return running;
    const task = this.fetchOne(name, url, headers, parse).finally(() => {
      this.at.set(name, (this.opts.now ?? Date.now)());
      this.inFlight.delete(name);
    });
    this.inFlight.set(name, task);
    return task;
  }

  private async fetchOne(name: string, url: string, headers: Record<string, string>, parse: (body: unknown) => UsageWindow[] | null): Promise<UsageWindow[]> {
    const keep = () => this.last.get(name) ?? [];
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
      this.last.set(name, windows);
      return windows;
    } catch (e) {
      this.opts.warn?.(`${this.opts.label} ${name}: ${(e as Error).message}`);
      return keep();
    }
  }
}
