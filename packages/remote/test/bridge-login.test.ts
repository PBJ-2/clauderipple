// This Mac's Claude login expiring is one state of the host, not an error per request: on
// 2026-10-15 the host logged "[desktop state] 이 컴퓨터의 Claude 로그인이 만료되었습니다…" every few
// seconds per Claude app session, and read the keychain (a child process) for every one of them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sessions } from "../src/sessions.ts";
import { AUTH_REREAD_MS, BridgeAuthError, BridgeClient, LOGIN_EXPIRED, LOGIN_REFUSED } from "../src/bridge-client.ts";
import type { BridgeAuth } from "../src/bridge-client.ts";
import { PermissionQueue } from "../src/permissions.ts";
import type { DesktopProcess } from "../src/desktop.ts";
import { environmentSession } from "./bridge-fixture.ts";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const tick = () => new Promise(resolve => setImmediate(resolve));
const line = (value: unknown) => JSON.stringify(value) + "\n";

test("an expired login reads the keychain at most every 30 s, and says so as a login problem", async () => {
  let now = 1_000_000, reads = 0, calls = 0;
  let stored: BridgeAuth = { accessToken: "old", organizationUuid: "org", expiresAt: now - 1 };
  const client = new BridgeClient({ now: () => now, auth: () => { reads++; return stored; }, fetch: async () => { calls++; return Response.json({ worker_status: "idle" }); } });
  for (let i = 0; i < 10; i++) {
    await assert.rejects(client.session("bridge"), (e: Error) => e instanceof BridgeAuthError && e.message === LOGIN_EXPIRED);
    now += 1000;
  }
  assert.equal(reads, 1, "one keychain read for ten requests within 30 s");
  assert.equal(calls, 0, "nothing is sent with an expired token");
  // Claude Code refreshed the token; it is picked up on the next read.
  stored = { accessToken: "new", organizationUuid: "org", expiresAt: now + 3_600_000 };
  now += AUTH_REREAD_MS;
  assert.deepEqual(await client.session("bridge"), { worker_status: "idle" });
  assert.equal(reads, 2);
});

test("a 401 is a login problem; the refused token is not sent again until the keychain is reread", async () => {
  let now = 1_000_000, reads = 0, calls = 0;
  const client = new BridgeClient({ now: () => now, auth: () => { reads++; return { accessToken: "t", organizationUuid: "org", expiresAt: now + 3_600_000 }; },
    fetch: async () => { calls++; return new Response("", { status: 401 }); } });
  await assert.rejects(client.session("bridge"), (e: Error) => e instanceof BridgeAuthError && e.message === LOGIN_REFUSED);
  for (let i = 0; i < 5; i++) { now += 1000; await assert.rejects(client.session("bridge"), (e: Error) => e instanceof BridgeAuthError); }
  assert.equal(calls, 1, "one refused request, not one per poll");
  assert.equal(reads, 1);
  now += AUTH_REREAD_MS;
  await assert.rejects(client.session("bridge"), BridgeAuthError);
  assert.equal(reads, 2, "read again after 30 s");
  assert.equal(calls, 2);
});

// A login that cannot be read at all (no keychain item, unreadable account) used to be asked for
// on every request: the first read left no login cached, and that forced the next read. Twenty
// polls at one moment meant twenty keychain child processes, and none of them was throttled.
test("a login that cannot be read is read once per 30 s, and each request is given that same error", async () => {
  let now = 1_000_000, reads = 0, calls = 0;
  const failure = new BridgeAuthError("이 컴퓨터의 Claude 로그인 정보를 읽을 수 없습니다.");
  const same = (error: unknown) => error === failure;
  const client = new BridgeClient({ now: () => now, auth: () => { reads++; throw failure; }, fetch: async () => { calls++; return Response.json({ worker_status: "idle" }); } });
  for (const result of await Promise.allSettled(Array.from({ length: 20 }, () => client.session("bridge")))) {
    assert.ok(result.status === "rejected" && same(result.reason), "every one meets the read's own error");
  }
  assert.equal(reads, 1, "twenty sessions at one moment are one failed read");
  for (let i = 0; i < 10; i++) { now += 2000; await assert.rejects(client.session("bridge"), same); }
  assert.equal(reads, 1, "no second read inside the window");
  assert.equal(calls, 0, "nothing is sent without a login");
  now += AUTH_REREAD_MS;
  await assert.rejects(client.session("bridge"), same);
  assert.equal(reads, 2, "read again once the window is up");
});

