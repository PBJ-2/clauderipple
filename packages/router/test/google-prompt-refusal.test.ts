import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GoogleAdapter, type GoogleOutcome } from "../src/providers/google/index.ts";
import { saveGoogleAccount } from "../src/providers/google/accounts.ts";
import { Logger } from "../src/log.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";
import { isAntigravityPromptRefusal } from "../src/providers/google/prompt-refusal.ts";

// Minimal shapes from the 2026-10-16 live comparison; no captured prompts or credentials.
const sdk = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const refusal = { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } };
const request: AnthropicRequest = {
  model: "gemini-3.8-flash", max_tokens: 64, stream: true,
  system: [{ type: "text", text: "Keep the user's instructions." }, { type: "text", text: sdk }],
  messages: [{ role: "user", content: "Reply OK." }],
};

test("the refusal detector requires the exact observed response and an outbound SDK paragraph", () => {
  const system = { parts: [{ text: `prefix\r\n\r\n${sdk}\r\n\r\nsuffix` }] };
  const body = JSON.stringify(refusal);
  assert.equal(isAntigravityPromptRefusal(system, 429, body, null), true);
  assert.equal(isAntigravityPromptRefusal(system, 429, JSON.stringify({ error: { ...refusal.error, details: [] } }), null), true);
  assert.equal(isAntigravityPromptRefusal(system, 429, body, ""), false);
  for (const status of [200, 400, 401, 403, 500, 503]) assert.equal(isAntigravityPromptRefusal(system, status, body, null), false);
  for (const text of ["not JSON", "null", "[]", "{}", '{"error":null}', '{"error":[]}', JSON.stringify({ error: { ...refusal.error, details: {} } }), JSON.stringify({ error: { ...refusal.error, code: 503 } })]) {
    assert.equal(isAntigravityPromptRefusal(system, 429, text, null), false, text);
  }
  assert.equal(isAntigravityPromptRefusal(undefined, 429, body, null), false);
  assert.equal(isAntigravityPromptRefusal({ parts: [{ text: `Quoted example: ${sdk}` }] }, 429, body, null), false);
});

test("the refusal detector matches the SDK sentence at the start of any line, not inside one", () => {
  const body = JSON.stringify(refusal);
  const matches = (text: string) => isAntigravityPromptRefusal({ parts: [{ text }] }, 429, body, null);
  // The sentence need not be a paragraph of its own: it may head a block whose next line carries more text.
  assert.equal(matches(`${sdk}\nKeep the user's instructions.`), true);
  assert.equal(matches(`Billing header\n${sdk}\nKeep the user's instructions.`), true);
  assert.equal(matches(`Billing header\r\n  ${sdk}  \r\nMore.`), true);
  assert.equal(matches(`${sdk}You are an agent for the user.`), true);
  assert.equal(matches(`${sdk} Extra words.`), true);
  assert.equal(matches(`Quoted example: ${sdk}\nNext line.`), false, "the sentence in the middle of a line is not the SDK block");
  assert.equal(matches(`prefix ${sdk}`), false);
  assert.equal(matches("You are a Claude agent, built on Anthropic's SDK."), false);
  assert.equal(isAntigravityPromptRefusal({ parts: [{ text: "other" }, { text: `x\n${sdk}\ny` }] }, 429, body, null), true, "any system part counts");
});

function quotaSummary(fraction = 0.9) {
  return { groups: [{ displayName: "Gemini Models", buckets: ["5h", "weekly"].map(window => ({
    bucketId: `gemini-${window}`, displayName: window, window,
    remainingFraction: fraction, resetTime: new Date(Date.now() + 3_600_000).toISOString(),
  })) }] };
}

const QUOTA_FAILS = Symbol("quota lookup fails");

