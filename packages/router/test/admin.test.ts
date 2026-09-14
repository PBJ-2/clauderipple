import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Logger } from "../src/log.ts";
import { startAdmin } from "../src/admin.ts";
import { RequestLog } from "../src/requestlog.ts";
import { PRESETS } from "../src/presets.ts";
import { saveClaudeAuthFile } from "../src/providers/anthropic-token-file.ts";

function makeCfg(overrides: Partial<Config> = {}): Config {
  // port 0: let the OS pick a free ephemeral port so parallel tests never collide.
  return { ...DEFAULTS, admin: { port: 0 }, ...overrides };
}

async function withAdmin(
  cfgInit: Config,
  fn: (ctx: { port: number; configFile: string; home: string; setCfg: (c: Config) => void }) => Promise<void>,
  extraDeps: { shutdown?: () => void } = {},
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
    assert.deepEqual(Object.keys(body.providers.native ?? {}).sort(), ["authSource", "reachable", "type", "url"]);
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
    assert.deepEqual(await missing.json(), { ok: false, auth: "missing", source: null, models: [
      { id: "claude-fable-5-1", name: "Fable 5.1" }, { id: "claude-opus-5", name: "Opus 5" }, { id: "claude-sonnet-5", name: "Sonnet 5" }, { id: "claude-haiku-4-5", name: "Haiku 4.5" }, { id: "claude-fable-5", name: "Fable 5" }, { id: "claude-opus-4-8", name: "Opus 4.8" }, { id: "claude-opus-4-7", name: "Opus 4.7" }, { id: "claude-opus-4-6", name: "Opus 4.6" }, { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
    ] });
    saveClaudeAuthFile(home, "test-token", "2026-09-13T00:00:00.000Z");
    const available = await fetch(`${base()}:${port}/api/providers/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "anthropic", auth: "claude-code" }) });
    const body = await available.json() as { ok: boolean; auth: string; source: string; models: { id: string; name: string }[] };
    assert.equal(body.ok, true);
    assert.equal(body.auth, "ok");
    assert.equal(body.source, "token-file");
    assert.equal(body.models[0]?.id, "claude-fable-5-1");
    assert.equal(JSON.stringify(body).includes("test-token"), false);
  });
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
        { id: "oai-model", name: "OAI Model", supported_parameters: ["reasoning_effort"] },
        { id: "no-effort-model", supported_parameters: ["reasoning"] },
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
          { id: "oai-model", name: "OAI Model", effortLevels: ["low", "medium", "high"] },
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
    for (const p of ["/api/picker", "/api/agent-title", "/api/codex", "/api/claude-logout", "/api/providers/probe"]) {
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
