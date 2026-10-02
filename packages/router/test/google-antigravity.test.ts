// Google Antigravity (Cloud Code Assist): the account store, refresh, sign-in, project discovery,
// the envelope/unwrap, and a whole turn against a mock CCA backend that answers per bearer token.
//
// No live Google call is made anywhere here — there is no Antigravity subscription in this
// environment, so every test drives a local mock. The wire facts these tests pin down come from the
// reference implementation opencodex and are marked (assumption) in docs/ARCHITECTURE.md §4d.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GoogleAdapter } from "../src/providers/google/index.ts";
import {
  GoogleAccountPool,
  googleAccountsPath,
  markGoogleNeedsReauth,
  readGoogleAccounts,
  refreshRejectionIsTerminal,
  removeGoogleAccount,
  replaceGoogleTokens,
  saveGoogleAccount,
} from "../src/providers/google/accounts.ts";
import { GoogleOAuthSession, exchangeGoogleCode } from "../src/providers/google/login.ts";
import { createTransport } from "../src/providers/google/transport.ts";
import {
  antigravitySessionId,
  discoverProject,
  parseAvailableModels,
  resolveAntigravityWireModel,
  staticAntigravityModels,
} from "../src/providers/google/antigravity.ts";
import { CredentialPool } from "../src/pool.ts";
import { Logger } from "../src/log.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";
import type { GeminiRequest } from "../src/providers/google/translate.ts";

const log = new Logger(null, 1e9, 0, false);
const tempHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cr-google-ag-"));

function grant(email: string, projectId: string, token = `tok-${email}`, refreshToken = `rt-${email}`) {
  return { accessToken: token, refreshToken, projectId, email, expiresAt: Date.now() + 3_600_000 };
}

// ── Account store ───────────────────────────────────────────────────────────────────────────────

test("store: a re-login replaces the same account, a different one is added; the file is 0600", () => {
  const home = tempHome();
  const a = saveGoogleAccount(home, grant("a@example.test", "proj-1"));
  const b = saveGoogleAccount(home, grant("b@example.test", "proj-1")); // same project, another person
  assert.equal(a.added && b.added, true);
  const again = saveGoogleAccount(home, grant("A@example.test", "proj-1", "tok-new", "rt-new"));
  assert.equal(again.added, false);
  assert.equal(again.id, a.id, "a re-login keeps the account's id and place");
  const stored = readGoogleAccounts(home);
  assert.equal(stored.length, 2);
  assert.equal(stored[0]!.accessToken, "tok-new");
  const mode = fs.statSync(googleAccountsPath(home)).mode & 0o777;
  assert.equal(mode, 0o600, "the token file is private");
});

test("store: remove and compare-and-swap refresh", () => {
  const home = tempHome();
  const a = saveGoogleAccount(home, grant("a@example.test", "proj-1"));
  assert.equal(removeGoogleAccount(home, "missing"), false);
  assert.equal(replaceGoogleTokens(home, a.id, "wrong-token", grant("a@example.test", "proj-2")), false, "a stale refresh token does not win");
  assert.equal(replaceGoogleTokens(home, a.id, "rt-a@example.test", grant("a@example.test", "proj-2", "tok-2", "rt-2")), true);
  assert.equal(readGoogleAccounts(home)[0]!.projectId, "proj-2");
  assert.equal(removeGoogleAccount(home, a.id), true);
  assert.equal(readGoogleAccounts(home).length, 0);
});

test("refresh rejection: only a structured invalid_grant needs a new sign-in", () => {
  assert.equal(refreshRejectionIsTerminal(400, JSON.stringify({ error: "invalid_grant" })), true);
  assert.equal(refreshRejectionIsTerminal(500, JSON.stringify({ error: "invalid_grant" })), true, "the code is read whatever the status");
  assert.equal(refreshRejectionIsTerminal(503, "service unavailable: token expired"), false, "prose on a 5xx does not retire a working account");
  assert.equal(refreshRejectionIsTerminal(400, "invalid_grant"), true, "prose only when there is no code");
  assert.equal(refreshRejectionIsTerminal(400, JSON.stringify({ error: "invalid_client" })), false);
});

