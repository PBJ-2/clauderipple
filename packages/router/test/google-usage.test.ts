// The Antigravity quota lookup: the `retrieveUserQuotaSummary` parse and its window mapping, and
// the per-account cache. The response shape is the measured one (2026-10-15); the values are fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleUsage, antigravityQuotaScope, googleWindowsFromGroups, parseQuotaSummary } from "../src/providers/google/usage.ts";
import { antigravityCliUserAgent, antigravityUserAgent } from "../src/providers/google/antigravity.ts";

const measured = {
  groups: [
    { displayName: "Gemini Models", buckets: [
      { bucketId: "gemini-weekly", displayName: "Weekly", window: "weekly", resetTime: "2026-10-19T00:00:00Z", remainingFraction: 0.98 },
      { bucketId: "gemini-5h", displayName: "5h", window: "5h", resetTime: "2026-10-15T05:39:48Z", remainingFraction: 1 },
    ] },
    { displayName: "Claude and GPT models", buckets: [
      { bucketId: "3p-weekly", displayName: "Weekly", window: "weekly", resetTime: "2026-10-19T00:00:00Z", remainingFraction: 0.9 },
      { bucketId: "3p-5h", displayName: "5h", window: "5h", resetTime: "2026-10-15T05:39:48Z", remainingFraction: 1 },
    ] },
  ],
};

test("the quota summary parses into groups; a body of the wrong shape gives null", () => {
  const groups = parseQuotaSummary(measured);
  assert.equal(groups?.length, 2);
  assert.equal(groups?.[0]?.displayName, "Gemini Models");
  assert.equal(groups?.[0]?.buckets[0]?.remainingFraction, 0.98);
  // A bucket without a readable fraction is dropped; a group left empty goes too.
  assert.deepEqual(parseQuotaSummary({ groups: [{ displayName: "X", buckets: [{ window: "5h" }] }] }), []);
  assert.equal(parseQuotaSummary({}), null);
  assert.equal(parseQuotaSummary(null), null);
  assert.equal(parseQuotaSummary([1, 2]), null);
});

test("windows map Gemini's own to five-hour/weekly and every other group to a scoped 3P", () => {
  const groups = parseQuotaSummary(measured)!;
  const windows = googleWindowsFromGroups(groups);
  assert.deepEqual(windows, [
    { kind: "five_hour", used_percent: 0, window_minutes: 300, reset_at: Math.round(Date.parse("2026-10-15T05:39:48Z") / 1000) },
    { kind: "seven_day", used_percent: 2, window_minutes: 10080, reset_at: Math.round(Date.parse("2026-10-19T00:00:00Z") / 1000) },
    { kind: "scoped", label: "3P", used_percent: 10, window_minutes: 10080, reset_at: Math.round(Date.parse("2026-10-19T00:00:00Z") / 1000) },
    { kind: "scoped", label: "3P", used_percent: 0, window_minutes: 300, reset_at: Math.round(Date.parse("2026-10-15T05:39:48Z") / 1000) },
  ]);
});

test("usage is cached per account and a failed lookup keeps the last good groups", async () => {
  const seen: string[] = [];
  let fail = false;
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    if (fail) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(measured), { status: 200 });
  }) as unknown as typeof fetch;
  let now = 1_000_000;
  const source = { credentials: async () => [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj" }] } as never;
  const instance = new GoogleUsage(source, { fetch: fetchImpl, now: () => now, ttlMs: 300_000, warn: () => {} });
  const first = await instance.snapshot();
  assert.equal(first["acct-1"]?.length, 2);
  assert.equal(seen.length, 1);
  // Within the TTL the answer is served from the cache, and no new request is made.
  await instance.snapshot();
  assert.equal(seen.length, 1);
  // Past the TTL a failed lookup keeps the last good groups.
  now += 300_001;
  fail = true;
  const third = await instance.snapshot();
  assert.equal(third["acct-1"]?.length, 2);
  assert.equal(seen.length, 3, "an unreadable CLI summary also tries the IDE UA");
});

