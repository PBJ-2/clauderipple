import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CODE_IDENTITY,
  ClaudeCodeAuthStore,
  ClaudeCodeCredentialStore,
  fromClaudeCodeToolName,
  nativeAnthropicHeaders,
  observedAnthropicHeaders,
  toClaudeCodeToolName,
} from "../src/providers/anthropic.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import { saveClaudeAuthFile } from "../src/providers/anthropic-token-file.ts";

test("borrowed Claude Code credential is cached for 60 seconds and never refreshed", () => {
  let reads = 0;
  let now = 100;
  const store = new ClaudeCodeCredentialStore(() => {
    reads++;
    return JSON.stringify({ claudeAiOauth: { accessToken: "secret", expiresAt: 1_000_000 } });
  }, () => now);
  const first = store.get();
  const second = store.get();
  assert.ok(!(first instanceof Error));
  assert.ok(!(second instanceof Error));
  assert.equal(reads, 1);
  now += 60_001;
  store.get();
  assert.equal(reads, 2);
});

test("expired Claude Code credential returns a clear client-safe error", () => {
  const store = new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "secret", expiresAt: 99 } }), () => 100);
  const result = store.get();
  assert.ok(result instanceof Error);
  assert.match(result.message, /Claude Code login expired — open Claude Code once to refresh/);
});

test("OAuth native headers and custom tool names follow Claude Code wire requirements", () => {
  const headers = nativeAnthropicHeaders({ type: "anthropic", auth: "claude-code" }, { accessToken: "secret", expiresAt: Date.now() + 1_000 });
  assert.equal(headers.authorization, "Bearer secret");
  assert.equal(headers["anthropic-beta"], "claude-code-20250219,oauth-2025-04-20");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(toClaudeCodeToolName("Read"), "custom_Read");
  assert.equal(toClaudeCodeToolName("web_search"), "web_search");
  assert.equal(fromClaudeCodeToolName("custom_Read"), "Read");
  assert.equal(CLAUDE_CODE_IDENTITY, "You are Claude Code, Anthropic's official CLI for Claude.");
});

test("fresh observed CLI headers win and are replayed exactly without non-allowlisted values", () => {
  const observed = new ObservedClaudeCodeAuth();
  observed.observe([
    "Authorization", "Bearer observed-secret",
    "Anthropic-Beta", "specific-beta",
    "anthropic-version", "2023-06-01",
    "User-Agent", "ClaudeDesktop/1",
    "x-app", "desktop",
    "x-stainless-lang", "js",
    "anthropic-client-version", "1.2.3",
    "x-not-allowed", "discard-me",
  ], 10_000);
  const stored = new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "stored-secret", expiresAt: 100_000 } }), () => 10_001);
  const result = new ClaudeCodeAuthStore(stored, { observed, now: () => 10_001 }).get();
  assert.ok(!(result instanceof Error));
  assert.equal(result.source, "observed");
  if (result.source !== "observed") throw new Error("expected observed auth");
  assert.deepEqual(observedAnthropicHeaders(result.observed), {
    Authorization: "Bearer observed-secret",
    "Anthropic-Beta": "specific-beta",
    "anthropic-version": "2023-06-01",
    "User-Agent": "ClaudeDesktop/1",
    "x-app": "desktop",
    "x-stainless-lang": "js",
    "anthropic-client-version": "1.2.3",
  });
});

test("expired observed header falls through env, stored CLI credential, then 0600 setup-token file", () => {
  const observed = new ObservedClaudeCodeAuth();
  observed.observe(["authorization", "Bearer stale-secret"], 0);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-auth-"));
  saveClaudeAuthFile(home, "file-secret", "2026-09-13T00:00:00.000Z");
  assert.equal(fs.statSync(path.join(home, "claude-auth.json")).mode & 0o777, 0o600);
  const missing = new ClaudeCodeCredentialStore(() => null, () => 12 * 60 * 60 * 1_000 + 1);
  const fromFile = new ClaudeCodeAuthStore(missing, { observed, home, env: {}, now: () => 12 * 60 * 60 * 1_000 + 1 }).get();
  assert.ok(!(fromFile instanceof Error));
  assert.equal(fromFile.source, "token-file");
  if (fromFile instanceof Error || fromFile.source !== "token-file") throw new Error("expected token file auth");
  assert.equal(fromFile.credentials.accessToken, "file-secret");
  const fromEnv = new ClaudeCodeAuthStore(missing, { observed, home, env: { CLAUDE_CODE_OAUTH_TOKEN: "env-secret" }, now: () => 12 * 60 * 60 * 1_000 + 1 }).get();
  assert.ok(!(fromEnv instanceof Error));
  assert.equal(fromEnv.source, "env");
  const validStored = new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "stored-secret", expiresAt: 100_000_000 } }), () => 12 * 60 * 60 * 1_000 + 1);
  const fromStored = new ClaudeCodeAuthStore(validStored, { observed, home, env: {}, now: () => 12 * 60 * 60 * 1_000 + 1 }).get();
  assert.ok(!(fromStored instanceof Error));
  assert.equal(fromStored.source, "stored");
});
