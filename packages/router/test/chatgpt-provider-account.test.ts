// Provider bindings are local account permissions, stronger than affinity or a worker's pin.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startAdmin } from "../src/admin.ts";
import { generatedAgents, syncAgentFiles } from "../src/agents.ts";
import { CertStore } from "../src/certs.ts";
import { DEFAULTS, validate, type Config, type ChatGptProvider } from "../src/config.ts";
import { UpstreamHealth, providerExhaustion } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { storedAccountsFor, storedAccountsSignature } from "../src/pinned-accounts.ts";
import { CredentialPool } from "../src/pool.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { ChatGptAdapter } from "../src/providers/chatgpt/index.ts";
import { ChatGptAccountPool, markChatGptNeedsReauth, readChatGptAccounts, removeChatGptAccount, saveChatGptAccount, updateChatGptAccount } from "../src/providers/chatgpt/accounts.ts";

const log = new Logger(null, 1e9, 0, false);
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const grant = (suffix: string, expiresAt = Date.now() + 3_600_000) => ({
  accessToken: `token-${suffix}`, refreshToken: `refresh-${suffix}`, accountId: "shared-workspace",
  idToken: jwt({ email: `${suffix}@example.test` }), expiresAt,
});
const percent = (quota: unknown): number | undefined => (quota as { rate_limits?: { primary?: { used_percent?: number } } } | null)?.rate_limits?.primary?.used_percent;
const sse = (events: object[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-provider-account-"));
  const previous = { CLAUDERIPPLE_HOME: process.env.CLAUDERIPPLE_HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_SETTINGS_PATH: process.env.CLAUDE_SETTINGS_PATH };
  process.env.CLAUDERIPPLE_HOME = home;
  process.env.CODEX_HOME = home;
  process.env.CLAUDE_SETTINGS_PATH = path.join(home, "settings.json");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const a = saveChatGptAccount(home, grant("a"));
  const b = saveChatGptAccount(home, grant("b"));
  const hits: { path: string; token: string | null; workspace: string | null }[] = [];
  const refreshes: string[] = [];
  const refused = new Map<string, number>();
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname === "registry.npmjs.org") return Response.json({ version: "1.0.0" });
    if (url.hostname === "auth.openai.com") {
      const token = new URLSearchParams(String(init?.body)).get("refresh_token")!;
      refreshes.push(token);
      return Response.json({ access_token: `${token}-fresh`, refresh_token: `${token}-next`, expires_in: 3600 });
    }
    if (url.pathname.startsWith("/codex/") || url.pathname === "/wham/usage") {
      const headers = new Headers(init?.headers);
      const token = headers.get("authorization");
      hits.push({ path: url.pathname, token, workspace: headers.get("chatgpt-account-id") });
      const status = refused.get(token ?? "");
      if (status) return Response.json({ error: { type: status === 429 ? "usage_limit_reached" : "unauthorized" } }, { status, headers: { "retry-after": "600" } });
      const used = token?.includes("-b") ? 73 : 21;
      if (url.pathname === "/wham/usage") return Response.json({ rate_limit: {
        primary_window: { used_percent: used, limit_window_seconds: 18000, reset_after_seconds: 600 },
        secondary_window: { used_percent: used + 1, limit_window_seconds: 604800, reset_after_seconds: 1200 },
      } });
      if (url.pathname === "/codex/models") return Response.json({ models: [{ slug: `model-${used}`, visibility: "list" }] });
      const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: { type: string }[] };
      const image = body.tools?.some(tool => tool.type === "image_generation");
      return new Response(sse([
        { type: "response.output_item.done", item: image ? { type: "image_generation_call", result: "aW1hZ2U=", output_format: "png" } : { type: "message", content: [] } },
        { type: "response.output_text.annotation.added", annotation: { type: "url_citation", title: "Fixture", url: "https://example.test/fixture" } },
        { type: "response.completed", response: { id: "r", tool_usage: { web_search: { num_requests: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } } },
      ]), { headers: { "content-type": "text/event-stream" } });
    }
    assert.equal(url.hostname, "127.0.0.1", `unexpected external request: ${url}`);
    return nativeFetch(input, init);
  });
  const provider = (account?: string): ChatGptProvider => ({ type: "chatgpt", auth: "auto", url: "https://codex.example.test", models: [{ id: "gpt-6-sol" }], ...(account === undefined ? {} : { account }) });
  const cfg: Config = { ...DEFAULTS, admin: { port: 0 }, providers: { a: provider(a.id), b: provider(b.id) }, routes: {}, direct: [], aliases: {} };
  const makeAdapter = (account?: string, name = "a", pool = new CredentialPool()) => new ChatGptAdapter(name, provider(account), home, log, pool);
  return { home, a, b, hits, refreshes, refused, provider, cfg, makeAdapter };
}

