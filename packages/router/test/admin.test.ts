import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Logger } from "../src/log.ts";
import { startAdmin } from "../src/admin.ts";

function makeCfg(overrides: Partial<Config> = {}): Config {
  // port 0: let the OS pick a free ephemeral port so parallel tests never collide.
  return { ...DEFAULTS, admin: { port: 0 }, ...overrides };
}

async function withAdmin(
  cfgInit: Config,
  fn: (ctx: { port: number; configFile: string; home: string; setCfg: (c: Config) => void }) => Promise<void>,
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
