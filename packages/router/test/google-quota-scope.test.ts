// Antigravity counts Gemini models and Claude/GPT models as two quota groups (usage.ts, measured
// 2026-10-15). A spent Claude group used to rest the whole account: on 2026-10-23 one 429 for
// claude-opus-5-5-low ("Individual quota reached … Resets in 4h51m") refused every gemini-3.8-flash
// turn with "every signed-in account is at its limit" for five hours while the Gemini group read 0%.
// A 429 now rests only the group of the model that met it.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { antigravityScopeKey, GoogleAdapter, type GoogleOutcome } from "../src/providers/google/index.ts";
import { saveGoogleAccount } from "../src/providers/google/accounts.ts";
import { antigravityQuotaScope } from "../src/providers/google/usage.ts";
import { Logger } from "../src/log.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

// The body Cloud Code Assist sent on 2026-10-23 for claude-opus-5-5-low, shortened only in its message.
const THIRD_PARTY_429 = { error: {
  code: 429, message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h51m35s.", status: "RESOURCE_EXHAUSTED",
  details: [
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED", domain: "cloudcode-pa.googleapis.com",
      metadata: { quotaResetTimeStamp: "2026-10-23T07:31:42Z", uiMessage: "true", model: "claude-opus-5-5-low", quotaResetDelay: "4h51m35.094691562s" } },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17495.094691562s" },
  ],
} };
const OK = { response: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] } };

const ask = (model: string): AnthropicRequest => ({ model, max_tokens: 64, stream: false, system: "sys", messages: [{ role: "user", content: "Reply OK." }] });
const GEMINI = "gemini-3.8-flash";
const OPUS = "claude-opus-5-5-low";

type Reply = { status: number; body: unknown };

/** The groups resting on an account, without the host each rests on (one host in these rigs). */
const groupsOf = (account: { quotaCooldowns?: Record<string, number> } | undefined): string[] => Object.keys(account?.quotaCooldowns ?? {}).map(k => k.split("@")[0]!);
const secondsOf = (account: { quotaCooldowns?: Record<string, number> } | undefined, group: string): number =>
  Object.entries(account?.quotaCooldowns ?? {}).find(([k]) => k.split("@")[0] === group)?.[1] ?? 0;