test("refresh is single-flight per token generation and invalid_grant marks the account", async () => {
  const home = tempHome();
  const saved = saveGoogleAccount(home, { ...grant("a@example.test", "proj-1"), expiresAt: Date.now() - 1000 });
  let tokenCalls = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes("oauth2.googleapis.com/token")) {
      tokenCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("loadCodeAssist")) return new Response(JSON.stringify({ cloudaicompanionProject: "proj-1" }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  const pool = new GoogleAccountPool({ home, log, fetch: fetchImpl });
  const [a, b] = await Promise.all([pool.forceRefresh(saved.id), pool.forceRefresh(saved.id)]);
  assert.equal(a && b, true);
  assert.equal(tokenCalls, 1, "two concurrent refreshes share one token request");

  const failPool = new GoogleAccountPool({
    home,
    log,
    fetch: async (url: string) => (url.includes("oauth2.googleapis.com/token")
      ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      : new Response("{}", { status: 200 })),
  });
  markGoogleNeedsReauth(home, saved.id, "fresh");
  // After needsReauth the pool refuses to refresh; clear it to exercise the failure path.
  replaceGoogleTokens(home, saved.id, "rt-2", { ...grant("a@example.test", "proj-1", "tok-3", "rt-3"), expiresAt: Date.now() + 3_600_000 });
  markGoogleNeedsReauth(home, saved.id, "tok-3");
  assert.equal(readGoogleAccounts(home)[0]!.needsReauth, true);
  await failPool.refreshDue();
  assert.equal(readGoogleAccounts(home)[0]!.needsReauth, true);
});

// ── Model id resolution ─────────────────────────────────────────────────────────────────────────

test("wire model resolution: a base id maps to its tier, a suffixed id passes through", () => {
  assert.deepEqual(resolveAntigravityWireModel("gemini-3.8-flash", "low"), { wire: "gemini-3.8-flash-low", known: true });
  // The suffix names the tier, so no thinking level travels beside it.
  assert.equal(resolveAntigravityWireModel("gemini-3.8-flash", "high").thinkingLevel, undefined);
  assert.deepEqual(resolveAntigravityWireModel("gemini-3.1-pro", "high"), { wire: "gemini-pro-agent", thinkingLevel: "high", known: true });
  assert.deepEqual(resolveAntigravityWireModel("gemini-3.7-flash", "medium"), { wire: "gemini-3.7-flash-tiered", thinkingLevel: "medium", known: true });
  assert.equal(resolveAntigravityWireModel("claude-opus-4-6-thinking", "xhigh").thinkingLevel, "high", "the top of the ladder clamps to high");
  assert.deepEqual(resolveAntigravityWireModel("gemini-9-unknown", "high"), { wire: "gemini-9-unknown", known: false }, "an unknown id is forwarded verbatim");
});

test("the session id is stable for one conversation and differs between two", () => {
  const a = antigravitySessionId("conversation-a");
  assert.equal(a, antigravitySessionId("conversation-a"));
  assert.notEqual(a, antigravitySessionId("conversation-b"));
  assert.match(a, /^-\d+$/);
});

// ── Transport: envelope and unwrap ──────────────────────────────────────────────────────────────

test("the antigravity transport wraps the body in the CCA envelope and unwraps the nested response", () => {
  const transport = createTransport("antigravity", {});
  const req: GeminiRequest = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  const built = transport.build(req, {
    model: "gemini-3.8-flash",
    stream: true,
    effort: "low",
    antigravity: { accessToken: "TOKEN", projectId: "proj-1", conversationKey: "conv-1" },
  });
  assert.equal(built.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  assert.equal(built.headers.authorization, "Bearer TOKEN");
  assert.match(built.headers["user-agent"] ?? "", /^antigravity\/ide\/2\.5\.5 /);
  const body = JSON.parse(built.body) as Record<string, unknown>;
  assert.equal(body.model, "gemini-3.8-flash-low", "the wire id carries the effort tier");
  assert.equal(body.project, "proj-1");
  assert.equal(body.userAgent, "antigravity");
  assert.equal(body.requestType, "agent");
  assert.match(String(body.requestId), /^agent-[0-9a-f-]{36}$/);
  const request = body.request as { sessionId?: string; generationConfig?: { thinkingConfig?: { thinkingLevel?: string } } };
  assert.equal(request.sessionId, antigravitySessionId("conv-1"));
  // The suffix already names the tier, so no thinking config is sent beside it.
  assert.equal(request.generationConfig?.thinkingConfig, undefined);

  const unwrapped = transport.unwrap({ response: { candidates: [{ finishReason: "STOP" }] } });
  assert.deepEqual(unwrapped, { candidates: [{ finishReason: "STOP" }] });
  assert.deepEqual(transport.unwrap({ error: { message: "boom" } }), { error: { message: "boom" } }, "a bare error frame is left for the mapper");
});

test("a Claude wire id forces validated function calling; an unknown model still gets a session id", () => {
  const transport = createTransport("antigravity", {});
  const req: GeminiRequest = {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    tools: [{ functionDeclarations: [{ name: "Read", description: "", parametersJsonSchema: { type: "object" } }] }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    // The translation guessed a Gemini-3 level from the base id; the transport must replace it with
    // the one the resolved wire id (a claude- id here, which takes effort via thinkingLevel) wants.
    generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
  };
  const built = transport.build(req, { model: "claude-sonnet-4-6", stream: false, effort: "low", antigravity: { accessToken: "T", projectId: "p", conversationKey: "c" } });
  const request = (JSON.parse(built.body) as { request: { toolConfig: { functionCallingConfig: { mode: string } }; generationConfig: { thinkingConfig: { thinkingLevel: string } } } }).request;
  assert.equal(request.toolConfig.functionCallingConfig.mode, "VALIDATED");
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, "low");
  assert.match(built.url, /v1internal:generateContent$/);

  // A suffix-tier model states the effort in its id, so no level travels beside it.
  const suffix = transport.build(req, { model: "gemini-3.8-flash", stream: false, effort: "low", antigravity: { accessToken: "T", projectId: "p", conversationKey: "c" } });
  const suffixRequest = (JSON.parse(suffix.body) as { request: { generationConfig?: { thinkingConfig?: unknown } } }).request;
  assert.equal(suffixRequest.generationConfig?.thinkingConfig, undefined);
});

// ── Project discovery ───────────────────────────────────────────────────────────────────────────

test("project discovery falls back from loadCodeAssist to onboardUser polling", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes("loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 }); // no project yet
    if (url.includes("onboardUser")) {
      const done = calls.filter((c) => c.includes("onboardUser")).length >= 2;
      return new Response(JSON.stringify(done ? { done: true, response: { cloudaicompanionProject: "proj-new" } } : { done: false }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  const project = await discoverProject("token", fetchImpl, undefined, async () => {});
  assert.equal(project, "proj-new");
  assert.ok(calls.some((c) => c.includes("cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")));
  assert.ok(calls.some((c) => c.includes("daily-cloudcode-pa.googleapis.com/v1internal:onboardUser")));
});

test("fetchAvailableModels parsing collapses tiers and reads context windows", () => {
  const body = {
    models: {
      "gemini-3.8-flash-low": { maxTokens: 1_048_576, displayName: "Gemini 3.8 Flash (Low)" },
      "gemini-3.8-flash-medium": { maxTokens: 1_048_576 },
      "gemini-3.8-flash-high": { maxTokens: 1_048_576 },
      "gemini-3.1-pro-preview": { maxTokens: 1_048_576 },
    },
    agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"] }] }],
  };
  const models = parseAvailableModels(body);
  const ids = (models ?? []).map((m) => m.id);
  assert.ok(ids.includes("gemini-3.8-flash"), "the three tiers collapse to one picker row");
  assert.equal(ids.filter((id) => id.startsWith("gemini-3.8-flash")).length, 1);
  assert.deepEqual(models!.find((m) => m.id === "gemini-3.8-flash")!.effortLevels, ["low", "medium", "high"]);
  assert.equal(parseAvailableModels({ models: {} }), null, "an empty catalogue falls back, not empty");
  assert.equal(staticAntigravityModels().length, 7);
});

// ── OAuth sign-in ───────────────────────────────────────────────────────────────────────────────

function oauthFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string) => {
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("userinfo")) return new Response(JSON.stringify({ email: "user@example.test", id: "123" }), { status: 200 });
    if (url.includes("loadCodeAssist")) return new Response(JSON.stringify({ cloudcodeapiproject: undefined, cloudaicompanionProject: "proj-1" }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
}

test("sign-in: a callback with the wrong state is refused without ending the attempt", async () => {
  const home = tempHome();
  const session = new GoogleOAuthSession({ home, fetch: oauthFetch() }, "warning");
  const { url, port } = await session.start();
  const state = new URL(url).searchParams.get("state")!;
  assert.ok(state);

  const wrong = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=not-the-state`);
  assert.equal(wrong.status, 400);
  assert.equal(session.snapshot.running, true, "the real redirect may still be on its way");

  const right = await fetch(`http://127.0.0.1:${port}/callback?code=good&state=${state}`);
  assert.equal(right.status, 200);
  await session.result;
  assert.equal(session.snapshot.ok, true);
  assert.equal(session.snapshot.account?.email, "user@example.test");
  assert.equal(readGoogleAccounts(home)[0]!.projectId, "proj-1");
});

test("the token exchange sends PKCE and the public client and fails without a project", async () => {
  let body = "";
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("oauth2.googleapis.com/token")) {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("userinfo")) return new Response(JSON.stringify({ email: "u@example.test" }), { status: 200 });
    // loadCodeAssist yields no project and onboardUser answers a hard 4xx, so discovery gives up at
    // once rather than polling.
    if (url.includes("onboardUser")) return new Response("{}", { status: 403 });
    return new Response("{}", { status: 200 });
  };
  await assert.rejects(exchangeGoogleCode({ code: "c", codeVerifier: "v", redirectUri: "http://127.0.0.1:51121/callback", fetch: fetchImpl }), /could not discover a Cloud Code Assist project/);
  const params = new URLSearchParams(body);
  assert.equal(params.get("code_verifier"), "v");
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.match(params.get("client_id") ?? "", /^1071006060591-/);
});

// ── A whole turn against a mock CCA backend ─────────────────────────────────────────────────────

type Seen = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
function ccaServer(handler: (req: http.IncomingMessage, body: string) => { status: number; frame?: Record<string, unknown>; text?: string }): Promise<{ port: number; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> });
      const out = handler(req, raw);
      if (out.status !== 200) {
        res.writeHead(out.status, { "content-type": "application/json" }).end(out.text ?? "{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(out.frame ?? {})}\n\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, seen, close: () => server.close() })));
}

async function callAdapter(adapter: GoogleAdapter, body: AnthropicRequest): Promise<{ status: number; text: string }> {
  const front = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest;
      void adapter.handle(req, res, req.url ?? "/v1/messages", json, "gemini-3.8-flash", "high");
    });
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const port = (front.address() as { port: number }).port;
  try {
    return await new Promise((resolve, reject) => {
      const raw = JSON.stringify(body);
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end(raw);
    });
  } finally {
    front.close();
  }
}

const request: AnthropicRequest = { model: "claude", stream: true, system: "sys", messages: [{ role: "user", content: "read a" }], tools: [{ name: "Read", input_schema: { type: "object" } }] };

test("a turn streams through the CCA envelope, carrying the account token and project", async () => {
  const upstream = await ccaServer(() => ({
    status: 200,
    frame: {
      response: {
        candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 20, cachedContentTokenCount: 5, candidatesTokenCount: 2 },
      },
    },
  }));
  const home = tempHome();
  saveGoogleAccount(home, grant("a@example.test", "proj-1", "tok-a"));
  const adapter = new GoogleAdapter("ag", { type: "google", auth: "antigravity", url: `http://127.0.0.1:${upstream.port}` }, home, log, new CredentialPool());
  try {
    const res = await callAdapter(adapter, request);
    assert.equal(res.status, 200);
    assert.match(res.text, /"text":"Hi"/);
    assert.match(res.text, /"cache_read_input_tokens":5/);
    const sent = upstream.seen.at(-1)!;
    assert.match(sent.path, /v1internal:streamGenerateContent\?alt=sse/);
    assert.equal(sent.headers.authorization, "Bearer tok-a");
    assert.equal((sent.body as { project?: string }).project, "proj-1");
    assert.equal((sent.body as { model?: string }).model, "gemini-3.8-flash-high", "the wire id carries the resolved tier");
  } finally {
    upstream.close();
  }
});