test("a failed read recovers at the next read 30 s later, and the new login is reused", async () => {
  let now = 1_000_000, reads = 0;
  let stored: BridgeAuth | null = null;
  const failure = new BridgeAuthError(LOGIN_EXPIRED);
  const client = new BridgeClient({ now: () => now, auth: () => { reads++; if (!stored) throw failure; return stored; },
    fetch: async (url, options) => { assert.equal(new Headers(options?.headers).get("authorization"), "Bearer fresh"); return Response.json({ worker_status: "idle" }); } });
  await assert.rejects(client.session("bridge"), error => error === failure);
  stored = { accessToken: "fresh", organizationUuid: "org", expiresAt: now + 3_600_000 };
  now += AUTH_REREAD_MS - 1;
  await assert.rejects(client.session("bridge"), error => error === failure);
  assert.equal(reads, 1, "a login written sooner is not seen before the window is up");
  now += 1;
  assert.deepEqual(await client.session("bridge"), { worker_status: "idle" });
  assert.equal(reads, 2);
  for (let i = 0; i < 5; i++) await client.session("bridge");
  assert.equal(reads, 2, "the fresh login is reused while it is good");
});

test("a usable login is read once and reused for every request", async () => {
  let now = 1_000_000, reads = 0, calls = 0;
  const client = new BridgeClient({ now: () => now, auth: () => { reads++; return { accessToken: "good", organizationUuid: "org", expiresAt: now + 3_600_000 }; },
    fetch: async () => { calls++; return Response.json({ worker_status: "idle" }); } });
  await Promise.all(Array.from({ length: 20 }, () => client.session("bridge")));
  now += 60_000;
  await client.session("bridge");
  assert.equal(reads, 1, "one read, not one per request");
  assert.equal(calls, 21, "but every request is sent");
});

test("a 401 whose read is 30 s old reads the login again at the next request, not 30 s later", async () => {
  let now = 1_000_000, reads = 0, calls = 0, status = 200;
  const client = new BridgeClient({ now: () => now, auth: () => { reads++; return { accessToken: `token-${reads}`, organizationUuid: "org", expiresAt: now + 3_600_000 }; },
    fetch: async () => { calls++; return status === 200 ? Response.json({ worker_status: "idle" }) : new Response("", { status }); } });
  await client.session("bridge");
  now += AUTH_REREAD_MS;
  status = 401;
  await assert.rejects(client.session("bridge"), (error: Error) => error instanceof BridgeAuthError && error.message === LOGIN_REFUSED);
  assert.equal(reads, 1, "the refused token is not read again inside the request that was refused");
  status = 200;
  assert.deepEqual(await client.session("bridge"), { worker_status: "idle" });
  assert.equal(reads, 2, "the next request reads the login at once");
  assert.equal(calls, 3);
});

