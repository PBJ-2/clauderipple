// Several ChatGPT accounts: the store, refresh, and a turn moving between accounts against a fake
// Codex backend that answers per bearer token. Nobody here has three real subscriptions to spend,
// so these tests are what stands behind the rotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ChatGptAdapter, exhaustedForMs } from "../src/providers/chatgpt/index.ts";
import {
  ChatGptAccountPool,
  chatgptAccountsPath,
  readChatGptAccounts,
  refreshRejectionIsTerminal,
  removeChatGptAccount,
  saveChatGptAccount,
  updateChatGptAccount,
} from "../src/providers/chatgpt/accounts.ts";
import { CredentialPool } from "../src/pool.ts";
import { Logger } from "../src/log.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

const log = new Logger(null, 1e9, 0, false);
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cr-gpt-codex-"));
process.env.CODEX_HOME = codexHome; // no Codex CLI login unless a test writes one

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cr-gpt-accounts-"));
}

function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function grant(accountId: string, email: string, token = `tok-${accountId}-${email}`, refreshToken = `rt-${accountId}-${email}`) {
  return {
    accessToken: token,
    refreshToken,
    idToken: jwt({ email, "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" } }),
    accountId,
    expiresAt: Date.now() + 3_600_000,
  };
}

test("store: distinct accounts are added, the same one signing in again replaces itself", () => {
  const home = tempHome();
  const a = saveChatGptAccount(home, grant("ws-1", "a@example.test"));
  const b = saveChatGptAccount(home, grant("ws-1", "b@example.test")); // same workspace, another person
  const c = saveChatGptAccount(home, grant("ws-2", "a@example.test")); // same person, another workspace
  assert.equal(a.added && b.added && c.added, true);
  assert.equal(readChatGptAccounts(home).length, 3);
  const again = saveChatGptAccount(home, grant("ws-1", "A@example.test", "tok-new", "rt-new"));
  assert.equal(again.added, false);
  assert.equal(again.id, a.id, "a re-login keeps the account's id, label and place");
  const stored = readChatGptAccounts(home);
  assert.equal(stored.length, 3);
  assert.equal(stored[0]!.accessToken, "tok-new");
  assert.equal(stored[0]!.planType, "plus");
  assert.equal(fs.statSync(chatgptAccountsPath(home)).mode & 0o777, 0o600);
});

test("store: the single-login file is one account until the first write, then imported and retired", () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, "chatgpt-auth.json"), JSON.stringify({ accessToken: "old", refreshToken: "old-rt", accountId: "ws-old", expiresAt: Date.now() + 3_600_000, source: "own" }));
  assert.deepEqual(readChatGptAccounts(home).map((a) => a.id), ["legacy"]);
  saveChatGptAccount(home, grant("ws-new", "new@example.test"));
  const ids = readChatGptAccounts(home).map((a) => a.id);
  assert.equal(ids[0], "legacy");
  assert.equal(ids.length, 2);
  assert.equal(fs.existsSync(path.join(home, "chatgpt-auth.json")), false, "no second copy of the refresh token survives");
  assert.equal(removeChatGptAccount(home, "legacy"), true);
  assert.deepEqual(readChatGptAccounts(home).length, 1, "a removed legacy login does not come back");
});

test("store: rename and pause; an unreadable store is never overwritten", () => {
  const home = tempHome();
  const a = saveChatGptAccount(home, grant("ws-1", "a@example.test"));
  assert.equal(updateChatGptAccount(home, a.id, { label: "work", paused: true }), true);
  assert.deepEqual({ label: readChatGptAccounts(home)[0]!.label, paused: readChatGptAccounts(home)[0]!.paused }, { label: "work", paused: true });
  assert.equal(updateChatGptAccount(home, a.id, { paused: false }), true);
  assert.equal(readChatGptAccounts(home)[0]!.paused, undefined);
  fs.writeFileSync(chatgptAccountsPath(home), "{broken");
  assert.throws(() => saveChatGptAccount(home, grant("ws-2", "b@example.test")), /unreadable/);
  assert.equal(fs.readFileSync(chatgptAccountsPath(home), "utf8"), "{broken");
});

