// #80: both install scripts handed a setup that never brought the router up back to the user as
// success — "Open the dashboard…", exit 0 — so `clauderipple update` (and the tray's Update button)
// reported a version that never started, and the version stayed old until `repair` (#62).
//
// These are shell/PowerShell bodies, so the check is by inspection (the task allows it): the setup
// step's exit code is read, a non-zero one ends the script non-zero, and both say what to run next.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const scripts = path.resolve(import.meta.dirname, "../../../scripts");
const read = (name: string): string => fs.readFileSync(path.join(scripts, name), "utf8");

test("install writes a fresh starter config owner-only", { skip: process.platform === "win32" }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-starter-config-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const name of ["ca.pem", "ca.key", "leaf.pem", "leaf.key"]) fs.writeFileSync(path.join(home, name), "test");
  const settings = path.join(home, "settings.json");
  // A foreign proxy stops install before it can register or start a real supervisor.
  fs.writeFileSync(settings, JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:1" } }));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDERIPPLE_HOME: home, CLAUDE_SETTINGS_PATH: settings };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../src/index.ts"), "install"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /starter config written/);
  assert.match(result.stderr, /HTTPS_PROXY/);
  assert.equal(fs.statSync(path.join(home, "config.json")).mode & 0o777, 0o600);
});

test("the pinned-Node cmd wrapper switches to UTF-8 before non-ASCII paths, without a BOM", () => {
  const ps1 = read("install.ps1");
  const block = ps1.slice(ps1.indexOf("if ($node.StartsWith"), ps1.indexOf("# PowerShell picks"));
  assert.match(block, /chcp 65001 >nul`r`n/);
  assert.match(block, /WriteAllText\(\$cmd, \$wrapper, \(New-Object System.Text.UTF8Encoding\(\$false\)\)\)/);
  assert.doesNotMatch(block, /-Encoding ASCII/);
  assert.ok(block.indexOf("chcp 65001") < block.indexOf('`"$node`"'), "cmd changes code page on its own line before reading the path");
});

test("Windows npm build commands use a shell for npm.cmd", async () => {
  const module = await import(pathToFileURL(path.join(scripts, "build-npm.mjs")).href) as { npmBuildSteps: (platform: NodeJS.Platform, run: (file: string, args: string[], opts: { shell: boolean }) => void) => void };
  for (const platform of ["win32", "darwin"] as const) {
    const calls: string[][] = [];
    module.npmBuildSteps(platform, (file, args, opts) => {
      assert.equal(file, platform === "win32" ? "npm.cmd" : "npm");
      assert.equal(opts.shell, platform === "win32");
      calls.push(args);
    });
    assert.equal(calls.length, 2, "both TypeScript and tray builds use the same execution policy");
  }
});

test("install.ps1 inherits `install`'s failure and names the command that finishes the job", () => {
  const ps1 = read("install.ps1");
  const start = ps1.indexOf("& $cmd install");
  const end = ps1.indexOf("# Part of the default install on Windows");
  assert.ok(start >= 0 && end > start, "the setup step is followed by the menu-bar app section");
  const block = ps1.slice(start, end);
  assert.match(block, /^\$setupCode = \$LASTEXITCODE$/m, "the native exit code is read, not assumed");
  assert.match(block, /if \(\$setupCode -ne 0\) \{/);
  assert.match(block, /exit \$setupCode/, "a failed setup ends the script non-zero");
  assert.match(block, /clauderipple\.cmd install/, "the user is told how to finish the install");
  assert.match(block, /clauderipple\.cmd repair/, "and how to recover a router that will not start");
});

test("install.sh stops on a failed setup with a non-zero code and the next command", () => {
  const sh = read("install.sh");
  const start = sh.indexOf('if ! "$BIN/clauderipple" install; then');
  const end = sh.indexOf("# --- the menu-bar app");
  assert.ok(start >= 0 && end > start, "the setup step is followed by the menu-bar app section");
  const block = sh.slice(start, end);
  assert.match(block, /exit 1/);
  assert.match(block, /clauderipple install/);
  assert.match(block, /clauderipple repair/);
});

// G-D03: an interrupted install must not destroy what was already working. install.sh unpacks Node
// beside the runtime and swaps by rename, keeps the previous runtime until the new one is in place,
// and replaces the command wrapper by rename too. Checked by inspection, as the bodies are shell.
test("install.sh stages the runtime swap and replaces the command by rename", () => {
  const sh = read("install.sh");
  assert.match(sh, /^cleanup\(\) \{/m);
  assert.match(sh, /trap cleanup EXIT/);
  const extract = sh.slice(sh.indexOf("download_node()"), sh.indexOf('NODE="$(find_node'));
  assert.match(extract, /STAGING="\$RUNTIME\.new\.\$\$"/);
  assert.match(extract, /tar -xzf "\$tmp\/node\.tar\.gz" -C "\$STAGING"/);
  assert.doesNotMatch(extract, /rm -rf "\$RUNTIME"$/m, "the runtime is not deleted before a new one is unpacked");
  assert.match(extract, /BACKUP="\$RUNTIME\.old\.\$\$"/);
  assert.match(extract, /mv "\$RUNTIME" "\$BACKUP"/);
  assert.match(extract, /mv "\$STAGING" "\$RUNTIME"/);
  assert.match(sh, /mv "\$BACKUP" "\$RUNTIME"/, "a failed install puts the previous runtime back");
  const wrapperAt = sh.indexOf('WRAPPER="$BIN');
  const wrapper = sh.slice(wrapperAt, sh.indexOf(";;", wrapperAt));
  assert.match(wrapper, /WRAPPER="\$BIN\/\.clauderipple\.new\.\$\$"/);
  assert.match(wrapper, /mv -f "\$WRAPPER" "\$BIN\/clauderipple"/);
  assert.doesNotMatch(wrapper, /rm -f "\$BIN\/clauderipple"/, "the old command is replaced, never removed first");
});
