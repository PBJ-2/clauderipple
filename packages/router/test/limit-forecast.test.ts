import { test } from "node:test";
import assert from "node:assert/strict";
import { paceExhaustAt, paceProjectedPercent, forecastLimits, type ForecastAccount, type ForecastWindow } from "../src/limit-forecast.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000; // the reading's time, epoch ms
const NOW_S = NOW / 1000;
const WEEK_MINUTES = 10080;
const FIVE_HOUR_MINUTES = 300;

/** A window of `minutes` length, at `used` percent, whose reset falls `leftMs` after NOW. */
function win(used: number, minutes: number, leftMs: number): ForecastWindow {
  return { used_percent: used, window_minutes: minutes, reset_at: NOW_S + leftMs / 1000 };
}

test("the real case: a weekly window at 54% with 57.6 h to its reset gets no forecast", () => {
  // The window has run 110.4 h; 54% is a pace that never reaches 100% before the reset.
  assert.equal(paceExhaustAt(win(54, WEEK_MINUTES, 57.6 * HOUR), NOW), undefined);
});

test("a scoped Fable weekly at 2% with the same reset gets no forecast", () => {
  assert.equal(paceExhaustAt(win(2, WEEK_MINUTES, 57.6 * HOUR), NOW), undefined);
});

test("a genuinely fast week gets its forecast at the computed moment", () => {
  // 80% after 72 h of 168: the pace is 80/72 per hour, so 20 more points take 18 h.
  const exhaust = paceExhaustAt(win(80, WEEK_MINUTES, 96 * HOUR), NOW);
  assert.equal(exhaust, Math.round(NOW_S + 18 * 3600));
});

test("a five-hour window at 60% after one hour runs out in 40 minutes", () => {
  assert.equal(paceExhaustAt(win(60, FIVE_HOUR_MINUTES, 4 * HOUR), NOW), Math.round(NOW_S + 40 * 60));
});

test("a weekly window is too early for a forecast at 16 h, and has one at 17 h", () => {
  assert.equal(paceExhaustAt(win(80, WEEK_MINUTES, 152 * HOUR), NOW), undefined, "16 h into the window");
  // 17 h: the pace is 80/17 per hour, so 20 more points take 4.25 h.
  assert.equal(paceExhaustAt(win(80, WEEK_MINUTES, 151 * HOUR), NOW), Math.round(NOW_S + 4.25 * 3600), "17 h into the window");
});

test("a weekly window at exactly 10% of its length (16.8 h) is old enough", () => {
  // 16.8 h elapsed is 1008 min, so the reset is 9072 min out (whole minutes keep the arithmetic exact).
  assert.notEqual(paceExhaustAt(win(80, WEEK_MINUTES, 9072 * MIN), NOW), undefined);
});

test("a five-hour window is too early at 29 min and has a forecast at 31 min", () => {
  assert.equal(paceExhaustAt(win(60, FIVE_HOUR_MINUTES, (300 - 29) * MIN), NOW), undefined, "29 min into the window");
  assert.notEqual(paceExhaustAt(win(60, FIVE_HOUR_MINUTES, (300 - 31) * MIN), NOW), undefined, "31 min into the window");
});

test("a thirty-day window needs a full day before its average is trusted", () => {
  const thirtyDays = 43200;
  // 23 h into the window is too early; 25 h is not. The 10% floor (3 days) is above a full day, so the day applies.
  assert.equal(paceExhaustAt(win(20, thirtyDays, (30 * 24 - 23) * HOUR), NOW), undefined);
  assert.notEqual(paceExhaustAt(win(20, thirtyDays, (30 * 24 - 25) * HOUR), NOW), undefined);
});

test("no forecast without reset_at or window_minutes", () => {
  assert.equal(paceExhaustAt({ used_percent: 60, window_minutes: FIVE_HOUR_MINUTES }, NOW), undefined);
  assert.equal(paceExhaustAt({ used_percent: 60, reset_at: NOW_S + 4 * 3600 }, NOW), undefined);
});

test("no forecast at 0% or at 100%", () => {
  assert.equal(paceExhaustAt(win(0, WEEK_MINUTES, 96 * HOUR), NOW), undefined);
  assert.equal(paceExhaustAt(win(100, WEEK_MINUTES, 96 * HOUR), NOW), undefined);
});

test("no forecast when the reset is not after the reading", () => {
  assert.equal(paceExhaustAt(win(80, WEEK_MINUTES, 0), NOW), undefined, "reset at the reading");
  assert.equal(paceExhaustAt(win(80, WEEK_MINUTES, -HOUR), NOW), undefined, "reset before the reading");
});

test("no forecast when the window would reach 100% at or after its reset", () => {
  // 84 h into a week at 50% is a pace that reaches 100% exactly when the reset comes.
  assert.equal(paceExhaustAt(win(50, WEEK_MINUTES, 84 * HOUR), NOW), undefined, "exactly at the reset");
  // At 51% the same week runs out at 80.7 h, before the 84 h reset.
  const exhaust = paceExhaustAt(win(51, WEEK_MINUTES, 84 * HOUR), NOW);
  assert.ok(exhaust !== undefined && exhaust < NOW_S + 84 * 3600, "before the reset");
});

