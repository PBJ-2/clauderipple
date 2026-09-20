// Claude subscription account storage: secrets stay in one 0600 file, upstream identities are
// one-way hashed, re-login replaces rather than duplicates, and refresh writes are generation-safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claudeAccountsPath,
  legacyMigrationDurable,
  listClaudeAccounts,
  markClaudeAccountNeedsReauth,
  readClaudeAccountsFile,
  readClaudeOAuthAccounts,
  removeClaudeAccount,
  renameClaudeAccount,
  replaceClaudeOAuthAccount,
  saveClaudeOAuthAccount,
} from "../src/providers/anthropic-accounts.ts";
import { readClaudeAuthFile, saveClaudeOAuthFile } from "../src/providers/anthropic-token-file.ts";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-accounts-"));
}

const grant = (suffix: string, accountId = `upstream-${suffix}`) => ({
  accessToken: `access-${suffix}`,
  refreshToken: `refresh-${suffix}`,
  expiresAt: 2_000_000,
  accountId,
  email: `${suffix}@example.test`,
});

function addAccountInChild(home: string, suffix: string): Promise<void> {
  const moduleUrl = new URL("../src/providers/anthropic-accounts.ts", import.meta.url).href;
  const script = [
    `import { saveClaudeOAuthAccount } from ${JSON.stringify(moduleUrl)};`,
    `saveClaudeOAuthAccount(${JSON.stringify(home)}, ${JSON.stringify(grant(suffix))});`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`)));
  });
}

test("account storage is private, exposes safe summaries, and never stores the upstream UUID", () => {
  const dir = home();
  try {
    const account = saveClaudeOAuthAccount(dir, grant("one"), "2026-09-20T00:00:00.000Z");
    assert.equal(fs.statSync(claudeAccountsPath(dir)).mode & 0o777, 0o600);
    const raw = fs.readFileSync(claudeAccountsPath(dir), "utf8");
    assert.doesNotMatch(raw, /upstream-one/);
    assert.match(raw, /[0-9a-f]{64}/);
    assert.deepEqual(listClaudeAccounts(dir), [{
      id: account.id,
      label: "one@example.test",
      email: "one@example.test",
      expiresAt: 2_000_000,
      needsReauth: false,
    }]);
    assert.doesNotMatch(JSON.stringify(listClaudeAccounts(dir)), /access-one|refresh-one|upstream-one/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("signing into the same upstream account replaces its grant and preserves local identity", () => {
  const dir = home();
  try {
    const first = saveClaudeOAuthAccount(dir, grant("old", "same-subject"), "2026-09-20T00:00:00.000Z");
    assert.equal(renameClaudeAccount(dir, first.id, "Work"), true);
    const second = saveClaudeOAuthAccount(dir, grant("new", "same-subject"), "2026-09-20T01:00:00.000Z");
    assert.equal(second.id, first.id);
    assert.equal(second.label, "Work");
    const stored = readClaudeAccountsFile(dir);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.token, "access-new");
    assert.equal(stored[0]!.refreshToken, "refresh-new");
    assert.equal(stored[0]!.createdAt, "2026-09-20T00:00:00.000Z");
    assert.equal(stored[0]!.updatedAt, "2026-09-20T01:00:00.000Z");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh and rejection writes compare the refresh-token generation", () => {
  const dir = home();
  try {
    const account = saveClaudeOAuthAccount(dir, grant("old"));
    assert.equal(replaceClaudeOAuthAccount(dir, account.id, "wrong-generation", grant("lost")), false);
    assert.equal(readClaudeAccountsFile(dir)[0]!.token, "access-old");
    assert.equal(replaceClaudeOAuthAccount(dir, account.id, "refresh-old", grant("fresh")), true);
    assert.equal(markClaudeAccountNeedsReauth(dir, account.id, "refresh-old"), false, "an old refresh failure cannot quarantine the new login");
    assert.equal(markClaudeAccountNeedsReauth(dir, account.id, "refresh-fresh"), true);
    assert.equal(readClaudeAccountsFile(dir)[0]!.needsReauth, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent processes preserve every account mutation", async () => {
  const dir = home();
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => addAccountInChild(dir, `child-${index}`)));
    assert.deepEqual(
      readClaudeAccountsFile(dir).map((account) => account.email).sort(),
      Array.from({ length: 8 }, (_, index) => `child-${index}@example.test`).sort(),
    );
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".lock")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale process lock is recovered without leaving lock files", () => {
  const dir = home();
  try {
    const lock = `${claudeAccountsPath(dir)}.lock`;
    fs.mkdirSync(lock, { mode: 0o700 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const account = saveClaudeOAuthAccount(dir, grant("recovered"));
    assert.equal(listClaudeAccounts(dir)[0]!.id, account.id);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".lock")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed pool fails closed and cannot be overwritten by a mutation", () => {
  const dir = home();
  try {
    const malformed = JSON.stringify({ version: 1, accounts: [{ id: "partial", token: "secret" }] });
    fs.writeFileSync(claudeAccountsPath(dir), malformed);
    assert.deepEqual(readClaudeAccountsFile(dir), []);
    assert.deepEqual(readClaudeOAuthAccounts(dir), []);
    assert.throws(() => saveClaudeOAuthAccount(dir, grant("replacement")), /refusing to overwrite/);
    assert.equal(fs.readFileSync(claudeAccountsPath(dir), "utf8"), malformed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy migration uses directory durability on POSIX and the atomic rename boundary on Windows", () => {
  assert.equal(legacyMigrationDurable(true, "darwin"), true);
  assert.equal(legacyMigrationDurable(false, "darwin"), false);
  assert.equal(legacyMigrationDurable(false, "win32"), true);
});

test("the legacy OAuth file is visible until the first pool mutation, then migrated once", () => {
  const dir = home();
  try {
    saveClaudeOAuthFile(dir, { accessToken: "legacy-access", refreshToken: "legacy-refresh", expiresAt: 3_000_000 }, "2026-09-19T00:00:00.000Z");
    assert.deepEqual(readClaudeOAuthAccounts(dir).map((account) => account.id), ["legacy"]);
    const added = saveClaudeOAuthAccount(dir, grant("two"));
    assert.equal(readClaudeAuthFile(dir), null, "the old mutable copy is removed only after the pool write");
    const stored = readClaudeAccountsFile(dir);
    assert.deepEqual(stored.map((account) => account.id), ["legacy", added.id]);
    saveClaudeOAuthFile(dir, { accessToken: "stale-legacy-access", refreshToken: "stale-legacy-refresh", expiresAt: 4_000_000 }, "2026-09-19T00:00:00.000Z");
    assert.deepEqual(readClaudeOAuthAccounts(dir).map((account) => account.id), ["legacy", added.id], "a retained old file cannot duplicate a migrated legacy account after token rotation");
    assert.equal(removeClaudeAccount(dir, "legacy"), true);
    assert.deepEqual(readClaudeAccountsFile(dir).map((account) => account.id), [added.id]);
    assert.deepEqual(readClaudeOAuthAccounts(dir).map((account) => account.id), [added.id], "a retained old file cannot resurrect a removed legacy account once the pool exists");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
