import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, CredentialPool, retryAfterMs, targets, type Credential } from "../src/pool.ts";

import { ProviderHealth, providerExhaustion } from "../src/health.ts";

const creds = (...ids: string[]): Credential[] => ids.map((id) => ({ id, headers: { "x-api-key": id } }));

test("provider exhaustion is remembered with a reason, expires, and a successful request clears it", () => {
  const health = new ProviderHealth();
  const now = 1_000_000;
  const mark = providerExhaustion(402, "Insufficient Balance", undefined, now);
  health.observe("deepseek", 402, mark);
  assert.deepEqual(health.snapshot(now), { deepseek: { reason: "insufficient_balance", at: now, until: now + 1_800_000 } });
  health.observe("other", 200);
  health.observe("deepseek", 503);
  assert.ok(health.snapshot(now).deepseek);
  health.observe("deepseek", 200);
  assert.deepEqual(health.snapshot(now), {});
  health.observe("deepseek", 402, providerExhaustion(402, "", 3000, now));
  assert.ok(health.snapshot(now + 2999).deepseek);
  assert.deepEqual(health.snapshot(now + 3000), {});
});

test("explicit billing/quota errors mark exhaustion; transient 429 and unrelated errors never do", () => {
  for (const text of ['{"error":{"code":"insufficient_quota"}}', 'billing_hard_limit_reached', 'balance exhausted', 'usage_limit_reached']) {
    assert.ok(providerExhaustion(429, text), text);
  }
  for (const text of ['rate_limit_exceeded', 'RESOURCE_EXHAUSTED', 'Too many requests. See billing documentation.', 'quota per minute exceeded']) {
    const health = new ProviderHealth();
    health.observe("p", 429, providerExhaustion(429, text, 2000));
    assert.deepEqual(health.snapshot(), {}, text);
  }
  for (const status of [400, 401, 403, 500, 503]) assert.equal(providerExhaustion(status, 'insufficient_quota billing limit'), undefined);
  assert.equal(providerExhaustion(402)?.reason, 'billing_exhausted');
});

