import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAuthPath, readClaudeAuthFile } from "../../router/src/providers/anthropic-token-file.ts";
import { claudeLogin, claudeLogout, parseSetupToken } from "../src/claude-auth.ts";

test("claude-login invokes PATH claude setup-token and saves only a 0600 credential file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-login-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  fs.mkdirSync(bin);
  const fake = path.join(bin, "claude");
  const token = "sk-ant-oat01-1234567890abcdefghijklmnopqrstuvwxyz";
  fs.writeFileSync(fake, `#!/bin/sh\n[ "$1" = "setup-token" ] || exit 64\nprintf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' '${token}'\n`);
  fs.chmodSync(fake, 0o755);
  const cli = path.resolve(import.meta.dirname, "..", "src", "index.ts");
  const output = execFileSync(process.execPath, [cli, "claude-login", "--setup-token"], {
    encoding: "utf8",
    env: { ...process.env, PATH: bin, CLAUDERIPPLE_HOME: home, CLAUDERIPPLE_ASSUME_TTY: "1" },
  });
  assert.match(output, /Claude subscription connected/);
  assert.doesNotMatch(output, new RegExp(token));
  assert.deepEqual(readClaudeAuthFile(home), { token, createdAt: readClaudeAuthFile(home)!.createdAt, source: "setup-token" });
  assert.equal(fs.statSync(claudeAuthPath(home)).mode & 0o777, 0o600);
  assert.equal(execFileSync(process.execPath, [cli, "claude-logout"], { encoding: "utf8", env: { ...process.env, PATH: bin, CLAUDERIPPLE_HOME: home } }), "✓ Claude subscription credential removed\n");
  assert.equal(fs.existsSync(claudeAuthPath(home)), false);
});

test("setup-token parser rejects prose and extracts only explicit long tokens", () => {
  assert.equal(parseSetupToken("Login complete"), null);
  assert.equal(parseSetupToken("CLAUDE_CODE_OAUTH_TOKEN=too-short"), null);
  assert.equal(parseSetupToken("Copy this token:\nexport CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789\nDo not share it."), "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789");
  assert.equal(parseSetupToken("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789 sk-ant-oat01-zyxwvutsrqponmlkjihgfedcba9876543210"), null);
  assert.equal(claudeLogout(fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-logout-"))), false);
  assert.throws(() => claudeLogin("/missing", { binary: "/missing/claude", interactive: true }), /setup-token failed/);
  // The tray app and the GUI have no terminal; the browser flow cannot run there, so say so up front.
  assert.throws(() => claudeLogin("/missing", { binary: "/missing/claude", interactive: false }), /needs a terminal/);
});
