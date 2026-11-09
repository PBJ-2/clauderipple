// When a limit window reaches 100% at its recent rate of use. Each /api/limits read adds one sample per
// window; nothing is persisted, so a router restart starts every window fresh. The clock is injected so
// the rule can be tested without waiting.

/** `at` is epoch milliseconds (the account snapshot's time); `reset_at` is epoch seconds, as the limits use. */
export type ForecastSample = { at: number; used_percent: number; reset_at?: number };
/** The window as it is now. */
export type ForecastWindow = { used_percent: number; reset_at?: number };

/** Samples kept per window. */
const HORIZON_MS = 3 * 60 * 60_000;
/** A new sample is skipped when the window's last stored sample is less than this much older. */
const THIN_MS = 60_000;
/** The rate is fitted over the samples of this last stretch. */
const RATE_MS = 60 * 60_000;
/** A forecast needs its samples to span at least this long... */
const MIN_SPAN_MS = 15 * 60_000;
/** ...and the window to have risen at least this many percentage points across them. */
const MIN_RISE_PERCENT = 2;

/** Least-squares slope of used_percent over time, in percentage points per second. */
function slopePerSecond(samples: ForecastSample[]): number {
  const t0 = samples[0]!.at;
  const xs = samples.map((s) => (s.at - t0) / 1000);
  const ys = samples.map((s) => s.used_percent);
  const n = samples.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

export class LimitForecaster {
  private readonly series = new Map<string, ForecastSample[]>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The samples kept for a window, oldest first. For inspection; the forecast reads them itself. */
  samples(key: string): readonly ForecastSample[] {
    return this.series.get(key) ?? [];
  }

  /**
   * Record one reading of a window (`key` names the window). A reading less than a minute after the
   * window's last stored sample (or at an earlier time) adds nothing, so many pollers do not multiply
   * the samples. A window whose used_percent went down, or whose reset_at changed, has reset: its
   * earlier samples are dropped and this reading starts the new series.
   */
  observe(key: string, sample: ForecastSample): void {
    const now = this.now();
    const list = this.series.get(key) ?? [];
    const last = list.at(-1);
    if (last && sample.at - last.at < THIN_MS) return;
    const reset = last !== undefined && (sample.used_percent < last.used_percent || last.reset_at !== sample.reset_at);
    const next = reset ? [] : list;
    next.push({ ...sample });
    while (next.length > 0 && next[0]!.at < now - HORIZON_MS) next.shift();
    this.series.set(key, next);
    this.dropStale(now);
  }

  /**
   * Epoch seconds when the window reaches 100% at its recent rate, or undefined when no forecast is due:
   * the window is already at 100%, the samples of the last hour span less than 15 minutes or rose less than
   * 2 points, the rate is not rising, or the window would reach 100% only after its reset.
   */
  exhaustAt(key: string, current: ForecastWindow): number | undefined {
    if (current.used_percent >= 100) return undefined;
    const now = this.now();
    const recent = (this.series.get(key) ?? []).filter((s) => s.at >= now - RATE_MS);
    if (recent.length < 2) return undefined;
    const first = recent[0]!;
    const latest = recent.at(-1)!;
    if (latest.at - first.at < MIN_SPAN_MS) return undefined;
    if (latest.used_percent - first.used_percent < MIN_RISE_PERCENT) return undefined;
    const rate = slopePerSecond(recent);
    if (!(rate > 0)) return undefined;
    const exhaust = Math.round(latest.at / 1000 + (100 - latest.used_percent) / rate);
    if (current.reset_at !== undefined && exhaust >= current.reset_at) return undefined;
    return exhaust;
  }

  /** Forget a window whose newest sample is older than the horizon, so a window no longer read does not stay in memory. */
  private dropStale(now: number): void {
    for (const [key, list] of this.series) {
      const newest = list.at(-1);
      if (!newest || newest.at < now - HORIZON_MS) this.series.delete(key);
    }
  }
}

/** The shape `buildLimits` returns: only what the forecast reads and writes. */
export type ForecastProviders = {
  provider: string;
  accounts: { account: number; at: number; windows: { kind: string; label?: string; window_minutes?: number; used_percent: number; reset_at?: number; exhaust_at?: number }[] }[];
}[];

/**
 * Record every window's reading and set `exhaust_at` on each window that has a forecast. A window with
 * no forecast gets no `exhaust_at` at all, so readers that predate the field see the same shape. The
 * series key is (provider, account, kind, label, window_minutes), so two windows that differ only in
 * length do not share samples.
 */
export function forecastLimits(forecaster: LimitForecaster, providers: ForecastProviders): void {
  for (const provider of providers) {
    for (const account of provider.accounts) {
      for (const window of account.windows) {
        const key = JSON.stringify([provider.provider, account.account, window.kind, window.label ?? null, window.window_minutes ?? null]);
        forecaster.observe(key, { at: account.at, used_percent: window.used_percent, ...(window.reset_at !== undefined ? { reset_at: window.reset_at } : {}) });
        const exhaust = forecaster.exhaustAt(key, window);
        if (exhaust !== undefined) window.exhaust_at = exhaust;
      }
    }
  }
}
