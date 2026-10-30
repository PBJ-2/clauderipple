// The shared client settings are one file per account: two installations write the same
// settings.json, the same Codex config and the same plugin list. B02/B03 (2026-10-25): a value is
// removed only when this home recorded writing it and no other home records it, and a Codex block
// from an older version is ours only when its port is exactly this installation's ingress.
//
// Nothing here runs a CLI or a service and nothing reads the user's real settings.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { posixModes } from "../../../test/capabilities.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-shared-settings-"));
process.env.CLAUDE_SETTINGS_PATH = path.join(root, "unused", "settings.json");
process.env.CLAUDERIPPLE_HOME = path.join(root, "unused-home");
process.env.CLAUDE_APP_SUPPORT = path.join(root, "Claude-3p");
process.env.CLAUDERIPPLE_LAUNCHER_DIR = path.join(root, "Applications");
process.env.CODEX_HOME = path.join(root, "unused-codex");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const { applyProxyEnv, removeProxyEnv, setAgentTitleHook, setStatusMod, settingsPath, syncModelSlots } = await import("../src/settings.ts");
const { ownersPath, readOwners } = await import("../src/owners.ts");
const { removeClientIntegrations } = await import("../src/integrations.ts");
const { codexEnabled, codexHome, codexOff, codexOn, codexOwner, codexRemove, ingressPort } = await import("../src/codex.ts");
const { applyAppProxy, currentAppProxy, removeAppProxy } = await import("../src/picker.ts");
const { normalizeHome } = await import("../src/ownership.ts");
const { withFileLock } = await import("../../router/src/locked-file.ts");
const { claudeSettingsPath } = await import("../../router/src/mod-settings.ts");

let n = 0;
/** A fresh settings file and two installation homes under the temp root. */
function scratch(): { settings: string; A: string; B: string; agents: string } {
  const dir = path.join(root, `t${++n}`);
  const settings = path.join(dir, "settings.json");
  fs.mkdirSync(dir, { recursive: true });
  process.env.CLAUDE_SETTINGS_PATH = settings;
  return { settings, A: path.join(dir, "install-a"), B: path.join(dir, "install-b"), agents: path.join(dir, "agents") };
}

const envOf = (file: string): Record<string, string> => (JSON.parse(fs.readFileSync(file, "utf8")) as { env?: Record<string, string> }).env ?? {};
const proxy = (port: number) => ({ proxyUrl: `http://127.0.0.1:${port}`, caPath: path.join(root, "ca.pem"), force: true });
/** The home key the store uses: real path when it exists, absolute otherwise. */
const homeKey = (home: string): string => {
  try {
    return fs.realpathSync(home);
  } catch {
    return path.resolve(home);
  }
};

// ---- model slots ---------------------------------------------------------------------------

test("another installation's uninstall leaves the model slots it wrote", () => {
  const ctx = scratch();
  applyProxyEnv({ ...proxy(18791), models: { main: "deepseek-v4.1-flash" }, home: ctx.A });
  assert.equal(envOf(ctx.settings).ANTHROPIC_MODEL, "deepseek-v4.1-flash");

  removeProxyEnv({ ...proxy(18890), home: ctx.B });
  assert.equal(envOf(ctx.settings).ANTHROPIC_MODEL, "deepseek-v4.1-flash", "the first installation's slot is not the second's to take");
  // The store still records the first home, so its own uninstall can clean up later.
  assert.deepEqual(readOwners(ctx.settings).store.homes[homeKey(ctx.A)]?.slots, { main: "deepseek-v4.1-flash" });
});

test("the installation that wrote a slot takes it back; a hand-edited value stays", () => {
  const ctx = scratch();
  applyProxyEnv({ ...proxy(18791), models: { smallFast: "deepseek-v4.1-flash", subagent: "gpt-5.6-terra" }, home: ctx.A });
  const settings = JSON.parse(fs.readFileSync(ctx.settings, "utf8"));
  settings.env.CLAUDE_CODE_SUBAGENT_MODEL = "set-by-hand";
  fs.writeFileSync(ctx.settings, JSON.stringify(settings));

  removeProxyEnv({ ...proxy(18791), home: ctx.A });
  const env = envOf(ctx.settings);
  assert.equal("ANTHROPIC_SMALL_FAST_MODEL" in env, false, "recorded and unchanged: removed");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "set-by-hand", "changed since we wrote it: kept");
});

