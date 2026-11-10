// Quota display changes must preserve the original shared pool and in-turn account failover.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Logger } from "../src/log.ts";
import { ChatGptAdapter } from "../src/providers/chatgpt/index.ts";
import { saveChatGptAccount, updateChatGptAccount } from "../src/providers/chatgpt/accounts.ts";
import type { ChatGptProvider } from "../src/config.ts";

const log = new Logger(null, 1e9, 0, false);
const percent = (quota: unknown): number | undefined => (quota as { rate_limits?: { primary?: { used_percent?: number } } } | null)?.rate_limits?.primary?.used_percent;
const sse = (events: object[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-quota-failover-"));
  const previous = { CLAUDERIPPLE_HOME: process.env.CLAUDERIPPLE_HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDERIPPLE_HOME = home;
  process.env.CODEX_HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const add = (name: string) => saveChatGptAccount(home, {
    accessToken: `token-${name}`, accountId: `workspace-${name}`, expiresAt: Date.now() + 3_600_000,
  });
  const a = add("a");
  const b = add("b");
  const hits: { path: string; token: string | null }[] = [];
  const refused = new Map<string, number>();
  const usage = new Map<string, number>([["Bearer token-a", 21], ["Bearer token-b", 73]]);
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname === "codex.example.test") {
      const token = new Headers(init?.headers).get("authorization");
      hits.push({ path: url.pathname, token });
      const status = refused.get(token ?? "");
      if (status) return Response.json({ error: { type: "usage_limit_reached" } }, { status, headers: { "retry-after": "600" } });
      const used = usage.get(token ?? "") ?? 0;
      if (url.pathname === "/wham/usage") return Response.json({ rate_limit: {
        primary_window: { used_percent: used, limit_window_seconds: 18000, reset_after_seconds: 600 },
        secondary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 1200 },
      } });
      return new Response(sse([
        { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "fixture answer" },
        { type: "response.completed", response: { id: "r", output: [{ type: "message", content: [{ type: "output_text", text: "fixture answer" }] }], usage: { input_tokens: 1, output_tokens: 1 } } },
      ]), { headers: { "content-type": "text/event-stream" } });
    }
    assert.equal(url.hostname, "127.0.0.1", `unexpected external request: ${url}`);
    return nativeFetch(input, init);
  });
  const provider: ChatGptProvider = { type: "chatgpt", auth: "auto", url: "https://codex.example.test", models: [{ id: "gpt-6-sol" }] };
  const adapter = (name = "a", cfg = provider) => new ChatGptAdapter(name, cfg, home, log);
  return { home, a, b, hits, refused, usage, provider, adapter };
}

async function send(adapter: ChatGptAdapter, pin?: string, conversation = "same-thread") {
  const result = await adapter.sendToAnAccount({ conversation, ...(pin ? { accountPin: pin } : {}), path: "/codex/responses", body: "{}", signal: AbortSignal.timeout(5000), headers: () => ({}) });
  if (result.kind === "ok") await result.upstream.text();
  return result;
}

test("an actual account 429 retries the same turn on the second account", async t => {
  const f = fixture(t);
  const adapter = f.adapter();
  f.refused.set("Bearer token-a", 429);
  const result = await send(adapter);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") assert.equal(result.credential.ownerId, f.b.id);
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-a", "Bearer token-b"]);
  assert.equal(adapter.accountStatus().find(row => row.id === f.a.id)?.state, "cooling");
  assert.equal(adapter.accountStatus().find(row => row.active)?.id, f.b.id);
  f.hits.length = 0;
  assert.equal((await send(adapter)).kind, "ok");
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-b"]);
});