async function send(adapter: ChatGptAdapter, pin?: string) {
  const result = await adapter.sendToAnAccount({ conversation: "same-thread", ...(pin ? { accountPin: pin } : {}), path: "/codex/responses", body: "{}", signal: AbortSignal.timeout(5000), headers: () => ({}) });
  if (result.kind === "ok") await result.upstream.text();
  return result;
}

function makeProxy(f: ReturnType<typeof fixture>) {
  return new Proxy({ config: () => f.cfg, home: f.home, log, certs: new CertStore(f.home), health: new UpstreamHealth(() => 100, () => {}), requests: new RequestLog(path.join(f.home, "requests.jsonl")) });
}

test("two bound providers have separate credentials, quota, catalogue, search and image calls", async t => {
  const f = fixture(t);
  const a = f.makeAdapter(f.a.id);
  const b = f.makeAdapter(f.b.id, "b");
  for (const [adapter, id, token, used] of [[a, f.a.id, "Bearer token-a", 21], [b, f.b.id, "Bearer token-b", 73]] as const) {
    f.hits.length = 0;
    assert.equal((await send(adapter)).kind, "ok");
    assert.equal(percent(await adapter.fetchRateLimits()), used);
    assert.equal((await adapter.fetchModels())?.[0]?.id, `model-${used}`);
    await adapter.webSearch("gpt-6-sol").search({ query: "fixture" });
    assert.equal((await adapter.generateImage("gpt-6-sol", { prompt: "fixture" })).data.toString(), "image");
    assert.equal(f.hits.length, 5);
    assert.ok(f.hits.every(hit => hit.token === token && hit.workspace === "shared-workspace"));
    assert.deepEqual(adapter.accountStatus().map(row => row.id), [id]);
    assert.equal(percent(adapter.lastRateLimits), used);
  }
});

test("a binding defeats old conversation affinity, contradictory worker pins and quota failover", async t => {
  const f = fixture(t);
  const pool = new CredentialPool();
  assert.equal((await send(f.makeAdapter(undefined, "a", pool))).kind, "ok");
  const bound = f.makeAdapter(f.b.id, "a", pool);
  assert.equal((await send(bound, f.a.id.slice(0, 8))).kind, "ok");
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-a", "Bearer token-b"]);
  f.refused.set("Bearer token-b", 429);
  assert.equal((await send(bound, f.a.id.slice(0, 8))).kind, "refused");
  assert.equal((await send(bound)).kind, "all-resting");
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-a", "Bearer token-b", "Bearer token-b"]);
  assert.equal(bound.hasUsable(), false);
});

test("unbound providers retain automatic rotation", async t => {
  const f = fixture(t);
  f.refused.set("Bearer token-a", 429);
  assert.equal((await send(f.makeAdapter())).kind, "ok");
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-a", "Bearer token-b"]);
});

test("missing, workspace-id, paused, expired and rejected selections fail closed", async t => {
  const f = fixture(t);
  updateChatGptAccount(f.home, f.a.id, { paused: true });
  const { refreshToken: _unused, ...expiredGrant } = grant("expired", Date.now() - 1000);
  const expired = saveChatGptAccount(f.home, expiredGrant);
  const rejected = saveChatGptAccount(f.home, grant("rejected"));
  markChatGptNeedsReauth(f.home, rejected.id, "token-rejected");
  for (const id of ["missing", "shared-workspace", f.a.id, expired.id, rejected.id]) {
    const adapter = f.makeAdapter(id);
    assert.equal(adapter.signedIn(), false, id);
    assert.equal(adapter.hasUsable(), false, id);
    assert.equal((await send(adapter, f.b.id.slice(0, 8))).kind, "no-account", id);
    assert.equal(await adapter.fetchRateLimits(), null);
    assert.equal(await adapter.fetchModels(), null);
    await assert.rejects(adapter.webSearch("gpt-6-sol").search({ query: "fixture" }), /no ChatGPT credentials/);
    await assert.rejects(adapter.generateImage("gpt-6-sol", { prompt: "fixture" }), /no ChatGPT credentials/);
  }
  assert.equal(f.hits.length, 0);
  assert.deepEqual(f.refreshes, []);
});

