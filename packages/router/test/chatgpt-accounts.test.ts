// Several ChatGPT accounts: the store, refresh, and a turn moving between accounts against a fake
// Codex backend that answers per bearer token. Nobody here has three real subscriptions to spend,
// so these tests are what stands behind the rotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ChatGptAdapter, exhaustedForMs, windowName, windowsAtLeast } from "../src/providers/chatgpt/index.ts";
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
import { posixModes } from "../../../test/capabilities.ts";

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
  if (posixModes) assert.equal(fs.statSync(chatgptAccountsPath(home)).mode & 0o777, 0o600);
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

test("exhaustedForMs: a full window with credits left is not out; refused anyway, it rests until the reset", () => {
  const now = 1_000_000;
  const full = { primary: { used_percent: 100, reset_after_seconds: 10 } };
  assert.equal(exhaustedForMs({ rate_limits: full, credits: { has_credits: true, unlimited: false } }, now), undefined);
  assert.equal(exhaustedForMs({ rate_limits: full, credits: { has_credits: false, unlimited: true } }, now), undefined);
  assert.equal(exhaustedForMs({ rate_limits: full, credits: { has_credits: false, unlimited: false } }, now), 10_000);
  assert.equal(exhaustedForMs({ rate_limits: full, credits: { has_credits: true, unlimited: false, overage_limit_reached: true } }, now), 10_000);
  assert.equal(exhaustedForMs({ rate_limits: full, credits: { has_credits: true, unlimited: false } }, now, false), 10_000);
});

test("store: a usage cap is a whole percent 1-99; null clears it; a re-login keeps it", () => {
  const home = tempHome();
  const a = saveChatGptAccount(home, grant("ws-1", "a@example.test"));
  assert.equal(a.usageCap, undefined, "no cap is the default, and the summary says nothing");
  for (const bad of [0, 100, 101, -5, 1.5, Number.NaN]) assert.equal(updateChatGptAccount(home, a.id, { usageCap: bad }), false, `${bad} is not a cap`);
  assert.equal(readChatGptAccounts(home)[0]!.usageCap, undefined);
  assert.equal(updateChatGptAccount(home, a.id, { usageCap: 70 }), true);
  assert.equal(readChatGptAccounts(home)[0]!.usageCap, 70);
  assert.equal(updateChatGptAccount(home, a.id, { paused: true }), true);
  assert.equal(readChatGptAccounts(home)[0]!.usageCap, 70, "another change leaves the cap alone");
  saveChatGptAccount(home, grant("ws-1", "a@example.test", "tok-new", "rt-new"));
  assert.equal(readChatGptAccounts(home)[0]!.usageCap, 70, "signing in again keeps the cap");
  const pool = new ChatGptAccountPool({ home, mode: "own", log });
  updateChatGptAccount(home, a.id, { paused: false });
  assert.equal("usageCap" in pool.peekCredentials()[0]!, false, "a credential does not carry the cap: a turn that outlives a change would judge by the old one");
  assert.equal(pool.summaries()[0]!.usageCap, 70);
  assert.equal(updateChatGptAccount(home, a.id, { usageCap: null }), true);
  assert.equal(readChatGptAccounts(home)[0]!.usageCap, undefined);
  assert.equal("usageCap" in pool.summaries()[0]!, false);
});

