// The OpenCode Go usage lookup: the `/usage` parse, the provider detection, the cache, and the two
// rules the router needs from a snapshot — when a spent key reopens, and when a refusal stated a
// reset. The response shape is the measured one (2026-10-15); the values are fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeUsage, isOpenCodeGo, opencodeWindowsFromBody, refusalResetAt, spentWindowReset } from "../src/providers/opencode-usage.ts";

const measured = {
  usage: {
    rolling: { status: "ok", percent: 3, resetsAt: "2026-10-15T05:39:48Z" },
    weekly: { status: "ok", percent: 52, resetsAt: "2026-10-19T00:00:00Z" },
    monthly: { status: "ok", percent: 92, resetsAt: "2026-10-18T05:43:30Z" },
  },
};

test("rolling/weekly/monthly map to five-hour, weekly and a 30-day window", () => {
  assert.deepEqual(opencodeWindowsFromBody(measured), [
    { kind: "five_hour", used_percent: 3, window_minutes: 300, reset_at: Math.round(Date.parse("2026-10-15T05:39:48Z") / 1000) },
    { kind: "seven_day", used_percent: 52, window_minutes: 10080, reset_at: Math.round(Date.parse("2026-10-19T00:00:00Z") / 1000) },
    { kind: "window", used_percent: 92, window_minutes: 43200, reset_at: Math.round(Date.parse("2026-10-18T05:43:30Z") / 1000) },
  ]);
  // A body with no usage object, or none of the three keys, gives null.
  assert.equal(opencodeWindowsFromBody({}), null);
  assert.equal(opencodeWindowsFromBody({ usage: { rolling: { percent: "x" } } }), null);
  assert.equal(opencodeWindowsFromBody(null), null);
});

test("a provider is OpenCode Go by its preset or its endpoint", () => {
  assert.equal(isOpenCodeGo({ type: "openai-compatible", preset: "opencode-go", url: "https://opencode.ai/zen/go/v1" }), true);
  assert.equal(isOpenCodeGo({ type: "openai-compatible", url: "https://opencode.ai/zen/go/v1" }), true);
  assert.equal(isOpenCodeGo({ type: "openai-compatible", url: "https://opencode.ai/zen/v1" }), false);
  assert.equal(isOpenCodeGo({ type: "openai-compatible", url: "https://api.deepseek.com/anthropic" }), false);
  assert.equal(isOpenCodeGo({ type: "chatgpt" }), false);
});

test("usage is cached per provider and a failed lookup keeps the last good windows", async () => {
  const seen: string[] = [];
  let fail = false;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push(url);
    assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer key");
    if (fail) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(measured), { status: 200 });
  }) as unknown as typeof fetch;
  let now = 1_000_000;
  const usage = new OpenCodeUsage({ fetch: fetchImpl, now: () => now, ttlMs: 300_000, warn: () => {} });
  const first = await usage.windows("go", "https://opencode.ai/zen/go/v1", { authorization: "Bearer key" });
  assert.equal(first.length, 3);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], "https://opencode.ai/zen/go/v1/usage");
  await usage.windows("go", "https://opencode.ai/zen/go/v1", { authorization: "Bearer key" });
  assert.equal(seen.length, 1);
  now += 300_001;
  fail = true;
  const third = await usage.windows("go", "https://opencode.ai/zen/go/v1", { authorization: "Bearer key" });
  assert.equal(third.length, 3);
  assert.equal(seen.length, 2);
});

test("the last snapshot is readable without fetching, and refresh re-reads it now", async () => {
  let calls = 0;
  let percent = 10;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ usage: { rolling: { status: "ok", percent, resetsAt: "2026-10-21T09:00:00Z" } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const now = 1_000_000_000_000;
  const usage = new OpenCodeUsage({ fetch: fetchImpl, now: () => now, ttlMs: 300_000, warn: () => {} });
  // A key nobody has read has no snapshot: the request path must see that rather than trigger a fetch.
  assert.equal(usage.peek("go/k1"), undefined);
  assert.equal(usage.readAt("go/k1"), 0);
  assert.equal(calls, 0);
  const first = await usage.windows("go/k1", "https://opencode.ai/zen/go/v1", { authorization: "Bearer k1" });
  assert.equal(usage.peek("go/k1"), first);
  assert.equal(usage.readAt("go/k1"), now);
  // Cached, so the same answer without a request.
  await usage.windows("go/k1", "https://opencode.ai/zen/go/v1", { authorization: "Bearer k1" });
  assert.equal(calls, 1);
  // A forced refresh ignores the cache — the cache said this key was fine, which is now wrong.
  percent = 100;
  const refreshed = await usage.refresh("go/k1", "https://opencode.ai/zen/go/v1", { authorization: "Bearer k1" });
  assert.equal(calls, 2);
  assert.equal(refreshed[0]!.used_percent, 100);
});

test("a full window parks the key until the last full window resets", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  const at = (iso: string): number => Math.round(Date.parse(iso) / 1000);
  // Nothing full: the key is usable.
  assert.equal(spentWindowReset([{ kind: "five_hour", used_percent: 99, reset_at: at("2026-10-21T12:00:00Z") }], now), null);
  // The 5-hour window full: parked until it resets, not until a longer window's reset.
  assert.equal(
    spentWindowReset([
      { kind: "five_hour", used_percent: 100, reset_at: at("2026-10-21T12:00:00Z") },
      { kind: "seven_day", used_percent: 40, reset_at: at("2026-10-25T00:00:00Z") },
    ], now),
    at("2026-10-21T12:00:00Z") * 1000,
  );
  // Weekly full as well: the later reset wins, because the key stays out until both clear.
  assert.equal(
    spentWindowReset([
      { kind: "five_hour", used_percent: 100, reset_at: at("2026-10-21T12:00:00Z") },
      { kind: "seven_day", used_percent: 120, reset_at: at("2026-10-25T00:00:00Z") },
    ], now),
    at("2026-10-25T00:00:00Z") * 1000,
  );
  // A full window whose reset has already passed is a stale snapshot: it says nothing about now.
  assert.equal(spentWindowReset([{ kind: "five_hour", used_percent: 100, reset_at: at("2026-10-21T09:00:00Z") }], now), null);
  // A full window with no reset stated parks the key for one cache period, not forever.
  const unknown = spentWindowReset([{ kind: "five_hour", used_percent: 100 }], now);
  assert.equal(unknown, now + 5 * 60_000);
});

