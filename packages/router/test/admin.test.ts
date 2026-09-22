import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Logger } from "../src/log.ts";
import { startAdmin } from "../src/admin.ts";
import { RequestLog } from "../src/requestlog.ts";
import { PRESETS } from "../src/presets.ts";
import { saveClaudeAuthFile, saveClaudeOAuthFile } from "../src/providers/anthropic-token-file.ts";
import { listClaudeAccounts, readClaudeAccountsFile, saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";

function makeCfg(overrides: Partial<Config> = {}): Config {
  // port 0: let the OS pick a free ephemeral port so parallel tests never collide.
  return { ...DEFAULTS, admin: { port: 0 }, ...overrides };
}

async function withAdmin(
  cfgInit: Config,
  fn: (ctx: { port: number; configFile: string; home: string; setCfg: (c: Config) => void }) => Promise<void>,
  extraDeps: {
    shutdown?: () => void;
    runCli?: (args: string[], timeout?: number) => Promise<{ ok: boolean; output: string }>;
    claudeOAuthFetch?: (url: string, init: RequestInit) => Promise<Response>;
    openBrowser?: (url: string) => boolean;
    observedClaudeCodeAuth?: ObservedClaudeCodeAuth;
    measureFetch?: (url: string, init: RequestInit) => Promise<Response>;
    chatgpt?: () => { quota: Record<string, Record<string, unknown> | null>; auth: Record<string, string>; refresh?: (name: string) => Promise<Record<string, unknown> | null> };
  } = {},
): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-admin-"));
  const prevHome = process.env.CLAUDERIPPLE_HOME;
  process.env.CLAUDERIPPLE_HOME = home;
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(cfgInit, null, 2));
  let cfg = cfgInit;
  const log = new Logger(null, 1_000_000, 1, false);
  const admin = await startAdmin({
    config: () => cfg,
    configFile,
    log,
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 1, completed: 1, failed: 0 }),
    health: () => 0,
    version: "0.0.0-test",
    requests: new RequestLog(path.join(home, "logs", "requests.jsonl")),
    ...extraDeps,
  });
  try {
    await fn({ port: admin.port, configFile, home, setCfg: (c) => (cfg = c) });
  } finally {
    admin.close();
    if (prevHome === undefined) delete process.env.CLAUDERIPPLE_HOME;
    else process.env.CLAUDERIPPLE_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const base = () => `http://127.0.0.1`;

/** fetch()/undici normalize %2e-encoded dot segments client-side before sending; use a raw
 * http.request (path passed through untouched) to actually exercise the server's own guard. */
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolveP({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the Claude subscription sign-in runs from the GUI: start, state, pasted code, stored credential, nothing echoed", async () => {
  const opened: string[] = [];
  const calls: Record<string, unknown>[] = [];
  const claudeOAuthFetch = async (_url: string, init: RequestInit): Promise<Response> => {
    calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ access_token: "at-secret", refresh_token: "rt-secret", expires_in: 3600 }), { status: 200 });
  };
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const idle = (await (await fetch(`${base()}:${port}/api/claude-oauth`)).json()) as { running: boolean; source: string | null };
    assert.equal(idle.running, false);
    const started = await fetch(`${base()}:${port}/api/claude-oauth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manual: true }) });
    const state = (await started.json()) as { running: boolean; url: string; manual: boolean; opened: boolean };
    assert.equal(started.status, 200);
    assert.equal(state.running, true);
    assert.equal(state.manual, true);
    assert.equal(state.opened, true);
    assert.equal(opened[0], state.url);
    assert.match(state.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    // A second start while one is running returns the same attempt instead of a new browser tab.
    await fetch(`${base()}:${port}/api/claude-oauth`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(opened.length, 1);
    const oauthState = new URL(state.url).searchParams.get("state");
    const done = await fetch(`${base()}:${port}/api/claude-oauth/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: `abc#${oauthState}` }) });
    assert.equal(done.status, 200);
    const finished = (await done.json()) as { running: boolean; ok: boolean };
    assert.equal(finished.running, false);
    assert.equal(finished.ok, true);
    assert.equal(calls[0]?.grant_type, "authorization_code");
    const stored = readClaudeAccountsFile(home);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.token, "at-secret");
    const after = (await (await fetch(`${base()}:${port}/api/claude-oauth`)).json()) as { source: string | null; account: { id: string } | null };
    assert.equal(after.source, null, "pool accounts are separate from the current external Claude login");
    assert.equal(after.account?.id, stored[0]!.id);
    assert.doesNotMatch(JSON.stringify(after), /at-secret|rt-secret/);
    const nothingWaiting = await fetch(`${base()}:${port}/api/claude-oauth/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "x" }) });
    assert.equal(nothingWaiting.status, 409);
  }, { claudeOAuthFetch, openBrowser: (url) => { opened.push(url); return true; } });
});

test("Claude account admin endpoints expose no secrets and rename or remove only stored accounts", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const account = saveClaudeOAuthAccount(home, {
      accessToken: "admin-access-secret",
      refreshToken: "admin-refresh-secret",
      expiresAt: Date.now() + 3_600_000,
      accountId: "upstream-account-secret",
      email: "person@example.test",
    });
    const listed = await fetch(`${base()}:${port}/api/claude-accounts`);
    assert.equal(listed.status, 200);
    const body = await listed.json() as { current: unknown; accounts: { id: string; label: string }[] };
    assert.equal(body.current, null);
    assert.deepEqual(body.accounts, [{ id: account.id, label: "person@example.test", email: "person@example.test", expiresAt: account.expiresAt, needsReauth: false }]);
    assert.doesNotMatch(JSON.stringify(body), /admin-access-secret|admin-refresh-secret|upstream-account-secret/);

    const renamed = await fetch(`${base()}:${port}/api/claude-accounts/${encodeURIComponent(account.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "  Personal  " }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(listClaudeAccounts(home)[0]!.label, "Personal");

    const current = await fetch(`${base()}:${port}/api/claude-accounts/current`, { method: "DELETE" });
    assert.equal(current.status, 409);
    const arbitrary = await fetch(`${base()}:${port}/api/claude-accounts/not-a-local-id`, { method: "DELETE" });
    assert.equal(arbitrary.status, 400);
    const removed = await fetch(`${base()}:${port}/api/claude-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(listClaudeAccounts(home), []);
    const missing = await fetch(`${base()}:${port}/api/claude-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    assert.equal(missing.status, 404);
  });
});

