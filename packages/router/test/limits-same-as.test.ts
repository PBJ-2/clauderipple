// Which login a cached Claude usage reading was taken with, so `/api/limits` hides a stored copy behind
// the app's login (and names it in `sameAs`) only while the login's figures are that login's own.
// Review of PR 179, 2026-11-20: the usage cache keeps the owner "current" across an account switch.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ClaudeUsage } from "../src/providers/anthropic-usage.ts";
import { ClaudeCurrentIdentity, loginAuthKey } from "../src/providers/anthropic-identity.ts";
import { subjectHash } from "../src/providers/anthropic-accounts.ts";
import type { Credential } from "../src/pool.ts";

const BODY = { five_hour: { utilization: 14 }, seven_day: null };
const UNIFIED = { "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-5h-utilization": "0.5" };

test("a usage reading names the login it was read with, as a hash the identity cache maps back without a request", async () => {
  let now = 1_000_000;
  let login = "token-a";
  let owners = ["current", "stored"];
  let refuse = false;
  const credentials = async (): Promise<Credential[]> => owners.map((ownerId) => ({
    id: `${ownerId}:1`,
    ownerId,
    headers: { authorization: `Bearer ${ownerId === "current" ? login : "token-stored"}` },
  }));
  const usage = new ClaudeUsage({ credentials }, {
    upstream: () => "api.example.test",
    now: () => now,
    ttlMs: 60_000,
    fetch: async () => refuse ? new Response("no", { status: 429, headers: { "retry-after": "3600" } }) : Response.json(BODY),
  });
  let profileAsks = 0;
  const identity = new ClaudeCurrentIdentity({ credentials }, {
    upstream: () => "api.example.test",
    now: () => now,
    fetch: async (_url, init) => {
      profileAsks++;
      const token = (init.headers as Record<string, string>).authorization!.replace(/^Bearer /, "");
      return Response.json({ account: { uuid: `uuid-${token}`, email: `${token}@example.test` } });
    },
  });
  const keyA = loginAuthKey({ authorization: "Bearer token-a" })!;
  const keyB = loginAuthKey({ authorization: "Bearer token-b" })!;

  assert.equal(usage.readWith("current"), undefined, "nothing read, no login named");
  const first = await usage.snapshot();
  assert.equal(usage.readWith("current"), keyA);
  assert.equal(usage.readWith("stored"), loginAuthKey({ authorization: "Bearer token-stored" }));
  assert.match(keyA, /^[0-9a-f]{64}$/, "a one-way hash");
  assert.ok(!keyA.includes("token-a"));
  // The snapshot object is sent as it is by /api/status and /api/claude-accounts, so it carries nothing new.
  assert.deepEqual(Object.keys(first.current!).sort(), ["at", "rate_limits", "type"]);

  // The identity cache answers only for a login it has looked up, and asks nobody to answer.
  assert.equal(identity.cachedFor(keyA), null, "never looked up");
  assert.equal(identity.cachedFor(undefined), null);
  assert.equal(profileAsks, 0);
  const a = await identity.identify();
  assert.deepEqual(a, { email: "token-a@example.test", subjectHash: subjectHash("uuid-token-a") });
  assert.deepEqual(identity.cachedFor(usage.readWith("current")), a);
  assert.equal(profileAsks, 1);

  // The app switches to B inside the usage interval: the lookup sees B, the cached reading is still A's.
  login = "token-b";
  await usage.snapshot();
  const b = await identity.identify();
  assert.equal(b?.email, "token-b@example.test");
  assert.equal(usage.readWith("current"), keyA, "the cached figures are still the previous login's");
  assert.deepEqual(identity.cachedFor(usage.readWith("current")), a);
  assert.notEqual(identity.cachedFor(usage.readWith("current"))?.subjectHash, b?.subjectHash);

  // The next reading is B's.
  now += 61_000;
  await usage.snapshot();
  assert.equal(usage.readWith("current"), keyB);
  assert.deepEqual(identity.cachedFor(usage.readWith("current")), b);
  assert.equal(profileAsks, 2, "one lookup per login, none for the mapping back");

  // A refused refresh keeps the old figures, and so keeps their login.
  refuse = true;
  now += 61_000;
  await usage.snapshot();
  assert.equal(usage.readWith("current"), keyB);
  // An answer whose caller does not say which auth it sent replaces the figures: their login is unknown.
  usage.observeAnswer("current", UNIFIED);
  assert.equal(usage.readWith("current"), undefined);
  // One that does is named by the auth it was sent with.
  usage.observeAnswer("current", UNIFIED, { authorization: "Bearer token-a" });
  assert.equal(usage.readWith("current"), keyA);
  // An answer that does not replace the reading leaves its login alone.
  refuse = false;
  now += 3_600_000;
  await usage.snapshot();
  assert.equal(usage.readWith("current"), keyB, "a body reading names the credential it was read with");
  usage.observeAnswer("current", UNIFIED);
  assert.equal(usage.readWith("current"), keyB, "a fresh body reading is kept, and so is its login");
  usage.observeAnswer("current", UNIFIED, { authorization: "Bearer token-b" });
  assert.equal(usage.readWith("current"), keyB);
  assert.equal(((await usage.snapshot()).current!.rate_limits as { primary: { used_percent: number } }).primary.used_percent, 14, "the same login's answer does not displace its fresh body reading");
  // An answer on another login does: the fresh body reading is the previous login's (second review, 2026-11-20).
  usage.observeAnswer("current", UNIFIED, { authorization: "Bearer token-a" });
  assert.equal(usage.readWith("current"), keyA);
  assert.equal(((await usage.snapshot()).current!.rate_limits as { primary: { used_percent: number } }).primary.used_percent, 50);

  // A removed account takes its login with it.
  owners = ["current"];
  now += 61_000;
  await usage.snapshot();
  assert.equal(usage.readWith("stored"), undefined);
});

