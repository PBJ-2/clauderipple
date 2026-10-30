import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, type Config, type ProviderModel } from "../src/config.ts";
import { Logger } from "../src/log.ts";
import { backfillContextWindows, effortLevelsForModel, googleHealth, measureUnsettledModels, parseUpdateCheck, startAdmin, type AdminDeps, type LimitsProvider } from "../src/admin.ts";
import type { ImageRequest } from "../src/providers/chatgpt/index.ts";
import type { GoogleAccountStatus } from "../src/providers/google/index.ts";
import type { QuotaGroup } from "../src/providers/google/usage.ts";
import type { OpenCodeWindow } from "../src/providers/opencode-usage.ts";
import { RequestLog } from "../src/requestlog.ts";
import { PRESETS } from "../src/presets.ts";
import { saveClaudeAuthFile, saveClaudeOAuthFile } from "../src/providers/anthropic-token-file.ts";
import { listClaudeAccounts, markClaudeAccountNeedsReauth, readClaudeAccountsFile, saveClaudeOAuthAccount, subjectHash } from "../src/providers/anthropic-accounts.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import type { ModOptions } from "../src/admin.ts";
import type { ModSettingsSnapshot } from "../src/mod-settings.ts";
import { MOD_SETTINGS_SCHEMA_VERSION, normalizeSettings } from "../../mod/hooks/settings.ts";

function makeCfg(overrides: Partial<Config> = {}): Config {
  // port 0: let the OS pick a free ephemeral port so parallel tests never collide.
  return { ...DEFAULTS, admin: { port: 0 }, ...overrides };
}

const noClaudeCodeCredentialReaders = { keychain: () => null, credentialsFile: () => null };

async function withAdmin(
  cfgInit: Config,
  fn: (ctx: { port: number; configFile: string; home: string; setCfg: (c: Config) => void }) => Promise<void>,
  extraDeps: {
    agentDir?: string;
    credentials?: NonNullable<AdminDeps["credentials"]>;
    clearCredentialCooldown?: NonNullable<AdminDeps["clearCredentialCooldown"]>;
    claudeClearCooldown?: NonNullable<AdminDeps["claudeClearCooldown"]>;
    providerHealth?: NonNullable<AdminDeps["providerHealth"]>;
    modelHealth?: NonNullable<AdminDeps["modelHealth"]>;
    shutdown?: () => void;
    instance?: NonNullable<AdminDeps["instance"]>;
    runCli?: (args: string[], timeout?: number) => Promise<{ ok: boolean; output: string }>;
    startCliDetached?: (args: string[], log: string) => void;
    claudeOAuthFetch?: (url: string, init: RequestInit) => Promise<Response>;
    openBrowser?: (url: string) => boolean;
    observedClaudeCodeAuth?: ObservedClaudeCodeAuth;
    probeFetch?: (url: string, init: RequestInit) => Promise<Response>;
    measureFetch?: (url: string, init: RequestInit) => Promise<Response>;
    modelCatalog?: () => Promise<unknown>;
    modelScoresFetch?: typeof fetch;
    configErrors?: NonNullable<AdminDeps["configErrors"]>;
    chatgpt?: NonNullable<AdminDeps["chatgpt"]>;
    google?: NonNullable<AdminDeps["google"]>;
    opencodeUsage?: NonNullable<AdminDeps["opencodeUsage"]>;
    claudeUsage?: NonNullable<AdminDeps["claudeUsage"]>;
    claudeIdentity?: NonNullable<AdminDeps["claudeIdentity"]>;
    googleOAuthFetch?: (url: string, init?: RequestInit) => Promise<Response>;
    googleOAuthPort?: number;
  } = {},
): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-admin-"));
  const prevHome = process.env.CLAUDERIPPLE_HOME;
  const prevSettings = process.env.CLAUDE_SETTINGS_PATH;
  process.env.CLAUDERIPPLE_HOME = home;
  // Saving admin config also syncs the Claude client settings (syncModelSlotsForGui). With only
  // CLAUDERIPPLE_HOME isolated, `npm test` wrote HTTPS_PROXY and a NODE_EXTRA_CA_CERTS pointing into
  // this temp dir into the real ~/.claude/settings.json, then deleted the dir: every new Code
  // session on that machine failed with ECONNREFUSED (measured 2026-09-24, Ubuntu 24.04).
  process.env.CLAUDE_SETTINGS_PATH = path.join(home, "claude-settings.json");
  let admin: Awaited<ReturnType<typeof startAdmin>> | undefined;
  try {
    const configFile = path.join(home, "config.json");
    fs.writeFileSync(configFile, JSON.stringify(cfgInit, null, 2));
    let cfg = cfgInit;
    const log = new Logger(null, 1_000_000, 1, false);
    admin = await startAdmin({
      config: () => cfg,
      configFile,
      log,
      stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 1, completed: 1, failed: 0 }),
      health: () => 0,
      version: "0.0.0-test",
      requests: new RequestLog(path.join(home, "logs", "requests.jsonl")),
      claudeCodeCredentialReaders: noClaudeCodeCredentialReaders,
      ...extraDeps,
    });
    await fn({ port: admin.port, configFile, home, setCfg: (c) => (cfg = c) });
  } finally {
    admin?.close();
    if (prevHome === undefined) delete process.env.CLAUDERIPPLE_HOME;
    else process.env.CLAUDERIPPLE_HOME = prevHome;
    if (prevSettings === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
    else process.env.CLAUDE_SETTINGS_PATH = prevSettings;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const base = () => `http://127.0.0.1`;

for (const kind of ["chatgpt", "claude", "google"]) {
  test(`${kind} account HTTP controls validate, persist one preference, pause, resume and clear cooldown`, async () => {
    const cleared: string[] = [];
    await withAdmin(makeCfg(), async ({ port, home }) => {
      const chatgpt = await import("../src/providers/chatgpt/accounts.ts");
      const google = await import("../src/providers/google/accounts.ts");
      const add = (name: string): string => {
        const grant = { accessToken: `test-${name}`, refreshToken: `test-refresh-${name}`, expiresAt: Date.now() + 3_600_000, accountId: name };
        if (kind === "chatgpt") return chatgpt.saveChatGptAccount(home, grant).id;
        if (kind === "google") return google.saveGoogleAccount(home, { ...grant, projectId: name, email: `${name}@example.test` }).id;
        return saveClaudeOAuthAccount(home, grant).id;
      };
      const a = add("a");
      const b = add("b");
      const endpoint = `${base()}:${port}/api/${kind}-accounts`;
      const patch = (id: string, body: unknown) => fetch(`${endpoint}/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const rows = async () => (await (await fetch(endpoint)).json() as { accounts: { id: string; paused: boolean; preferred: boolean; inUse: boolean; state: string }[] }).accounts;
      assert.equal((await patch(b, { preferred: true })).status, 200);
      assert.equal((await rows()).find((row) => row.id === b)?.inUse, true);
      assert.equal((await patch(a, { preferred: true })).status, 200);
      assert.deepEqual((await rows()).filter((row) => row.preferred).map((row) => row.id), [a]);
      assert.equal((await patch(b, { preferred: false })).status, 200);
      assert.equal((await rows()).find((row) => row.id === a)?.preferred, true);
      assert.equal((await patch(a, { paused: true, clearCooldown: true })).status, 200);
      assert.deepEqual(cleared, [a]);
      const paused = (await rows()).find((row) => row.id === a)!;
      assert.equal(paused.paused, true);
      assert.equal(paused.inUse, false);
      assert.equal(paused.state, "paused");
      assert.equal((await rows()).find((row) => row.id === b)?.inUse, true);
      for (const invalid of [null, { preferred: "true" }, { paused: 1 }, { clearCooldown: false }]) assert.equal((await patch(a, invalid)).status, 400);
      assert.equal((await patch(a, { paused: false })).status, 200);
      assert.equal((await rows()).find((row) => row.id === a)?.inUse, true);
      assert.equal((await patch(a, { preferred: false })).status, 200);
      assert.equal((await rows()).some((row) => row.preferred), false);
      assert.equal((await patch("00000000-0000-4000-8000-000000000000", { clearCooldown: true })).status, 404);
    }, {
      claudeClearCooldown: (id) => { cleared.push(id); },
      chatgpt: () => ({ quota: {}, auth: {}, clearCooldown: (id) => { cleared.push(id); } }),
      google: () => ({ accounts: () => ({}), clearCooldown: (id) => { cleared.push(id); } }),
    });
  });
}

test("PUT /api/config persists credential control flags and refuses invalid or duplicate preferences", async () => {
  const cfg = makeCfg({ providers: { p: { type: "anthropic-compatible", url: "http://127.0.0.1:1", credentials: [{ id: "a", headers: {}, preferred: true, paused: true }] } } });
  await withAdmin(cfg, async ({ port, configFile }) => {
    const put = (value: unknown) => fetch(`${base()}:${port}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    assert.equal((await put(cfg)).status, 200);
    const saved = fs.readFileSync(configFile, "utf8");
    assert.deepEqual((JSON.parse(saved) as Config).providers, cfg.providers);
    for (const credentials of [
      [{ id: "a", headers: {}, preferred: "yes" }],
      [{ id: "a", headers: {}, paused: 1 }],
      [{ id: "a", headers: {}, preferred: true }, { id: "b", headers: {}, preferred: true }],
    ]) {
      assert.equal((await put({ ...cfg, providers: { p: { type: "openai-compatible", url: "http://127.0.0.1:1", credentials } } })).status, 400);
      assert.equal(fs.readFileSync(configFile, "utf8"), saved, "invalid edits leave the stored config unchanged");
    }
  });
});

test("credential cooldown HTTP endpoint clears one key and status exposes all three control flags", async () => {
  const { CredentialPool } = await import("../src/pool.ts");
  const entries = [{ id: "default", headers: {}, preferred: true, paused: false }, { id: "b", headers: {}, paused: true }];
  const pool = new CredentialPool();
  pool.penalise("p", "default", 429, 60_000);
  pool.penalise("p", "b", 401);
  await withAdmin(makeCfg({ providers: { p: { type: "openai-compatible", url: "http://127.0.0.1:1", credentials: entries } } }), async ({ port }) => {
    const url = `${base()}:${port}`;
    const post = (body: unknown) => fetch(`${url}/api/credentials/clear-cooldown`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const status = async () => (await (await fetch(`${url}/api/status`)).json() as { credentials: Record<string, ReturnType<typeof pool.report>> });
    assert.equal((await post({ provider: "p", id: "default" })).status, 200);
    assert.deepEqual(pool.report("p", entries).map((row) => [row.state, row.paused, row.preferred, row.inUse]), [["ready", false, true, true], ["quarantined", true, false, false]]);
    const result = await status();
    assert.deepEqual(result.credentials, { p: pool.report("p", entries) });
    assert.equal((await post({ provider: "p", id: "missing" })).status, 404);
    assert.equal((await post({ provider: "missing", id: "default" })).status, 404);
    assert.equal((await post({ provider: true, id: "default" })).status, 400);
    assert.equal((await post(null)).status, 400);
  }, { credentials: () => ({ p: pool.report("p", entries) }), clearCredentialCooldown: (provider, id) => pool.clear(provider, id) });
});

test('status and ladder options expose retirement without disabling sibling models (#94)', async () => {
  const { ModelHealth, modelDeprecation } = await import('../src/health.ts');
  const health = new ModelHealth();
  health.observe('p', 'retired', modelDeprecation(410, 'ModelDeprecated', 100));
  assert.equal(modelDeprecation(410, 'endpoint gone'), undefined);
  assert.equal(modelDeprecation(429, 'ModelDeprecated'), undefined);
  assert.equal(modelDeprecation(404, 'thread_not_found'), undefined);
  assert.equal(modelDeprecation(404, 'model_not_found'), undefined, 'a key without access is not a retirement');
  assert.equal(modelDeprecation(404, 'Model x has been deprecated.')?.reason, 'model_deprecated');
  const cfg = makeCfg({ providers: { p: { type: 'anthropic-compatible', url: 'http://127.0.0.1:1', models: [{ id: 'retired' }, { id: 'active' }] } } });
  await withAdmin(cfg, async ({ port }) => {
    const options = await (await fetch(`${base()}:${port}/api/mod-options`)).json() as ModOptions;
    assert.equal(options.providers[0]?.usable, true);
    assert.deepEqual(options.providers[0]?.models, { retired: { reason: 'model_deprecated', exhaustedAt: 100 } });
    const status = await (await fetch(`${base()}:${port}/api/status`)).json() as { providers: Record<string, { models: unknown }> };
    assert.deepEqual(status.providers.p?.models, { retired: { usable: false, reason: 'model_deprecated', at: 100 } });
  }, { modelHealth: () => health.snapshot(), modelScoresFetch: async () => new Response('{}') });
  assert.deepEqual(new ModelHealth().snapshot(), {}, 'a router restart clears retirement');
});

test("mod options and status expose runtime provider exhaustion and clear it on recovery", async () => {
  const { ProviderHealth, providerExhaustion } = await import('../src/health.ts');
  const health = new ProviderHealth();
  health.observe('deepseek', 402, providerExhaustion(402, 'Insufficient Balance'));
  const cfg = makeCfg({ providers: { deepseek: { type: 'anthropic-compatible', url: 'http://127.0.0.1:1' } } });
  await withAdmin(cfg, async ({ port }) => {
    const options = await (await fetch(`${base()}:${port}/api/mod-options`)).json() as ModOptions;
    assert.equal(options.providers[0]?.usable, false);
    assert.equal(options.providers[0]?.reason, 'insufficient_balance');
    assert.ok(options.providers[0]?.exhaustedAt);
    const status = await (await fetch(`${base()}:${port}/api/status`)).json() as { providers: Record<string, { usable: boolean; exhaustion?: { reason: string } }> };
    assert.equal(status.providers.deepseek?.usable, false);
    assert.equal(status.providers.deepseek?.exhaustion?.reason, 'insufficient_balance');
    health.observe('deepseek', 200);
    const recovered = await (await fetch(`${base()}:${port}/api/mod-options`)).json() as ModOptions;
    assert.equal(recovered.providers[0]?.usable, true);
    assert.equal(recovered.providers[0]?.reason, undefined);
  }, { providerHealth: () => health.snapshot(), modelScoresFetch: async () => new Response('{}') });
});

test("mod options leave an OpenCode Go provider out only while every key's plan is spent (#95)", async () => {
  const cfg = makeCfg({ providers: {
    go: {
      type: "openai-compatible", preset: "opencode-go", url: "https://opencode.ai/zen/go/v1",
      headers: { authorization: "Bearer hidden-default-key" },
      credentials: [
        { id: "key-a", headers: { authorization: "Bearer hidden-a" } },
        { id: "key-b", headers: { authorization: "Bearer hidden-b" } },
      ],
      models: [{ id: "deepseek-v4.1-flash" }],
    },
  } });
  const weekly = (percent: number, resetAt: number): OpenCodeWindow => ({ kind: "seven_day", used_percent: percent, window_minutes: 10080, reset_at: resetAt });
  const soon = Math.round((Date.now() + 3_600_000) / 1000);
  const later = Math.round((Date.now() + 7_200_000) / 1000);
  // keyed by the credential id the router's own `/api/limits` read uses.
  let windows: Record<string, OpenCodeWindow[]> = {};
  await withAdmin(cfg, async ({ port }) => {
    const go = async () => ((await (await fetch(`${base()}:${port}/api/mod-options`)).json()) as ModOptions).providers.find((p) => p.name === "go")!;
    // One key still has room: rotation serves the work, so the provider stays in the ladder.
    windows = { "key-a": [weekly(100, soon)], "key-b": [weekly(40, later)] };
    assert.equal((await go()).usable, true);
    assert.equal((await go()).reason, undefined);
    // Every key is spent: the provider leaves the ladder until the first key's window resets.
    windows = { "key-a": [weekly(100, soon), { kind: "five_hour", used_percent: 20, window_minutes: 300 }], "key-b": [weekly(100, later)] };
    const out = await go();
    assert.equal(out.usable, false);
    assert.equal(out.reason, "quota_exhausted");
    const back = out.exhaustedUntil ?? 0;
    assert.ok(back > Date.now() && back <= Date.now() + 3_600_000 + 5_000, `key-a's weekly reset lifts it first (${back - Date.now()} ms)`);
    // A spent five-hour window alone is just as final as the weekly one.
    windows = { "key-a": [{ kind: "five_hour", used_percent: 100, window_minutes: 300, reset_at: soon }], "key-b": [weekly(100, later)] };
    assert.equal((await go()).usable, false);
    // A window whose reset already passed is no evidence: the next read will carry the new percent.
    windows = { "key-a": [weekly(100, Math.round((Date.now() - 60_000) / 1000))], "key-b": [weekly(100, later)] };
    assert.equal((await go()).usable, true);
    // Unknown usage — an empty answer, or one key's read missing — keeps today's answer.
    windows = {};
    assert.equal((await go()).usable, true);
    windows = { "key-a": [weekly(100, soon)] };
    assert.equal((await go()).usable, true);
  }, { opencodeUsage: async (_name: string, credentialId?: string) => windows[credentialId ?? ""] ?? [], modelScoresFetch: async () => new Response("{}") });
});

test("mod options count a stored Claude account as signed in when Claude Code's own login is not seen", async () => {
  const cfg = makeCfg({ providers: { native: { type: "anthropic", auth: "claude-code" } } });
  await withAdmin(cfg, async ({ port, home }) => {
    const usable = async () => ((await (await fetch(`${base()}:${port}/api/mod-options`)).json()) as ModOptions).providers.find((p) => p.name === "native")?.usable;
    // An access token already past its expiry still counts: the pool refreshes it before the turn.
    const account = saveClaudeOAuthAccount(home, { accessToken: "mod-access", refreshToken: "mod-refresh", expiresAt: Date.now() - 1, accountId: "mod-account", email: "mod@example.test" });
    assert.equal(await usable(), true);
    markClaudeAccountNeedsReauth(home, account.id, "mod-refresh");
    assert.equal(await usable(), false, "an account that must sign in again serves nothing");
  }, { modelScoresFetch: async () => new Response("{}") });
});

test("mod options with a Claude account pool still follow the pool's own state", async () => {
  const cfg = makeCfg({ providers: { native: { type: "anthropic", auth: "claude-code", accountPool: true } } });
  let row = { id: "a", state: "ready", failures: 0, paused: false };
  await withAdmin(cfg, async ({ port, home }) => {
    const usable = async () => ((await (await fetch(`${base()}:${port}/api/mod-options`)).json()) as ModOptions).providers.find((p) => p.name === "native")?.usable;
    // Expired but refreshable: the pool reports it ready, so the mod keeps the worker.
    saveClaudeOAuthAccount(home, { accessToken: "pool-access", refreshToken: "pool-refresh", expiresAt: Date.now() - 1, accountId: "pool-account", email: "pool@example.test" });
    assert.equal(await usable(), true);
    row = { ...row, paused: true };
    assert.equal(await usable(), false, "a paused pool serves nothing even with a stored account");
  }, { credentials: () => ({ native: [row] }), modelScoresFetch: async () => new Response("{}") });
});

test("mod options take a spent Antigravity quota group's models out, not the provider", async () => {
  const models = ['gemini-3.8-flash', 'claude-opus-5-5-medium', 'claude-sonnet-5-5-low'].map(id => ({ id }));
  const cfg = makeCfg({ providers: { google: { type: 'google', auth: 'antigravity', models } } });
  const ready = { id: 'a', label: 'a', email: 'a@example.test', projectId: 'p', expiresAt: 0, needsReauth: false, paused: false, state: 'ready', active: true } as GoogleAccountStatus;
  // The adapter's own answer for where each model's quota is counted: its group on the host it goes to.
  const DAILY_3P = '3p@daily-cloudcode-pa.googleapis.com';
  const scopes: Record<string, string> = { 'gemini-3.8-flash': 'gemini@daily-cloudcode-pa.googleapis.com', 'claude-opus-5-5-medium': DAILY_3P, 'claude-sonnet-5-5-low': DAILY_3P };
  let accounts: GoogleAccountStatus[] = [{ ...ready, quotaCooldowns: { [DAILY_3P]: 600 } }];
  await withAdmin(cfg, async ({ port }) => {
    const read = async () => (await (await fetch(`${base()}:${port}/api/mod-options`)).json() as ModOptions).providers.find(p => p.name === 'google')!;
    const google = await read();
    assert.equal(google.usable, true, 'Gemini still answers, so the provider stays in the ladder');
    assert.equal(google.reason, undefined);
    assert.deepEqual(Object.keys(google.models ?? {}).sort(), ['claude-opus-5-5-medium', 'claude-sonnet-5-5-low']);
    assert.equal(google.models?.['claude-opus-5-5-medium']?.reason, 'quota_exhausted');
    assert.ok((google.models?.['claude-opus-5-5-medium']?.exhaustedUntil ?? 0) > Date.now() + 590_000);
    // Only when every account in rotation rests the group: a second account with Claude quota keeps it.
    accounts = [{ ...ready, quotaCooldowns: { [DAILY_3P]: 600 } }, { ...ready, id: 'b' }];
    assert.equal((await read()).models, undefined);
    // A paused account is not in rotation, so it neither keeps nor spends the group.
    accounts = [{ ...ready, quotaCooldowns: { [DAILY_3P]: 600 } }, { ...ready, id: 'b', state: 'paused', paused: true }];
    assert.ok((await read()).models?.['claude-sonnet-5-5-low']);
    // Cleared on the dashboard (or reset): the models are back at once.
    accounts = [ready];
    assert.equal((await read()).models, undefined);
  }, { google: () => ({ accounts: () => ({ google: accounts }), quotaScope: (_name: string, model: string) => scopes[model] }), modelScoresFetch: async () => new Response('{}') });
});

test("a quota group spent on one host leaves the models that go to the other host in the ladder", async () => {
  const models = ['claude-opus-5-5-medium', 'claude-sonnet-5-5-low'].map(id => ({ id }));
  const cfg = makeCfg({ providers: { google: { type: 'google', auth: 'antigravity', models } } });
  const ready = { id: 'a', label: 'a', email: 'a@example.test', projectId: 'p', expiresAt: 0, needsReauth: false, paused: false, state: 'ready', active: true } as GoogleAccountStatus;
  const scopes: Record<string, string> = { 'claude-opus-5-5-medium': '3p@daily-cloudcode-pa.googleapis.com', 'claude-sonnet-5-5-low': '3p@cloudcode-pa.googleapis.com' };
  const accounts = [{ ...ready, quotaCooldowns: { '3p@daily-cloudcode-pa.googleapis.com': 600 } }];
  await withAdmin(cfg, async ({ port }) => {
    const google = (await (await fetch(`${base()}:${port}/api/mod-options`)).json() as ModOptions).providers.find(p => p.name === 'google')!;
    assert.deepEqual(Object.keys(google.models ?? {}), ['claude-opus-5-5-medium'], "prod's Claude/GPT quota is counted apart from daily's");
  }, { google: () => ({ accounts: () => ({ google: accounts }), quotaScope: (_name: string, model: string) => scopes[model] }), modelScoresFetch: async () => new Response('{}') });
});

test("a group's return counts an account that is only cooling: the soonest of each account's later rest", async () => {
  const cfg = makeCfg({ providers: { google: { type: 'google', auth: 'antigravity', models: [{ id: 'claude-opus-5-5-medium' }] } } });
  const ready = { id: 'a', label: 'a', email: 'a@example.test', projectId: 'p', expiresAt: 0, needsReauth: false, paused: false, state: 'ready', active: true } as GoogleAccountStatus;
  const DAILY_3P = '3p@daily-cloudcode-pa.googleapis.com';
  // A's group rests four hours; B still has Claude quota but its own account rests ten seconds.
  let accounts: GoogleAccountStatus[] = [{ ...ready, quotaCooldowns: { [DAILY_3P]: 14_400 } }, { ...ready, id: 'b', state: 'cooling', cooldownSeconds: 10 }];
  await withAdmin(cfg, async ({ port }) => {
    const until = async () => ((await (await fetch(`${base()}:${port}/api/mod-options`)).json()) as ModOptions).providers.find(p => p.name === 'google')!.models?.['claude-opus-5-5-medium']?.exhaustedUntil;
    const back = (await until()) ?? 0;
    assert.ok(back > Date.now() && back <= Date.now() + 10_000, `back with B in about ten seconds, not four hours (${back - Date.now()} ms)`);
    // B cooling longer than its own group rest: the later of the two is when B takes the group again.
    accounts = [{ ...ready, quotaCooldowns: { [DAILY_3P]: 14_400 } }, { ...ready, id: 'b', state: 'cooling', cooldownSeconds: 60, quotaCooldowns: { [DAILY_3P]: 300 } }];
    const later = (await until()) ?? 0;
    assert.ok(later > Date.now() + 290_000 && later <= Date.now() + 300_000, `B's group rest outlasts its own (${later - Date.now()} ms)`);
  }, { google: () => ({ accounts: () => ({ google: accounts }), quotaScope: () => DAILY_3P }), modelScoresFetch: async () => new Response('{}') });
});

const putModSettings = (port: number, body: unknown) => fetch(`${base()}:${port}/api/mod-settings`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, ...(body as Record<string, unknown>) }),
});

test("admin mod-settings rejects an old session's full empty/default overwrite even at the current revision", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const steps = [{ target: { agent: "first" }, effort: "high" }, { target: { agent: "second" }, effort: "medium" }];
    const settings = normalizeSettings({ rules: { general: { mode: "ladder", rungs: { light: steps, standard: steps, hard: steps, plan: steps } } }, modes: [{ id: "saved", name: "Saved mode", rungs: { hard: steps }, delegation: "eager", until: "none" }], activeMode: "saved" });
    const file = path.join(home, "mod-settings.json");
    const original = JSON.stringify({ settings, revision: 9, stored: true });
    fs.writeFileSync(file, original);
    // Pre-a931858 reads Step[] as no Step. An unrelated toggle PUTs empty rungs,
    // and the admin fill used to turn that into a complete default overwrite.
    for (const lost of [{ ...settings, rules: { general: { mode: "ladder", rungs: {} } }, modes: [] }, normalizeSettings(null)]) {
      const response = await putModSettings(port, { settings: lost, revision: 9, schemaVersion: undefined });
      assert.equal(response.status, 426);
      assert.equal(fs.readFileSync(file, "utf8"), original);
    }
  });
});

