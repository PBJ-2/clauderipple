// Generic quota-cache identity and races, using only a stub fetch and an injected clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageCache, type UsageWindow } from "../src/providers/usage-cache.ts";

const URL = "https://quota.invalid/usage";
const parse = (body: unknown): UsageWindow[] | null => typeof body === "number" ? [{ kind: "five_hour", used_percent: body }] : null;
const reply = (percent: number) => new Response(JSON.stringify(percent));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

for (const change of ["key", "url"] as const) {
  test(`a changed ${change} cannot reuse cached windows or the previous identity's fallback`, async () => {
    let calls = 0;
    let now = 1_000;
    const cache = new UsageCache({ label: "test usage", now: () => now, ttlMs: 100, fetch: async () => {
      calls++;
      return calls === 1 ? reply(90) : new Response("refused", { status: 401 });
    } });
    await cache.windows("provider", URL, { authorization: "Bearer old-key" }, parse);
    const url = change === "url" ? "https://other.invalid/usage" : URL;
    const headers = { authorization: change === "key" ? "Bearer new-key" : "Bearer old-key" };
    assert.deepEqual(await cache.windows("provider", url, headers, parse), []);
    assert.equal(calls, 2, "the new identity bypasses the old TTL");
    now += 101;
    assert.deepEqual(await cache.windows("provider", url, headers, parse), [], "a failure cannot retain another identity's windows");
    assert.equal(calls, 3);
  });
}

test("equivalent header casing and order share one lookup and preserve the original read time", async () => {
  const pending = deferred<Response>();
  let calls = 0;
  let now = 1_000;
  const cache = new UsageCache({ label: "test usage", now: () => now, ttlMs: 100, fetch: async () => { calls++; return pending.promise; } });
  const a = cache.windows("provider", URL, { Authorization: "Bearer key", "X-Account": "one" }, parse);
  const b = cache.windows("provider", URL, { "x-account": "one", authorization: "Bearer key" }, parse);
  assert.equal(a, b);
  pending.resolve(reply(20));
  const windows = await a;
  assert.equal(calls, 1);
  now += 50;
  assert.deepEqual(await cache.windows("provider", URL, { authorization: "Bearer key", "x-account": "one" }, parse), windows);
  assert.equal(windows[0]?.read_at, 1_000);
  assert.equal(calls, 1);
});

for (const oldFinishesFirst of [true, false]) {
  test(`an old in-flight identity cannot overwrite or clear its replacement (${oldFinishesFirst ? "old" : "new"} finishes first)`, async () => {
    const old = deferred<Response>();
    const fresh = deferred<Response>();
    let calls = 0;
    const cache = new UsageCache({ label: "test usage", now: () => 1_000, fetch: async (_url, init) => {
      calls++;
      return (init?.headers as Record<string, string>).authorization === "Bearer old-key" ? old.promise : fresh.promise;
    } });
    const a = cache.windows("provider", URL, { authorization: "Bearer old-key" }, parse);
    const b = cache.windows("provider", URL, { authorization: "Bearer new-key" }, parse);
    assert.notEqual(a, b, "a replacement does not join the old lookup");
    if (oldFinishesFirst) {
      old.resolve(reply(90));
      await a;
      assert.equal(cache.windows("provider", URL, { authorization: "Bearer new-key" }, parse), b, "old cleanup cannot clear new single-flight state");
      fresh.resolve(reply(10));
    } else {
      fresh.resolve(reply(10));
      await b;
      old.resolve(reply(90));
    }
    assert.equal((await a)[0]?.used_percent, 90, "an existing caller may finish on its own identity");
    assert.equal((await b)[0]?.used_percent, 10);
    assert.equal((await cache.windows("provider", URL, { authorization: "Bearer new-key" }, parse))[0]?.used_percent, 10);
    assert.equal(calls, 2);
  });
}

test("null and transport failures keep only the same identity's windows and redact reflected credentials", async () => {
  const warnings: string[] = [];
  const headers = { authorization: "Bearer mock-opaque-key", "x-api-key": "mock-other-key" };
  let now = 1_000;
  let calls = 0;
  const cache = new UsageCache({ label: "test usage", now: () => now, ttlMs: 100, warn: message => warnings.push(message), fetch: async () => {
    calls++;
    if (calls === 1) return reply(40);
    if (calls === 2) return new Response("{}");
    throw new Error(`fetch failed with ${headers.authorization} and ${headers["x-api-key"]}`);
  } });
  const initial = await cache.windows("provider", URL, headers, parse);
  now += 101;
  assert.deepEqual(await cache.windows("provider", URL, headers, parse), initial);
  now += 101;
  assert.deepEqual(await cache.windows("provider", URL, headers, parse), initial);
  assert.match(warnings[0]!, /test usage provider:/);
  assert.doesNotMatch(warnings.join("\n"), /mock-opaque-key|mock-other-key/);
});