test("an install with no model slots clears only what this home recorded", () => {
  const ctx = scratch();
  applyProxyEnv({ ...proxy(18791), models: { main: "deepseek-v4.1-flash" }, home: ctx.A });
  // A second installation with no slots of its own: the first installation's value is not its to clear.
  applyProxyEnv({ ...proxy(18890), models: {}, home: ctx.B });
  assert.equal(envOf(ctx.settings).ANTHROPIC_MODEL, "deepseek-v4.1-flash");
  // An explicit clear from the GUI is honoured, but still never another installation's value.
  const cleared = syncModelSlots({ ...proxy(18890), models: { main: "" }, home: ctx.B });
  assert.equal(envOf(ctx.settings).ANTHROPIC_MODEL, "deepseek-v4.1-flash");
  assert.ok(cleared.notes.some((note) => /another installation records it/.test(note)), cleared.notes.join("\n"));
  // Its own value it may clear.
  applyProxyEnv({ ...proxy(18791), models: {}, home: ctx.A });
  assert.equal("ANTHROPIC_MODEL" in envOf(ctx.settings), false);
});

test("a value two installations record is never removed by either", () => {
  const ctx = scratch();
  applyProxyEnv({ ...proxy(18791), models: { main: "same-model" }, home: ctx.A });
  applyProxyEnv({ ...proxy(18890), models: { main: "same-model" }, home: ctx.B });
  removeProxyEnv({ ...proxy(18890), home: ctx.B });
  assert.equal(envOf(ctx.settings).ANTHROPIC_MODEL, "same-model");
  removeProxyEnv({ ...proxy(18791), home: ctx.A });
  assert.equal("ANTHROPIC_MODEL" in envOf(ctx.settings), false, "the last installation holding the value takes it");
});

test("a second installation claims an unchanged slot so the first owner's uninstall cannot clear it", () => {
  const ctx = scratch();
  applyProxyEnv({ ...proxy(18791), models: { main: "shared-model" }, home: ctx.A });
  const second = applyProxyEnv({ ...proxy(18890), models: { main: "shared-model" }, home: ctx.B });
  assert.deepEqual(second.wroteSlots, [], "the value did not change, but ownership must be recorded");
  assert.equal(readOwners(ctx.settings).store.homes[homeKey(ctx.B)]?.slots?.main, "shared-model");
  removeProxyEnv({ ...proxy(18791), home: ctx.A });
  assert.equal(envOf(ctx.settings).ANTHROPIC_MODEL, "shared-model");
  removeProxyEnv({ ...proxy(18890), home: ctx.B });
  assert.equal("ANTHROPIC_MODEL" in envOf(ctx.settings), false);
});

test("an unreadable ownership record blocks new shared settings, hooks and mod registrations", () => {
  const ctx = scratch();
  fs.writeFileSync(ctx.settings, JSON.stringify({ env: { KEEP: "original" } }));
  fs.writeFileSync(ownersPath(ctx.settings), "{broken");
  const original = fs.readFileSync(ctx.settings, "utf8");
  for (const work of [
    () => applyProxyEnv({ ...proxy(18791), models: { main: "unrecorded" }, home: ctx.A }),
    () => setStatusMod(true, path.join(ctx.A, "mod"), { home: ctx.A }),
    () => setAgentTitleHook(true, { node: "/n", script: "/hook.ts" }, { home: ctx.A }),
  ]) {
    const result = work();
    assert.equal(result.changed, false);
    assert.ok(result.notes.some(note => note.includes("ownership record")));
    assert.equal(fs.readFileSync(ctx.settings, "utf8"), original);
    assert.equal(fs.readFileSync(ownersPath(ctx.settings), "utf8"), "{broken");
  }
});

// ---- status mod and agent-title hook -------------------------------------------------------

function pluginDir(dir: string, name = "ripple"): string {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  return dir;
}