test("exhaustedForMs: under a cap a window is used up at the cap, and credits do not keep the account usable", () => {
  const now = 1_000_000;
  const at = (weekly: number) => ({ rate_limits: { primary: { used_percent: 20, reset_after_seconds: 10 }, secondary: { used_percent: weekly, reset_after_seconds: 3 * 86_400 } } });
  assert.equal(exhaustedForMs(at(70), now, true, 70), 3 * 86_400_000, "70% at a 70% cap is spent until the weekly reset");
  assert.equal(exhaustedForMs(at(69), now, true, 70), undefined);
  assert.equal(exhaustedForMs(at(70), now), undefined, "no cap: exactly as before");
  assert.equal(exhaustedForMs(at(99), now, true, undefined), undefined);
  assert.equal(exhaustedForMs({ rate_limits: { primary: { used_percent: 75, reset_after_seconds: 600 }, secondary: { used_percent: 80, reset_after_seconds: 7200 } } }, now, true, 70), 7_200_000, "the window that frees last decides");
  const credits = { has_credits: true, unlimited: false };
  assert.equal(exhaustedForMs({ ...at(100), credits }, now), undefined, "no cap: credits carry a full window, as before");
  assert.equal(exhaustedForMs({ ...at(100), credits }, now, true, 70), 3 * 86_400_000, "under a cap credits do not");
  assert.equal(exhaustedForMs({ ...at(80), credits: { has_credits: false, unlimited: true } }, now, true, 70), 3 * 86_400_000);
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

type Behaviour = { status: number; headers?: Record<string, string>; body?: string; /** Runs when the request reaches the backend, before it answers: the owner acting while the turn is in flight. */ before?: () => void };
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
    next?.before?.();
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

type Rig = { home: string; ids: string[]; refreshes: string[]; logFile: string; pool: CredentialPool; tokenEndpoint: (url: string, init?: RequestInit) => Promise<Response>; now: (() => number) | undefined };
function rig(count: number, tokenFor: (i: number) => string = (i) => `tok-${i}`, opts: { now?: () => number; caps?: Record<number, number> } = {}): Rig {
  const home = tempHome();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(saveChatGptAccount(home, { ...grant(`ws-${i}`, `u${i}@example.test`), accessToken: tokenFor(i), refreshToken: `rt-${i}` }).id);
  for (const [i, cap] of Object.entries(opts.caps ?? {})) updateChatGptAccount(home, ids[Number(i)]!, { usageCap: cap });
  const logFile = path.join(home, "router.log");
  const refreshes: string[] = [];
  const tokenEndpoint = async (_url: string, init?: RequestInit): Promise<Response> => {
    const rt = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
    refreshes.push(rt);
    return new Response(JSON.stringify({ access_token: `${rt}-fresh`, refresh_token: `${rt}-next`, expires_in: 3600 }), { status: 200 });
  };
  const pool = new CredentialPool(opts.now ? { now: opts.now } : {});
  adapter = new ChatGptAdapter("chatgpt", { type: "chatgpt", auth: "own", url: backendUrl }, home, new Logger(logFile, 1e9, 0, false), pool, tokenEndpoint, opts.now);
  behaviour.clear();
  hits.length = 0;
  return { home, ids, refreshes, logFile, pool, tokenEndpoint, now: opts.now };
}

/** An answered turn that reports these plan windows (weekly = the secondary window) in its headers. */
const reading = (used: { fiveHour?: number; weekly?: number }, resetAfter = { fiveHour: 3600, weekly: 3 * 86_400 }, credits?: boolean): Behaviour => ({
  status: 200,
  headers: {
    "x-codex-primary-used-percent": String(used.fiveHour ?? 10), "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": String(resetAfter.fiveHour),
    "x-codex-secondary-used-percent": String(used.weekly ?? 10), "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-after-seconds": String(resetAfter.weekly),
    ...(credits ? { "x-codex-credits-has-credits": "True", "x-codex-credits-unlimited": "False", "x-codex-credits-balance": "12" } : {}),
  },
});

const capLines = (file: string): string[] => fs.readFileSync(file, "utf8").split("\n").filter((line) => line.includes("(cap "));

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

// Review finding (2026-09-24): a 403 whose text mentions a token ("per-minute token limit") read as a
// credential refusal, and after one refresh each account was marked for sign-in — one turn could
// sign the whole pool out. Only a 401 on a fresh token means the account is refused.
test("rotation: a 403 that mentions a token never signs accounts out", async () => {
  const r = rig(2);
  const refusal = { status: 403, body: JSON.stringify({ error: { message: "invalid token budget for this request" } }) };
  behaviour.set("tok-0", refusal);
  behaviour.set("rt-0-fresh", refusal);
  behaviour.set("tok-1", refusal);
  behaviour.set("rt-1-fresh", refusal);
  const res = await call("conv-403");
  assert.equal(res.status, 401, "the client hears an auth-looking 403 as it always did (mapHttpError)");
  assert.deepEqual(readChatGptAccounts(r.home).map((a) => a.needsReauth === true), [false, false]);
});

// Review finding: the cooldown was keyed on the token, so a refresh or re-login brought a spent
// account straight back into rotation for one more failure.
test("rotation: a new token does not bring an account at its limit back early", async () => {
  const r = rig(2);
  behaviour.set("tok-0", usageLimit(3600));
  await call("conv-spent");
  saveChatGptAccount(r.home, { ...grant("ws-0", "u0@example.test"), accessToken: "tok-0-new", refreshToken: "rt-0-new" });
  await call("conv-spent-2");
  assert.equal(hits.at(-1)!.token, "tok-1");
  assert.equal(adapter.accountStatus()[0]!.state, "cooling");
});

// The owner's usage cap: the first account answers once, its reading shows the weekly window at the
// cap, and from then on turns go to the next account until that window resets (days, past the pool's
// six-hour clamp on a rest).
test("usage cap: an account at its cap rests until the window resets, and is not tried again after six hours", async () => {
  let clock = Date.now();
  const r = rig(2, undefined, { now: () => clock, caps: { 0: 70 } });
  behaviour.set("tok-0", reading({ weekly: 72 }));
  assert.equal((await call("conv-a")).status, 200);
  assert.deepEqual(hits.map((h) => h.token), ["tok-0"], "the turn that carried the reading is answered, one request over the cap at most");
  const status = adapter.accountStatus()[0]!;
  assert.equal(status.state, "cooling");
  assert.deepEqual(status.capRest, { window: "weekly", windowMinutes: 10080, used: 72, cap: 70 });
  assert.ok(Math.abs((status.cooldownSeconds ?? 0) - 3 * 86_400) <= 2, "the rest is the window's real reset, not the pool's six hours");
  await call("conv-a", "again");
  await call("conv-b");
  assert.deepEqual(hits.slice(1).map((h) => h.token), ["tok-1", "tok-1"], "the capped account is skipped, and the held conversation moves");
  const lines = capLines(r.logFile);
  assert.equal(lines.length, 1, "one line for the transition, not one per answer");
  assert.match(lines[0]!, /chatgpt chatgpt: account [0-9a-f]{8} at 72% of weekly \(cap 70%\); resting until \d{4}-\d\d-\d\dT[\d:.]+Z, next account$/);
  assert.equal(/@|tok-|rt-/.test(lines[0]!), false, "no email or token in the line");
  clock += 7 * 3_600_000;
  await call("conv-c");
  await call("conv-d");
  assert.deepEqual(hits.slice(3).map((h) => h.token), ["tok-1", "tok-1"], "six hours on, it is still out: no request is spent to find out");
  assert.equal(adapter.accountStatus()[0]!.state, "cooling");
  clock += 3 * 86_400_000;
  behaviour.set("tok-0", reading({ weekly: 4 }));
  await call("conv-e");
  assert.equal(hits.at(-1)!.token, "tok-0", "the window has reset: back in rotation");
  assert.equal(adapter.accountStatus()[0]!.capRest, undefined);
  assert.equal(adapter.accountStatus()[0]!.state, "ready");
  assert.equal(capLines(r.logFile).length, 1);
});

test("usage cap: without a cap the same reading changes nothing; credits do not carry a capped account", async () => {
  rig(2);
  behaviour.set("tok-0", reading({ weekly: 72 }));
  await call("conv-a");
  await call("conv-b");
  assert.deepEqual(hits.map((h) => h.token), ["tok-0", "tok-0"], "no cap: the account keeps serving at 72%");
  assert.equal(adapter.accountStatus()[0]!.state, "ready");
  assert.equal(adapter.accountStatus()[0]!.capRest, undefined);

  rig(2, undefined, { caps: { 0: 70 } });
  behaviour.set("tok-0", reading({ weekly: 85 }, undefined, true));
  await call("conv-c");
  await call("conv-d");
  assert.deepEqual(hits.map((h) => h.token), ["tok-0", "tok-1"], "credits left, but the owner said stop at 70%");
});

test("usage cap: the five-hour window counts too, and a reading under the cap keeps the account in", async () => {
  const r = rig(2, undefined, { caps: { 0: 50 } });
  behaviour.set("tok-0", reading({ fiveHour: 49, weekly: 49 }));
  await call("conv-a");
  await call("conv-a", "more");
  assert.deepEqual(hits.map((h) => h.token), ["tok-0", "tok-0"]);
  behaviour.set("tok-0", reading({ fiveHour: 55, weekly: 20 }));
  await call("conv-a", "third");
  await call("conv-a", "fourth");
  assert.deepEqual(hits.slice(2).map((h) => h.token), ["tok-0", "tok-1"]);
  assert.match(capLines(r.logFile)[0]!, /at 55% of 5-hour \(cap 50%\)/);
  assert.ok((adapter.accountStatus()[0]!.cooldownSeconds ?? 0) <= 3600);
});

test("usage cap: changing or clearing it takes effect at once; a genuine 429 rest is not cleared with it", async () => {
  const r = rig(2);
  behaviour.set("tok-0", reading({ weekly: 72 }));
  await call("conv-a");
  assert.equal(adapter.accountStatus()[0]!.state, "ready");
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: 70 });
  adapter.usageCapChanged(r.ids[0]!);
  assert.equal(adapter.accountStatus()[0]!.state, "cooling", "lowering the cap rests the account from the reading already held");
  assert.equal(adapter.accountStatus()[0]!.usageCap, 70);
  assert.equal(capLines(r.logFile).length, 1);
  await call("conv-b");
  assert.equal(hits.at(-1)!.token, "tok-1");
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: 90 });
  adapter.usageCapChanged(r.ids[0]!);
  assert.equal(adapter.accountStatus()[0]!.state, "ready", "raising it above the reading brings the account back");
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: 60 });
  adapter.usageCapChanged(r.ids[0]!);
  assert.equal(adapter.accountStatus()[0]!.state, "cooling");
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: null });
  adapter.usageCapChanged(r.ids[0]!);
  assert.equal(adapter.accountStatus()[0]!.state, "ready", "clearing it brings the account back");
  assert.equal(adapter.accountStatus()[0]!.capRest, undefined);

  // A real usage-limit answer is the backend's rest; lifting the cap must leave it standing.
  const s = rig(2, undefined, { caps: { 0: 70 } });
  behaviour.set("tok-0", usageLimit(3600));
  await call("conv-c");
  assert.equal(adapter.accountStatus()[0]!.state, "cooling");
  updateChatGptAccount(s.home, s.ids[0]!, { usageCap: null });
  adapter.usageCapChanged(s.ids[0]!);
  assert.equal(adapter.accountStatus()[0]!.state, "cooling", "still resting: the backend refused it");
  assert.ok((adapter.accountStatus()[0]!.cooldownSeconds ?? 0) > 3000);
});