test("a forecast is judged at the reading's own time, not the clock's", () => {
  // The same window read two hours ago: 70 h elapsed, so 80% runs out 17.5 h after that reading.
  const older = NOW - 2 * HOUR;
  const windows: ForecastWindow[] = [win(80, WEEK_MINUTES, 96 * HOUR)];
  const accounts: ForecastAccount[] = [{ at: older, windows }];
  forecastLimits([{ accounts }]);
  assert.equal(windows[0]!.exhaust_at, Math.round(older / 1000 + 17.5 * 3600));
});

test("forecastLimits sets exhaust_at only on the windows with a forecast, and no others have the field", () => {
  const fast = win(60, FIVE_HOUR_MINUTES, 4 * HOUR);
  const weekly = win(54, WEEK_MINUTES, 57.6 * HOUR);
  // A window that carries a stale exhaust_at from an earlier reading loses it: nothing is forecast now.
  const stale: ForecastWindow = { ...win(2, WEEK_MINUTES, 57.6 * HOUR), exhaust_at: NOW_S + 60 };
  const providers = [{ accounts: [{ at: NOW, windows: [fast, weekly, stale] }] }];
  forecastLimits(providers);
  const [a, b, c] = providers[0]!.accounts[0]!.windows;
  assert.equal(a!.exhaust_at, Math.round(NOW_S + 40 * 60));
  assert.equal("exhaust_at" in b!, false, "the weekly at 54% has no field at all");
  assert.equal("exhaust_at" in c!, false, "a stale field is removed");
});

test("the projection: a weekly window at 54% after 110.4 h of 168 is projected at 82% for its reset", () => {
  // 54% over 110.4 h is 0.489 points an hour; 168 h at that pace is 82.2%.
  assert.equal(paceProjectedPercent(win(54, WEEK_MINUTES, 57.6 * HOUR), NOW), 82);
});

test("the projection: a five-hour window at 60% after one hour is projected at 300%, with an exhaust moment", () => {
  const window = win(60, FIVE_HOUR_MINUTES, 4 * HOUR);
  assert.equal(paceProjectedPercent(window, NOW), 300);
  assert.equal(paceExhaustAt(window, NOW), Math.round(NOW_S + 40 * 60));
});

test("the projection is too early at 29 min of a five-hour window, and has one at 31 min", () => {
  assert.equal(paceProjectedPercent(win(60, FIVE_HOUR_MINUTES, (300 - 29) * MIN), NOW), undefined, "29 min into the window");
  // 60% over 31 min of 300 is 60/1860 a second, so 18000 s at that pace is 580.6%.
  assert.equal(paceProjectedPercent(win(60, FIVE_HOUR_MINUTES, (300 - 31) * MIN), NOW), 581, "31 min into the window");
});

test("the projection is absent at 0% and without reset_at or window_minutes", () => {
  assert.equal(paceProjectedPercent(win(0, WEEK_MINUTES, 57.6 * HOUR), NOW), undefined);
  assert.equal(paceProjectedPercent({ used_percent: 60, window_minutes: FIVE_HOUR_MINUTES }, NOW), undefined);
  assert.equal(paceProjectedPercent({ used_percent: 60, reset_at: NOW_S + 4 * 3600 }, NOW), undefined);
});

test("the projection is absent once the reset has passed", () => {
  assert.equal(paceProjectedPercent(win(80, WEEK_MINUTES, 0), NOW), undefined, "reset at the reading");
});

test("the projection may exceed 100, and the exhaust moment is set with it", () => {
  // 80% after 72 h of 168: 186.7% at the reset, and 100% in 18 h.
  const window = win(80, WEEK_MINUTES, 96 * HOUR);
  assert.equal(paceProjectedPercent(window, NOW), 187);
  assert.equal(paceExhaustAt(window, NOW), Math.round(NOW_S + 18 * 3600));
});

test("forecastLimits sets projected_percent with exhaust_at, and removes a stale one", () => {
  const fast = win(60, FIVE_HOUR_MINUTES, 4 * HOUR);
  const weekly = win(54, WEEK_MINUTES, 57.6 * HOUR);
  // A window that carries a stale projection from an earlier reading loses it, and gets the one now due.
  const stale: ForecastWindow = { ...win(2, WEEK_MINUTES, 57.6 * HOUR), projected_percent: 999 };
  const early: ForecastWindow = { ...win(60, FIVE_HOUR_MINUTES, 4.9 * HOUR), exhaust_at: NOW_S + 60, projected_percent: 999 };
  const providers = [{ accounts: [{ at: NOW, windows: [fast, weekly, stale, early] }] }];
  forecastLimits(providers);
  const [a, b, c, d] = providers[0]!.accounts[0]!.windows;
  assert.equal(a!.projected_percent, 300);
  assert.equal(b!.projected_percent, 82);
  assert.equal(c!.projected_percent, 3, "2% over 110.4 h of a week");
  assert.equal("exhaust_at" in c!, false, "a stale exhaust_at is removed");
  assert.equal("projected_percent" in d!, false, "too early for a pace: no field at all");
  assert.equal("exhaust_at" in d!, false, "too early for a pace: no field at all");
});
