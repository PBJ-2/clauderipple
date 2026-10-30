import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CODE_IDENTITY,
  ClaudeCodeAuthStore,
  ClaudeCodeCredentialStore,
  nativeAnthropicHeaders,
  observedAnthropicHeaders,
} from "../src/providers/anthropic.ts";
import { OBSERVED_CLAUDE_CODE_TTL_MS, ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import {
  CLAUDE_CLI_FALLBACK_VERSION,
  claudeCliUserAgent,
  installedClaudeCliVersion,
  parseClaudeCliVersion,
} from "../src/providers/claude-cli-version.ts";
import { saveClaudeAuthFile } from "../src/providers/anthropic-token-file.ts";
import { posixModes } from "../../../test/capabilities.ts";

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

test("describeSource checks injected keychain, credentials file, token file, then nothing", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-source-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = 10_000;
  const credential = (accessToken: string, expiresAt = now + 1_000) => JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });

  const keychain = new ClaudeCodeAuthStore(undefined, {
    home,
    env: {},
    now: () => now,
    credentialReaders: { keychain: () => credential("keychain-token"), credentialsFile: () => credential("file-token") },
  });
  assert.equal(keychain.describeSource(), "keychain");

  const credentialsFile = new ClaudeCodeAuthStore(undefined, {
    home,
    env: {},
    now: () => now,
    credentialReaders: { keychain: () => null, credentialsFile: () => credential("file-token") },
  });
  assert.equal(credentialsFile.describeSource(), "credentials-file");

  saveClaudeAuthFile(home, "token-file-token", "2026-09-13T00:00:00.000Z");
  const tokenFile = new ClaudeCodeAuthStore(undefined, {
    home,
    env: {},
    now: () => now,
    credentialReaders: { keychain: () => credential("expired", now), credentialsFile: () => null },
  });
  assert.equal(tokenFile.describeSource(), "token-file");

  fs.unlinkSync(path.join(home, "claude-auth.json"));
  const missing = new ClaudeCodeAuthStore(undefined, {
    home,
    env: {},
    now: () => now,
    credentialReaders: { keychain: () => null, credentialsFile: () => null },
  });
  assert.equal(missing.describeSource(), null);
});

test("get reads the injected keychain before the credentials file", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-get-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let keychainReads = 0;
  let credentialsFileReads = 0;
  const store = new ClaudeCodeAuthStore(undefined, {
    home,
    env: {},
    now: () => 10_000,
    credentialReaders: {
      keychain: () => {
        keychainReads++;
        return JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token", expiresAt: Number.MAX_SAFE_INTEGER } });
      },
      credentialsFile: () => {
        credentialsFileReads++;
        return JSON.stringify({ claudeAiOauth: { accessToken: "file-token", expiresAt: Number.MAX_SAFE_INTEGER } });
      },
    },
  });
  const result = store.get();
  if (result instanceof Error || result.source !== "stored") throw new Error("expected stored auth");
  assert.equal(result.credentials.accessToken, "keychain-token");
  assert.equal(keychainReads, 1);
  assert.equal(credentialsFileReads, 0);
});

test("OAuth native headers follow Claude Code wire requirements", () => {
  const headers = nativeAnthropicHeaders({ type: "anthropic", auth: "claude-code" }, { accessToken: "secret", expiresAt: Date.now() + 1_000 });
  assert.equal(headers.authorization, "Bearer secret");
  assert.equal(headers["anthropic-beta"], "claude-code-20250219,oauth-2025-04-20");
  assert.equal(headers["anthropic-version"], "2023-06-01");
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
  if (posixModes) assert.equal(fs.statSync(path.join(home, "claude-auth.json")).mode & 0o777, 0o600);
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

test("the fallback user-agent takes the observed version, then this machine's CLI, then the constant", () => {
  const credentials = { accessToken: "secret", expiresAt: Date.now() + 1_000 };
  const provider = { type: "anthropic" as const, auth: "claude-code" as const };
  const agent = (versionSources: Parameters<typeof nativeAnthropicHeaders>[2]): string =>
    nativeAnthropicHeaders(provider, credentials, versionSources)["user-agent"]!;

  assert.equal(agent({ observed: "claude-cli/2.1.308 (external, cli)" }), "claude-cli/2.1.308 (external, cli)");
  assert.equal(agent({ observed: "2.1.308" }), "claude-cli/2.1.308 (external, cli)", "a bare version is accepted");
  assert.equal(agent({ observed: "ClaudeDesktop/1", installed: () => "2.1.310" }), "claude-cli/2.1.310 (external, cli)");
  assert.equal(agent({ observed: null, installed: () => "2.1.310" }), "claude-cli/2.1.310 (external, cli)");
  assert.equal(agent({ observed: null, installed: () => null }), claudeCliUserAgent(CLAUDE_CLI_FALLBACK_VERSION));
  assert.match(CLAUDE_CLI_FALLBACK_VERSION, /^\d+\.\d+\.\d+$/);
});

test("a version parser rejects anything but a three-part version", () => {
  assert.equal(parseClaudeCliVersion("claude-cli/2.1.304 (external, cli)"), "2.1.304");
  assert.equal(parseClaudeCliVersion(" 2.1.304 "), "2.1.304");
  assert.equal(parseClaudeCliVersion("2.1"), null);
  assert.equal(parseClaudeCliVersion("ClaudeDesktop/1"), null);
  assert.equal(parseClaudeCliVersion("foo/1.2.3 claude-cli/2.1.304"), null, "only Claude Code's own form is read");
  assert.equal(parseClaudeCliVersion(null), null);
});

test("an observation hands its CLI version to fallback headers only inside the snapshot TTL", () => {
  const observed = new ObservedClaudeCodeAuth();
  observed.observe(["authorization", "Bearer token", "user-agent", "claude-cli/2.1.309 (external, cli)"], 10_000);
  assert.equal(observed.cliVersion(10_000), "2.1.309");
  assert.equal(observed.cliVersion(10_000 + OBSERVED_CLAUDE_CODE_TTL_MS - 1), "2.1.309");
  assert.equal(observed.cliVersion(10_000 + OBSERVED_CLAUDE_CODE_TTL_MS), null);

  const store = new ClaudeCodeAuthStore(new ClaudeCodeCredentialStore(() => null, () => 10_001), { observed, home: "/nonexistent", env: {}, now: () => 10_001 });
  assert.equal(store.observedCliVersion(), "2.1.309");
});

test("the installed CLI version is the newest cached version directory", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-cli-versions-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "2.1.280"));
  fs.mkdirSync(path.join(directory, "2.1.310"));
  fs.mkdirSync(path.join(directory, "not-a-version"));
  assert.equal(installedClaudeCliVersion([directory]), "2.1.310");
  assert.equal(installedClaudeCliVersion([path.join(directory, "missing")]), null);
});
