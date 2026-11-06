import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, CredentialPool, retryAfterMs, targets, ThreadAffinity, type Credential } from "../src/pool.ts";

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

test("OpenCode Go's spent subscription window is quota exhaustion, not a speed limit (#95)", () => {
  const now = 1_000_000;
  // The measured 429 body (2026-10-25): a weekly Go window, no retry header, no billing vocabulary.
  const body = JSON.stringify({
    type: "error",
    error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" },
    metadata: { workspace: "org_hidden", limitName: "weekly" },
  });
  assert.deepEqual(providerExhaustion(429, body, undefined, now), { reason: "quota_exhausted", at: now, until: now + 1_800_000 });
  assert.equal(providerExhaustion(429, '{"error":{"type":"GoUsageLimitError"}}')?.reason, "quota_exhausted");
  // The message alone reads the same; so does a plain usage-limit phrase.
  assert.equal(providerExhaustion(429, "Go usage limit exceeded")?.reason, "quota_exhausted");
  assert.equal(providerExhaustion(429, '{"error":{"message":"usage limit exceeded"}}')?.reason, "quota_exhausted");
  // A limit counted per minute is still a speed limit, however it is worded.
  for (const text of ['quota per minute exceeded', 'rate_limit_exceeded', 'Go usage limit per minute exceeded', 'usage limit exceeded per minute', 'Usage limit reached for this minute']) {
    assert.equal(providerExhaustion(429, text), undefined, text);
  }
  // Only a 429/402 carries it, never another status.
  assert.equal(providerExhaustion(400, body), undefined);
});

