import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, CredentialPool, targets, type Credential } from "../src/pool.ts";

const creds = (...ids: string[]): Credential[] => ids.map((id) => ({ id, headers: { "x-api-key": id } }));

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