test("another installation's status mod and hook survive an uninstall", () => {
  const ctx = scratch();
  const aMod = pluginDir(path.join(ctx.A, "mod"));
  const bMod = pluginDir(path.join(ctx.B, "mod"));
  setStatusMod(true, aMod, { home: ctx.A });
  const cmd = { node: "/runtime/node", env: { ELECTRON_RUN_AS_NODE: "1" }, script: path.join(ctx.A, "hooks", "agent-title.ts") };
  setAgentTitleHook(true, cmd, { home: ctx.A });
  assert.ok(envOf(ctx.settings).CLAUDE_CODE_PLUGIN_DIRS?.includes(aMod));

  // The second installation's uninstall, through the real path.
  assert.equal(removeClientIntegrations(ctx.B, () => true, { modDir: bMod, agentDir: ctx.agents, defaultHome: ctx.A }), true);
  const after = JSON.parse(fs.readFileSync(ctx.settings, "utf8")) as { env?: Record<string, string>; hooks?: { PreToolUse?: { _clauderipple?: string }[] } };
  assert.equal(after.env?.CLAUDE_CODE_PLUGIN_DIRS, aMod, "the first installation's mod is still registered");
  assert.equal(after.hooks?.PreToolUse?.some((entry) => entry._clauderipple === "agent-title"), true, "and its hook too");

  // The first installation's own uninstall removes both.
  assert.equal(removeClientIntegrations(ctx.A, () => true, { modDir: aMod, agentDir: ctx.agents, defaultHome: ctx.A }), true);
  const gone = JSON.parse(fs.readFileSync(ctx.settings, "utf8")) as { env?: Record<string, string>; hooks?: { PreToolUse?: unknown[] } };
  assert.equal("CLAUDE_CODE_PLUGIN_DIRS" in (gone.env ?? {}), false);
  assert.equal((gone.hooks?.PreToolUse ?? []).some((entry) => (entry as { _clauderipple?: string })._clauderipple === "agent-title"), false);
});

test("a moved installation replaces its recorded mod, and a foreign one is left alone", () => {
  const ctx = scratch();
  const oldDir = pluginDir(path.join(ctx.A, "old-mod"));
  const newDir = pluginDir(path.join(ctx.A, "new-mod"));
  setStatusMod(true, oldDir, { home: ctx.A });
  setStatusMod(true, newDir, { home: ctx.A });
  assert.equal(envOf(ctx.settings).CLAUDE_CODE_PLUGIN_DIRS, newDir);
  // A folder matching only by manifest name, outside this home, is not evidence of ownership.
  const foreign = pluginDir(path.join(ctx.B, "mod"));
  fs.writeFileSync(ctx.settings, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: [newDir, foreign].join(path.delimiter) } }));
  setStatusMod(false, newDir, { home: ctx.A });
  assert.ok(envOf(ctx.settings).CLAUDE_CODE_PLUGIN_DIRS?.split(path.delimiter).includes(foreign));
});

test("a status mod entry with no record is legacy-owned only inside this home", () => {
  const ctx = scratch();
  const mod = pluginDir(path.join(ctx.A, "mod"));
  const other = pluginDir(path.join(ctx.A, "other-plugin"), "someone-else");
  fs.writeFileSync(ctx.settings, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: [other, mod].join(path.delimiter) } }));
  // The folder lies inside this installation's home and nobody recorded it: an older version's
  // entry, which this installation's own removal takes (D3).
  const off = setStatusMod(false, mod, { home: ctx.A });
  assert.equal(envOf(ctx.settings).CLAUDE_CODE_PLUGIN_DIRS, other);
  assert.equal(off.outcome, "removed");
  // The same folder outside this home is no evidence of ownership: preserved and reported.
  const outside = pluginDir(path.join(ctx.B, "mod"));
  fs.writeFileSync(ctx.settings, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: outside } }));
  const again = setStatusMod(false, mod, { home: ctx.A });
  assert.equal(envOf(ctx.settings).CLAUDE_CODE_PLUGIN_DIRS, outside);
  assert.equal(again.outcome, "preserved-unknown");
  assert.ok(again.notes.some((note) => /did not record/.test(note)), again.notes.join("\n"));
});