test("admin mod-settings keeps ten exact previous files and refuses unsupported schemas without backups", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const file = path.join(home, "mod-settings.json");
    const previous = new Map<number, string>();
    // An old file need not be normalized or formatted like today's serializer.
    fs.writeFileSync(file, '{"revision":1,"settings":{"language":"pt","future":"preserve in backup"}}');
    for (let revision = 1; revision <= 12; revision++) {
      previous.set(revision, fs.readFileSync(file, "utf8"));
      const response = await putModSettings(port, { settings: { language: "ko" }, revision });
      assert.equal(response.status, 200);
    }
    const names = fs.readdirSync(home).filter(name => name.startsWith("mod-settings.json.bak-"));
    assert.equal(names.length, 10);
    for (let revision = 3; revision <= 12; revision++) {
      const backup = `${file}.bak-${revision}`;
      assert.equal(fs.readFileSync(backup, "utf8"), previous.get(revision));
      if (process.platform !== "win32") assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    }
    const final = fs.readFileSync(file, "utf8");
    for (const schemaVersion of [undefined, 0, 2, "1", null]) {
      assert.equal((await putModSettings(port, { schemaVersion, settings: {}, revision: 13 })).status, 426);
    }
    assert.equal((await putModSettings(port, { settings: {}, revision: 0 })).status, 409);
    assert.equal(fs.readFileSync(file, "utf8"), final);
    assert.deepEqual(fs.readdirSync(home).filter(name => name.startsWith("mod-settings.json.bak-")), names);
    // Current writers may deliberately shorten a list or remove a saved mode.
    assert.equal((await putModSettings(port, { settings: normalizeSettings(null), revision: 13 })).status, 200);
  });
});

test("admin mod-settings returns full defaults before storage, normalizes writes and persists revisions", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const defaults = { settings: normalizeSettings(null), revision: 0, stored: false, compactAt: null };
    assert.deepEqual(await (await fetch(`${base()}:${port}/api/mod-settings`)).json(), defaults);
    const input = { effortAuto: false, judge: "invalid", layout: "invalid", language: "invalid", keepWarmMinTokens: 1234, rules: { general: { mode: "auto", allow: [] } }, future: [1, null, { nested: true }] };
    // Auto is a ladder with no rung set; saving fills it from the connected models (here only Claude's own).
    const claude = (model: string, effort: string) => ({ target: { agent: "general-purpose", model }, effort });
    const settings = normalizeSettings({ ...input, rules: { general: { mode: "ladder", rungs: { light: claude("haiku", "low"), standard: claude("sonnet", "medium"), hard: claude("opus", "high"), plan: claude("opus", "high") } } } });
    const saved = await putModSettings(port, { settings: input, revision: 0 });
    assert.equal(saved.status, 200);
    const snapshot = { settings, revision: 1, stored: true, compactAt: null };
    assert.deepEqual(await saved.json(), snapshot);
    assert.deepEqual(await (await fetch(`${base()}:${port}/api/mod-settings`)).json(), snapshot);
    assert.equal(settings.judge, defaults.settings.judge);
    assert.equal(settings.layout, defaults.settings.layout);
    assert.equal(settings.language, defaults.settings.language);
    assert.equal(settings.keepWarmMinTokens, 1234);
    const file = path.join(home, "mod-settings.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { settings, revision: 1, stored: true });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal((await (await putModSettings(port, { settings })).json() as ModSettingsSnapshot).revision, 2);
    assert.deepEqual(fs.readdirSync(home).filter(name => /mod-settings.*(tmp|lock)/.test(name)), []);
  });
});

test("admin mod-settings empty-store conflicts include normalized defaults and stored false", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const response = await putModSettings(port, { settings: { language: "ko" }, revision: 1 });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { settings: normalizeSettings(null), revision: 0, stored: false, compactAt: null });
    assert.equal(fs.existsSync(path.join(home, "mod-settings.json")), false);
  });
});

test("admin mod-settings normalizes legacy stored settings on GET without rewriting their revision", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const old = { settings: { layout: "invalid", language: "pt", tiers: { light: { agent: "legacy" } } }, revision: 7 };
    const file = path.join(home, "mod-settings.json");
    fs.writeFileSync(file, JSON.stringify(old));
    assert.deepEqual(await (await fetch(`${base()}:${port}/api/mod-settings`)).json(), { settings: normalizeSettings(old.settings), revision: 7, stored: true, compactAt: null });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), old);
  });
});

test("admin mod-settings reads Auto and field rules as the four workers, fills empty rungs from the ticked models and says it once", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const file = path.join(home, "mod-settings.json");
    const old = { settings: { language: "ko", rules: { general: { mode: "auto", allow: ["general-purpose:sonnet", "general-purpose:opus"] }, backend: { mode: "auto", allow: [] } } }, revision: 7 };
    fs.writeFileSync(file, JSON.stringify(old));
    const got = await (await fetch(`${base()}:${port}/api/mod-settings`)).json() as ModSettingsSnapshot;
    assert.equal(got.legacy, true);
    assert.deepEqual(got.settings.allow, ["general-purpose:sonnet", "general-purpose:opus"]);
    assert.deepEqual(Object.keys(got.settings.rules), ["general"], "field rules are dropped");
    const general = got.settings.rules.general;
    assert.equal(general.mode, "ladder");
    // Only Sonnet and Opus are ticked: Haiku cannot stand on Low, so Low takes the session model.
    assert.deepEqual(general.rungs.light, [{ target: { agent: "general-purpose" }, effort: "max" }]);
    assert.deepEqual([general.rungs.standard, general.rungs.hard, general.rungs.plan].map(steps => steps?.[0]?.target.model), ["sonnet", "opus", "opus"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), old, "reading rewrites nothing");
    // The first save drops what was retired, so the note is said once.
    const saved = await (await putModSettings(port, { settings: got.settings, revision: 7 })).json() as ModSettingsSnapshot;
    assert.equal(saved.revision, 8);
    assert.equal(Object.hasOwn(saved, "legacy"), false);
    assert.equal(Object.hasOwn(await (await fetch(`${base()}:${port}/api/mod-settings`)).json() as object, "legacy"), false);
    // Existing ordered lists survive allow-list changes; dispatch skips unticked entries.
    const kept = { target: { agent: "general-purpose", model: "opus" }, effort: "xhigh" };
    const unticked = await (await putModSettings(port, { settings: { allow: ["general-purpose:opus"], rules: { general: { mode: "ladder", rungs: { light: kept, standard: { target: { agent: "gpt-6-1-sol" }, effort: "low" } } } } } })).json() as ModSettingsSnapshot;
    const rungs = unticked.settings.rules.general.mode === "ladder" ? unticked.settings.rules.general.rungs : {};
    assert.deepEqual(rungs.light, [kept]);
    assert.equal(rungs.standard?.[0]?.target.model, undefined);
    assert.deepEqual(rungs.standard?.[0]?.target, { agent: "gpt-6-1-sol" });
  });
});

