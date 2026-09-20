// The Claude subscription sign-in: PKCE authorize URL, loopback callback, pasted code, token
// exchange, storage, and refresh. The token endpoint is a stub; nothing here reaches Anthropic.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { CLAUDE_OAUTH, ClaudeOAuthSession, refreshClaudeOAuth } from "../src/providers/claude-oauth.ts";
import { claudeAccountsPath, readClaudeAccountsFile } from "../src/providers/anthropic-accounts.ts";
import { readClaudeAuthFile, saveClaudeOAuthFile } from "../src/providers/anthropic-token-file.ts";
import { ClaudeCodeAuthStore, ClaudeCodeCredentialStore } from "../src/providers/anthropic.ts";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** A token endpoint that records what it was asked and answers a grant. */
function tokenEndpoint(reply: Record<string, unknown> = { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }, status = 200) {
  const calls: Record<string, unknown>[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    assert.equal(url, CLAUDE_OAUTH.tokenUrl);
    calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

test("the authorize URL carries a PKCE challenge, and the loopback callback completes the exchange", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-oauth-"));
  const port = await freePort();
  const endpoint = tokenEndpoint();
  const session = new ClaudeOAuthSession({ home, port, fetch: endpoint.fetchImpl, now: () => 1_000_000 });
  const { url, manual } = await session.start();
  assert.equal(manual, false);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, CLAUDE_OAUTH.authorizeUrl);
  assert.equal(u.searchParams.get("client_id"), CLAUDE_OAUTH.clientId);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(session.port, port);
  assert.equal(u.searchParams.get("redirect_uri"), `http://localhost:${port}${CLAUDE_OAUTH.callbackPath}`);
  assert.equal(u.searchParams.get("scope"), CLAUDE_OAUTH.scope);
  const state = u.searchParams.get("state")!;
  assert.ok(state.length >= 16);

  // A wrong state is refused and does not end the attempt.
  const bad = await fetch(`http://127.0.0.1:${port}${CLAUDE_OAUTH.callbackPath}?code=x&state=other`);
  assert.equal(bad.status, 400);
  assert.equal(session.snapshot.running, true);

  const good = await fetch(`http://127.0.0.1:${port}${CLAUDE_OAUTH.callbackPath}?code=the-code&state=${state}`);
  assert.equal(good.status, 200);
  await session.result;
  assert.equal(session.snapshot.ok, true);
  const exchange = endpoint.calls[0]!;
  assert.equal(exchange.grant_type, "authorization_code");
  assert.equal(exchange.code, "the-code");
  assert.equal(exchange.state, state);
  assert.equal(exchange.redirect_uri, `http://localhost:${port}${CLAUDE_OAUTH.callbackPath}`);
  assert.equal(exchange.client_id, CLAUDE_OAUTH.clientId);
  // The verifier hashes to the challenge that was sent.
  const challenge = crypto.createHash("sha256").update(String(exchange.code_verifier)).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(challenge, u.searchParams.get("code_challenge"));

  const [stored] = readClaudeAccountsFile(home);
  assert.ok(stored);
  assert.equal(stored.token, "at-1");
  assert.equal(stored.refreshToken, "rt-1");
  assert.equal(stored.expiresAt, 1_000_000 + 3600_000);
  assert.equal(session.snapshot.account?.id, stored.id);
  assert.doesNotMatch(JSON.stringify(session.snapshot), /at-1|rt-1/);
  assert.equal(fs.statSync(claudeAccountsPath(home)).mode & 0o777, 0o600);
  // The listener is gone: the port is free again.
  const again = await new Promise<boolean>((r) => {
    const s = net.createServer();
    s.once("error", () => r(false));
    s.listen(port, "127.0.0.1", () => s.close(() => r(true)));
  });
  assert.equal(again, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a taken preferred port falls back to a random loopback port before manual mode", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-oauth-"));
  const taken = net.createServer();
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
  const port = (taken.address() as net.AddressInfo).port;
  const session = new ClaudeOAuthSession({ home, port, fetch: tokenEndpoint().fetchImpl });
  const { url, manual } = await session.start();
  assert.equal(manual, false);
  assert.ok(session.port && session.port !== port);
  assert.equal(new URL(url).searchParams.get("redirect_uri"), `http://localhost:${session.port}${CLAUDE_OAUTH.callbackPath}`);
  session.cancel();
  await assert.rejects(session.result, /cancelled/);
  await new Promise<void>((r) => taken.close(() => r()));
  fs.rmSync(home, { recursive: true, force: true });
});

