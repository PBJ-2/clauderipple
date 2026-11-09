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
      account: 0,
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