test("each account keeps the time of its own last good lookup", async () => {
  let now = 1_000_000;
  let failSecond = false;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const project = (JSON.parse(init?.body as string) as { project: string }).project;
    if (project === "proj-2" && failSecond) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(measured), { status: 200 });
  }) as unknown as typeof fetch;
  const accounts = [
    { ownerId: "acct-1", accessToken: "tok", projectId: "proj-1" },
    { ownerId: "acct-2", accessToken: "tok2", projectId: "proj-2" },
  ];
  const usage = new GoogleUsage({ credentials: async () => accounts } as never, { fetch: fetchImpl, now: () => now, ttlMs: 300_000, warn: () => {} });
  const readTimes = (groups: { read_at?: number }[] | undefined) => [...new Set((groups ?? []).map((g) => g.read_at))];
  let shown = await usage.snapshot();
  assert.deepEqual(readTimes(shown["acct-1"]), [1_000_000]);
  assert.deepEqual(readTimes(shown["acct-2"]), [1_000_000]);
  now = 1_000_000 + 300_001;
  failSecond = true;
  shown = await usage.snapshot();
  assert.deepEqual(readTimes(shown["acct-1"]), [now], "the first account was read again");
  assert.deepEqual(readTimes(shown["acct-2"]), [1_000_000], "the second account's failed lookup keeps its own earlier time");
});

// hasRemainingQuota: cached, positive-only evidence from the last successful lookup.
const NOW = Date.parse("2026-10-15T00:00:00Z");
const FUTURE = "2026-10-15T03:00:00Z";
const bucket = (window: string, remainingFraction: unknown, resetTime: unknown = FUTURE) => ({ displayName: window, window, resetTime, remainingFraction });
// A bucket without its own bucketId gets the measured one for its group ("gemini-5h", "3p-weekly").
const group = (displayName: string, prefix: string, buckets: unknown[]) => ({
  displayName,
  buckets: buckets.map((b) => ({ bucketId: `${prefix}-${(b as { window: string }).window}`, ...(b as object) })),
});
const summary = (gemini: unknown[], thirdParty: unknown[]) => ({ groups: [group("Gemini Models", "gemini", gemini), group("Claude and GPT models", "3p", thirdParty)] });
const healthy = () => summary([bucket("weekly", 0.5), bucket("5h", 1)], [bucket("weekly", 0.2), bucket("5h", 0.01)]);
const ARGON = "gemini-4-argon";
const argonBucket = (remainingFraction: unknown = 0.4, resetTime: unknown = FUTURE) => ({ ...bucket("weekly", remainingFraction, resetTime), bucketId: "gemini-argon-wtu-weekly" });
const argonGroup = (buckets: unknown[] = [argonBucket()]) => ({ displayName: "Gemini 4 Argon", buckets });
const withArgon = (buckets: unknown[] = [argonBucket()]) => ({ groups: [...healthy().groups, argonGroup(buckets)] });

type Account = { ownerId: string; accessToken: string; projectId: string };
function harness(initial: unknown = healthy()) {
  const state = { body: initial as unknown, status: 200, now: NOW, accounts: [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj-1" }] as Account[], calls: 0 };
  const fetchImpl = (async () => {
    state.calls++;
    return state.status === 200 ? new Response(JSON.stringify(state.body), { status: 200 }) : new Response("nope", { status: state.status });
  }) as unknown as typeof fetch;
  const usage = new GoogleUsage({ credentials: async () => state.accounts } as never, { fetch: fetchImpl, now: () => state.now, ttlMs: 300_000, warn: () => {} });
  return { state, usage, acct: (): Account => state.accounts[0]! };
}
const GEMINI = "gemini-3.8-flash";

test("quota is read from the host the requests go to, the daily host unless configured", async () => {
  // Each host counts its own: prod answered 1.0 for a day of use on daily (2026-10-20).
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(measured), { status: 200 });
  }) as unknown as typeof fetch;
  const source = { credentials: async () => [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj" }] } as never;
  await new GoogleUsage(source, { fetch: fetchImpl, warn: () => {} }).snapshot();
  await new GoogleUsage(source, { baseUrl: "https://example.test", fetch: fetchImpl, warn: () => {} }).snapshot();
  assert.deepEqual(seen, [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://example.test/v1internal:retrieveUserQuotaSummary",
  ]);
});

test("every configured host is read, one failing host keeps the other's numbers and evidence", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    if (url.startsWith("https://prod.test/")) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(measured), { status: 200 });
  }) as unknown as typeof fetch;
  const source = { credentials: async () => [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj" }] } as never;
  const usage = new GoogleUsage(source, {
    baseUrl: "https://daily.test",
    hosts: () => ["https://daily.test", "https://prod.test"],
    fetch: fetchImpl,
    now: () => Date.parse("2026-10-15T00:00:00Z"),
    warn: () => {},
  });
  const shown = await usage.snapshot();
  assert.deepEqual(seen.sort(), [
    "https://daily.test/v1internal:retrieveUserQuotaSummary",
    "https://prod.test/v1internal:retrieveUserQuotaSummary",
    "https://prod.test/v1internal:retrieveUserQuotaSummary",
  ]);
  assert.equal(shown["acct-1"]?.length, 2, "the reachable host's groups are shown");
  assert.equal(usage.hasRemainingQuota({ ownerId: "acct-1", projectId: "proj" }, GEMINI, "https://daily.test"), true);
  assert.equal(usage.hasRemainingQuota({ ownerId: "acct-1", projectId: "proj" }, GEMINI, "https://prod.test"), false, "a failed host proves nothing");
});

