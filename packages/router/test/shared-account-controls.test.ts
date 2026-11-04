import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialPool, type Credential } from "../src/pool.ts";
import { DEFAULTS, validate, type Config, type ProviderCredential } from "../src/config.ts";
import { ChatGptAccountPool, readChatGptAccounts, saveChatGptAccount, updateChatGptAccount } from "../src/providers/chatgpt/accounts.ts";
import { GoogleAccountPool, readGoogleAccounts, saveGoogleAccount, updateGoogleAccount } from "../src/providers/google/accounts.ts";
import { ClaudeAccountAuthPool } from "../src/providers/anthropic-account-pool.ts";
import { readClaudeOAuthAccounts, saveClaudeOAuthAccount, updateClaudeAccount } from "../src/providers/anthropic-accounts.ts";
import { ClaudeCodeAuthStore, ClaudeCodeCredentialStore } from "../src/providers/anthropic.ts";
import { saveClaudeOAuthFile } from "../src/providers/anthropic-token-file.ts";
import { Logger } from "../src/log.ts";
import { ChatGptAdapter } from "../src/providers/chatgpt/index.ts";
import { GoogleAdapter } from "../src/providers/google/index.ts";

type Controls = { preferred?: boolean; paused?: boolean };
type Fixture = {
  add: (name: string) => string;
  update: (id: string, change: Controls) => boolean;
  credentials: () => Credential[];
  flags: () => { id: string; preferred?: boolean; paused?: boolean }[];
};
const owner = (credential: Credential | null): string | undefined => credential?.ownerId ?? credential?.id;
const log = new Logger(null, 1_000_000, 1, false);

function fixture(kind: string, home: string, now: () => number): Fixture {
  const expiresAt = now() + 86_400_000;
  if (kind === "chatgpt") {
    const pool = new ChatGptAccountPool({ home, mode: "own", now, log });
    return {
      add: (name) => saveChatGptAccount(home, { accessToken: `test-${name}`, accountId: name, expiresAt }).id,
      update: (id, change) => updateChatGptAccount(home, id, change),
      credentials: () => pool.peekCredentials(), flags: () => readChatGptAccounts(home),
    };
  }
  if (kind === "google") {
    const pool = new GoogleAccountPool({ home, now, log });
    return {
      add: (name) => saveGoogleAccount(home, { accessToken: `test-${name}`, projectId: name, email: `${name}@example.test`, expiresAt }).id,
      update: (id, change) => updateGoogleAccount(home, id, change),
      credentials: () => pool.peekCredentials(), flags: () => readGoogleAccounts(home),
    };
  }
  if (kind === "claude") {
    const current = new ClaudeCodeAuthStore(new ClaudeCodeCredentialStore(() => null, now), { home, env: {}, now });
    const pool = new ClaudeAccountAuthPool({ home, now, log, current });
    return {
      add: (name) => saveClaudeOAuthAccount(home, { accessToken: `test-${name}`, refreshToken: `test-refresh-${name}`, accountId: name, expiresAt }).id,
      update: (id, change) => updateClaudeAccount(home, id, change),
      credentials: () => pool.peekCredentials(), flags: () => readClaudeOAuthAccounts(home),
    };
  }
  const entries: ProviderCredential[] = [];
  return {
    add: (name) => {
      if (!entries.some((entry) => entry.id === name)) entries.push({ id: name, headers: { authorization: `Bearer test-${name}` } });
      return name;
    },
    update: (id, change) => {
      const entry = entries.find((entry) => entry.id === id);
      if (!entry) return false;
      if (change.preferred) for (const other of entries) other.preferred = false;
      Object.assign(entry, change);
      return true;
    },
    credentials: () => entries, flags: () => entries,
  };
}