function fixture(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-login-test-"));
  const projects = path.join(root, "projects");
  fs.mkdirSync(path.join(projects, "project"), { recursive: true });
  fs.writeFileSync(path.join(projects, "project", `${id}.jsonl`), line({ type: "user", uuid: "old", cwd: root, message: { content: "old prompt" } }));
  const registry = new Map<string, DesktopProcess>([[id, { sessionId: id, pid: 42, status: "idle", bridgeSessionId: "bridge" }]]);
  let now = Date.now();
  let expired = true;
  const logs: string[] = [];
  const problems: (string | null)[] = [];
  const client = new BridgeClient({
    now: () => now,
    auth: () => ({ accessToken: "private-token", organizationUuid: "org", expiresAt: expired ? now - 1 : now + 3_600_000 }),
    fetch: async (url, options) => {
      if (options?.method === "POST") return new Response("{}");
      if (String(url).endsWith("/sessions/bridge")) return Response.json({ worker_status: "idle" });
      if (String(url).includes("/events?")) return Response.json({ data: [] });
      return new Response(new ReadableStream<Uint8Array>({ start(c) { options?.signal?.addEventListener("abort", () => { try { c.close(); } catch { /* closed */ } }, { once: true }); } }));
    },
  });
  const sessions = new Sessions({ now: () => now, log: l => logs.push(l), dir: path.join(root, "host"), desktopProjects: projects, desktopRegistry: () => registry, desktopProcesses: () => "", bridgeClient: client,
    permissions: PermissionQueue.open(path.join(root, "permissions.json")),
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } },
    queryFn: () => { throw new Error("must not spawn SDK"); }, onEvent() {}, onSessions() {}, onDesktopProblem: p => problems.push(p) });
  t.after(async () => { sessions.shutdown(); await tick(); fs.rmSync(root, { recursive: true, force: true }); });
  return { sessions, logs, problems, advance: (ms: number) => { now += ms; }, refresh: () => { expired = false; } };
}

test("an expired login is logged once and told to phones once, and its end too", async t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) { await f.sessions.pollDesktop(); await tick(); f.advance(3000); }
  assert.deepEqual(f.logs.filter(l => l.includes("로그인")), [`[desktop] Claude app sessions cannot be reached: ${LOGIN_EXPIRED}`]);
  assert.deepEqual(f.problems, [LOGIN_EXPIRED]);
  assert.equal(f.sessions.desktopProblem(), LOGIN_EXPIRED);
  // A send to a session Ripple created in a Remote Control environment (the one kind whose bridge post still
  // runs) fails with that reason, which the phone shows.
  f.sessions.log(id);
  environmentSession(f, id);
  await assert.rejects(Promise.resolve(f.sessions.send(id, "phone-msg-1", "hello")), new RegExp(LOGIN_EXPIRED.slice(0, 20)));
  f.refresh();
  f.advance(31_000);
  await f.sessions.pollDesktop();
  await tick();
  assert.deepEqual(f.problems, [LOGIN_EXPIRED, null]);
  assert.ok(f.logs.includes("[desktop] Claude app sessions answer again"));
  assert.equal(f.sessions.desktopProblem(), null);
});

// 2026-10-20: the CLI's keychain login was emptied while the Claude app worked, and the phone said
// the login had expired. The login the router saw the app use stands in for it.
test("the Claude app's login the router observed stands in for the CLI's, while it is recent", async () => {
  const { loadObservedAuth, OBSERVED_FRESH_MS, OBSERVED_TTL_MS } = await import("../src/bridge-client.ts");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "observed-auth-"));
  const now = 5_000_000_000;
  assert.equal(loadObservedAuth(now, home), null, "no file, no login");
  const write = (value: unknown) => fs.writeFileSync(path.join(home, "claude-auth-observed.json"), JSON.stringify(value));
  write({ authorization: "Bearer sk-ant-oat01-abc", observedAt: now - 60_000 });
  assert.deepEqual(loadObservedAuth(now, home), { accessToken: "sk-ant-oat01-abc", expiresAt: now + OBSERVED_TTL_MS });
  write({ authorization: "Bearer sk-ant-oat01-abc", observedAt: now - OBSERVED_FRESH_MS - 1 });
  assert.equal(loadObservedAuth(now, home), null, "too old to trust");
  write({ authorization: "Basic xyz", observedAt: now });
  assert.equal(loadObservedAuth(now, home), null, "not a bearer token");
  fs.writeFileSync(path.join(home, "claude-auth-observed.json"), "{ not json");
  assert.equal(loadObservedAuth(now, home), null, "unreadable");
  fs.rmSync(home, { recursive: true, force: true });
});