test("Google's monthly spending cap is billing exhaustion, including its JSON error message", () => {
  const now = 1_000_000;
  const message = "Your project has exceeded its monthly spending cap.";
  for (const body of [message, JSON.stringify({ error: { code: 429, message, status: "RESOURCE_EXHAUSTED" } })]) {
    const exhaustion = providerExhaustion(429, body, undefined, now);
    assert.deepEqual(exhaustion, { reason: "billing_exhausted", at: now, until: now + 1_800_000 });
    const health = new ProviderHealth();
    health.observe("google-gemini", 429, exhaustion);
    assert.equal(health.snapshot(now)["google-gemini"]?.reason, "billing_exhausted");
    assert.deepEqual(providerExhaustion(429, body, 60_000, now), { reason: "billing_exhausted", at: now, until: now + 60_000 });
  }
  for (const message of ["RESOURCE_EXHAUSTED", "Rate limit exceeded.", "Your project has a monthly spending cap.", "Monthly spending cap may be exceeded.", "Your project has exceeded its requests per minute quota."]) {
    assert.equal(providerExhaustion(429, JSON.stringify({ error: { code: 429, message, status: "RESOURCE_EXHAUSTED" } })), undefined, message);
  }
  for (const status of [400, 401, 403, 500, 503]) assert.equal(providerExhaustion(status, message), undefined);
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

test("issue #101: only the relay's explicit workspace-region 400 can move a credential", () => {
  const message = "Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it.";
  const body = JSON.stringify({ error: { type: "server_error", message } });
  assert.deepEqual(classify(400, undefined, body), { retryable: true, kind: "auth", cooldownMs: 60_000, quarantine: false });
  for (const text of ["", message, JSON.stringify({ error: { type: "invalid_request_error", message } }), JSON.stringify({ error: { type: "server_error", message: "Upstream request failed: invalid messages" } }), JSON.stringify({ error: { type: "server_error", message: "Global regions" } })]) {
    assert.equal(classify(400, undefined, text).retryable, false, text);
  }
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const all = creds("a", "b");
  pool.pick("p", all, "worker-a");
  pool.penalise("p", "a", 400, undefined, body);
  assert.equal(pool.pick("p", all, "worker-a")?.id, "b");
  c.advance(60_001);
  assert.equal(pool.pick("p", all, "worker-a")?.id, "b");
  assert.equal(pool.pick("p", all, "worker-b")?.id, "a");
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

test("regression: visiting another provider preserves each provider's conversation credential", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const a = creds("a1", "a2");
  const b = creds("b1", "b2");
  pool.penalise("a", "a1", 429, 1_000);
  assert.equal(pool.pick("a", a, "conv")?.id, "a2");
  assert.equal(pool.pick("b", b, "conv")?.id, "b1");
  c.advance(2_000);
  assert.equal(pool.pick("a", a, "conv")?.id, "a2", "a1 recovered, but a2 still holds the cached prefix");
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

// The owner moving the preferred account is the one deliberate exception to "a held conversation
// stays put": every conversation of that provider re-picks, and each pays one cold prompt cache.
test("changing the preferred account moves held conversations onto it", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const plain = (): Credential[] => creds("a", "b");
  assert.equal(pool.pick("p", plain(), "conv")?.id, "a");
  assert.equal(pool.pick("p", plain(), "conv")?.id, "a");

  const preferB = (): Credential[] => [{ ...creds("a")[0]! }, { ...creds("b")[0]!, preferred: true }];
  assert.equal(pool.pick("p", preferB(), "conv")?.id, "b", "the held claim is dropped when the preferred owner changes");
  assert.equal(pool.pick("p", preferB(), "conv")?.id, "b", "and the new claim holds from then on");
  assert.equal(pool.pick("p", preferB(), "other-conv")?.id, "b", "new conversations prefer it too");
});

// Removing the preference is not a move the owner asked for, so held conversations keep their cache.
// Removing the preference asks for the configured order back (2026-11-05: held conversations used to
// stay on the account the owner had just stopped preferring).
test("removing the preference moves held conversations back to the configured order", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const preferA = (): Credential[] => [{ ...creds("b")[0]! }, { ...creds("a")[0]!, preferred: true }];
  assert.equal(pool.pick("p", preferA(), "conv")?.id, "a");
  const plain = (): Credential[] => creds("b", "a");
  assert.equal(pool.pick("p", plain(), "conv")?.id, "b", "the held conversation re-picks from the configured order");
  assert.equal(pool.pick("p", plain(), "fresh")?.id, "b");
  assert.equal(pool.pick("p", plain(), "conv")?.id, "b", "and stays there");
});

// Choosing the same account again after removing its preference is a change the owner asked for.
test("re-preferring an account after removing its preference moves held conversations again", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const preferA = (): Credential[] => [{ ...creds("b")[0]! }, { ...creds("a")[0]!, preferred: true }];
  assert.equal(pool.pick("p", preferA(), "conv")?.id, "a");
  assert.equal(pool.pick("p", creds("b", "a"), "fresh")?.id, "b", "with no preference a new chat takes b");
  assert.equal(pool.pick("p", preferA(), "fresh")?.id, "a", "preferring a again moves it");
});

// A retry's list leaves out the credential it tried; that is not the owner removing the preference.
test("a retry list without the preferred account does not count as removing the preference", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const preferA = (): Credential[] => [{ ...creds("b")[0]! }, { ...creds("a")[0]!, preferred: true }];
  assert.equal(pool.pick("p", preferA(), "conv")?.id, "a");
  pool.penalise("p", "a", 429, 1_000);
  assert.equal(pool.pick("p", creds("b"), "conv")?.id, "b", "the retry answers on b");
  c.advance(2_000);
  assert.equal(pool.pick("p", preferA(), "conv")?.id, "b", "a recovered, the preference never changed, so the conversation stays on b");
});

// A preferred account coming back from a cooldown is not a preference change: the conversation
// that ran elsewhere while it rested keeps the cache it built there.
test("a preferred account recovering from cooldown does not move a held conversation", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const all = (): Credential[] => [{ ...creds("b")[0]! }, { ...creds("a")[0]!, preferred: true }];
  pool.penalise("p", "a", 429, 1_000);
  assert.equal(pool.pick("p", all(), "conv")?.id, "b", "preferred is cooling, so the next account answers");
  assert.equal(pool.pick("p", all(), "conv")?.id, "b");
  c.advance(2_000);
  assert.equal(pool.pick("p", all(), "conv")?.id, "b", "a recovered, but the conversation stays on b");
  assert.equal(pool.pick("p", all(), "fresh")?.id, "a", "a new conversation tries the preferred account");
});

// One provider's preference change must not move another provider's conversations.
test("a preference change is scoped to its provider", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  assert.equal(pool.pick("x", creds("x1", "x2"), "conv")?.id, "x1");
  assert.equal(pool.pick("y", creds("y1", "y2"), "conv")?.id, "y1");
  assert.equal(pool.pick("x", [{ ...creds("x1")[0]! }, { ...creds("x2")[0]!, preferred: true }], "conv")?.id, "x2");
  assert.equal(pool.pick("y", creds("y1", "y2"), "conv")?.id, "y1", "y kept its own claim");
});