test("admin fills Base and mode domain ladders even when every general rung is already full", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const kept = [{ target: { agent: 'general-purpose', model: 'sonnet' }, effort: 'high' }];
    const full = { light: kept, standard: kept, hard: kept, plan: kept };
    const input = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: full } }, domainRules: {
      ui: { mode: 'ladder', rungs: { light: kept } }, backend: { mode: 'ladder', rungs: {} },
    }, modes: [
      { id: 'own', name: 'Own', rungs: full, domainRules: { ui: { mode: 'ladder', rungs: {} }, backend: { mode: 'ladder', rungs: { hard: kept } } } },
      { id: 'plain', name: 'Plain', rungs: full },
    ] });
    const saved = await (await putModSettings(port, { settings: input, revision: 0 })).json() as ModSettingsSnapshot;
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.settings.rules.general, input.rules.general);
    assert.deepEqual(saved.settings.domainRules!.ui!.rungs.light, kept);
    assert.deepEqual(saved.settings.modes[0]!.domainRules!.backend!.rungs.hard, kept);
    for (const set of [saved.settings, saved.settings.modes[0]!]) {
      for (const rule of Object.values(set.domainRules!)) {
        assert.deepEqual(Object.keys(rule.rungs).sort(), ['hard', 'light', 'plan', 'standard']);
        assert.ok(Object.values(rule.rungs).every(steps => steps.length > 0));
        // A domain ladder has two levels: the fill leaves light work (light, standard) one list and
        // heavy work (hard, plan) another.
        assert.deepEqual(rule.rungs.light, rule.rungs.standard);
        assert.deepEqual(rule.rungs.hard, rule.rungs.plan);
      }
    }
    assert.equal(Object.hasOwn(saved.settings.modes[1]!, 'domainRules'), false);
    assert.equal(saved.legacy, undefined);
    assert.deepEqual(await (await fetch(`${base()}:${port}/api/mod-settings`)).json(), saved);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'mod-settings.json'), 'utf8')), { settings: saved.settings, revision: saved.revision, stored: saved.stored });
  });
});

test("admin folds a domain ladder into two levels and leaves the general ladder's four rungs", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const light = [{ target: { agent: "general-purpose", model: "haiku" }, effort: "low" }];
    const standard = [{ target: { agent: "general-purpose", model: "sonnet" }, effort: "medium" }];
    const hard = [{ target: { agent: "general-purpose", model: "opus" }, effort: "high" }];
    const plan = [{ target: { agent: "general-purpose", model: "opus" }, effort: "xhigh" }];
    const input = normalizeSettings({ rules: { general: { mode: "ladder", rungs: { light, standard, hard, plan } } }, domainRules: {
      ui: { mode: "ladder", rungs: { light, standard, hard, plan } },
    } });
    const saved = await (await putModSettings(port, { settings: input, revision: 0 })).json() as ModSettingsSnapshot;
    // The general ladder keeps its four rungs.
    assert.deepEqual(saved.settings.rules.general.rungs, { light, standard, hard, plan });
    // Light's list runs light and ordinary work; plan's runs hard work and plans.
    assert.deepEqual(saved.settings.domainRules!.ui!.rungs.light, light);
    assert.deepEqual(saved.settings.domainRules!.ui!.rungs.standard, light);
    assert.deepEqual(saved.settings.domainRules!.ui!.rungs.hard, plan);
    assert.deepEqual(saved.settings.domainRules!.ui!.rungs.plan, plan);
  });
});

test("admin mod-settings round-trips allowKnown, the keys the allow-list was last written with", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const known = ["deepseek-v4-1-flash", "gpt-6-1-sol", "gpt-6-astra", "general-purpose:haiku", "general-purpose:sonnet", "general-purpose:opus", "general-purpose:fable"];
    const saved = await (await putModSettings(port, { settings: { allow: ["gpt-6-1-sol"], allowKnown: known } })).json() as ModSettingsSnapshot;
    assert.deepEqual(saved.settings.allow, ["gpt-6-1-sol"]);
    assert.deepEqual(saved.settings.allowKnown, known);
    assert.deepEqual(await (await fetch(`${base()}:${port}/api/mod-settings`)).json(), saved, "the stored copy carries allowKnown too");
    // A default-sized list (every model ticked) resets both to empty.
    const all = await (await putModSettings(port, { settings: { allow: [], allowKnown: [] } })).json() as ModSettingsSnapshot;
    assert.deepEqual(all.settings.allow, []);
    assert.deepEqual(all.settings.allowKnown, []);
  });
});

test("admin mod-settings stale revisions return current settings; concurrent CAS has one winner", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const responses = await Promise.all([putModSettings(port, { settings: { language: "ko" }, revision: 0 }), putModSettings(port, { settings: { language: "ja" }, revision: 0 })]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const current = await (await fetch(`${base()}:${port}/api/mod-settings`)).json() as ModSettingsSnapshot;
    assert.equal(current.stored, true);
    assert.equal(current.revision, 1);
    assert.deepEqual(current.settings, normalizeSettings(current.settings));
    for (const response of responses) assert.deepEqual(await response.json(), current);
    const stale = await putModSettings(port, { settings: {}, revision: 0 });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), current);
  });
});

test("admin mod-settings refuses nonobjects, invalid revisions and secrets at any depth without changing the store", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    for (const settings of [null, [], "text", 1, { apiKey: "hidden" }, { nested: [{ TOKEN: "hidden" }] }, { deep: { clientSecret: "hidden" } }]) {
      const response = await putModSettings(port, { settings });
      assert.equal(response.status, 400, JSON.stringify(settings));
      assert.doesNotMatch(await response.text(), /hidden/);
    }
    for (const revision of [-1, 0.5, null, "0"]) assert.equal((await putModSettings(port, { settings: {}, revision })).status, 400);
    const malformed = await fetch(`${base()}:${port}/api/mod-settings`, { method: "PUT", body: "{" });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await (await fetch(`${base()}:${port}/api/mod-settings`)).json(), { settings: normalizeSettings(null), revision: 0, stored: false, compactAt: null });
    // A count named for tokens is a setting the mod has, not a credential.
    assert.equal((await putModSettings(port, { settings: { keepWarmMinTokens: 30000, rules: { general: { mode: "pin" } } } })).status, 200);
  });
});

test("admin mod-settings enforces the UTF-8 64 KiB object limit at the exact boundary", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const limit = 64 * 1024;
    const overhead = Buffer.byteLength(JSON.stringify({ text: "" }));
    const settings = { text: "é".repeat(Math.floor((limit - overhead) / 2)) + "a".repeat((limit - overhead) % 2) };
    assert.equal(Buffer.byteLength(JSON.stringify(settings)), limit);
    assert.equal((await putModSettings(port, { settings })).status, 200);
    assert.equal((await putModSettings(port, { settings: { text: settings.text + "a" } })).status, 413);
    assert.equal((await putModSettings(port, { settings: { text: "a".repeat(1024 * 1024) } })).status, 413, "oversized HTTP bodies receive an error, not a connection reset");
    assert.equal((await (await fetch(`${base()}:${port}/api/mod-settings`)).json() as ModSettingsSnapshot).revision, 1);
  });
});

test("admin mod-settings refuses to overwrite corrupt persistence", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const file = path.join(home, "mod-settings.json");
    fs.writeFileSync(file, "{");
    assert.equal((await putModSettings(port, { settings: {} })).status, 500);
    assert.equal(fs.readFileSync(file, "utf8"), "{");
  });
});

