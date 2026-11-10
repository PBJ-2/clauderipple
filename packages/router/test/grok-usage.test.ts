import { test } from "node:test";
import assert from "node:assert/strict";
import { GrokUsage, grokWindowsFromBilling } from "../src/providers/grok/usage.ts";

// The shape answered 2026-10-15 on a SuperGrok account with nothing used that week (values faked).
const WEEK_BODY = {
  config: {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-10T04:12:41.377508+00:00", end: "2026-10-17T04:12:41.377508+00:00" },
    onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, isUnifiedBillingUser: true, prepaidBalance: { val: 0 },
    billingPeriodStart: "2026-10-10T04:12:41.377508+00:00", billingPeriodEnd: "2026-10-17T04:12:41.377508+00:00",
  },
};
const RESET = Math.round(Date.parse("2026-10-17T04:12:41.377508+00:00") / 1000);

test("a weekly pool reads as the week, an absent percent as zero (protobuf JSON leaves zeros out)", () => {
  assert.deepEqual(grokWindowsFromBilling(WEEK_BODY), [{ kind: "seven_day", used_percent: 0, window_minutes: 10080, reset_at: RESET }]);
  const used = { config: { ...WEEK_BODY.config, creditUsagePercent: 37.5 } };
  assert.equal(grokWindowsFromBilling(used)![0]!.used_percent, 37.5);
  const monthly = { config: { ...WEEK_BODY.config, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-11-01T00:00:00Z" } } };
  assert.deepEqual(grokWindowsFromBilling(monthly), [{ kind: "window", used_percent: 0, window_minutes: 43200, reset_at: Date.parse("2026-11-01T00:00:00Z") / 1000 }]);
  for (const body of [null, {}, { config: {} }, { config: { ...WEEK_BODY.config, creditUsagePercent: "x" } }]) assert.equal(grokWindowsFromBilling(body), null);
});

test("the pool is read with the session's headers, cached, and kept through a failure", async () => {
  let now = 0;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let answer: Response | Error = new Response(JSON.stringify({ config: { ...WEEK_BODY.config, creditUsagePercent: 12 } }), { status: 200 });
  const warnings: string[] = [];
  const usage = new GrokUsage("grok", {
    now: () => now,
    warn: (m) => warnings.push(m),
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const headers = async () => ({ authorization: "Bearer session", "x-xai-token-auth": "xai-grok-cli" });
  assert.equal((await usage.windows("https://cli-chat-proxy.grok.com/v1/", headers))[0]!.used_percent, 12);
  assert.equal(calls[0]!.url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
  assert.equal(calls[0]!.headers.authorization, "Bearer session");
  now = 60_000;
  await usage.windows("https://cli-chat-proxy.grok.com/v1", headers);
  assert.equal(calls.length, 1, "cached for five minutes");
  now = 6 * 60_000;
  answer = new Response("{}", { status: 401 });
  assert.equal((await usage.windows("https://cli-chat-proxy.grok.com/v1", headers))[0]!.used_percent, 12, "the last good pool stays");
  assert.deepEqual(warnings, ["grok usage grok: HTTP 401"]);
});

test("a cached Grok reading keeps the time it was taken, and a failed read keeps that time", async () => {
  let now = 1_000_000;
  let status = 200;
  const usage = new GrokUsage("grok", {
    now: () => now,
    warn: () => {},
    fetch: async () => (status === 200 ? new Response(JSON.stringify({ config: { ...WEEK_BODY.config, creditUsagePercent: 12 } }), { status: 200 }) : new Response("nope", { status })),
  });
  const headers = async () => ({ authorization: "Bearer session" });
  const url = "https://cli-chat-proxy.grok.com/v1";
  assert.equal((await usage.windows(url, headers))[0]!.read_at, 1_000_000);
  now += 4 * 60_000;
  assert.equal((await usage.windows(url, headers))[0]!.read_at, 1_000_000, "a cached reading keeps its own time");
  now += 2 * 60_000;
  status = 401;
  const kept = await usage.windows(url, headers);
  assert.equal(kept[0]!.used_percent, 12);
  assert.equal(kept[0]!.read_at, 1_000_000, "a failed read keeps the reading's time");
});
