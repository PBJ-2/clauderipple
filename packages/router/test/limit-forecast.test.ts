import { test } from "node:test";
import assert from "node:assert/strict";
import { LimitForecaster, forecastLimits, type ForecastProviders } from "../src/limit-forecast.ts";

const MIN = 60_000;
const BASE = 1_800_000_000_000; // epoch ms
const FAR_RESET = BASE / 1000 + 10 * 24 * 3600; // a reset ten days out, in epoch seconds

/** A forecaster on a clock the test sets. */
function clocked(): { forecaster: LimitForecaster; at: (ms: number) => void } {
  let now = BASE;
  return { forecaster: new LimitForecaster(() => now), at: (ms) => (now = ms) };
}

test("no forecast while the samples span less than 15 minutes", () => {
  const { forecaster, at } = clocked();
  forecaster.observe("w", { at: BASE, used_percent: 0 });
  forecaster.observe("w", { at: BASE + 10 * MIN, used_percent: 5 });
  at(BASE + 10 * MIN);
  assert.equal(forecaster.exhaustAt("w", { used_percent: 5, reset_at: FAR_RESET }), undefined);
});

test("no forecast when the window rose less than 2 percentage points", () => {
  const { forecaster, at } = clocked();
  for (let m = 0; m <= 30; m += 5) forecaster.observe("w", { at: BASE + m * MIN, used_percent: 10 + m / 60 });
  at(BASE + 30 * MIN);
  // 30 minutes at 1/60 point a minute rose 0.5 points.
  assert.equal(forecaster.exhaustAt("w", { used_percent: 10.5, reset_at: FAR_RESET }), undefined);
});

test("a steady rise gives the moment the window reaches 100%", () => {
  const { forecaster, at } = clocked();
  // 10% at the start, then 0.5 points a minute: 25% at minute 30, so 100% comes 150 minutes later.
  for (let m = 0; m <= 30; m += 5) forecaster.observe("w", { at: BASE + m * MIN, used_percent: 10 + 0.5 * m });
  at(BASE + 30 * MIN);
  assert.equal(forecaster.exhaustAt("w", { used_percent: 25, reset_at: FAR_RESET }), Math.round((BASE + 180 * MIN) / 1000));
});

test("no forecast once the window would reach 100% only after its reset", () => {
  const { forecaster, at } = clocked();
  for (let m = 0; m <= 30; m += 5) forecaster.observe("w", { at: BASE + m * MIN, used_percent: 10 + 0.5 * m });
  at(BASE + 30 * MIN);
  // The forecast is minute 180; a reset at minute 100 comes first.
  assert.equal(forecaster.exhaustAt("w", { used_percent: 25, reset_at: (BASE + 100 * MIN) / 1000 }), undefined);
  // A reset later than the forecast leaves it in place.
  assert.equal(forecaster.exhaustAt("w", { used_percent: 25, reset_at: (BASE + 200 * MIN) / 1000 }), Math.round((BASE + 180 * MIN) / 1000));
});

test("no forecast at or above 100%", () => {
  const { forecaster, at } = clocked();
  for (let m = 0; m <= 30; m += 5) forecaster.observe("w", { at: BASE + m * MIN, used_percent: 10 + 0.5 * m });
  at(BASE + 30 * MIN);
  assert.equal(forecaster.exhaustAt("w", { used_percent: 100, reset_at: FAR_RESET }), undefined);
});

test("a drop in used_percent clears the window's samples, so no forecast follows until new samples arrive", () => {
  const { forecaster, at } = clocked();
  for (let m = 0; m <= 30; m += 5) forecaster.observe("w", { at: BASE + m * MIN, used_percent: 10 + 0.5 * m });
  at(BASE + 30 * MIN);
  assert.ok(forecaster.exhaustAt("w", { used_percent: 25, reset_at: FAR_RESET }) !== undefined, "forecast before the reset");
  // The window reset at minute 35: 3%. That one reading is the start of a new series.
  forecaster.observe("w", { at: BASE + 35 * MIN, used_percent: 3, reset_at: FAR_RESET });
  at(BASE + 35 * MIN);
  assert.equal(forecaster.exhaustAt("w", { used_percent: 3, reset_at: FAR_RESET }), undefined);
});

test("a change of reset_at clears the samples too", () => {
  const { forecaster, at } = clocked();
  for (let m = 0; m <= 30; m += 5) forecaster.observe("w", { at: BASE + m * MIN, used_percent: 10 + 0.5 * m, reset_at: FAR_RESET });
  // The same used_percent trend, but a new reset_at at minute 31: the old series must not carry into it.
  forecaster.observe("w", { at: BASE + 31 * MIN, used_percent: 25.5, reset_at: FAR_RESET + 3600 });
  at(BASE + 31 * MIN);
  assert.equal(forecaster.exhaustAt("w", { used_percent: 25.5, reset_at: FAR_RESET + 3600 }), undefined);
});

test("a reading at the same time as the last one adds nothing, and an earlier one is ignored", () => {
  const { forecaster, at } = clocked();
  for (let m = 0; m <= 30; m += 5) forecaster.observe("w", { at: BASE + m * MIN, used_percent: 10 + 0.5 * m });
  at(BASE + 30 * MIN);
  const expected = forecaster.exhaustAt("w", { used_percent: 25, reset_at: FAR_RESET });
  forecaster.observe("w", { at: BASE + 30 * MIN, used_percent: 40 }); // same time: skipped
  forecaster.observe("w", { at: BASE + 10 * MIN, used_percent: 40 }); // earlier: skipped
  assert.equal(forecaster.exhaustAt("w", { used_percent: 25, reset_at: FAR_RESET }), expected);
});