test("/readyz separates readiness from liveness and names each problem", async () => {
  await withAdmin(makeCfg({ providers: { p: { type: "anthropic-compatible", url: "http://127.0.0.1:1" } } }), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/readyz`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    const body = (await res.json()) as { ready: boolean; problems: string[] };
    assert.equal(body.ready, false);
    assert.ok(body.problems.includes("provider:p"), body.problems.join(","));
    const status = (await (await fetch(`${base()}:${port}/api/status`)).json()) as { readiness: { ready: boolean; problems: string[] } };
    assert.deepEqual(status.readiness, body);
  });
});

test("GET /api/status returns a snapshot", async () => {
  await withAdmin(makeCfg({ providers: { p: { type: "anthropic-compatible", url: "http://127.0.0.1:1" } } }), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.version, "0.0.0-test");
    assert.equal(typeof body.listen, "object");
    assert.equal(typeof body.providers, "object");
    const providers = body.providers as Record<string, { reachable: boolean }>;
    assert.ok("p" in providers);
    assert.equal(providers.p?.reachable, false); // nothing listening on :1
    assert.equal(typeof body.settings, "object");
    assert.equal(typeof body.cliVersion, "string");
  });
});

// The Clients screen labels a model the router cannot search through, and only the router knows
// which those are. The capability is measured per route, so it must not come from the vendor name —
// nor from whether the model itself can search, which the router has no way to use.
// Anything that checks whether a service is up asks with a HEAD: the headers, no body. Every route
// matched on "GET" alone, so a HEAD fell through to the 404 at the end and a healthy router reported
// itself dead — while the CSRF check above it had been written to expect HEAD all along.
test("HEAD answers a read-only route with its headers and no body", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    // The contract is that a HEAD answers exactly as the GET does, whatever that answer is:
    // `/readyz` is a 503 until the proxy reports ready, and a HEAD has to say the same thing.
    for (const route of ["/readyz", "/api/status", "/style.css", "/"]) {
      const get = await fetch(`${base()}:${port}${route}`);
      const head = await fetch(`${base()}:${port}${route}`, { method: "HEAD" });
      assert.notEqual(head.status, 404, `HEAD ${route} must reach its route`);
      assert.equal(head.status, get.status, `HEAD ${route} answers as the GET does`);
    }
    // A static file is the same bytes on both calls, so its stated length can be compared exactly;
    // `/api/status` carries live counters and would differ between two reads.
    const [getCss, headCss] = [await fetch(`${base()}:${port}/style.css`), await fetch(`${base()}:${port}/style.css`, { method: "HEAD" })];
    assert.ok(Number(getCss.headers.get("content-length")) > 0);
    assert.equal(headCss.headers.get("content-length"), getCss.headers.get("content-length"), "the length of the body a GET would have sent");
    // The body is the part a HEAD must not carry, and `fetch` never exposes one — read the wire.
    const wire = await new Promise<string>((done, fail) => {
      const sock = net.connect(port, "127.0.0.1", () => sock.write("HEAD /style.css HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n"));
      let text = "";
      sock.on("data", (chunk: Buffer) => { text += chunk.toString("latin1"); });
      sock.on("close", () => done(text));
      sock.on("error", fail);
    });
    assert.match(wire, /^HTTP\/1\.1 200 OK/);
    assert.match(wire, /content-length: [1-9]/i, "the length of the body a GET would have sent");
    assert.equal(wire.split("\r\n\r\n")[1], "", "nothing after the headers");
  });
});

test("GET /api/status marks which providers can run a web search", async () => {
  const cfg = makeCfg({
    providers: {
      translated: { type: "openai-compatible", url: "http://127.0.0.1:1" },
      native: { type: "anthropic-compatible", url: "http://127.0.0.1:1", preset: "deepseek" },
      // The same vendor through another route: it serves the model but runs no server tool.
      via: { type: "anthropic-compatible", url: "http://127.0.0.1:1", preset: "opencode-go" },
    },
  });
  await withAdmin(cfg, async ({ port }) => {
    const body = (await (await fetch(`${base()}:${port}/api/status`)).json()) as {
      providers: Record<string, { webSearch?: boolean }>;
    };
    assert.equal(body.providers.native?.webSearch, true, "a measured server-tool provider can search");
    assert.equal("webSearch" in (body.providers.translated ?? {}), false, "a translated path cannot");
    assert.equal("webSearch" in (body.providers.via ?? {}), false, "the same model elsewhere still cannot");
  });
});

test("GET /api/presets returns the provider catalog", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/presets`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { presets: unknown[] };
    assert.deepEqual(body.presets, PRESETS);
  });
});

test("GET /api/claude-models falls back when no picker bootstrap has arrived", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/claude-models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { source: string; models: { id: string; name: string }[] };
    assert.equal(body.source, "fallback");
    assert.deepEqual(body.models[0], { id: "claude-fable-5-1", name: "Fable 5.1" });
  });
});