test("hasRemainingQuota evidence belongs to one host: the same model on another host is unknown", async () => {
  const fetchImpl = (async (url: string) => {
    const fraction = url.startsWith("https://daily.test/") ? 0.9 : 0;
    const body = summary([bucket("weekly", fraction), bucket("5h", fraction, FUTURE)], []);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const source = { credentials: async () => [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj" }] } as never;
  const usage = new GoogleUsage(source, {
    baseUrl: "https://daily.test",
    hosts: () => ["https://daily.test", "https://prod.test"],
    fetch: fetchImpl,
    now: () => NOW,
    warn: () => {},
  });
  const shown = await usage.snapshot();
  const a = { ownerId: "acct-1", projectId: "proj" };
  // Both hosts answered; the row takes the higher used percent, so the exhausted prod windows win.
  const fiveHour = shown["acct-1"]?.find((g) => /gemini/i.test(g.displayName))?.buckets.find((b) => b.window === "5h");
  assert.equal(fiveHour?.remainingFraction, 0, "both hosts in use: the row shows the closer-to-spent window");
  assert.equal(usage.hasRemainingQuota(a, GEMINI, "https://daily.test"), true, "the daily host has room");
  assert.equal(usage.hasRemainingQuota(a, GEMINI, "https://prod.test"), false, "prod's windows are spent");
  // The default host is the provider's, so an unspecified host means daily here.
  assert.equal(usage.hasRemainingQuota(a, GEMINI), true);
  assert.equal(usage.hasRemainingQuota(a, GEMINI, "https://unread.test"), false, "an unread host is not evidence");
});

test("hasRemainingQuota is false until a lookup has succeeded, never fetches, then is true on the ordinary positive path", async () => {
  const h = harness();
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), false);
  assert.equal(h.state.calls, 0);
  await h.usage.snapshot();
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), true);
  // Both windows only need to be positive: 1 (untouched) and 0.01 (almost spent) both count.
  assert.equal(h.usage.hasRemainingQuota(h.acct(), "claude-opus-4-6-thinking"), true);
  assert.equal(h.state.calls, 1);
});

test("hasRemainingQuota reads the model's own group and treats unrecognized models as false", async () => {
  const h = harness(summary([bucket("weekly", 0.5), bucket("5h", 0.5)], [bucket("weekly", 0.5), bucket("5h", 0)]));
  await h.usage.snapshot();
  const a = h.acct();
  for (const model of ["gemini-3.1-pro", "gemini-pro-agent", "gemini-3.7-flash-tiered"]) assert.equal(h.usage.hasRemainingQuota(a, model), true, model);
  // The third-party group has a spent 5h window.
  for (const model of ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]) assert.equal(h.usage.hasRemainingQuota(a, model), false, model);
  // With room in that group, claude-/gpt-oss are true, but names outside the known families never are.
  h.state.body = healthy();
  h.state.now += 300_001;
  await h.usage.snapshot();
  for (const model of ["claude-sonnet-4-6", "gpt-oss-120b-medium"]) assert.equal(h.usage.hasRemainingQuota(a, model), true, model);
  for (const model of ["gpt-6-sol", "gemini", "geminix-1", "gpt-oss2", "llama-4", ""]) assert.equal(h.usage.hasRemainingQuota(a, model), false, model);
});

test("hasRemainingQuota expires with the cache TTL, and a clock that moved backwards is not evidence", async () => {
  const h = harness();
  await h.usage.snapshot();
  h.state.now = NOW + 299_999;
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), true);
  h.state.now = NOW + 300_000;
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), false);
  h.state.now = NOW - 1;
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), false);
});

test("hasRemainingQuota is false once a reset time has passed, even inside the snapshot TTL", async () => {
  const reset = NOW + 60_000;
  const h = harness(summary([bucket("weekly", 0.5), bucket("5h", 0.5, new Date(reset).toISOString())], []));
  await h.usage.snapshot();
  h.state.now = reset - 1;
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), true);
  h.state.now = reset;
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), false);
});

