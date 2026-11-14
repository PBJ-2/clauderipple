import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeUsage, claudeLimitResetMs, claudeUsageFromBody, claudeUsageFromHeaders } from "../src/providers/anthropic-usage.ts";

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

test("weekly_scoped entries ride beside rate_limits for the mod's per-model row", () => {
  const body = {
    ...BODY,
    limits: [
      // Shape measured 2026-10-15.
      { kind: "weekly_scoped", group: "weekly", percent: 2, severity: "normal", resets_at: "2026-10-15T10:59:59.851460+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 41, severity: "normal", resets_at: "2026-10-15T10:59:59.851460+00:00", scope: { model: { id: null, display_name: "Opus" }, surface: null }, is_active: true },
      // Other kinds, nameless models and unusable percents are left out.
      { kind: "daily_scoped", group: "daily", percent: 9, scope: { model: { display_name: "Daily" } } },
      { kind: "weekly_scoped", group: "weekly", percent: 3, scope: { model: { id: null, display_name: null } } },
      { kind: "weekly_scoped", group: "weekly", percent: "many", scope: { model: { display_name: "Vague" } } },
      null,
    ],
  };
  const q = claudeUsageFromBody(body) as { scoped: Record<string, number | string>[] };
  const resetAt = Math.round(Date.parse("2026-10-15T10:59:59.851460+00:00") / 1000);
  assert.deepEqual(q.scoped, [
    { name: "Fable", used_percent: 2, window_minutes: 10080, reset_at: resetAt },
    { name: "Opus", used_percent: 41, window_minutes: 10080, reset_at: resetAt },
  ]);
  // Without scoped entries the snapshot keeps its old shape exactly.
  const plain = claudeUsageFromBody(BODY) as Record<string, unknown>;
  assert.equal(Object.hasOwn(plain, "scoped"), false);
  assert.deepEqual(Object.keys(plain).sort(), ["at", "rate_limits", "type"]);
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

// Measured against the installed CLI 2.1.317 bundle (2026-11-05): the unified utilization
// headers are fractions 0..1 and the resets are epoch seconds.
test("unified limit headers give the same windows in the snapshot shape", () => {
  const now = Date.parse("2026-11-02T11:18:00Z");
  const reset5h = Math.floor(now / 1000) + 1_200;
  const reset7d = Math.floor(now / 1000) + 86_400;
  const q = claudeUsageFromHeaders({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1",
    "anthropic-ratelimit-unified-5h-reset": String(reset5h),
    "anthropic-ratelimit-unified-7d-utilization": "0.584",
    "anthropic-ratelimit-unified-7d-reset": String(reset7d),
  }, now) as { rate_limits: { primary: Record<string, number>; secondary: Record<string, number> }; at: number };
  assert.equal(q.at, now);
  assert.deepEqual(q.rate_limits.primary, { used_percent: 100, window_minutes: 300, reset_at: reset5h });
  assert.deepEqual(q.rate_limits.secondary, { used_percent: 58.4, window_minutes: 10080, reset_at: reset7d });
  assert.equal(claudeUsageFromHeaders({}, now), null, "no unified limiter headers, no reading");
  assert.equal(claudeUsageFromHeaders({ "anthropic-ratelimit-unified-status": "allowed" }, now), null, "a window is what a reading needs");
  const ended = claudeUsageFromHeaders({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "1",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / 1000) - 10),
  }, now) as { rate_limits: { primary: Record<string, number> } };
  assert.equal(ended.rate_limits.primary.reset_at, undefined, "a reset already behind us is not shown as the next one");
});

// A 429 without retry-after cooled a spent Claude subscription for a minute, so a 5h/7d window was
// re-tried every minute until it reset (2026-11-07). The unified headers state the real reset.
test("a rejected unified window states how long the account must rest", () => {
  const now = Date.parse("2026-11-07T10:00:00Z");
  const reset5h = Math.floor(now / 1000) + 1_200;
  const reset7d = Math.floor(now / 1000) + 86_400;
  const headers = {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1",
    "anthropic-ratelimit-unified-5h-reset": String(reset5h),
    "anthropic-ratelimit-unified-7d-utilization": "0.584",
    "anthropic-ratelimit-unified-7d-reset": String(reset7d),
  };
  assert.equal(claudeLimitResetMs(headers, now), 1_200_000, "the spent 5h window's reset");
  // Only a window that is actually spent names a wait; allowed, below 100%, or a reset already gone
  // by is an ordinary 429 and keeps the pool's default.
  assert.equal(claudeLimitResetMs({ ...headers, "anthropic-ratelimit-unified-status": "allowed" }, now), undefined);
  assert.equal(claudeLimitResetMs({ ...headers, "anthropic-ratelimit-unified-5h-utilization": "0.99" }, now), undefined);
  assert.equal(claudeLimitResetMs({ ...headers, "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / 1000) - 1) }, now), undefined);
  assert.equal(claudeLimitResetMs({ "anthropic-ratelimit-unified-5h-reset": String(reset5h) }, now), undefined, "no limiter status, no claim");
  // Both windows spent: the soonest reset is the first moment asking again can work.
  assert.equal(claudeLimitResetMs({ ...headers, "anthropic-ratelimit-unified-7d-utilization": "1" }, now), 1_200_000);
});

// Issue #123 part 2: a refused usage lookup kept the last numbers and showed them as current.
test("a 429 keeps the last numbers, marks them stale and honors retry-after (#123)", async () => {
  let now = 1_000_000;
  const calls: string[] = [];
  const lines: string[] = [];
  let reply = (): Response => Response.json(BODY);
  const usage = new ClaudeUsage(
    { credentials: async () => [{ id: "current:aa", ownerId: "current", headers: { authorization: "Bearer one" } }] },
    {
      upstream: () => "api.anthropic.com",
      now: () => now,
      ttlMs: 60_000,
      warn: (line) => lines.push(line),
      fetch: async () => { calls.push("call"); return reply(); },
    },
  );
  const first = await usage.snapshot();
  assert.equal((first.current as Record<string, unknown>).stale, undefined, "a successful reading is not stale");

  now += 61_000;
  reply = () => new Response("no", { status: 429, headers: { "retry-after": "300" } });
  const stale = (await usage.snapshot()).current as Record<string, unknown>;
  assert.equal((stale.rate_limits as { primary: { used_percent: number } }).primary.used_percent, 14, "the last good numbers stay");
  assert.equal(stale.at, 1_000_000, "at is the last success, not the failed try");
  assert.equal(stale.stale, true);
  assert.equal(stale.failed_status, 429);
  assert.equal(stale.failed_at, 1_061_000);
  assert.ok(lines.some((line) => /HTTP 429 \(retry after 300s\)/.test(line)), "the vendor's wait is logged");

  // Inside retry-after nothing is asked again, although the normal interval has passed.
  now += 60_000;
  await usage.snapshot();
  assert.equal(calls.length, 2);
  now += 300_000;
  reply = () => Response.json(BODY);
  await usage.snapshot();
  assert.equal(calls.length, 3, "the wait ends and the account is asked again");
  const recovered = (await usage.snapshot()).current as Record<string, unknown>;
  assert.equal(recovered.stale, undefined);
});

test("a message answer fills in a stale reading from its unified headers (#123)", async () => {
  let now = 1_000_000;
  let fail = false;
  const usage = new ClaudeUsage(
    { credentials: async () => [{ id: "current:aa", ownerId: "current", headers: {} }] },
    {
      upstream: () => "api.anthropic.com",
      now: () => now,
      ttlMs: 60_000,
      fetch: async () => fail ? new Response("no", { status: 429 }) : Response.json(BODY),
    },
  );
  const headers = {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / 1000) + 600),
  };
  await usage.snapshot();
  usage.observeAnswer("current", headers);
  const fresh = (await usage.snapshot()).current as Record<string, unknown>;
  assert.equal((fresh.rate_limits as { primary: { used_percent: number } }).primary.used_percent, 14, "the richer body reading wins while it is fresh");

  now += 61_000;
  fail = true;
  await usage.snapshot();
  usage.observeAnswer("current", headers);
  const refreshed = (await usage.snapshot()).current as Record<string, unknown>;
  assert.equal((refreshed.rate_limits as { primary: { used_percent: number } }).primary.used_percent, 100, "the answer's headers fill in while the usage endpoint refuses");
  assert.equal(refreshed.stale, undefined);
});

test("during a backoff, every answer's headers update the reading and a body read still wins (#123)", async () => {
  let now = 1_000_000;
  let reply = (): Response => Response.json(BODY);
  const usage = new ClaudeUsage(
    { credentials: async () => [{ id: "current:aa", ownerId: "current", headers: {} }] },
    { upstream: () => "api.anthropic.com", now: () => now, ttlMs: 60_000, fetch: async () => reply() },
  );
  const headers = (fraction: number) => ({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": String(fraction),
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / 1000) + 600),
  });
  const primary = async () => ((await usage.snapshot()).current as { rate_limits: { primary: { used_percent: number } }; stale?: true })
    .rate_limits.primary.used_percent;
  await usage.snapshot();
  now += 61_000;
  reply = () => new Response("no", { status: 429, headers: { "retry-after": "3600" } });
  await usage.snapshot();
  usage.observeAnswer("current", headers(0.1));
  assert.equal(await primary(), 10, "the answer's headers fill in while the endpoint refuses");
  now += 60_000;
  usage.observeAnswer("current", headers(1));
  assert.equal(await primary(), 100, "a newer header reading replaces the older one for the whole wait");
  // The wait ends, a body reading arrives, and headers stop overriding it until it goes stale again.
  now += 3_600_000;
  reply = () => Response.json(BODY);
  assert.equal(await primary(), 14);
  usage.observeAnswer("current", headers(1));
  assert.equal(await primary(), 14, "a fresh body reading is not replaced by an answer's headers");
});

