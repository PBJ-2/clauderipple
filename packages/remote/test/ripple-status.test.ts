import test from "node:test";
import assert from "node:assert/strict";
import { computeFigures, rippleStatus } from "../src/router.ts";

const NOW = 1_792_380_000_000;
const sec = (ms: number): number => Math.round(ms / 1000);
const win = (kind: string, used: number, resetMs: number | null, extra: Record<string, unknown> = {}) => ({ kind, used_percent: used, window_minutes: kind === "five_hour" ? 300 : 10080, ...(resetMs === null ? {} : { reset_at: sec(resetMs) }), ...extra });
const settings = (over: Record<string, unknown> = {}) => ({
  settings: { activeMode: "m2", activeSince: 1_792_374_341_839, effortAuto: true, floor: "medium", ceiling: "max", modes: [{ id: "m1", name: "Saver" }, { id: "m2", name: "Maxing" }], ...over },
  revision: 3, stored: true,
});
// Shaped like the live router's GET /api/limits (checked 2026-10-19): GPT listed before Claude, a scoped Claude window, Go's 30-day window.
const limits = () => ({ providers: [
  { provider: "chatgpt", type: "chatgpt", title: "GPT", accounts: [{ account: 0, at: NOW, windows: [win("seven_day", 2, NOW + 86_400_000)] }] },
  { provider: "anthropic", type: "anthropic", title: "Claude", accounts: [{ account: 0, at: NOW, windows: [win("five_hour", 38, NOW + 600_000), win("seven_day", 41, NOW + 86_400_000), win("scoped", 40, NOW + 86_400_000, { label: "Fable" })] }] },
  { provider: "opencode-go", type: "opencode-go", title: "Go", accounts: [{ account: 0, at: NOW, windows: [win("window", 0, NOW + 5 * 86_400_000, { window_minutes: 43200 })] }] },
] });

test("a live router's limits and settings become the status, Claude first, resets in ms", () => {
  const s = rippleStatus(limits(), settings(), NOW);
  assert.deepEqual(s.mode, { id: "m2", name: "Maxing", since: 1_792_374_341_839 });
  assert.equal(s.effortAuto, true);
  assert.equal(s.effortFloor, "medium");
  assert.equal(s.effortCeiling, "max");
  assert.equal(s.at, NOW);
  assert.deepEqual(s.limits.map(l => [l.provider, l.kind, l.label]), [
    ["anthropic", "five_hour", null], ["anthropic", "seven_day", null], ["anthropic", "scoped", "Fable"], ["chatgpt", "seven_day", null], ["opencode-go", "window", null],
  ]);
  const five = s.limits[0]!;
  assert.deepEqual(five, { provider: "anthropic", title: "Claude", kind: "five_hour", label: null, usedPct: 38, windowMinutes: 300, resetAt: sec(NOW + 600_000) * 1000 });
  assert.equal(s.limits[4]!.windowMinutes, 43200);
  assert.ok(s.limits.every(l => !("account" in l)), "one account needs no label");
});

test("windows whose reset has passed are dropped, and one with no reset stays", () => {
  const body = { providers: [{ provider: "anthropic", type: "anthropic", title: "Claude", accounts: [{ account: 0, windows: [win("five_hour", 99, NOW - 1000), win("seven_day", 10, NOW + 1000), win("scoped", 5, null, { label: "X" })] }] }] };
  const s = rippleStatus(body, settings(), NOW);
  assert.deepEqual(s.limits.map(l => l.kind), ["seven_day", "scoped"]);
  assert.equal(s.limits[1]!.resetAt, null);
  assert.deepEqual(rippleStatus(body, settings(), NOW + 10_000).limits.map(l => l.kind), ["scoped"], "the same body a little later has lost the seven-day window");
});

test("an account label appears only when a provider has more than one", () => {
  const body = { providers: [
    { provider: "chatgpt", type: "chatgpt", title: "GPT", accounts: [
      { account: 0, windows: [win("seven_day", 1, NOW + 1000)] },
      { account: 1, windows: [win("seven_day", 2, NOW + 1000), win("five_hour", 3, NOW + 1000)] },
    ] },
    { provider: "anthropic", type: "anthropic", title: "Claude", accounts: [{ account: 0, windows: [win("five_hour", 4, NOW + 1000)] }] },
  ] };
  const s = rippleStatus(body, settings(), NOW);
  assert.deepEqual(s.limits.map(l => [l.provider, l.account, l.usedPct]), [["anthropic", undefined, 4], ["chatgpt", "#1", 1], ["chatgpt", "#2", 2], ["chatgpt", "#2", 3]]);
});

test("of several Claude accounts only the one in use shows, unnumbered, as on the desktop band", () => {
  const claude = (accounts: Record<string, unknown>[]) => ({ providers: [{ provider: "anthropic", type: "anthropic", title: "Claude", accounts }] });
  const marked = rippleStatus(claude([
    { account: 0, windows: [win("five_hour", 81, NOW + 1000)] },
    { account: 1, label: "work@example.com", inUse: true, windows: [win("five_hour", 15, NOW + 1000)] },
    { account: 2, label: "spare", windows: [win("five_hour", 40, NOW + 1000)] },
  ]), settings(), NOW);
  assert.deepEqual(marked.limits.map(l => [l.account, l.usedPct]), [[undefined, 15]]);
  // None marked (an older router, or the in-use account's usage not known yet): the first.
  const unmarked = rippleStatus(claude([
    { account: 0, windows: [win("five_hour", 81, NOW + 1000)] },
    { account: 2, windows: [win("five_hour", 40, NOW + 1000)] },
  ]), settings(), NOW);
  assert.deepEqual(unmarked.limits.map(l => [l.account, l.usedPct]), [[undefined, 81]]);
});

