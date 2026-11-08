// The MiniMax M Plan usage lookup: the `coding_plan/remains` parse, the provider detection, and the
// cache. The response shape is the measured one (2026-11-08, a real M Plan key); the values are fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MiniMaxUsage, isMiniMaxPlan, minimaxKey, minimaxQuotaRequest, minimaxWindowsFromBody } from "../src/providers/minimax-usage.ts";

/** The measured answer of 2026-11-08: 9% of the five-hour window, 1% of the week. */
const measured = {
  model_remains: [
    {
      start_time: 1794108007151,
      end_time: 1794126007151,
      remains_time: 16502432,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: "general",
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1794108007151,
      weekly_end_time: 1794712807151,
      weekly_remains_time: 603302432,
      current_interval_status: 1,
      current_interval_remaining_percent: 91,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 99,
    },
  ],
  base_resp: { status_code: 0, status_msg: "success" },
};

test("the share left becomes the share used, and the epoch milliseconds become a reset in seconds", () => {
  assert.deepEqual(minimaxWindowsFromBody(measured), [
    { kind: "five_hour", used_percent: 9, window_minutes: 300, reset_at: 1794126007 },
    { kind: "seven_day", used_percent: 1, window_minutes: 10080, reset_at: 1794712807 },
  ]);
});

test("a body the plan did not answer for reads as null, so the caller keeps its last good answer", () => {
  // A refused request.
  assert.equal(minimaxWindowsFromBody({ ...measured, base_resp: { status_code: 1004, status_msg: "invalid api key" } }), null);
  // No plan at all: a pay-as-you-go key carries no remains.
  assert.equal(minimaxWindowsFromBody({ model_remains: [], base_resp: { status_code: 0, status_msg: "success" } }), null);
  assert.equal(minimaxWindowsFromBody({ base_resp: { status_code: 0, status_msg: "success" } }), null);
  // No percent at all to read.
  assert.equal(minimaxWindowsFromBody({ model_remains: [{ model_name: "general" }], base_resp: { status_code: 0, status_msg: "success" } }), null);
  // One percent missing is no plan to read either: the answer stays the last good one.
  const without = (key: string) => ({ model_remains: [{ ...measured.model_remains[0]!, [key]: undefined }], base_resp: { status_code: 0, status_msg: "success" } });
  assert.equal(minimaxWindowsFromBody(without("current_interval_remaining_percent")), null);
  assert.equal(minimaxWindowsFromBody(without("current_weekly_remaining_percent")), null);
  assert.equal(minimaxWindowsFromBody(null), null);
  assert.equal(minimaxWindowsFromBody("nope"), null);
});

test("the general entry answers for the plan, and a body without it answers for its first entry", () => {
  const other = { ...measured.model_remains[0]!, model_name: "MiniMax-M3", current_interval_remaining_percent: 50 };
  const general = measured.model_remains[0]!;
  const windows = minimaxWindowsFromBody({ model_remains: [other, general], base_resp: { status_code: 0, status_msg: "success" } });
  assert.equal(windows?.[0]?.used_percent, 9, "the general entry wins over the model's own");
  const first = minimaxWindowsFromBody({ model_remains: [other], base_resp: { status_code: 0, status_msg: "success" } });
  assert.equal(first?.[0]?.used_percent, 50, "without a general entry the first one answers");
});

test("the share used stays inside 0..100", () => {
  const body = (remaining: number) => ({
    model_remains: [{ model_name: "general", current_interval_remaining_percent: remaining, current_weekly_remaining_percent: remaining }],
    base_resp: { status_code: 0, status_msg: "success" },
  });
  assert.equal(minimaxWindowsFromBody(body(100))?.[0]?.used_percent, 0);
  assert.equal(minimaxWindowsFromBody(body(0))?.[0]?.used_percent, 100);
  assert.equal(minimaxWindowsFromBody(body(140))?.[0]?.used_percent, 0, "more than a hundred left is still nothing used");
  assert.equal(minimaxWindowsFromBody(body(-10))?.[0]?.used_percent, 100);
});

