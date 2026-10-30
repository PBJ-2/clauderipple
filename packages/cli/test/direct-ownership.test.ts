import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { directOn, directOff, directStatePath } from "../src/direct.ts";
import { applyProxyEnv, removeProxyEnv, settingsEnv } from "../src/settings.ts";
import { applyAppProxy, currentAppProxy, removeAppProxy } from "../src/picker.ts";
import { removeClientIntegrations } from "../src/integrations.ts";
import * as launchd from "../src/launchd.ts";
import * as systemd from "../src/systemd.ts";
import * as schtasks from "../src/schtasks.ts";
import { stopWindowsRouter, restartWindowsRouter, type WindowsRouterOps } from "../src/supervisor.ts";
import { normalizeHome } from "../src/ownership.ts";

// Native real path resolves macOS's /var link and Windows' 8.3 TEMP alias.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cr-direct-ownership-")));
const keys = ["HOME", "CLAUDE_SETTINGS_PATH", "CLAUDE_APP_SUPPORT", "CLAUDERIPPLE_LAUNCH_AGENTS_DIR", "XDG_CONFIG_HOME", "CODEX_HOME"] as const;
const previous = keys.map(key => [key, process.env[key]] as const);
after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
let serial = 0;
function setup() {
  const dir = path.join(root, String(++serial));
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  for (const home of [a, b]) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 18791 }, cli: { models: { smallFast: "routed-model" } } }));
  }
  process.env.HOME = dir;
  process.env.CLAUDE_SETTINGS_PATH = path.join(dir, "settings.json");
  process.env.CLAUDE_APP_SUPPORT = path.join(dir, "desktop");
  process.env.CLAUDERIPPLE_LAUNCH_AGENTS_DIR = path.join(dir, "launch-agents");
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
  process.env.CODEX_HOME = path.join(dir, "codex");
  const proxyUrl = "http://127.0.0.1:18791";
  const apply = (home: string) => applyProxyEnv({ home, proxyUrl, caPath: path.join(home, "ca.pem"), force: false, models: { smallFast: "routed-model" } });
  return { a, b, apply, proxyUrl, settings: process.env.CLAUDE_SETTINGS_PATH };
}
const deps = (home: string, routerStatus = async () => ({ version: "test" })) => ({ home, version: "test", routerStatus, supervisor: {
  inspect(): never { throw new Error("unexpected supervisor inspection"); },
  register(): never { throw new Error("unexpected registration"); },
  start(): never { throw new Error("unexpected service start"); },
} });

test("direct preserves hand-written and another home's same-port settings and Desktop entry", () => {
  const c = setup();
  c.apply(c.a);
  applyAppProxy(c.proxyUrl, c.a);
  const before = fs.readFileSync(c.settings, "utf8");
  const desktop = currentAppProxy();
  assert.equal(removeProxyEnv({ home: c.b, proxyUrl: c.proxyUrl, caPath: path.join(c.b, "ca.pem") }).changed, false);
  assert.equal(fs.readFileSync(c.settings, "utf8"), before);
  directOn(c.b);
  assert.equal(fs.readFileSync(c.settings, "utf8"), before);
  assert.deepEqual(currentAppProxy(), desktop);
  assert.equal(fs.existsSync(directStatePath(c.b)), false);
  assert.equal(removeAppProxy(c.proxyUrl, c.b), false);
  fs.writeFileSync(c.settings, JSON.stringify({ env: { ANTHROPIC_MODEL: "hand-written-gpt" } }));
  directOn(c.a);
  assert.equal(settingsEnv().ANTHROPIC_MODEL, "hand-written-gpt");
});

test("direct double on/off restores owned values and protects shared claims", async () => {
  const c = setup();
  c.apply(c.a);
  applyAppProxy(c.proxyUrl, c.a);
  directOn(c.a);
  const snapshot = fs.readFileSync(directStatePath(c.a), "utf8");
  directOn(c.a);
  assert.equal(fs.readFileSync(directStatePath(c.a), "utf8"), snapshot);
  await directOff(deps(c.a));
  assert.equal(settingsEnv().ANTHROPIC_SMALL_FAST_MODEL, "routed-model");
  assert.equal(currentAppProxy().installationHome, normalizeHome(c.a));
  await directOff(deps(c.a));
  c.apply(c.b);
  directOn(c.a);
  assert.equal(settingsEnv().ANTHROPIC_SMALL_FAST_MODEL, "routed-model");
});

test("direct refuses shared routed slots and preserves the existing connection", () => {
  const c = setup();
  c.apply(c.a);
  c.apply(c.b);
  applyAppProxy(c.proxyUrl, c.a);
  const before = fs.readFileSync(c.settings, "utf8");
  const desktop = currentAppProxy();
  const result = directOn(c.a);
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(c.settings, "utf8"), before);
  assert.deepEqual(currentAppProxy(), desktop);
  assert.equal(fs.existsSync(directStatePath(c.a)), false);
});

