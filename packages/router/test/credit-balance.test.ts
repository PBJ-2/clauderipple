// The credit-balance reader: which providers sell credit, the two bodies that state a balance, the
// cache, and what happens when a read fails. The response shapes are the documented ones (2026-10-21);
// the values are fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditBalances, creditVendor, lowCredit, openRouterCreditsFromBody, openRouterKeyFromBody, sailBalanceFromBody } from "../src/providers/credit-balance.ts";

test("a provider sells credit by its host, and nothing else does", () => {
  assert.equal(creditVendor({ url: "https://api.sailresearch.com/anthropic" }), "sail");
  assert.equal(creditVendor({ url: "https://openrouter.ai/api" }), "openrouter");
  assert.equal(creditVendor({ url: "https://api.deepseek.com/anthropic" }), null);
  assert.equal(creditVendor({ url: "not a url" }), null);
  assert.equal(creditVendor({}), null);
});

test("sail's balance is fractional cents, and balance_unavailable says nothing", () => {
  assert.deepEqual(sailBalanceFromBody({ balance: 73795, days_remaining: 12.3 }), { remaining_usd: 737.95, days_remaining: 12.3, low: false });
  assert.deepEqual(sailBalanceFromBody({ balance: "499.5" }), { remaining_usd: 5, low: false });
  // Under $5, or under three days of it, is low.
  assert.equal(sailBalanceFromBody({ balance: 400 })?.low, true);
  assert.equal(sailBalanceFromBody({ balance: 100000, days_remaining: 2.5 })?.low, true);
  assert.equal(sailBalanceFromBody({ balance_unavailable: true }), null);
  assert.equal(sailBalanceFromBody({}), null);
  assert.equal(sailBalanceFromBody(null), null);
  assert.equal(lowCredit(5), false);
  assert.equal(lowCredit(4.99), true);
});

test("OpenRouter's remaining credit is the difference, with the key's limit as the fallback", () => {
  assert.deepEqual(openRouterCreditsFromBody({ data: { total_credits: 100, total_usage: 20.5 } }), { remaining_usd: 79.5, low: false });
  assert.equal(openRouterCreditsFromBody({ data: { total_credits: 10 } }), null);
  assert.equal(openRouterCreditsFromBody({}), null);
  // limit_remaining null means the key has no limit — not a balance of zero.
  assert.deepEqual(openRouterKeyFromBody({ data: { limit: 20, limit_remaining: 3.25 } }), { remaining_usd: 3.25, low: true });
  assert.equal(openRouterKeyFromBody({ data: { limit: null, limit_remaining: null } }), null);
});

test("a balance is cached per provider, and a failed read keeps the last good one", async () => {
  const seen: string[] = [];
  let fail = false;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push(url);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer key");
    if (fail) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ data: { total_credits: 50, total_usage: 10 } }), { status: 200 });
  }) as unknown as typeof fetch;
  let now = 1_000_000;
  const credits = new CreditBalances({ fetch: fetchImpl, now: () => now, ttlMs: 300_000, warn: () => {} });
  const first = await credits.balance("openrouter", "openrouter", { authorization: "Bearer key" });
  assert.deepEqual(first, { remaining_usd: 40, low: false });
  assert.deepEqual(seen, ["https://openrouter.ai/api/v1/credits"]);
  assert.equal(credits.readAt("openrouter"), now);
  // Cached, so the same answer without a request.
  await credits.balance("openrouter", "openrouter", { authorization: "Bearer key" });
  assert.equal(seen.length, 1);
  now += 300_001;
  fail = true;
  const third = await credits.balance("openrouter", "openrouter", { authorization: "Bearer key" });
  assert.deepEqual(third, { remaining_usd: 40, low: false });
  assert.equal(credits.readAt("openrouter"), now - 300_001, "a failed read does not make the old balance look new");
});

test("OpenRouter falls back to the key's limit when the credits read fails", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    if (url.endsWith("/credits")) return new Response("{}", { status: 403 });
    return new Response(JSON.stringify({ data: { limit: 20, limit_remaining: 7.5 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const credits = new CreditBalances({ fetch: fetchImpl, now: () => 1_000_000, warn: () => {} });
  assert.deepEqual(await credits.balance("or", "openrouter", {}), { remaining_usd: 7.5, low: false });
  assert.deepEqual(seen, ["https://openrouter.ai/api/v1/credits", "https://openrouter.ai/api/v1/key"]);
});

test("a provider never read has no balance, and a failed first read does not invent one", async () => {
  const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const credits = new CreditBalances({ fetch: fetchImpl, now: () => 1_000_000, warn: () => {} });
  assert.equal(credits.peek("sail"), undefined);
  assert.equal(credits.readAt("sail"), 0);
  assert.equal(await credits.balance("sail", "sail", { authorization: "Bearer key" }), null);
  assert.equal(credits.readAt("sail"), 0);
});

test("sail is read at its usage summary, and a body without a balance keeps the last good one", async () => {
  const seen: string[] = [];
  let body: Record<string, unknown> = { balance: 12345, days_remaining: 10 };
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  let now = 1_000_000;
  const credits = new CreditBalances({ fetch: fetchImpl, now: () => now, ttlMs: 1000, warn: () => {} });
  assert.deepEqual(await credits.balance("sail", "sail", {}), { remaining_usd: 123.45, days_remaining: 10, low: false });
  assert.deepEqual(seen, ["https://api.sailresearch.com/v2/usage/summary?range=30d"]);
  now += 2000;
  body = { balance_unavailable: true };
  assert.deepEqual(await credits.balance("sail", "sail", {}), { remaining_usd: 123.45, days_remaining: 10, low: false });
});
