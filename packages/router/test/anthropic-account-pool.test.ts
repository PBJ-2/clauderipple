// Runtime projection of Claude subscription accounts. The current Claude login stays externally
// owned; ClaudeRipple refreshes only grants in its private account file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClaudeAccountAuthPool } from "../src/providers/anthropic-account-pool.ts";
import { CredentialPool } from "../src/pool.ts";
import {
  listClaudeAccounts,
  readClaudeAccountsFile,
  replaceClaudeOAuthAccount,
  saveClaudeOAuthAccount,
  setCurrentClaudeAccountPaused,
  setPreferredClaudeAccount,
  updateClaudeAccount,
} from "../src/providers/anthropic-accounts.ts";
import { ClaudeCodeAuthStore, ClaudeCodeCredentialStore } from "../src/providers/anthropic.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";

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

test("the current login's pause survives a new pool and account writes, and resuming projects it again", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "current-access", expiresAt: 9_000_000 } }), now),
      { home: dir, env: {}, now },
    );
    const options = { home: dir, now, current, log: log().logger };
    const pool = new ClaudeAccountAuthPool(options);
    assert.equal(pool.currentPaused(), false);
    setCurrentClaudeAccountPaused(dir, true);
    assert.equal(pool.currentPaused(), true);
    assert.deepEqual(pool.peekCredentials(), []);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "claude-current-paused")).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(dir, "claude-accounts.json")), false, "pausing needs no stored copy of the login");

    const stored = saveClaudeOAuthAccount(dir, { accessToken: "stored-access", refreshToken: "stored-refresh", expiresAt: 9_000_000, accountId: "stored-id" });
    const restarted = new ClaudeAccountAuthPool(options);
    assert.equal(restarted.currentPaused(), true);
    assert.deepEqual(restarted.peekCredentials().map((c) => c.ownerId), [stored.id]);
    assert.equal(current.describeSource(), "keychain", "the external credential is left alone");

    setCurrentClaudeAccountPaused(dir, false);
    assert.equal(restarted.currentPaused(), false);
    assert.deepEqual(restarted.peekCredentials().map((c) => c.ownerId), ["current", stored.id]);
    setCurrentClaudeAccountPaused(dir, false);
    assert.equal(fs.existsSync(path.join(dir, "claude-current-paused")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resuming the current login does not bypass a paused stored copy of the same token", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const stored = saveClaudeOAuthAccount(dir, { accessToken: "same-access", refreshToken: "stored-refresh", expiresAt: 9_000_000 });
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "same-access", expiresAt: 9_000_000 } }), now),
      { home: dir, env: {}, now },
    );
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    assert.deepEqual(pool.peekCredentials().map((c) => c.ownerId), ["current"]);
    setCurrentClaudeAccountPaused(dir, true);
    assert.deepEqual(pool.peekCredentials(), [], "an unpaused stored copy cannot re-project the paused current token");
    updateClaudeAccount(dir, stored.id, { paused: true });
    setCurrentClaudeAccountPaused(dir, false);
    assert.deepEqual(pool.peekCredentials(), [], "the stored pause still drops the current login");
    updateClaudeAccount(dir, stored.id, { paused: false });
    assert.deepEqual(pool.peekCredentials().map((c) => c.ownerId), ["current"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a preferred stored account leads the current login, and clearing it hands first place back", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const first = saveClaudeOAuthAccount(dir, { accessToken: "a-access", refreshToken: "a-refresh", expiresAt: 9_000_000, accountId: "a" });
    const second = saveClaudeOAuthAccount(dir, { accessToken: "b-access", refreshToken: "b-refresh", expiresAt: 9_000_000, accountId: "b" });
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "current-access", expiresAt: 9_000_000 } }), now),
      { home: dir, env: {}, now },
    );
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    const order = () => pool.peekCredentials().map((c) => c.ownerId);
    assert.deepEqual(order(), ["current", first.id, second.id]);

    assert.equal(setPreferredClaudeAccount(dir, second.id), true);
    assert.deepEqual(order(), [second.id, "current", first.id]);
    assert.equal(setPreferredClaudeAccount(dir, first.id), true);
    assert.deepEqual(order(), [first.id, "current", second.id], "only one account is preferred at a time");
    assert.deepEqual(listClaudeAccounts(dir).map((a) => a.preferred), [true, false]);

    // A refresh rewrites the account; the choice survives it.
    replaceClaudeOAuthAccount(dir, first.id, "a-refresh", { accessToken: "a2", refreshToken: "a2-refresh", expiresAt: 9_000_000 });
    assert.equal(order()[0], first.id);

    assert.equal(setPreferredClaudeAccount(dir, "missing"), false);
    assert.equal(setPreferredClaudeAccount(dir, null), true);
    assert.deepEqual(order(), ["current", first.id, second.id]);
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