test("GET /api/claude-models uses named entries from code and ccd picker surfaces", async () => {
  const cfg = makeCfg();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-picker-admin-"));
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const log = new Logger(null, 1_000_000, 1, false);
  const admin = await startAdmin({
    config: () => cfg,
    configFile,
    log,
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    health: () => 0,
    version: "0.0.0-test",
    requests: new RequestLog(path.join(home, "logs", "requests.jsonl")),
    picker: () => ({
      enabled: true,
      hosts: ["claude.ai"],
      last: { at: "now", injected: 0, surfaces: [{ id: "code", models: ["claude-opus-5"], entries: [{ id: "claude-opus-5", name: "Opus 5" }] }, { id: "chat", models: ["ignored"], entries: [{ id: "ignored", name: "Ignored" }] }] },
    }),
  });
  try {
    const res = await fetch(`${base()}:${admin.port}/api/claude-models`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { source: "picker", models: [{ id: "claude-opus-5", name: "Opus 5" }] });
  } finally {
    admin.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GET /api/status reports native Anthropic TCP reachability and token-file source", async () => {
  await withAdmin(makeCfg({ providers: { native: { type: "anthropic", auth: "claude-code" } } }), async ({ port, home }) => {
    saveClaudeAuthFile(home, "test-token", "2026-09-13T00:00:00.000Z");
    const res = await fetch(`${base()}:${port}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json() as { providers: Record<string, { url: string; type: string; reachable: boolean; authSource: string | null }> };
    assert.deepEqual(Object.keys(body.providers.native ?? {}).sort(), ["accountCount", "authSource", "reachable", "signedIn", "type", "url"]);
    assert.equal(body.providers.native?.url, "https://api.anthropic.com");
    assert.equal(body.providers.native?.type, "anthropic");
    assert.equal(body.providers.native?.authSource, "token-file");
  });
});

test("GET /api/effort-levels reports compatible defaults and ChatGPT model exceptions", async () => {
  const cfg = makeCfg({
    providers: {
      openrouter: { type: "anthropic-compatible", url: "https://openrouter.ai/api", preset: "openrouter", models: [{ id: "effort", effortLevels: ["low", "medium", "high"] }, { id: "no-effort", effortLevels: [] }, { id: "fallback" }] },
      custom: { type: "anthropic-compatible", url: "https://example.test", caps: { effortLevels: ["max"], thinking: "none" } },
      gpt: { type: "chatgpt" },
    },
  });
  await withAdmin(cfg, async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/effort-levels`);
    assert.equal(res.status, 200);
    const body = await res.json() as { providers: Record<string, { default: string[]; models?: Record<string, string[]> }> };
    assert.deepEqual(body.providers.anthropic?.default, ["low", "medium", "high", "max"]);
    assert.deepEqual(body.providers.openrouter?.default, ["low", "medium", "high"]);
    assert.deepEqual(body.providers.openrouter?.models, { effort: ["low", "medium", "high"], "no-effort": [] });
    assert.deepEqual(body.providers.custom?.default, ["max"]);
    assert.deepEqual(body.providers.gpt?.models?.["gpt-5.6-luna"], ["low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.deepEqual(body.providers.gpt?.models?.["gpt-5.6-terra"], ["low", "medium", "high", "xhigh", "max"]);
  });
});

test("GET /api/config returns the config file contents", async () => {
  const cfg = makeCfg({ routes: { "claude-opus-4-8": { provider: "p", model: "m" } }, providers: { p: { type: "anthropic-compatible", url: "http://x" } } });
  await withAdmin(cfg, async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/config`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Config;
    assert.deepEqual(body.routes, cfg.routes);
  });
});

test("PUT /api/config accepts a valid config and saves it atomically", async () => {
  await withAdmin(makeCfg(), async ({ port, configFile, setCfg }) => {
    const next = makeCfg({ providers: { p: { type: "anthropic-compatible", url: "http://127.0.0.1:9" } }, routes: { "claude-opus-4-8": { provider: "p", model: "m" } } });
    const res = await fetch(`${base()}:${port}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    assert.equal(res.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(onDisk.routes, next.routes);
    // no leftover temp files
    const dir = fs.readdirSync(path.dirname(configFile));
    assert.ok(!dir.some((f) => f.includes(".tmp-")));
    setCfg(next);
  });
});

test("PUT /api/config rejects an invalid config with 400 and does not touch the file", async () => {
  const cfg = makeCfg();
  await withAdmin(cfg, async ({ port, configFile }) => {
    const before = fs.readFileSync(configFile, "utf8");
    const bad = makeCfg({ routes: { a: { provider: "nope", model: "m" } } });
    const res = await fetch(`${base()}:${port}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(bad) });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { errors: string[] };
    assert.ok(body.errors.length > 0);
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
  });
});

test("PUT /api/config rejects malformed JSON with 400", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{ not json" });
    assert.equal(res.status, 400);
  });
});

test("POST /api/providers/probe accepts native Claude Code auth and reports only the source name", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const missing = await fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "anthropic", auth: "claude-code" }) });
    assert.deepEqual(await missing.json(), { ok: false, auth: "missing", source: null, signedIn: null, accountCount: 0, models: [
      { id: "claude-fable-5-1", name: "Fable 5.1" }, { id: "claude-opus-5", name: "Opus 5" }, { id: "claude-sonnet-5", name: "Sonnet 5" }, { id: "claude-haiku-4-5", name: "Haiku 4.5" }, { id: "claude-fable-5", name: "Fable 5" }, { id: "claude-opus-4-8", name: "Opus 4.8" }, { id: "claude-opus-4-7", name: "Opus 4.7" }, { id: "claude-opus-4-6", name: "Opus 4.6" }, { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
    ] });
    saveClaudeAuthFile(home, "test-token", "2026-09-13T00:00:00.000Z");
    const available = await fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "anthropic", auth: "claude-code" }) });
    const body = await available.json() as { ok: boolean; auth: string; source: string; signedIn: string | null; models: { id: string; name: string }[] };
    assert.equal(body.ok, true);
    assert.equal(body.auth, "ok");
    assert.equal(body.source, "token-file");
    assert.equal(body.signedIn, "setup-token");
    assert.equal(body.models[0]?.id, "claude-fable-5-1");
    assert.equal(JSON.stringify(body).includes("test-token"), false);
  });
});

test("the probe names our own stored sign-in even while a Claude Desktop session outranks it", async () => {
  const observed = new ObservedClaudeCodeAuth();
  observed.observe(["authorization", "Bearer desktop-token", "anthropic-beta", "oauth-2025-04-20", "user-agent", "claude-cli/2.1.272"]);
  await withAdmin(makeCfg({ providers: { anthropic: { type: "anthropic", auth: "claude-code" } } }), async ({ port, home }) => {
    saveClaudeOAuthFile(home, { accessToken: "ours", refreshToken: "rt", expiresAt: Date.now() + 3600_000 });
    const res = await fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "anthropic", auth: "claude-code" }) });
    const body = await res.json() as { source: string; signedIn: string | null };
    assert.equal(body.source, "observed");
    assert.equal(body.signedIn, "oauth");
    const status = await (await fetch(`${base()}:${port}/api/status`)).json() as { providers: Record<string, { authSource?: string; signedIn?: string | null }> };
    assert.equal(status.providers.anthropic?.authSource, "observed");
    assert.equal(status.providers.anthropic?.signedIn, "oauth");
  }, { observedClaudeCodeAuth: observed });
});

test("POST /api/providers/probe sends Anthropic API-key headers and treats a model 400 as authenticated", async () => {
  const seen: { url?: string; headers?: Headers; body?: string } = {};
  const cfg = makeCfg();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-admin-native-probe-"));
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const admin = await startAdmin({
    config: () => cfg, configFile, log: new Logger(null, 1_000_000, 1, false),
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }), health: () => 0, version: "test",
    requests: new RequestLog(path.join(home, "logs", "requests.jsonl")),
    probeFetch: async (url, init) => { seen.url = url; seen.headers = new Headers(init.headers); seen.body = String(init.body); return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 400 }); },
  });
  try {
    const res = await fetch(`${base()}:${admin.port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "anthropic", auth: "api-key", apiKey: "secret-key" }) });
    assert.deepEqual(await res.json(), { ok: true, auth: "ok", models: [
      { id: "claude-fable-5-1", name: "Fable 5.1" }, { id: "claude-opus-5", name: "Opus 5" }, { id: "claude-sonnet-5", name: "Sonnet 5" }, { id: "claude-haiku-4-5", name: "Haiku 4.5" }, { id: "claude-fable-5", name: "Fable 5" }, { id: "claude-opus-4-8", name: "Opus 4.8" }, { id: "claude-opus-4-7", name: "Opus 4.7" }, { id: "claude-opus-4-6", name: "Opus 4.6" }, { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
    ] });
    assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
    assert.equal(seen.headers?.get("x-api-key"), "secret-key");
    assert.equal(seen.headers?.get("anthropic-version"), "2023-06-01");
    assert.equal(JSON.parse(seen.body ?? "{}")?.max_tokens, 1);
  } finally { admin.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("POST /api/providers/probe rejects an incomplete native Anthropic request", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "anthropic", auth: "api-key" }) });
    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /apiKey/);
  });
});

