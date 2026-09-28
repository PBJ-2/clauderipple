import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeUsage, claudeUsageFromBody } from "../src/providers/anthropic-usage.ts";

// Shape measured 2026-09-28 from GET /api/oauth/usage.
const BODY = {
  five_hour: { utilization: 14.0, resets_at: "2026-09-28T08:30:00.581181+00:00", limit_dollars: null },
  seven_day: { utilization: 10.0, resets_at: "2026-10-01T11:00:00.581203+00:00" },
  seven_day_opus: null,
};

test("the usage body maps onto the Codex snapshot shape the GUI already reads", () => {
  const q = claudeUsageFromBody(BODY) as { type: string; rate_limits: { primary: Record<string, number>; secondary: Record<string, number> } };
  assert.equal(q.type, "claude.usage");
  assert.deepEqual(q.rate_limits.primary, { used_percent: 14, window_minutes: 300, reset_at: Math.round(Date.parse("2026-09-28T08:30:00.581Z") / 1000) });
  assert.equal(q.rate_limits.secondary.used_percent, 10);
  assert.equal(q.rate_limits.secondary.window_minutes, 7 * 24 * 60);
  assert.equal(claudeUsageFromBody({ five_hour: null, seven_day: null }), null);
  assert.equal(claudeUsageFromBody(null), null);
});

test("each account is asked once per interval with its own headers, and a failure keeps the last numbers", async () => {
  let now = 1_000_000;
  const calls: string[] = [];
  let fail = false;
  const usage = new ClaudeUsage(
    {
      credentials: async () => [
        { id: "current:aa", ownerId: "current", headers: { authorization: "Bearer one" } },
        { id: "acct:bb", ownerId: "acct", headers: { authorization: "Bearer two" } },
      ],
    },
    {
      upstream: () => "api.anthropic.com",
      now: () => now,
      ttlMs: 60_000,
      fetch: async (url, init) => {
        calls.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
        return fail ? new Response("no", { status: 500 }) : Response.json(BODY);
      },
    },
  );
  const first = await usage.snapshot();
  assert.deepEqual(Object.keys(first).sort(), ["acct", "current"]);
  assert.deepEqual(calls.sort(), ["https://api.anthropic.com/api/oauth/usage Bearer one", "https://api.anthropic.com/api/oauth/usage Bearer two"]);

  await usage.snapshot();
  assert.equal(calls.length, 2, "within the interval nothing is fetched");

  now += 61_000;
  fail = true;
  const kept = await usage.snapshot();
  assert.equal(calls.length, 4);
  assert.deepEqual(Object.keys(kept).sort(), ["acct", "current"], "a failed lookup keeps the last good numbers");
});

test("a removed account drops out of the snapshot", async () => {
  let now = 0;
  let owners = ["current", "gone"];
  const usage = new ClaudeUsage(
    { credentials: async () => owners.map((ownerId) => ({ id: `${ownerId}:x`, ownerId, headers: {} })) },
    { upstream: () => "api.anthropic.com", now: () => now, ttlMs: 1, fetch: async () => Response.json(BODY) },
  );
  assert.deepEqual(Object.keys(await usage.snapshot()).sort(), ["current", "gone"]);
  owners = ["current"];
  now += 10;
  assert.deepEqual(Object.keys(await usage.snapshot()), ["current"]);
});