test("nested legacy installation mod and hook survive the parent uninstall", () => {
  const ctx = scratch();
  const nested = path.join(ctx.A, "release-check");
  const mod = pluginDir(path.join(nested, "mod"));
  fs.writeFileSync(path.join(nested, "config.json"), "{}");
  const hook = path.join(nested, "lib", "node_modules", "clauderipple", "dist", "cli", "src", "hooks", "agent-title.js");
  const entry = { _clauderipple: "agent-title", hooks: [{ type: "command", command: `"/node" "${hook}"` }] };
  fs.writeFileSync(ctx.settings, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: mod }, hooks: { PreToolUse: [entry] } }));
  const before = fs.readFileSync(ctx.settings, "utf8");
  assert.equal(setStatusMod(false, mod, { home: ctx.A }).outcome, "preserved-unknown");
  assert.equal(setAgentTitleHook(false, { node: "/node", script: hook }, { home: ctx.A }).outcome, "preserved-unknown");
  assert.equal(fs.readFileSync(ctx.settings, "utf8"), before);
});

test("known legacy mod paths that resolve into another home stay unknown", () => {
  const ctx = scratch();
  const nested = path.join(ctx.A, "mod");
  const mod = pluginDir(nested);
  fs.writeFileSync(path.join(nested, "config.json"), "{}");
  fs.writeFileSync(ctx.settings, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: mod } }));
  assert.equal(setStatusMod(false, mod, { home: ctx.A }).outcome, "preserved-unknown");
  assert.equal(envOf(ctx.settings).CLAUDE_CODE_PLUGIN_DIRS, mod);
});

test("an agent-title hook entry this installation did not record is preserved", () => {
  const ctx = scratch();
  fs.writeFileSync(ctx.settings, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: '"/n" "/old-agent-title.ts"' }], _clauderipple: "agent-title" }] },
  }));
  const off = setAgentTitleHook(false, { node: "/n", script: "/old-agent-title.ts" }, { home: ctx.A });
  assert.equal((JSON.parse(fs.readFileSync(ctx.settings, "utf8")) as { hooks?: { PreToolUse?: unknown[] } }).hooks?.PreToolUse?.length, 1);
  assert.ok(off.notes.some((note) => /did not record/.test(note)), off.notes.join("\n"));
});

test("settings and the ownership record are changed under one lock", () => {
  const ctx = scratch();
  const before = JSON.stringify({ env: { KEEP: "1" } });
  fs.writeFileSync(ctx.settings, before);
  // The canonical boundary is settings.json itself: the router's own settings writer
  // (mod-settings.writeAutoCompactWindow) locks the same file, so CLI and router exclude each other.
  assert.equal(claudeSettingsPath(), settingsPath());
  // Holding that lock blocks the whole read-modify-write, settings included: no half change.
  assert.throws(
    () => withFileLock(settingsPath(), () => applyProxyEnv({ ...proxy(18791), models: { main: "deepseek-v4.1-flash" }, home: ctx.A })),
    /another ClaudeRipple operation/,
  );
  assert.equal(fs.readFileSync(ctx.settings, "utf8"), before);
});

test("a store that cannot be written stops the change (fail closed)", { skip: !posixModes }, () => {
  const ctx = scratch();
  fs.writeFileSync(ctx.settings, JSON.stringify({ env: { KEEP: "1" } }));
  applyProxyEnv({ ...proxy(18791), models: { main: "deepseek-v4.1-flash" }, home: ctx.A });
  const before = fs.readFileSync(ctx.settings, "utf8");
  const dir = path.dirname(ownersPath(ctx.settings));
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => removeProxyEnv({ ...proxy(18791), home: ctx.A }));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  // The record could not be released, so the value it covers stays (an unrecorded deletion is
  // exactly what a later installation would have to guess at).
  assert.equal(fs.readFileSync(ctx.settings, "utf8"), before);
});