test("streaming and non-streaming Messages return one successful answer after account 429", async t => {
  const f = fixture(t);
  f.refused.set("Bearer token-a", 429);
  let adapter = f.adapter();
  const front = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    await adapter.handle(req, res, "/v1/messages", body, "gpt-6-sol", undefined);
  });
  await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));
  t.after(() => front.close());
  for (const stream of [false, true]) {
    adapter = f.adapter();
    f.hits.length = 0;
    const response = await fetch(`http://127.0.0.1:${(front.address() as { port: number }).port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-sol", max_tokens: 32, stream, messages: [{ role: "user", content: "fixture" }] }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /fixture answer/);
    assert.doesNotMatch(text, /usage_limit_reached|"type":"error"/);
    if (stream) assert.match(text, /message_stop/);
    assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-a", "Bearer token-b"]);
  }
});

test("known exhaustion skips even a preferred account and quota follows the fallback", async t => {
  const f = fixture(t);
  updateChatGptAccount(f.home, f.a.id, { preferred: true });
  const adapter = f.adapter();
  f.usage.set("Bearer token-a", 100);
  assert.equal(percent(await adapter.fetchRateLimits()), 73);
  f.hits.length = 0;
  assert.equal((await send(adapter)).kind, "ok");
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-b"]);
  assert.equal(percent(adapter.lastRateLimits), 73);
  assert.equal(percent(adapter.accountStatus().find(row => row.id === f.a.id)?.quota), 100);
  assert.equal(adapter.accountStatus().find(row => row.active)?.id, f.b.id);
});

test("a recovered preferred account does not steal a healthy fallback conversation", async t => {
  const f = fixture(t);
  updateChatGptAccount(f.home, f.a.id, { preferred: true });
  const adapter = f.adapter();
  f.usage.set("Bearer token-a", 100);
  await adapter.fetchRateLimits();
  await send(adapter);
  f.usage.set("Bearer token-a", 30);
  assert.equal(percent(await adapter.fetchRateLimits()), 73);
  f.hits.length = 0;
  await send(adapter);
  await send(adapter, undefined, "new-thread");
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-b", "Bearer token-a"]);
});

test("providers share the auth-mode-eligible accounts instead of binding their labels", async t => {
  const f = fixture(t);
  const one = f.adapter("one");
  const two = f.adapter("two");
  assert.deepEqual(one.accountStatus().map(row => row.id), [f.a.id, f.b.id]);
  assert.deepEqual(two.accountStatus().map(row => row.id), [f.a.id, f.b.id]);
  updateChatGptAccount(f.home, f.b.id, { preferred: true });
  await send(one);
  await send(two);
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-b", "Bearer token-b"]);
});

test("a leftover account field from the former patch cannot restrict automatic failover", async t => {
  const f = fixture(t);
  const adapter = f.adapter("a", { ...f.provider, ...{ account: f.a.id } });
  f.refused.set("Bearer token-a", 429);
  assert.equal((await send(adapter)).kind, "ok");
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-a", "Bearer token-b"]);
  assert.deepEqual(adapter.accountStatus().map(row => row.id), [f.a.id, f.b.id]);
});

test("existing worker pins precede the global preference and still allow failover", async t => {
  const f = fixture(t);
  updateChatGptAccount(f.home, f.b.id, { preferred: true });
  const adapter = f.adapter();
  await send(adapter, f.a.id.slice(0, 8));
  f.refused.set("Bearer token-a", 429);
  await send(adapter, f.a.id.slice(0, 8));
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-a", "Bearer token-a", "Bearer token-b"]);
});

test("both exhausted accounts return an error and later turns do not retry them", async t => {
  const f = fixture(t);
  const adapter = f.adapter();
  f.refused.set("Bearer token-a", 429);
  f.refused.set("Bearer token-b", 429);
  const refused = await send(adapter);
  assert.equal(refused.kind, "refused");
  if (refused.kind === "refused") assert.equal(refused.status, 429);
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-a", "Bearer token-b"]);
  assert.equal((await send(adapter)).kind, "all-resting");
  assert.equal(f.hits.length, 2);
  assert.equal(adapter.hasUsable(), false);
});