test("admin mod-settings renames a rung and an allow-list entry saved under the 0.12.18 worker name (#111)", async () => {
  const agents = fs.mkdtempSync(path.join(os.tmpdir(), "cr-agent-renames-"));
  const cfg = makeCfg({ providers: { deepseek: { type: "anthropic-compatible", url: "http://127.0.0.1:9", models: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" }] } } });
  const old = "deepseek-ai--eep-eek--4-1--lash-1017";
  const now = "deepseek-ai-deepseek-v4-1-flash-1017";
  try {
    await withAdmin(cfg, async ({ port, home }) => {
      const steps = (agent: string) => [{ target: { agent }, effort: "high" }];
      const saved = {
        rules: { general: { mode: "ladder", rungs: { light: steps(old), standard: steps("gpt-6-1-sol") } } },
        modes: [{ id: "saved", name: "Saved mode", rungs: { hard: steps(old) }, delegation: "normal", until: "none" }],
        allow: [old, "gpt-6-1-sol"],
        allowKnown: [old, "gpt-6-1-sol"],
      };
      fs.writeFileSync(path.join(home, "mod-settings.json"), JSON.stringify({ revision: 3, settings: normalizeSettings(saved) }));

      const response = await fetch(`${base()}:${port}/api/mod-settings`);
      assert.equal(response.status, 200);
      const settings = ((await response.json()) as ModSettingsSnapshot).settings;
      assert.deepEqual(settings.rules.general.rungs.light, steps(now), "the renamed worker, not a missing one");
      assert.deepEqual(settings.rules.general.rungs.standard, steps("gpt-6-1-sol"), "a name that did not change is left alone");
      assert.deepEqual(settings.modes[0]!.rungs.hard, steps(now), "a saved mode's rung too");
      assert.deepEqual(settings.allow, [now, "gpt-6-1-sol"], "the ticked worker keeps its tick");
      assert.deepEqual(settings.allowKnown, [now, "gpt-6-1-sol"]);
    }, { agentDir: agents });
  } finally {
    fs.rmSync(agents, { recursive: true, force: true });
  }
});

test("admin mod-settings leaves a hand-written worker at a 0.12.18 name, and every entry naming it, alone", async () => {
  const agents = fs.mkdtempSync(path.join(os.tmpdir(), "cr-agent-hand-rename-"));
  // Never generated by the router: a person's own file that happens to carry the name 0.12.18 gave
  // Vendor/Model, so a saved rung or tick naming it means that worker, not a stale generated one.
  const legacy = "-endor--odel";
  const hand = `---\nname: ${legacy}\nmodel: unrelated-model\n---\nMy hand-written worker\n`;
  fs.writeFileSync(path.join(agents, `${legacy}.md`), hand);
  const cfg = makeCfg({ providers: { vendor: { type: "anthropic-compatible", url: "http://127.0.0.1:9", models: [{ id: "Vendor/Model" }] } } });
  try {
    await withAdmin(cfg, async ({ port, home }) => {
      const steps = (agent: string) => [{ target: { agent }, effort: "high" }];
      const saved = normalizeSettings({ rules: { general: { mode: "ladder", rungs: { light: steps(legacy) } } }, allow: [legacy], allowKnown: [legacy] });
      const store = path.join(home, "mod-settings.json");
      fs.writeFileSync(store, JSON.stringify({ revision: 3, settings: saved }));
      const before = fs.readFileSync(store, "utf8");

      const read = ((await (await fetch(`${base()}:${port}/api/mod-settings`)).json()) as ModSettingsSnapshot).settings;
      assert.deepEqual(read.rules.general.rungs.light, steps(legacy), "the rung keeps the hand worker");
      assert.deepEqual(read.allow, [legacy], "and so does the tick");
      assert.equal(fs.readFileSync(store, "utf8"), before, "reading persists no migration");

      assert.equal((await putModSettings(port, { settings: saved, revision: 3 })).status, 200);
      const stored = (JSON.parse(fs.readFileSync(store, "utf8")) as { settings: ModSettingsSnapshot["settings"] }).settings;
      assert.deepEqual(stored.rules.general.rungs.light, steps(legacy), "saving keeps it too");
      assert.deepEqual(stored.allow, [legacy]);
      const again = ((await (await fetch(`${base()}:${port}/api/mod-settings`)).json()) as ModSettingsSnapshot).settings;
      assert.deepEqual(again, stored, "a repeated migration is idempotent");
      assert.equal(fs.readFileSync(path.join(agents, `${legacy}.md`), "utf8"), hand, "the hand file is untouched");
    }, { agentDir: agents });
  } finally {
    fs.rmSync(agents, { recursive: true, force: true });
  }
});

test("admin mod-options offers owned workers, every provider model, judge candidates and attributed AA scores", async () => {
  const agents = fs.mkdtempSync(path.join(os.tmpdir(), "cr-mod-options-"));
  const full = { rate_limits: { primary: { used_percent: 100, reset_after_seconds: 600 } } };
  let refreshed = 0;
  let credit = false;
  const cfg = makeCfg({ providers: {
    codex: { type: "chatgpt", models: [{ id: "gpt-6.1-sol", name: "Sol" }] },
    zen: { type: "openai-compatible", preset: "opencode-zen", url: "http://127.0.0.1:9", headers: { authorization: "Bearer hidden-credential" }, models: [{ id: "jev-1.13", name: "Jev" }, { id: "deepseek-v4.1-flash" }] },
    custom: { type: "anthropic-compatible", url: "http://127.0.0.1:9", models: [{ id: "custom-chat" }] },
    native: { type: "anthropic", auth: "api-key", apiKey: "hidden-api-key", models: [{ id: "claude-sonnet-5-5" }] },
    google: { type: "google", auth: "antigravity", models: [{ id: "gemini-3.8-flash" }] },
  }, routes: {}, direct: [], aliases: {} });
  try {
    fs.writeFileSync(path.join(agents, "gpt-6-1-sol.md"), "---\nname: gpt-6-1-sol\nmodel: gpt-6.1-sol@high\n---\n");
    fs.writeFileSync(path.join(agents, "jev-1-13.md"), "---\nname: jev-1-13\nmodel: jev-1.13\n---\n");
    fs.writeFileSync(path.join(agents, "hand.md"), "---\nname: hand\nmodel: custom-chat\n---\n");
    await withAdmin(cfg, async ({ port, home, setCfg }) => {
      fs.writeFileSync(path.join(home, "generated-agents.json"), JSON.stringify({ agents: ["gpt-6-1-sol", "jev-1-13", "missing"] }));
      const get = async () => {
        const response = await fetch(`${base()}:${port}/api/mod-options`);
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.doesNotMatch(text, /hidden-credential|hidden-api-key/);
        return JSON.parse(text) as ModOptions;
      };
      const options = await get();
      assert.deepEqual(options.agents, [{ name: "gpt-6-1-sol", model: "gpt-6.1-sol", provider: "codex", efforts: ["low", "medium", "high", "xhigh", "max"], billing: "subscription" }]);
      assert.deepEqual(options.providers.map(p => [p.name, p.billing]), [["codex", "subscription"], ["zen", "payg"], ["custom", "free"], ["native", "payg"], ["google", "subscription"]]);
      assert.deepEqual(options.claudeEfforts, ["low", "medium", "high", "xhigh", "max"]);
      assert.equal(Object.hasOwn(options, "presets"), false, "the presets are gone: the router fills empty rungs itself");
      assert.deepEqual(options.models.find(m => m.model === "jev-1.13"), { model: "jev-1.13", provider: "zen", name: "Jev", judgeOnly: true });
      assert.equal(options.models.length, 6);
      assert.deepEqual(options.zen, { configured: true, model: "jev-1.13" });
      assert.equal(options.providers.find(p => p.name === "codex")?.usable, false);
      assert.equal(options.providers.find(p => p.name === "google")?.usable, false);
      assert.equal(options.providers.find(p => p.name === "native")?.usable, true);
      assert.equal(options.scores.attribution, "Data: Artificial Analysis (artificialanalysis.ai)");
      assert.equal(options.scores.models.find(m => m.model === "gpt-6.1-sol")?.variants[0]?.intelligence, 50.24);
      assert.equal(refreshed, 1);
      // ChatGPT out of quota is not connected: an empty Standard rung is filled with Claude, not Sol.
      const fill = async () => {
        const saved = await putModSettings(port, { settings: { rules: { general: { mode: "auto", allow: [] } } } });
        assert.equal(saved.status, 200);
        const general = ((await saved.json()) as ModSettingsSnapshot).settings.rules.general;
        return general.mode === "ladder" ? general.rungs : {};
      };
      assert.deepEqual((await fill()).standard, [{ target: { agent: "general-purpose", model: "sonnet" }, effort: "medium" }]);
      credit = true;
      const credited = await get();
      assert.equal(credited.providers.find(p => p.name === "codex")?.usable, true, "purchased credits keep a full account usable");
      assert.deepEqual((await fill()).standard, [{ target: { agent: "gpt-6-1-sol" }, effort: "medium" }]);
      setCfg(makeCfg({ providers: { zen: { type: "openai-compatible", url: "https://opencode.ai/zen/v1", models: [{ id: "jev-2" }] } }, routes: {}, aliases: {}, direct: [] }));
      assert.deepEqual((await get()).zen, { configured: true, model: "jev-2" }, "hand-entered Zen URLs need no preset");
      setCfg(makeCfg({ providers: {}, routes: {}, aliases: {}, direct: [] }));
      const empty = await get();
      assert.deepEqual(empty.zen, { configured: false, model: null });
      assert.deepEqual(empty.models, []);
      assert.deepEqual(empty.agents, []);
    }, {
      agentDir: agents,
      chatgpt: () => ({ quota: { codex: null }, auth: { codex: "ok" }, refresh: async () => { refreshed++; return { at: Date.now(), ...full }; }, accounts: () => ({ codex: [
        { id: "ready", label: "Ready", expiresAt: Date.now() + 10000, needsReauth: false, paused: false, preferred: false, inUse: true, source: "own", state: "ready", quota: { ...full, ...(credit ? { credits: { has_credits: true } } : {}) }, active: true },
        { id: "paused", label: "Paused", expiresAt: Date.now() + 10000, needsReauth: false, paused: true, preferred: false, inUse: false, source: "own", state: "paused", quota: null, active: false },
      ] }) }),
      modelScoresFetch: async () => Response.json({ source: "https://artificialanalysis.ai", attribution: "Data: Artificial Analysis (artificialanalysis.ai)", generatedAt: "2026-10-10T00:00:00Z", models: [{ slug: "gpt-6-1-sol-high", base: "gpt-6-1-sol", effort: "high", intelligence: 50.24, costPerTask: 0.3191 }] }),
    });
  } finally { fs.rmSync(agents, { recursive: true, force: true }); }
});

test("admin config saves isolate client settings and restore the caller environment on failure", async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "cr-admin-settings-"));
  const settingsFile = path.join(outer, "settings.json");
  const original = '{"env":{"KEEP_ME":"unchanged"}}\n';
  fs.writeFileSync(settingsFile, original);
  const prevSettings = process.env.CLAUDE_SETTINGS_PATH;
  const prevHome = process.env.CLAUDERIPPLE_HOME;
  process.env.CLAUDE_SETTINGS_PATH = settingsFile;
  let isolatedHome = "";
  try {
    await assert.rejects(withAdmin(makeCfg(), async ({ port, home }) => {
      isolatedHome = home;
      assert.equal(process.env.CLAUDE_SETTINGS_PATH, path.join(home, "claude-settings.json"));
      const res = await fetch(`${base()}:${port}/api/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeCfg()),
      });
      assert.equal(res.status, 200);
      const settings = JSON.parse(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH!, "utf8"));
      assert.equal(settings.env.NODE_EXTRA_CA_CERTS, path.join(home, "ca.pem"));
      assert.equal(fs.readFileSync(settingsFile, "utf8"), original);
      throw new Error("exercise fixture cleanup");
    }), /exercise fixture cleanup/);
    assert.equal(process.env.CLAUDE_SETTINGS_PATH, settingsFile);
    assert.equal(process.env.CLAUDERIPPLE_HOME, prevHome);
    assert.equal(fs.existsSync(isolatedHome), false);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), original);
  } finally {
    if (prevSettings === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
    else process.env.CLAUDE_SETTINGS_PATH = prevSettings;
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(body.accounts, [{ id: account.id, label: "person@example.test", email: "person@example.test", expiresAt: account.expiresAt, needsReauth: false, preferred: false, paused: false, state: "ready", inUse: true }]);
    assert.doesNotMatch(JSON.stringify(body), /admin-access-secret|admin-refresh-secret|upstream-account-secret/);

    const renamed = await fetch(`${base()}:${port}/api/claude-accounts/${encodeURIComponent(account.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "  Personal  " }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(listClaudeAccounts(home)[0]!.label, "Personal");

    const prefer = (preferred: unknown) => fetch(`${base()}:${port}/api/claude-accounts`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferred }),
    });
    assert.equal((await prefer(account.id)).status, 200);
    assert.equal(listClaudeAccounts(home)[0]!.preferred, true);
    assert.equal((await prefer("current")).status, 200, "the current login takes first place back by name");
    assert.equal(listClaudeAccounts(home)[0]!.preferred, false);
    assert.equal((await prefer("not-a-local-id")).status, 404);
    assert.equal((await prefer(7)).status, 400);

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

test("/api/claude-accounts marks a stored copy of the current Claude login, by subject hash or by email", async () => {
  const uuid = "current-login-uuid";
  await withAdmin(makeCfg(), async ({ port, home }) => {
    saveClaudeAuthFile(home, "current-login-token", "2026-10-23T00:00:00.000Z");
    const sameByHash = saveClaudeOAuthAccount(home, {
      accessToken: "pool-token-1", refreshToken: "pool-refresh-1", expiresAt: Date.now() + 3_600_000,
      accountId: uuid, email: "some-label@example.test",
    });
    const sameByEmail = saveClaudeOAuthAccount(home, {
      accessToken: "pool-token-2", refreshToken: "pool-refresh-2", expiresAt: Date.now() + 3_600_000,
      email: "PERSON@example.test",
    });
    const other = saveClaudeOAuthAccount(home, {
      accessToken: "pool-token-3", refreshToken: "pool-refresh-3", expiresAt: Date.now() + 3_600_000,
      accountId: "someone-else", email: "person@example.test",
    });
    const body = await (await fetch(`${base()}:${port}/api/claude-accounts`)).json() as {
      current: { email?: string }; accounts: { id: string; sameAsCurrent?: boolean }[];
    };
    assert.equal(body.current.email, "Person@Example.Test");
    const byId = new Map(body.accounts.map((account) => [account.id, account]));
    assert.equal(byId.get(sameByHash.id)?.sameAsCurrent, true, "the same upstream account, whatever its label");
    assert.equal(byId.get(sameByEmail.id)?.sameAsCurrent, true, "no subject hash: the email decides, case-insensitively");
    assert.equal(byId.get(other.id)?.sameAsCurrent, undefined, "another upstream account stays separate even with the same email");
    assert.doesNotMatch(JSON.stringify(body), new RegExp(subjectHash(uuid)!), "the subject hash itself never reaches the GUI");
    assert.doesNotMatch(JSON.stringify(body), /pool-token|pool-refresh/, "no token material either");
  }, { claudeIdentity: async () => ({ email: "Person@Example.Test", subjectHash: subjectHash(uuid)! }) });
});

test("an unknown current identity leaves /api/claude-accounts exactly as it was", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    saveClaudeAuthFile(home, "current-login-token");
    const stored = saveClaudeOAuthAccount(home, {
      accessToken: "pool-token", refreshToken: "pool-refresh", expiresAt: Date.now() + 3_600_000,
      email: "person@example.test",
    });
    const body = await (await fetch(`${base()}:${port}/api/claude-accounts`)).json() as {
      current: unknown; accounts: unknown[];
    };
    assert.deepEqual(body.current, { id: "current", label: "Current Claude login", source: "token-file", external: true, paused: false, preferred: false, state: "ready", inUse: true });
    assert.deepEqual(body.accounts, [{ id: stored.id, label: "person@example.test", email: "person@example.test", expiresAt: stored.expiresAt, needsReauth: false, preferred: false, paused: false, state: "ready", inUse: false }]);
    assert.doesNotMatch(JSON.stringify(body), /sameAsCurrent/);
  }, { claudeIdentity: async () => null });
});

test("a failed identity lookup does not break /api/claude-accounts", async () => {
  await withAdmin(makeCfg(), async ({ port, home }) => {
    saveClaudeAuthFile(home, "current-login-token");
    const res = await fetch(`${base()}:${port}/api/claude-accounts`);
    assert.equal(res.status, 200);
    const body = await res.json() as { current: { source?: string; email?: string }; accounts: unknown[] };
    assert.equal(body.current.source, "token-file");
    assert.equal(body.current.email, undefined);
    assert.deepEqual(body.accounts, []);
  }, { claudeIdentity: async () => { throw new Error("profile endpoint down"); } });
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

// G-D14: the first read adopts an invalid config so the router can serve the fix, but that is not
// a healthy router: readiness said "ready" over a config whose routes could not exist.
test("a config that failed validation is reported as a problem, with its errors", async () => {
  const errors = ["route x: fallback 0 names unknown provider \"q\""];
  await withAdmin(makeCfg(), async ({ port }) => {
    const status = (await (await fetch(`${base()}:${port}/api/status`)).json()) as {
      readiness: { ready: boolean; problems: string[] }; config: { errors: string[] };
    };
    assert.equal(status.readiness.ready, false);
    assert.ok(status.readiness.problems.includes("config"), status.readiness.problems.join(","));
    assert.deepEqual(status.config.errors, errors);
    const ready = await fetch(`${base()}:${port}/readyz`);
    assert.equal(ready.status, 503);
  }, { configErrors: () => errors });
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
      const sock = net.connect(port, "127.0.0.1", () => sock.write(`HEAD /style.css HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
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
    assert.deepEqual(body.models[0], { id: "claude-haiku-5-5", name: "Haiku 5.5" });
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

test("POST /api/image answers with the image bytes, and refuses a bad request before generating", async () => {
  const cfg = makeCfg();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-image-admin-"));
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const asked: ImageRequest[] = [];
  const admin = await startAdmin({
    config: () => cfg,
    configFile,
    log: new Logger(null, 1_000_000, 1, false),
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    health: () => 0,
    version: "0.0.0-test",
    requests: new RequestLog(path.join(home, "logs", "requests.jsonl")),
    image: async (req) => {
      asked.push(req);
      return { data: Buffer.from("PNGDATA"), format: "png", size: "1024x1024", revisedPrompt: "a boat, flat" };
    },
  });
  const post = (body: unknown): Promise<Response> =>
    fetch(`${base()}:${admin.port}/api/image`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const ok = await post({ prompt: "a boat", aspect: "portrait", images: ["data:image/png;base64,QUJD"] });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(decodeURIComponent(ok.headers.get("x-revised-prompt") ?? ""), "a boat, flat");
    assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), "PNGDATA");
    assert.deepEqual(asked, [{ prompt: "a boat", aspect: "portrait", images: [{ mediaType: "image/png", data: "QUJD" }] }]);

    const noPrompt = await post({ prompt: " " });
    assert.equal(noPrompt.status, 400);
    const badAspect = await post({ prompt: "x", aspect: "1024x1024" });
    assert.equal(badAspect.status, 400);
    assert.match(((await badAspect.json()) as { error: string }).error, /aspect must be one of/);
    const badRef = await post({ prompt: "x", images: ["/tmp/a.png"] });
    assert.equal(badRef.status, 400);
    assert.equal(asked.length, 1, "nothing generated for a refused request");
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
    assert.deepEqual(Object.keys(body.providers.native ?? {}).sort(), ["accountCount", "authSource", "reachable", "signedIn", "type", "url", "usable"]);
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
    assert.deepEqual(body.providers.anthropic?.default, ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(body.providers.openrouter?.default, ["low", "medium", "high"]);
    assert.deepEqual(body.providers.openrouter?.models, { effort: ["low", "medium", "high"], "no-effort": [] });
    assert.deepEqual(body.providers.custom?.default, ["max"]);
    assert.deepEqual(body.providers.gpt?.models?.["gpt-5.6-luna"], ["low", "medium", "high", "xhigh", "max"], "Luna takes no ultra");
    assert.deepEqual(body.providers.gpt?.models?.["gpt-5.6-terra"], ["low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.deepEqual(body.providers.gpt?.models?.["gpt-5.6-sol"], ["low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.deepEqual(body.providers.gpt?.models?.["gpt-6-sol"], ["low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.deepEqual(body.providers.gpt?.models?.["gpt-6-luna"], ["low", "medium", "high", "xhigh", "max"], "Luna takes no ultra");
    assert.deepEqual(body.providers.gpt?.default, ["low", "medium", "high", "xhigh", "max"]);
  });
});

test("GET /api/effort-levels lets a chatgpt config entry override the fallback ladder", async () => {
  const cfg = makeCfg({ providers: { gpt: { type: "chatgpt", models: [{ id: "gpt-6-luna", effortLevels: ["low", "ultra"] }, { id: "something-new", effortLevels: ["high"] }] } } });
  await withAdmin(cfg, async ({ port }) => {
    const body = (await (await fetch(`${base()}:${port}/api/effort-levels`)).json()) as { providers: Record<string, { models?: Record<string, string[]> }> };
    assert.deepEqual(body.providers.gpt?.models?.["gpt-6-luna"], ["low", "ultra"], "config wins over the built-in ladder");
    assert.deepEqual(body.providers.gpt?.models?.["something-new"], ["high"], "a model the fallback does not know still reports what it takes");
    assert.deepEqual(body.providers.gpt?.models?.["gpt-6-sol"], ["low", "medium", "high", "xhigh", "max", "ultra"], "untouched entries keep the fallback");
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

test("PUT /api/config warns when accepted rules name an ingress-only provider", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const next = makeCfg({
      providers: { native: { type: "anthropic", auth: "api-key" } },
      routes: { slot: { provider: "native", model: "claude-sonnet-5" } },
      direct: [{ prefix: "native-", provider: "native" }],
    });
    const res = await fetch(`${base()}:${port}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; warning?: string };
    assert.equal(body.ok, true);
    assert.equal(body.warning, [
      'route "slot" names "native", which serves the OpenAI ingress only; requests for it pass through to Anthropic',
      'direct rule "native-" names "native", which serves the OpenAI ingress only; requests it matches pass through to Anthropic',
    ].join("\n"));
  });
});

test("config revisions prevent concurrent lost updates and detect external edits while legacy saves still work", async () => {
  await withAdmin(makeCfg(), async ({ port, configFile, setCfg }) => {
    type Snapshot = Config & { configRevision: string };
    const url = `${base()}:${port}/api/config`;
    const get = async () => (await (await fetch(url)).json()) as Snapshot;
    const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const firstWindow = await get();
    const secondWindow = await get();
    assert.match(firstWindow.configRevision, /^[a-f0-9]{64}$/);
    assert.deepEqual(secondWindow, firstWindow);
    const responses = await Promise.all([put({ ...firstWindow, autoUpdate: true }), put({ ...secondWindow, autoUpdate: false })]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const saved = JSON.parse(fs.readFileSync(configFile, "utf8")) as Config;
    const success = await responses.find(response => response.status === 200)!.json() as { ok: boolean; configRevision: string };
    assert.equal(success.ok, true);
    assert.notEqual(success.configRevision, firstWindow.configRevision);
    assert.equal("configRevision" in saved, false, "revision metadata must not be persisted");
    assert.deepEqual(await responses.find(response => response.status === 409)!.json(), { error: "config revision conflict", config: saved, configRevision: success.configRevision });
    setCfg(saved); // Production's ConfigStore reloads the file on get().
    assert.deepEqual(await get(), { ...saved, configRevision: success.configRevision });
    const before = fs.readFileSync(configFile, "utf8");
    assert.equal((await put(firstWindow)).status, 409);
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
    for (const configRevision of [null, 0, {}, "", "invalid"]) {
      assert.equal((await put({ ...saved, configRevision })).status, 400);
      assert.equal(fs.readFileSync(configFile, "utf8"), before);
    }
    const fresh = await put({ ...await get(), autoUpdate: !saved.autoUpdate });
    assert.equal(fresh.status, 200);
    const { configRevision } = await fresh.json() as { configRevision: string };
    const external = { ...saved, providers: { external: { type: "anthropic-compatible", url: "http://127.0.0.1:9" } } } satisfies Config;
    fs.writeFileSync(configFile, JSON.stringify(external));
    const conflict = await put({ ...saved, configRevision });
    assert.equal(conflict.status, 409);
    const current = await conflict.json() as { config: Config; configRevision: string };
    assert.deepEqual(current.config, external);
    assert.notEqual(current.configRevision, configRevision);
    assert.equal((await put(external)).status, 200, "old clients may save without a revision");
  });
});

test("PUT /api/config carries a webSearch backend through to the file and GET returns it", async () => {
  await withAdmin(makeCfg(), async ({ port, configFile, setCfg }) => {
    const next = makeCfg({
      providers: { gpt: { type: "chatgpt", auth: "own" } },
      webSearch: { provider: "gpt", model: "gpt-5.6-terra", maxResults: 4 },
    });
    const res = await fetch(`${base()}:${port}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    assert.equal(res.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf8")) as Config;
    assert.deepEqual(onDisk.webSearch, next.webSearch);
    setCfg(next);
    const read = (await (await fetch(`${base()}:${port}/api/config`)).json()) as Config;
    assert.deepEqual(read.webSearch, next.webSearch);
  });
});

test("PUT /api/config carries a chatgpt provider's Fast switches through to the file and back", async () => {
  await withAdmin(makeCfg(), async ({ port, configFile, setCfg }) => {
    const next = makeCfg({
      providers: { gpt: { type: "chatgpt", auth: "own", fast: { main: true, subagent: false } } },
    });
    const res = await fetch(`${base()}:${port}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    assert.equal(res.status, 200);
    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf8")) as Config;
    assert.deepEqual((onDisk.providers.gpt as { fast?: unknown }).fast, { main: true, subagent: false });
    setCfg(next);
    const read = (await (await fetch(`${base()}:${port}/api/config`)).json()) as Config;
    assert.deepEqual((read.providers.gpt as { fast?: unknown }).fast, { main: true, subagent: false });
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
      { id: "claude-haiku-5-5", name: "Haiku 5.5" }, { id: "claude-sonnet-5-5", name: "Sonnet 5.5" }, { id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-fable-5-1", name: "Fable 5.1" }, { id: "claude-opus-5", name: "Opus 5" }, { id: "claude-sonnet-5", name: "Sonnet 5" }, { id: "claude-fable-5", name: "Fable 5" }, { id: "claude-opus-4-8", name: "Opus 4.8" }, { id: "claude-opus-4-7", name: "Opus 4.7" }, { id: "claude-sonnet-4-6", name: "Sonnet 4.6" }, { id: "claude-opus-4-6", name: "Opus 4.6" }, { id: "claude-haiku-4-5", name: "Haiku 4.5" },
    ] });
    saveClaudeAuthFile(home, "test-token", "2026-09-13T00:00:00.000Z");
    const available = await fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "anthropic", auth: "claude-code" }) });
    const body = await available.json() as { ok: boolean; auth: string; source: string; signedIn: string | null; models: { id: string; name: string }[] };
    assert.equal(body.ok, true);
    assert.equal(body.auth, "ok");
    assert.equal(body.source, "token-file");
    assert.equal(body.signedIn, "setup-token");
    assert.equal(body.models[0]?.id, "claude-haiku-5-5");
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
      { id: "claude-haiku-5-5", name: "Haiku 5.5" }, { id: "claude-sonnet-5-5", name: "Sonnet 5.5" }, { id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-fable-5-1", name: "Fable 5.1" }, { id: "claude-opus-5", name: "Opus 5" }, { id: "claude-sonnet-5", name: "Sonnet 5" }, { id: "claude-fable-5", name: "Fable 5" }, { id: "claude-opus-4-8", name: "Opus 4.8" }, { id: "claude-opus-4-7", name: "Opus 4.7" }, { id: "claude-sonnet-4-6", name: "Sonnet 4.6" }, { id: "claude-opus-4-6", name: "Opus 4.6" }, { id: "claude-haiku-4-5", name: "Haiku 4.5" },
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

test("POST /api/providers/probe tests a typed model id and reads a model 404 as authenticated, a bare 404 as not", async () => {
  const seen: { model?: string } = {};
  let modelNamed = true;
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.model = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model;
      // abliteration.ai's answer to an id it does not serve (issue #42).
      res.writeHead(404, { "content-type": "application/json" }).end(modelNamed ? JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Requested model was not found." } }) : "Not Found");
    });
  });
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const probe = (port: number) => fetch(`${base()}:${port}/api/providers/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "anthropic-compatible", url: `http://127.0.0.1:${address.port}`, headers: { authorization: "Bearer secret-key" }, probeModel: "abliterated-model" }),
  });
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      assert.deepEqual(await (await probe(port)).json(), { ok: true, auth: "ok", models: [] });
      assert.equal(seen.model, "abliterated-model");
      modelNamed = false;
      const bare = (await (await probe(port)).json()) as { ok: boolean };
      assert.equal(bare.ok, false);
    });
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
    // Above the floor some vendors set (B.ai refuses anything under 3, #57).
    assert.equal(seen.tokens, 16);
  } finally {
    await new Promise<void>((resolveP, reject) => upstream.close((error) => error ? reject(error) : resolveP()));
  }
});