test("a malformed or unsupported ownership store is an error, never a silently empty one", () => {
  const other = "/tmp/other-installation";
  const malformed = [
    { version: 2, homes: {} },
    { version: 1, homes: [] },
    { version: 1, homes: { [other]: "not a record" } },
    { version: 1, homes: { [other]: { slots: [] } } },
    { version: 1, homes: { [other]: { slots: { main: 7 } } } },
    { version: 1, homes: { [other]: { mods: ["a", 1] } } },
    { version: 1, homes: { [other]: { hooks: "not a list" } } },
  ];
  for (const bad of malformed) {
    const ctx = scratch();
    fs.writeFileSync(ctx.settings, JSON.stringify({ env: { ANTHROPIC_MODEL: "hand-set" } }));
    const original = JSON.stringify(bad);
    fs.writeFileSync(ownersPath(ctx.settings), original);
    const read = readOwners(ctx.settings);
    assert.ok(read.error, `expected an error for ${original}`);
    assert.deepEqual(read.store, { version: 1, homes: {} }, "no partial recovery of valid-looking entries");
    const before = fs.readFileSync(ctx.settings, "utf8");
    const edit = removeProxyEnv({ ...proxy(18791), models: { main: "hand-set" }, home: ctx.A });
    assert.equal(envOf(ctx.settings).ANTHROPIC_MODEL, "hand-set", "an unverifiable claim never deletes");
    assert.equal(fs.readFileSync(ctx.settings, "utf8"), before);
    assert.equal(fs.readFileSync(ownersPath(ctx.settings), "utf8"), original, "the original store is untouched");
    assert.ok(edit.notes.some((note) => note.includes("ownership record")), edit.notes.join("\n"));
  }
});

test("crash states: a claim without its value, and a value without its claim", () => {
  // Record written, settings write never happened: the claim matches no value, so it is released
  // and nothing is deleted.
  const a = scratch();
  fs.writeFileSync(ownersPath(a.settings), JSON.stringify({ version: 1, homes: { [homeKey(a.A)]: { slots: { main: "never-written" } } } }));
  fs.writeFileSync(a.settings, JSON.stringify({ env: { KEEP: "1" } }));
  assert.equal(removeProxyEnv({ ...proxy(18791), home: a.A }).changed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(a.settings, "utf8")).env, { KEEP: "1" });
  assert.equal(fs.existsSync(ownersPath(a.settings)), false, "a released claim leaves no store behind");

  // Value written, record already released (a crash during removal): preserved, not guessed at.
  const b = scratch();
  fs.writeFileSync(b.settings, JSON.stringify({ env: { ANTHROPIC_MODEL: "orphan" } }));
  const edit = removeProxyEnv({ ...proxy(18791), models: { main: "orphan" }, home: b.A });
  assert.equal(envOf(b.settings).ANTHROPIC_MODEL, "orphan");
  assert.ok(edit.notes.some((note) => /no record/.test(note)), edit.notes.join("\n"));
});

// ---- the ownership store -------------------------------------------------------------------

test("the ownership store is schema 1, owner-only, per home, and has no temporary files", { skip: !posixModes }, () => {
  const ctx = scratch();
  applyProxyEnv({ ...proxy(18791), models: { main: "a-model" }, home: ctx.A });
  applyProxyEnv({ ...proxy(18890), models: { smallFast: "b-model" }, home: ctx.B });
  const file = ownersPath(ctx.settings);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const store = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown; homes?: Record<string, unknown> };
  assert.equal(store.version, 1);
  assert.deepEqual(Object.keys(store.homes ?? {}).sort(), [homeKey(ctx.A), homeKey(ctx.B)].sort());
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp-")), []);
});

test("a broken ownership store preserves values and says where it is", () => {
  const ctx = scratch();
  applyProxyEnv({ ...proxy(18791), models: { main: "deepseek-v4.1-flash" }, home: ctx.A });
  fs.writeFileSync(ownersPath(ctx.settings), "not json");
  const edit = removeProxyEnv({ ...proxy(18791), home: ctx.A });
  assert.equal(envOf(ctx.settings).ANTHROPIC_MODEL, "deepseek-v4.1-flash", "unverifiable ownership is not a reason to delete");
  assert.ok(edit.notes.some((note) => note.includes(ownersPath(ctx.settings))), edit.notes.join("\n"));
});

// ---- Codex ---------------------------------------------------------------------------------

test("Codex on, off and uninstall share the config lock and never mutate while another writer holds it", () => {
  const ctx = scratch();
  const home = path.join(ctx.A, "codex");
  codexOn(18892, home, [], ctx.A);
  const file = path.join(home, "config.toml");
  const before = fs.readFileSync(file, "utf8");
  for (const work of [() => codexOn(19000, home, [], ctx.A), () => codexOff(home, ctx.A), () => codexRemove(home, { installationHome: ctx.A })]) {
    assert.throws(() => withFileLock<unknown>(file, work), { code: "ELOCKED" });
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
});

test("Codex on and off refuse another installation's marked settings without changing any bytes", () => {
  const ctx = scratch();
  const home = path.join(ctx.A, "codex");
  codexOn(18892, home, [], ctx.A);
  const before = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.throws(() => codexOn(19000, home, [], ctx.B), /another ClaudeRipple installation/);
  assert.throws(() => codexOff(home, ctx.B), /another ClaudeRipple installation/);
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), before);
  assert.equal(codexOff(home, ctx.A).changed, true);
});