test("a failed refresh drops the evidence even though the dashboard keeps the last good groups", async () => {
  const h = harness();
  await h.usage.snapshot();
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), true);
  h.state.now += 300_001;
  h.state.status = 500;
  const shown = await h.usage.snapshot();
  assert.equal(shown["acct-1"]?.length, 2);
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), false);
  // A response of the wrong shape is a failed lookup too, and a later success restores the evidence.
  h.state.now += 300_001;
  h.state.status = 200;
  h.state.body = { nope: true };
  await h.usage.snapshot();
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), false);
  h.state.now += 300_001;
  h.state.body = healthy();
  await h.usage.snapshot();
  assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), true);
});

test("hasRemainingQuota belongs to one account and project, and a removed account loses its evidence", async () => {
  const h = harness();
  h.state.accounts.push({ ownerId: "acct-2", accessToken: "tok2", projectId: "proj-2" });
  await h.usage.snapshot();
  const [one, two] = h.state.accounts as [Account, Account];
  assert.equal(h.usage.hasRemainingQuota(one, GEMINI), true);
  assert.equal(h.usage.hasRemainingQuota(two, GEMINI), true);
  assert.equal(h.usage.hasRemainingQuota({ ownerId: "acct-3", projectId: "proj-1" }, GEMINI), false);
  // The same owner under another project is a different quota.
  assert.equal(h.usage.hasRemainingQuota({ ownerId: "acct-1", projectId: "proj-other" }, GEMINI), false);
  // acct-1 is removed and later signs in again with a new project: the old answer cannot be reused.
  h.state.accounts.shift();
  h.state.now += 300_001;
  await h.usage.snapshot();
  assert.equal(h.usage.hasRemainingQuota(one, GEMINI), false);
  assert.equal(h.usage.hasRemainingQuota(two, GEMINI), true);
  h.state.accounts.push({ ownerId: "acct-1", accessToken: "tok", projectId: "proj-new" });
  assert.equal(h.usage.hasRemainingQuota({ ownerId: "acct-1", projectId: "proj-new" }, GEMINI), false);
  assert.equal(h.usage.hasRemainingQuota(one, GEMINI), false);
});

test("hasRemainingQuota rejects invalid fractions, bad resets and missing or ambiguous windows", async () => {
  const cases: Record<string, unknown[]> = {
    "zero 5h": [bucket("weekly", 0.5), bucket("5h", 0)],
    "zero weekly": [bucket("weekly", 0), bucket("5h", 0.5)],
    "negative": [bucket("weekly", -0.1), bucket("5h", 0.5)],
    "above one": [bucket("weekly", 0.5), bucket("5h", 1.0001)],
    "disabled required bucket": [bucket("weekly", 0.5), { ...bucket("5h", 1), disabled: true }],
    "malformed disabled flag": [bucket("weekly", 0.5), { ...bucket("5h", 1), disabled: "false" }],
    "null fraction": [bucket("weekly", 0.5), bucket("5h", null)],
    "nonfinite fraction": [bucket("weekly", Number.POSITIVE_INFINITY), bucket("5h", 0.5)],
    "unreadable fraction (dropped by the parse)": [bucket("weekly", 0.5), bucket("5h", "0.5")],
    "missing 5h": [bucket("weekly", 0.5)],
    "missing weekly": [bucket("5h", 0.5)],
    "unknown window only": [bucket("monthly", 0.5), bucket("5h", 0.5)],
    "duplicate 5h": [bucket("weekly", 0.5), bucket("5h", 0.5), bucket("5h", 0.5)],
    "missing reset": [bucket("weekly", 0.5), { window: "5h", remainingFraction: 0.5 }],
    "invalid reset": [bucket("weekly", 0.5), bucket("5h", 0.5, "not a date")],
    "reset in the past": [bucket("weekly", 0.5), bucket("5h", 0.5, "2026-10-14T23:59:59Z")],
    "reset exactly now": [bucket("weekly", 0.5), bucket("5h", 0.5, "2026-10-15T00:00:00Z")],
    "no buckets": [],
    "extra exhausted window": [bucket("weekly", 0.5), bucket("5h", 0.5), bucket("monthly", 0)],
    "extra bucket of a known window": [bucket("weekly", 0.5), bucket("5h", 0.5), { ...bucket("5h", 0), bucketId: "other-5h" }],
    "wrong bucket id": [bucket("weekly", 0.5), { ...bucket("5h", 0.5), bucketId: "something-else" }],
    "malformed extra bucket (dropped by the display parse)": [bucket("weekly", 0.5), bucket("5h", 0.5), { window: "5h", bucketId: "gemini-5h" }],
    "malformed duplicate bucket": [bucket("weekly", 0.5), bucket("5h", 0.5), { ...bucket("5h", 0.5), remainingFraction: "0" }],
  };
  for (const [name, buckets] of Object.entries(cases)) {
    const h = harness(summary(buckets, buckets));
    await h.usage.snapshot();
    assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), false, name);
    assert.equal(h.usage.hasRemainingQuota(h.acct(), "claude-sonnet-4-6"), false, name);
  }
  // An absent or duplicated group is unknown too.
  const noThirdParty = harness({ groups: [group("Gemini Models", "gemini", [bucket("weekly", 0.5), bucket("5h", 0.5)])] });
  await noThirdParty.usage.snapshot();
  assert.equal(noThirdParty.usage.hasRemainingQuota(noThirdParty.acct(), GEMINI), true);
  assert.equal(noThirdParty.usage.hasRemainingQuota(noThirdParty.acct(), "claude-sonnet-4-6"), false);
  const twoGemini = harness({ groups: [...healthy().groups, group("gemini models", "gemini", [bucket("weekly", 0.5), bucket("5h", 0.5)])] });
  await twoGemini.usage.snapshot();
  assert.equal(twoGemini.usage.hasRemainingQuota(twoGemini.acct(), GEMINI), false);
});