// A provider being added is filled the same way, because what the form saves is what the probe
// returned: Hive's `/models` names its models and nothing else.
test("POST /api/providers/probe fills a window the vendor did not state from the model's catalogue entry", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/v3/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [
        { id: "deepseek-ai/deepseek-v4.1-flash-1017", object: "model", created: 1, owned_by: "deepseek-ai", shutdown_date: null },
        { id: "jev-1.13", object: "model", created: 1, owned_by: "jev", shutdown_date: null },
      ] }));
      return;
    }
    if (req.url === "/v3/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}/v3`;
  const modelCatalog = async (): Promise<unknown> => ({
    "opencode-go": { models: { "deepseek-v4.1-flash": { limit: { context: 1000000 } } } },
    scaleway: { models: { "deepseek-v4.1-flash": { limit: { context: 256000 } } } },
  });
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "openai-compatible", url: origin, headers: { authorization: "Bearer secret-key" }, modelsUrl: `${origin}/models`, modelsAuthHeader: "authorization-bearer" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { models: { id: string; contextWindow?: number }[] };
      assert.deepEqual(body.models.map((model) => [model.id, model.contextWindow]), [
        ["deepseek-ai/deepseek-v4.1-flash-1017", 256000],
        ["jev-1.13", undefined],
      ]);
    }, { modelCatalog });
  } finally {
    await new Promise<void>((resolveP, reject) => upstream.close((error) => error ? reject(error) : resolveP()));
  }
});

// A provider entered by hand on the Responses wire may serve nothing else, so its test goes there.
test("POST /api/providers/probe tests a hand-entered Responses provider on /responses", async () => {
  const seen: { path?: string | undefined; body?: Record<string, unknown> } = {};
  const upstream = http.createServer((req, res) => {
    seen.path = req.url;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (req.url === "/v1/responses") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ output: [] }));
      else res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "openai-compatible", url: `http://127.0.0.1:${address.port}/v1/`, wire: "responses", headers: { authorization: "Bearer secret-key" }, probeModel: "resp-model" }),
      });
      assert.deepEqual(await res.json(), { ok: true, auth: "ok", models: [] });
    });
    assert.equal(seen.path, "/v1/responses");
    assert.equal(seen.body?.model, "resp-model");
    assert.equal(seen.body?.input, "hi");
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
      assert.deepEqual(body.total, { count: 2, ok: 1, failed: 1, input: 20, cached: 80, cacheWrite: 0, output: 7, cacheHitPercent: 80, avgMs: 200, conversationTokens: 107, ungroupedRequests: 1 });
    } finally {
      extra.close();
    }
  });
});

test("GET /api/requests takes a comma-separated kind list", async () => {
  await withAdmin(makeCfg(), async ({ home }) => {
    const requests = new RequestLog(path.join(home, "logs", "requests.jsonl"));
    requests.add({ id: "turn", at: new Date(Date.now() - 20_000).toISOString(), ms: 150, status: 200, ok: true, kind: "messages", source: "claude", target: "gpt", provider: "chatgpt", stream: true, usage: { input: 20, cached: 0, output: 7 } });
    requests.add({ id: "count", at: new Date(Date.now() - 10_000).toISOString(), ms: 5, status: 200, ok: true, kind: "count_tokens", source: "claude", target: "gpt", provider: "chatgpt", stream: false });
    requests.add({ id: "image", at: new Date().toISOString(), ms: 30_000, status: 200, ok: true, kind: "image", source: "gpt-6-astra", target: "image", provider: "gpt", stream: false, usage: { input: 2249, cached: 0, output: 75 }, note: "1536x1024 low png, 1 reference(s)" });
    const reloaded = new RequestLog(path.join(home, "logs", "requests.jsonl"));
    const cfg = makeCfg({ admin: { port: 0 } });
    const log = new Logger(null, 1_000_000, 1, false);
    const extra = await startAdmin({ config: () => cfg, configFile: path.join(home, "extra-config.json"), log, stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }), health: () => 0, version: "test", requests: reloaded });
    try {
      const ids = async (query: string): Promise<string[]> =>
        ((await (await fetch(`${base()}:${extra.port}/api/requests?n=10&${query}`)).json()) as { requests: { id: string }[] }).requests.map((r) => r.id);
      assert.deepEqual(await ids("kind=messages,image"), ["image", "turn"]);
      // An unknown entry is ignored, not an error; a list with nothing valid left means no filter.
      assert.deepEqual(await ids("kind=messages,nonsense"), ["turn"]);
      assert.deepEqual(await ids("kind=nonsense"), ["image", "count", "turn"]);
      assert.deepEqual(await ids("kind="), ["image", "count", "turn"]);
    } finally {
      extra.close();
    }
  });
});

test("GET /api/requests/summary?from=&to= answers any period from hourly usage", async () => {
  await withAdmin(makeCfg(), async ({ home }) => {
    const records = new RequestLog(path.join(home, "logs", "requests.jsonl"));
    records.add({ id: "a", at: "2026-10-20T10:05:00.000Z", ms: 100, status: 200, ok: true, kind: "messages", source: "claude", target: "gpt", provider: "chatgpt", stream: true, usage: { input: 20, cached: 80, output: 7 } });
    records.add({ id: "b", at: "2026-10-20T12:05:00.000Z", ms: 300, status: 500, ok: false, kind: "messages", source: "claude", target: "gpt", provider: "chatgpt", stream: true, usage: { input: 5, cached: 5, output: 1 } });
    const reloaded = new RequestLog(path.join(home, "logs", "requests.jsonl"));
    const cfg = makeCfg({ admin: { port: 0 } });
    const log = new Logger(null, 1_000_000, 1, false);
    const extra = await startAdmin({ config: () => cfg, configFile: path.join(home, "extra-config.json"), log, stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }), health: () => 0, version: "test", requests: reloaded });
    try {
      const from = Date.parse("2026-10-20T00:00:00.000Z");
      const to = Date.parse("2026-10-21T00:00:00.000Z");
      const res = await fetch(`${base()}:${extra.port}/api/requests/summary?from=${from}&to=${to}`);
      assert.equal(res.status, 200);
      const body = await res.json() as {
        total: { count: number; failed: number; input: number };
        models: { provider: string; model: string }[];
        earliest: string | null;
        from: number;
        to: number;
      };
      assert.equal(body.total.count, 2);
      assert.equal(body.total.failed, 1);
      assert.equal(body.total.input, 25);
      assert.deepEqual(body.models.map((m) => m.model), ["gpt"]);
      assert.equal(body.earliest, "2026-10-20T10:00:00.000Z");
      assert.equal(body.from, from);
      assert.equal(body.to, to);

      // Hour granularity: the record's own hour alone.
      const hourStart = Date.parse("2026-10-20T10:00:00.000Z");
      const firstHour = await fetch(`${base()}:${extra.port}/api/requests/summary?from=${hourStart}&to=${hourStart + 3_600_000}`);
      assert.deepEqual(((await firstHour.json()) as { total: { count: number } }).total.count, 1);

      for (const query of ["from=abc", "from=-1&to=0xq", `from=${to + 1}&to=${to}`]) {
        const bad = await fetch(`${base()}:${extra.port}/api/requests/summary?${query}`);
        assert.equal(bad.status, 400);
        assert.ok(typeof ((await bad.json()) as { error?: string }).error === "string");
      }
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

test("the dashboard's favicons are served, and /favicon.ico gets the PNG", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const svg = await fetch(`${base()}:${port}/favicon.svg`);
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    for (const route of ["/favicon-32.png", "/favicon.ico"]) {
      const res = await fetch(`${base()}:${port}${route}`);
      assert.equal(res.status, 200, route);
      assert.equal(res.headers.get("content-type"), "image/png", route);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", route);
    }
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

test("POST /api/shutdown refuses another installation's id, accepts its own and an older CLI", async () => {
  let called = 0;
  const ours = "a".repeat(32);
  await withAdmin(
    makeCfg(),
    async ({ port, home }) => {
      // A file rewritten while the process runs must not change what this process is.
      fs.writeFileSync(path.join(home, "installation-id"), `${"d".repeat(32)}\n`, { mode: 0o600 });
      const post = (id?: string) => fetch(`${base()}:${port}/api/shutdown`, { method: "POST", ...(id ? { headers: { "x-clauderipple-install-id": id } } : {}) });

      const foreign = await post("b".repeat(32));
      assert.equal(foreign.status, 409);
      assert.equal(called, 0, "another installation's request never drains this router");
      const disk = await post("d".repeat(32));
      assert.equal(disk.status, 409, "the id captured at start, not the file on disk, decides");

      const own = await post(ours);
      assert.equal(own.status, 202);
      assert.equal(called, 1);

      // A CLI from before the id existed sends no header; it keeps working as it did.
      const legacy = await post();
      assert.equal(legacy.status, 202);
      assert.equal(called, 2);
    },
    { shutdown: () => void called++, instance: { installId: ours, pid: 4242 } },
  );
});

test("status reports the identity this process captured at start", async () => {
  const ctx = { installId: "c".repeat(32), pid: 5150 };
  await withAdmin(makeCfg(), async ({ port, home }) => {
    const read = async () => (await (await fetch(`${base()}:${port}/api/status`)).json()) as { installId?: unknown; pid?: unknown };
    const before = await read();
    assert.equal(before.installId, ctx.installId);
    assert.equal(before.pid, ctx.pid);
    // The file changing later is not this process's identity.
    fs.writeFileSync(path.join(home, "installation-id"), `${"e".repeat(32)}\n`, { mode: 0o600 });
    const after = await read();
    assert.equal(after.installId, ctx.installId);
    assert.equal(after.pid, ctx.pid);
  }, { instance: ctx });
});

test("admin rejects rebinding Hosts and foreign write Origins but accepts dashboard and tray requests", async () => {
  const cfg = makeCfg({ providers: { p: { type: "anthropic-compatible", url: "http://127.0.0.1:9", headers: { "x-api-key": "test-secret" } } } });
  await withAdmin(cfg, async ({ port, configFile }) => {
    const request = (method: string, pathname: string, host?: string, origin?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, setHost: false,
        headers: { ...(host === undefined ? {} : { host }), ...(origin === undefined ? {} : { origin }) } }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject);
      req.end(method === "PUT" ? JSON.stringify(cfg) : undefined);
    });
    const before = fs.readFileSync(configFile, "utf8");
    for (const host of [undefined, "evil.example", `evil.example:${port}`, "127.0.0.1", "localhost:1", "[::1]:1", `127.1:${port}`, `localhost.evil.example:${port}`]) {
      for (const [method, pathname] of [["GET", "/api/config"], ["HEAD", "/api/config"], ["PUT", "/api/config"], ["GET", "/"]]) {
        const response = await request(method!, pathname!, host);
        assert.equal(response.status, host === undefined ? 400 : 403, `${method} ${pathname} Host=${host}`);
        assert.doesNotMatch(response.body, /test-secret/);
      }
    }
    for (const origin of ["https://evil.example", "null", "", "http://localhost:1", `https://localhost:${port}`, "ripple://app"]) {
      const response = await request("PUT", "/api/config", `127.0.0.1:${port}`, origin);
      assert.equal(response.status, 403, `Origin=${origin}`);
    }
    assert.equal(fs.readFileSync(configFile, "utf8"), before, "rejected requests cannot save");
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      assert.equal((await request("GET", "/api/config", host)).status, 200);
      assert.equal((await request("PUT", "/api/config", host, `http://${host}`)).status, 200);
    }
    // ripple://app's main-process forwarder sends the loopback Host and strips Origin.
    assert.equal((await request("PUT", "/api/config", `127.0.0.1:${port}`)).status, 200);
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

test("POST /api/providers/probe[chatgpt] reports the live catalogue when it can be read", async () => {
  // The model list is not ours to hardcode any more: a model OpenAI ships must appear without a
  // release here, and the response says which of the two answers the list came from.
  const live = [
    { id: "gpt-6-sol", name: "GPT-6 Sol", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 272000 },
    { id: "gpt-6-omega", name: "GPT-6 Omega", effortLevels: ["low", "high"] },
  ];
  const seen: string[] = [];
  await withAdmin(
    makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } }),
    async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "chatgpt", auth: "own", name: "gpt" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { models: { id: string }[]; modelsSource: string };
      assert.equal(body.modelsSource, "catalog");
      assert.deepEqual(body.models, live);
    },
    { chatgpt: () => ({ quota: { gpt: null }, auth: { gpt: "borrow-codex" }, models: (name: string) => { seen.push(name); return Promise.resolve(live); } }) },
  );
  assert.deepEqual(seen, ["gpt"], "the probe asks the provider the form named");
});