// ---- Red-team round (#184): the cap as stored now, one hold per account, and what the client is told

/** 09:00 local on a fixed day, so "later today" and "another day" do not depend on when the suite runs. */
const morning = (): number => new Date(2026, 10, 25, 9, 0, 0).getTime();
const stored = (home: string, id: string): number | undefined => readChatGptAccounts(home).find((account) => account.id === id)?.usageCap;

test("usage cap: a turn in flight is judged by the cap as it stands when its answer arrives", async () => {
  // Lowered while the turn runs: the hold the change started is not undone by the older cap's verdict.
  const r = rig(2, undefined, { caps: { 0: 90 } });
  behaviour.set("tok-0", reading({ weekly: 60 }));
  await call("conv-a");
  assert.equal(adapter.accountStatus()[0]!.state, "ready", "60% is under a 90% cap");
  behaviour.set("tok-0", { ...reading({ weekly: 61 }), before: () => { updateChatGptAccount(r.home, r.ids[0]!, { usageCap: 50 }); adapter.usageCapChanged(r.ids[0]!); } });
  await call("conv-a", "again");
  assert.equal(stored(r.home, r.ids[0]!), 50);
  assert.equal(adapter.accountStatus()[0]!.state, "cooling", "the answer that finished after the change does not release it");
  assert.equal(adapter.accountStatus()[0]!.capRest?.cap, 50);

  // Cleared while the turn runs: the answer does not put the old cap back on.
  const s = rig(2, undefined, { caps: { 0: 70 } });
  behaviour.set("tok-0", { ...reading({ weekly: 85 }), before: () => { updateChatGptAccount(s.home, s.ids[0]!, { usageCap: null }); adapter.usageCapChanged(s.ids[0]!); } });
  await call("conv-b");
  assert.equal(adapter.accountStatus()[0]!.state, "ready");
  assert.equal(adapter.accountStatus()[0]!.capRest, undefined);
  await call("conv-b", "more");
  assert.equal(hits.at(-1)!.token, "tok-0", "no cap, so the account keeps serving at 85%");
  assert.equal(capLines(s.logFile).length, 0, "and nothing was logged as a transition");
});