test("refresh rejections: only the structured code decides, prose only when there is none", () => {
  assert.equal(refreshRejectionIsTerminal(400, JSON.stringify({ error: "invalid_grant" })), true);
  assert.equal(refreshRejectionIsTerminal(401, JSON.stringify({ error: { code: "refresh_token_reused", message: "x" } })), true);
  assert.equal(refreshRejectionIsTerminal(400, JSON.stringify({ error: { code: "refresh_token_expired" } })), true);
  assert.equal(refreshRejectionIsTerminal(500, JSON.stringify({ error: { code: "server_error", message: "token revoked upstream" } })), false);
  assert.equal(refreshRejectionIsTerminal(503, "upstream revoked connection"), false, "a 5xx never retires an account");
  assert.equal(refreshRejectionIsTerminal(400, "Your refresh token was revoked"), true);
});

test("exhaustedForMs: out until the latest full window resets; not out below 100%", () => {
  const now = 1_000_000;
  assert.equal(exhaustedForMs({ rate_limits: { primary: { used_percent: 99, reset_after_seconds: 10 } } }, now), undefined);
  assert.equal(exhaustedForMs({ rate_limits: { primary: { used_percent: 100, reset_after_seconds: 10 }, secondary: { used_percent: 100, reset_at: (now + 50_000) / 1000 } } }, now), 50_000);
  assert.equal(exhaustedForMs(null, now), undefined);
});

test("pool: a due account refreshes once however many turns ask; a terminal rejection needs sign-in", async () => {
  const home = tempHome();
  saveChatGptAccount(home, { ...grant("ws-1", "a@example.test"), expiresAt: Date.now() + 60_000 });
  let calls = 0;
  const fakeFetch = async (): Promise<Response> => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "rt-rotated", expires_in: 3600 }), { status: 200 });
  };
  const pool = new ChatGptAccountPool({ home, mode: "own", log, fetch: fakeFetch });
  await Promise.all([pool.refreshDue(), pool.refreshDue(), pool.refreshDue()]);
  assert.equal(calls, 1, "single flight");
  assert.equal(readChatGptAccounts(home)[0]!.accessToken, "fresh");
  assert.equal(readChatGptAccounts(home)[0]!.refreshToken, "rt-rotated");

  const home2 = tempHome();
  saveChatGptAccount(home2, { ...grant("ws-1", "a@example.test"), expiresAt: Date.now() + 60_000 });
  const rejecting = new ChatGptAccountPool({ home: home2, mode: "own", log, fetch: async () => new Response(JSON.stringify({ error: { code: "refresh_token_reused" } }), { status: 401 }) });
  await rejecting.refreshDue();
  assert.equal(readChatGptAccounts(home2)[0]!.needsReauth, true);

  const home3 = tempHome();
  saveChatGptAccount(home3, { ...grant("ws-1", "a@example.test"), expiresAt: Date.now() + 60_000 });
  const flaky = new ChatGptAccountPool({ home: home3, mode: "own", log, fetch: async () => new Response("bad gateway", { status: 502 }) });
  await flaky.refreshDue();
  assert.equal(readChatGptAccounts(home3)[0]!.needsReauth, undefined, "a failed network refresh leaves the account alone");
});