async function rig(t: TestContext, apiKey = false, initialQuota: unknown = quotaSummary()) {
  // The quota answer can change after the rig is built, so a test can start with no cached evidence
  // and decide what the first lookup says; `quotaCalls` counts the requests the lookup makes.
  let quota = initialQuota;
  let quotaCalls = 0;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-prompt-refusal-"));
  const seen: { token: string | undefined; body: { request?: { systemInstruction?: unknown } } }[] = [];
  let reply = { status: 429, body: refusal as unknown, retryAfter: undefined as string | undefined };
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ token: req.headers.authorization, body: JSON.parse(body) as typeof seen[number]["body"] });
    res.writeHead(reply.status, { "content-type": "application/json", ...(reply.retryAfter ? { "retry-after": reply.retryAfter } : {}) });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  for (const n of [1, 2]) saveGoogleAccount(home, {
    accessToken: `token-${n}`, projectId: `project-${n}`, email: `user-${n}@example.test`, expiresAt: Date.now() + 3_600_000,
  });
  const adapter = new GoogleAdapter("google", apiKey
    ? { type: "google", auth: "api-key", apiKey: "test-key", url }
    : { type: "google", auth: "antigravity", url }, home, new Logger(null, 1e6, 1, false), undefined,
    async (_url, init) => {
      quotaCalls++;
      if (quota === QUOTA_FAILS) return new Response("unavailable", { status: 500 });
      return Response.json(typeof quota === "function" ? quota(new Headers(init?.headers).get("authorization")) : quota);
    });
  if (initialQuota !== null) await adapter.usageSnapshot();
  quotaCalls = 0;
  let outcome: GoogleOutcome | undefined;
  const front = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    outcome = await adapter.handle(req, res, "/v1/messages", JSON.parse(body) as AnthropicRequest, "gemini-3.8-flash", "low");
    if (outcome.kind === "prompt-incompatible") {
      assert.equal(res.headersSent, false, "only the proxy may commit a prompt refusal");
      assert.equal(res.writableEnded, false);
      assert.equal(outcome.bytes, 0);
      res.writeHead(400, { "content-type": "application/json" }).end(outcome.errorBody);
    }
  });
  await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const server of [front, upstream]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    adapter, seen,
    quotaCalls: () => quotaCalls,
    setQuota: (value: unknown) => { quota = value; },
    setReply: (value: typeof reply) => { reply = value; },
    call: async (body: AnthropicRequest) => {
      const r = await fetch(`http://127.0.0.1:${(front.address() as { port: number }).port}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
      const text = await r.text();
      return { status: r.status, retryAfter: r.headers.get("retry-after"), text, outcome };
    },
  };
}

for (const stream of [true, false]) test(`SDK prompt refusal is non-retryable and rests no account (stream=${stream})`, async t => {
  const r = await rig(t);
  const res = await r.call({ ...request, stream });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.text).error.type, "invalid_request_error");
  assert.match(res.text, /Antigravity.*Claude Agent SDK/);
  assert.match(res.text, /Resource has been exhausted/);
  assert.equal(res.retryAfter, null);
  assert.equal(r.seen.length, 1, "the same rejected prompt must not walk every Google account");
  assert.equal(res.outcome?.exhaustion, undefined);
  assert.equal(res.outcome?.refusal, "prompt-incompatible");
  assert.equal(res.outcome?.upstreamCalled, undefined, "Google was actually called");
  assert.deepEqual(r.adapter.accountStatus().map(a => a.state), ["ready", "ready"]);
  assert.match(JSON.stringify(r.seen[0]!.body.request!.systemInstruction), /Keep the user's instructions/);
  assert.ok(JSON.stringify(r.seen[0]!.body).includes(sdk), "classification must not rewrite the outbound system prompt");

  r.setReply({ status: 200, body: { response: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] } }, retryAfter: undefined });
  const next = await r.call({ ...request, system: "A different client.", stream: false });
  assert.equal(next.status, 200);
  assert.match(next.text, /"text":"OK"/);
  assert.equal(r.seen[1]!.token, r.seen[0]!.token, "a subsequent compatible request can use the same account immediately");
});

for (const evidence of [
  { label: "missing snapshot", quota: null },
  { label: "exhausted quota", quota: quotaSummary(0) },
  { label: "invalid quota", quota: quotaSummary(1.1) },
  { label: "unrelated model family", quota: { groups: [{ ...quotaSummary().groups[0], displayName: "Claude and GPT models" }] } },
  { label: "expired windows", quota: { groups: [{ displayName: "Gemini Models", buckets: quotaSummary().groups[0]!.buckets.map(b => ({ ...b, resetTime: "2020-01-01T00:00:00Z" })) }] } },
]) test(`SDK paragraph retains ordinary 429 handling with ${evidence.label}`, async t => {
  const r = await rig(t, false, evidence.quota);
  const res = await r.call(request);
  assert.equal(res.status, 429);
  assert.equal(res.outcome?.refusal, undefined);
  assert.equal(r.seen.length, 2, "unknown or exhausted quota must still try peer accounts");
  assert.deepEqual(r.adapter.accountStatus().map(a => a.state), ["cooling", "cooling"]);
});

test("stale quota evidence is refreshed once; a failed refresh keeps the SDK request on the ordinary account-rotation path", async t => {
  const r = await rig(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 300_001);
  r.setQuota(QUOTA_FAILS);
  const res = await r.call(request);
  assert.equal(res.status, 429);
  assert.equal(res.outcome?.refusal, undefined);
  assert.equal(r.seen.length, 2);
  assert.equal(r.quotaCalls(), 4, "one lookup (two requests per account: CLI then IDE user agent), not one per attempt");
  assert.deepEqual(r.adapter.accountStatus().map(a => a.state), ["cooling", "cooling"]);
});

test("stale quota evidence that the refresh renews classifies the refusal", async t => {
  const r = await rig(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 300_001);
  const res = await r.call(request);
  assert.equal(res.status, 400);
  assert.equal(res.outcome?.refusal, "prompt-incompatible");
  assert.equal(r.seen.length, 1);
  assert.equal(r.quotaCalls(), 2);
  assert.deepEqual(r.adapter.accountStatus().map(a => a.state), ["ready", "ready"]);
});

// Issue #170: a headless install never polls /api/limits, so no evidence exists when the refusal arrives.
test("refusal shape with no cached evidence fetches the usage snapshot once and classifies the refusal", async t => {
  const r = await rig(t, false, null);
  r.setQuota(quotaSummary());
  const res = await r.call(request);
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.text).error.type, "invalid_request_error");
  assert.equal(res.outcome?.refusal, "prompt-incompatible");
  assert.equal(res.outcome?.exhaustion, undefined);
  assert.equal(r.seen.length, 1, "the rejected prompt must not walk the other account");
  assert.equal(r.quotaCalls(), 2, "one snapshot: one lookup per account");
  assert.deepEqual(r.adapter.accountStatus().map(a => a.state), ["ready", "ready"], "no account is penalised");
  const again = await r.call(request);
  assert.equal(again.status, 400);
  assert.equal(r.quotaCalls(), 2, "the snapshot is TTL-cached; a second refusal does not fetch again");
});

test("refusal shape with no cached evidence and an exhausted snapshot keeps the ordinary rest path", async t => {
  const r = await rig(t, false, null);
  r.setQuota(quotaSummary(0));
  const res = await r.call(request);
  assert.equal(res.status, 429);
  assert.equal(res.outcome?.refusal, undefined);
  assert.equal(r.seen.length, 2);
  assert.equal(r.quotaCalls(), 2, "the snapshot is read once, not once per account attempt");
  assert.deepEqual(r.adapter.accountStatus().map(a => a.state), ["cooling", "cooling"]);
});

test("refusal shape with no cached evidence and a failing snapshot keeps the ordinary rest path", async t => {
  const r = await rig(t, false, null);
  r.setQuota(QUOTA_FAILS);
  const res = await r.call(request);
  assert.equal(res.status, 429);
  assert.equal(res.outcome?.refusal, undefined);
  assert.equal(r.seen.length, 2);
  assert.deepEqual(r.adapter.accountStatus().map(a => a.state), ["cooling", "cooling"]);
});

test("a 429 that is not the refusal shape never fetches the usage snapshot", async t => {
  const r = await rig(t, false, null);
  r.setQuota(quotaSummary());
  r.setReply({ status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You have exhausted your capacity on this model. Your quota will reset after 3h." } }, retryAfter: undefined });
  const withDetails = await r.call(request);
  assert.equal(withDetails.status, 429);
  r.setReply({ status: 429, body: refusal, retryAfter: "120" });
  await r.call(request);
  await r.call({ ...request, system: "A normal assistant." });
  assert.equal(r.quotaCalls(), 0);
});

test("an SDK sentence that is followed by more text on the next line of the same block is still the refusal", async t => {
  const r = await rig(t);
  const res = await r.call({ ...request, system: [{ type: "text", text: `${sdk}\nKeep the user's instructions.` }] });
  assert.equal(res.status, 400);
  assert.equal(res.outcome?.refusal, "prompt-incompatible");
  assert.match(JSON.stringify(r.seen[0]!.body.request!.systemInstruction), /Claude Agent SDK\.\\nKeep the user/);
});