test("refresh is restricted to the binding, single-flight, and never refreshes a paused account", async t => {
  const f = fixture(t);
  saveChatGptAccount(f.home, grant("a", Date.now() - 1000));
  saveChatGptAccount(f.home, grant("b", Date.now() - 1000));
  const one = new ChatGptAccountPool({ home: f.home, mode: "auto", account: f.b.id, log });
  const two = new ChatGptAccountPool({ home: f.home, mode: "auto", account: f.b.id, log });
  const credentials = await Promise.all([one.credentials(), two.credentials()]);
  assert.deepEqual(f.refreshes, ["refresh-b"]);
  assert.ok(credentials.every(rows => rows.length === 1 && rows[0]?.ownerId === f.b.id && rows[0]?.accessToken === "refresh-b-fresh"));
  assert.equal(readChatGptAccounts(f.home).find(row => row.id === f.a.id)?.accessToken, "token-a");
  assert.equal(await one.forceRefresh(f.a.id), false);
  updateChatGptAccount(f.home, f.a.id, { paused: true });
  const paused = new ChatGptAccountPool({ home: f.home, mode: "auto", account: f.a.id, log });
  await paused.refreshDue();
  assert.equal(await paused.forceRefresh(f.a.id), false);
  assert.deepEqual(f.refreshes, ["refresh-b"]);
});

test("401 refresh/replay stays on the selected account for quota and actual requests", async t => {
  const f = fixture(t);
  f.refused.set("Bearer token-b", 401);
  assert.equal(percent(await f.makeAdapter(f.b.id).fetchRateLimits()), 73);
  assert.deepEqual(f.refreshes, ["refresh-b"]);
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-b", "Bearer refresh-b-fresh"]);
  saveChatGptAccount(f.home, grant("b"));
  f.hits.length = 0;
  f.refused.set("Bearer refresh-b-fresh", 401);
  const adapter = f.makeAdapter(f.b.id);
  assert.notEqual((await send(adapter, f.a.id.slice(0, 8))).kind, "ok");
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-b", "Bearer refresh-b-fresh"]);
  assert.equal(readChatGptAccounts(f.home).find(row => row.id === f.b.id)?.needsReauth, true);
  assert.equal(adapter.signedIn(), false);
  assert.equal(readChatGptAccounts(f.home).find(row => row.id === f.a.id)?.needsReauth, undefined);
});

test("local legacy/codex ids work without widening own or borrow-codex modes", async t => {
  const f = fixture(t);
  const borrowed = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "codex-workspace" } });
  const auth = JSON.stringify({ tokens: { access_token: borrowed, refresh_token: "never-refresh-codex", account_id: "codex-workspace" } });
  fs.writeFileSync(path.join(f.home, "auth.json"), auth);
  const pool = (mode: "own" | "auto" | "borrow-codex", account?: string) => new ChatGptAccountPool({ home: f.home, mode, ...(account === undefined ? {} : { account }), log });
  assert.deepEqual(pool("auto").peekCredentials().map(row => row.ownerId), [f.a.id, f.b.id, "codex"]);
  assert.deepEqual(pool("auto", "codex").peekCredentials().map(row => row.ownerId), ["codex"]);
  assert.deepEqual(pool("own", "codex").peekCredentials(), []);
  assert.deepEqual(pool("borrow-codex", f.a.id).peekCredentials(), []);
  assert.deepEqual(pool("auto", "missing").peekCredentials(), []);
  assert.equal(await pool("auto", "codex").forceRefresh("codex"), false);
  assert.equal(fs.readFileSync(path.join(f.home, "auth.json"), "utf8"), auth);
  const legacyHome = path.join(f.home, "legacy-home");
  fs.mkdirSync(legacyHome);
  fs.writeFileSync(path.join(legacyHome, "chatgpt-auth.json"), JSON.stringify(grant("legacy")));
  assert.deepEqual(new ChatGptAccountPool({ home: legacyHome, mode: "auto", account: "legacy", log }).peekCredentials().map(row => row.ownerId), ["legacy"]);
});

