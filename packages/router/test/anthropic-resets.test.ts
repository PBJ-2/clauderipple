// Anthropic's limit resets for a Claude account: reading what an account holds and using one
// (providers/anthropic-resets.ts), and the pool handing out a credential for that without routing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAccountAuthPool } from "../src/providers/anthropic-account-pool.ts";
import { ClaudeLimitResets, claudeResetsFromBody, type ClaudeResetsSource } from "../src/providers/anthropic-resets.ts";
import { ClaudeUsage, ClaudeUsageBackoff } from "../src/providers/anthropic-usage.ts";
import { saveClaudeOAuthAccount, setCurrentClaudeAccountPaused, updateClaudeAccount, markClaudeAccountNeedsReauth, readClaudeAccountsFile } from "../src/providers/anthropic-accounts.ts";
import { ClaudeCodeAuthStore, ClaudeCodeCredentialStore } from "../src/providers/anthropic.ts";

const ORG = "11111111-2222-3333-4444-555555555555";

/** The shape of a real answer (measured 2026-11-20, read-only), reduced to two grants. */
function usageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    five_hour: { utilization: 8, resets_at: "2026-11-20T19:00:00+00:00" },
    cedar_ember: {
      eligible: true,
      ineligible_reason: null,
      at_limit: false,
      exhausted: [],
      next_grant_id: "full-reset-2611",
      weekly_resets_at: "2026-11-25T04:00:00+00:00",
      cooldown_until: null,
      grants: [
        {
          id: "full-reset-2611",
          label: "One full limit reset (November 2026)",
          resets_total: 1,
          resets_left: 1,
          starts_at: "2026-11-10T21:30:00+00:00",
          ends_at: "2026-12-10T22:00:00+00:00",
          clears: ["five_hour", "seven_day", "seven_day_overage_included"],
          paused: false,
          usable_now: true,
          use_requires_limit: false,
          percent_used: { five_hour: 8, seven_day: 2, seven_day_overage_included: 0 },
          blocking: [],
          type: "full",
          unavailable_reason: null,
          gives_back_weekly: false,
        },
        { id: "used-up", label: "Spent", resets_total: 1, resets_left: 0, clears: ["five_hour"], paused: false, usable_now: false, type: "session", unavailable_reason: "already_used" },
      ],
      ...overrides,
    },
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

function harness(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const call: Call = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: typeof init.body === "string" ? init.body : undefined };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const source: ClaudeResetsSource = {
  credential: async (id) => id === "acct" ? { id: "acct:1", ownerId: "acct", headers: { authorization: "Bearer own-token", "anthropic-beta": "oauth-2025-04-20" } } : id === "stale" ? "needs-login" : null,
};

function resets(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, now: () => number = () => 1_000_000) {
  return new ClaudeLimitResets(source, { upstream: () => "api.example.test", fetch: fetchImpl, now, requestId: () => "req_test_1" });
}

async function preview(client: ClaudeLimitResets, owner = "acct"): Promise<string> {
  const result = await client.status(owner);
  assert.ok(result.ok && result.value.previewId);
  return result.value.previewId;
}

async function claimPreview(client: ClaudeLimitResets, grant = "full-reset-2611") {
  return client.claim("acct", grant, await preview(client));
}