test("usage cap: a hold set by the cap has no 'use now'; a backend refusal keeps its own, and ending it leaves the cap hold", async () => {
  const r = rig(2, undefined, { caps: { 0: 70 } });
  behaviour.set("tok-0", reading({ weekly: 72 }));
  await call("conv-a");
  const held = adapter.accountStatus()[0]!;
  assert.equal(held.state, "cooling");
  assert.ok(held.capRest, "the row says why");
  assert.equal(held.restSeconds, undefined, "nothing the backend refused, so nothing for 'use now' to end");
  assert.ok((held.cooldownSeconds ?? 0) > 0);
  adapter.clearCooldown(r.ids[0]!);
  assert.equal(adapter.accountStatus()[0]!.state, "cooling", "'use now' cannot lift a cap hold; changing the cap does");

  // Refused by the backend as well: that rest keeps its action, and ending it leaves the cap hold.
  const s = rig(2, undefined, { caps: { 0: 70 } });
  behaviour.set("tok-0", usageLimit(3600));
  await call("conv-b");
  const both = adapter.accountStatus()[0]!;
  assert.ok(both.capRest);
  assert.ok((both.restSeconds ?? 0) > 3000, "the genuine rest is there to be ended");
  adapter.clearCooldown(s.ids[0]!);
  const after = adapter.accountStatus()[0]!;
  assert.equal(after.restSeconds, undefined);
  assert.equal(after.state, "cooling");
  assert.ok(after.capRest);

  // No cap at all: exactly the old row.
  rig(2);
  behaviour.set("tok-0", usageLimit(3600));
  await call("conv-c");
  const plain = adapter.accountStatus()[0]!;
  assert.equal(plain.capRest, undefined);
  assert.ok((plain.restSeconds ?? 0) > 3000);
});