test("pool: the Codex CLI login takes part last, unless it is one of ours already", () => {
  const home = tempHome();
  saveChatGptAccount(home, grant("ws-1", "a@example.test"));
  const codexToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "ws-codex" }, "https://api.openai.com/profile": { email: "codex@example.test" } });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: codexToken, refresh_token: "codex-rt", account_id: "ws-codex" } }));
  try {
    const auto = new ChatGptAccountPool({ home, mode: "auto", log });
    assert.deepEqual(auto.peekCredentials().map((c) => c.ownerId).slice(-1), ["codex"]);
    assert.equal(new ChatGptAccountPool({ home, mode: "own", log }).peekCredentials().length, 1);
    saveChatGptAccount(home, { ...grant("ws-codex", "codex@example.test"), accessToken: "ours" });
    assert.equal(auto.peekCredentials().some((c) => c.ownerId === "codex"), false, "the same account is not tried twice");
  } finally {
    fs.rmSync(path.join(codexHome, "auth.json"), { force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Rotation through the adapter

type Behaviour = { status: number; headers?: Record<string, string>; body?: string };
const behaviour = new Map<string, Behaviour | Behaviour[]>();
const hits: { token: string; turnState?: string; conversation?: string }[] = [];
let turn = 0;

const sse = (evs: Record<string, unknown>[]): string => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const answer = sse([
  { type: "response.created", response: { id: "r" } },
  { type: "response.output_item.added", item: { type: "message", id: "m" } },
  { type: "response.output_text.delta", delta: "ok", item_id: "m" },
  { type: "response.output_item.done", item: { type: "message", id: "m" } },
  { type: "response.completed", response: { id: "r", usage: { input_tokens: 10, output_tokens: 1 } } },
]);

const backend = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    hits.push({ token, ...(req.headers["x-codex-turn-state"] ? { turnState: String(req.headers["x-codex-turn-state"]) } : {}), conversation: String(req.headers["session-id"] ?? "") });
    const planned = behaviour.get(token);
    const next = Array.isArray(planned) ? (planned.length > 1 ? planned.shift()! : planned[0]!) : planned;
    if (next && next.status !== 200) {
      res.writeHead(next.status, { "content-type": "application/json", ...(next.headers ?? {}) }).end(next.body ?? JSON.stringify({ error: { message: `status ${next.status}` } }));
      return;
    }
    turn += 1;
    res.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": `ts-${token}-${turn}`, ...(next?.headers ?? {}) }).end(answer);
  });
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", () => r()));
const backendUrl = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;

let adapter: ChatGptAdapter;
const front = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => void adapter.handle(req, res, "/v1/messages", JSON.parse(Buffer.concat(chunks).toString()) as AnthropicRequest, "gpt-6-sol", "high"));
});
await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
const frontPort = (front.address() as { port: number }).port;

/** A turn of `conversation`: the opening message is fixed (it is part of the conversation's key), later turns append. */
function call(conversation: string, text?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const opening = { role: "user" as const, content: `${conversation}: hello` };
  const messages = text ? [opening, { role: "assistant" as const, content: "ok" }, { role: "user" as const, content: text }] : [opening];
  const req: AnthropicRequest = { model: "claude-opus-5", stream: true, metadata: { user_id: conversation }, system: "sys", messages };
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(req);
    const r = http.request({ host: "127.0.0.1", port: frontPort, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    r.on("error", reject);
    r.end(data);
  });
}

type Rig = { home: string; ids: string[]; refreshes: string[] };
function rig(count: number, tokenFor: (i: number) => string = (i) => `tok-${i}`): Rig {
  const home = tempHome();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(saveChatGptAccount(home, { ...grant(`ws-${i}`, `u${i}@example.test`), accessToken: tokenFor(i), refreshToken: `rt-${i}` }).id);
  const refreshes: string[] = [];
  const tokenEndpoint = async (_url: string, init?: RequestInit): Promise<Response> => {
    const rt = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
    refreshes.push(rt);
    return new Response(JSON.stringify({ access_token: `${rt}-fresh`, refresh_token: `${rt}-next`, expires_in: 3600 }), { status: 200 });
  };
  adapter = new ChatGptAdapter("chatgpt", { type: "chatgpt", auth: "own", url: backendUrl }, home, log, new CredentialPool(), tokenEndpoint);
  behaviour.clear();
  hits.length = 0;
  return { home, ids, refreshes };
}

const usageLimit = (resetAfter: number): Behaviour => ({
  status: 429,
  headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": String(resetAfter) },
  body: JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached" } }),
});

test("rotation: an account at its limit hands the same turn to the next, and the conversation stays there", async () => {
  rig(3);
  behaviour.set("tok-0", usageLimit(3600));
  const first = await call("conv-1");
  assert.equal(first.status, 200);
  assert.match(first.body, /"text":"ok"/);
  assert.deepEqual(hits.map((h) => h.token), ["tok-0", "tok-1"], "one client request, answered by the second account");
  await call("conv-1", "again");
  await call("conv-2");
  assert.deepEqual(hits.slice(2).map((h) => h.token), ["tok-1", "tok-1"], "the resting account is skipped; the conversation keeps its account");
  const states = adapter.accountStatus();
  assert.equal(states[0]!.state, "cooling");
  assert.ok((states[0]!.cooldownSeconds ?? 0) > 3000, "rests until the reported reset");
  assert.equal(states[1]!.active, true);
});