test("POST /api/providers/probe discovers models then accepts model-validation errors", async () => {
  const seen: { modelsAuth: string | undefined; messagesAuth: string | undefined; model: string | undefined } = { modelsAuth: undefined, messagesAuth: undefined, model: undefined };
  const upstream = http.createServer((req, res) => {
    if (req.url === "/models") {
      seen.modelsAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fake-model", name: "Fake Model" }] }));
      return;
    }
    if (req.url === "/anthropic/v1/messages") {
      seen.messagesAuth = req.headers["x-api-key"] as string | undefined;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.model = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model;
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "model not found" } }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "anthropic-compatible",
          url: `${origin}/anthropic`,
          headers: { "x-api-key": "secret-key" },
          modelsUrl: `${origin}/models`,
          modelsAuthHeader: "authorization-bearer",
        }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, auth: "ok", models: [{ id: "fake-model", name: "Fake Model" }] });
    });
    assert.equal(seen.modelsAuth, "Bearer secret-key");
    assert.equal(seen.messagesAuth, "secret-key");
    assert.equal(seen.model, "fake-model");
  } finally {
    await new Promise<void>((resolveP, reject) => upstream.close((error) => (error ? reject(error) : resolveP())));
  }
});

test("POST /api/providers/probe discovers OpenAI-compatible models and probes Chat Completions", async () => {
  const seen: { auth?: string; model?: string; tokens?: number } = {};
  const upstream = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [
        { id: "oai-model", name: "OAI Model", supported_parameters: ["reasoning_effort"], context_length: 1000000 },
        { id: "no-effort-model", supported_parameters: ["reasoning"], context_length: "400k" },
        { id: "legacy-model" },
      ] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      if (typeof req.headers.authorization === "string") seen.auth = req.headers.authorization;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; max_tokens: number };
        seen.model = body.model;
        seen.tokens = body.max_tokens;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}/v1`;
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "openai-compatible", url: origin, headers: { authorization: "Bearer secret-key" }, modelsUrl: `${origin}/models`, modelsAuthHeader: "authorization-bearer" }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true,
        auth: "ok",
        models: [
          // context_length is taken when it is a usable number, and ignored otherwise ("400k").
          { id: "oai-model", name: "OAI Model", effortLevels: ["low", "medium", "high"], contextWindow: 1000000 },
          { id: "no-effort-model", effortLevels: [] },
          { id: "legacy-model" },
        ],
      });
    });
    assert.equal(seen.auth, "Bearer secret-key");
    assert.equal(seen.model, "oai-model");
    assert.equal(seen.tokens, 1);
  } finally {
    await new Promise<void>((resolveP, reject) => upstream.close((error) => error ? reject(error) : resolveP()));
  }
});

// A provider built from a preset reaches several wires on one `/models` catalog, and the catalog
// reports ids alone. The preset's fallback list is the only place each model's wire, endpoint and auth
// convention is written, so discovery has to fold it in — a model left bare would be sent in the
// provider's default shape to the wrong path.
test("POST /api/providers/probe tags discovered models with the wire their preset declares", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [
        { id: "minimax-m3", name: "MiniMax M3" },
        { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
        { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 (Contributor)" },
        // Not on the preset's list: it must come back bare and ride the provider default.
        { id: "brand-new-model", name: "Brand New" },
      ] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}/v1`;
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "openai-compatible", url: origin, headers: { authorization: "Bearer secret-key" }, modelsUrl: `${origin}/models`, modelsAuthHeader: "authorization-bearer", preset: "opencode-go" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { models: { id: string; wire?: string; url?: string; authHeader?: string }[] };
      const byId = new Map(body.models.map((m) => [m.id, m]));
      assert.equal(byId.get("minimax-m3")?.wire, "anthropic");
      assert.equal(byId.get("minimax-m3")?.url, "https://opencode.ai/zen/go", "one segment shorter than the OpenAI base");
      assert.equal(byId.get("minimax-m3")?.authHeader, "x-api-key", "Anthropic's convention, not the provider bearer");
      assert.equal(byId.get("deepseek-v4.1-flash")?.wire, "chat");
      assert.equal(byId.get("deepseek-v4.1-flash")?.url, undefined, "the chat group uses the provider base");
      assert.equal(byId.get("muse-spark-1.3-contributor")?.wire, undefined, "the Responses group rides the provider default");
      assert.equal(byId.get("brand-new-model")?.wire, undefined, "an id the preset does not list stays bare");
    });
  } finally {
    await new Promise<void>((resolveP, reject) => upstream.close((error) => (error ? reject(error) : resolveP())));
  }
});

test("POST /api/providers/probe reports 401 as a bad key without exposing it", async () => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.url, "/anthropic/v1/messages");
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad key" }));
  });
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "anthropic-compatible", url: `http://127.0.0.1:${address.port}/anthropic`, headers: { authorization: "Bearer secret-key" } }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; auth: string; error?: string };
      assert.equal(body.ok, false);
      assert.equal(body.auth, "bad-key");
      assert.equal(JSON.stringify(body).includes("secret-key"), false);
    });
  } finally {
    await new Promise<void>((resolveP, reject) => upstream.close((error) => (error ? reject(error) : resolveP())));
  }
});

