import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAuthPath, readClaudeAuthFile } from "../../router/src/providers/anthropic-token-file.ts";
import { claudeAccountsPath, saveClaudeOAuthAccount } from "../../router/src/providers/anthropic-accounts.ts";
import { claudeLogin, claudeLogout, desktopClaudeCodeDirs, latestDesktopClaude, parseSetupToken } from "../src/claude-auth.ts";

const desktopBinary = process.platform === "linux"
  ? "claude"
  : process.platform === "win32"
    ? "claude.exe"
    : path.join("claude.app", "Contents", "MacOS", "claude");

/**
 * Runs `fn` with every platform's Desktop cache root (XDG_CONFIG_HOME, LOCALAPPDATA, APPDATA, HOME)
 * in a scratch dir, handing it the first claude-code directory and a way to place a launcher, then
 * puts everything back.
 */
function withDesktopCache(fn: (dir: string, place: (...parts: string[]) => string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-cache-"));
  const keys = ["XDG_CONFIG_HOME", "LOCALAPPDATA", "APPDATA", "HOME"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = root;
  try {
    const [dir] = desktopClaudeCodeDirs();
    const place = (...parts: string[]): string => {
      const binary = path.join(dir!, ...parts, desktopBinary);
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, "", { mode: 0o755 });
      return binary;
    };
    fn(dir!, place);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("finds the newest Desktop-cached CLI inside a hashed directory", () =>
  withDesktopCache((dir, place) => {
    place("2.1.284", "3f4bed3e44ad");
    const latest = place("2.1.286", "635c1867224a");
    // A version directory with no launcher yet is one the app is still downloading.
    fs.mkdirSync(path.join(dir, "2.1.290"), { recursive: true });
    assert.equal(latestDesktopClaude(), latest);
  }));

test("prefers a flat Desktop-cached CLI over a hashed one in the same version", () =>
  withDesktopCache((_dir, place) => {
    const flat = place("2.1.300");
    place("2.1.300", "abcdef123456");
    assert.equal(latestDesktopClaude(), flat);
  }));

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
  // The Desktop cache roots point into the scratch dir too. Where the fake is not a launcher (an
  // extensionless file on Windows), the lookup falls back to the Desktop-cached CLI, and a real one
  // would run its interactive `setup-token` and wait for a pasted code that never comes.
  const output = execFileSync(process.execPath, [cli, "claude-login", "--setup-token"], {
    encoding: "utf8",
    env: { ...process.env, PATH: bin, CLAUDERIPPLE_HOME: home, CLAUDERIPPLE_ASSUME_TTY: "1", APPDATA: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: root },
  });
  assert.match(output, /Claude subscription connected/);
  assert.doesNotMatch(output, new RegExp(token));
  assert.deepEqual(readClaudeAuthFile(home), { token, createdAt: readClaudeAuthFile(home)!.createdAt, source: "setup-token" });
  assert.equal(fs.statSync(claudeAuthPath(home)).mode & 0o777, 0o600);
  saveClaudeOAuthAccount(home, { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 60_000, accountId: "second" });
  assert.equal(execFileSync(process.execPath, [cli, "claude-logout"], { encoding: "utf8", env: { ...process.env, PATH: bin, CLAUDERIPPLE_HOME: home } }), "✓ ClaudeRipple Claude accounts removed\n");
  assert.equal(fs.existsSync(claudeAuthPath(home)), false);
  assert.equal(fs.existsSync(claudeAccountsPath(home)), false);
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