test("rotation: every account out → one 429 with retry-after, and nothing more is sent until one is back", async () => {
  rig(2);
  behaviour.set("tok-0", usageLimit(600));
  behaviour.set("tok-1", usageLimit(1200));
  const r = await call("conv-x");
  assert.equal(r.status, 429);
  assert.equal(JSON.parse(r.body).error.type, "rate_limit_error");
  assert.ok(Number(r.headers["retry-after"]) >= 600);
  assert.equal(hits.length, 2);
  const later = await call("conv-y");
  assert.equal(later.status, 429);
  assert.equal(hits.length, 2, "no account is asked while all of them are resting");
  assert.match(JSON.parse(later.body).error.message, /every signed-in account/);
});

test("rotation: a refused token is refreshed once and the turn replayed on the same account", async () => {
  const r = rig(2);
  behaviour.set("tok-0", { status: 401, body: JSON.stringify({ error: { message: "token expired" } }) });
  const res = await call("conv-401");
  assert.equal(res.status, 200);
  assert.deepEqual(r.refreshes, ["rt-0"]);
  assert.deepEqual(hits.map((h) => h.token), ["tok-0", "rt-0-fresh"], "same account, new token; the second account was not needed");
  assert.equal(readChatGptAccounts(r.home)[0]!.accessToken, "rt-0-fresh");
});

test("rotation: refused again after a fresh token → that account needs sign-in, the next one answers", async () => {
  const r = rig(2);
  behaviour.set("tok-0", { status: 401 });
  behaviour.set("rt-0-fresh", { status: 401 });
  const res = await call("conv-dead");
  assert.equal(res.status, 200);
  assert.deepEqual(hits.map((h) => h.token), ["tok-0", "rt-0-fresh", "tok-1"]);
  assert.equal(readChatGptAccounts(r.home)[0]!.needsReauth, true);
  assert.equal(adapter.accountStatus()[0]!.state, "needs-login");
});

test("rotation: a request the backend rejects is not retried on other accounts", async () => {
  rig(2);
  behaviour.set("tok-0", { status: 400, body: JSON.stringify({ error: { message: "bad input" } }) });
  const res = await call("conv-400");
  assert.equal(res.status, 400);
  assert.deepEqual(hits.map((h) => h.token), ["tok-0"]);
});

test("rotation: an answer reporting a full window moves the next turn before it can fail", async () => {
  rig(2);
  behaviour.set("tok-0", { status: 200, headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "900", "x-codex-primary-window-minutes": "300" } });
  assert.equal((await call("conv-full")).status, 200);
  await call("conv-full", "next");
  assert.deepEqual(hits.map((h) => h.token), ["tok-0", "tok-1"]);
});

test("rotation: turn state is per account; a moved conversation does not carry the old account's token", async () => {
  rig(2);
  await call("conv-ts");
  await call("conv-ts", "two");
  assert.equal(hits[1]!.turnState, `ts-tok-0-${turn - 1}`);
  behaviour.set("tok-0", usageLimit(60));
  await call("conv-ts", "three");
  const moved = hits.at(-1)!;
  assert.equal(moved.token, "tok-1");
  assert.equal(moved.turnState, undefined);
});

test("rotation: a paused account is left out; unpaused it is back", async () => {
  const r = rig(2);
  updateChatGptAccount(r.home, r.ids[0]!, { paused: true });
  await call("conv-p");
  assert.equal(hits.at(-1)!.token, "tok-1");
  assert.equal(adapter.accountStatus()[0]!.state, "paused");
  updateChatGptAccount(r.home, r.ids[0]!, { paused: false });
  await call("conv-p2");
  assert.equal(hits.at(-1)!.token, "tok-0");
});

test("rotation: a backend 5xx that outlasts the in-place retries moves to the next account", async () => {
  rig(2);
  behaviour.set("tok-0", { status: 503, body: "unavailable" });
  const res = await call("conv-503");
  assert.equal(res.status, 200);
  assert.equal(hits.at(-1)!.token, "tok-1");
});

test("cleanup", () => {
  backend.close();
  front.close();
});
