import { test } from "node:test";
import assert from "node:assert/strict";
import { measureModel, type MeasureDeps, type WireCandidate } from "../src/capabilities.ts";

// The vendor this is built against: one plan, one key, `/models` reporting ids only, and different
// wires answering for different models (OpenCode Go, measured 2026-09-22). These tests stand in for
// a live endpoint so nothing here touches the network.

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Recorded = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function recorder(handler: (url: string, body: Record<string, unknown>) => number): { calls: Recorded[]; fetch: MeasureDeps["fetch"] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ url, body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return jsonResponse(handler(url, body));
    },
  };
}

const BASE = "https://opencode.ai/zen/go/v1";
const wireCandidates: WireCandidate[] = [
  { wire: "responses", url: BASE },
  { wire: "chat", url: BASE },
];

test("a 503 on the first wire and a 200 on the second settles on the second (mimo, measured 2026-09-22)", async () => {
  const { calls, fetch } = recorder((url) => (url.endsWith("/responses") ? 503 : 200));
  const result = await measureModel("mimo-v2.6-pro", wireCandidates, [], { fetch });
  assert.deepEqual(result, { id: "mimo-v2.6-pro", wire: "chat" });
  assert.deepEqual(calls.map((c) => c.url), [`${BASE}/responses`, `${BASE}/chat/completions`]);
});

test("the first wire that answers ends the search: the next candidate is never called", async () => {
  let calls = 0;
  const fetch = async (): Promise<Response> => { calls++; return jsonResponse(200); };
  const result = await measureModel("muse-spark-1.3-contributor", wireCandidates, [], { fetch });
  assert.equal(result.wire, "responses");
  assert.equal(calls, 1, "a working first wire means the others are not tried");
});

test("a 401 stops everything as an auth problem: no wire is guessed and no further candidate is called", async () => {
  const { calls, fetch } = recorder(() => 401);
  const result = await measureModel("m", wireCandidates, ["low", "high"], { fetch });
  assert.equal(result.wire, undefined, "an auth failure says nothing about which wire the model speaks");
  assert.deepEqual(result, { id: "m", error: "auth" });
  assert.equal(calls.length, 1);
});

test("only the effort levels refused with 400 are dropped (mimo: minimal and xhigh, measured 2026-09-22)", async () => {
  const { fetch } = recorder((_url, body) => (body.reasoning_effort === "minimal" || body.reasoning_effort === "xhigh" ? 400 : 200));
  const result = await measureModel("mimo-v2.6-pro", [{ wire: "chat", url: BASE }], ["none", "minimal", "low", "medium", "high", "xhigh"], { fetch });
  assert.equal(result.wire, "chat");
  assert.deepEqual(result.effortLevels, ["none", "low", "medium", "high"]);
});

test("a rate-limited or errored level stays in the ladder: a momentary failure is not a capability answer", async () => {
  const { fetch } = recorder((_url, body) => (body.reasoning_effort === "low" ? 429 : body.reasoning_effort === "high" ? 500 : 200));
  const result = await measureModel("m", [{ wire: "chat", url: BASE }], ["low", "medium", "high"], { fetch });
  assert.deepEqual(result.effortLevels, ["low", "medium", "high"]);
});

test("a dropped connection keeps the level too, rather than reading as unsupported", async () => {
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as { reasoning_effort?: string };
    if (body.reasoning_effort === "medium") throw new Error("socket hang up");
    return jsonResponse(200);
  };
  const result = await measureModel("m", [{ wire: "chat", url: BASE }], ["low", "medium", "high"], { fetch });
  assert.deepEqual(result.effortLevels, ["low", "medium", "high"]);
});

test("an empty ladder skips effort measurement entirely: one request, no effortLevels key", async () => {
  let calls = 0;
  const fetch = async (): Promise<Response> => { calls++; return jsonResponse(200); };
  const result = await measureModel("m", [{ wire: "chat", url: BASE }], [], { fetch });
  assert.deepEqual(result, { id: "m", wire: "chat" });
  assert.equal("effortLevels" in result, false);
  assert.equal(calls, 1, "no effort probe is sent when there is no ladder to measure");
});

test("each wire is asked in the shape the router actually sends, on the path that wire appends", async () => {
  const { calls, fetch } = recorder(() => 200);
  await measureModel("m", [{ wire: "chat", url: BASE }], [], { fetch });
  await measureModel("m", [{ wire: "responses", url: BASE }], [], { fetch });
  await measureModel("m", [{ wire: "anthropic", url: "https://x" }], [], { fetch });
  assert.equal(calls[0]!.url, `${BASE}/chat/completions`);
  assert.equal(calls[1]!.url, `${BASE}/responses`);
  assert.equal(calls[2]!.url, "https://x/v1/messages");
  assert.equal(calls[0]!.body.max_tokens, 1);
  assert.equal(calls[2]!.body.max_tokens, 1);
  // Measured 2026-09-22: Responses rejects a smaller cap with a 400 that names the parameter, which
  // made every model on this wire measure as not serving it. One token is only legal on the others.
  assert.equal(calls[1]!.body.max_output_tokens, 16, "Responses refuses a cap below sixteen");
});

test("effort is carried the way each wire carries it: reasoning_effort, reasoning.effort, output_config.effort", async () => {
  const seen: Record<string, unknown>[] = [];
  const fetch: MeasureDeps["fetch"] = async (url, init) => {
    if (/chat\/completions|\/responses|\/v1\/messages/.test(url)) seen.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return jsonResponse(200);
  };
  await measureModel("m", [{ wire: "chat", url: BASE }], ["low"], { fetch });
  await measureModel("m", [{ wire: "responses", url: BASE }], ["low"], { fetch });
  await measureModel("m", [{ wire: "anthropic", url: "https://x" }], ["low"], { fetch });
  const effortRequests = seen.filter((b) => "reasoning_effort" in b || "reasoning" in b || "output_config" in b);
  assert.equal(effortRequests.length, 3);
  assert.equal(effortRequests[0]!.reasoning_effort, "low");
  assert.deepEqual(effortRequests[1]!.reasoning, { effort: "low" });
  assert.deepEqual(effortRequests[2]!.output_config, { effort: "low" });
});

test("the session header rides every request with a fresh value, and the key moves to the wire's auth convention", async () => {
  const { calls, fetch } = recorder(() => 200);
  await measureModel("m", [{ wire: "anthropic", url: "https://x", authHeader: "x-api-key" }], ["low"], {
    fetch, sessionHeader: "x-opencode-session", headers: { authorization: "Bearer sk-secret" },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers["x-api-key"], "sk-secret");
  assert.equal(calls[0]!.headers.authorization, undefined, "the same key is not sent twice in two conventions");
  for (const call of calls) assert.match(call.headers["x-opencode-session"] ?? "", /^measure-[0-9a-f]{16}$/);
  assert.notEqual(calls[0]!.headers["x-opencode-session"], calls[1]!.headers["x-opencode-session"], "a fresh session value per request");
});

test("when no candidate answers, the failure is reported and no wire is invented", async () => {
  const { fetch } = recorder((url) => (url.endsWith("/responses") ? 503 : 404));
  const result = await measureModel("m", wireCandidates, [], { fetch });
  assert.equal(result.wire, undefined);
  assert.match(result.error ?? "", /^404 /);
});