test("POST /api/providers/probe does not call an upstream 500 authenticated", async () => {
  const upstream = http.createServer((_req, res) => res.writeHead(500).end("failure"));
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "anthropic-compatible", url: `http://127.0.0.1:${address.port}` }),
      });
      assert.deepEqual(await res.json(), { ok: false, auth: "unreachable", models: [], error: "messages endpoint returned 500: failure" });
    });
  } finally {
    await new Promise<void>((resolveP, reject) => upstream.close((error) => (error ? reject(error) : resolveP())));
  }
});

test("Codex and Claude subscription endpoints invoke the matching CLI command", async () => {
  const calls: { args: string[]; timeout?: number }[] = [];
  const cfg = makeCfg();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-admin-cli-"));
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const admin = await startAdmin({
    config: () => cfg,
    configFile,
    log: new Logger(null, 1_000_000, 1, false),
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    health: () => 0,
    version: "test",
    requests: new RequestLog(path.join(home, "logs", "requests.jsonl")),
    runCli: async (args, timeout) => { calls.push({ args, ...(timeout === undefined ? {} : { timeout }) }); return { ok: true, output: "done" }; },
  });
  try {
    const codexBefore = await fetch(`${base()}:${admin.port}/api/codex`);
    assert.equal(codexBefore.status, 200);
    const codex = await codexBefore.json() as { enabled: boolean; codexHome: string; configPath: string };
    assert.equal(typeof codex.enabled, "boolean");
    assert.ok(codex.configPath.endsWith("config.toml"));
    for (const [pathName, body] of [["/api/codex", { enabled: true }], ["/api/claude-login", {}], ["/api/claude-logout", {}]] as const) {
      const res = await fetch(`${base()}:${admin.port}${pathName}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, output: "done" });
    }
    assert.deepEqual(calls, [{ args: ["codex", "on"] }, { args: ["claude-login"], timeout: 200_000 }, { args: ["claude-logout"] }]);
  } finally {
    admin.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ChatGPT login starts without waiting and reports its eventual result", async () => {
  let complete: ((value: { ok: boolean; output: string }) => void) | undefined;
  const calls: { args: string[]; timeout?: number }[] = [];
  const runCli = (args: string[], timeout?: number) => {
    calls.push({ args, ...(timeout === undefined ? {} : { timeout }) });
    return new Promise<{ ok: boolean; output: string }>((resolveP) => { complete = resolveP; });
  };
  await withAdmin(makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } }), async ({ port }) => {
    const started = await fetch(`${base()}:${port}/api/chatgpt-login`, { method: "POST" });
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { started: true });
    assert.deepEqual(calls, [{ args: ["login"], timeout: 330_000 }]);
    const duplicate = await fetch(`${base()}:${port}/api/chatgpt-login`, { method: "POST" });
    assert.deepEqual(await duplicate.json(), { running: true });
    assert.equal(calls.length, 1);

    const inProgress = await fetch(`${base()}:${port}/api/chatgpt-login`);
    const pending = await inProgress.json() as { running: boolean; startedAt?: string; signedIn: boolean };
    assert.equal(pending.running, true);
    assert.match(pending.startedAt ?? "", /^\d{4}-\d\d-\d\dT/);
    assert.equal(pending.signedIn, false);

    complete?.({ ok: true, output: "logged in" });
    await new Promise((resolveP) => setImmediate(resolveP));
    const finished = await fetch(`${base()}:${port}/api/chatgpt-login`);
    const done = await finished.json() as { running: boolean; finishedAt?: string; ok?: boolean; output?: string; signedIn: boolean };
    assert.equal(done.running, false);
    assert.equal(done.ok, true);
    assert.equal(done.output, "logged in");
    assert.match(done.finishedAt ?? "", /^\d{4}-\d\d-\d\dT/);
  }, { runCli });
});

test("GET /api/requests filters newest records and returns a summary", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const requests = new RequestLog(path.join(home, "logs", "requests.jsonl"));
    requests.add({ id: "older", at: new Date(Date.now() - 10_000).toISOString(), ms: 150, status: 200, ok: true, kind: "messages", source: "claude", target: "gpt", provider: "chatgpt", stream: true, usage: { input: 20, cached: 80, output: 7 } });
    requests.add({ id: "newer", at: new Date().toISOString(), ms: 250, status: 400, ok: false, kind: "count_tokens", source: "claude", target: "gpt", provider: "chatgpt", stream: false });
    // The test admin owns a separate instance, so add these records through its persisted file then reload it.
    const reloaded = new RequestLog(path.join(home, "logs", "requests.jsonl"));
    const cfg = makeCfg({ admin: { port: 0 } });
    const log = new Logger(null, 1_000_000, 1, false);
    const extra = await startAdmin({ config: () => cfg, configFile: path.join(home, "extra-config.json"), log, stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }), health: () => 0, version: "test", requests: reloaded });
    try {
      const list = await fetch(`${base()}:${extra.port}/api/requests?n=5&kind=messages`);
      assert.deepEqual((await list.json() as { requests: { id: string }[] }).requests.map((r) => r.id), ["older"]);
      const summary = await fetch(`${base()}:${extra.port}/api/requests/summary?since=3600`);
      const body = await summary.json() as { total: { count: number; ok: number; failed: number; cached: number } };
      assert.deepEqual(body.total, { count: 2, ok: 1, failed: 1, input: 20, cached: 80, output: 7, cacheHitPercent: 80, avgMs: 200 });
    } finally {
      extra.close();
    }
  });
});

test("GET /api/logs returns the tail of router.log", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const logDir = path.join(home, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    fs.writeFileSync(path.join(logDir, "router.log"), lines.join("\n") + "\n");
    const res = await fetch(`${base()}:${port}/api/logs?n=3`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(text.trim().split("\n"), ["line-7", "line-8", "line-9"]);
  });
});

test("GET / serves the UI index.html", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /ClaudeRipple/);
    assert.match(text, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
  });
});

test("GET /app.js serves a static file with the right content-type", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  });
});

test("path traversal outside the UI root is blocked", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    // fetch()/undici would normalize %2e%2e client-side; send the raw encoded path so the
    // server actually has to decode-and-check it itself.
    const res = await rawGet(port, "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd");
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body) as { error: string };
    assert.match(body.error, /invalid path/);
  });
});

test("admin binds only to 127.0.0.1", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    // connecting via 127.0.0.1 must work; this just re-confirms the server answers there
    const res = await fetch(`${base()}:${port}/api/status`);
    assert.equal(res.status, 200);
  });
});

test("POST /api/shutdown accepts, then drains", async () => {
  let called = 0;
  await withAdmin(
    makeCfg(),
    async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/shutdown`, { method: "POST" });
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { draining: true });
      assert.equal(called, 1);
    },
    { shutdown: () => void called++ },
  );
});