test("binding changes replace proxy adapter quota/catalogue and clear stale provider health", async t => {
  const f = fixture(t);
  const proxy = makeProxy(f);
  const old = proxy.chatgptForCodex("a");
  assert.equal(percent(await proxy.chatgptFetchRateLimits("a")), 21);
  assert.equal((await proxy.chatgptFetchModels("a"))?.[0]?.id, "model-21");
  proxy.providerHealth.observe("a", 429, providerExhaustion(429, "usage_limit_reached"));
  proxy.modelHealth.observe("a", "gpt-6-sol", { reason: "model_deprecated", at: Date.now() });
  f.cfg.providers.a = f.provider(f.b.id);
  assert.equal(proxy.chatgptRateLimits.a, null, "status cannot expose the old adapter's quota before the next turn");
  assert.notEqual(proxy.chatgptForCodex("a"), old);
  proxy.reconcileConfig(f.cfg);
  assert.deepEqual(proxy.providerHealth.snapshot(), {});
  assert.deepEqual(proxy.modelHealth.snapshot(), {});
  assert.equal(percent(await proxy.chatgptFetchRateLimits("a")), 73);
  assert.equal((await proxy.chatgptFetchModels("a"))?.[0]?.id, "model-73");
  assert.deepEqual(proxy.chatgptAccounts().a?.map(row => row.id), [f.b.id]);
  f.cfg.providers.a = f.provider("missing");
  assert.match(proxy.chatgptAuthStatus().a!, /accounts=0 usable=0/);
  assert.equal(proxy.chatgptRateLimits.a, null);
  assert.equal(await proxy.chatgptFetchModels("a"), null);
});

test("bound Codex passthrough never falls back to caller credentials, unlike unbound mode", async t => {
  const f = fixture(t);
  let adapter = f.makeAdapter("missing");
  const front = http.createServer((req, res) => { void adapter.passthrough(req, res, "/responses", undefined, "thread"); });
  await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));
  t.after(() => front.close());
  const url = `http://127.0.0.1:${(front.address() as { port: number }).port}/turn`;
  const call = () => fetch(url, { method: "POST", headers: { authorization: "Bearer caller-token", "chatgpt-account-id": "caller-workspace" } });
  assert.equal((await call()).status, 401);
  assert.equal(f.hits.length, 0);
  adapter = f.makeAdapter(f.a.id);
  f.refused.set("Bearer token-a", 429);
  assert.equal((await call()).status, 429);
  assert.deepEqual(f.hits.map(hit => hit.token), ["Bearer token-a"]);
  removeChatGptAccount(f.home, f.a.id);
  removeChatGptAccount(f.home, f.b.id);
  adapter = f.makeAdapter();
  const response = await call();
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(f.hits.at(-1)?.token, "Bearer caller-token");
});