test("usage cap: image generation and web search never fall back to an account the cap holds", async () => {
  const r = rig(2, undefined, { caps: { 0: 70, 1: 70 } });
  behaviour.set("tok-0", reading({ weekly: 72 }));
  behaviour.set("tok-1", reading({ weekly: 75 }));
  await call("conv-a");
  await call("conv-b");
  assert.deepEqual(adapter.accountStatus().map((a) => a.state), ["cooling", "cooling"]);
  hits.length = 0;
  await assert.rejects(adapter.generateImage("gpt-6-sol", { prompt: "a fox" }), /usage cap/);
  await assert.rejects(adapter.webSearch("gpt-6-sol").search({ query: "fox" }), /usage cap/);
  assert.equal(hits.length, 0, "no request was spent on a held account");

  // One account held by its cap, the other resting after a refusal: the refused one is the fallback, as it always was.
  const s = rig(2, undefined, { caps: { 0: 70 } });
  behaviour.set("tok-0", reading({ weekly: 72 }));
  behaviour.set("tok-1", usageLimit(3600));
  await call("conv-c");
  await call("conv-d");
  assert.deepEqual(adapter.accountStatus().map((a) => a.state), ["cooling", "cooling"]);
  hits.length = 0;
  await adapter.generateImage("gpt-6-sol", { prompt: "a fox" }).catch(() => undefined);
  assert.deepEqual(hits.map((h) => h.token), ["tok-1"], "the account the cap holds is not the one tried");
  void r; void s;
});

test("usage cap: the hold is the account's, so every provider on it honours it, and it outlives a rebuilt adapter", async () => {
  const clock = morning();
  const r = rig(2, undefined, { now: () => clock, caps: { 0: 70 } });
  const build = (name: string) => new ChatGptAdapter(name, { type: "chatgpt", auth: "own", url: backendUrl }, r.home, new Logger(r.logFile, 1e9, 0, false), r.pool, r.tokenEndpoint, r.now);
  const first = adapter;
  const other = build("chatgpt-b");
  behaviour.set("tok-0", reading({ weekly: 72 }));
  await call("conv-a");
  assert.equal(first.accountStatus()[0]!.state, "cooling");
  assert.equal(other.accountStatus()[0]!.state, "cooling", "the second provider sees the account the first one held");
  assert.ok(other.accountStatus()[0]!.capRest);
  adapter = other;
  await call("conv-b");
  assert.equal(hits.at(-1)!.token, "tok-1", "and does not send its turn there");
  assert.equal(capLines(r.logFile).length, 1, "one transition, one line");

  // A provider edit rebuilds the adapter; the hold is still there, and clearing the cap still lifts it.
  const rebuilt = build("chatgpt");
  adapter = rebuilt;
  assert.equal(rebuilt.accountStatus()[0]!.state, "cooling");
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: null });
  rebuilt.usageCapChanged(r.ids[0]!);
  assert.equal(rebuilt.accountStatus()[0]!.state, "ready");
  assert.equal(other.accountStatus()[0]!.state, "ready", "one release serves every provider");
  assert.equal(first.accountStatus()[0]!.state, "ready");

  // The newest reading survives the rebuild too: a cap set again is judged on it at once.
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: 60 });
  rebuilt.usageCapChanged(r.ids[0]!);
  assert.equal(rebuilt.accountStatus()[0]!.state, "cooling");
  assert.equal(other.accountStatus()[0]!.state, "cooling");
  assert.equal(capLines(r.logFile).length, 2);
});

test("usage cap: a provider on the borrowed Codex login keeps no store, so it never sets or releases a hold, whichever is configured first", async () => {
  const clock = morning();
  const r = rig(2, undefined, { now: () => clock, caps: { 0: 80 } });
  const build = (name: string, auth: "own" | "borrow-codex") => new ChatGptAdapter(name, { type: "chatgpt", auth, url: backendUrl }, r.home, new Logger(r.logFile, 1e9, 0, false), r.pool, r.tokenEndpoint, r.now);
  const own = adapter;
  const codexOnly = build("codex-only", "borrow-codex");
  behaviour.set("tok-0", reading({ weekly: 50 }));
  await call("conv-a");
  assert.equal(own.accountStatus()[0]!.state, "ready", "50% is under the cap of 80");

  // The proxy tells every chatgpt provider, in config order: the Own one first, the Codex-only one after.
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: 40 });
  for (const a of [own, codexOnly]) a.usageCapChanged(r.ids[0]!);
  assert.equal(own.accountStatus()[0]!.state, "cooling", "lowered below the known usage: held");
  assert.ok(own.accountStatus()[0]!.capRest);
  assert.equal(r.pool.heldAccount(r.ids[0]!)?.detail?.cap, 40, "the Codex-only provider did not read its missing record as 'no cap' and release it");

  // The other order, and an unrelated account id: still not its business.
  codexOnly.usageCapChanged(r.ids[0]!);
  codexOnly.usageCapChanged(r.ids[1]!);
  codexOnly.usageCapChanged("codex");
  assert.ok(r.pool.heldAccount(r.ids[0]!), "still held");
  hits.length = 0;
  adapter = own;
  await call("conv-b");
  assert.equal(hits.at(-1)!.token, "tok-1", "and the turn goes to the other account");

  // Clearing the cap, which the store can show, still releases it (through either provider).
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: null });
  for (const a of [codexOnly, own]) a.usageCapChanged(r.ids[0]!);
  assert.equal(r.pool.heldAccount(r.ids[0]!), undefined);
  assert.equal(own.accountStatus()[0]!.state, "ready");
});