test("POST /api/shutdown reports 501 when the router supplied no drain hook", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/shutdown`, { method: "POST" });
    assert.equal(res.status, 501);
  });
});

test("a POST carrying another site's Origin is refused", async () => {
  // Binding to loopback does not keep the browser out: a page the user visits can send a simple
  // POST here and CORS hides only the response, not the side effect.
  let called = 0;
  await withAdmin(
    makeCfg(),
    async ({ port }) => {
      for (const origin of ["http://evil.example", "https://claude.ai", "null"]) {
        const res = await fetch(`${base()}:${port}/api/shutdown`, { method: "POST", headers: { origin } });
        assert.equal(res.status, 403, `origin ${origin} must be refused`);
      }
      assert.equal(called, 0, "the drain hook must never run for a cross-site request");
    },
    { shutdown: () => void called++ },
  );
});

test("a POST from the GUI's own origin, or from a non-browser client, is allowed", async () => {
  let called = 0;
  await withAdmin(
    makeCfg(),
    async ({ port }) => {
      const own = await fetch(`${base()}:${port}/api/shutdown`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}` } });
      assert.equal(own.status, 202);
      const localhost = await fetch(`${base()}:${port}/api/shutdown`, { method: "POST", headers: { origin: `http://localhost:${port}` } });
      assert.equal(localhost.status, 202);
      const noOrigin = await fetch(`${base()}:${port}/api/shutdown`, { method: "POST" });
      assert.equal(noOrigin.status, 202);
      assert.equal(called, 3);
    },
    { shutdown: () => void called++ },
  );
});

test("the Origin guard covers the other state-changing endpoints too", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    for (const p of ["/api/picker", "/api/agent-title", "/api/codex", "/api/claude-login", "/api/claude-logout", "/api/claude-accounts/fake", "/api/chatgpt-login", "/api/providers/probe"]) {
      const res = await fetch(`${base()}:${port}${p}`, { method: "POST", headers: { origin: "http://evil.example" } });
      assert.equal(res.status, 403, `${p} must refuse a cross-site POST`);
    }
    // Reading is not gated: a cross-site page cannot see the response anyway.
    const get = await fetch(`${base()}:${port}/api/status`, { headers: { origin: "http://evil.example" } });
    assert.equal(get.status, 200);
  });
});

test("GET /api/claude-models de-duplicates surfaces and drops our own injected ids", async () => {
  // The picker snapshot is taken after injection and the surfaces carry the same catalog, so a
  // naive read lists every model twice and offers GPT ids as mapping sources.
  const cfg = makeCfg({ cli: { extraModels: [{ model: "gpt-5.6-terra", name: "GPT-5.6 Terra" }] } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-picker-dedup-"));
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const entries = [
    { id: "claude-opus-5", name: "Opus 5" },
    { id: "claude-sonnet-5", name: "Sonnet 5" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  ];
  const admin = await startAdmin({
    config: () => cfg,
    configFile,
    log: new Logger(null, 1_000_000, 1, false),
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    health: () => 0,
    version: "0.0.0-test",
    requests: new RequestLog(path.join(home, "logs", "requests.jsonl")),
    picker: () => ({
      enabled: true,
      hosts: ["claude.ai"],
      last: { surfaces: [{ id: "code", entries }, { id: "ccd", entries }] },
    }),
  });
  try {
    const body = (await (await fetch(`${base()}:${admin.port}/api/claude-models`)).json()) as { source: string; models: { id: string }[] };
    assert.equal(body.source, "picker");
    assert.deepEqual(body.models.map((m) => m.id), ["claude-opus-5", "claude-sonnet-5"]);
  } finally {
    admin.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a chatgpt provider with no credentials is not reported as usable", async () => {
  // Reaching chatgpt.com says nothing about being able to call it. Claiming "connected" without a
  // login sends a new user away believing setup is finished (reported from a real install).
  const cfg = makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } });
  await withAdmin(cfg, async ({ port }) => {
    const status = (await (await fetch(`${base()}:${port}/api/status`)).json()) as { providers: Record<string, { needsLogin?: boolean }> };
    assert.equal(status.providers.gpt?.needsLogin, true, "status must say a login is missing");

    const probe = await fetch(`${base()}:${port}/api/providers/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "chatgpt", auth: "own" }),
    });
    const body = (await probe.json()) as { ok: boolean; auth: string; error?: string };
    assert.equal(body.ok, false, "the connection check must not claim success without credentials");
    assert.equal(body.auth, "missing");
    assert.match(body.error ?? "", /credentials/i);
  });
});

/** A chatgpt deps stub whose snapshot ages on command and counts refresh calls. */
function quotaDeps(snapshot: Record<string, unknown> | null) {
  const quota: Record<string, Record<string, unknown> | null> = { gpt: snapshot };
  let calls = 0;
  const fresh = { type: "codex.rate_limits", plan_type: "prolite", rate_limits: { primary: { used_percent: 40, window_minutes: 10080 }, secondary: null }, at: Date.now() };
  return {
    deps: () => ({
      quota,
      auth: { gpt: "own" },
      refresh: async (name: string): Promise<Record<string, unknown> | null> => {
        calls += 1;
        quota[name] = fresh;
        return fresh;
      },
    }),
    calls: () => calls,
    set: (name: string, v: Record<string, unknown> | null): void => {
      quota[name] = v;
    },
  };
}

test("status: a quota snapshot younger than 10 minutes is served as-is, without a lookup", async () => {
  const q = quotaDeps({ type: "codex.rate_limits", plan_type: "prolite", rate_limits: { primary: { used_percent: 1 } }, at: Date.now() - 60_000 });
  await withAdmin(makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } }), async ({ port }) => {
    const body = (await (await fetch(`${base()}:${port}/api/status`)).json()) as { chatgpt: { quota: Record<string, { rate_limits: { primary: { used_percent: number } } }> } };
    assert.equal(q.calls(), 0, "a fresh snapshot must not trigger a lookup");
    assert.equal(body.chatgpt.quota.gpt?.rate_limits.primary.used_percent, 1);
  }, { chatgpt: q.deps });
});

test("status: a snapshot older than 10 minutes (or with no timestamp) is refreshed", async () => {
  const q = quotaDeps({ type: "codex.rate_limits", plan_type: "prolite", rate_limits: { primary: { used_percent: 1 } }, at: Date.now() - 11 * 60_000 });
  await withAdmin(makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } }), async ({ port }) => {
    const body = (await (await fetch(`${base()}:${port}/api/status`)).json()) as { chatgpt: { quota: Record<string, { rate_limits: { primary: { used_percent: number } } }> } };
    assert.equal(q.calls(), 1, "a stale snapshot must trigger one lookup");
    assert.equal(body.chatgpt.quota.gpt?.rate_limits.primary.used_percent, 40);
  }, { chatgpt: q.deps });

  const missing = quotaDeps(null);
  await withAdmin(makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } }), async ({ port }) => {
    await fetch(`${base()}:${port}/api/status`);
    assert.equal(missing.calls(), 1, "no snapshot at all also triggers a lookup");
  }, { chatgpt: missing.deps });
});

test("status: ?refresh=1 always looks up, even when the snapshot is fresh", async () => {
  const q = quotaDeps({ type: "codex.rate_limits", plan_type: "prolite", rate_limits: { primary: { used_percent: 1 } }, at: Date.now() - 1000 });
  await withAdmin(makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } }), async ({ port }) => {
    const body = (await (await fetch(`${base()}:${port}/api/status?refresh=1`)).json()) as { chatgpt: { quota: Record<string, { rate_limits: { primary: { used_percent: number } } }> } };
    assert.equal(q.calls(), 1);
    assert.equal(body.chatgpt.quota.gpt?.rate_limits.primary.used_percent, 40);
  }, { chatgpt: q.deps });
});

test("status: a failed lookup keeps the last value and marks it stale with a reason", async () => {
  const snapshot = { type: "codex.rate_limits", plan_type: "prolite", rate_limits: { primary: { used_percent: 1 } }, at: Date.now() - 11 * 60_000 };
  const q = quotaDeps(snapshot);
  const failing = (): { quota: Record<string, Record<string, unknown> | null>; auth: Record<string, string>; refresh: (name: string) => Promise<Record<string, unknown> | null> } => ({
    ...q.deps(),
    refresh: async (): Promise<Record<string, unknown> | null> => null,
  });
  await withAdmin(makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } }), async ({ port }) => {
    const body = (await (await fetch(`${base()}:${port}/api/status`)).json()) as { chatgpt: { quota: Record<string, { rate_limits: { primary: { used_percent: number } } }>; stale?: boolean; staleReason?: Record<string, string> } };
    assert.equal(body.chatgpt.quota.gpt?.rate_limits.primary.used_percent, 1, "last good value survives a failed lookup");
    assert.equal(body.chatgpt.stale, true);
    assert.match(body.chatgpt.staleReason?.gpt ?? "", /failed/i);
  }, { chatgpt: failing });
});

test("status: two concurrent polls share one lookup", async () => {
  const q = quotaDeps({ type: "codex.rate_limits", plan_type: "prolite", rate_limits: { primary: { used_percent: 1 } }, at: 0 });
  // The stub resolves on a later tick so both requests are in flight together; the admin-side
  // dedupe lives in the adapter's shared promise (tested there), so this asserts the route path.
  await withAdmin(makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } }), async ({ port }) => {
    await Promise.all([fetch(`${base()}:${port}/api/status`), fetch(`${base()}:${port}/api/status`)]);
    assert.ok(q.calls() >= 1);
  }, { chatgpt: q.deps });
});

/**
 * The measurement job: several small upstream requests per model, so it runs detached and the caller
 * polls. These tests drive it with a `measureFetch` stub, so no socket leaves the process.
 */
async function pollMeasure(port: number, jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base()}:${port}/api/providers/measure/${jobId}`);
    const job = (await res.json()) as { state: string };
    if (job.state !== "running") return job as unknown as Record<string, unknown>;
    await new Promise((resolveP) => setTimeout(resolveP, 5));
  }
  throw new Error("measure job never finished");
}

/** Each wire names the effort differently — `reasoning_effort` on Chat, `reasoning.effort` on
 * Responses, `output_config.effort` on Anthropic Messages — so a stub reads whichever is there. */
type StubBody = { reasoning_effort?: string; reasoning?: { effort?: string }; output_config?: { effort?: string } };

function stubFetch(status: (url: string, body: StubBody) => number): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) as StubBody : {};
    return new Response(JSON.stringify({}), { status: status(url, body) });
  };
}