async function rig(t: TestContext, reply: (seen: { token: string | undefined; model: string }) => Reply, accounts = 1, logger = new Logger(null, 1e6, 1, false)) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-quota-scope-"));
  const seen: { token: string | undefined; model: string }[] = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = { token: req.headers.authorization, model: String((JSON.parse(body) as { model?: unknown }).model ?? "") };
    seen.push(call);
    const r = reply(call);
    res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  for (let n = 1; n <= accounts; n++) saveGoogleAccount(home, {
    accessToken: `token-${n}`, projectId: `project-${n}`, email: `user-${n}@example.test`, expiresAt: Date.now() + 3_600_000,
  });
  const adapter = new GoogleAdapter("google", { type: "google", auth: "antigravity", url }, home, logger);
  const outcomes: GoogleOutcome[] = [];
  const front = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = JSON.parse(body) as AnthropicRequest;
    outcomes.push(await adapter.handle(req, res, "/v1/messages", json, json.model, "low"));
  });
  await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const server of [front, upstream]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = async (model: string) => {
    const r = await fetch(`http://127.0.0.1:${(front.address() as { port: number }).port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ask(model)), signal: AbortSignal.timeout(30_000),
    });
    return { status: r.status, text: await r.text() };
  };
  return { adapter, seen, outcomes, call };
}

test("models map onto the two measured quota groups; anything else has none", () => {
  for (const model of ["gemini-3.8-flash", "gemini-3.8-flash@high", "Gemini-4-Pro", "gemini-4-argonaut", "gemini-4-hydrogenate"]) assert.equal(antigravityQuotaScope(model), "gemini", model);
  for (const model of ["gemini-4-hydrogen", "gemini-4-hydrogen-xhigh", "gemini-4-hydrogen@xhigh"]) assert.equal(antigravityQuotaScope(model), "hydrogen", model);
  for (const model of ["gemini-4-argon", "gemini-4-argon-low", "gemini-4-argon@high"]) assert.equal(antigravityQuotaScope(model), "argon", model);
  for (const model of ["claude-opus-5-5-low", "claude-sonnet-5-5-high", "gpt-oss-120b", "gpt-oss"]) assert.equal(antigravityQuotaScope(model), "3p", model);
  for (const model of ["gpt-6-luna", "gpt-ossify", "deepseek-v4", ""]) assert.equal(antigravityQuotaScope(model), undefined, model);
});

test("a spent Claude group rests only Claude models: Gemini keeps answering on the same account", async t => {
  const r = await rig(t, ({ model }) => model.startsWith("claude-") ? { status: 429, body: THIRD_PARTY_429 } : { status: 200, body: OK });

  const spent = await r.call(OPUS);
  assert.equal(spent.status, 429);
  assert.match(JSON.parse(spent.text).error.message, /Individual quota reached/);
  assert.equal(r.outcomes[0]!.exhaustion, undefined, "a spent group is not the provider's exhaustion");

  // The account stays in rotation, with the group's rest beside it.
  const [account] = r.adapter.accountStatus();
  assert.equal(account!.state, "ready");
  assert.ok(secondsOf(account, "3p") > 17_000, "the group rests until Google's stated reset");
  assert.deepEqual(groupsOf(account), ["3p"]);
  assert.equal(r.adapter.hasUsable(GEMINI), true);
  assert.equal(r.adapter.hasUsable(OPUS), false);
  assert.equal(r.adapter.hasUsable("claude-sonnet-5-5-high"), false, "the whole group, not just the one model");
  assert.equal(r.adapter.hasUsable(), true);

  const gemini = await r.call(GEMINI);
  assert.equal(gemini.status, 200, "not refused with 'every signed-in account is at its limit'");
  assert.match(gemini.text, /"text":"OK"/);
  assert.equal(r.seen.length, 2, "the Gemini turn reached Google");

  const again = await r.call("claude-sonnet-5-5-high");
  assert.equal(again.status, 429);
  assert.match(JSON.parse(again.text).error.message, /the Claude\/GPT quota is spent on every signed-in account; Gemini models still answer\. The first is usable again at/);
  assert.equal(r.seen.length, 2, "nothing sent for the resting group");
  assert.equal(r.outcomes[2]!.exhaustion, undefined);
});

test("with two accounts, a spent group moves the turn to the next account and leaves the first for Gemini", async t => {
  const r = await rig(t, ({ token, model }) => model.startsWith("claude-") && token === "Bearer token-1" ? { status: 429, body: THIRD_PARTY_429 } : { status: 200, body: OK }, 2);
  const opus = await r.call(OPUS);
  assert.equal(opus.status, 200);
  assert.deepEqual(r.seen.map(s => s.token), ["Bearer token-1", "Bearer token-2"]);
  assert.deepEqual(r.adapter.accountStatus().map(a => [a.state, groupsOf(a)]), [["ready", ["3p"]], ["ready", []]]);
  // The conversation stays on the account that answered (its cache), and the first one is still in
  // rotation for Gemini: only its Claude group rests.
  const gemini = await r.call(GEMINI);
  assert.equal(gemini.status, 200);
  assert.equal(r.seen.at(-1)!.token, "Bearer token-2");
  assert.equal(r.adapter.hasUsable(OPUS), true, "the second account still has Claude quota");
});

test("a 429 that does not prove a spent group still rests the whole account", async t => {
  for (const body of [
    { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } },
    { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "x", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }] } },
    { error: { ...THIRD_PARTY_429.error, details: [{ ...THIRD_PARTY_429.error.details[0], metadata: { model: "gemini-3.8-flash" } }] } },
  ]) {
    const r = await rig(t, () => ({ status: 429, body }));
    assert.equal((await r.call(OPUS)).status, 429);
    const [account] = r.adapter.accountStatus();
    assert.equal(account!.state, "cooling", JSON.stringify(body));
    assert.equal(account!.quotaCooldowns, undefined);
    assert.equal(r.adapter.hasUsable(GEMINI), false);
    assert.match(JSON.parse((await r.call(GEMINI)).text).error.message, /every signed-in account is at its limit/);
  }
});

test("a failure that is about the account still rests all of it", async t => {
  const r = await rig(t, () => ({ status: 402, body: { error: { code: 402, message: "Payment required", status: "FAILED_PRECONDITION" } } }));
  assert.ok((await r.call(OPUS)).status >= 400);
  const [account] = r.adapter.accountStatus();
  assert.equal(account!.state, "cooling");
  assert.equal(account!.quotaCooldowns, undefined);
  assert.equal(r.adapter.hasUsable(GEMINI), false);
  assert.equal((await r.call(GEMINI)).status, 429);
  assert.equal(r.seen.length, 1);
});

// Measured 2026-11-06 in router.log.1: Google disabled account 23c72a59 for a Terms of Service
// violation. The 403 carries PERMISSION_DENIED, which the auth heuristic used to read as a stale
// token: the adapter refreshed and replayed, then rested the account a minute and kept it in
// rotation — 73 such 403s and 39 refresh+replays in one night. It is a dead credential.
const TOS_403 = { error: {
  code: 403,
  message: "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.",
  status: "PERMISSION_DENIED",
  details: [{
    "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TOS_VIOLATION", domain: "cloudcode-pa.googleapis.com",
    metadata: { uiMessage: "true", appeal_url: "https://cloudcode-pa.googleapis.com/v1internal:appeal" },
  }],
} };

test("a 403 Terms of Service ban parks the account: no refresh, no replay, not ready", async t => {
  const lines: string[] = [];
  const logger = { info: (line: string) => lines.push(line), warn: (line: string) => lines.push(line) } as unknown as Logger;
  const r = await rig(t, () => ({ status: 403, body: TOS_403 }), 1, logger);

  const refused = await r.call(OPUS);
  assert.equal(refused.status, 401, "the refusal is about the account, not the request");
  const [account] = r.adapter.accountStatus();
  assert.equal(account!.state, "quarantined", "the status screen shows it as not ready");
  assert.equal(account!.cooldownSeconds, undefined, "a ban is not a rest that expires by itself");
  assert.equal(r.adapter.hasUsable(), false);
  assert.equal(r.seen.length, 1, "no replay after a refresh");
  const parked = lines.filter(line => line.includes("TOS_VIOLATION"));
  assert.equal(parked.length, 1, "one warn line names the reason");
  assert.match(parked[0]!, new RegExp(`account ${account!.id.slice(0, 8)}`));
  assert.doesNotMatch(lines.join("\n"), /refreshed after/);

  // The account stays out of rotation: the next turn is refused without reaching Google.
  assert.equal((await r.call(GEMINI)).status, 429);
  assert.equal(r.seen.length, 1);
});

test("clearing an account's cooldown also clears its resting groups", async t => {
  let spent = true;
  const r = await rig(t, ({ model }) => spent && model.startsWith("claude-") ? { status: 429, body: THIRD_PARTY_429 } : { status: 200, body: OK });
  await r.call(OPUS);
  assert.equal(r.adapter.hasUsable(OPUS), false);
  spent = false;
  const [account] = r.adapter.accountStatus();
  r.adapter.clearCooldown(account!.id);
  assert.equal(r.adapter.accountStatus()[0]!.quotaCooldowns, undefined);
  assert.equal((await r.call(OPUS)).status, 200);
});

test("a group spent on one host still answers on the other: each Cloud Code Assist host counts its own quota", async t => {
  // The re-review's repro: a Gemini-group 429 on daily refused a turn for prod with all-resting, unsent.
  const DAILY = "https://daily-cloudcode-pa.googleapis.com";
  const PROD = "https://cloudcode-pa.googleapis.com";
  const dailyCatalogue = { models: { "gemini-3.8-flash-low": { maxTokens: 1_048_576 } }, agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-low"] }] }] };
  const prodCatalogue = { models: { "gemini-3.1-pro-low": { maxTokens: 1_048_576, displayName: "Gemini 3.1 Pro (Low)" } }, agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.1-pro-low"] }] }] };
  const geminiSpent = { error: { ...THIRD_PARTY_429.error, details: [{ ...THIRD_PARTY_429.error.details[0], metadata: { ...THIRD_PARTY_429.error.details[0]!.metadata, model: "gemini-3.8-flash-low" } }, THIRD_PARTY_429.error.details[1]] } };
  const sent: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(":fetchAvailableModels")) return Response.json(url.startsWith(`${DAILY}/`) ? dailyCatalogue : prodCatalogue);
    if (url.includes(":generateContent") || url.includes(":streamGenerateContent")) {
      sent.push(new URL(url).origin);
      return url.startsWith(`${DAILY}/`) ? Response.json(geminiSpent, { status: 429 }) : Response.json(OK);
    }
    return Response.json({});
  }) as typeof fetch;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-quota-hosts-"));
  saveGoogleAccount(home, { accessToken: "token-1", projectId: "project-1", email: "user-1@example.test", expiresAt: Date.now() + 3_600_000 });
  const adapter = new GoogleAdapter("google", { type: "google", auth: "antigravity", models: [{ id: GEMINI }, { id: "gemini-3.1-pro" }] }, home, new Logger(null, 1e6, 1, false));
  const front = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = JSON.parse(body) as AnthropicRequest;
    await adapter.handle(req, res, "/v1/messages", json, json.model, "low");
  });
  await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    globalThis.fetch = original;
    front.closeAllConnections();
    await new Promise<void>(resolve => front.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const call = async (model: string) => {
    const r = await original(`http://127.0.0.1:${(front.address() as { port: number }).port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ask(model)), signal: AbortSignal.timeout(30_000),
    });
    return { status: r.status, text: await r.text() };
  };

  assert.equal((await call(GEMINI)).status, 429);
  assert.deepEqual(sent, [DAILY]);
  const [account] = adapter.accountStatus();
  assert.equal(account!.state, "ready");
  assert.deepEqual(Object.keys(account!.quotaCooldowns ?? {}), [antigravityScopeKey("gemini", DAILY)], "the rest names the host it was met on");
  assert.equal(adapter.quotaScopeOf("gemini-3.1-pro"), antigravityScopeKey("gemini", PROD));
  assert.equal(adapter.hasUsable("gemini-3.1-pro"), true, "prod's Gemini quota is untouched");
  assert.equal(adapter.hasUsable(GEMINI), false);

  const pro = await call("gemini-3.1-pro");
  assert.equal(pro.status, 200, "not refused as all-resting");
  assert.deepEqual(sent, [DAILY, PROD], "the prod turn was sent");

  assert.equal((await call(GEMINI)).status, 429);
  assert.deepEqual(sent, [DAILY, PROD], "nothing sent for the group still resting on daily");
});