test("usage cap: the meter and the cap notice both read the account's newest reading, whichever provider took it", async () => {
  let clock = morning();
  const r = rig(1, undefined, { now: () => clock, caps: { 0: 70 } });
  const build = (name: string) => new ChatGptAdapter(name, { type: "chatgpt", auth: "own", url: backendUrl }, r.home, new Logger(r.logFile, 1e9, 0, false), r.pool, r.tokenEndpoint, r.now);
  const a = adapter;
  const b = build("chatgpt-b");
  const weekly = (status: { quota: Record<string, unknown> | null }): number | undefined =>
    ((status.quota?.rate_limits as { secondary?: { used_percent?: number } } | undefined)?.secondary)?.used_percent;
  behaviour.set("tok-0", reading({ weekly: 40 }));
  adapter = b;
  await call("conv-b");
  clock += 60_000;
  behaviour.set("tok-0", reading({ weekly: 75 }));
  adapter = a;
  await call("conv-a");
  for (const provider of [a, b]) {
    const status = provider.accountStatus()[0]!;
    assert.equal(weekly(status), 75, "B's older 40% is not shown beside A's newer reading");
    assert.equal(status.capRest?.used, 75);
  }
  assert.equal((b.lastRateLimits?.rate_limits as { secondary?: { used_percent?: number } }).secondary?.used_percent, 75, "the single-number reader agrees");

  // And the other way round: the newer reading is B's, and A shows it.
  clock += 60_000;
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: 90 });
  a.usageCapChanged(r.ids[0]!);
  behaviour.set("tok-0", reading({ weekly: 82 }));
  adapter = b;
  await call("conv-b2");
  assert.equal(weekly(a.accountStatus()[0]!), 82);
});

test("usage cap: an account with no cap shows the provider's own reading, as before the cap existed, so one provider's 100% is not another's", async () => {
  let clock = morning();
  const r = rig(1, undefined, { now: () => clock });
  const build = (name: string) => new ChatGptAdapter(name, { type: "chatgpt", auth: "own", url: backendUrl }, r.home, new Logger(r.logFile, 1e9, 0, false), r.pool, r.tokenEndpoint, r.now);
  const a = adapter;
  const b = build("chatgpt-b");
  const weekly = (quota: Record<string, unknown> | null): number | undefined =>
    ((quota?.rate_limits as { secondary?: { used_percent?: number } } | undefined)?.secondary)?.used_percent;
  behaviour.set("tok-0", reading({ weekly: 40 }));
  adapter = a;
  await call("conv-a");
  assert.equal(weekly(a.accountStatus()[0]!.quota), 40);
  assert.equal(b.accountStatus()[0]!.quota, null, "B has read nothing of its own: it shows nothing, not A's reading");
  assert.equal(b.lastRateLimits, null);
  clock += 60_000;
  behaviour.set("tok-0", usageLimit(3600));
  adapter = a;
  await call("conv-a2");
  // A saw the account at its limit; B never asked, so its meter is as it was and its availability is its own pool's call.
  assert.equal(b.accountStatus()[0]!.quota, null, "B's quota stays its own, which the mod-options availability reads");
  assert.equal(exhaustedForMs(b.accountStatus()[0]!.quota, clock, true, b.accountStatus()[0]!.usageCap), undefined);

  // The same account with a cap shares the newest reading (A's), so B follows A and the hold agrees with the meter.
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: 90 });
  b.usageCapChanged(r.ids[0]!);
  const primary = (quota: Record<string, unknown> | null): number | undefined => ((quota?.rate_limits as { primary?: { used_percent?: number } } | undefined)?.primary)?.used_percent;
  assert.equal(primary(b.accountStatus()[0]!.quota), 100, "with a cap the meter and the cap notice agree on the newest reading");
  assert.equal(b.accountStatus()[0]!.capRest?.used, 100);
  // And without it again, B is back to its own, which it has none of.
  updateChatGptAccount(r.home, r.ids[0]!, { usageCap: null });
  assert.equal(b.accountStatus()[0]!.quota, null);
});