test("a provider is a MiniMax plan by its preset or its endpoint", () => {
  assert.equal(isMiniMaxPlan({ type: "anthropic-compatible", preset: "minimax", url: "https://api.minimax.io/anthropic" }), true);
  assert.equal(isMiniMaxPlan({ type: "anthropic-compatible", url: "https://api.minimax.io/anthropic" }), true);
  assert.equal(isMiniMaxPlan({ type: "anthropic-compatible", url: "https://api.minimaxi.com/anthropic" }), true, "the China region answers on its own host");
  assert.equal(isMiniMaxPlan({ type: "anthropic-compatible", url: "https://api.deepseek.com/anthropic" }), false);
  assert.equal(isMiniMaxPlan({ type: "anthropic-compatible", url: "https://api.minimax.io/v1" }), false);
  assert.equal(isMiniMaxPlan({ type: "openai-compatible", preset: "minimax" }), false);
});

test("the key is read from the header the provider keeps it in, and goes out as a bearer", () => {
  assert.equal(minimaxKey({ "x-api-key": "secret-key" }), "secret-key");
  assert.equal(minimaxKey({ authorization: "Bearer secret-key" }), "secret-key");
  assert.equal(minimaxKey({ "X-API-Key": "secret-key" }), "secret-key", "the header's name is not case-sensitive");
  assert.equal(minimaxKey({}), undefined);
  assert.equal(minimaxKey({ authorization: "Bearer " }), undefined);
  const request = minimaxQuotaRequest("https://api.minimax.io/anthropic", { "x-api-key": "secret-key" });
  assert.equal(request?.url, "https://api.minimax.io/v1/api/openplatform/coding_plan/remains");
  assert.equal(request?.headers.authorization, "Bearer secret-key");
  assert.equal(request?.headers["x-api-key"], undefined, "the key travels once, as the bearer the endpoint wants");
  assert.equal(minimaxQuotaRequest("https://api.minimaxi.com/anthropic", { "x-api-key": "k" })?.url, "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");
  assert.equal(minimaxQuotaRequest("not an address", { "x-api-key": "k" }), null);
  assert.equal(minimaxQuotaRequest("https://api.minimax.io/anthropic", {}), null, "no key, no plan to read");
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
  const usage = new MiniMaxUsage({ fetch: fetchImpl, now: () => now, ttlMs: 300_000, warn: () => {} });
  const first = await usage.windows("mini", "https://api.minimax.io/anthropic", { "x-api-key": "key" });
  assert.equal(first.length, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], "https://api.minimax.io/v1/api/openplatform/coding_plan/remains");
  await usage.windows("mini", "https://api.minimax.io/anthropic", { "x-api-key": "key" });
  assert.equal(seen.length, 1, "the second read is the cached one");
  now += 300_001;
  fail = true;
  const third = await usage.windows("mini", "https://api.minimax.io/anthropic", { "x-api-key": "key" });
  assert.equal(third.length, 2, "a failed lookup keeps the last good windows");
  assert.equal(seen.length, 2);
});

test("a replaced key does not inherit the old key's windows", async () => {
  const noPlan = { model_remains: [], base_resp: { status_code: 1004, status_msg: "no plan" } };
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).authorization;
    return new Response(JSON.stringify(auth === "Bearer plan-key" ? measured : noPlan), { status: 200 });
  }) as unknown as typeof fetch;
  const usage = new MiniMaxUsage({ fetch: fetchImpl, ttlMs: 300_000, warn: () => {} });
  assert.equal((await usage.windows("mini", "https://api.minimax.io/anthropic", { "x-api-key": "plan-key" })).length, 2);
  assert.deepEqual(await usage.windows("mini", "https://api.minimax.io/anthropic", { "x-api-key": "payg-key" }), [], "the new key starts with no windows");
});
