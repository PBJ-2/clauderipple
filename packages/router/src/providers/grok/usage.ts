// How much of a Grok subscription's usage pool is spent, for the status bar's limits row.
//
// The Grok CLI's `/usage` (alias `/cost`) shows it; the CLI reads it from the chat proxy it talks to
// with the same session (CLI 1.0.5 strings: "/billing?format=credits", "Monthly limit", "Weekly
// limit", "Next reset:", field names creditUsagePercent, currentPeriod, billingPeriodEnd).
// Measured 2026-10-15, signed in on a SuperGrok account with nothing used that week:
//   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits   (the adapter's headers) → 200
//   {"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"…","end":"2026-10-17T04:12:41Z"},
//    "onDemandCap":{"val":0},"onDemandUsed":{"val":0},"isUnifiedBillingUser":true,"prepaidBalance":{"val":0},
//    "billingPeriodStart":"…","billingPeriodEnd":"2026-10-17T04:12:41Z"}}
// The body is protobuf JSON, which leaves zero values out: `creditUsagePercent` was absent at 0%
// use, so absent reads as 0. Its scale (0–100, by its name) is not yet seen on a non-zero week.

/** One window `/api/limits` reads, as the OpenCode Go reader gives it. */
/**
 * `read_at` (epoch milliseconds) is when the request for the reading was sent: internal, kept while a
 * failed read keeps the reading, and stripped before `/api/limits` answers.
 */
export type GrokWindow = { kind: "seven_day" | "window"; used_percent: number; window_minutes: number; reset_at?: number; read_at?: number };

const WEEK = 7 * 24 * 60;
const MONTH = 30 * 24 * 60;

/** The usage pool's current period as a window, or null when the body names none. */
export function grokWindowsFromBilling(body: unknown): GrokWindow[] | null {
  const config = (body as { config?: unknown } | null)?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const c = config as { currentPeriod?: { type?: unknown; end?: unknown }; creditUsagePercent?: unknown; billingPeriodEnd?: unknown };
  const period = c.currentPeriod;
  if (!period || typeof period !== "object") return null;
  const weekly = period.type === "USAGE_PERIOD_TYPE_WEEKLY";
  const raw = c.creditUsagePercent;
  const used = typeof raw === "number" && Number.isFinite(raw) ? raw : raw === undefined ? 0 : NaN;
  if (!Number.isFinite(used)) return null;
  const end = typeof period.end === "string" ? Date.parse(period.end) : typeof c.billingPeriodEnd === "string" ? Date.parse(c.billingPeriodEnd) : NaN;
  return [{ kind: weekly ? "seven_day" : "window", used_percent: used, window_minutes: weekly ? WEEK : MONTH, ...(Number.isFinite(end) ? { reset_at: Math.round(end / 1000) } : {}) }];
}

type UsageOptions = { fetch?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number; ttlMs?: number; timeoutMs?: number; warn?: (message: string) => void };

/**
 * One provider's pool, fetched at most once per `ttlMs`. A failed lookup keeps the last good
 * window rather than blanking it, and only the status code is logged (never the session).
 */
export class GrokUsage {
  private last: GrokWindow[] = [];
  private at = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<GrokWindow[]> | null = null;
  private readonly name: string;
  private readonly opts: UsageOptions;

  constructor(name: string, opts: UsageOptions = {}) {
    this.name = name;
    this.opts = opts;
  }

  windows(url: string, headers: () => Promise<Record<string, string>>): Promise<GrokWindow[]> {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.at < (this.opts.ttlMs ?? 5 * 60_000)) return Promise.resolve(this.last);
    this.inFlight ??= this.fetchOne(url, headers).finally(() => {
      this.at = (this.opts.now ?? Date.now)();
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchOne(url: string, headers: () => Promise<Record<string, string>>): Promise<GrokWindow[]> {
    const readAt = (this.opts.now ?? Date.now)();
    try {
      const res = await (this.opts.fetch ?? fetch)(`${url.replace(/\/+$/, "")}/billing?format=credits`, {
        method: "GET",
        headers: { accept: "application/json", ...(await headers()) },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        this.opts.warn?.(`grok usage ${this.name}: HTTP ${res.status}`);
        return this.last;
      }
      const windows = grokWindowsFromBilling(await res.json());
      if (windows) this.last = windows.map((w) => ({ ...w, read_at: readAt }));
      return this.last;
    } catch (e) {
      this.opts.warn?.(`grok usage ${this.name}: ${(e as Error).message}`);
      return this.last;
    }
  }
}