test("usage cap: a provider that takes over the borrowed Codex login shows no quota the previous login had", async () => {
  const r = rig(1);
  const login = (id: string) => {
    const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: `ws-${id}` }, "https://api.openai.com/profile": { email: `${id}@example.test` } });
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: token, refresh_token: `rt-${id}`, account_id: `ws-${id}` } }));
    return token;
  };
  const build = (name: string) => new ChatGptAdapter(name, { type: "chatgpt", auth: "borrow-codex", url: backendUrl }, r.home, new Logger(r.logFile, 1e9, 0, false), r.pool, r.tokenEndpoint, r.now);
  try {
    const first = login("one");
    const old = build("codex-a");
    behaviour.set(first, reading({ weekly: 95 }));
    adapter = old;
    await call("conv-codex");
    const shown = (status: { quota: Record<string, unknown> | null }) => ((status.quota?.rate_limits as { secondary?: { used_percent?: number } } | undefined)?.secondary)?.used_percent;
    assert.equal(shown(old.accountStatus().find((a) => a.id === "codex")!), 95);
    // The user signs in to Codex as somebody else and the provider is rebuilt (or a new one added).
    login("two");
    const fresh = build("codex-b");
    assert.equal(fresh.accountStatus().find((a) => a.id === "codex")!.quota, null, "the new login has no reading yet");
    assert.equal(fresh.lastRateLimits, null);
  } finally {
    fs.rmSync(path.join(codexHome, "auth.json"), { force: true });
  }
});

test("usage cap: when every account is held by its cap the answer says so, with the date, and is not retried", async () => {
  const clock = morning();
  rig(2, undefined, { now: () => clock, caps: { 0: 70, 1: 70 } });
  behaviour.set("tok-0", reading({ weekly: 72 }));
  behaviour.set("tok-1", reading({ weekly: 75 }, { fiveHour: 3600, weekly: 2 * 86_400 }));
  await call("conv-a");
  await call("conv-b");
  hits.length = 0;
  const res = await call("conv-c");
  assert.equal(res.status, 429);
  assert.equal(res.headers["x-should-retry"], "false");
  assert.ok(Math.abs(Number(res.headers["retry-after"]) - 2 * 86_400) <= 2, "the wait is the soonest window's reset");
  const message = JSON.parse(res.body).error.message as string;
  assert.match(message, /usage cap/);
  assert.doesNotMatch(message, /at its usage limit/);
  assert.match(message, /usable again on \S+ \d+ at /, "two days out: the date is named");
  assert.equal(hits.length, 0);

  // The same day: the time alone, as before.
  rig(2, undefined, { now: () => clock, caps: { 0: 50, 1: 50 } });
  behaviour.set("tok-0", reading({ fiveHour: 60, weekly: 10 }));
  behaviour.set("tok-1", reading({ fiveHour: 70, weekly: 10 }));
  await call("conv-d");
  await call("conv-e");
  const today = await call("conv-f");
  assert.equal(today.headers["x-should-retry"], "false");
  assert.match(JSON.parse(today.body).error.message, /usage cap set for it\. The first is usable again at \S+/);
  assert.doesNotMatch(JSON.parse(today.body).error.message, / on /);

  // A cap beside a backend refusal: the cap is named too, but the answer is not final: the other
  // account's short rest ends within the hour, so the client keeps main's headers and the wait.
  rig(2, undefined, { now: () => clock, caps: { 0: 70 } });
  behaviour.set("tok-0", reading({ weekly: 72 }));
  behaviour.set("tok-1", usageLimit(3600));
  await call("conv-g");
  await call("conv-h");
  const mixed = await call("conv-i");
  assert.equal(mixed.status, 429);
  assert.equal(mixed.headers["x-should-retry"], undefined, "one account is only on a short backend rest: retrying is right");
  assert.ok(Math.abs(Number(mixed.headers["retry-after"]) - 3600) <= 2, "the wait is that account's rest, not the cap's days");
  assert.match(JSON.parse(mixed.body).error.message, /usage limit or the usage cap/);

  // No cap anywhere: the old words and the old headers, nothing added.
  rig(2, undefined, { now: () => clock });
  behaviour.set("tok-0", usageLimit(600));
  behaviour.set("tok-1", usageLimit(1200));
  await call("conv-j");
  const plain = await call("conv-k");
  assert.equal(plain.status, 429);
  assert.equal(plain.headers["x-should-retry"], undefined);
  assert.match(JSON.parse(plain.body).error.message, /^ChatGPT: every signed-in account is at its usage limit\. The first is usable again at /);
});