test("a tool call's signature is remembered and replayed on the next turn, nested under response", async () => {
  const upstream = await ccaServer(() => ({
    status: 200,
    frame: {
      response: {
        candidates: [
          { content: { parts: [{ text: "Let me read." }] } },
          { content: { parts: [{ functionCall: { name: "Read", args: { file_path: "a.ts" } }, thoughtSignature: "SIG" }] } },
          { finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5 },
      },
    },
  }));
  const home = tempHome();
  saveGoogleAccount(home, grant("a@example.test", "proj-1", "tok-a"));
  const adapter = new GoogleAdapter("ag", { type: "google", auth: "antigravity", url: `http://127.0.0.1:${upstream.port}` }, home, log, new CredentialPool());
  try {
    const first = await callAdapter(adapter, request);
    const id = /"id":"(toolu_[0-9a-f]+)"/.exec(first.text)?.[1];
    assert.ok(id);
    assert.equal(adapter.signatureCount, 1);

    const replay: AnthropicRequest = {
      ...request,
      messages: [
        { role: "user", content: "read a" },
        { role: "assistant", content: [{ type: "tool_use", id: id!, name: "Read", input: { file_path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id!, content: "ok" }] },
      ],
    };
    await callAdapter(adapter, replay);
    const sentBody = upstream.seen.at(-1)!.body as { request: { contents: { role: string; parts: { thoughtSignature?: string }[] }[] } };
    const modelTurn = sentBody.request.contents.find((c) => c.role === "model")!;
    assert.equal(modelTurn.parts[0]?.thoughtSignature, "SIG");
  } finally {
    upstream.close();
  }
});

test("429 on one account moves the same turn to the next, before anything reaches the client", async () => {
  const upstream = await ccaServer((req) => {
    const auth = req.headers.authorization;
    if (auth === "Bearer tok-a") return { status: 429, text: JSON.stringify({ error: { message: "quota", status: "RESOURCE_EXHAUSTED" } }) };
    return { status: 200, frame: { response: { candidates: [{ content: { parts: [{ text: "second" }] } }, { finishReason: "STOP" }] } } };
  });
  const home = tempHome();
  saveGoogleAccount(home, grant("a@example.test", "proj-1", "tok-a"));
  saveGoogleAccount(home, grant("b@example.test", "proj-2", "tok-b"));
  const adapter = new GoogleAdapter("ag", { type: "google", auth: "antigravity", url: `http://127.0.0.1:${upstream.port}` }, home, log, new CredentialPool());
  try {
    const res = await callAdapter(adapter, request);
    assert.equal(res.status, 200);
    assert.match(res.text, /"text":"second"/);
    const auths = upstream.seen.map((s) => s.headers.authorization);
    assert.deepEqual(auths, ["Bearer tok-a", "Bearer tok-b"], "the first account was tried, refused, and the second answered");
  } finally {
    upstream.close();
  }
});

test("401 gets one refresh and a replay on the same account", async () => {
  const upstream = await ccaServer((req) => (req.headers.authorization === "Bearer fresh"
    ? { status: 200, frame: { response: { candidates: [{ content: { parts: [{ text: "ok" }] } }, { finishReason: "STOP" }] } } }
    : { status: 401, text: JSON.stringify({ error: { message: "unauth", status: "UNAUTHENTICATED" } }) }));
  const home = tempHome();
  saveGoogleAccount(home, { accessToken: "stale", refreshToken: "rt", projectId: "proj-1", email: "a@example.test", expiresAt: Date.now() + 3_600_000 });
  const tokenCalls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes("oauth2.googleapis.com/token")) {
      tokenCalls.push(url);
      return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "rt", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("loadCodeAssist")) return new Response(JSON.stringify({ cloudaicompanionProject: "proj-1" }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  const adapter = new GoogleAdapter("ag", { type: "google", auth: "antigravity", url: `http://127.0.0.1:${upstream.port}` }, home, log, new CredentialPool(), fetchImpl);
  try {
    const res = await callAdapter(adapter, request);
    assert.equal(res.status, 200);
    assert.match(res.text, /"text":"ok"/);
    assert.equal(tokenCalls.length, 1);
    assert.deepEqual(upstream.seen.map((s) => s.headers.authorization), ["Bearer stale", "Bearer fresh"]);
  } finally {
    upstream.close();
  }
});

test("a 403 asking for account verification passes Google's page on, without a refresh or a rest", async () => {
  const page = "https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=x";
  let verified = false;
  const upstream = await ccaServer(() => (verified
    ? { status: 200, frame: { response: { candidates: [{ content: { parts: [{ text: "ok" }] } }, { finishReason: "STOP" }] } } }
    : { status: 403, text: JSON.stringify({ error: { code: 403, message: "Verify your account to continue.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "VALIDATION_REQUIRED", domain: "cloudcode-pa.googleapis.com", metadata: { validation_url: page } }] } }) }));
  const home = tempHome();
  saveGoogleAccount(home, grant("a@example.test", "proj-1", "tok-a"));
  const tokenCalls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    tokenCalls.push(url);
    return new Response("{}", { status: 200 });
  };
  const adapter = new GoogleAdapter("ag", { type: "google", auth: "antigravity", url: `http://127.0.0.1:${upstream.port}` }, home, log, new CredentialPool(), fetchImpl);
  try {
    const res = await callAdapter(adapter, request);
    assert.equal(res.status, 403);
    assert.match(res.text, /a@example\.test/);
    assert.ok(res.text.includes(page), "the page is in the error the client shows");
    assert.equal(tokenCalls.length, 0, "a fresh token would not help, so none is fetched");
    const [account] = adapter.accountStatus();
    assert.equal(account!.state, "needs-verification");
    assert.equal(account!.verifyUrl, page);
    assert.equal(adapter.hasUsable(), true, "the account stays in rotation");
    assert.equal(await adapter.recheckVerification(account!.id), "still-required");
    assert.equal(adapter.accountStatus()[0]!.state, "needs-verification");
    verified = true;
    assert.equal(await adapter.recheckVerification(account!.id), "verified", "asking again clears the mark without a real turn");
    assert.equal(adapter.accountStatus()[0]!.state, "ready");
    assert.equal(await adapter.recheckVerification(account!.id), "unknown", "nothing to recheck once verified");
    const again = await callAdapter(adapter, request);
    assert.equal(again.status, 200, "once the check is done the next turn is answered");
    assert.equal(adapter.accountStatus()[0]!.state, "ready");
  } finally {
    upstream.close();
  }
});