// Gemini 4 Argon has a quota of its own (usage.ts antigravityQuotaScope, measured 2026-10-27). No
// spent Argon has been observed yet, so this body is the measured Claude 429 (THIRD_PARTY_429) with
// Argon's wire id in `metadata.model`.
const ARGON_429 = { error: { ...THIRD_PARTY_429.error, details: [
  { ...THIRD_PARTY_429.error.details[0], metadata: { ...THIRD_PARTY_429.error.details[0]!.metadata, model: "gemini-4-argon-low" } },
  THIRD_PARTY_429.error.details[1],
] } };
const ARGON = "gemini-4-argon";

test("a spent Argon rests only Argon: Gemini Flash and Claude keep answering, and the refusal says so", async t => {
  const r = await rig(t, ({ model }) => model.startsWith("gemini-4-argon-") ? { status: 429, body: ARGON_429 } : { status: 200, body: OK });

  const spent = await r.call(ARGON);
  assert.equal(spent.status, 429);
  const [account] = r.adapter.accountStatus();
  assert.equal(account!.state, "ready");
  assert.deepEqual(groupsOf(account), ["argon"]);
  assert.equal(r.adapter.hasUsable(ARGON), false);
  assert.equal(r.adapter.hasUsable(GEMINI), true, "Flash's own quota is not Argon's");
  assert.equal(r.adapter.hasUsable(OPUS), true);

  assert.equal((await r.call(GEMINI)).status, 200);
  assert.equal((await r.call(OPUS)).status, 200);
  const refused = await r.call(ARGON);
  assert.equal(refused.status, 429);
  assert.match(JSON.parse(refused.text).error.message, /the Gemini 4 Argon quota is spent on every signed-in account; other Gemini and Claude\/GPT models still answer/);
  assert.equal(r.seen.filter(s => s.model.startsWith("gemini-4-argon-")).length, 1, "the resting Argon is refused without an upstream call");
});