test("usage cap: a window is named by its length, so a weekly-only plan's weekly window is 'weekly'", async () => {
  assert.equal(windowName(300, "primary"), "5-hour");
  assert.equal(windowName(10_080, "primary"), "weekly", "weekly-only plans report the weekly window in `primary`");
  assert.equal(windowName(10_080, "secondary"), "weekly");
  assert.equal(windowName(43_200, "primary"), "monthly");
  assert.equal(windowName(1_440, "secondary"), "24-hour");
  assert.equal(windowName(undefined, "primary"), "5-hour", "no length: the slot decides");
  assert.equal(windowName(undefined, "secondary"), "weekly");
  const weeklyOnly = { rate_limits: { primary: { used_percent: 80, window_minutes: 10_080, reset_after_seconds: 86_400 }, secondary: null } };
  assert.deepEqual(windowsAtLeast(weeklyOnly, 70, 0).map((w) => [w.name, w.windowMinutes]), [["weekly", 10_080]]);

  const r = rig(2, undefined, { caps: { 0: 70 } });
  behaviour.set("tok-0", { status: 200, headers: { "x-codex-primary-used-percent": "72", "x-codex-primary-window-minutes": "10080", "x-codex-primary-reset-after-seconds": String(3 * 86_400) } });
  await call("conv-a");
  assert.equal(adapter.accountStatus()[0]!.capRest?.window, "weekly");
  assert.equal(adapter.accountStatus()[0]!.capRest?.windowMinutes, 10_080);
  assert.match(capLines(r.logFile)[0]!, /at 72% of weekly \(cap 70%\)/);
});

test("exhaustedForMs: under a cap a reading whose reset has passed is not over the cap; without a cap nothing changes", () => {
  const now = 10 * 86_400_000;
  const weekly = (at: number | undefined) => ({ ...(at !== undefined ? { at } : {}), rate_limits: { primary: { used_percent: 20, reset_after_seconds: 60 }, secondary: { used_percent: 72, window_minutes: 10_080, reset_after_seconds: 3 * 86_400 } } });
  assert.equal(exhaustedForMs(weekly(now - 86_400_000), now, true, 70), 2 * 86_400_000, "read a day ago: two days are left");
  assert.equal(exhaustedForMs(weekly(now - 4 * 86_400_000), now, true, 70), undefined, "read four days ago: the window has reset since");
  assert.equal(exhaustedForMs(weekly(undefined), now, true, 70), 3 * 86_400_000, "no reading time: taken as just now");
  const absolute = (resetAt: number) => ({ rate_limits: { primary: { used_percent: 72, reset_at: resetAt } } });
  assert.equal(exhaustedForMs(absolute((now - 1000) / 1000), now, true, 70), undefined, "a stated reset time that is past ends it");
  assert.equal(exhaustedForMs(absolute((now + 5000) / 1000), now, true, 70), 5000);
  // Uncapped: a full window is read as it always was, however old the reading.
  const full = { at: now - 9 * 86_400_000, rate_limits: { primary: { used_percent: 100, reset_after_seconds: 3600 } } };
  assert.equal(exhaustedForMs(full, now), 3_600_000);
});

test("pool: a hold is the account's for every provider, and 'clear' leaves it", () => {
  let clock = 1_000_000;
  const pool = new CredentialPool({ now: () => clock });
  const credential = { id: "acct", ownerId: "acct", headers: {} };
  pool.hold("acct", clock + 600_000, { why: "cap" });
  for (const provider of ["a", "b"]) {
    assert.equal(pool.hasUsable(provider, [credential]), false, provider);
    assert.equal(pool.pick(provider, [credential]), null, provider);
    const row = pool.report(provider, [credential])[0]!;
    assert.equal(row.state, "cooling");
    assert.equal(row.holdSeconds, 600);
    assert.equal(row.restSeconds, undefined);
  }
  pool.clear("a", "acct");
  pool.clear("a");
  assert.equal(pool.hasUsable("b", [credential]), false, "clearing a provider's rests does not lift an owner's hold");
  pool.penalise("a", "acct", 429, 120_000);
  const both = pool.report("a", [credential])[0]!;
  assert.equal(both.restSeconds, 120);
  assert.equal(both.holdSeconds, 600);
  assert.equal(both.cooldownSeconds, 600);
  assert.deepEqual(pool.heldAccount("acct")?.detail, { why: "cap" });
  clock += 601_000;
  assert.equal(pool.heldAccount("acct"), undefined, "the time passing ends it");
  assert.equal(pool.hasUsable("b", [credential]), true);
  pool.hold("acct", clock + 1000);
  assert.equal(pool.releaseHold("acct"), true);
  assert.equal(pool.releaseHold("acct"), false);
});

test("cleanup", () => {
  backend.close();
  front.close();
});
