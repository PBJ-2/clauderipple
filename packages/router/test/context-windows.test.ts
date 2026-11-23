import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, type Config } from "../src/config.ts";
import { injectBootstrap } from "../src/bootstrap.ts";
import { contextWindowSnapshot, routedCompactWindows, syncContextWindows } from "../src/context-windows.ts";
import { readCompactSettings, syncCompactWindows } from "../../cli/src/compact-windows.ts";
import { claimsOf, readOwners } from "../../cli/src/owners.ts";
import { removeProxyEnv } from "../../cli/src/settings.ts";
import { readAutoCompactWindow, writeAutoCompactWindow } from "../src/mod-settings.ts";
import { startAdmin } from "../src/admin.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";

function fixture(t: { after(fn: () => void): void }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-compact-windows-"));
  const file = path.join(home, "settings.json");
  const previous = { CLAUDE_SETTINGS_PATH: process.env.CLAUDE_SETTINGS_PATH, CLAUDERIPPLE_HOME: process.env.CLAUDERIPPLE_HOME };
  process.env.CLAUDE_SETTINGS_PATH = file;
  process.env.CLAUDERIPPLE_HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const cfg: Config = { ...structuredClone(DEFAULTS), admin: { port: 0 },
    providers: { gpt: { type: "openai-compatible", url: "https://example.test", models: [{ id: "gpt-test", contextWindow: 475000 }] },
      native: { type: "anthropic", auth: "claude-code", models: [{ id: "claude-opus-5-5", contextWindow: 1000000 }] } },
    routes: { "claude-opus-4-7": { provider: "gpt", model: "gpt-test" } },
    cli: { autoCompactWindow: 258400, extraModels: [{ model: "gpt-test", name: "GPT" }, { model: "gpt-test@high", name: "GPT High" }] },
  };
  const save = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  const models = () => readCompactSettings(file).modelSettings as Record<string, { autoCompactWindow?: number; effort?: string }> | undefined;
  return { cfg, home, file, save, models };
}

test("global 600k writes 475k for bootstrap's routed ids, not native Claude; unchanged sync is a no-op", t => {
  const f = fixture(t);
  f.save({ autoCompactWindow: 600000, permissions: { allow: ["Read"] }, modelSettings: { "claude-opus-5-5": { effort: "high" } } });
  assert.equal(syncContextWindows(f.cfg, [], f.home), true);
  const boot = JSON.parse(injectBootstrap(Buffer.from("{}"), f.cfg, []).toString()) as { auto_compact_windows: Record<string, number> };
  assert.deepEqual(Object.keys(routedCompactWindows(f.cfg, [])).sort(), Object.keys(boot.auto_compact_windows).sort());
  for (const id of Object.keys(boot.auto_compact_windows)) assert.equal(f.models()?.[id]?.autoCompactWindow, 475000, id);
  assert.deepEqual(f.models()?.["claude-opus-5-5"], { effort: "high" });
  assert.deepEqual(readCompactSettings(f.file).permissions, { allow: ["Read"] });
  assert.equal(syncContextWindows(f.cfg, [], f.home), false);
  assert.equal(Object.keys(readOwners(f.file).store.homes).length, 1);
});

test("global changes use min and can rise again; user model overrides and sibling keys survive", t => {
  const f = fixture(t);
  f.save({ autoCompactWindow: 600000, modelSettings: { "gpt-test": { autoCompactWindow: 250000, effort: "high" }, "gpt-test@high": { effort: "low" } } });
  syncContextWindows(f.cfg, [], f.home);
  assert.equal(f.models()?.["gpt-test"]?.autoCompactWindow, 250000);
  writeAutoCompactWindow(300000);
  syncContextWindows(f.cfg, [], f.home);
  assert.equal(f.models()?.["claude-opus-4-7"]?.autoCompactWindow, 300000);
  assert.deepEqual(f.models()?.["gpt-test@high"], { effort: "low", autoCompactWindow: 300000 });
  writeAutoCompactWindow(600000);
  syncContextWindows(f.cfg, [], f.home);
  assert.equal(f.models()?.["claude-opus-4-7"]?.autoCompactWindow, 475000);
  assert.deepEqual(f.models()?.["gpt-test"], { autoCompactWindow: 250000, effort: "high" });
  // A hand edit of a previously managed value transfers control to the user.
  const settings = readCompactSettings(f.file);
  f.save({ ...settings, modelSettings: { ...f.models(), "claude-opus-4-7": { autoCompactWindow: 200000 } } });
  syncContextWindows(f.cfg, [], f.home);
  assert.equal(f.models()?.["claude-opus-4-7"]?.autoCompactWindow, 200000);
});

test("removing routes and uninstall remove only this home's unchanged managed fields", t => {
  const f = fixture(t);
  f.save({ autoCompactWindow: 600000, modelSettings: { "gpt-test": { effort: "high" }, user: { autoCompactWindow: 400000 } } });
  syncContextWindows(f.cfg, [], f.home);
  f.cfg.routes = {};
  syncContextWindows(f.cfg, [], f.home);
  assert.equal(f.models()?.["claude-opus-4-7"], undefined);
  removeProxyEnv({ proxyUrl: "http://127.0.0.1:9999", caPath: "/test/ca.pem", home: f.home });
  assert.deepEqual(f.models(), { "gpt-test": { effort: "high" }, user: { autoCompactWindow: 400000 } });
  assert.equal(claimsOf(readOwners(f.file).store, f.home)?.compactWindows, undefined);
});