// Gemini 4 Hydrogen's bucket is not measured (2026-11-13: the summary reports no group for it), so
// it rests in a scope of its own. No spent Hydrogen has been observed: the body is the measured
// Claude 429 with Hydrogen's wire id in `metadata.model`.
test("a spent Hydrogen rests only Hydrogen, and a spent Gemini group leaves Hydrogen answering", async t => {
  const HYDROGEN = "gemini-4-hydrogen";
  const naming = (model: string) => ({ error: { ...ARGON_429.error, details: [{ ...ARGON_429.error.details[0], metadata: { ...ARGON_429.error.details[0]!.metadata, model } }, ARGON_429.error.details[1]] } });
  const r = await rig(t, ({ model }) => model.startsWith("gemini-4-hydrogen-") ? { status: 429, body: naming("gemini-4-hydrogen-medium") } : { status: 200, body: OK });
  assert.equal((await r.call(HYDROGEN)).status, 429);
  assert.deepEqual(groupsOf(r.adapter.accountStatus()[0]), ["hydrogen"]);
  assert.equal(r.adapter.hasUsable(HYDROGEN), false);
  assert.equal(r.adapter.hasUsable(GEMINI), true, "Flash's quota is not known to be Hydrogen's");
  assert.equal(r.adapter.hasUsable(ARGON), true);
  assert.equal((await r.call(GEMINI)).status, 200);
  const refused = await r.call(HYDROGEN);
  assert.match(JSON.parse(refused.text).error.message, /the Gemini 4 Hydrogen quota is spent on every signed-in account/);

  const flash = await rig(t, ({ model }) => model.startsWith("gemini-3.8-flash") ? { status: 429, body: naming("gemini-3.8-flash-low") } : { status: 200, body: OK });
  assert.equal((await flash.call(GEMINI)).status, 429);
  assert.equal(flash.adapter.hasUsable(HYDROGEN), true);
  assert.equal((await flash.call(HYDROGEN)).status, 200);
});

test("a spent Gemini group leaves Argon answering", async t => {
  const FLASH_429 = { error: { ...ARGON_429.error, details: [{ ...ARGON_429.error.details[0], metadata: { ...ARGON_429.error.details[0]!.metadata, model: "gemini-3.8-flash-low" } }, ARGON_429.error.details[1]] } };
  const r = await rig(t, ({ model }) => model.startsWith("gemini-3.8-flash") ? { status: 429, body: FLASH_429 } : { status: 200, body: OK });
  assert.equal((await r.call(GEMINI)).status, 429);
  assert.deepEqual(groupsOf(r.adapter.accountStatus()[0]), ["gemini"]);
  assert.equal(r.adapter.hasUsable(ARGON), true);
  assert.equal((await r.call(ARGON)).status, 200);
});