test("hasRemainingQuota accepts only the exact known group names and a structurally valid body", async () => {
  // Case and surrounding space in the name are tolerated; a renamed or lookalike group is not a known group.
  const ok = harness({ groups: [group(" gemini MODELS ", "gemini", [bucket("weekly", 0.5), bucket("5h", 0.5)]), group("claude and gpt MODELS", "3p", [bucket("weekly", 0.5), bucket("5h", 0.5)])] });
  await ok.usage.snapshot();
  assert.equal(ok.usage.hasRemainingQuota(ok.acct(), GEMINI), true);
  assert.equal(ok.usage.hasRemainingQuota(ok.acct(), "claude-sonnet-4-6"), true);
  const renamed = harness({ groups: [group("Gemini Models", "gemini", [bucket("weekly", 0.5), bucket("5h", 0.5)]), group("GPT premium", "3p", [bucket("weekly", 0.5), bucket("5h", 0.5)])] });
  await renamed.usage.snapshot();
  assert.equal(renamed.usage.hasRemainingQuota(renamed.acct(), GEMINI), true);
  assert.equal(renamed.usage.hasRemainingQuota(renamed.acct(), "claude-sonnet-4-6"), false);
  assert.equal(renamed.usage.hasRemainingQuota(renamed.acct(), "gpt-oss-120b-medium"), false);
  // A malformed group anywhere (even an unrelated one the display parse silently drops) voids the whole snapshot,
  // while the display still shows what parsed.
  for (const bad of [{ displayName: "Other", buckets: "nope" }, { buckets: [] }, 42, { displayName: "Other", buckets: [{ window: "5h", bucketId: "x", remainingFraction: 0 }, null] }]) {
    const h = harness({ groups: [...summary([bucket("weekly", 0.5), bucket("5h", 0.5)], [bucket("weekly", 0.5), bucket("5h", 0.5)]).groups, bad] });
    const shown = await h.usage.snapshot();
    assert.equal((shown["acct-1"]?.length ?? 0) >= 2, true);
    assert.equal(h.usage.hasRemainingQuota(h.acct(), GEMINI), false, JSON.stringify(bad));
  }
});

test("quota uses the CLI header and summary endpoint for the full Gemini, 3P and Argon groups", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const usage = new GoogleUsage({ credentials: async () => [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj-1" }] } as never, {
    fetch: async (url, init) => {
      seen.push({ url, init });
      return Response.json(withArgon());
    },
    now: () => NOW,
  });
  const shown = await usage.snapshot();
  assert.equal(shown["acct-1"]?.length, 3);
  assert.equal(seen.length, 1, "a readable CLI summary needs neither an IDE nor a catalogue lookup");
  assert.equal(seen[0]?.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
  assert.equal(seen[0]?.init?.method, "POST");
  const headers = new Headers(seen[0]?.init?.headers);
  assert.equal(headers.get("user-agent"), antigravityCliUserAgent());
  assert.equal(headers.get("authorization"), "Bearer tok");
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(seen[0]?.init?.body as string), { project: "proj-1" });
});