test("manual mode uses the paste-the-code page and accepts code#state or the redirect URL", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-oauth-"));
  const endpoint = tokenEndpoint();
  const session = new ClaudeOAuthSession({ home, manual: true, fetch: endpoint.fetchImpl });
  const { url, manual } = await session.start();
  assert.equal(manual, true);
  const state = new URL(url).searchParams.get("state")!;
  assert.equal(new URL(url).searchParams.get("redirect_uri"), CLAUDE_OAUTH.manualRedirectUri);
  await session.submitCode(`pasted-code#${state}`);
  await session.result;
  assert.equal(endpoint.calls[0]!.code, "pasted-code");
  assert.equal(endpoint.calls[0]!.redirect_uri, CLAUDE_OAUTH.manualRedirectUri);

  const other = new ClaudeOAuthSession({ home, manual: true, fetch: endpoint.fetchImpl });
  const started = await other.start();
  await other.submitCode(`https://console.anthropic.com/oauth/code/callback?code=url-code&state=${new URL(started.url).searchParams.get("state")}`);
  await other.result;
  assert.equal(endpoint.calls[1]!.code, "url-code");

  const wrong = new ClaudeOAuthSession({ home, manual: true, fetch: endpoint.fetchImpl });
  await wrong.start();
  await wrong.submitCode("code#not-my-state");
  await assert.rejects(wrong.result, /different sign-in attempt/);
  assert.equal(wrong.snapshot.ok, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("overlapping code submissions exchange and store exactly once", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-oauth-"));
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = async (): Promise<Response> => {
    calls += 1;
    await held;
    return new Response(JSON.stringify({ access_token: "one-access", refresh_token: "one-refresh", expires_in: 3600 }), { status: 200 });
  };
  const session = new ClaudeOAuthSession({ home, manual: true, fetch: fetchImpl });
  await session.start();
  const first = session.submitCode("first");
  const second = session.submitCode("second");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second, session.result]);
  assert.equal(readClaudeAccountsFile(home).length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a refused exchange fails the attempt with the endpoint's reason", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-oauth-"));
  const endpoint = tokenEndpoint({ error: "invalid_grant", error_description: "code already used" }, 400);
  const session = new ClaudeOAuthSession({ home, manual: true, fetch: endpoint.fetchImpl });
  await session.start();
  await session.submitCode("x");
  await assert.rejects(session.result, /code already used/);
  assert.equal(readClaudeAuthFile(home), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test("token endpoint errors cannot echo authorization or refresh secrets", async () => {
  const refreshSecret = "refresh-secret-that-must-not-escape";
  const endpoint = tokenEndpoint({
    error: "invalid_grant",
    error_description: `refresh_token=${refreshSecret}\nBearer reflected-secret-value`,
  }, 400);
  await assert.rejects(
    refreshClaudeOAuth(refreshSecret, { fetch: endpoint.fetchImpl }),
    (error: Error) => {
      assert.doesNotMatch(error.message, new RegExp(refreshSecret));
      assert.doesNotMatch(error.message, /reflected-secret-value/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, /\n/);
      return true;
    },
  );
});

test("the auth store refreshes our OAuth grant before it expires, once, and reports expiry after a failed refresh", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-oauth-"));
  let now = 10_000_000;
  saveClaudeOAuthFile(home, { accessToken: "old", refreshToken: "rt-old", expiresAt: now + 60_000 });
  const missing = new ClaudeCodeCredentialStore(() => null, () => now);
  const endpoint = tokenEndpoint({ access_token: "new", refresh_token: "rt-new", expires_in: 7200 });
  const lines: string[] = [];
  const store = new ClaudeCodeAuthStore(missing, { home, env: {}, now: () => now, fetch: endpoint.fetchImpl, log: (l) => lines.push(l) });
  // Still valid but within the refresh lead: one refresh for two concurrent callers.
  await Promise.all([store.refreshIfNeeded(), store.refreshIfNeeded()]);
  assert.equal(endpoint.calls.length, 1);
  assert.equal(endpoint.calls[0]!.grant_type, "refresh_token");
  assert.equal(endpoint.calls[0]!.refresh_token, "rt-old");
  assert.equal(endpoint.calls[0]!.scope, CLAUDE_OAUTH.refreshScope);
  const auth = store.get();
  assert.ok(!(auth instanceof Error) && auth.source === "token-file");
  assert.equal(auth.credentials.accessToken, "new");
  assert.equal(readClaudeAuthFile(home)!.source === "oauth" && readClaudeAuthFile(home)!.token, "new");
  // Fresh: no call.
  await store.refreshIfNeeded();
  assert.equal(endpoint.calls.length, 1);

  // Expired and the refresh is refused: get() says so instead of sending a dead token.
  now += 7200_000 + 1;
  const refused = tokenEndpoint({ error: "invalid_grant" }, 400);
  const store2 = new ClaudeCodeAuthStore(missing, { home, env: {}, now: () => now, fetch: refused.fetchImpl, log: (l) => lines.push(l) });
  await store2.refreshIfNeeded();
  assert.match(store2.get() instanceof Error ? (store2.get() as Error).message : "", /expired/);
  assert.ok(lines.some((l) => /refresh failed/.test(l)));
  assert.ok(!lines.some((l) => /rt-|at-|new|old/.test(l.replace(/refreshed|failed/g, ""))), "no token value in the log");
  fs.rmSync(home, { recursive: true, force: true });
});

test("refreshClaudeOAuth keeps the previous refresh token when the reply omits one", async () => {
  const endpoint = tokenEndpoint({ access_token: "at-2", expires_in: 100 });
  const grant = await refreshClaudeOAuth("rt-keep", { fetch: endpoint.fetchImpl, now: () => 5 });
  assert.deepEqual(grant, { accessToken: "at-2", refreshToken: "rt-keep", expiresAt: 5 + 100_000 });
});
