import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setStatusMod, statusModEnabled, STATUS_MOD_NAME } from "../src/settings.ts";

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