test("Argon's exact weekly bucket is scoped separately, preserving Gemini and 3P window labels", () => {
  const windows = googleWindowsFromGroups(parseQuotaSummary(withArgon())!);
  assert.deepEqual(windows.slice(0, -1), googleWindowsFromGroups(parseQuotaSummary(healthy())!));
  assert.deepEqual(windows.at(-1), {
    kind: "scoped", label: "Argon weekly", used_percent: 60, window_minutes: 10080, reset_at: Date.parse(FUTURE) / 1000,
  });
  assert.equal(windows.filter((w) => w.kind === "seven_day").length, 1);
  const unknown = googleWindowsFromGroups(parseQuotaSummary({ groups: [argonGroup([{ ...argonBucket(), bucketId: "other-weekly" }])] })!);
  assert.equal(unknown[0]?.label, "Argon", "a lookalike bucket is not the known Argon weekly window");
});

test("spent Argon cannot borrow available Flash quota, and available Argon cannot prove Flash quota", async () => {
  const spent = harness(withArgon([argonBucket(0)]));
  await spent.usage.snapshot();
  assert.equal(spent.usage.hasRemainingQuota(spent.acct(), GEMINI), true);
  for (const model of [ARGON, `${ARGON}-low`, `${ARGON}-medium`, `${ARGON}-high@high`]) {
    assert.equal(antigravityQuotaScope(model), "argon");
    assert.equal(spent.usage.hasRemainingQuota(spent.acct(), model), false, model);
  }
  const available = harness({ groups: [...summary([bucket("weekly", 0), bucket("5h", 0)], []).groups, argonGroup()] });
  await available.usage.snapshot();
  assert.equal(available.usage.hasRemainingQuota(available.acct(), GEMINI), false);
  for (const model of [ARGON, `${ARGON}-low`, `${ARGON}-medium`, `${ARGON}-high@high`, "GEMINI-4-ARGON@medium"]) {
    assert.equal(available.usage.hasRemainingQuota(available.acct(), model), true, model);
  }
  for (const fraction of [1, 0.00001]) {
    const h = harness(withArgon([{ ...argonBucket(fraction), disabled: false }]));
    await h.usage.snapshot();
    assert.equal(h.usage.hasRemainingQuota(h.acct(), ARGON), true, String(fraction));
  }
});