// Measured 2026-09-22: a free-tier OpenCode account answers 403 FreeTierError, "OpenCode's free
// tier can only be used from within OpenCode". Every 403 read as a bad key, so the screen told the
// operator to check a key that was working and never mentioned the plan that had refused it.
test("a 403 that names the plan is reported as the plan, not as a bad key", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "claude-fable-5" }] }));
      return;
    }
    res.writeHead(403, { "content-type": "application/json" })
      .end(JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }));
  });
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "openai-compatible", url: `http://127.0.0.1:${address.port}/v1`, headers: { authorization: "Bearer sk-test" } }),
      });
      const out = (await res.json()) as { ok: boolean; auth: string; error?: string };
      assert.equal(out.ok, false);
      assert.equal(out.auth, "not-entitled", "the credential was accepted; the plan was not");
      assert.match(out.error ?? "", /FreeTierError/, "the vendor's own words reach the screen");
    });
  } finally { upstream.close(); }
});

// A 403 with nothing about a plan in it is still what it always was.
test("a bare 403 is still reported as a bad key", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m" }] }));
      return;
    }
    res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Forbidden" } }));
  });
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "openai-compatible", url: `http://127.0.0.1:${address.port}/v1`, headers: { authorization: "Bearer sk-test" } }),
      });
      assert.equal(((await res.json()) as { auth: string }).auth, "bad-key");
    });
  } finally { upstream.close(); }
});