test("a thread continuation remembers which conversation produced its previous message id", () => {
  const c = clock();
  const affinity = new ThreadAffinity({ now: c.now, ttlMs: 10_000, maxEntries: 2 });
  assert.equal(affinity.lookup("msg_unknown"), undefined, "an unknown id keeps the computed key");
  affinity.remember("msg_1", "conversation-1");
  assert.equal(affinity.lookup("msg_1"), "conversation-1");
  // Re-remembering is an update, not a duplicate.
  affinity.remember("msg_1", "conversation-2");
  assert.equal(affinity.lookup("msg_1"), "conversation-2");
  assert.equal(affinity.size, 1);
  // Bounded by the size cap: the oldest entry goes first.
  affinity.remember("msg_2", "conversation-1");
  affinity.remember("msg_3", "conversation-1");
  assert.deepEqual([affinity.size, affinity.lookup("msg_1"), affinity.lookup("msg_3")], [2, undefined, "conversation-1"]);
  // Expiry is the idle claim's own lifetime.
  c.advance(10_001);
  assert.equal(affinity.lookup("msg_3"), undefined, "an entry older than the TTL is forgotten");
  assert.equal(affinity.lookup("msg_2"), undefined);
  assert.equal(affinity.size, 0);
  // A read at the boundary still answers; the TTL has not elapsed yet.
  affinity.remember("msg_4", "conversation-9");
  c.advance(10_000);
  assert.equal(affinity.lookup("msg_4"), "conversation-9");
  c.advance(1);
  assert.equal(affinity.lookup("msg_4"), undefined);
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

// OpenCode Go answered 429 `[prefill_cap_refused]` / `[overloaded]` for its own failing upstream
// (2026-11-06, router.log 15:34:34): the same key answered 200 five seconds later, while the 429
// cooled it for a minute as if the key were over its limit.
test("a relay's 429 for a failed upstream is transient, not the key's rate limit", () => {
  for (const body of [
    '{"error":{"type":"server_error","message":"Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 5 s)"}}',
    '{"error":{"type":"server_error","message":"Upstream request failed: [overloaded] the server is overloaded; retry shortly"}}',
  ]) {
    assert.deepEqual(classify(429, undefined, body), { retryable: true, kind: "transient", cooldownMs: 0, quarantine: false }, body);
  }
  // A 429 about our own limit is still a rate limit, with its stated or default wait.
  assert.equal((classify(429) as { kind: string }).kind, "rate-limit");
  assert.equal((classify(429, 5_000) as { cooldownMs: number }).cooldownMs, 5_000);
  assert.equal((classify(429, undefined, '{"error":{"message":"rate_limit_exceeded"}}') as { kind: string }).kind, "rate-limit");
});

// A Claude subscription's 5h/7d window belongs to the account, while its credential id carries a
// token digest. A refresh during a rest used to hand the pool a fresh id with no cooldown and spend
// an account whose window was still gone (2026-11-07). A quarantine is still the token generation's.
test("a token refresh does not clear a resting account, and a fresh generation starts unquarantined", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const old: Credential = { id: "account-a:gen1", ownerId: "account-a", headers: {} };
  const other: Credential = { id: "account-b:gen1", ownerId: "account-b", headers: {} };
  assert.equal(pool.pick("claude", [old, other], "conv")?.id, old.id, "the pool has now seen the account");
  assert.equal(pool.penalise("claude", old.id, 429, 5 * 60 * 60_000).retryable, true);

  const fresh: Credential = { id: "account-a:gen2", ownerId: "account-a", headers: {} };
  assert.equal(pool.hasUsable("claude", [fresh]), false, "the refreshed generation still rests");
  assert.deepEqual(pool.report("claude", [fresh]).map((row) => row.state), ["cooling"]);
  assert.equal(pool.report("claude", [fresh])[0]?.cooldownSeconds, 5 * 60 * 60);
  c.advance(5 * 60 * 60_000);
  assert.equal(pool.hasUsable("claude", [fresh]), true, "the rest ends at its stated reset");

  // A 401 is the token generation being refused; a re-login must not inherit it (2026-09-20).
  pool.penalise("claude", fresh.id, 401);
  assert.equal(pool.hasUsable("claude", [fresh]), false);
  const relogged: Credential = { id: "account-a:gen3", ownerId: "account-a", headers: {} };
  assert.equal(pool.hasUsable("claude", [relogged]), true, "a fresh generation is not the refused one");
  // The old generation stays parked even while its account is otherwise healthy.
  assert.deepEqual(pool.report("claude", [fresh, relogged]).map((row) => row.state), ["quarantined", "ready"]);
});

// OpenCode Go answered 402 for minimax-m3.1-flash-free while that model's endpoint was down
// (2026-10-22). Read as exhaustion it parked the whole account, DeepSeek included, for 30 minutes.
test("a relay's 402 for a failed upstream is transient, not exhaustion", () => {
  const body = '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}';
  assert.equal(providerExhaustion(402, body), undefined);
  assert.deepEqual(classify(402, undefined, body), { retryable: true, kind: "transient", cooldownMs: 0, quarantine: false });
  // A real 402 still is.
  assert.deepEqual(classify(402, undefined, '{"error":{"message":"Insufficient balance"}}'), { retryable: true, kind: "exhausted", cooldownMs: 30 * 60_000, quarantine: false });
  assert.equal(providerExhaustion(402, "Insufficient Balance")?.reason, "insufficient_balance");
});

test("a scoped rate limit rests only that scope of the credential; other failures rest all of it", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const [a, b] = creds("a", "b");
  // Antigravity's Claude/GPT group spent on `a`: Gemini turns still take `a`.
  assert.equal(pool.penalise("google", "a", 429, 5_000, "", "3p").retryable, true);
  assert.equal(pool.pick("google", [a!, b!], "conv", "gemini")?.id, "a");
  assert.equal(pool.pick("google", [a!, b!], undefined, "3p")?.id, "b");
  assert.equal(pool.pick("google", [a!])?.id, "a", "no scope asked: the credential itself is fine");
  assert.equal(pool.hasUsable("google", [a!], "3p"), false);
  assert.equal(pool.hasUsable("google", [a!], "gemini"), true);
  assert.deepEqual(pool.report("google", [a!]).map((r) => r.state), ["ready"]);
  assert.deepEqual(pool.scopeCooldowns("google", "a"), { "3p": 5 });
  // A conversation held on `a` moves for a 3p turn, and keeps `a` for Gemini.
  assert.equal(pool.pick("google", [a!, b!], "conv", "3p")?.id, "b");
  c.advance(5_000);
  assert.deepEqual(pool.scopeCooldowns("google", "a"), {});
  assert.equal(pool.hasUsable("google", [a!], "3p"), true);
  // 402, 401 and a broken upstream are about the credential: a scope does not narrow them.
  pool.penalise("google", "a", 402, undefined, "", "3p");
  assert.equal(pool.hasUsable("google", [a!], "gemini"), false);
  assert.deepEqual(pool.scopeCooldowns("google", "a"), {});
});

