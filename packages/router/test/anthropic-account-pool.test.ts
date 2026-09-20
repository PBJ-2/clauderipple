// Runtime projection of Claude subscription accounts. The current Claude login stays externally
// owned; ClaudeRipple refreshes only grants in its private account file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClaudeAccountAuthPool } from "../src/providers/anthropic-account-pool.ts";
import { readClaudeAccountsFile, saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";
import { ClaudeCodeAuthStore, ClaudeCodeCredentialStore } from "../src/providers/anthropic.ts";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-account-pool-"));
}

const log = () => {
  const info: string[] = [];
  const warn: string[] = [];
  return { info, warn, logger: { info: (line: string) => info.push(line), warn: (line: string) => warn.push(line) } };
};

function noCurrent(dir: string, now: () => number): ClaudeCodeAuthStore {
  return new ClaudeCodeAuthStore(new ClaudeCodeCredentialStore(() => null, now), { home: dir, env: {}, now });
}

test("the current Claude login is first and stored accounts follow without exposing refresh tokens", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthAccount(dir, { accessToken: "stored-access", refreshToken: "stored-refresh", expiresAt: 9_000_000, accountId: "stored-id" });
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "current-access", expiresAt: 9_000_000 } }), now),
      { home: dir, env: {}, now },
    );
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    const credentials = pool.peekCredentials();
    const stored = readClaudeAccountsFile(dir)[0]!;
    assert.match(credentials[0]!.id, /^current:/);
    assert.equal(credentials[0]!.ownerId, "current");
    assert.match(credentials[1]!.id, new RegExp(`^${stored.id}:`));
    assert.equal(credentials[1]!.ownerId, stored.id);
    assert.equal(credentials[0]!.headers.authorization, "Bearer current-access");
    assert.equal(credentials[1]!.headers.authorization, "Bearer stored-access");
    assert.doesNotMatch(JSON.stringify(credentials), /stored-refresh/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed current Claude login gets a fresh runtime identity", () => {
  const dir = home();
  try {
    let time = 1_000_000;
    let accessToken = "current-old";
    const now = () => time;
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(
        () => JSON.stringify({ claudeAiOauth: { accessToken, expiresAt: 9_000_000 } }),
        now,
      ),
      { home: dir, env: {}, now },
    );
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    const before = pool.peekCredentials()[0]!;

    accessToken = "current-new";
    time += 60_000;
    const after = pool.peekCredentials()[0]!;

    assert.equal(before.ownerId, "current");
    assert.equal(after.ownerId, "current");
    assert.notEqual(after.id, before.id);
    assert.equal(after.headers.authorization, "Bearer current-new");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent callers share one refresh and persist the rotated grant", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const account = saveClaudeOAuthAccount(dir, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: now() - 1, accountId: "one" });
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
      calls += 1;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(body.refresh_token, "old-refresh");
      await held;
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 }), { status: 200 });
    };
    const lines = log();
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current: noCurrent(dir, now), fetch: fetchImpl, log: lines.logger });
    const first = pool.credentials();
    const second = pool.credentials();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a[0]!.headers.authorization, "Bearer new-access");
    assert.equal(b[0]!.headers.authorization, "Bearer new-access");
    const stored = readClaudeAccountsFile(dir).find((candidate) => candidate.id === account.id)!;
    assert.equal(stored.refreshToken, "new-refresh");
    assert.equal(stored.expiresAt, now() + 7_200_000);
    assert.ok(lines.info.some((line) => /token refreshed/.test(line)));
    assert.doesNotMatch(lines.info.join("\n"), /old-refresh|new-refresh|old-access|new-access/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("separate account-pool projections share one refresh for the same grant generation", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthAccount(dir, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: now() - 1, accountId: "one" });
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      await held;
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 }), { status: 200 });
    };
    const options = { home: dir, now, current: noCurrent(dir, now), fetch: fetchImpl, log: log().logger };
    const proxyProjection = new ClaudeAccountAuthPool(options);
    const ingressProjection = new ClaudeAccountAuthPool(options);

    const first = proxyProjection.credentials();
    const second = ingressProjection.credentials();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a[0]!.headers.authorization, "Bearer new-access");
    assert.equal(b[0]!.headers.authorization, "Bearer new-access");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a slow refresh does not block an independent current login", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthAccount(dir, { accessToken: "due-access", refreshToken: "due-refresh", expiresAt: now() + 1_000, accountId: "due" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "current-access", expiresAt: 9_000_000 } }), now),
      { home: dir, env: {}, now },
    );
    const pool = new ClaudeAccountAuthPool({
      home: dir,
      now,
      current,
      log: log().logger,
      fetch: async () => {
        await held;
        return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 7200 }), { status: 200 });
      },
    });
    const race = await Promise.race([
      pool.credentials().then((credentials) => credentials[0]!.headers.authorization),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    assert.equal(race, "Bearer current-access");
    release();
    await pool.refreshIfNeeded();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a refreshed or re-signed-in grant gets a new runtime identity without changing its owner id", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const first = saveClaudeOAuthAccount(dir, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 9_000_000, accountId: "same" });
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current: noCurrent(dir, now), log: log().logger });
    const before = pool.peekCredentials()[0]!;
    const second = saveClaudeOAuthAccount(dir, { accessToken: "new-access", refreshToken: "old-refresh", expiresAt: 9_000_000, accountId: "same" });
    const afterAccessOnly = pool.peekCredentials()[0]!;
    assert.equal(second.id, first.id);
    assert.equal(before.ownerId, first.id);
    assert.equal(afterAccessOnly.ownerId, first.id);
    assert.notEqual(afterAccessOnly.id, before.id, "an access-token-only rotation is a new runtime generation");
    saveClaudeOAuthAccount(dir, { accessToken: "newer-access", refreshToken: "new-refresh", expiresAt: 9_000_000, accountId: "same" });
    const afterBoth = pool.peekCredentials()[0]!;
    assert.equal(afterBoth.ownerId, first.id);
    assert.notEqual(afterBoth.id, afterAccessOnly.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a 401 from an old runtime generation cannot quarantine a refreshed grant", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const account = saveClaudeOAuthAccount(dir, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 9_000_000, accountId: "same" });
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current: noCurrent(dir, now), log: log().logger });
    const oldRuntimeId = pool.peekCredentials()[0]!.id;
    saveClaudeOAuthAccount(dir, { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 9_000_000, accountId: "same" });
    pool.reject(oldRuntimeId);
    const stored = readClaudeAccountsFile(dir).find((candidate) => candidate.id === account.id)!;
    assert.notEqual(stored.needsReauth, true);
    assert.equal(pool.peekCredentials()[0]!.headers.authorization, "Bearer new-access");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh transport errors cannot reflect account secrets into logs", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthAccount(dir, { accessToken: "opaque-access-secret", refreshToken: "opaque-refresh-secret", expiresAt: now() + 1_000, accountId: "secret-error" });
    const lines = log();
    const pool = new ClaudeAccountAuthPool({
      home: dir,
      now,
      current: noCurrent(dir, now),
      log: lines.logger,
      fetch: async () => { throw new Error("opaque-access-secret\nrefresh_token=opaque-refresh-secret"); },
    });
    await pool.refreshIfNeeded();
    assert.doesNotMatch(lines.warn.join("\n"), /opaque-(?:access|refresh)-secret/);
    assert.doesNotMatch(lines.warn.join("\n"), /\n/);
    assert.match(lines.warn.join("\n"), /\[REDACTED\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid_grant requires reauthentication, while a transient endpoint failure does not", async () => {
  for (const scenario of [
    { name: "rejected", status: 400, body: { error: "invalid_grant" }, needsReauth: true },
    { name: "transient", status: 503, body: { error: "unavailable" }, needsReauth: false },
  ]) {
    const dir = home();
    try {
      const now = () => 1_000_000;
      const account = saveClaudeOAuthAccount(dir, { accessToken: `${scenario.name}-access`, refreshToken: `${scenario.name}-refresh`, expiresAt: now() + 1_000, accountId: scenario.name });
      const lines = log();
      const pool = new ClaudeAccountAuthPool({
        home: dir,
        now,
        current: noCurrent(dir, now),
        log: lines.logger,
        fetch: async () => new Response(JSON.stringify(scenario.body), { status: scenario.status }),
      });
      await pool.refreshIfNeeded();
      const stored = readClaudeAccountsFile(dir).find((candidate) => candidate.id === account.id)!;
      assert.equal(stored.needsReauth === true, scenario.needsReauth, scenario.name);
      assert.equal(pool.peekCredentials().length, scenario.needsReauth ? 0 : 1, scenario.name);
      assert.doesNotMatch(lines.warn.join("\n"), new RegExp(`${scenario.name}-(?:access|refresh)`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
