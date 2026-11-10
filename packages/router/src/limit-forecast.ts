// When a limit window reaches 100% at its average pace since the window started. The forecast reads the
// current reading alone: no samples are kept, so a router restart changes nothing and a cached snapshot is
// judged at its own time (the account's `at`).
//
// The average covers the whole window, not the last hour. One busy hour extrapolated around the clock
// overstated weekly windows (a 52% -> 54% hour projected 35+ hours of use), and percents arrive as integers,
// so a real rise of about one point read as two doubled the slope.

/** A window as the limits read it. `reset_at` is epoch seconds; `window_minutes` is the window's length. */
export type ForecastWindow = { used_percent: number; window_minutes?: number; reset_at?: number; exhaust_at?: number };
/** One account's windows, with the reading's time (`at`, epoch milliseconds). */
export type ForecastAccount = { at: number; windows: ForecastWindow[] };

/** A window's average is trusted once it has run this long: a full day and night, or a tenth of the window if that is shorter. */
const FULL_CYCLE_S = 24 * 3600;
const MIN_SHARE_OF_WINDOW = 0.1;

/**
 * Epoch seconds when the window reaches 100% at its average pace since it started, or undefined when no
 * forecast applies: the window is at 0% or at 100%; `reset_at` or `window_minutes` is missing; the reset
 * is not after `now`; the window has run for less than min(24 h, 10% of its length), too early for the
 * average to hold a full day and night; or the window reaches 100% at or after its reset.
 * `now` is epoch milliseconds (the reading's time).
 */
export function paceExhaustAt(window: ForecastWindow, now: number): number | undefined {
  const used = window.used_percent;
  const reset = window.reset_at;
  const minutes = window.window_minutes;
  // The negated comparisons also refuse NaN and a missing value.
  if (!(used > 0 && used < 100)) return undefined;
  if (reset === undefined || minutes === undefined) return undefined;
  const nowS = now / 1000;
  if (!(reset > nowS)) return undefined;
  if (!(minutes > 0)) return undefined;
  const lengthS = minutes * 60;
  const elapsed = nowS - (reset - lengthS);
  if (!(elapsed > 0)) return undefined;
  if (elapsed < Math.min(FULL_CYCLE_S, MIN_SHARE_OF_WINDOW * lengthS)) return undefined;
  const rate = used / elapsed;
  const exhaust = Math.round(nowS + (100 - used) / rate);
  return exhaust >= reset ? undefined : exhaust;
}

/**
 * Set `exhaust_at` on each window that has a forecast. A window with none is left without the field at
 * all, so readers that predate the field see the same shape. Each account is judged at its own `at`.
 */
export function forecastLimits(providers: { accounts: ForecastAccount[] }[]): void {
  for (const provider of providers) {
    for (const account of provider.accounts) {
      for (const window of account.windows) {
        const exhaust = paceExhaustAt(window, account.at);
        if (exhaust === undefined) delete window.exhaust_at;
        else window.exhaust_at = exhaust;
      }
    }
  }
}