test("samples older than three hours are dropped, so a window read long ago forecasts nothing", () => {
  const { forecaster, at } = clocked();
  for (let m = 0; m <= 30; m += 5) forecaster.observe("w", { at: BASE + m * MIN, used_percent: 10 + 0.5 * m });
  at(BASE + 30 * MIN + 4 * 60 * MIN);
  assert.equal(forecaster.exhaustAt("w", { used_percent: 25, reset_at: FAR_RESET }), undefined);
});

test("forecastLimits sets exhaust_at on the windows that have one, and leaves the others as they were", () => {
  const { forecaster, at } = clocked();
  // One account: a five-hour window that rises, and a scoped window that stays flat at 40%.
  const readAt = (ms: number, fiveHourUsed: number): ForecastProviders => [{
    provider: "claude",
    accounts: [{
      id: "acct-0",
      at: ms,
      windows: [
        { kind: "five_hour", used_percent: fiveHourUsed, reset_at: FAR_RESET },
        { kind: "scoped", label: "Opus", used_percent: 40 },
      ],
    }],
  }];
  for (let m = 0; m <= 30; m += 5) forecastLimits(forecaster, readAt(BASE + m * MIN, 10 + 0.5 * m));
  at(BASE + 30 * MIN);
  const last = readAt(BASE + 30 * MIN, 25);
  forecastLimits(forecaster, last);
  const [fiveHour, scoped] = last[0]!.accounts[0]!.windows;
  assert.equal(fiveHour!.exhaust_at, Math.round((BASE + 180 * MIN) / 1000));
  assert.equal("exhaust_at" in scoped!, false, "a flat window has no forecast field at all");
});

test("a reading less than a minute after the window's last stored sample is skipped", () => {
  const { forecaster } = clocked();
  forecaster.observe("t", { at: BASE, used_percent: 0 });
  forecaster.observe("t", { at: BASE + 30_000, used_percent: 5 });
  forecaster.observe("t", { at: BASE + 59_000, used_percent: 6 });
  forecaster.observe("t", { at: BASE + 60_000, used_percent: 10 });
  assert.deepEqual(forecaster.samples("t").map((s) => [s.at, s.used_percent]), [[BASE, 0], [BASE + 60_000, 10]]);
});

test("windows that differ only in window_minutes keep separate series", () => {
  const { forecaster, at } = clocked();
  // Two windows of one kind and no label on one account: a five-hour one that rises and a weekly one that stays at 90%.
  const readAt = (ms: number, fiveHourUsed: number): ForecastProviders => [{
    provider: "claude",
    accounts: [{
      id: "acct-0",
      at: ms,
      windows: [
        { kind: "window", window_minutes: 300, used_percent: fiveHourUsed, reset_at: FAR_RESET },
        { kind: "window", window_minutes: 10080, used_percent: 90, reset_at: FAR_RESET + 1 },
      ],
    }],
  }];
  for (let m = 0; m <= 30; m += 5) forecastLimits(forecaster, readAt(BASE + m * MIN, 10 + 0.5 * m));
  at(BASE + 30 * MIN);
  const last = readAt(BASE + 30 * MIN, 25);
  forecastLimits(forecaster, last);
  const [fiveHour, weekly] = last[0]!.accounts[0]!.windows;
  // Had the weekly readings shared the five-hour series, every rise would look like a reset and no forecast would follow.
  assert.equal(fiveHour!.exhaust_at, Math.round((BASE + 180 * MIN) / 1000));
  assert.equal("exhaust_at" in weekly!, false);
});

test("the series follows the account's id, so removing the first of two accounts leaves the second with its own samples only", () => {
  const withRemoval = clocked();
  const alone = clocked();
  // "a" is listed first and rises slowly; "b" rises steadily from 30%. From minute 35 "a" is gone and "b" is the first account.
  const readings = (ms: number, accounts: { id: string; used: number }[]): ForecastProviders => [{
    provider: "claude",
    accounts: accounts.map(({ id, used }) => ({ id, at: ms, windows: [{ kind: "five_hour", used_percent: used, reset_at: FAR_RESET }] })),
  }];
  let afterRemoval: ForecastProviders = [];
  let bAlone: ForecastProviders = [];
  for (let m = 0; m <= 60; m += 5) {
    const ms = BASE + m * MIN;
    const a = { id: "a", used: 5 + 0.2 * m };
    const b = { id: "b", used: 30 + 0.5 * m };
    withRemoval.at(ms);
    alone.at(ms);
    afterRemoval = readings(ms, m <= 30 ? [a, b] : [b]);
    forecastLimits(withRemoval.forecaster, afterRemoval);
    bAlone = readings(ms, [b]);
    forecastLimits(alone.forecaster, bAlone);
  }
  const exhaustOf = (providers: ForecastProviders) => providers[0]!.accounts[0]!.windows[0]!.exhaust_at;
  assert.notEqual(exhaustOf(bAlone), undefined);
  assert.equal(exhaustOf(afterRemoval), exhaustOf(bAlone));
});