test("POST /api/providers/measure runs in the background and polling settles the wire into the config", async () => {
  const cfg = makeCfg({
    providers: {
      oc: {
        type: "openai-compatible",
        url: "http://127.0.0.1:9/v1",
        wire: "responses",
        headers: { authorization: "Bearer sk-test" },
        caps: { reasoning: "effort", effortLevels: ["none", "low", "minimal"] },
        models: [{ id: "mimo", name: "MiMo" }],
      },
    },
  });
  // The provider's own wire (Responses) is unavailable for this model, Chat answers, and the vendor
  // takes only these levels — exactly the mimo-v2.6-pro shape measured 2026-09-22. Every level the
  // measurement knows of is offered, so what comes back is the endpoint's answer, not the config's.
  const takes = new Set(["none", "low", "medium", "high"]);
  const measureFetch = stubFetch((url, body) =>
    url.endsWith("/responses") ? 503
      : body.reasoning_effort === undefined || takes.has(String(body.reasoning_effort)) ? 200 : 400);
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "oc", models: ["mimo"] }),
    });
    assert.equal(started.status, 202);
    const { jobId, total } = (await started.json()) as { jobId: string; total: number };
    assert.equal(typeof jobId, "string");
    assert.equal(total, 1);
    const job = await pollMeasure(port, jobId);
    assert.equal(job.state, "done");
    assert.equal(job.done, 1);
    assert.equal(job.total, 1);
    assert.deepEqual(job.results, [{ id: "mimo", wire: "chat", effortLevels: ["none", "low", "medium", "high"] }]);
    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf8")) as Config;
    assert.equal(onDisk.providers.oc?.models?.[0]?.wire, "chat");
    // `medium` and `high` are in although the provider declared neither: a measurement corrects the
    // configuration in both directions, or a level the plan really offers stays out of reach.
    assert.deepEqual(onDisk.providers.oc?.models?.[0]?.effortLevels, ["none", "low", "medium", "high"]);
  }, { measureFetch });
});

test("measurement fills blank fields but never overwrites a wire or ladder the user already set", async () => {
  const cfg = makeCfg({
    providers: {
      oc: {
        type: "openai-compatible",
        url: "http://127.0.0.1:9/v1",
        wire: "responses",
        headers: { authorization: "Bearer sk-test" },
        caps: { reasoning: "effort", effortLevels: ["none", "low"] },
        models: [
          { id: "muse", name: "Muse", wire: "responses", effortLevels: ["none"] },
          { id: "fresh", name: "Fresh" },
        ],
      },
    },
  });
  const takes = new Set(["none", "low"]);
  // This provider stays on its own Responses wire, which carries the level as `reasoning.effort`.
  const measureFetch = stubFetch((_url, body) => {
    const level = body.reasoning?.effort;
    return level === undefined || takes.has(level) ? 200 : 400;
  });
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "oc", models: ["muse", "fresh"] }),
    });
    assert.equal(started.status, 202);
    await pollMeasure(port, ((await started.json()) as { jobId: string }).jobId);
    const models = (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers.oc!.models!;
    const muse = models.find((m) => m.id === "muse")!;
    const fresh = models.find((m) => m.id === "fresh")!;
    assert.equal(muse.wire, "responses", "an explicit wire is the user's, not the measurement's, to change");
    assert.deepEqual(muse.effortLevels, ["none"], "an explicit ladder is left as it was");
    assert.equal(fresh.wire, "responses");
    assert.deepEqual(fresh.effortLevels, ["none", "low"], "the blank fields are the ones filled");
  }, { measureFetch });
});

test("a preset provider measures across the wires the preset declares, the provider's own first", async () => {
  const cfg = makeCfg({
    providers: {
      "opencode-go": {
        type: "openai-compatible",
        url: "https://opencode.ai/zen/go/v1",
        wire: "responses",
        preset: "opencode-go",
        sessionHeader: "x-opencode-session",
        headers: { authorization: "Bearer sk-test" },
        caps: { reasoning: "effort", effortLevels: ["none", "low"] },
        models: [{ id: "glm-new", name: "GLM New" }],
      },
    },
  });
  // The Responses wire the preset puts first does not serve this model; the Chat one does.
  const seen: string[] = [];
  const measureFetch = async (url: string, _init: RequestInit): Promise<Response> => {
    seen.push(url);
    return new Response("{}", { status: url.endsWith("/chat/completions") ? 200 : 503 });
  };
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "opencode-go", models: ["glm-new"] }),
    });
    await pollMeasure(port, ((await started.json()) as { jobId: string }).jobId);
    assert.equal(seen[0], "https://opencode.ai/zen/go/v1/responses", "the provider's own wire is tried first");
    const model = (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers["opencode-go"]!.models![0]!;
    assert.equal(model.wire, "chat");
  }, { measureFetch });
});

// Order decides the answer, because the first wire to reply wins. Measured 2026-09-22: minimax-m3
// answers on Chat Completions as well as on Anthropic Messages, so trying the catalogue in its own
// order settled it as `chat` and overruled the `anthropic` the preset had recorded for it.
test("a model the preset already places is measured on that wire first, even when another would answer", async () => {
  const cfg = makeCfg({
    providers: {
      "opencode-go": {
        type: "openai-compatible",
        url: "https://opencode.ai/zen/go/v1",
        wire: "responses",
        preset: "opencode-go",
        sessionHeader: "x-opencode-session",
        headers: { authorization: "Bearer sk-test" },
        caps: { reasoning: "effort", effortLevels: [] },
        models: [{ id: "minimax-m3", name: "MiniMax M3" }],
      },
    },
  });
  // Everything answers, so nothing but the order can decide which wire is recorded.
  const seen: string[] = [];
  const measureFetch = async (url: string, _init: RequestInit): Promise<Response> => {
    seen.push(url);
    return new Response("{}", { status: 200 });
  };
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "opencode-go", models: ["minimax-m3"] }),
    });
    await pollMeasure(port, ((await started.json()) as { jobId: string }).jobId);
    assert.equal(seen[0], "https://opencode.ai/zen/go/v1/messages", "the preset's own placement is tried before the provider default");
    assert.equal(seen.length, 1, "a wire that answers ends the search");
    const model = (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers["opencode-go"]!.models![0]!;
    assert.equal(model.wire, "anthropic");
  }, { measureFetch });
});

test("an auth failure in measurement writes nothing: the wire is not guessed", async () => {
  const cfg = makeCfg({
    providers: {
      oc: {
        type: "openai-compatible",
        url: "http://127.0.0.1:9/v1",
        headers: { authorization: "Bearer sk-test" },
        models: [{ id: "bad", name: "Bad" }],
      },
    },
  });
  const measureFetch = stubFetch(() => 401);
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "oc", models: ["bad"] }),
    });
    const job = await pollMeasure(port, ((await started.json()) as { jobId: string }).jobId);
    assert.deepEqual(job.results, [{ id: "bad", error: "auth" }]);
    const model = (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers.oc!.models![0]!;
    assert.equal("wire" in model, false);
    assert.equal("effortLevels" in model, false);
  }, { measureFetch });
});

test("POST /api/providers/measure refuses a provider that has no OpenAI or Anthropic wire", async () => {
  await withAdmin(makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } }), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "gpt", models: ["x"] }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not openai-compatible or anthropic-compatible/);
  });
});

test("GET /api/providers/measure/<id> reports an unknown job as 404", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/providers/measure/deadbeef`);
    assert.equal(res.status, 404);
  });
});