test("a Codex provider block records the installation that wrote it", () => {
  const ctx = scratch();
  process.env.CODEX_HOME = path.join(ctx.A, "codex");
  codexOn(18892, undefined, [], ctx.A);
  const text = fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8");
  assert.ok(text.includes(`# clauderipple-home: ${normalizeHome(ctx.A)}`), text);
  assert.equal(codexOwner(undefined, ctx.A).state, "ours");
  assert.equal(codexOwner(undefined, ctx.B).state, "other");
});

test("uninstall removes this installation's provider and leaves another's", () => {
  const ctx = scratch();
  process.env.CODEX_HOME = path.join(ctx.A, "codex");
  codexOn(18892, undefined, [], ctx.A);
  assert.equal(codexRemove(undefined, { installationHome: ctx.B }).result, "other-installation");
  assert.equal(codexEnabled(), true);
  assert.equal(codexRemove(undefined, { installationHome: ctx.A }).result, "removed");
  assert.equal(codexEnabled(), false);
});

test("a Codex block without an installation marker is never removed, whatever port it names", () => {
  const ctx = scratch();
  const codex = path.join(ctx.A, "codex");
  process.env.CODEX_HOME = codex;
  fs.mkdirSync(codex, { recursive: true });
  const legacy =
    `# >>> ClaudeRipple Codex provider >>>\n[model_providers.clauderipple]\nname = "ClaudeRipple local ingress"\n` +
    `base_url = "http://127.0.0.1:18892/v1"\nwire_api = "responses"\n# <<< ClaudeRipple Codex provider <<<\n`;
  fs.writeFileSync(path.join(codex, "config.toml"), legacy);
  // No home recorded: the port alone does not say which installation wrote it, so it is preserved.
  assert.equal(codexOwner(undefined, ctx.B).state, "unknown");
  assert.equal(codexRemove(undefined, { installationHome: ctx.B }).result, "ownership-unknown");
  assert.equal(codexEnabled(), true);
  // An explicit `codex on` from this installation is how a legacy block is taken over.
  codexOn(18892, undefined, [], ctx.B);
  assert.equal(codexOwner(undefined, ctx.B).state, "ours");
  assert.equal(codexRemove(undefined, { installationHome: ctx.B }).result, "removed");
});

test("Codex ownership uses the recorded home, not the proxy or ingress number", () => {
  assert.equal(ingressPort({ listen: { host: "127.0.0.1", port: 18791 } }), 18793);
  assert.equal(ingressPort({ listen: { host: "127.0.0.1", port: 18791, openaiPort: 19000 } }), 19000);

  const ctx = scratch();
  const config = path.join(ctx.B, "config.json");
  fs.mkdirSync(ctx.B, { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ listen: { host: "127.0.0.1", port: 18890, openaiPort: 19000 } }));
  process.env.CODEX_HOME = path.join(ctx.B, "codex");
  fs.mkdirSync(codexHome(), { recursive: true });

  // An unmarked legacy block at this installation's exact ingress is still preserved (no record).
  fs.writeFileSync(
    path.join(codexHome(), "config.toml"),
    `# >>> ClaudeRipple Codex provider >>>\n[model_providers.clauderipple]\nname = "ClaudeRipple local ingress"\nbase_url = "http://127.0.0.1:19000/v1"\nwire_api = "responses"\n# <<< ClaudeRipple Codex provider <<<\n`,
  );
  removeClientIntegrations(ctx.B, () => true, { agentDir: ctx.agents, defaultHome: ctx.A });
  assert.equal(codexEnabled(), true, "a matching port is not evidence of which installation wrote it");

  // A marked block of this installation is removed even when its port is none of this config's.
  codexOn(18892, undefined, [], ctx.B);
  removeClientIntegrations(ctx.B, () => true, { agentDir: ctx.agents, defaultHome: ctx.A });
  assert.equal(codexEnabled(), false, "the recorded home is the ownership, whatever the port says");
});

