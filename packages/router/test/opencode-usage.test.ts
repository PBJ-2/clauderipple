// The OpenCode Go usage lookup: the `/usage` parse, the provider detection, and the cache. The
// response shape is the measured one (2026-10-15); the values are fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeUsage, isOpenCodeGo, opencodeWindowsFromBody } from "../src/providers/opencode-usage.ts";

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

test("a cached reading keeps the time it was taken, and a failed refresh keeps that time", async () => {
  let fail = false;
  const fetchImpl = (async () => (fail ? new Response("nope", { status: 500 }) : new Response(JSON.stringify(measured), { status: 200 }))) as unknown as typeof fetch;
  const readTimes = (windows: { read_at?: number }[]) => windows.map((w) => w.read_at);
  const headers = { authorization: "Bearer key" };
  let now = 1_000_000;
  const usage = new OpenCodeUsage({ fetch: fetchImpl, now: () => now, ttlMs: 300_000, warn: () => {} });
  assert.deepEqual(readTimes(await usage.windows("go", "https://opencode.ai/zen/go/v1", headers)), [1_000_000, 1_000_000, 1_000_000]);
  // Four minutes later the same reading is served from the cache: it was taken at 1,000,000, not now.
  now += 4 * 60_000;
  assert.deepEqual(readTimes(await usage.windows("go", "https://opencode.ai/zen/go/v1", headers)), [1_000_000, 1_000_000, 1_000_000], "a cached reading keeps its own time");
  // A failed refresh keeps the reading, and with it the time it was taken.
  now = 1_000_000 + 300_001;
  fail = true;
  assert.deepEqual(readTimes(await usage.windows("go", "https://opencode.ai/zen/go/v1", headers)), [1_000_000, 1_000_000, 1_000_000], "a failed refresh keeps the original time");
  // A later good refresh is stamped with its own time.
  now += 300_001;
  fail = false;
  assert.deepEqual(readTimes(await usage.windows("go", "https://opencode.ai/zen/go/v1", headers)), [now, now, now]);
});