for (const model of ["opus", "sonnet", "haiku", "sonnet[1m]", "opus[1m]", "claude-sonnet-4-6[1m]"]) {
  test(`direct accepts native Claude slot ${model} and preserves it`, () => {
    const c = setup();
    c.apply(c.a);
    const settings = JSON.parse(fs.readFileSync(c.settings, "utf8"));
    settings.env.ANTHROPIC_MODEL = model;
    fs.writeFileSync(c.settings, JSON.stringify(settings));
    const result = directOn(c.a);
    assert.equal(result.ok, true);
    assert.equal(result.mode, "direct");
    assert.equal(settingsEnv().ANTHROPIC_MODEL, model);
    assert.equal(settingsEnv().HTTPS_PROXY, undefined);
  });
}

test("direct rejects corrupt snapshots without modifying their raw text or clients", async () => {
  const c = setup();
  c.apply(c.a);
  const before = fs.readFileSync(c.settings, "utf8");
  const raw = '{"cli": {broken\n';
  fs.writeFileSync(directStatePath(c.a), raw);
  assert.throws(() => directOn(c.a));
  await assert.rejects(directOff(deps(c.a)));
  assert.equal(fs.readFileSync(directStatePath(c.a), "utf8"), raw);
  assert.equal(fs.readFileSync(c.settings, "utf8"), before);
});

test("snapshot save failure changes no client and settings save failure retains restoration evidence", () => {
  const c = setup();
  c.apply(c.a);
  const before = fs.readFileSync(c.settings, "utf8");
  fs.mkdirSync(directStatePath(c.a));
  assert.throws(() => directOn(c.a));
  assert.equal(fs.readFileSync(c.settings, "utf8"), before);
  fs.rmdirSync(directStatePath(c.a));
  // Backup creation fails after the write-ahead snapshot, before settings replacement. The backup is
  // named by the second, so this second's name and the next two are taken: one name alone missed
  // when the second turned over before directOn made its backup (Windows CI, 2026-10-29).
  const stampAt = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const now = Date.now();
  for (const ms of [now, now + 1_000, now + 2_000]) fs.mkdirSync(`${c.settings}.bak-clauderipple-${stampAt(ms)}`);
  assert.throws(() => directOn(c.a));
  assert.equal(fs.readFileSync(c.settings, "utf8"), before);
  assert.equal(JSON.parse(fs.readFileSync(directStatePath(c.a), "utf8")).cli.HTTPS_PROXY, c.proxyUrl);
});

test("direct off rechecks delayed health responses and never overwrites explicit slot edits", async () => {
  const c = setup();
  c.apply(c.a);
  directOn(c.a);
  await assert.rejects(directOff(deps(c.a, async () => {
    fs.writeFileSync(c.settings, JSON.stringify({ env: { ANTHROPIC_SMALL_FAST_MODEL: "user-edited" } }));
    return { version: "test" };
  })), /changed/);
  assert.equal(settingsEnv().ANTHROPIC_SMALL_FAST_MODEL, "user-edited");
  assert.equal(fs.existsSync(directStatePath(c.a)), true);
  await assert.rejects(directOff(deps(c.a), { force: true }), /changed/);
});

test("integration removal reports unconfirmed CA removal and removes only this home's workers", () => {
  const c = setup();
  const agents = path.join(c.a, "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "shared.md"), "---\n# Generated by ClaudeRipple from config.json — edits are overwritten; to customise, copy to another name.\nname: shared\ndescription: x\nmodel: x\n---\n");
  fs.writeFileSync(path.join(c.a, "generated-agents.json"), '{"agents":["shared"]}\n');
  let sweep: boolean | undefined;
  const ok = removeClientIntegrations(c.a, (_ca, opts) => { sweep = opts.sweep; return false; }, { agentDir: agents, defaultHome: c.a });
  assert.equal(ok, false, "an unconfirmed CA removal makes the uninstall incomplete");
  assert.equal(sweep, false);
  // This home's manifest names the worker and no other home records it, so its uninstall takes it.
  assert.equal(fs.existsSync(path.join(agents, "shared.md")), false);
  assert.equal(fs.existsSync(path.join(c.a, "generated-agents.json")), false);
});

test("launchd stop then remove accepts confirmed absence but preserves on bootout failure", () => {
  const c = setup();
  const file = launchd.plistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const definition = launchd.renderPlist({ home: c.a, program: "/node", stdoutLog: "/unused" });
  fs.writeFileSync(file, definition);
  let loaded = true;
  const run: launchd.Launchctl = args => {
    if (args[0] === "print") return loaded ? { ok: true, out: "state = waiting" } : { ok: false, out: "", code: 113 };
    if (!loaded) return { ok: false, out: "", code: 113 };
    loaded = false;
    return { ok: true, out: "" };
  };
  assert.equal(launchd.stopAgent(c.a, run), "stopped");
  assert.equal(launchd.removeAgent(c.a, run), "removed");
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, definition);
  const denied: launchd.Launchctl = args => args[0] === "print" ? { ok: true, out: "state = waiting" } : { ok: false, out: "permission denied" };
  assert.throws(() => launchd.removeAgent(c.a, denied), /definition preserved/);
  assert.equal(launchd.stopAgent(c.a, denied), "failed");
  assert.equal(fs.readFileSync(file, "utf8"), definition);
});