test("a body reading older than its interval no longer blocks an answer's headers (#123)", async () => {
  let now = 1_000_000;
  let reply = (): Response => Response.json(BODY);
  const usage = new ClaudeUsage(
    { credentials: async () => [{ id: "current:aa", ownerId: "current", headers: {} }] },
    { upstream: () => "api.anthropic.com", now: () => now, ttlMs: 60_000, fetch: async () => reply() },
  );
  const headers = {
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / 1000) + 600),
  };
  const primary = async () => ((await usage.snapshot()).current as { rate_limits: { primary: { used_percent: number } } })
    .rate_limits.primary.used_percent;
  await usage.snapshot();
  usage.observeAnswer("current", headers);
  assert.equal(await primary(), 14, "within the interval the richer body reading wins");
  // The interval passes while nobody polls, so the body reading is now as old as a failed try.
  now += 60_000;
  reply = () => new Response("no", { status: 429, headers: { "retry-after": "3600" } });
  usage.observeAnswer("current", headers);
  assert.equal(await primary(), 42, "past the interval the answer's headers are the newer reading");
});

test("a 429 that lands after an answer's newer reading does not mark that reading stale (#123)", async () => {
  let now = 1_000_000;
  let release!: (response: Response) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const usage = new ClaudeUsage(
    { credentials: async () => [{ id: "current:aa", ownerId: "current", headers: {} }] },
    { upstream: () => "api.anthropic.com", now: () => now, ttlMs: 60_000,
      fetch: () => { began(); return new Promise<Response>(resolve => { release = resolve; }); } },
  );
  const pending = usage.snapshot(); // the refresh starts now
  await started;
  // A Messages answer stores fresh header readings while the lookup is still in flight.
  now += 30_000;
  usage.observeAnswer("current", {
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.9",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / 1000) + 600),
  });
  release(new Response("no", { status: 429, headers: { "retry-after": "60" } }));
  const snapshot = (await pending).current as Record<string, unknown>;
  assert.equal(snapshot.at, 1_030_000, "the answer's reading stays the current one");
  assert.equal(snapshot.stale, undefined, "a refusal older than the reading does not mark it stale");
  assert.equal(snapshot.failed_at, undefined);
});