/** A clock the test drives, so cooldowns are asserted rather than waited for. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("only failures another credential could answer are retryable", () => {
  assert.equal(classify(401).retryable, true, "rejected credentials — try the next one");
  assert.equal(classify(429).retryable, true);
  assert.equal(classify(402).retryable, true);
  assert.equal(classify(503).retryable, true);
  assert.equal(classify(0).retryable, true, "never reached the provider at all");

  // A bad request is bad everywhere. Retrying it burns every credential and still fails.
  assert.equal(classify(400).retryable, false);
  assert.equal(classify(404).retryable, false);
  assert.equal(classify(413).retryable, false);
  assert.equal(classify(422).retryable, false);
  assert.equal(classify(501).retryable, false, "the server says it will never do this");
});

test("a rejected credential is parked; a rate-limited one is only paused", () => {
  const auth = classify(401);
  assert.equal(auth.retryable && auth.quarantine, true, "an auth failure does not heal on its own");

  const limited = classify(429);
  assert.equal(limited.retryable && limited.quarantine, false);
  assert.equal(limited.retryable && limited.cooldownMs, 60_000);

  // A stated reset beats a guess, and an absurd one is clamped rather than trusted.
  const stated = classify(429, 5_000);
  assert.equal(stated.retryable && stated.cooldownMs, 5_000);
  const huge = classify(429, 99 * 60 * 60_000);
  assert.equal(huge.retryable && huge.cooldownMs, 6 * 60 * 60_000);
});

test("a conversation keeps its credential — moving it would cost the prompt cache", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const all = creds("a", "b");

  assert.equal(pool.pick("p", all, "conv-1")?.id, "a");
  assert.equal(pool.pick("p", all, "conv-1")?.id, "a", "same conversation, same credential");
  assert.equal(pool.pick("p", all, "conv-2")?.id, "a", "a healthy credential is not spread for its own sake");
});

test("a token refresh keeps the conversation on its durable account without inheriting runtime health", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const old: Credential = { id: "account-a:old", ownerId: "account-a", headers: {} };
  const other: Credential = { id: "account-b:generation", ownerId: "account-b", headers: {} };

  assert.equal(pool.pick("p", [old, other], "conv")?.id, old.id);
  const fresh: Credential = { id: "account-a:fresh", ownerId: "account-a", headers: {} };
  assert.equal(pool.pick("p", [other, fresh], "conv")?.id, fresh.id, "the owner claim survives token rotation even when order changes");

  pool.penalise("p", old.id, 401);
  assert.equal(pool.pick("p", [other, fresh], "conv")?.id, fresh.id, "the fresh generation does not inherit the old generation's quarantine");
});

test("a failure moves the conversation on, and the parked credential is skipped", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const all = creds("a", "b", "c");

  assert.equal(pool.pick("p", all, "conv")?.id, "a");
  pool.penalise("p", "a", 429, 30_000);
  assert.equal(pool.pick("p", all, "conv")?.id, "b", "cooling credential skipped");

  pool.penalise("p", "b", 401);
  assert.equal(pool.pick("p", all, "conv")?.id, "c", "rejected credential skipped");

  pool.penalise("p", "c", 503);
  assert.equal(pool.pick("p", all, "conv"), null, "nothing usable — the caller falls over to another provider");

  // The rate limits lapse; the quarantine does not. The conversation last ran on "c", so when "c"
  // recovers it keeps it — moving back to "a" would throw away the cache it just built there.
  c.advance(31_000);
  assert.equal(pool.pick("p", all, "conv")?.id, "c");
  assert.equal(pool.pick("p", all, "fresh-conv")?.id, "a", "a new conversation starts at the configured order");
  assert.deepEqual(pool.report("p", all).map((r) => `${r.id}:${r.state}`), ["a:ready", "b:quarantined", "c:ready"]);
});

test("a credential that answers is healthy again", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const all = creds("a", "b");
  pool.penalise("p", "a", 401);
  assert.equal(pool.pick("p", all, "conv")?.id, "b");
  pool.succeed("p", "a");
  assert.equal(pool.report("p", all)[0]?.state, "ready");
});

test("the report says why a credential is idle and for how long", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const all: Credential[] = [{ id: "a", headers: {}, label: "personal" }, { id: "b", headers: {} }];
  pool.penalise("p", "a", 429, 45_000);
  const [a, b] = pool.report("p", all);
  assert.equal(a?.state, "cooling");
  assert.equal(a?.label, "personal");
  assert.equal(a?.cooldownSeconds, 45);
  assert.equal(a?.failures, 1);
  assert.equal(b?.state, "ready");
  assert.equal(b?.cooldownSeconds, undefined);
});

test("a paused credential is never picked, keeps its place, and reports as paused", () => {
  const pool = new CredentialPool();
  const all: Credential[] = [
    { id: "a", headers: {}, paused: true },
    { id: "b", headers: {} },
  ];
  assert.equal(pool.pick("p", all, "conv")?.id, "b", "a paused key is skipped even as the first one");
  assert.equal(pool.pick("p", all)?.id, "b");
  assert.equal(pool.hasUsable("p", [all[0]!]), false);
  // When every key is paused there is nothing to pick, exactly as when every key is cooling.
  assert.equal(pool.pick("p", [all[0]!]), null);
  assert.deepEqual(pool.report("p", all).map((r) => r.state), ["paused", "ready"]);
  // Paused outranks a cooldown in the report: the dashboard should offer "resume", not "clear cooldown".
  pool.penalise("p", "a", 429, 60_000);
  assert.equal(pool.report("p", all)[0]?.state, "paused");
  // Un-pausing puts it straight back at the front, because the list order is the priority. (A new
  // conversation, not the one already stuck to b: stickiness keeps that one where it is. Its own
  // cooldown from above is cleared first, as the dashboard's "resume" does.)
  pool.clear("p", "a");
  assert.equal(pool.pick("p", [{ ...all[0]!, paused: false }, all[1]!], "new-conv")?.id, "a");
});

test("cooling until a stated reset leaves a longer cooldown alone, and a shorter one is not shortened", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const all = creds("a", "b");
  // A usage window that resets in an hour parks the key until then.
  pool.coolUntil("p", "a", c.now() + 3_600_000);
  assert.equal(pool.report("p", all)[0]?.cooldownSeconds, 3_600);
  assert.equal(pool.pick("p", all)?.id, "b");
  // A reset five minutes away must not cut that hour short.
  pool.coolUntil("p", "a", c.now() + 300_000);
  assert.equal(pool.report("p", all)[0]?.cooldownSeconds, 3_600);
  // The key is usable again once the hour passes, without anything having to clear it.
  c.advance(3_600_001);
  assert.equal(pool.pick("p", all)?.id, "a");
});

// A prepaid key that cannot pay is not a failure the vendor reported: nothing is wrong with it, it
// just has no money until someone tops it up. It rests the way a cooling key does, but a later
// balance read — the only thing that can say money came back — is what lets it in again.
test("a key parked for an empty balance is skipped, reported as cooling, and released by a later read", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const all = creds("a", "b");
  const parkMs = 300_000;
  pool.parkEmpty("p", "a", c.now() + parkMs);

  assert.equal(pool.pick("p", all, "conv")?.id, "b", "a zero balance is skipped like a cooldown");
  assert.equal(pool.hasUsable("p", [all[0]!]), false);
  const [a] = pool.report("p", all);
  assert.equal(a?.state, "cooling", "the dashboard shows it resting");
  assert.equal(a?.cooldownSeconds, parkMs / 1000, "for one balance-read period");
  assert.equal(a?.failures, 0, "nothing failed — it is spent, not rejected");
  assert.equal(pool.emptySince("p", "a"), c.now() + parkMs);

  // A vendor's own cooldown on the same key is not shortened by a topped-up balance: the two are
  // separate reasons to rest a key, and releasing one leaves the other standing.
  pool.penalise("p", "a", 429, 60_000);
  pool.releaseEmpty("p", "a");
  assert.equal(pool.report("p", all)[0]?.state, "cooling", "the vendor's cooldown still stands");
  assert.equal(pool.emptySince("p", "a"), 0, "the balance park is gone");
  c.advance(61_000);
  // A new conversation, because "conv" is still held on the key that answered it (that is its cache).
  assert.equal(pool.pick("p", all, "conv-2")?.id, "a", "with money and no cooldown it is first again");

  // The operator's "use again" releases a balance park as well, per key and for the whole provider.
  pool.parkEmpty("p", "a", c.now() + parkMs);
  pool.clear("p", "a");
  assert.equal(pool.pick("p", all, "conv-3")?.id, "a");
  pool.parkEmpty("p", "a", c.now() + parkMs);
  pool.parkEmpty("p", "b", c.now() + parkMs);
  assert.equal(pool.pick("p", all, "conv-3"), null, "every key resting leaves nothing to pick");
  pool.clear("p");
  assert.equal(pool.pick("p", all, "conv-3")?.id, "a");
});

test("an operator can un-park a credential without restarting the router", () => {
  const pool = new CredentialPool();
  const all = creds("a", "b");
  pool.penalise("p", "a", 401);
  pool.clear("p", "a");
  assert.equal(pool.pick("p", all, "conv")?.id, "a");

  pool.penalise("p", "a", 401);
  pool.penalise("p", "b", 401);
  pool.clear("p");
  assert.equal(pool.pick("p", all, "conv")?.id, "a");
});

test("an idle conversation loses its claim, so a restarted chat is not pinned forever", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now, stickyTtlMs: 1_000 });
  const all = creds("a", "b");
  assert.equal(pool.pick("p", all, "conv")?.id, "a");
  pool.penalise("p", "a", 429, 500);
  assert.equal(pool.pick("p", all, "conv")?.id, "b");
  c.advance(5_000);
  assert.equal(pool.pick("p", all, "conv")?.id, "a", "claim expired, order applies again");
});

test("a single credential behaves exactly as before: one choice, or none", () => {
  const pool = new CredentialPool();
  const one = creds("only");
  assert.equal(pool.pick("p", one, "conv")?.id, "only");
  pool.penalise("p", "only", 429);
  assert.equal(pool.pick("p", one, "conv"), null);
  assert.equal(pool.pick("p", [], "conv"), null);
});

test("fallbacks follow the primary in order, and a repeat of it is not a second chance", () => {
  const primary = { provider: "chatgpt", model: "gpt-6-astra", effort: "high", tag: "slot" };
  const list = targets(primary, [
    { provider: "deepseek", model: "deepseek-flash" },
    { provider: "chatgpt", model: "gpt-6-astra" },
    { provider: "openrouter", model: "z-ai/glm-5.3-flash", effort: "high" },
  ]);
  assert.deepEqual(list.map((t) => `${t.provider}/${t.model}`), [
    "chatgpt/gpt-6-astra",
    "deepseek/deepseek-flash",
    "openrouter/z-ai/glm-5.3-flash",
  ]);
  assert.equal(list[0]?.tag, "slot", "the primary keeps the tag the log already uses");
  assert.deepEqual(targets(primary), [primary], "no fallbacks is just the primary");
});

// A vendor saying when to come back beats our guess, and a vendor saying nothing useful must not
// turn into NaN milliseconds.
test("retry-after is read as seconds or as a date, and nonsense is ignored", () => {
  assert.equal(retryAfterMs({ "retry-after": "30" }), 30_000);
  assert.equal(retryAfterMs({ "retry-after": ["45"] }), 45_000, "a repeated header still parses");
  assert.equal(retryAfterMs({ "retry-after": "0" }), 0);
  assert.equal(retryAfterMs({ "x-codex-primary-reset-after-seconds": "120" }), 120_000);
  assert.equal(retryAfterMs({}), undefined);
  assert.equal(retryAfterMs({ "retry-after": "soon" }), undefined);
  assert.equal(retryAfterMs({ "retry-after": "-5" }), undefined, "a negative wait is not a wait");

  const future = retryAfterMs({ "retry-after": new Date(Date.now() + 60_000).toUTCString() });
  assert.ok(future !== undefined && future > 50_000 && future <= 60_000, `http-date parsed: ${future}`);
  assert.equal(retryAfterMs({ "retry-after": new Date(Date.now() - 60_000).toUTCString() }), 0, "a past date means now");
});

// 403 is not only a rejected credential: it is also a content policy, a blocked region, a model
// the account may not use, or an edge refusing what it took for a bot. Parking a working credential
// until someone notices is the worse mistake.
test("403 waits rather than parks, and 401 still parks", () => {
  const forbidden = classify(403);
  assert.equal(forbidden.retryable && forbidden.quarantine, false);
  assert.equal(forbidden.retryable && forbidden.cooldownMs, 60_000);
  const stated = classify(403, 5_000);
  assert.equal(stated.retryable && stated.cooldownMs, 5_000);

  const rejected = classify(401);
  assert.equal(rejected.retryable && rejected.quarantine, true);
});

// A relay in front of the vendor answers 403 when its own call upstream broke. That is not a
// statement about our key, and treating it as one parked a working credential for a full minute —
// every turn in that minute reached the user as an authentication error (2026-09-21).
test("a 403 that reports a broken upstream is transient, not an auth failure", () => {
  const relayed = classify(403, undefined, JSON.stringify({
    error: { type: "server_error", code: "server_error", message: "Error from provider (Console Go): Upstream request failed: [server_error] Upstream response was not valid JSON" },
  }));
  assert.equal(relayed.retryable && relayed.kind, "transient");
  // No cooldown at all: any wait would move the conversation off a credential that did nothing and
  // take the prompt cache with it, which is the cost the pool exists to avoid.
  assert.equal(relayed.retryable && relayed.cooldownMs, 0);
  assert.equal(relayed.retryable && relayed.quarantine, false);

  // No body, or a body about something else, is still judged the way it always was.
  assert.equal((classify(403) as { kind: string }).kind, "auth");
  const policy = classify(403, undefined, JSON.stringify({ error: { message: "This model is not available in your region" } }));
  assert.equal(policy.retryable && policy.kind, "auth");
  assert.equal(policy.retryable && policy.cooldownMs, 60_000);
});

// Requests overlap. A 200 arriving after a concurrent 429 does not mean the limit lifted, and
// clearing the cooldown here would send the next turn straight back into it.
test("an answer lifts a quarantine but does not cancel a live cooldown", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const all = creds("a", "b");

  pool.penalise("p", "a", 429, 60_000);
  pool.succeed("p", "a");
  assert.equal(pool.report("p", all)[0]?.state, "cooling", "the rate limit still stands");
  assert.equal(pool.pick("p", all, "conv")?.id, "b");

  c.advance(61_000);
  assert.equal(pool.report("p", all)[0]?.state, "ready", "and it lapses on its own");

  pool.penalise("p", "a", 401);
  pool.succeed("p", "a");
  assert.equal(pool.report("p", all)[0]?.state, "ready", "a credential that answered is not rejected");
});