test("POST /api/providers/probe[chatgpt] falls back to the measured list when the catalogue is unreadable", async () => {
  await withAdmin(
    makeCfg({ providers: { gpt: { type: "chatgpt", auth: "own" } } }),
    async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "chatgpt", auth: "own" }),
      });
      const body = (await res.json()) as { models: { id: string }[]; modelsSource: string };
      assert.equal(body.modelsSource, "fallback");
      assert.deepEqual(body.models.map((m) => m.id), ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]);
    },
    { chatgpt: () => ({ quota: { gpt: null }, auth: { gpt: "borrow-codex" }, models: () => Promise.resolve(null) }) },
  );
});

test("POST /api/providers/probe[google] lists generateContent models across pages and mints effortLevels", async () => {
  const seen: { url: string; key: string | null }[] = [];
  const pages: Record<string, unknown> = {
    "": {
      models: [
        { name: "models/gemini-3-pro-preview", displayName: "Gemini 3 Pro Preview", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent", "countTokens"], thinking: true },
        { name: "models/text-embedding-004", displayName: "Embedding 004", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
      ],
      nextPageToken: "page2",
    },
    page2: {
      models: [
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 2097152, supportedGenerationMethods: ["generateContent"], thinking: true },
      ],
    },
  };
  await withAdmin(
    makeCfg(),
    async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "google", auth: "api-key", apiKey: "secret-key", url: "https://generativelanguage.googleapis.com" }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true,
        auth: "ok",
        models: [
          { id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview", contextWindow: 1048576, effortLevels: ["minimal", "low", "medium", "high"] },
          { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1048576 },
          { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 2097152, effortLevels: ["minimal", "low", "medium", "high"] },
        ],
      });
    },
    {
      probeFetch: async (url, init) => {
        seen.push({ url, key: new Headers(init.headers).get("x-goog-api-key") });
        const token = new URL(url).searchParams.get("pageToken") ?? "";
        return new Response(JSON.stringify(pages[token]), { status: 200 });
      },
    },
  );
  // The key rides on x-goog-api-key, not in the URL, and the second page is followed.
  assert.equal(seen[0]!.key, "secret-key");
  assert.equal(seen.length, 2, "follows nextPageToken");
  assert.match(seen[0]!.url, /\/v1beta\/models\?pageSize=1000$/);
  assert.match(seen[1]!.url, /pageToken=page2/);
});

test("POST /api/providers/probe[google] reads a bad key as bad-key without exposing it", async () => {
  await withAdmin(
    makeCfg(),
    async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "google", auth: "api-key", apiKey: "leaky-secret-key", url: "https://generativelanguage.googleapis.com" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; auth: string; error?: string };
      assert.equal(body.ok, false);
      assert.equal(body.auth, "bad-key");
      assert.doesNotMatch(JSON.stringify(body), /leaky-secret-key/, "the probe body never echoes the key");
    },
    {
      probeFetch: async () =>
        new Response(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "API_KEY_INVALID" } }), { status: 400 }),
    },
  );
});

test("POST /api/providers/probe[google] needs a key before it calls out", async () => {
  const prev = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "google", auth: "api-key" }) });
      assert.deepEqual(await res.json(), { ok: false, auth: "missing", models: [], error: "no API key; set one or GEMINI_API_KEY" });
    });
  } finally {
    if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
  }
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

// Measured 2026-09-22: `big-pickle`, the first entry of OpenCode Zen's catalogue, answers 403
// FreeTierError while `claude-fable-5` on the same key answers 402. Testing with whatever the
// vendor listed first reported a paying account as refused.
test("the connection test uses a model the preset names, not the head of the catalogue", async () => {
  let asked = "";
  const upstream = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ id: "big-pickle" }, { id: "glm-5.3" }, { id: "kimi-k3" }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      asked = (JSON.parse(raw) as { model: string }).model;
      // Only the free-tier head refuses, exactly as the vendor does.
      if (asked === "big-pickle") {
        res.writeHead(403, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { type: "FreeTierError", message: "free tier can only be used from within OpenCode" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [] }));
    });
  });
  await new Promise<void>((resolveP) => upstream.listen(0, "127.0.0.1", resolveP));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  try {
    await withAdmin(makeCfg(), async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "openai-compatible", url: `http://127.0.0.1:${address.port}/v1`,
          modelsUrl: `http://127.0.0.1:${address.port}/v1/models`,
          headers: { authorization: "Bearer sk-test" }, preset: "opencode-go",
        }),
      });
      assert.equal(((await res.json()) as { ok: boolean }).ok, true);
      assert.notEqual(asked, "big-pickle", "the catalogue's head is not what the test asks for");
      // Muse Spark heads the preset's list but speaks Responses; the test posts to Chat Completions.
      assert.equal(asked, "glm-5.3", "the preset's first Chat model is what answers here");
    });
  } finally { upstream.close(); }
});

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

test("measurement updates only its provider when another provider has the same model id", async () => {
  const cfg = makeCfg({ providers: {
    p: { type: "openai-compatible", url: "http://127.0.0.1:9/v1", caps: { reasoning: "effort", effortLevels: ["low"] }, models: [{ id: "shared", name: "P's model" }] },
    q: { type: "openai-compatible", url: "http://127.0.0.1:10/v1", models: [{ id: "shared", name: "Q's model" }] },
  } });
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "p", models: ["shared"] }),
    });
    assert.equal(started.status, 202);
    const job = await pollMeasure(port, ((await started.json()) as { jobId: string }).jobId);
    assert.equal(job.state, "done");
    const saved = JSON.parse(fs.readFileSync(configFile, "utf8")) as Config;
    assert.equal(saved.providers.p?.models?.[0]?.wire, "chat");
    assert.deepEqual(saved.providers.p?.models?.[0]?.effortLevels, ["low"]);
    assert.deepEqual(saved.providers.q, cfg.providers.q, "a shared id does not share measured capabilities");
  }, { measureFetch: stubFetch((_url, body) => body.reasoning_effort === undefined || body.reasoning_effort === "low" ? 200 : 400) });
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

test("effortLevelsForModel: the model's own ladder, else its provider's, else nothing", () => {
  const cfg = makeCfg({
    providers: {
      "opencode-go": {
        type: "openai-compatible",
        url: "https://opencode.ai/zen/go/v1",
        caps: { reasoning: "effort", effortLevels: ["none", "low", "medium", "high", "xhigh"] },
        models: [{ id: "glm-5.3-flash", effortLevels: ["low", "high", "max"] }, { id: "muse" }],
      },
    },
  });
  assert.deepEqual(effortLevelsForModel(cfg, "glm-5.3-flash"), ["low", "high", "max"]);
  assert.deepEqual(effortLevelsForModel(cfg, "muse"), ["none", "low", "medium", "high", "xhigh"]);
  assert.equal(effortLevelsForModel(cfg, "nobody-declares-me"), undefined);
});

// The catalogue states the ladder, so the only request is the one that settles the wire — and a
// model newer than the preset's table is sent down the catalogue's wire first. Shapes as models.dev
// served them 2026-10-02: space-bunny-free has no SDK of its own (so the provider's Chat one), and
// glm-5.3-flash takes low/high/max although it answers 200 to more.
test("a model the catalogue describes is measured with one request and takes the catalogue's ladder", async () => {
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
        models: [{ id: "space-bunny-free", name: "Space Bunny" }, { id: "glm-5.3-flash", name: "GLM" }, { id: "unlisted", name: "Unlisted" }],
      },
    },
  });
  const modelCatalog = async (): Promise<unknown> => ({
    "opencode-go": {
      npm: "@ai-sdk/openai-compatible",
      models: {
        "space-bunny-free": { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }] },
        "glm-5.3-flash": { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
      },
    },
  });
  const seen: { url: string; model: string }[] = [];
  const measureFetch = async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, model: (JSON.parse(String(init.body)) as { model: string }).model });
    return new Response("{}", { status: url.endsWith("/chat/completions") ? 200 : 503 });
  };
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "opencode-go", models: ["space-bunny-free", "glm-5.3-flash", "unlisted"] }),
    });
    const job = await pollMeasure(port, ((await started.json()) as { jobId: string }).jobId);
    assert.equal(job.state, "done");
    const bunny = seen.filter((s) => s.model === "space-bunny-free");
    assert.deepEqual(bunny.map((s) => s.url), ["https://opencode.ai/zen/go/v1/chat/completions"], "the catalogue's wire first, and nothing after it answers");
    assert.equal(seen.filter((s) => s.model === "glm-5.3-flash").length, 1);
    assert.ok(seen.filter((s) => s.model === "unlisted").length > 2, "a model the catalogue lacks is measured as before");
    const models = (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers["opencode-go"]!.models!;
    assert.deepEqual(models.find((m) => m.id === "space-bunny-free")?.effortLevels, ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(models.find((m) => m.id === "glm-5.3-flash")?.effortLevels, ["low", "high", "max"]);
    assert.equal(models.find((m) => m.id === "glm-5.3-flash")?.wire, "chat");
  }, { measureFetch, modelCatalog });
});

// OpenCode's `/models` reports ids alone, so a model the catalogue lists has no window unless the
// catalogue's `limit.context` is written in. It goes only into a blank field (the user's stands).
test("measurement writes the catalogue's context window into a model that has none, and never overwrites one", async () => {
  const cfg = makeCfg({
    providers: {
      "opencode-go": {
        type: "openai-compatible",
        url: "https://opencode.ai/zen/go/v1",
        wire: "responses",
        preset: "opencode-go",
        headers: { authorization: "Bearer sk-test" },
        models: [
          { id: "muse-spark-1.3-contributor", name: "Muse", contextWindow: 999 },
          { id: "deepseek-v4.1-flash", name: "DeepSeek" },
        ],
      },
    },
  });
  const modelCatalog = async (): Promise<unknown> => ({
    "opencode-go": {
      models: {
        "muse-spark-1.3-contributor": { reasoning: true, reasoning_options: [{ type: "effort", values: ["max"] }], limit: { context: 1048576 } },
        "deepseek-v4.1-flash": { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }], limit: { context: 1000000 } },
      },
    },
  });
  const measureFetch = async (): Promise<Response> => new Response("{}", { status: 200 });
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "opencode-go", models: ["muse-spark-1.3-contributor", "deepseek-v4.1-flash"] }),
    });
    const job = await pollMeasure(port, ((await started.json()) as { jobId: string }).jobId);
    assert.equal(job.state, "done");
    const models = (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers["opencode-go"]!.models!;
    assert.equal(models.find((m) => m.id === "muse-spark-1.3-contributor")?.contextWindow, 999, "a window already set is not overwritten");
    assert.equal(models.find((m) => m.id === "deepseek-v4.1-flash")?.contextWindow, 1000000);
  }, { measureFetch, modelCatalog });
});