test("admin discovery keeps all account metadata while status and probes honor the selection", async t => {
  const f = fixture(t);
  const proxy = makeProxy(f);
  const admin = await startAdmin({ config: () => f.cfg, configFile: path.join(f.home, "config.json"), log,
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }), health: () => 0, version: "test",
    requests: new RequestLog(path.join(f.home, "admin-requests.jsonl")),
    chatgpt: () => ({ quota: proxy.chatgptRateLimits, auth: proxy.chatgptAuthStatus(), accounts: () => proxy.chatgptAccounts(), refresh: name => proxy.chatgptFetchRateLimits(name), models: name => proxy.chatgptFetchModels(name) }),
  });
  t.after(() => admin.close());
  const base = `http://127.0.0.1:${admin.port}`;
  for (const provider of Object.values(f.cfg.providers)) if (provider.type === "chatgpt") provider.url = base;
  await proxy.chatgptFetchRateLimits("a");
  await proxy.chatgptFetchRateLimits("b");
  const discovered = await (await fetch(`${base}/api/chatgpt-accounts?provider=a`)).json() as { provider: string; accounts: { id: string; quota: unknown; inUse: boolean }[] };
  assert.equal(discovered.provider, "a");
  assert.deepEqual(discovered.accounts.map(row => row.id), [f.a.id, f.b.id]);
  assert.equal(percent(discovered.accounts[0]?.quota), 21);
  assert.equal(discovered.accounts[1]?.inUse, false);
  assert.doesNotMatch(JSON.stringify(discovered), /token-a|token-b|refresh-a|refresh-b|shared-workspace/);
  const status = await (await fetch(`${base}/api/status`)).json() as { chatgpt: { signedIn: Record<string, boolean>; accounts: Record<string, { id: string }[]>; quota: Record<string, unknown> }; providers: Record<string, { needsLogin: boolean; usable: boolean }> };
  assert.deepEqual(status.chatgpt.accounts.a?.map(row => row.id), [f.a.id]);
  assert.equal(percent(status.chatgpt.quota.a), 21);
  assert.equal(percent(status.chatgpt.quota.b), 73);
  assert.equal(status.chatgpt.signedIn.a, true);
  const probe = async (account: unknown) => {
    const response = await fetch(`${base}/api/providers/probe`, { method: "POST", body: JSON.stringify({ type: "chatgpt", name: "a", auth: "auto", account }) });
    return { status: response.status, body: await response.json() as { ok: boolean; modelsSource: string } };
  };
  assert.equal((await probe(f.a.id)).body.modelsSource, "catalog");
  const before = f.hits.length;
  assert.equal((await probe(f.b.id)).body.modelsSource, "fallback");
  assert.equal((await probe("missing")).body.ok, false);
  assert.equal((await probe(123)).status, 400);
  assert.equal(f.hits.length, before, "a draft must not call the saved provider's account");
  f.cfg.providers.a = { ...f.provider("missing"), url: base };
  const missing = await (await fetch(`${base}/api/status`)).json() as typeof status;
  assert.equal(missing.chatgpt.signedIn.a, false);
  assert.equal(missing.providers.a?.needsLogin, true);
  assert.equal(missing.providers.a?.usable, false);
  assert.deepEqual(missing.chatgpt.accounts.a, []);
  assert.equal(missing.chatgpt.quota.a, null);
  const stillDiscoverable = await (await fetch(`${base}/api/chatgpt-accounts?provider=a`)).json() as typeof discovered;
  assert.deepEqual(stillDiscoverable.accounts.map(row => row.id), [f.a.id, f.b.id]);
});

test("generated pinned workers follow binding changes and remove the previous account", t => {
  const f = fixture(t);
  delete f.cfg.providers.b;
  const dir = path.join(f.home, "agents");
  const manifest = path.join(f.home, "generated-agents.json");
  const accountsFor = (provider: ChatGptProvider) => storedAccountsFor(provider, f.home);
  const sync = () => syncAgentFiles(f.cfg, dir, undefined, { manifestPath: manifest, pinnedAccounts: provider => storedAccountsFor(provider, f.home) });
  sync();
  const oldFile = path.join(dir, `gpt-6-sol-${f.a.id.slice(0, 8)}.md`);
  assert.ok(fs.existsSync(oldFile));
  const signature = storedAccountsSignature(f.cfg.providers, f.home);
  f.cfg.providers.a = f.provider(f.b.id);
  assert.notEqual(storedAccountsSignature(f.cfg.providers, f.home), signature);
  sync();
  assert.equal(fs.existsSync(oldFile), false);
  assert.ok(fs.existsSync(path.join(dir, `gpt-6-sol-${f.b.id.slice(0, 8)}.md`)));
  assert.deepEqual(generatedAgents(f.cfg, dir, manifest, undefined, provider => storedAccountsFor(provider, f.home)).filter(agent => agent.account).map(agent => agent.name), [`gpt-6-sol-${f.b.id.slice(0, 8)}`]);
  assert.deepEqual(accountsFor(f.provider("missing")), []);
  assert.deepEqual(accountsFor({ ...f.provider(f.b.id), auth: "borrow-codex" }), []);
});

test("configuration accepts absent/exact ids and rejects malformed bindings", t => {
  const f = fixture(t);
  for (const account of [undefined, f.a.id, "legacy", "codex", "missing"]) {
    f.cfg.providers.a = f.provider(account);
    assert.deepEqual(validate(f.cfg), [], String(account));
  }
  for (const account of ["", " ", ` ${f.a.id}`, 123, null]) {
    f.cfg.providers.a = { ...f.provider(), account } as ChatGptProvider;
    assert.ok(validate(f.cfg).some(error => error.includes("account must")), String(account));
  }
});