test("a refusal's reset is read from retry-after, or from the body's own field", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  // The header wins over anything in the body.
  assert.equal(refusalResetAt(JSON.stringify({ reset_at: 5 }), now, 90_000), now + 90_000);
  // ISO date, at the depth these APIs nest their error in.
  assert.equal(
    refusalResetAt(JSON.stringify({ type: "error", error: { type: "rate_limit_error", resetsAt: "2026-10-21T12:00:00Z" } }), now),
    Date.parse("2026-10-21T12:00:00Z"),
  );
  // Epoch seconds, and a delay in seconds. A refusal is about this key right now, so a reset it
  // states further out than the pool would ever cool for is held to that ceiling instead.
  assert.equal(
    refusalResetAt(JSON.stringify({ usage: { weekly: { percent: 100, resets_at: Math.round(Date.parse("2026-10-21T14:00:00Z") / 1000) } } }), now),
    Date.parse("2026-10-21T14:00:00Z"),
  );
  assert.equal(refusalResetAt(JSON.stringify({ retry_after: 30 }), now), now + 30_000);
  // Nothing stated, or unreadable: undefined, so the caller uses its own delay.
  assert.equal(refusalResetAt(JSON.stringify({ error: { message: "rate limited" } }), now), undefined);
  assert.equal(refusalResetAt("not json at all", now), undefined);
  assert.equal(refusalResetAt(JSON.stringify({ reset_at: "2026-10-01T00:00:00Z" }), now), undefined, "a reset in the past is not a wait");
});

// A numeric string is a number the vendor quoted, not a date. `Date.parse("3600")` reads as the year
// 3600, and that key stayed parked until it.
test("a quoted number is a delay in seconds, not a date in the year 3600", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  assert.equal(refusalResetAt(JSON.stringify({ error: { retry_after: "3600" } }), now), now + 3_600_000);
  assert.equal(refusalResetAt(JSON.stringify({ retry_after: "90.5" }), now), now + 90_500);
  // An epoch as a string is the same instant a number would name.
  const epochSeconds = Math.round((now + 1_800_000) / 1000);
  assert.equal(refusalResetAt(JSON.stringify({ resets_at: String(epochSeconds) }), now), epochSeconds * 1000);
  // A large magnitude is still epoch seconds or ms, decided the same way as a number.
  assert.equal(refusalResetAt(JSON.stringify({ reset_at: String(epochSeconds * 1000) }), now), epochSeconds * 1000);
});

// An epoch already behind `now` is a stale snapshot, exactly as an ISO date in the past is. It used
// to come back as a reset, so the caller believed the vendor had stated a wait: the key was cooled
// to a moment that had passed, and the retry was refused again with no cooldown to move it.
test("a numeric reset in the past is not a wait, as the ISO branch already says", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  const pastSeconds = Math.round((now - 3_600_000) / 1000);
  assert.equal(refusalResetAt(JSON.stringify({ resets_at: pastSeconds }), now), undefined, "epoch seconds in the past");
  assert.equal(refusalResetAt(JSON.stringify({ reset_at: pastSeconds * 1000 }), now), undefined, "epoch ms in the past");
  assert.equal(refusalResetAt(JSON.stringify({ resets_at: String(pastSeconds) }), now), undefined, "the same epoch quoted");
  // A refusal that states nothing usable leaves the caller its own delay, while a real future epoch
  // is still taken as stated.
  const future = Math.round((now + 1_800_000) / 1000);
  assert.equal(refusalResetAt(JSON.stringify({ resets_at: future }), now), future * 1000);
});

// A refusal is about this key now, so a reset it states further out than the pool would ever cool for
// is held to that ceiling. A usage window's own reset is a real date and is not clamped.
test("a refusal's stated reset is held to the pool's ceiling; a usage window's stays as stated", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  const sixHours = now + 6 * 3_600_000;
  const week = new Date(now + 7 * 86_400_000).toISOString();
  assert.equal(refusalResetAt(JSON.stringify({ resetsAt: week }), now), sixHours);
  assert.equal(refusalResetAt("{}", now, 7 * 86_400_000), sixHours);
  const weeklyReset = Math.round((now + 7 * 86_400_000) / 1000) * 1000;
  assert.equal(
    spentWindowReset([{ kind: "seven_day", used_percent: 100, reset_at: weeklyReset / 1000 }], now),
    weeklyReset,
    "a weekly window at 100% still parks the key until its own reset, days away",
  );
});