function router(call: Call): Response {
  if (call.url.includes("/api/oauth/usage")) return json(usageBody());
  if (call.url.endsWith("/api/oauth/profile")) return json({ account: {}, organization: { uuid: ORG } });
  if (call.url.endsWith(`/api/organizations/${ORG}/reset_rate_limits`)) return json({ result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day"], weekly_resets_at: "2026-11-26T04:00:00+00:00" });
  return json({}, 404);
}

test("the status block of a usage body becomes grants, dropping what is malformed", () => {
  const status = claudeResetsFromBody(usageBody());
  assert.ok(status);
  assert.equal(status.eligible, true);
  assert.equal(status.nextGrantId, "full-reset-2611");
  assert.equal(status.weeklyResetsAt, "2026-11-25T04:00:00+00:00");
  assert.equal(status.grants.length, 2);
  const [full, spent] = status.grants;
  assert.deepEqual({ id: full!.id, left: full!.left, total: full!.total, usableNow: full!.usableNow, requiresLimit: full!.requiresLimit, type: full!.type }, { id: "full-reset-2611", left: 1, total: 1, usableNow: true, requiresLimit: false, type: "full" });
  assert.deepEqual(full!.clears, ["five_hour", "seven_day", "seven_day_overage_included"]);
  assert.equal(full!.endsAt, "2026-12-10T22:00:00+00:00");
  assert.equal(spent!.usableNow, false);
  // Anthropic's own client assumes a use needs a limit until the grant says otherwise.
  assert.equal(spent!.requiresLimit, true);

  assert.equal(claudeResetsFromBody({ cedar_ember: { grants: [{ id: "Bad Id", resets_left: 1 }, { id: "ok", resets_left: -1 }, { id: "fine", resets_left: 2, clears: ["five_hour", "nonsense"] }] } })!.grants.map((grant) => [grant.id, grant.clears]).flat(2).join(","), "fine,five_hour");
  assert.equal(claudeResetsFromBody({ cedar_ember: { next_grant_id: "ghost", grants: [] } })!.nextGrantId, null);
});

test("a Fable grant can preview the weekly total without claiming it is cleared", () => {
  const status = claudeResetsFromBody({
    seven_day: { utilization: 72.5 },
    seven_day_overage_included: { utilization: 91 },
    five_hour: { utilization: 10 },
    cedar_ember: { grants: [{ id: "fable", resets_left: 1, clears: ["seven_day_overage_included"], percent_used: { seven_day_overage_included: 94 }, gives_back_weekly: true }] },
  });
  const grant = status?.grants[0];
  assert.ok(grant);
  assert.equal(grant.givesBackWeekly, true);
  assert.deepEqual(grant.clears, ["seven_day_overage_included"]);
  assert.deepEqual(grant.percentUsed, { seven_day_overage_included: 94, seven_day: 72.5 });
});

test("an account the program does not reach has no resets, and a block that is not an object is unreadable", () => {
  const none = claudeResetsFromBody({ five_hour: null });
  assert.deepEqual({ eligible: none!.eligible, grants: none!.grants }, { eligible: false, grants: [] });
  assert.equal(claudeResetsFromBody({ cedar_ember: "nope" }), null);
  assert.equal(claudeResetsFromBody(null), null);
});

test("reading asks the usage endpoint with the account's own login and keeps the answer for thirty seconds", async () => {
  let clock = 1_000_000;
  const { calls, fetchImpl } = harness(router);
  const client = resets(fetchImpl, () => clock);
  const first = await client.status("acct");
  assert.ok(first.ok);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.example.test/api/oauth/usage?cedar_ember=1&skip_spend=1");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.headers.authorization, "Bearer own-token");
  await client.status("acct");
  assert.equal(calls.length, 1, "a second read inside thirty seconds is answered from memory");
  clock += 31_000;
  await client.status("acct");
  assert.equal(calls.length, 2);
  await client.status("acct", { force: true });
  assert.equal(calls.length, 3, "a forced read asks again");
});

test("an account that must sign in again, or does not exist, is named and nothing is sent", async () => {
  const { calls, fetchImpl } = harness(router);
  const client = resets(fetchImpl);
  assert.deepEqual(await client.status("stale"), { ok: false, error: { kind: "needs-login" } });
  assert.deepEqual(await client.status("ghost"), { ok: false, error: { kind: "unknown-account" } });
  assert.equal(calls.length, 0);
});

test("a 429 is not asked again before its retry-after, even for a forced read", async () => {
  let clock = 1_000_000;
  const { calls, fetchImpl } = harness(() => json({}, 429, { "retry-after": "120" }));
  const client = resets(fetchImpl, () => clock);
  assert.deepEqual(await client.status("acct"), { ok: false, error: { kind: "http", status: 429, retryAfterSeconds: 120 } });
  clock += 30_000;
  assert.deepEqual(await client.status("acct", { force: true }), { ok: false, error: { kind: "http", status: 429, retryAfterSeconds: 90 } });
  assert.equal(calls.length, 1);
  clock += 91_000;
  await client.status("acct", { force: true });
  assert.equal(calls.length, 2);
});

test("usage and resets honor the same OAuth backoff", async () => {
  const backoff = new ClaudeUsageBackoff();
  const credential = await source.credential("acct");
  assert.ok(credential && credential !== "needs-login");
  const { calls, fetchImpl } = harness(() => json({}, 429, { "retry-after": "120" }));
  const options = { upstream: () => "api.example.test", fetch: fetchImpl, backoff, now: () => 1_000_000 };
  const usage = new ClaudeUsage({ credentials: async () => [credential] }, options);
  const limitResets = new ClaudeLimitResets(source, options);
  await usage.snapshot();
  assert.deepEqual(await limitResets.status("acct", { force: true }), { ok: false, error: { kind: "http", status: 429, retryAfterSeconds: 120 } });
  assert.equal(calls.length, 1);
});

test("an older status response cannot replace the status read after a claim", async () => {
  let completeOld!: (response: Response) => void;
  const old = new Promise<Response>(resolve => { completeOld = resolve; });
  let requestedOld!: () => void;
  const requested = new Promise<void>(resolve => { requestedOld = resolve; });
  let reads = 0;
  const { fetchImpl } = harness(call => {
    if (!call.url.includes("/api/oauth/usage")) return router(call);
    if (++reads === 2) { requestedOld(); return old; }
    return json(usageBody(reads === 4 ? { grants: [] } : {}));
  });
  const client = resets(fetchImpl);
  const binding = await preview(client);
  const stale = client.status("acct", { force: true });
  await requested;
  const claim = await client.claim("acct", "full-reset-2611", binding);
  assert.ok(claim.ok);
  assert.equal(claim.value.status?.grants.length, 0);
  completeOld(json(usageBody()));
  await stale;
  const cached = await client.status("acct");
  assert.ok(cached.ok);
  assert.equal(cached.value.grants.length, 0);
});

test("using a reset reads the status again, names the account's organization, sends the one grant once, and reads the status afterwards", async () => {
  const { calls, fetchImpl } = harness(router);
  const outcome = await claimPreview(resets(fetchImpl));
  assert.ok(outcome.ok);
  assert.equal(outcome.value.claim.result, "reset");
  assert.equal(outcome.value.claim.resetsLeft, 0);
  assert.deepEqual(outcome.value.claim.cleared, ["five_hour", "seven_day"]);
  const posts = calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, `https://api.example.test/api/organizations/${ORG}/reset_rate_limits`);
  assert.deepEqual(JSON.parse(posts[0]!.body!), { program: "cedar_ember", grant_id: "full-reset-2611", request_id: "req_test_1" });
  assert.equal(posts[0]!.headers.authorization, "Bearer own-token");
  assert.equal(posts[0]!.headers["content-type"], "application/json");
  // A fresh status before (to check the grant) and one after (to show the new count).
  assert.equal(calls.filter((call) => call.url.includes("/api/oauth/usage")).length, 3);
  assert.ok(outcome.value.status);
});

test("a grant that is unknown, spent or not usable now is refused without sending anything", async () => {
  const { calls, fetchImpl } = harness(router);
  const client = resets(fetchImpl);
  for (const [grant, reason] of [["ghost", "unknown_grant"], ["used-up", "already_used"]] as const) {
    const outcome = await claimPreview(client, grant);
    assert.ok(outcome.ok);
    assert.equal(outcome.value.claim.result, "not_usable");
    assert.equal(outcome.value.claim.reason, reason);
  }
  const malformed = await client.claim("acct", "Not A Grant!", "");
  assert.equal(malformed.ok, false);
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

test("a use nobody could confirm is never retried and is followed by a fresh status", async () => {
  let posts = 0;
  const { calls, fetchImpl } = harness((call) => {
    if (call.method === "POST") {
      posts += 1;
      throw new Error("socket hang up");
    }
    return router(call);
  });
  const outcome = await claimPreview(resets(fetchImpl));
  assert.ok(outcome.ok);
  assert.equal(outcome.value.claim.result, "unconfirmed");
  assert.equal(posts, 1);
  assert.ok(outcome.value.status, "the person is shown the status to see whether the use counted");
  assert.equal(calls.filter((call) => call.url.includes("/api/oauth/usage")).length, 3);
});

test("Anthropic's own refusals are passed on and spend nothing here", async () => {
  for (const [status, expected] of [[429, "rate_limited"], [401, "auth_error"], [403, "auth_error"], [400, "error"], [503, "unconfirmed"]] as const) {
    const { fetchImpl } = harness((call) => call.method === "POST" ? json({ error: "x" }, status) : router(call));
    const outcome = await claimPreview(resets(fetchImpl));
    assert.ok(outcome.ok);
    assert.equal(outcome.value.claim.result, expected, `HTTP ${status}`);
  }
  const { fetchImpl } = harness((call) => call.method === "POST" ? json({ result: "not_limited", reason: "not_limited" }) : router(call));
  const outcome = await claimPreview(resets(fetchImpl));
  assert.ok(outcome.ok);
  assert.deepEqual({ result: outcome.value.claim.result, reason: outcome.value.claim.reason }, { result: "not_limited", reason: "not_limited" });
});

test("a login switch before or during eligibility never sends a claim", async () => {
  for (const switchDuringRead of [false, true]) {
    let token = "first";
    let reads = 0;
    const { calls, fetchImpl } = harness((call) => {
      if (switchDuringRead && call.url.includes("/api/oauth/usage") && ++reads === 2) token = "second";
      return router(call);
    });
    const client = new ClaudeLimitResets({ credential: async () => ({ id: token, headers: { authorization: `Bearer ${token}` } }) }, {
      upstream: () => "api.example.test", fetch: fetchImpl,
    });
    const binding = await preview(client, "current");
    if (!switchDuringRead) token = "second";
    assert.deepEqual(await client.claim("current", "full-reset-2611", binding), { ok: false, error: { kind: "account-changed" } });
    assert.equal(calls.some((call) => call.method === "POST"), false);
  }
});

test("only one use runs at a time across rows for the same organization", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { calls, fetchImpl } = harness(async (call) => {
    if (call.method === "POST") await gate;
    return router(call);
  });
  const client = new ClaudeLimitResets({ credential: async (owner) => ({ id: owner, headers: { authorization: `Bearer ${owner}` } }) }, {
    upstream: () => "api.example.test", fetch: fetchImpl,
  });
  const firstBinding = await preview(client, "current");
  const secondBinding = await preview(client, "stored");
  const first = client.claim("current", "full-reset-2611", firstBinding);
  // Let the first claim reach its POST.
  while (!calls.some((call) => call.method === "POST")) await new Promise((resolve) => setImmediate(resolve));
  const second = await client.claim("stored", "full-reset-2611", secondBinding);
  assert.ok(second.ok);
  assert.equal(second.value.claim.result, "busy");
  release();
  const done = await first;
  assert.ok(done.ok);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("an organization that is not a plain id is never put in a URL", async () => {
  const { calls, fetchImpl } = harness((call) => call.url.endsWith("/api/oauth/profile") ? json({ organization: { uuid: "../../evil" } }) : router(call));
  const outcome = await claimPreview(resets(fetchImpl));
  assert.deepEqual(outcome, { ok: false, error: { kind: "no-organization" } });
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

// ---- The pool's credential for a lookup that is about the account, not about routing ----

function dir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-resets-"));
}

const logger = { info: () => {}, warn: () => {} };

function poolWithCurrent(home: string, now: () => number, accessToken: string | null): ClaudeAccountAuthPool {
  const current = new ClaudeCodeAuthStore(
    new ClaudeCodeCredentialStore(() => accessToken ? JSON.stringify({ claudeAiOauth: { accessToken, expiresAt: 9_000_000 } }) : null, now),
    { home, env: {}, now },
  );
  return new ClaudeAccountAuthPool({ home, now, current, log: logger });
}

test("a paused stored account and a paused current login still have a credential for their resets, while routing skips them", async () => {
  const home = dir();
  try {
    const now = () => 1_000_000;
    const stored = saveClaudeOAuthAccount(home, { accessToken: "stored-access", refreshToken: "stored-refresh", expiresAt: 9_000_000, accountId: "stored-id" });
    updateClaudeAccount(home, stored.id, { paused: true });
    setCurrentClaudeAccountPaused(home, true);
    const pool = poolWithCurrent(home, now, "current-access");
    assert.deepEqual(pool.peekCredentials(), [], "paused accounts are not routed");
    const own = await pool.accountCredential(stored.id);
    assert.ok(own && own !== "needs-login");
    assert.equal(own.headers.authorization, "Bearer stored-access");
    assert.equal(own.ownerId, stored.id);
    const current = await pool.accountCredential("current");
    assert.ok(current && current !== "needs-login");
    assert.equal(current.headers.authorization, "Bearer current-access");
    assert.equal(current.ownerId, "current");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an account that must sign in again says so, and an unknown account or a missing login gives nothing", async () => {
  const home = dir();
  try {
    const now = () => 1_000_000;
    const stored = saveClaudeOAuthAccount(home, { accessToken: "stored-access", refreshToken: "stored-refresh", expiresAt: 9_000_000, accountId: "stored-id" });
    markClaudeAccountNeedsReauth(home, stored.id, readClaudeAccountsFile(home)[0]!.refreshToken);
    const pool = poolWithCurrent(home, now, null);
    assert.equal(await pool.accountCredential(stored.id), "needs-login");
    assert.equal(await pool.accountCredential("ghost"), null);
    assert.equal(await pool.accountCredential("current"), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a stored account whose token is due is refreshed before its credential is handed out", async () => {
  const home = dir();
  try {
    const clock = 1_000_000;
    const stored = saveClaudeOAuthAccount(home, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: clock + 60_000, accountId: "stored-id" });
    const current = new ClaudeCodeAuthStore(new ClaudeCodeCredentialStore(() => null, () => clock), { home, env: {}, now: () => clock });
    const pool = new ClaudeAccountAuthPool({
      home,
      now: () => clock,
      current,
      log: logger,
      fetch: async () => json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
    });
    const credential = await pool.accountCredential(stored.id);
    assert.ok(credential && credential !== "needs-login");
    assert.equal(credential.headers.authorization, "Bearer new-access");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