// Second-round review (2026-11-20): an answer on another token replaces a fresh body reading only when
// the token is another login's. One login's refreshed token keeps the body reading (and the per-model
// weeklies only a body carries) once the identity cache places both tokens on the same account.
test("an answer on a refreshed token of the same login keeps the fresh body reading; one on another login replaces it", async () => {
  const accountOf: Record<string, string> = {
    [loginAuthKey({ authorization: "Bearer gen-1" })!]: "subject-a",
    [loginAuthKey({ authorization: "Bearer gen-2" })!]: "subject-a",
    [loginAuthKey({ authorization: "Bearer other" })!]: "subject-b",
  };
  const credentials = async (): Promise<Credential[]> => [{ id: "current:1", ownerId: "current", headers: { authorization: "Bearer gen-1" } }];
  const usage = new ClaudeUsage({ credentials }, {
    upstream: () => "api.example.test",
    ttlMs: 60_000,
    fetch: async () => Response.json({ ...BODY, seven_day_opus: { utilization: 40 } }),
    loginOf: (key) => accountOf[key] ?? null,
  });
  const percent = async () => ((await usage.snapshot()).current!.rate_limits as { primary: { used_percent: number } }).primary.used_percent;
  assert.equal(await percent(), 14);
  usage.observeAnswer("current", UNIFIED, { authorization: "Bearer gen-2" });
  assert.equal(await percent(), 14, "the same account's refreshed token: the body reading stays");
  assert.equal(usage.readWith("current"), loginAuthKey({ authorization: "Bearer gen-1" }));
  usage.observeAnswer("current", UNIFIED, { authorization: "Bearer unplaced" });
  assert.equal(await percent(), 50, "a token the cache cannot place may be another account: its answer is taken");
  usage.observeAnswer("current", { ...UNIFIED, "anthropic-ratelimit-unified-5h-utilization": "0.6" }, { authorization: "Bearer other" });
  assert.equal(await percent(), 60, "a header reading is replaced by the next answer, as before");
});