// ---- legacy forms from 0.12.14 -------------------------------------------------------------

test("a same-port legacy Desktop proxy is never adopted or deleted without installation evidence", () => {
  const ctx = scratch();
  process.env.CLAUDE_APP_SUPPORT = path.join(path.dirname(ctx.settings), "Claude-3p");
  const dir = path.join(process.env.CLAUDE_APP_SUPPORT, "configLibrary");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "legacy.json"), JSON.stringify({ egressProxyUrl: "http://127.0.0.1:18791" }, null, 2));
  // 0.12.14's _meta.json: our marker, no installationHome.
  fs.writeFileSync(path.join(dir, "_meta.json"), JSON.stringify({ appliedId: "legacy", clauderipple: { ourId: "legacy" } }, null, 2));
  // Another URL is not evidence of which installation applied it.
  assert.throws(() => applyAppProxy("http://127.0.0.1:19991", ctx.A), /unknown/);
  const raw = fs.readFileSync(path.join(dir, "_meta.json"), "utf8");
  assert.equal(removeAppProxy("http://127.0.0.1:18791", ctx.B), false);
  assert.throws(() => applyAppProxy("http://127.0.0.1:18791", ctx.B), /unknown|어느 설치에서 설정했는지 확인할 수 없어/);
  assert.equal(removeClientIntegrations(ctx.B, () => "absent", { agentDir: ctx.agents, defaultHome: ctx.A, port: 18791 }), false);
  assert.equal(fs.readFileSync(path.join(dir, "_meta.json"), "utf8"), raw);
  assert.equal(fs.existsSync(path.join(dir, "legacy.json")), true);
  // Even the matching installation needs an explicit home record, not merely a matching URL.
  assert.throws(() => applyAppProxy("http://127.0.0.1:18791", ctx.A), /unknown|어느 설치에서 설정했는지 확인할 수 없어/);
});

test("an unmarked Codex block goes on uninstall only with this home's service and ingress", () => {
  const ctx = scratch();
  process.env.CLAUDE_APP_SUPPORT = path.join(path.dirname(ctx.settings), "Claude-3p");
  const codex = path.join(ctx.A, "codex");
  process.env.CODEX_HOME = codex;
  fs.mkdirSync(codex, { recursive: true });
  const legacy = `# >>> ClaudeRipple Codex provider >>>\n[model_providers.clauderipple]\nname = "ClaudeRipple local ingress"\nbase_url = "http://127.0.0.1:18893/v1"\nwire_api = "responses"\n# <<< ClaudeRipple Codex provider <<<\n`;
  fs.writeFileSync(path.join(codex, "config.toml"), legacy);
  // No service evidence, then the wrong ingress: the port alone proves nothing.
  assert.equal(removeClientIntegrations(ctx.A, () => true, { agentDir: ctx.agents, defaultHome: ctx.A }), false);
  assert.equal(codexEnabled(), true);
  assert.equal(removeClientIntegrations(ctx.A, () => true, { agentDir: ctx.agents, defaultHome: ctx.A, legacyCodexIngressPort: 19000 }), false);
  assert.equal(codexEnabled(), true);
  // This home's definition was the one registered and the block names this ingress: taken.
  assert.equal(removeClientIntegrations(ctx.A, () => true, { agentDir: ctx.agents, defaultHome: ctx.A, legacyCodexIngressPort: 18893 }), true);
  assert.equal(codexEnabled(), false);
  // `codex off`, run here, applies the same rule.
  fs.writeFileSync(path.join(codex, "config.toml"), legacy);
  assert.throws(() => codexOff(undefined, ctx.A), /refusing/);
  assert.equal(codexOff(undefined, ctx.A, { legacyIngressPort: 18893 }).changed, true);
  assert.equal(codexEnabled(), false);
});

test("an installation whose CA is already gone can still finish its removal", () => {
  const ctx = scratch();
  process.env.CLAUDE_APP_SUPPORT = path.join(path.dirname(ctx.settings), "Claude-3p");
  // Nothing trusted to remove is not a failure: --purge must not be blocked by a CA that is absent.
  assert.equal(removeClientIntegrations(ctx.A, () => "absent", { agentDir: ctx.agents, defaultHome: ctx.A }), true);
});