test("scoped Argon weekly reaches remote status with its label, account and reset intact", () => {
  const resetAt = NOW + 2 * 86_400_000;
  const body = { providers: [{ provider: "ag", type: "google", title: "Gemini", accounts: [
    { account: 0, at: NOW, windows: [
      win("five_hour", 13, resetAt), win("seven_day", 24, resetAt),
      win("scoped", 65, resetAt, { label: "Argon weekly" }),
    ] },
    { account: 1, at: NOW, windows: [win("scoped", 35, resetAt, { label: "Argon weekly" })] },
  ] }] };
  // The host status travels as JSON to remote clients; no new kind or schema field is needed.
  const status = JSON.parse(JSON.stringify(rippleStatus(body, settings(), NOW)));
  assert.deepEqual(status.limits.map((l: { kind: string; label: string | null; usedPct: number }) => [l.kind, l.label, l.usedPct]), [
    ["five_hour", null, 13], ["seven_day", null, 24], ["scoped", "Argon weekly", 65], ["scoped", "Argon weekly", 35],
  ]);
  assert.deepEqual(status.limits.slice(2), [
    { provider: "ag", title: "Gemini", account: "#1", kind: "scoped", label: "Argon weekly", usedPct: 65, windowMinutes: 10080, resetAt: sec(resetAt) * 1000 },
    { provider: "ag", title: "Gemini", account: "#2", kind: "scoped", label: "Argon weekly", usedPct: 35, windowMinutes: 10080, resetAt: sec(resetAt) * 1000 },
  ]);
});

test("no active mode, an unknown mode and missing settings all give a null mode", () => {
  assert.equal(rippleStatus(limits(), settings({ activeMode: undefined }), NOW).mode, null);
  assert.equal(rippleStatus(limits(), settings({ activeMode: "gone" }), NOW).mode, null);
  assert.equal(rippleStatus(limits(), settings({ modes: undefined }), NOW).mode, null);
  assert.equal(rippleStatus(limits(), settings({ activeSince: "yesterday" }), NOW).mode?.since, null);
});

test("malformed pieces are dropped and nothing throws", () => {
  for (const bad of [null, undefined, 7, "x", [], { providers: "no" }, { providers: [null, 3, { provider: 1 }, { provider: "p", accounts: "no" }, { provider: "p", accounts: [null, { windows: 5 }] }] }]) {
    const s = rippleStatus(bad, bad, NOW);
    assert.deepEqual([s.mode, s.effortAuto, s.effortFloor, s.effortCeiling, s.limits], [null, false, null, null, []]);
  }
  const body = { providers: [{ provider: "anthropic", type: "anthropic", accounts: [{ account: 0, windows: [
    { kind: "fortnight", used_percent: 1, reset_at: sec(NOW + 1000) },
    { kind: "five_hour", used_percent: "lots", reset_at: sec(NOW + 1000) },
    { kind: "five_hour", used_percent: Number.NaN, reset_at: sec(NOW + 1000) },
    null,
    win("seven_day", 12.34, NOW + 1000, { window_minutes: -5 }),
  ] }] }] };
  const s = rippleStatus(body, settings({ floor: "enormous", ceiling: 3, effortAuto: "yes" }), NOW);
  assert.deepEqual(s.limits.map(l => [l.title, l.kind, l.usedPct, l.windowMinutes]), [["Claude", "seven_day", 12.3, null]], "title falls back to the router's name for the provider");
  assert.deepEqual([s.effortAuto, s.effortFloor, s.effortCeiling], [false, null, null]);
});

test("computeFigures also reports the latest request's tokens, the window it is read against, and where it went", () => {
  const rec = (at: string, over: Record<string, unknown> = {}) => ({ source: "claude-opus-5-5", target: "claude-opus-5-5", provider: "anthropic", ok: true, status: 200, effort: "high", at, usage: { input: 2, cached: 900, cacheWrite: 98, output: 5 }, ...over });
  const f = computeFigures([
    rec("2026-10-19T03:00:00Z", { usage: { input: 1, cached: 10, cacheWrite: 0 } }),
    rec("2026-10-19T03:02:00Z", { target: "gpt-6.1-sol@high", provider: "chatgpt", status: 529, ok: false }),
    rec("2026-10-19T03:01:00Z", { source: "deepseek-v4.1-flash@high", target: "deepseek-v4.1-flash", provider: "opencode-go" }),
    rec("2026-10-19T03:03:00Z", { usage: undefined }),
  ], "claude-opus-5-5", 1_000_000, {}, NOW);
  assert.equal(f.contextTokens, 1000);
  assert.equal(f.contextWindow, 1_000_000);
  assert.equal(f.contextPct, 0.1);
  assert.deepEqual(f.route, { model: "gpt-6.1-sol", provider: "chatgpt", ok: false, status: 529 });
  assert.deepEqual(f.workers, [{ model: "deepseek-v4.1-flash", provider: "opencode-go", requests: 1 }]);
});

test("without a known window the tokens are still reported and the window and percent are null", () => {
  const f = computeFigures([{ source: "m", target: "m", provider: "p", ok: true, at: "2026-10-19T03:00:00Z", usage: { input: 5, cached: 5 } }], "m", null, {}, NOW);
  assert.deepEqual([f.contextTokens, f.contextWindow, f.contextPct], [10, null, null]);
  assert.deepEqual(f.route, { model: "m", provider: "p", ok: true, status: null });
  const none = computeFigures([], "m", 100, {}, NOW);
  assert.deepEqual([none.contextTokens, none.contextWindow, none.route], [null, 100, null]);
});
