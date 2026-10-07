import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findGrokCli, GROK_CLIENT_VERSION_FALLBACK, GrokAuth, GrokAuthError, grokAuthPath, readGrokToken, type RunCli } from "../src/providers/grok/auth.ts";

const HOUR = 3600_000;
const NOW = Date.parse("2026-10-08T12:00:00Z");
const quiet = { info: () => {}, warn: () => {} };
const GROK_BIN = process.platform === "win32" ? "grok.exe" : "grok";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cr-grok-"));
}

/** The shape `grok login` writes (CLI 1.0.46): issuer-prefixed keys, RFC 3339 expiry. */
function writeAuth(dir: string, entries: Record<string, { key: string; expiresAt: number; email?: string }>): void {
  const doc = Object.fromEntries(Object.entries(entries).map(([name, e]) => [name, {
    key: e.key,
    expires_at: new Date(e.expiresAt).toISOString(),
    refresh_token: `refresh-${e.key}`,
    auth_mode: "oidc",
    ...(e.email ? { email: e.email } : {}),
  }]));
  fs.writeFileSync(grokAuthPath(dir), JSON.stringify(doc));
}

/** A fake CLI: records every run and, for `models`, plays the CLI's refresh by rewriting the file. */
function fakeCli(dir: string, onRefresh?: () => void) {
  const runs: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: RunCli = async (_file, args, env) => {
    runs.push({ args, env });
    if (args[0] === "--version") return "grok 1.0.52 (abc123) [stable]\n";
    await new Promise((resolve) => setTimeout(resolve, 20));
    onRefresh?.();
    return "grok-4.7\n";
  };
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, GROK_BIN), "#!/bin/sh\n", { mode: 0o755 });
  return { runs, run };
}

test("readGrokToken takes the entry that expires last and assumes no key name", () => {
  const dir = home();
  writeAuth(dir, {
    "https://auth.x.ai::old": { key: "tok-old", expiresAt: NOW + HOUR },
    "https://accounts.x.ai/sign-in": { key: "tok-new", expiresAt: NOW + 5 * HOUR, email: "a@example.com" },
  });
  assert.deepEqual(readGrokToken(grokAuthPath(dir)), { key: "tok-new", expiresAt: NOW + 5 * HOUR, email: "a@example.com" });
  fs.writeFileSync(grokAuthPath(dir), "{not json");
  assert.equal(readGrokToken(grokAuthPath(dir)), null);
  assert.equal(readGrokToken(path.join(dir, "missing.json")), null);
});

test("a token with time left is used as it is, and the CLI is not run", async () => {
  const dir = home();
  writeAuth(dir, { "https://auth.x.ai::a": { key: "tok-a", expiresAt: NOW + 5 * HOUR } });
  const cli = fakeCli(dir);
  const auth = new GrokAuth({ home: dir, log: quiet, run: cli.run, now: () => NOW, env: {} });
  assert.equal((await auth.token()).key, "tok-a");
  assert.equal(cli.runs.length, 0);
});

test("a token near its end is refreshed by the CLI, once for any number of concurrent turns", async () => {
  const dir = home();
  writeAuth(dir, { "https://auth.x.ai::a": { key: "tok-a", expiresAt: NOW + 5 * 60_000 } });
  const cli = fakeCli(dir, () => writeAuth(dir, { "https://auth.x.ai::a": { key: "tok-b", expiresAt: NOW + 6 * HOUR } }));
  const auth = new GrokAuth({ home: dir, log: quiet, run: cli.run, now: () => NOW, env: {} });
  const tokens = await Promise.all([auth.token(), auth.token(), auth.token()]);
  assert.deepEqual(tokens.map((t) => t.key), ["tok-b", "tok-b", "tok-b"]);
  assert.equal(cli.runs.length, 1, "one CLI run serves every waiting turn");
  assert.deepEqual(cli.runs[0]!.args, ["models"]);
  // The CLI is told the same threshold the router used, so it agrees the token is due.
  assert.equal(cli.runs[0]!.env.GROK_AUTH_EARLY_INVALIDATION_SECS, "600");
  // A home that is not the CLI's default reaches it as GROK_HOME.
  assert.equal(cli.runs[0]!.env.GROK_HOME, dir);
});

test("a token close to its end is still used when the CLI cannot refresh it, and the CLI is not asked every turn", async () => {
  const dir = home();
  writeAuth(dir, { "https://auth.x.ai::a": { key: "tok-a", expiresAt: NOW + 5 * 60_000 } });
  let runs = 0;
  const failing: RunCli = async () => { runs += 1; throw new Error("network down"); };
  fakeCli(dir);
  let clock = NOW;
  const auth = new GrokAuth({ home: dir, log: quiet, run: failing, now: () => clock, env: {} });
  assert.equal((await auth.token()).key, "tok-a");
  clock += 10_000;
  assert.equal((await auth.token()).key, "tok-a");
  assert.equal(runs, 1, "a refresh that just failed is not run again for the next turn");
  clock += 60_000;
  assert.equal((await auth.token()).key, "tok-a");
  assert.equal(runs, 2);
});

