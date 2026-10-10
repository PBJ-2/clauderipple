import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setStatusMod, statusModEnabled, STATUS_MOD_NAME } from "../src/settings.ts";
import { agentModel, fixSpawn } from "../../mod/hooks/worker.ts";

test("a worker spawn keeps its own model and takes its marker's level from anywhere in the prompt", () => {
  const file = "deepseek-v4.1-flash@high";
  const spawn = (prompt: string, model?: string) => fixSpawn({ subagentType: "deepseek-v4-1-flash", prompt, ...(model ? { model } : {}) }, file);

  assert.equal(spawn("Do the thing."), null, "nothing to fix");
  assert.deepEqual(spawn("Do the thing.", "sonnet"), { prompt: "Do the thing.", model: file, dropped: "sonnet" });
  assert.equal(spawn("Do the thing.", "deepseek-v4.1-flash@low"), null, "its own id with another level is not a stray model");

  assert.deepEqual(spawn("[[ripple: deepseek-v4-1-flash@low]]\nDo the thing."), { prompt: "Do the thing.", model: "deepseek-v4.1-flash@low" }, "at the top");
  assert.deepEqual(spawn("Context first.\n[[ripple: deepseek-v4.1-flash@max]] Do the thing."), { prompt: "Context first.\n Do the thing.", model: "deepseek-v4.1-flash@max" }, "below the top, named by model id");
  assert.deepEqual(spawn("[[ripple: deepseek-v4-1-flash]]\nGo.", "opus"), { prompt: "Go.", model: file, dropped: "opus" }, "no level keeps the file's");

  assert.equal(spawn("[[ripple: astra@high]]\nGo."), null, "another alias already at the top is the router's");
  assert.deepEqual(spawn("Go.\n[[ripple: astra@high]]"), { prompt: "[[ripple: astra@high]]\nGo.\n", model: file }, "another alias below the top is moved up");
});

test("an agent file's model is read from its frontmatter only", () => {
  assert.equal(agentModel("---\nname: x\nmodel: gpt-6-astra@high\ntools: Read\n---\nmodel: not-this\n"), "gpt-6-astra@high");
  assert.equal(agentModel("no frontmatter\nmodel: x\n"), undefined);
});

/** A plugin folder carrying `name` in its manifest. */
function pluginDir(root: string, folder: string, name: string): string {
  const dir = path.join(root, folder);
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  return dir;
}

function withSettings(initial: Record<string, unknown>, body: (file: string, root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-status-mod-"));
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, JSON.stringify(initial));
  process.env.CLAUDE_SETTINGS_PATH = file;
  try {
    body(file, root);
  } finally {
    delete process.env.CLAUDE_SETTINGS_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const envOf = (file: string) => (JSON.parse(fs.readFileSync(file, "utf8")) as { env?: Record<string, string> }).env ?? {};

test("turning the mod on adds its folder beside another plugin's, and off removes only it", () => {
  withSettings({ env: { HTTPS_PROXY: "http://127.0.0.1:8791" } }, (file, root) => {
    const other = pluginDir(root, "other", "someone-else");
    const mod = pluginDir(root, "mod", STATUS_MOD_NAME);
    fs.writeFileSync(file, JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:8791", CLAUDE_CODE_PLUGIN_DIRS: other } }));

    assert.equal(statusModEnabled(), false);
    assert.equal(setStatusMod(true, mod).changed, true);
    assert.equal(envOf(file).CLAUDE_CODE_PLUGIN_DIRS, [other, mod].join(path.delimiter));
    assert.equal(envOf(file).HTTPS_PROXY, "http://127.0.0.1:8791", "other env keys are left alone");
    assert.equal(statusModEnabled(), true);
    assert.equal(setStatusMod(true, mod).changed, false, "already on");

    setStatusMod(false, mod);
    assert.equal(envOf(file).CLAUDE_CODE_PLUGIN_DIRS, other);
    assert.equal(statusModEnabled(), false);
  });
});

test("an install that moved replaces its old entry, and the variable goes with our last entry", () => {
  withSettings({}, (file, root) => {
    const old = pluginDir(root, "checkout-mod", STATUS_MOD_NAME);
    const now = pluginDir(root, "app-mod", STATUS_MOD_NAME);
    setStatusMod(true, old);
    setStatusMod(true, now);
    assert.equal(envOf(file).CLAUDE_CODE_PLUGIN_DIRS, now);
    setStatusMod(false, now);
    assert.equal("CLAUDE_CODE_PLUGIN_DIRS" in envOf(file), false);
  });
});

test("an entry under the mod's old name is replaced by the renamed mod", () => {
  withSettings({}, (file, root) => {
    const old = pluginDir(root, "old-mod", "clauderipple-status");
    const now = pluginDir(root, "mod", STATUS_MOD_NAME);
    setStatusMod(true, old);
    assert.equal(statusModEnabled(), true);
    setStatusMod(true, now);
    assert.equal(envOf(file).CLAUDE_CODE_PLUGIN_DIRS, now);
  });
});