test("an answer's reading stored in the same millisecond as the refusal is not marked stale (#123)", async () => {
  let now = 1_000_000;
  let release!: (response: Response) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const usage = new ClaudeUsage(
    { credentials: async () => [{ id: "current:aa", ownerId: "current", headers: {} }] },
    { upstream: () => "api.anthropic.com", now: () => now, ttlMs: 60_000,
      fetch: () => { began(); return new Promise<Response>(resolve => { release = resolve; }); } },
  );
  const pending = usage.snapshot(); // the refresh starts now
  await started;
  // The clock does not advance, so the reading and the failure carry the same `at`.
  usage.observeAnswer("current", {
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.9",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / 1000) + 600),
  });
  release(new Response("no", { status: 429, headers: { "retry-after": "60" } }));
  const snapshot = (await pending).current as Record<string, unknown>;
  assert.equal(snapshot.at, 1_000_000, "the answer's reading is the current one");
  assert.equal(snapshot.stale, undefined, "the refusal started before the reading, so it does not mark it stale");
  assert.equal(snapshot.failed_at, undefined);
});

test("a header reading that lands while credentials are collected is not marked stale (#123)", async () => {
  let now = 1_000_000;
  let release!: (list: { id: string; ownerId: string; headers: Record<string, string> }[]) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const usage = new ClaudeUsage(
    { credentials: () => { began(); return new Promise(resolve => { release = resolve; }); } },
    { upstream: () => "api.anthropic.com", now: () => now, ttlMs: 60_000,
      fetch: async () => new Response("no", { status: 429, headers: { "retry-after": "60" } }) },
  );
  const pending = usage.snapshot(); // the refresh starts, and waits on the credential list
  await started;
  // A Messages answer stores a fresh header reading before the credential list arrives.
  now += 30_000;
  usage.observeAnswer("current", {
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.9",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / 1000) + 600),
  });
  release([{ id: "current:aa", ownerId: "current", headers: {} }]);
  const snapshot = (await pending).current as Record<string, unknown>;
  assert.equal(snapshot.at, 1_030_000, "the answer's reading stays the current one");
  assert.equal(snapshot.stale, undefined, "the refusal started before the reading, so it does not mark it stale");
  assert.equal(snapshot.failed_at, undefined);
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

test("a model family is read from a model id or a usage window's display name", async () => {
  const { claudeModelFamily } = await import("../src/providers/anthropic-usage.ts");
  assert.equal(claudeModelFamily("claude-fable-5-1"), "fable");
  assert.equal(claudeModelFamily("Fable"), "fable");
  assert.equal(claudeModelFamily("claude-opus-5-5"), "opus");
  assert.equal(claudeModelFamily("claude-sonnet-5-5"), "sonnet");
  assert.equal(claudeModelFamily("claude-3-5-haiku-20241022"), "haiku");
  assert.equal(claudeModelFamily("deepseek-v4"), undefined, "an unknown model has no scope");
  assert.equal(claudeModelFamily("unfabled"), undefined, "a family is a word of the id, not any substring");
});

test("a spent per-model window's reset is read from the cached body reading, and header readings do not erase it", async () => {
  let now = 1_000_000_000_000;
  const resetsAt = (seconds: number) => new Date(now + seconds * 1000).toISOString();
  const body = (fable: number, reset: string) => ({
    ...BODY,
    limits: [
      { kind: "weekly_scoped", percent: fable, resets_at: reset, scope: { model: { id: null, display_name: "Fable" }, surface: null } },
      { kind: "weekly_scoped", percent: 3, resets_at: reset, scope: { model: { id: null, display_name: "Opus" }, surface: null } },
    ],
  });
  let reply = body(100, resetsAt(7_200));
  let asked = 0;
  const usage = new ClaudeUsage(
    { credentials: async () => [{ id: "current:aa", ownerId: "current", headers: {} }] },
    { upstream: () => "api.anthropic.com", now: () => now, ttlMs: 60_000, fetch: async () => { asked++; return Response.json(reply); } },
  );
  const current = { id: "current:aa", ownerId: "current", headers: {} };
  assert.equal(usage.spentScopeResetMs(current, "fable"), undefined, "nothing is read before a body reading exists");
  await usage.snapshot();
  assert.equal(asked, 1);
  assert.equal(usage.spentScopeResetMs(current, "fable"), 7_200_000);
  assert.equal(usage.spentScopeResetMs(current, "opus"), undefined, "a window under 100% is not spent");
  assert.equal(usage.spentScopeResetMs({ id: "other", headers: {} }, "fable"), undefined, "another account has its own reading");
  // The app signed in to another account: same owner "current", another durable account.
  assert.equal(usage.spentScopeResetMs({ id: "current:bb", ownerId: "current", healthKey: "login-b", headers: {} }, "fable"), undefined,
    "a reading taken on the previous login does not rest the next one");
  // A later header reading replaces the display snapshot and carries no per-model window.
  now += 120_000;
  usage.observeAnswer("current", {
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.1",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / 1000) + 600),
  });
  assert.equal(usage.spentScopeResetMs(current, "fable"), 7_200_000 - 120_000, "the spent window stays spent until its reset");
  now += 7_200_000;
  assert.equal(usage.spentScopeResetMs(current, "fable"), undefined, "after the reset it is not");
  // A newer body reading that no longer lists the window clears it.
  reply = { ...BODY, limits: [] } as typeof reply;
  now += 120_000;
  await usage.snapshot();
  assert.equal(usage.spentScopeResetMs(current, "fable"), undefined);
});