// The same window for models already saved: OpenCode's ids-only `/models` left them without one, so
// they fell back to `cli.autoCompactWindow`. The backfill reaches them once, at start-up.
test("backfillContextWindows fills only models without a window, leaving a set one alone", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-window-"));
  try {
    const cfg = makeCfg({
      providers: {
        "opencode-go": {
          type: "openai-compatible",
          url: "https://opencode.ai/zen/go/v1",
          preset: "opencode-go",
          headers: { authorization: "Bearer sk-test" },
          models: [
            // A saved null is blank too: the live config carried `"contextWindow": null` (2026-10-28).
            { id: "muse-spark-1.3-contributor", name: "Muse", contextWindow: null as unknown as number },
            { id: "deepseek-v4.1-flash", name: "DeepSeek", contextWindow: 123 },
            { id: "not-listed", name: "Unlisted" },
          ],
        },
      },
    });
    const configFile = path.join(home, "config.json");
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
    const lines: string[] = [];
    const log = new Logger(null, 1_000_000, 1, false);
    log.info = (msg: string) => { lines.push(msg); };
    const modelCatalog = async (): Promise<unknown> => ({
      "opencode-go": { models: { "muse-spark-1.3-contributor": { limit: { context: 1048576 } }, "deepseek-v4.1-flash": { limit: { context: 1000000 } } } },
    });
    const deps = { config: () => cfg, configFile, log, modelCatalog } as unknown as AdminDeps;
    assert.deepEqual(await backfillContextWindows(deps), ["opencode-go/muse-spark-1.3-contributor"]);
    const models = (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers["opencode-go"]!.models!;
    assert.equal(models.find((m) => m.id === "muse-spark-1.3-contributor")?.contextWindow, 1048576);
    assert.equal(models.find((m) => m.id === "deepseek-v4.1-flash")?.contextWindow, 123, "the vendor's own window stands");
    assert.equal("contextWindow" in (models.find((m) => m.id === "not-listed") ?? {}), false);
    assert.ok(lines.some((line) => line === "admin: opencode-go/muse-spark-1.3-contributor context window 1048576 (catalogue)"), `expected the catalogue log line, got ${JSON.stringify(lines)}`);
    assert.deepEqual(await backfillContextWindows(deps), [], "a second pass finds nothing left to fill");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Hive's `/models` states `object, created, owned_by, shutdown_date` and nothing else, and models.dev
// has no block for it: the window comes from the same model filed under a provider it does know.
test("backfillContextWindows fills a provider with no catalogue block from the same model's entry elsewhere", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-window-"));
  try {
    const cfg = makeCfg({
      providers: {
        hive: {
          type: "openai-compatible",
          url: "https://api-cdn.thehive.ai/api/v3",
          headers: { authorization: "Bearer sk-test" },
          models: [
            { id: "deepseek-ai/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" },
            { id: "zai-org/glm-5.3-flash", name: "GLM-5.3 Flash", contextWindow: 111 },
            { id: "jev-1.13", name: "JEV" },
          ],
        },
      },
    });
    const configFile = path.join(home, "config.json");
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
    const lines: string[] = [];
    const log = new Logger(null, 1_000_000, 1, false);
    log.info = (msg: string) => { lines.push(msg); };
    const modelCatalog = async (): Promise<unknown> => ({
      "opencode-go": { models: { "deepseek-v4.1-flash": { limit: { context: 1000000 } }, "glm-5.3-flash": { limit: { context: 1000000 } } } },
      scaleway: { models: { "deepseek-v4.1-flash": { limit: { context: 256000 } } } },
    });
    const deps = { config: () => cfg, configFile, log, modelCatalog } as unknown as AdminDeps;
    assert.deepEqual(await backfillContextWindows(deps), ["hive/deepseek-ai/deepseek-v4.1-flash-1017"]);
    const models = (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers.hive!.models!;
    assert.equal(models.find((m) => m.id === "deepseek-ai/deepseek-v4.1-flash-1017")?.contextWindow, 256000, "the smallest window the catalogue states");
    assert.equal(models.find((m) => m.id === "zai-org/glm-5.3-flash")?.contextWindow, 111, "the operator's own window stands");
    assert.equal("contextWindow" in (models.find((m) => m.id === "jev-1.13") ?? {}), false, "a model the catalogue does not list stays blank");
    assert.ok(lines.some((line) => line === "admin: hive/deepseek-ai/deepseek-v4.1-flash-1017 context window 256000 (catalogue)"), `expected the catalogue log line, got ${JSON.stringify(lines)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The same fold on the measurement path, which is what a provider saved by hand goes through.
test("measurement gives a provider with no catalogue block the window its model has elsewhere", async () => {
  const cfg = makeCfg({
    providers: {
      hive: {
        type: "openai-compatible",
        url: "https://api-cdn.thehive.ai/api/v3",
        wire: "chat",
        headers: { authorization: "Bearer sk-test" },
        models: [
          { id: "deepseek-ai/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" },
          { id: "zai-org/glm-5.3-flash", name: "GLM-5.3 Flash", contextWindow: 777 },
        ],
      },
    },
  });
  const modelCatalog = async (): Promise<unknown> => ({
    "opencode-go": { models: { "deepseek-v4.1-flash": { limit: { context: 1000000 } }, "glm-5.3-flash": { limit: { context: 1000000 } } } },
    scaleway: { models: { "deepseek-v4.1-flash": { limit: { context: 256000 } } } },
  });
  const measureFetch = async (): Promise<Response> => new Response("{}", { status: 200 });
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "hive", models: ["deepseek-ai/deepseek-v4.1-flash-1017", "zai-org/glm-5.3-flash"] }),
    });
    const job = await pollMeasure(port, ((await started.json()) as { jobId: string }).jobId);
    assert.equal(job.state, "done");
    const models = (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers.hive!.models!;
    assert.equal(models.find((m) => m.id === "deepseek-ai/deepseek-v4.1-flash-1017")?.contextWindow, 256000);
    assert.equal(models.find((m) => m.id === "zai-org/glm-5.3-flash")?.contextWindow, 777, "a window already set is not overwritten");
  }, { measureFetch, modelCatalog });
});

test("a model the plan refuses is still reported when the catalogue lists it", async () => {
  const cfg = makeCfg({
    providers: {
      "opencode-go": {
        type: "openai-compatible",
        url: "https://opencode.ai/zen/go/v1",
        wire: "responses",
        preset: "opencode-go",
        headers: { authorization: "Bearer sk-test" },
        caps: { reasoning: "effort", effortLevels: ["low"] },
        models: [{ id: "x-free", name: "Free" }],
      },
    },
  });
  const modelCatalog = async (): Promise<unknown> => ({ "opencode-go": { models: { "x-free": { reasoning_options: [{ type: "effort", values: ["low"] }] } } } });
  const measureFetch = async (): Promise<Response> => new Response("OpenCode's free tier can only be used from within OpenCode", { status: 403 });
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "opencode-go", models: ["x-free"] }),
    });
    const job = await pollMeasure(port, ((await started.json()) as { jobId: string }).jobId);
    const [result] = job.results as { error?: string; effortLevels?: string[] }[];
    assert.match(result?.error ?? "", /^not-entitled/);
    assert.equal(result?.effortLevels, undefined, "a model that did not answer is not given the catalogue's ladder");
    assert.equal("effortLevels" in (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers["opencode-go"]!.models![0]!, false);
  }, { measureFetch, modelCatalog });
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

test("google (antigravity) probe reports no account with the static catalogue and never a token", async () => {
  await withAdmin(makeCfg(), async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "google", auth: "antigravity" }) });
    const body = await res.json() as { ok: boolean; auth: string; models: { id: string }[]; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.auth, "missing");
    assert.match(body.error, /clauderipple google-login/);
    assert.ok(body.models.some((m) => m.id === "gemini-3.8-flash"));
  });
});

test("google login: the API returns the terms warning and account endpoints expose no token", async () => {
  const googleToken = "ya29.SECRET-GOOGLE-TOKEN";
  const seen: string[] = [];
  const googleOAuthFetch = async (url: string): Promise<Response> => {
    seen.push(url);
    if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: googleToken, refresh_token: "1//SECRET-REFRESH", expires_in: 3600 }), { status: 200 });
    if (url.includes("userinfo")) return new Response(JSON.stringify({ email: "g@example.test", id: "1" }), { status: 200 });
    if (url.includes("loadCodeAssist")) return new Response(JSON.stringify({ cloudaicompanionProject: "proj-1" }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  const google = () => ({
    accounts: () => ({ ag: [
      { id: "acct-1", label: "g@example.test", email: "g@example.test", projectId: "proj-1", expiresAt: Date.now() + 3_600_000, needsReauth: false, paused: false, preferred: false, inUse: true, state: "ready" as const, active: true },
    ] }),
    models: async () => [{ id: "gemini-3.8-flash" }],
    clearCooldown: () => {},
  });
  await withAdmin(makeCfg({ providers: { ag: { type: "google", auth: "antigravity" } } }), async ({ port }) => {
    const idle = await (await fetch(`${base()}:${port}/api/google-login`)).json() as { running: boolean; termsWarning: string };
    assert.equal(idle.running, false);
    assert.match(idle.termsWarning, /Antigravity terms|Gemini CLI FAQ/);

    const started = await fetch(`${base()}:${port}/api/google-login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const startedBody = await started.json() as { running: boolean; url: string; termsWarning: string };
    assert.equal(startedBody.running, true);
    assert.ok(startedBody.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth"));
    assert.match(startedBody.termsWarning, /not affiliated with Google/);

    // Drive the loopback callback so the sign-in completes and an account is stored.
    const state = new URL(startedBody.url).searchParams.get("state")!;
    const callbackPort = new URL(startedBody.url).searchParams.get("redirect_uri")!;
    await fetch(`${callbackPort}?code=good&state=${state}`).catch(() => {});
    // Wait for the exchange to finish.
    for (let i = 0; i < 50; i++) {
      const s = await (await fetch(`${base()}:${port}/api/google-login`)).json() as { running: boolean };
      if (!s.running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const done = await (await fetch(`${base()}:${port}/api/google-login`)).json() as { ok: boolean; account: { email?: string; id: string } | null };
    assert.equal(done.ok, true);
    assert.equal(done.account?.email, "g@example.test");
    assert.equal(JSON.stringify(done).includes(googleToken), false);

    const accounts = await (await fetch(`${base()}:${port}/api/google-accounts?provider=ag`)).json() as { accounts: { state: string }[] };
    assert.equal(accounts.accounts[0]?.state, "ready");
    assert.equal(JSON.stringify(accounts).includes(googleToken), false);
    assert.equal(JSON.stringify(accounts).includes("1//SECRET-REFRESH"), false);
  }, { googleOAuthFetch, google, openBrowser: () => true, googleOAuthPort: 0 });
});

test("update: the CLI decides what an update is; a POST starts it detached once, and only where it can run", async () => {
  let check = { current: "1.0.0", latest: "1.1.0", newer: true, kind: "checkout" };
  const started: { args: string[]; log: string }[] = [];
  await withAdmin(makeCfg(), async ({ port }) => {
    const get = await fetch(`${base()}:${port}/api/update`);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { ...check, running: false });

    const post = () => fetch(`${base()}:${port}/api/update`, { method: "POST" });
    assert.equal((await post()).status, 409, "a source checkout is not updated from the GUI");
    check = { ...check, kind: "script", newer: false };
    assert.equal((await post()).status, 409, "nothing newer, nothing to run");
    assert.equal(started.length, 0);

    check = { ...check, newer: true };
    const first = await post();
    assert.equal(first.status, 202);
    assert.deepEqual(started.map((s) => s.args), [["update"]]);
    assert.ok(started[0]!.log.endsWith(path.join("logs", "update.log")));
    assert.equal((await post()).status, 409, "a second click while it runs starts nothing");
    assert.equal(started.length, 1);
    assert.equal(((await (await fetch(`${base()}:${port}/api/update`)).json()) as { running: boolean }).running, true);

    const crossSite = await fetch(`${base()}:${port}/api/update`, { method: "POST", headers: { origin: "https://evil.example" } });
    assert.equal(crossSite.status, 403);
  }, {
    runCli: async (args) => {
      assert.deepEqual(args, ["update", "--check", "--json"]);
      return { ok: true, output: `npm notice\n${JSON.stringify(check)}` };
    },
    startCliDetached: (args, log) => { started.push({ args, log }); },
  });
});

test("update: a check the CLI could not answer is an error, not a guess", () => {
  assert.equal(parseUpdateCheck("error: npm registry answered HTTP 503"), null);
  assert.deepEqual(parseUpdateCheck('{"current":"1.0.0","latest":null,"newer":true,"kind":"npm"}'), { current: "1.0.0", latest: null, newer: true, kind: "npm" });
});

test("an Antigravity provider reads as usable only when an account can answer", () => {
  const account = (state: GoogleAccountStatus["state"]): GoogleAccountStatus => ({ id: state, label: state, projectId: "p", expiresAt: 0, needsReauth: false, paused: state === "paused", preferred: false, inUse: state === "ready", state, active: false });
  assert.deepEqual(googleHealth([]), { needsLogin: true });
  assert.deepEqual(googleHealth([account("needs-login")]), { needsLogin: true });
  assert.deepEqual(googleHealth([account("needs-verification")]), { needsLogin: false, needsVerification: true });
  assert.deepEqual(googleHealth([account("needs-verification"), account("ready")]), { needsLogin: false });
  assert.deepEqual(googleHealth([account("paused")]), { needsLogin: false });
});

// A provider set up before effort discovery stays without effort until someone saves it again, so
// the router measures those models itself. Only models whose effort is stripped and unsettled.
test("measureUnsettledModels: discovers effort for a ladderless provider's unsettled models, and nothing else", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-unsettled-"));
  try {
    const cfg = makeCfg({
      providers: {
        kimi: { type: "anthropic-compatible", url: "http://127.0.0.1:9", preset: "kimi", models: [{ id: "kimi-k3" }, { id: "kimi-settled", effortLevels: [] }] },
        // DeepSeek's preset declares low/high/max, which requests already use: nothing to discover.
        deepseek: { type: "anthropic-compatible", url: "http://127.0.0.1:9", preset: "deepseek", models: [{ id: "deepseek-v4-pro" }] },
        // The provider form writes `reasoning: "none"` for any OpenAI-compatible provider without a
        // preset ladder; that is a default, not a decision. This endpoint ignores the field.
        groq: { type: "openai-compatible", url: "http://127.0.0.1:9/v1", wire: "chat", caps: { reasoning: "none", effortLevels: [] }, models: [{ id: "llama-4" }] },
        // `reasoning: "effort"` with no levels passes effort through as asked: nothing to discover.
        relay: { type: "openai-compatible", url: "http://127.0.0.1:9/v1", wire: "chat", caps: { reasoning: "effort", effortLevels: [] }, models: [{ id: "relayed" }] },
      },
    });
    const configFile = path.join(home, "config.json");
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
    const asked = new Set<string>();
    const measureFetch = stubFetch((_url, body) => {
      const effort = body.output_config?.effort ?? body.reasoning_effort;
      if (body.reasoning_effort !== undefined) return 200;
      return effort === undefined ? 200 : effort === "clauderipple-probe" ? 400 : ["low", "high"].includes(effort) ? 200 : 400;
    });
    const deps = {
      config: () => cfg,
      configFile,
      log: new Logger(null, 1_000_000, 1, false),
      measureFetch: async (url: string, init: RequestInit) => {
        asked.add(String((JSON.parse(String(init.body)) as { model: string }).model));
        return measureFetch(url, init);
      },
    } as unknown as AdminDeps;
    assert.equal(measureUnsettledModels(deps), 2, "two jobs: Kimi and Groq");
    let onDisk: Config | undefined;
    for (let i = 0; i < 200 && !(onDisk?.providers.kimi?.models?.[0]?.effortLevels && onDisk?.providers.groq?.models?.[0]?.effortLevels); i++) {
      await new Promise((resolveP) => setTimeout(resolveP, 5));
      onDisk = JSON.parse(fs.readFileSync(configFile, "utf8")) as Config;
    }
    assert.deepEqual(onDisk?.providers.kimi?.models?.[0]?.effortLevels, ["low", "high"], "validated, and these two accepted");
    assert.deepEqual(onDisk?.providers.kimi?.models?.[1]?.effortLevels, [], "a settled model is left as it was");
    assert.deepEqual(onDisk?.providers.groq?.models?.[0]?.effortLevels, [], "a field the endpoint ignores is no effort");
    assert.deepEqual([...asked].sort(), ["kimi-k3", "llama-4"], "not the settled model, DeepSeek or the pass-through relay");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Ollama states a model's thinking levels and context length in its own `/api/show`. Its
// OpenAI-compatible surface reports ids alone and ignores an unknown `reasoning_effort`, which a
// probe measured as "no effort" — an empty ladder that then looked settled (Discord, 0.12.14).
test("an Ollama model's effort and context come from /api/show, and an empty ladder is filled", async () => {
  const cfg = makeCfg({
    providers: {
      "ollama-cloud": {
        type: "openai-compatible",
        url: "https://ollama.com/v1",
        headers: { authorization: "Bearer key" },
        caps: { reasoning: "none", effortLevels: [] },
        models: [
          { id: "gpt-oss:120b", name: "GPT-OSS 120B", effortLevels: [] },
          { id: "qwen3:235b", name: "Qwen3 235B", effortLevels: ["low"] },
        ],
      },
    },
  });
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const measureFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, body });
    if (!url.endsWith("/api/show")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify(body.model === "gpt-oss:120b"
      ? { thinking: { values: ["low", "medium", "high"] }, model_info: { "gptoss.context_length": 1048576 } }
      : { model_info: { "qwen3.context_length": 262144 } }), { status: 200 });
  };
  await withAdmin(cfg, async ({ port, configFile }) => {
    const started = await fetch(`${base()}:${port}/api/providers/measure`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "ollama-cloud", models: ["gpt-oss:120b", "qwen3:235b"] }),
    });
    const job = await pollMeasure(port, ((await started.json()) as { jobId: string }).jobId);
    assert.equal(job.state, "done");
    assert.deepEqual(calls.filter((c) => c.url === "https://ollama.com/api/show").map((c) => c.body.model), ["gpt-oss:120b", "qwen3:235b"]);
    assert.equal(calls.some((c) => "reasoning_effort" in c.body), false, "no ladder probing: the vendor states it");
    const models = (JSON.parse(fs.readFileSync(configFile, "utf8")) as Config).providers["ollama-cloud"]!.models!;
    assert.deepEqual(models.find((m) => m.id === "gpt-oss:120b")?.effortLevels, ["low", "medium", "high"], "an empty ladder is a blank on Ollama");
    assert.equal(models.find((m) => m.id === "gpt-oss:120b")?.contextWindow, 1048576);
    assert.deepEqual(models.find((m) => m.id === "qwen3:235b")?.effortLevels, ["low"], "a ladder someone set stands");
    assert.equal(models.find((m) => m.id === "qwen3:235b")?.contextWindow, 262144);
  }, { measureFetch });
});

test("measureUnsettledModels re-measures Ollama's empty ladders, and leaves an empty one elsewhere", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ollama-"));
  try {
    const cfg = makeCfg({
      providers: {
        ollama: {
          type: "openai-compatible",
          url: "http://127.0.0.1:11434/v1",
          preset: "ollama",
          caps: { reasoning: "none", effortLevels: [] },
          models: [{ id: "llama3.3" }, { id: "qwen3", effortLevels: [] }, { id: "settled", effortLevels: ["low"] }],
        },
        // Same empty ladder, but not Ollama: there an empty ladder is a decision and stands.
        groq: { type: "openai-compatible", url: "http://127.0.0.1:9/v1", wire: "chat", caps: { reasoning: "none", effortLevels: [] }, models: [{ id: "llama-4", effortLevels: [] }, { id: "blank" }] },
      },
    });
    const configFile = path.join(home, "config.json");
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
    const asked: string[] = [];
    const measureFetch = async (url: string, init: RequestInit): Promise<Response> => {
      const model = (JSON.parse(String(init.body)) as { model: string }).model;
      asked.push(model);
      if (!url.endsWith("/api/show")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ thinking: { values: ["low", "high"] }, model_info: { "qwen3.context_length": 131072 } }), { status: 200 });
    };
    const deps = { config: () => cfg, configFile, log: new Logger(null, 1_000_000, 1, false), measureFetch } as unknown as AdminDeps;
    assert.equal(measureUnsettledModels(deps), 2, "the Ollama provider and the ladderless one");
    let onDisk: Config | undefined;
    const models = () => onDisk?.providers.ollama?.models ?? [];
    for (let i = 0; i < 200 && !(models().find((m) => m.id === "llama3.3")?.effortLevels?.length && models().find((m) => m.id === "qwen3")?.contextWindow); i++) {
      await new Promise((resolveP) => setTimeout(resolveP, 5));
      onDisk = JSON.parse(fs.readFileSync(configFile, "utf8")) as Config;
    }
    assert.deepEqual(models().find((m) => m.id === "llama3.3")?.effortLevels, ["low", "high"], "an unset ladder is stated now");
    assert.deepEqual(models().find((m) => m.id === "qwen3")?.effortLevels, ["low", "high"], "the empty ladder is replaced");
    assert.equal(models().find((m) => m.id === "qwen3")?.contextWindow, 131072);
    assert.deepEqual(models().find((m) => m.id === "settled")?.effortLevels, ["low"], "a ladder someone set stands");
    assert.deepEqual(onDisk?.providers.groq?.models?.[0]?.effortLevels, [], "an empty ladder elsewhere is still a decision");
    assert.ok(!asked.includes("settled"), `a settled model is not measured: ${JSON.stringify(asked)}`);
    assert.ok(!asked.includes("llama-4"), `a non-Ollama empty ladder is not measured: ${JSON.stringify(asked)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("POST /api/providers/probe[grok] lists the proxy's models with the headers live traffic sends, and warns", async () => {
  const grokHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-grok-probe-"));
  fs.writeFileSync(path.join(grokHomeDir, "auth.json"), JSON.stringify({ "https://auth.x.ai::u": { key: "grok-session-secret", expires_at: new Date(Date.now() + 5 * 3600_000).toISOString() } }));
  const seen: { url: string; headers: Headers }[] = [];
  await withAdmin(
    makeCfg(),
    async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "grok", home: grokHomeDir, clientVersion: "1.0.46" }),
      });
      const body = (await res.json()) as { ok: boolean; auth: string; models: { id: string; effortLevels?: string[]; contextWindow?: number }[]; modelsSource: string; warning: string };
      assert.equal(body.ok, true);
      assert.equal(body.auth, "ok");
      assert.equal(body.modelsSource, "catalog");
      assert.deepEqual(body.models, [{ id: "grok-4.7", name: "Grok 4.7", contextWindow: 256000, effortLevels: ["low", "medium", "high", "xhigh"] }]);
      assert.match(body.warning, /not affiliated with xAI/);
      assert.doesNotMatch(JSON.stringify(body), /grok-session-secret/);
    },
    {
      probeFetch: async (url, init) => {
        seen.push({ url, headers: new Headers(init.headers) });
        return new Response(JSON.stringify({ object: "list", data: [{ id: "grok-4.7", name: "Grok 4.7", context_window: 256000, supports_reasoning_effort: true, reasoning_efforts: [{ value: "xhigh" }, { value: "high" }, { value: "medium" }, { value: "low" }] }] }), { status: 200 });
      },
    },
  );
  assert.equal(seen[0]!.url, "https://cli-chat-proxy.grok.com/v1/models");
  assert.equal(seen[0]!.headers.get("authorization"), "Bearer grok-session-secret");
  assert.equal(seen[0]!.headers.get("x-xai-token-auth"), "xai-grok-cli");
  assert.equal(seen[0]!.headers.get("x-grok-client-version"), "1.0.46");
});

test("POST /api/providers/probe[grok]: two probes at once share one CLI refresh", { skip: process.platform === "win32" }, async () => {
  const grokHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-grok-probe-"));
  const auth = (key: string, ms: number) => JSON.stringify({ "https://auth.x.ai::u": { key, expires_at: new Date(Date.now() + ms).toISOString() } });
  fs.writeFileSync(path.join(grokHomeDir, "auth.json"), auth("grok-old", 5 * 60_000));
  fs.writeFileSync(path.join(grokHomeDir, "fresh.json"), auth("grok-new", 6 * 3600_000));
  fs.mkdirSync(path.join(grokHomeDir, "bin"));
  // Plays `grok models` refreshing the session: slow enough for the second probe to arrive meanwhile.
  fs.writeFileSync(path.join(grokHomeDir, "bin", "grok"), `#!/bin/sh\necho "$1" >> "${grokHomeDir}/runs"\nsleep 0.3\ncp "${grokHomeDir}/fresh.json" "${grokHomeDir}/auth.json"\n`, { mode: 0o755 });
  const sent: string[] = [];
  await withAdmin(
    makeCfg(),
    async ({ port }) => {
      const probe = () => fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "grok", home: grokHomeDir, clientVersion: "1.0.46" }) }).then((res) => res.json() as Promise<{ ok: boolean }>);
      const results = await Promise.all([probe(), probe()]);
      assert.deepEqual(results.map((r) => r.ok), [true, true]);
    },
    {
      probeFetch: async (_url, init) => {
        sent.push(new Headers(init.headers).get("authorization") ?? "");
        return new Response(JSON.stringify({ object: "list", data: [{ id: "grok-4.7" }] }), { status: 200 });
      },
    },
  );
  assert.deepEqual(fs.readFileSync(path.join(grokHomeDir, "runs"), "utf8").trim().split("\n"), ["models"], "one CLI run for both probes");
  assert.deepEqual(sent, ["Bearer grok-new", "Bearer grok-new"]);
});

