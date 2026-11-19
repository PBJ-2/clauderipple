// Anthropic's own model list replaces the constant the provider form and mapping table used to
// carry, and a release the account gains is declared on its own (2026-10-08).
import { test } from "node:test";
import assert from "node:assert/strict";

import { ClaudeModelCatalog, claudeModelsFromBody, newClaudeReleases } from "../src/providers/anthropic-models.ts";

// Trimmed from the live answer (2026-10-08): newest first, effort per level, a dated id for 4.5.
const BODY = {
  data: [
    { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", created_at: "2026-10-07T18:00:00Z", line: "haiku", max_input_tokens: 1000000, lifecycle: "active",
      capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } } },
    { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-28T00:00:00Z", line: "sonnet", max_input_tokens: 1000000, lifecycle: "active",
      capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } } } },
    { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-21T16:24:00Z", line: "opus", lifecycle: "active" },
    { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z", line: "opus", lifecycle: "active" },
    { type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-06-29T00:00:00Z", line: "sonnet", lifecycle: "active" },
    { type: "model", id: "claude-opus-4-1", display_name: "Claude Opus 4.1", created_at: "2025-08-05T00:00:00Z", line: "opus", lifecycle: "retired" },
    { type: "model", id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-15T00:00:00Z", line: "haiku", max_input_tokens: 200000, lifecycle: "active",
      capabilities: { effort: { supported: false, low: { supported: false }, medium: { supported: false }, high: { supported: false }, xhigh: { supported: false }, max: { supported: false } } } },
  ],
};

test("claudeModelsFromBody keeps active models, folds a dated id to its alias, and reads the effort ladder", () => {
  const models = claudeModelsFromBody(BODY);
  assert.deepEqual(models.map((model) => model.id), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
  const haiku55 = models[0]!;
  assert.equal(haiku55.name, "Haiku 5.5");
  assert.deepEqual(haiku55.effortLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(haiku55.contextWindow, 1000000);
  assert.deepEqual(models[1]!.effortLevels, ["low", "medium", "high", "max"]);
  assert.equal(models[2]!.effortLevels, undefined, "no effort block, no ladder stated");
  assert.deepEqual(models.at(-1)!.effortLevels, [], "Haiku 4.5 takes no effort");
});

test("newClaudeReleases offers each family's newer models once, and never a family nobody declared", () => {
  const live = claudeModelsFromBody(BODY);
  const declared = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];
  assert.deepEqual(newClaudeReleases(live, declared, new Set()).map((model) => model.id), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  // Offered before (and unticked since): not offered again.
  assert.deepEqual(newClaudeReleases(live, declared, new Set(["claude-sonnet-5-5"])).map((model) => model.id), ["claude-haiku-5-5", "claude-opus-5-5"]);
  // Only Opus declared: no Sonnet or Haiku is pushed onto the provider.
  assert.deepEqual(newClaudeReleases(live, ["claude-opus-5"], new Set()).map((model) => model.id), ["claude-opus-5-5"]);
  // Already on the newest: nothing to add, and an older model is never added.
  assert.deepEqual(newClaudeReleases(live, ["claude-opus-5-5"], new Set()), []);
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("ClaudeModelCatalog asks once per hour with the account's headers and keeps the last good list", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const seen: Record<string, string>[] = [];
  const catalog = new ClaudeModelCatalog(
    { credentials: async () => [{ id: "current", headers: { authorization: "Bearer t" } } as never] },
    {
      upstream: () => "api.anthropic.com",
      now: () => now,
      fetch: async (_url, init) => {
        calls++;
        seen.push(init.headers as Record<string, string>);
        return fail ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(BODY), { status: 200 });
      },
    },
  );
  assert.equal((await catalog.list())?.[0]?.id, "claude-haiku-5-5");
  assert.equal(seen[0]?.authorization, "Bearer t");
  assert.equal(seen[0]?.["anthropic-version"], "2023-06-01");
  await catalog.list();
  assert.equal(calls, 1, "cached within the hour");
  now = 61 * 60_000;
  fail = true;
  assert.equal((await catalog.list())?.length, 6, "a stale cache is served while its failed refresh runs");
  await settle();
  assert.equal(calls, 2);
  assert.equal((await catalog.list())?.length, 6, "a failed refresh keeps the last good list");
});

// The lookup two seconds after a restart was answered 401, and the failure was then held for the
// whole hour (2026-11-18).
test("ClaudeModelCatalog tries a failed lookup again within seconds, backing off, and an hour after it succeeds", async () => {
  let now = 0;
  let calls = 0;
  let fail = true;
  const catalog = new ClaudeModelCatalog(
    { credentials: async () => [{ id: "current", headers: { authorization: "Bearer t" } } as never] },
    {
      upstream: () => "api.anthropic.com",
      now: () => now,
      fetch: async () => {
        calls++;
        return fail ? new Response("{}", { status: 401 }) : new Response(JSON.stringify(BODY), { status: 200 });
      },
    },
  );
  assert.equal(await catalog.list(), null, "no list was ever had");
  now = 29_000;
  await catalog.list();
  assert.equal(calls, 1, "not before the first retry is due");
  now = 30_000;
  assert.equal(await catalog.list(), null);
  assert.equal(calls, 2, "tried again 30 s after the miss");
  now = 30_000 + 59_000;
  await catalog.list();
  assert.equal(calls, 2, "the second miss waits twice as long");
  now = 30_000 + 60_000;
  fail = false;
  assert.equal((await catalog.list())?.[0]?.id, "claude-haiku-5-5");
  assert.equal(calls, 3);
  now += 59 * 60_000;
  await catalog.list();
  assert.equal(calls, 3, "a good list is kept for the hour");
  now += 60_000;
  fail = true;
  assert.equal((await catalog.list())?.length, 6);
  await settle();
  assert.equal(calls, 4);
  now += 30_000;
  assert.equal((await catalog.list())?.length, 6, "the backoff starts again from 30 s, and the last good list stays");
  await settle();
  assert.equal(calls, 5);
});

test("ClaudeModelCatalog asks only the current login, never another account's credential", async () => {
  const tried: string[] = [];
  const catalog = new ClaudeModelCatalog(
    {
      credentials: async () => [
        { id: "current", headers: { authorization: "Bearer stale" } } as never,
        { id: "stored", headers: { authorization: "Bearer good" } } as never,
      ],
    },
    {
      upstream: () => "api.anthropic.com",
      fetch: async (_url, init) => {
        const auth = (init.headers as Record<string, string>).authorization!;
        tried.push(auth);
        return auth === "Bearer good" ? new Response(JSON.stringify(BODY), { status: 200 }) : new Response("{}", { status: 401 });
      },
    },
  );
  assert.equal(await catalog.list(), null);
  assert.deepEqual(tried, ["Bearer stale"]);
});

test("ClaudeModelCatalog waits out Retry-After", async () => {
  let now = 0;
  let calls = 0;
  const catalog = new ClaudeModelCatalog(
    { credentials: async () => [{ id: "current", headers: {} } as never] },
    {
      upstream: () => "api.anthropic.com",
      now: () => now,
      retryMs: 30_000,
      fetch: async () => {
        calls++;
        return calls === 1
          ? new Response("{}", { status: 429, headers: { "retry-after": "120" } })
          : new Response(JSON.stringify(BODY), { status: 200 });
      },
    },
  );
  assert.equal(await catalog.list(), null);
  assert.equal(calls, 1);
  now = 31_000;
  assert.equal(await catalog.list(), null);
  assert.equal(calls, 1, "the ordinary retry time does not override Retry-After");
  now = 121_000;
  assert.equal((await catalog.list())?.length, 6);
  assert.equal(calls, 2, "one request is made per lookup");
});

test("ClaudeModelCatalog serves its cached list while a refresh runs", async () => {
  let now = 0;
  let calls = 0;
  let resolveRefresh!: (response: Response) => void;
  const newer = structuredClone(BODY);
  newer.data[0]!.id = "claude-haiku-5-6";
  const catalog = new ClaudeModelCatalog(
    { credentials: async () => [{ id: "current", headers: {} } as never] },
    {
      upstream: () => "api.anthropic.com",
      now: () => now,
      ttlMs: 100,
      fetch: async () => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify(BODY), { status: 200 });
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      },
    },
  );
  assert.equal((await catalog.list())?.[0]?.id, "claude-haiku-5-5");
  now = 101;
  assert.equal((await catalog.list())?.[0]?.id, "claude-haiku-5-5");
  await settle();
  assert.equal(calls, 2);
  resolveRefresh(new Response(JSON.stringify(newer), { status: 200 }));
  await settle();
  assert.equal((await catalog.list())?.[0]?.id, "claude-haiku-5-6");
  assert.equal(calls, 2, "only one refresh runs");
});

test("ClaudeModelCatalog caps the wait when it has no list yet", async () => {
  let calls = 0;
  const catalog = new ClaudeModelCatalog(
    { credentials: async () => [{ id: "current", headers: {} } as never] },
    {
      upstream: () => "api.anthropic.com",
      waitMs: 20,
      fetch: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return new Response(JSON.stringify(BODY), { status: 200 });
      },
    },
  );
  const started = Date.now();
  assert.equal(await catalog.list(), null);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 10 && elapsed < 150, `waited ${elapsed} ms`);
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal((await catalog.list())?.length, 6);
  assert.equal(calls, 1);
});

test("ClaudeModelCatalog calls onFirstList once, on the first list", async () => {
  let now = 0;
  let calls = 0;
  let notified = 0;
  const warnings: string[] = [];
  const catalog = new ClaudeModelCatalog(
    { credentials: async () => [{ id: "current", headers: {} } as never] },
    {
      upstream: () => "api.anthropic.com",
      now: () => now,
      ttlMs: 10,
      retryMs: 5,
      warn: (message) => warnings.push(message),
      fetch: async () => {
        calls++;
        return calls === 1 ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(BODY), { status: 200 });
      },
    },
  );
  catalog.onFirstList(() => { throw new Error("listener broke"); });
  catalog.onFirstList(() => { notified++; });
  assert.equal(await catalog.list(), null);
  assert.equal(notified, 0);
  now = 5;
  assert.equal((await catalog.list())?.length, 6);
  assert.equal(notified, 1);
  assert.ok(warnings.some((message) => message.includes("listener broke")));
  now = 16;
  assert.equal((await catalog.list())?.length, 6);
  await settle();
  assert.equal(notified, 1);
  assert.equal(calls, 3);
});