test("an expired session the CLI cannot refresh, or none at all, is an error naming grok login", async () => {
  const dir = home();
  writeAuth(dir, { "https://auth.x.ai::a": { key: "tok-a", expiresAt: NOW - 60_000 } });
  const cli = fakeCli(dir);
  const auth = new GrokAuth({ home: dir, log: quiet, run: cli.run, now: () => NOW, env: {} });
  await assert.rejects(auth.token(), (error: Error) => error instanceof GrokAuthError && /expired/.test(error.message) && /grok login/.test(error.message));

  const empty = home();
  const none = new GrokAuth({ home: empty, log: quiet, run: cli.run, now: () => NOW, env: {} });
  await assert.rejects(none.token(), (error: Error) => error instanceof GrokAuthError && /no Grok session/.test(error.message));
});

test("after a 401 a token the CLI already rotated is taken without running it", async () => {
  const dir = home();
  writeAuth(dir, { "https://auth.x.ai::a": { key: "tok-a", expiresAt: NOW + 5 * HOUR } });
  const cli = fakeCli(dir);
  const auth = new GrokAuth({ home: dir, log: quiet, run: cli.run, now: () => NOW, env: {} });
  assert.equal((await auth.token()).key, "tok-a");
  // Same size, new content: the cache must notice the mtime, not only the length.
  const later = new Date(Date.now() + 5_000);
  writeAuth(dir, { "https://auth.x.ai::a": { key: "tok-b", expiresAt: NOW + 6 * HOUR } });
  fs.utimesSync(grokAuthPath(dir), later, later);
  assert.equal(await auth.rejected("tok-a"), true);
  assert.equal(cli.runs.length, 0);
});

test("after a 401 on the file's own token the CLI refresh is forced, and a refusal it cannot fix stays one", async () => {
  const dir = home();
  writeAuth(dir, { "https://auth.x.ai::a": { key: "tok-a", expiresAt: NOW + 5 * HOUR } });
  const rotating = fakeCli(dir, () => writeAuth(dir, { "https://auth.x.ai::a": { key: "tok-b", expiresAt: NOW + 6 * HOUR } }));
  const auth = new GrokAuth({ home: dir, log: quiet, run: rotating.run, now: () => NOW, env: {} });
  assert.equal(await auth.rejected("tok-a"), true);
  assert.equal(Number(rotating.runs[0]!.env.GROK_AUTH_EARLY_INVALIDATION_SECS) > 6 * 3600, true, "forced past any token lifetime");

  const stuck = fakeCli(dir);
  let clock = NOW;
  const auth2 = new GrokAuth({ home: dir, log: quiet, run: stuck.run, now: () => clock, env: {} });
  assert.equal(await auth2.rejected("tok-b"), false);
  // Refused again right away: the account is being refused, not the token, so the grant is left alone.
  clock += 10_000;
  assert.equal(await auth2.rejected("tok-b"), false);
  assert.equal(stuck.runs.filter((r) => r.args[0] === "models").length, 1);
  clock += 60_000;
  assert.equal(await auth2.rejected("tok-b"), false);
  assert.equal(stuck.runs.filter((r) => r.args[0] === "models").length, 2);
});

test("the client version is the installed CLI's, asked once per binary, with a fallback", async () => {
  const dir = home();
  const cli = fakeCli(dir);
  const auth = new GrokAuth({ home: dir, log: quiet, run: cli.run, now: () => NOW, env: {} });
  assert.equal(await auth.clientVersion(), "1.0.52");
  assert.equal(await auth.clientVersion(), "1.0.52");
  assert.equal(cli.runs.filter((r) => r.args[0] === "--version").length, 1);

  const pinned = new GrokAuth({ home: dir, clientVersion: "9.9.9", log: quiet, run: cli.run, now: () => NOW, env: {} });
  assert.equal(await pinned.clientVersion(), "9.9.9");

  const bare = home();
  const missing = new GrokAuth({ home: bare, log: quiet, run: cli.run, now: () => NOW, env: { PATH: "", HOME: bare } });
  assert.equal(await missing.clientVersion(), GROK_CLIENT_VERSION_FALLBACK);
});

test("findGrokCli looks in the CLI's own bin before PATH, and honours an explicit path only if it runs", () => {
  const dir = home();
  assert.equal(findGrokCli(dir, undefined, { PATH: "", HOME: dir }), null);
  fakeCli(dir);
  assert.equal(findGrokCli(dir, undefined, { PATH: "", HOME: dir }), path.join(dir, "bin", GROK_BIN));
  assert.equal(findGrokCli(dir, path.join(dir, "nope"), { PATH: "", HOME: dir }), null);
});