test("POST /api/providers/probe[grok] refuses a clientVersion that cannot be a header, before calling anything", async () => {
  const grokHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-grok-probe-"));
  fs.writeFileSync(path.join(grokHomeDir, "auth.json"), JSON.stringify({ "https://auth.x.ai::u": { key: "grok-session-secret", expires_at: new Date(Date.now() + 5 * 3600_000).toISOString() } }));
  let called = false;
  await withAdmin(
    makeCfg(),
    async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "grok", home: grokHomeDir, clientVersion: "1.0.46\r\nx: y" }) });
      const body = (await res.json()) as { ok: boolean; error: string };
      assert.equal(body.ok, false);
      assert.match(body.error, /clientVersion cannot be sent as a header/);
    },
    { probeFetch: async () => { called = true; return new Response("{}", { status: 200 }); } },
  );
  assert.equal(called, false);
});

test("POST /api/providers/probe[grok] without a session says to sign in and calls nothing", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cr-grok-probe-"));
  let called = false;
  await withAdmin(
    makeCfg(),
    async ({ port }) => {
      const res = await fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "grok", home: empty, clientVersion: "1.0.46" }) });
      const body = (await res.json()) as { ok: boolean; auth: string; error: string; modelsSource: string; models: unknown[] };
      assert.equal(body.ok, false);
      assert.equal(body.auth, "missing");
      assert.match(body.error, /grok login/);
      assert.equal(body.modelsSource, "fallback");
      assert.ok(body.models.length > 0, "the measured list is still offered");
    },
    { probeFetch: async () => { called = true; return new Response("{}", { status: 200 }); } },
  );
  assert.equal(called, false);
});

test("GET /api/limits keeps Argon weekly separate from Gemini and hides only unselected 3P windows", async () => {
  const now = Date.now();
  const resetAt = Math.floor((now + 7 * 86_400_000) / 1000);
  const resetTime = new Date(resetAt * 1000).toISOString();
  const bucket = (bucketId: string, window: string, remainingFraction: number) => ({ bucketId, displayName: window, window, remainingFraction, resetTime });
  const gemini: QuotaGroup = { displayName: "Gemini Models", buckets: [bucket("gemini-5h", "5h", 0.87), bucket("gemini-weekly", "weekly", 0.76)] };
  const argon: QuotaGroup = { displayName: "Gemini 4 Argon", buckets: [bucket("gemini-argon-wtu-weekly", "weekly", 0.35)] };
  const thirdParty: QuotaGroup = { displayName: "Claude and GPT models", buckets: [bucket("3p-5h", "5h", 0.45), bucket("3p-weekly", "weekly", 0.25)] };
  const account = (id: string, state: GoogleAccountStatus["state"] = "ready"): GoogleAccountStatus => ({
    id, label: id, projectId: `project-${id}`, expiresAt: now + 3_600_000, needsReauth: state === "needs-login",
    paused: state === "paused", preferred: false, inUse: id === "a", state, active: id === "a",
  });
  const groups: Record<string, QuotaGroup[]> = {
    a: [gemini, thirdParty, argon],
    // Missing Argon stays unknown, not a copy of this account's general Gemini windows.
    b: [gemini, thirdParty],
    c: [argon],
    paused: [gemini, thirdParty, argon],
    login: [gemini, thirdParty, argon],
  };
  const cfg = makeCfg({ providers: { gem: { type: "google", auth: "antigravity", models: [{ id: "gemini-4-argon" }] } } });
  const generalWindows = [
    { kind: "five_hour", used_percent: 13, window_minutes: 300, reset_at: resetAt },
    { kind: "seven_day", used_percent: 24, window_minutes: 10080, reset_at: resetAt },
  ];
  const argonWindow = { kind: "scoped", label: "Argon weekly", used_percent: 65, window_minutes: 10080, reset_at: resetAt };
  const thirdPartyWindows = [
    { kind: "scoped", label: "3P", used_percent: 55, window_minutes: 300, reset_at: resetAt },
    { kind: "scoped", label: "3P", used_percent: 75, window_minutes: 10080, reset_at: resetAt },
  ];
  await withAdmin(cfg, async ({ port, setCfg }) => {
    const read = async () => {
      const response = await fetch(`${base()}:${port}/api/limits`);
      assert.equal(response.status, 200);
      const body = await response.json() as { providers: LimitsProvider[] };
      assert.deepEqual(body.providers.map(p => [p.provider, p.type, p.title]), [["gem", "google", "Gemini"]]);
      return body.providers[0]!.accounts;
    };
    // Selecting no models, Argon alone, or any other Gemini model never makes Argon a 3P quota.
    for (const ids of [[], ["gemini-4-argon"], ["gemini-3.8-flash"], ["gemini-3.8-flash", "gemini-4-argon"]]) {
      setCfg({ ...cfg, providers: { gem: { type: "google", auth: "antigravity", models: ids.map(id => ({ id })) } } });
      const accounts = await read();
      assert.deepEqual(accounts.map(a => a.account), [0, 1, 2], "paused and needs-login accounts are omitted");
      assert.deepEqual(accounts.map(a => a.windows), [
        [...generalWindows, argonWindow], generalWindows, [argonWindow],
      ], `Gemini and Argon remain independent with ${JSON.stringify(ids)} selected`);
    }
    // Either supported third-party family enables its windows without relabeling Argon or Gemini.
    for (const id of ["claude-sonnet-5-5-low", "gpt-oss-120b-medium"]) {
      setCfg({ ...cfg, providers: { gem: { type: "google", auth: "antigravity", models: [{ id: "gemini-4-argon" }, { id }] } } });
      const accounts = await read();
      assert.deepEqual(accounts.map(a => a.windows), [
        [...generalWindows, ...thirdPartyWindows, argonWindow], [...generalWindows, ...thirdPartyWindows], [argonWindow],
      ]);
    }
  }, { google: () => ({
    accounts: () => ({ gem: [account("paused", "paused"), account("a"), account("login", "needs-login"), account("b"), account("c")] }),
    usage: async (name: string) => { assert.equal(name, "gem"); return groups; },
  }) });
});

test("GET /api/limits assembles every readable provider and honours limits:false", async () => {
  const now = Date.now();
  const future = Math.floor((now + 3_600_000) / 1000);
  const cfg = makeCfg({ providers: {
    anthropic: { type: "anthropic", auth: "claude-code" },
    chatgpt: { type: "chatgpt" },
    gem: { type: "google", auth: "antigravity" },
    go: { type: "openai-compatible", url: "https://opencode.ai/zen/go/v1", preset: "opencode-go" },
    zen: { type: "openai-compatible", url: "https://opencode.ai/zen/v1" },
    deepseek: { type: "anthropic-compatible", url: "https://api.deepseek.com/anthropic" },
    quiet: { type: "chatgpt", limits: false },
  } });
  await withAdmin(cfg, async ({ port }) => {
    const res = await fetch(`${base()}:${port}/api/limits`);
    const body = (await res.json()) as { providers: { provider: string; type: string; title: string; accounts: { account: number; windows: { kind: string; label?: string; used_percent: number }[] }[] }[] };
    assert.deepEqual(body.providers.map((p) => p.provider), ["anthropic", "chatgpt", "gem", "go"]);
    assert.deepEqual(body.providers.map((p) => p.title), ["Claude", "GPT", "Gemini", "Go"]);
    assert.equal(body.providers[0]!.type, "anthropic");
    assert.deepEqual(body.providers[0]!.accounts[0]!.windows.map((w) => `${w.kind}${w.label ? ":" + w.label : ""}`), ["five_hour", "seven_day", "scoped:Fable"]);
    // The paused ChatGPT account takes no number; the ready one is account 0.
    assert.deepEqual(body.providers[1]!.accounts.map((a) => a.account), [0]);
    assert.equal(body.providers[2]!.type, "google");
    assert.equal(body.providers[3]!.type, "opencode-go");
  }, {
    claudeUsage: async () => ({ current: { type: "claude.usage", at: now, rate_limits: {
      primary: { used_percent: 1, window_minutes: 300 },
      secondary: { used_percent: 88, window_minutes: 10080, reset_at: future },
    }, scoped: [{ name: "Fable", used_percent: 2, window_minutes: 10080, reset_at: future }] } }),
    chatgpt: () => ({
      quota: {}, auth: {},
      accounts: () => ({
        chatgpt: [
          { id: "a", label: "A", paused: false, state: "ready", quota: { at: now, rate_limits: { primary: { used_percent: 23, window_minutes: 10080, reset_at: future }, secondary: null } }, active: true },
          { id: "b", label: "B", paused: true, state: "paused", quota: null, active: false },
        ] as never,
        quiet: [{ id: "c", label: "C", paused: false, state: "ready", quota: { at: now, rate_limits: { primary: { used_percent: 5, window_minutes: 10080 } } }, active: false }] as never,
      }),
    }),
    google: () => ({
      accounts: () => ({ gem: [{ id: "g1", label: "G", paused: false, state: "ready", projectId: "p", expiresAt: now + 3_600_000, needsReauth: false, active: true }] as never }),
      usage: async () => ({ g1: [{ displayName: "Gemini Models", buckets: [
        { bucketId: "gemini-weekly", displayName: "Weekly", window: "weekly", resetTime: new Date(future * 1000).toISOString(), remainingFraction: 0.98 },
        { bucketId: "gemini-5h", displayName: "5h", window: "5h", remainingFraction: 1 },
      ] }] }),
    }),
    opencodeUsage: async (name: string) => name === "go" ? [
      { kind: "five_hour", used_percent: 3, window_minutes: 300, reset_at: future },
      { kind: "seven_day", used_percent: 52, window_minutes: 10080, reset_at: future },
      { kind: "window", used_percent: 92, window_minutes: 43200, reset_at: future },
    ] : [],
  });
});