test("service PID lookup errors cause zero control calls and preserve definitions", () => {
  const c = setup();
  fs.mkdirSync(path.dirname(launchd.plistPath()), { recursive: true });
  const plist = launchd.renderPlist({ home: c.a, program: "/shared/node", stdoutLog: "/unused" });
  fs.writeFileSync(launchd.plistPath(), plist);
  const lc: string[][] = [];
  const runLaunchd = (args: string[]) => { lc.push(args); return { ok: false, out: "permission denied" }; };
  assert.throws(() => launchd.removeAgent(c.a, runLaunchd), /lookup failed/);
  assert.throws(() => launchd.stopAgent(c.a, runLaunchd), /lookup failed/);
  assert.throws(() => launchd.restartAgent(c.a, {}, runLaunchd), /lookup failed/);
  assert.throws(() => launchd.installAgent({ home: c.a, program: "/other/node" }, runLaunchd), /lookup failed/);
  assert.ok(lc.every(args => args[0] === "print"));
  assert.equal(fs.readFileSync(launchd.plistPath(), "utf8"), plist);
  fs.mkdirSync(path.dirname(systemd.unitPath()), { recursive: true });
  const unit = systemd.renderUnit({ home: c.a, program: "/shared/node" });
  fs.writeFileSync(systemd.unitPath(), unit);
  const sc: string[][] = [];
  const runSystemd = (args: string[]) => { sc.push(args); return { ok: false, out: "bus unavailable" }; };
  assert.throws(() => systemd.removeAgent(c.a, runSystemd), /lookup failed/);
  assert.throws(() => systemd.stopAgent(c.a, {}, runSystemd), /lookup failed/);
  assert.throws(() => systemd.restartAgent(c.a, {}, runSystemd), /lookup failed/);
  assert.ok(sc.every(args => args[0] === "show"));
  assert.equal(fs.readFileSync(systemd.unitPath(), "utf8"), unit);
});

test("definition replacement during service drain is never deleted", () => {
  const c = setup();
  fs.mkdirSync(path.dirname(systemd.unitPath()), { recursive: true });
  fs.writeFileSync(systemd.unitPath(), systemd.renderUnit({ home: c.a, program: "/shared/node" }));
  const foreign = systemd.renderUnit({ home: c.b, program: "/shared/node" });
  const run = (args: string[]) => {
    if (args[0] === "disable") fs.writeFileSync(systemd.unitPath(), foreign);
    return { ok: true, out: "0" };
  };
  assert.throws(() => systemd.removeAgent(c.a, run), /변경/);
  assert.equal(fs.readFileSync(systemd.unitPath(), "utf8"), foreign);
});

test("Windows drain never stops or starts over a replacement PID", () => {
  for (const restart of [false, true]) {
    let draining = false;
    let controls = 0;
    const ops: WindowsRouterOps = {
      owner: () => ({ state: "ours", home: root }),
      targetPid: () => draining ? 22 : 11,
      identity: pid => pid === 11 && !draining ? "ours" : "other",
      running: () => true,
      shutdown: () => { draining = true; return true; },
      stopTask: () => { controls++; return "stopped"; },
      start: () => { controls++; return "started"; },
      now: () => 0,
      sleep: () => { throw new Error("unexpected wait"); },
    };
    assert.equal(restart ? restartWindowsRouter(ops) : stopWindowsRouter(ops), "other-installation");
    assert.equal(controls, 0);
  }
});

test("scheduled task legacy wrapper and start propagate read errors without starting", () => {
  const calls: string[] = [];
  const taskDeps = { run: (script: string) => { calls.push(script); return { ok: false, out: "access denied" }; } };
  assert.throws(() => schtasks.existingTaskDefinition("isolated", taskDeps), /lookup failed/);
  assert.throws(() => schtasks.startAgent("isolated", { home: root, deps: taskDeps }), /lookup failed/);
  assert.equal(calls.length, 2);
});