// Issue #123: the 12 h guard counted from the last un-routed request, so an account answering
// every turn through the pool was forgotten and then listed nowhere. Pool use is now evidence.
test("use through the pool keeps the observed current login inside the 12 h guard (#123)", () => {
  const dir = home();
  try {
    const HOUR = 3_600_000;
    let time = 10_000_000;
    const now = () => time;
    const observed = new ObservedClaudeCodeAuth();
    observed.observe(["authorization", "Bearer current-token"], time);
    const current = new ClaudeCodeAuthStore(undefined, { observed, home: dir, env: {}, now });
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });

    // The last un-routed request is the observation above; from now on the pool answers on it.
    for (let hour = 1; hour <= 13; hour += 1) {
      time += HOUR;
      const credential = pool.peekCredentials().find((candidate) => candidate.ownerId === "current");
      assert.ok(credential, `the current login is still listed after ${hour} h of routed use`);
      pool.noteAnswer(credential.id, 429);
    }
    assert.equal(current.describeSource(), "observed");
    assert.equal(pool.peekCredentials()[0]?.headers.authorization, "Bearer current-token");

    // Without any evidence for 12 h it is dropped, as before.
    time += 13 * HOUR;
    assert.equal(current.describeSource(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a 401 drops the observed current login and the same dead token is not readopted (#123)", () => {
  const dir = home();
  try {
    let time = 10_000_000;
    const now = () => time;
    const observed = new ObservedClaudeCodeAuth();
    observed.observe(["authorization", "Bearer current-token"], time);
    const current = new ClaudeCodeAuthStore(undefined, { observed, home: dir, env: {}, now });
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    const credential = pool.peekCredentials()[0]!;
    assert.equal(credential.ownerId, "current");

    time += 1_000;
    pool.noteAnswer(credential.id, 401);
    assert.equal(current.describeSource(), null);
    assert.deepEqual(pool.peekCredentials(), []);

    // The client has not signed in again and keeps presenting the rejected token: not adopted.
    observed.observe(["authorization", "Bearer current-token"], time);
    assert.equal(current.describeSource(), null);
    assert.deepEqual(pool.peekCredentials(), []);

    // A different token is a new login and becomes the current one again.
    observed.observe(["authorization", "Bearer fresh-token"], time);
    assert.equal(current.describeSource(), "observed");
    assert.equal(pool.peekCredentials()[0]?.headers.authorization, "Bearer fresh-token");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The audit's defect 4 (2026-11-07): Claude ids carry a token-generation digest and the pool keyed
// health by id, so a refresh during a 5h/7d rest produced a fresh id with no cooldown and spent an
// account whose window was still gone. Health now counts a rest against the account; a quarantine
// still belongs to the generation that earned it (2026-09-20).
test("a token refresh keeps a resting account's cooldown, and a re-login starts unquarantined", () => {
  const dir = home();
  try {
    const HOUR = 3_600_000;
    let time = 1_000_000;
    const now = () => time;
    const account = saveClaudeOAuthAccount(dir, { accessToken: "first-access", refreshToken: "first-refresh", expiresAt: 99_000_000, accountId: "same" });
    const accounts = new ClaudeAccountAuthPool({ home: dir, now, current: noCurrent(dir, now), log: log().logger });
    const pool = new CredentialPool({ now });

    const first = pool.pick("claude", accounts.peekCredentials(), "conversation")!;
    assert.match(first.id, new RegExp(`^${account.id}:`));
    pool.penalise("claude", first.id, 429, 5 * HOUR);
    assert.equal(pool.hasUsable("claude", accounts.peekCredentials()), false, "the 5 h window rest holds the account");

    // A refresh is a new runtime generation of the same account, not a healthy credential.
    assert.equal(replaceClaudeOAuthAccount(dir, account.id, "first-refresh", { accessToken: "second-access", refreshToken: "second-refresh", expiresAt: 99_000_000 }), true);
    const refreshed = accounts.peekCredentials()[0]!;
    assert.notEqual(refreshed.id, first.id);
    assert.equal(pool.hasUsable("claude", accounts.peekCredentials()), false, "the rest survives the refresh");
    assert.deepEqual(pool.report("claude", accounts.peekCredentials()).map((row) => row.state), ["cooling"]);
    assert.equal(pool.report("claude", accounts.peekCredentials())[0]?.cooldownSeconds, 5 * 60 * 60);

    // The rest ends at its reset, and only then is the refreshed generation in rotation.
    time += 5 * HOUR;
    assert.equal(pool.hasUsable("claude", accounts.peekCredentials()), true);

    // A 401 parks the exact token generation; the next sign-in must not inherit it.
    pool.penalise("claude", refreshed.id, 401);
    assert.equal(pool.hasUsable("claude", accounts.peekCredentials()), false);
    assert.equal(replaceClaudeOAuthAccount(dir, account.id, "second-refresh", { accessToken: "third-access", refreshToken: "third-refresh", expiresAt: 99_000_000 }), true);
    const relogged = accounts.peekCredentials()[0]!;
    assert.notEqual(relogged.id, refreshed.id);
    assert.equal(pool.hasUsable("claude", accounts.peekCredentials()), true, "a fresh token is not the refused one");
    assert.deepEqual(pool.report("claude", accounts.peekCredentials()).map((row) => row.state), ["ready"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The audit's defect (2026-11-07): every generation of the app's own login is named `current`, so
// the first account's spent window moved onto whoever signed in next. The rest now names the
// login's own account (Claude Code's `oauthAccount` uuid, read locally), which a token refresh keeps
// and an account switch changes.
test("switching the app's own login does not carry the old account's rest onto the new one", () => {
  const dir = home();
  try {
    const HOUR = 3_600_000;
    const now = () => 1_000_000;
    let login = "account-a";
    const observed = new ObservedClaudeCodeAuth();
    observed.observe(["authorization", "Bearer token-a"], now());
    const current = new ClaudeCodeAuthStore(undefined, { observed, home: dir, env: {}, now });
    const accounts = new ClaudeAccountAuthPool({ home: dir, now, current, loginKey: () => login, log: log().logger });
    const pool = new CredentialPool({ now });

    const a = pool.pick("claude", accounts.peekCredentials())!;
    assert.equal(a.ownerId, "current", "the app login keeps its display owner");
    pool.penalise("claude", a.id, 429, 5 * HOUR);
    assert.equal(pool.hasUsable("claude", accounts.peekCredentials()), false, "the spent window rests the login");

    // A token refresh is the same account: the rest stays.
    observed.observe(["authorization", "Bearer token-a2"], now());
    const refreshed = accounts.peekCredentials()[0]!;
    assert.notEqual(refreshed.id, a.id);
    assert.equal(pool.hasUsable("claude", accounts.peekCredentials()), false, "a refresh keeps the rest");

    // Signing in as another account is not that account's rest.
    login = "account-b";
    observed.observe(["authorization", "Bearer token-b"], now());
    const b = accounts.peekCredentials()[0]!;
    assert.notEqual(b.id, refreshed.id);
    assert.equal(pool.hasUsable("claude", accounts.peekCredentials()), true, "the new login is not cooling from the old one's rest");

    // Going back to the first account finds its rest still there.
    login = "account-a";
    observed.observe(["authorization", "Bearer token-a3"], now());
    assert.equal(pool.hasUsable("claude", accounts.peekCredentials()), false, "the first account is still resting");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a 401 from an old runtime generation cannot quarantine a refreshed grant", () => {  const dir = home();
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
