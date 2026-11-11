import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatGptAdapter } from "../src/providers/chatgpt/index.ts";
import { saveChatGptAccount } from "../src/providers/chatgpt/accounts.ts";
import { Logger } from "../src/log.ts";

const quota = { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } };
const catalog = { models: [{ slug: "timeout-test-model", visibility: "list" }] };
const cases = [
  { name: "quota", timeout: 10_000, body: quota, read: (adapter: ChatGptAdapter) => adapter.fetchRateLimits() },
  { name: "catalog", timeout: 15_000, body: catalog, read: (adapter: ChatGptAdapter) => adapter.fetchModels() },
];

function rig(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-sidecall-timeout-"));
  const keys = ["HOME", "CODEX_HOME", "CLAUDERIPPLE_HOME"] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = home;
  // Fail closed if a future import/caller tries to consult OS credential readers.
  const noOsCredentials = () => { throw new Error("OS credential readers are disabled in this test"); };
  t.mock.method(childProcess, "execFileSync", noOsCredentials);
  t.mock.method(childProcess, "execSync", noOsCredentials);
  t.mock.method(childProcess, "spawnSync", noOsCredentials);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    fs.rmSync(home, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  saveChatGptAccount(home, { accessToken: "fixture-token", refreshToken: "fixture-refresh", accountId: "fixture-workspace", expiresAt: Date.now() + 86_400_000 });
  let refreshes = 0;
  const adapter = new ChatGptAdapter("timeout-test", { type: "chatgpt", auth: "own", url: "https://backend.invalid" }, home, new Logger(null, 1e9, 0, false), undefined, async () => {
    refreshes++;
    return Response.json({ access_token: "fixture-fresh", refresh_token: "fixture-next", expires_in: 86400 });
  });
  const signals: AbortSignal[] = [];
  let calls = 0;
  let reply: (signal: AbortSignal) => Response = () => Response.json(quota);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://registry.npmjs.org/@openai/codex/latest") return Response.json({ version: "0.159.0" });
    assert.ok(url.startsWith("https://backend.invalid/"), "no real network or OAuth refresh");
    assert.ok(init?.signal);
    signals.push(init.signal);
    calls++;
    return reply(init.signal);
  });
  return { adapter, signals, calls: () => calls, refreshes: () => refreshes, reply: (next: typeof reply) => { reply = next; } };
}

function stalledBody(signal: AbortSignal) {
  const reading = Promise.withResolvers<void>();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { reading.resolve(); },
  }, { highWaterMark: 0 });
  signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
  return { response: new Response(stream), reading: reading.promise };
}

for (const spec of cases) {
  test(`${spec.name}: the deadline aborts a stalled JSON body and releases singleflight for a later lookup`, async (t) => {
    const r = rig(t);
    const started = Promise.withResolvers<void>();
    r.reply((signal) => {
      const stalled = stalledBody(signal);
      void stalled.reading.then(started.resolve);
      return stalled.response;
    });
    const first = spec.read(r.adapter);
    assert.equal(spec.read(r.adapter), first, "concurrent callers share the entire body read");
    await started.promise;
    t.mock.timers.tick(spec.timeout - 1);
    assert.equal(r.signals[0]!.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(r.signals[0]!.aborted, true, "the original deadline must remain active after headers");
    assert.equal(await first, null);
    assert.equal(r.calls(), 1);
    r.reply(() => Response.json(spec.body));
    assert.ok(await spec.read(r.adapter), "a timeout does not wedge the next lookup");
    assert.equal(r.calls(), 2);
    t.mock.timers.tick(spec.timeout);
    assert.equal(r.signals[1]!.aborted, false, "successful body consumption clears the timer");
  });

  for (const failure of ["invalid-json", "http", "fetch"] as const) {
    test(`${spec.name}: ${failure} releases its timer and allows a fresh lookup`, async (t) => {
      const r = rig(t);
      r.reply(() => {
        if (failure === "fetch") throw new Error("fixture connection failure");
        return new Response(failure === "http" ? "unavailable" : "{broken", { status: failure === "http" ? 503 : 200 });
      });
      assert.equal(await spec.read(r.adapter), null);
      t.mock.timers.tick(spec.timeout);
      assert.equal(r.signals[0]!.aborted, false, "every completed failure clears its timer");
      r.reply(() => Response.json(spec.body));
      assert.ok(await spec.read(r.adapter));
      assert.equal(r.calls(), 2);
    });
  }
}

test("quota: a 401 refreshes once and the replay keeps its own body deadline", async (t) => {
  const r = rig(t);
  const started = Promise.withResolvers<void>();
  r.reply((signal) => {
    if (r.calls() === 1) return new Response(null, { status: 401 });
    const stalled = stalledBody(signal);
    void stalled.reading.then(started.resolve);
    return stalled.response;
  });
  const pending = r.adapter.fetchRateLimits();
  await started.promise;
  assert.equal(r.refreshes(), 1);
  assert.equal(r.calls(), 2);
  t.mock.timers.tick(10_000);
  assert.equal(r.signals[0]!.aborted, false, "the original 401 attempt cleared its timer");
  assert.equal(r.signals[1]!.aborted, true, "the replay's body is still bounded");
  assert.equal(await pending, null);
  assert.equal(r.refreshes(), 1, "a body timeout must not refresh credentials again");
});

test("quota: a repeated 401 stops after one refresh and replay", async (t) => {
  const r = rig(t);
  r.reply(() => new Response(null, { status: 401 }));
  assert.equal(await r.adapter.fetchRateLimits(), null);
  assert.equal(r.refreshes(), 1);
  assert.equal(r.calls(), 2);
  t.mock.timers.tick(10_000);
  assert.ok(r.signals.every((signal) => !signal.aborted));
});

test("quota: a timed-out refresh preserves the last good snapshot", async (t) => {
  const r = rig(t);
  const good = await r.adapter.fetchRateLimits();
  assert.ok(good);
  const started = Promise.withResolvers<void>();
  r.reply((signal) => {
    const stalled = stalledBody(signal);
    void stalled.reading.then(started.resolve);
    return stalled.response;
  });
  const pending = r.adapter.fetchRateLimits();
  await started.promise;
  t.mock.timers.tick(10_000);
  assert.equal(await pending, null);
  assert.equal(r.adapter.lastRateLimits, good);
});

test("catalog: a timed-out refresh preserves the last good expired catalog", async (t) => {
  const r = rig(t);
  r.reply(() => Response.json(catalog));
  const good = await r.adapter.fetchModels();
  assert.ok(good);
  assert.equal(await r.adapter.fetchModels(), good);
  assert.equal(r.calls(), 1, "an unexpired catalog stays cached");
  t.mock.timers.tick(60 * 60 * 1000);
  const started = Promise.withResolvers<void>();
  r.reply((signal) => {
    const stalled = stalledBody(signal);
    void stalled.reading.then(started.resolve);
    return stalled.response;
  });
  const pending = r.adapter.fetchModels();
  await started.promise;
  t.mock.timers.tick(15_000);
  assert.equal(await pending, good);
  r.reply(() => Response.json(catalog));
  assert.ok(await r.adapter.fetchModels());
  assert.equal(r.calls(), 3, "a timed-out refresh releases singleflight without renewing the cache");
});