test("another account's positive quota does not excuse the attempted account's exhaustion", async t => {
  const r = await rig(t, false, (token: string) => quotaSummary(token === "Bearer token-1" ? 0 : 0.9));
  const res = await r.call(request);
  assert.equal(res.status, 400, "the second account has evidence for a distinct refusal");
  assert.equal(res.outcome?.kind, "prompt-incompatible");
  assert.deepEqual(r.seen.map(s => s.token), ["Bearer token-1", "Bearer token-2"]);
  assert.deepEqual(r.adapter.accountStatus().map(a => a.state), ["cooling", "ready"]);
});

test("the generic 429 without an SDK system paragraph still cools accounts", async t => {
  const r = await rig(t);
  const res = await r.call({ ...request, system: "A normal assistant.", messages: [{ role: "user", content: sdk }] });
  assert.equal(res.status, 429);
  assert.equal(r.seen.length, 2);
  assert.deepEqual(r.adapter.accountStatus().map(a => a.state), ["cooling", "cooling"]);
});

for (const detail of [
  { label: "quota message", body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You have exhausted your capacity on this model. Your quota will reset after 3h." } }, retryAfter: undefined },
  { label: "quota details", body: { error: { ...refusal.error, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }] } }, retryAfter: undefined },
  { label: "retry info", body: { error: { ...refusal.error, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "120s" }] } }, retryAfter: undefined },
  { label: "retry header", body: refusal, retryAfter: "120" },
]) test(`real quota signals retain rate-limit handling with the SDK paragraph: ${detail.label}`, async t => {
  const r = await rig(t);
  r.setReply({ status: 429, body: detail.body, retryAfter: detail.retryAfter });
  const res = await r.call(request);
  assert.equal(res.status, 429);
  assert.equal(JSON.parse(res.text).error.type, "rate_limit_error");
  assert.equal(res.outcome?.refusal, undefined);
  assert.equal(r.seen.length, 2);
  assert.deepEqual(r.adapter.accountStatus().map(a => a.state), ["cooling", "cooling"]);
});

test("API-key Google requests keep their existing error classification", async t => {
  const r = await rig(t, true);
  const res = await r.call(request);
  assert.equal(res.status, 429);
  assert.equal(res.outcome?.refusal, undefined);
  assert.equal(r.seen.length, 1);
});

test("a different 4xx is not relabelled as SDK prompt refusal", async t => {
  const r = await rig(t);
  r.setReply({ status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Malformed tool schema" } }, retryAfter: undefined });
  const res = await r.call(request);
  assert.equal(res.status, 400);
  assert.match(res.text, /Malformed tool schema/);
  assert.equal(res.outcome?.refusal, undefined);
  assert.equal(r.seen.length, 1);
});