for (const kind of ["chatgpt", "claude", "google", "api-key"]) {
  test(`${kind}: choosing a preferred account moves held conversations, it returns after reset, and a reset alone moves nothing`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-controls-"));
    try {
      let time = Date.now();
      const pool = new CredentialPool({ now: () => time });
      const f = fixture(kind, home, () => time);
      const a = f.add("a");
      assert.equal(owner(pool.pick(kind, f.credentials(), "single")), a);
      const b = f.add("b");
      assert.equal(owner(pool.pick(kind, f.credentials(), "old")), a);
      assert.equal(f.update(b, { preferred: true }), true);
      assert.equal(owner(pool.pick(kind, f.credentials(), "new")), b);
      // The owner chose b: a conversation held by a moves there too (2026-11-04).
      assert.equal(owner(pool.pick(kind, f.credentials(), "old")), b);
      const runtimeB = f.credentials().find((credential) => owner(credential) === b)!;
      pool.penalise(kind, runtimeB.id, 429, 5_000);
      assert.equal(owner(pool.pick(kind, f.credentials(), "during-rest")), a);
      assert.deepEqual(pool.report(kind, f.credentials()).filter((row) => row.inUse).map((row) => row.id), [f.credentials().find((credential) => owner(credential) === a)!.id]);
      time += 5_001;
      assert.equal(owner(pool.pick(kind, f.credentials(), "after-reset")), b);
      assert.equal(owner(pool.pick(kind, f.credentials(), "during-rest")), a);
      assert.equal(pool.report(kind, f.credentials()).filter((row) => row.inUse).length, 1);
      assert.equal(f.update(a, { preferred: true }), true);
      assert.equal(f.flags().filter((account) => account.preferred).length, 1);
      assert.equal(f.update(b, { preferred: false }), true, "clearing a nonpreferred row does not clear the preferred one");
      assert.equal(owner(pool.pick(kind, f.credentials(), "newer")), a);
      assert.equal(f.update(a, { preferred: false }), true);
      assert.equal(owner(pool.pick(kind, f.credentials(), "no-flags")), a);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test(`${kind}: pause overrides affinity, all-cooling selection excludes paused accounts, and clear restores readiness`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-controls-"));
    try {
      const pool = new CredentialPool();
      const f = fixture(kind, home, Date.now);
      const a = f.add("a");
      const b = f.add("b");
      assert.equal(owner(pool.pick(kind, f.credentials(), "held")), a);
      f.update(a, { preferred: true, paused: true });
      assert.equal(owner(pool.pick(kind, f.credentials(), "held")), b);
      const runtimeB = f.credentials().find((credential) => owner(credential) === b)!;
      pool.penalise(kind, runtimeB.id, 429, 60_000);
      assert.equal(pool.pick(kind, f.credentials(), "new"), null);
      assert.equal(pool.hasUsable(kind, f.credentials()), false);
      assert.equal(pool.report(kind, f.credentials()).some((row) => row.inUse), false);
      // The proxy's legacy all-cooling fallback gets only unpaused entries.
      assert.equal(owner(f.credentials().filter((credential) => !credential.paused)[0] ?? null), b);
      pool.clear(kind, runtimeB.id);
      assert.equal(owner(pool.pick(kind, f.credentials(), "cleared")), b);
      f.update(b, { paused: true });
      assert.equal(pool.pick(kind, f.credentials()), null);
      assert.equal(pool.hasUsable(kind, f.credentials()), false);
      assert.equal(pool.report(kind, f.credentials()).some((row) => row.inUse), false);
      f.update(a, { paused: false });
      assert.equal(owner(pool.pick(kind, f.credentials(), "resumed")), a);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test(`${kind}: re-login preserves operator flags`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-controls-"));
    try {
      const f = fixture(kind, home, Date.now);
      const id = f.add("a");
      f.update(id, { preferred: true, paused: true });
      assert.equal(f.add("a"), id);
      assert.equal(f.flags()[0]?.preferred, true);
      assert.equal(f.flags()[0]?.paused, true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}

for (const type of ["anthropic-compatible", "openai-compatible"] as const) {
  test(`${type}: config validates booleans and permits at most one preferred credential`, () => {
    const config = (entries: unknown[]): Config => JSON.parse(JSON.stringify({ ...DEFAULTS, providers: { p: { type, url: "https://example.test", credentials: entries } } })) as Config;
    const a = { id: "a", headers: {}, preferred: true, paused: true };
    assert.deepEqual(validate(config([a, { id: "b", headers: {}, preferred: false, paused: false }])), []);
    assert.ok(validate(config([a, { ...a, id: "b" }])).some((error) => error.includes("at most one")));
    for (const field of ["preferred", "paused"]) for (const value of [null, 1, "true", {}]) {
      assert.ok(validate(config([{ ...a, [field]: value }])).some((error) => error.includes(`${field} must be a boolean`)));
    }
    assert.deepEqual(validate(config([{ id: "only", headers: {} }])), []);
  });
}

test("login adapters expose exactly one inUse and clear a cooldown while its account is paused", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-controls-"));
  try {
    for (const kind of ["chatgpt", "google"]) {
      const pool = new CredentialPool();
      const f = fixture(kind, home, Date.now);
      const a = f.add("a");
      const b = f.add("b");
      const adapter = kind === "chatgpt"
        ? new ChatGptAdapter(kind, { type: "chatgpt", auth: "own" }, home, log, pool)
        : new GoogleAdapter(kind, { type: "google", auth: "antigravity" }, home, log, pool);
      f.update(b, { preferred: true });
      assert.deepEqual(adapter.accountStatus().filter((row) => row.inUse).map((row) => row.id), [b]);
      pool.penalise(kind, b, 429, 60_000);
      assert.deepEqual(adapter.accountStatus().filter((row) => row.inUse).map((row) => row.id), [a]);
      f.update(b, { paused: true });
      adapter.clearCooldown(b);
      f.update(b, { paused: false });
      assert.deepEqual(adapter.accountStatus().filter((row) => row.inUse).map((row) => row.id), [b]);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Claude legacy current-token projection cannot bypass a stored pause", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-controls-"));
  try {
    const now = Date.now;
    saveClaudeOAuthFile(home, { accessToken: "test-legacy", refreshToken: "test-refresh", expiresAt: now() + 86_400_000 });
    const current = new ClaudeCodeAuthStore(new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "test-legacy", expiresAt: now() + 86_400_000 } }), now), { home, env: {}, now });
    const pool = new ClaudeAccountAuthPool({ home, now, log, current });
    assert.equal(pool.peekCredentials().length, 1);
    const runtime = pool.peekCredentials()[0]!;
    const health = new CredentialPool();
    health.penalise("claude", runtime.id, 429);
    updateClaudeAccount(home, "legacy", { paused: true });
    assert.deepEqual(pool.peekCredentials(), []);
    assert.deepEqual(pool.cooldownOwners("legacy"), ["legacy", "current"]);
    for (const ownerId of pool.cooldownOwners("legacy")) health.clearOwner("claude", ownerId);
    updateClaudeAccount(home, "legacy", { paused: false });
    assert.equal(health.report("claude", pool.peekCredentials())[0]?.inUse, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("clearOwner releases all Claude token generations without clearing another account", () => {
  const pool = new CredentialPool();
  const credentials: Credential[] = ["a:old", "a:new", "ab:new"].map((id) => ({ id, headers: {} }));
  for (const credential of credentials) pool.penalise("claude", credential.id, 429);
  pool.clearOwner("claude", "a");
  assert.deepEqual(pool.report("claude", credentials).map((row) => row.state), ["ready", "ready", "cooling"]);
});