test("generated windows are not a global user setting; invalid settings and ownership fail closed", t => {
  const f = fixture(t);
  f.save({});
  syncContextWindows(f.cfg, [], f.home);
  assert.equal(readAutoCompactWindow(), null);
  fs.writeFileSync(f.file, "{ broken");
  assert.throws(() => syncContextWindows(f.cfg, [], f.home));
  assert.equal(fs.readFileSync(f.file, "utf8"), "{ broken");
  f.save({});
  fs.writeFileSync(`${f.file}.clauderipple-owners.json`, "{ broken");
  assert.throws(() => syncContextWindows(f.cfg, [], f.home));
  assert.deepEqual(readCompactSettings(f.file), {});
});

test("other installations' managed settings are not updated or removed; CLI bounds are enforced", t => {
  const f = fixture(t);
  f.save({});
  syncCompactWindows(f.file, f.home, { large: 1000000 });
  assert.equal(syncCompactWindows(f.file, `${f.home}/other`, { large: 500000 }), false);
  assert.equal(f.models()?.large?.autoCompactWindow, 1000000);
  // Out of Claude Code's range: that model is skipped, and the others are still written.
  syncCompactWindows(f.file, f.home, { tiny: 99999, large: 1000000 });
  assert.equal(f.models()?.tiny, undefined);
  assert.equal(f.models()?.large?.autoCompactWindow, 1000000);
  f.cfg.cli.extraModels[0]!.contextWindow = 1048576;
  assert.equal(routedCompactWindows(f.cfg, [])["gpt-test"], 1000000);
});

test("empty user modelSettings stays untouched and agent-file effort ids share bootstrap's managed key set", t => {
  const f = fixture(t);
  f.save({ modelSettings: {} });
  assert.equal(syncCompactWindows(f.file, f.home, {}), false);
  assert.deepEqual(readCompactSettings(f.file), { modelSettings: {} });
  fs.writeFileSync(path.join(f.home, "worker.md"), "---\nname: test-worker\nmodel: gpt-test@max\n---\n");
  syncContextWindows(f.cfg, [f.home], f.home);
  assert.equal(f.models()?.["gpt-test@max"]?.autoCompactWindow, 475000);
  const boot = JSON.parse(injectBootstrap(Buffer.from("{}"), f.cfg, [f.home]).toString()) as { auto_compact_windows: Record<string, number> };
  assert.deepEqual(Object.keys(claimsOf(readOwners(f.file).store, f.home)!.compactWindows!).sort(), Object.keys(boot.auto_compact_windows).sort());
});

test("offline native catalogue falls back to the stored Anthropic window", t => {
  const f = fixture(t);
  f.cfg.providers.native!.models = [{ id: "claude-opus-5-5", contextWindow: 500000 }];
  const snapshot = contextWindowSnapshot(f.cfg, [{ id: "claude-opus-5-5" }], []);
  assert.equal(snapshot.windows["claude-opus-5-5"], 500000);
  assert.equal(snapshot.resolvedWindows["claude-opus-5-5"]?.contextWindow, 500000);
});

test("live native catalogue window wins over the stored Anthropic window", t => {
  const f = fixture(t);
  f.cfg.providers.native!.models = [{ id: "claude-opus-5-5", contextWindow: 500000 }];
  const snapshot = contextWindowSnapshot(f.cfg, [{ id: "claude-opus-5-5", contextWindow: 1000000 }], []);
  assert.equal(snapshot.windows["claude-opus-5-5"], 1000000);
  assert.equal(snapshot.resolvedWindows["claude-opus-5-5"]?.contextWindow, 1000000);
});

test("context API exposes per-model effective windows including native Claude without modifying settings", async t => {
  const f = fixture(t);
  f.save({ autoCompactWindow: 600000, modelSettings: { "gpt-test@high": { autoCompactWindow: 200000 } } });
  const initial = fs.readFileSync(f.file, "utf8");
  const log = new Logger(null, 1e9, 0, false);
  const admin = await startAdmin({ config: () => f.cfg, configFile: path.join(f.home, "config.json"), agentDir: f.home, log,
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }), health: () => 0, version: "test",
    requests: new RequestLog(path.join(f.home, "requests.jsonl")),
    claudeModels: async () => [{ id: "claude-opus-5-5", name: "Opus", line: "opus", contextWindow: 1000000 }],
  });
  t.after(() => admin.close());
  const response = await fetch(`http://127.0.0.1:${admin.port}/api/context-windows`);
  assert.equal(response.status, 200);
  const body = await response.json() as ReturnType<typeof contextWindowSnapshot>;
  assert.equal(body.resolvedWindows["claude-opus-5-5"]?.contextWindow, 1000000);
  assert.equal(body.resolvedWindows["claude-opus-5-5"]?.compactWindow, 600000);
  assert.equal(body.resolvedWindows["claude-opus-4-7"]?.compactWindow, 475000);
  assert.equal(body.resolvedWindows["gpt-test@high"]?.compactWindow, 200000);
  assert.equal(fs.readFileSync(f.file, "utf8"), initial);
});