test("an answer in a scope does not cancel its live rest; clearing the credential clears its scopes", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const [a] = creds("a");
  pool.penalise("google", "a", 429, 60_000, "", "3p");
  pool.succeed("google", "a", "3p");
  assert.equal(pool.hasUsable("google", [a!], "3p"), false, "a concurrent 200 does not lift a limit");
  pool.clear("google", "a");
  assert.equal(pool.hasUsable("google", [a!], "3p"), true);
  pool.penalise("google", "a", 429, 60_000, "", "3p");
  pool.clear("google");
  assert.deepEqual(pool.scopeCooldowns("google", "a"), {});
});

test("a quota scope combines with pause and preference: paused is never picked, the preferred one first while its scope has room", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const [a, b, p] = [{ ...creds("a")[0]!, paused: true }, creds("b")[0]!, { ...creds("p")[0]!, preferred: true }];
  // A paused credential stays out whatever its scopes say, and the preferred one leads.
  assert.equal(pool.pick("google", [a, b, p], undefined, "3p")?.id, "p");
  assert.equal(pool.hasUsable("google", [a], "gemini"), false);
  // The preferred credential's Claude/GPT group is spent: 3p turns go to the next usable one, Gemini still prefers it.
  pool.penalise("google", "p", 429, 60_000, "", "3p");
  assert.equal(pool.pick("google", [a, b, p], undefined, "3p")?.id, "b");
  assert.equal(pool.pick("google", [a, b, p], undefined, "gemini")?.id, "p");
  // A held conversation leaves a paused credential even when its scope has room.
  assert.equal(pool.pick("google", [b, p], "conv", "gemini")?.id, "p");
  assert.equal(pool.pick("google", [b, { ...p, paused: true }], "conv", "gemini")?.id, "b");
  // Clearing the credential clears its resting scopes too.
  pool.clear("google", "p");
  assert.deepEqual(pool.scopeCooldowns("google", "p"), {});
  assert.equal(pool.pick("google", [a, b, p], undefined, "3p")?.id, "p");
  // So does clearing a durable owner, whose token generations are `owner:n`.
  pool.penalise("claude", "owner:1", 429, 60_000, "", "3p");
  pool.clearOwner("claude", "owner");
  assert.deepEqual(pool.scopeCooldowns("claude", "owner:1"), {});
});

test("clearing one provider's login leaves another provider's rest on the same login to its own clear", () => {
  const c = clock();
  const pool = new CredentialPool({ now: c.now });
  const login = { id: "gen1", headers: {}, ownerId: "current", healthKey: "login:abc" } as Credential;
  for (const provider of ["claude", "claude-work"]) {
    assert.equal(pool.pick(provider, [login])?.id, "gen1");
    pool.penalise(provider, "gen1", 429, 3_600_000, "");
    assert.equal(pool.hasUsable(provider, [login]), false);
  }
  pool.clearOwner("claude", "current");
  assert.equal(pool.hasUsable("claude", [login]), true);
  assert.equal(pool.hasUsable("claude-work", [login]), false, "the other provider still rests until it is cleared");
  pool.clearOwner("claude-work", "current");
  assert.equal(pool.hasUsable("claude-work", [login]), true, "its own clear still finds its login");
});