test("missing Argon stays unknown, even with Gemini room or contradictory catalogue quotaInfo", async () => {
  const seen: string[] = [];
  const body = { ...healthy(), models: { "gemini-4-argon-high": { quotaInfo: { remainingFraction: 1, resetTime: FUTURE } } } };
  const usage = new GoogleUsage({ credentials: async () => [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj-1" }] } as never, {
    fetch: async (url) => {
      seen.push(url);
      assert.ok(url.endsWith(":retrieveUserQuotaSummary"), "catalogue quotaInfo must never be requested as quota evidence");
      return Response.json(body);
    },
    now: () => NOW,
  });
  const shown = await usage.snapshot();
  const account = { ownerId: "acct-1", projectId: "proj-1" };
  assert.equal(usage.hasRemainingQuota(account, GEMINI), true);
  assert.equal(usage.hasRemainingQuota(account, ARGON), false);
  assert.equal(googleWindowsFromGroups(shown["acct-1"]!).some((w) => w.label?.startsWith("Argon")), false);
  assert.equal(seen.length, 1, "an absent group is not an unreadable summary and does not trigger fallback");
});

test("weekly-only Argon evidence rejects malformed, missing, extra, duplicate or disabled buckets", async () => {
  const cases: Record<string, unknown[]> = {
    "missing weekly": [],
    "spent": [argonBucket(0)],
    "negative": [argonBucket(-0.1)],
    "above one": [argonBucket(1.01)],
    "null fraction": [argonBucket(null)],
    "string fraction": [argonBucket("0.4")],
    "nonfinite fraction": [argonBucket(Number.POSITIVE_INFINITY)],
    "NaN fraction": [argonBucket(Number.NaN)],
    "missing fraction": [{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", resetTime: FUTURE }],
    "missing bucket id": [bucket("weekly", 0.4)],
    "wrong bucket id": [{ ...argonBucket(), bucketId: "gemini-weekly" }],
    "wrong window": [{ ...argonBucket(), window: "5h" }],
    "missing window": [{ bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.4, resetTime: FUTURE }],
    "missing reset": [{ ...argonBucket(), resetTime: undefined }],
    "invalid reset": [argonBucket(0.4, "not a date")],
    "nonstring reset": [argonBucket(0.4, NOW + 60_000)],
    "past reset": [argonBucket(0.4, new Date(NOW - 1).toISOString())],
    "reset now": [argonBucket(0.4, new Date(NOW).toISOString())],
    "disabled": [{ ...argonBucket(), disabled: true }],
    "malformed disabled flag": [{ ...argonBucket(), disabled: "false" }],
    "null disabled flag": [{ ...argonBucket(), disabled: null }],
    "duplicate weekly": [argonBucket(), argonBucket()],
    "extra exhausted bucket": [argonBucket(), { ...bucket("5h", 0), bucketId: "argon-5h" }],
    "extra healthy bucket": [argonBucket(), { ...bucket("5h", 1), bucketId: "argon-5h" }],
    "malformed duplicate": [argonBucket(), { ...argonBucket(), remainingFraction: "0" }],
    "malformed extra": [argonBucket(), null],
  };
  for (const [name, buckets] of Object.entries(cases)) {
    const h = harness(withArgon(buckets));
    await h.usage.snapshot();
    assert.equal(h.usage.hasRemainingQuota(h.acct(), ARGON), false, name);
    assert.equal(h.state.calls, 1, `${name}: a display-readable CLI answer must not retry malformed evidence under the IDE UA`);
  }
  const bodies = [
    { groups: [...healthy().groups, { displayName: "Gemini 4 Argon", buckets: "nope" }] },
    { groups: [...healthy().groups, { buckets: [argonBucket()] }] },
    { groups: [...withArgon().groups, { displayName: "Other", buckets: [null] }] },
  ];
  for (const body of bodies) {
    const h = harness(body);
    await h.usage.snapshot();
    assert.equal(h.usage.hasRemainingQuota(h.acct(), ARGON), false, JSON.stringify(body));
  }
});

test("Argon needs exactly one known group; case and surrounding whitespace alone are tolerated", async () => {
  for (const name of ["gemini 4 argon preview", "Gemini Argon", "Gemini Models"]) {
    const h = harness({ groups: [{ ...argonGroup(), displayName: name }] });
    await h.usage.snapshot();
    assert.equal(h.usage.hasRemainingQuota(h.acct(), ARGON), false, name);
  }
  const duplicate = harness({ groups: [...withArgon().groups, { ...argonGroup(), displayName: " gemini 4 ARGON " }] });
  await duplicate.usage.snapshot();
  assert.equal(duplicate.usage.hasRemainingQuota(duplicate.acct(), ARGON), false);
  const normalized = harness({ groups: [{ ...argonGroup(), displayName: " gemini 4 ARGON " }] });
  await normalized.usage.snapshot();
  assert.equal(normalized.usage.hasRemainingQuota(normalized.acct(), ARGON), true);
});

test("unreadable CLI responses fall back to the IDE UA without establishing Argon evidence", async () => {
  for (const failure of ["http", "json", "shape", "network"]) {
    const headers: string[] = [];
    const usage = new GoogleUsage({ credentials: async () => [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj-1" }] } as never, {
      fetch: async (url, init) => {
        assert.ok(url.endsWith(":retrieveUserQuotaSummary"));
        const ua = new Headers(init?.headers).get("user-agent")!;
        headers.push(ua);
        if (ua === antigravityCliUserAgent()) {
          if (failure === "http") return new Response("nope", { status: 403 });
          if (failure === "json") return new Response("not json");
          if (failure === "shape") return Response.json({ nope: true });
          throw new Error("offline");
        }
        // Even an unexpected Argon group under the IDE UA must not become Argon evidence.
        return Response.json(withArgon());
      },
      now: () => NOW,
      warn: () => {},
    });
    const shown = await usage.snapshot();
    assert.deepEqual(headers, [antigravityCliUserAgent(), antigravityUserAgent()], failure);
    assert.equal(shown["acct-1"]?.length, 2, failure);
    const account = { ownerId: "acct-1", projectId: "proj-1" };
    assert.equal(usage.hasRemainingQuota(account, GEMINI), true, failure);
    assert.equal(usage.hasRemainingQuota(account, "claude-sonnet-4-6"), true, failure);
    assert.equal(usage.hasRemainingQuota(account, ARGON), false, failure);
  }
});

test("failed fallback keeps old display numbers but invalidates all quota evidence", async () => {
  for (const failure of ["http", "json", "shape", "network"]) {
    let fail = false;
    let now = NOW;
    let calls = 0;
    const usage = new GoogleUsage({ credentials: async () => [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj-1" }] } as never, {
      fetch: async () => {
        calls++;
        if (!fail) return Response.json(withArgon());
        if (failure === "http") return new Response("nope", { status: 500 });
        if (failure === "json") return new Response("not json");
        if (failure === "shape") return Response.json({ nope: true });
        throw new Error("offline");
      },
      now: () => now,
      ttlMs: 300_000,
      warn: () => {},
    });
    const first = await usage.snapshot();
    const account = { ownerId: "acct-1", projectId: "proj-1" };
    assert.equal(usage.hasRemainingQuota(account, ARGON), true);
    fail = true;
    now += 300_001;
    assert.deepEqual(await usage.snapshot(), first, failure);
    assert.equal(calls, 3, failure);
    assert.equal(usage.hasRemainingQuota(account, ARGON), false, failure);
    assert.equal(usage.hasRemainingQuota(account, GEMINI), false, failure);
  }
});

test("a successful IDE fallback discards prior CLI Argon evidence and its displayed group", async () => {
  let fallback = false;
  let now = NOW;
  const usage = new GoogleUsage({ credentials: async () => [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj-1" }] } as never, {
    fetch: async (_url, init) => fallback && new Headers(init?.headers).get("user-agent") === antigravityCliUserAgent()
      ? new Response("nope", { status: 500 }) : Response.json(fallback ? healthy() : withArgon()),
    now: () => now,
    ttlMs: 300_000,
    warn: () => {},
  });
  await usage.snapshot();
  const account = { ownerId: "acct-1", projectId: "proj-1" };
  assert.equal(usage.hasRemainingQuota(account, ARGON), true);
  fallback = true;
  now += 300_001;
  const shown = await usage.snapshot();
  assert.equal(shown["acct-1"]?.length, 2);
  assert.equal(usage.hasRemainingQuota(account, ARGON), false);
  assert.equal(usage.hasRemainingQuota(account, GEMINI), true);
});

test("Argon evidence expires at the TTL or reset and rejects a backwards clock", async () => {
  const h = harness(withArgon());
  await h.usage.snapshot();
  h.state.now = NOW + 299_999;
  assert.equal(h.usage.hasRemainingQuota(h.acct(), ARGON), true);
  h.state.now = NOW + 300_000;
  assert.equal(h.usage.hasRemainingQuota(h.acct(), ARGON), false);
  h.state.now = NOW - 1;
  assert.equal(h.usage.hasRemainingQuota(h.acct(), ARGON), false);
  const reset = NOW + 60_000;
  const short = harness(withArgon([argonBucket(0.4, new Date(reset).toISOString())]));
  await short.usage.snapshot();
  short.state.now = reset - 1;
  assert.equal(short.usage.hasRemainingQuota(short.acct(), ARGON), true);
  short.state.now = reset;
  assert.equal(short.usage.hasRemainingQuota(short.acct(), ARGON), false);
});

test("Argon evidence is per host, account and project; host merging only changes display", async () => {
  let now = NOW;
  const accounts = [{ ownerId: "acct-1", accessToken: "tok", projectId: "proj-1" }, { ownerId: "acct-2", accessToken: "tok2", projectId: "proj-2" }];
  const usage = new GoogleUsage({ credentials: async () => accounts } as never, {
    baseUrl: "https://daily.test",
    hosts: () => ["https://daily.test", "https://prod.test"],
    fetch: async (url, init) => {
      const accountOne = JSON.parse(init?.body as string).project === "proj-1";
      return Response.json(withArgon([argonBucket(accountOne && url.startsWith("https://daily.test/") ? 0.4 : 0)]));
    },
    now: () => now,
    ttlMs: 300_000,
  });
  const shown = await usage.snapshot();
  const one = { ...accounts[0]! };
  const two = { ...accounts[1]! };
  assert.equal(googleWindowsFromGroups(shown["acct-1"]!).find((w) => w.label === "Argon weekly")?.used_percent, 100);
  assert.equal(usage.hasRemainingQuota(one, ARGON), true, "daily evidence is not replaced by prod's spent display bucket");
  assert.equal(usage.hasRemainingQuota(one, ARGON, "https://prod.test"), false);
  assert.equal(usage.hasRemainingQuota(one, ARGON, "https://unread.test"), false);
  assert.equal(usage.hasRemainingQuota(two, ARGON), false, "another account's quota cannot establish room");
  assert.equal(usage.hasRemainingQuota({ ...one, projectId: "proj-new" }, ARGON), false);
  assert.equal(usage.hasRemainingQuota({ ...one, ownerId: "acct-3" }, ARGON), false);
  accounts.shift();
  now += 300_001;
  await usage.snapshot();
  assert.equal(usage.hasRemainingQuota(one, ARGON), false, "a removed account loses its evidence");
  accounts.push({ ...one, projectId: "proj-new" });
  assert.equal(usage.hasRemainingQuota({ ...one, projectId: "proj-new" }, ARGON), false);
});
