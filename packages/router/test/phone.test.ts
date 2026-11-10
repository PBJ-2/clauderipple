import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startAdmin } from "../src/admin.ts";
import { DEFAULTS } from "../src/config.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";
import { phoneRequest } from "../src/phone.ts";
import type { PhoneDeps } from "../src/phone.ts";
import { APPROVAL_WAIT_MS } from "../../remote/src/mod-approval.ts";

async function admin(t: import("node:test").TestContext, phone: PhoneDeps) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-phone-admin-"));
  fs.writeFileSync(path.join(home, "host.json"), JSON.stringify({ port: 18797 }));
  fs.writeFileSync(path.join(home, "local.secret"), "s".repeat(43), { mode: 0o600 });
  const server = await startAdmin({
    config: () => ({ ...DEFAULTS, admin: { port: 0 } }), configFile: path.join(home, "config.json"),
    log: new Logger(null, 1_000_000, 1, false), version: "test", health: () => 0,
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    requests: new RequestLog(path.join(home, "requests.jsonl")), phone: { home, ...phone },
  });
  t.after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${server.port}`, home };
}

test("admin proxies only allowed phone routes to the configured loopback port with the secret", async t => {
  const calls: { url: string; method: string; body: string | undefined }[] = [];
  const f = await admin(t, { fetch: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("x-ripple-local"), "s".repeat(43));
    assert.equal(init?.redirect, "error");
    calls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    return Response.json(String(url).endsWith("status") ? { mode: "relay", phones: [] } : String(url).endsWith("pairing") ? { url: "https://relay.example/#pair=secret", svg: "<svg/>" } : { ok: true });
  } });
  const status = await fetch(`${f.base}/api/phone/status`);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(await status.json(), { hostRunning: true, mode: "relay", phones: [] });
  const pair = await fetch(`${f.base}/api/phone/pairing`);
  assert.equal(pair.headers.get("cache-control"), "no-store");
  assert.deepEqual(await pair.json(), { url: "https://relay.example/#pair=secret", svg: "<svg/>" });
  for (const route of ["settings", "rotate"]) assert.equal((await fetch(`${f.base}/api/phone/${route}`, { method: "POST", body: JSON.stringify({ bind: "local" }) })).status, 200);
  assert.deepEqual(calls.map(c => [c.url, c.method]), [["http://127.0.0.1:18797/local/status", "GET"], ["http://127.0.0.1:18797/local/pairing", "GET"], ["http://127.0.0.1:18797/local/settings", "POST"], ["http://127.0.0.1:18797/local/rotate", "POST"]]);
  assert.equal(calls[2]?.body, '{"bind":"local"}');
  for (const route of ["../config", "other", "settings/extra"]) await fetch(`${f.base}/api/phone/${route}`);
  assert.equal(calls.length, 4);
  assert.equal((await fetch(`${f.base}/api/phone/pairing`, { headers: { origin: "https://evil.example" } })).status, 403);
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(`${f.base}/api/phone/pairing`, { headers: { host: "evil.example" } }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(`${f.base}/api/phone/rotate`, { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(calls.length, 4);
});

test("inbox routes validate, forward only their own requests and preserve host responses", async t => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const f = await admin(t, { fetch: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("x-ripple-local"), "s".repeat(43));
    calls.push({ url: String(url), method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    return String(url).endsWith("/claim") ? Response.json({ error: "offer unavailable" }, { status: 409 })
      : Response.json(String(url).includes("/inbox?") ? { offers: [{ sessionId: "a &b", itemId: "one", text: "private", offeredAt: 1 }] } : { ok: true });
  } });
  const list = await fetch(`${f.base}/api/phone-inbox?session=a%20%26b`);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.deepEqual(await list.json(), { offers: [{ sessionId: "a &b", itemId: "one", text: "private", offeredAt: 1 }] });
  const claim = await fetch(`${f.base}/api/phone-inbox/claim`, { method: "POST", body: '{"itemId":"one"}' });
  assert.equal(claim.status, 409);
  assert.deepEqual(await claim.json(), { error: "offer unavailable" });
  const result = await fetch(`${f.base}/api/phone-inbox/result`, { method: "POST", body: '{"itemId":"one","outcome":"submitted"}' });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true });
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:18797/local/inbox?session=a%20%26b", method: "GET" },
    { url: "http://127.0.0.1:18797/local/inbox/claim", method: "POST", body: '{"itemId":"one"}' },
    { url: "http://127.0.0.1:18797/local/inbox/result", method: "POST", body: '{"itemId":"one","outcome":"submitted"}' },
  ]);
  for (const query of ["", "?session=", "?session=a&session=b", `?session=${"x".repeat(201)}`]) assert.equal((await fetch(`${f.base}/api/phone-inbox${query}`)).status, 400);
  for (const [route, body] of [["claim", "{}"], ["claim", '{"itemId":"a/b"}'], ["claim", '{"itemId":"a","extra":1}'], ["result", '{"itemId":"a"}'], ["result", '{"itemId":"a","outcome":"other"}'], ["claim", "x".repeat(4097)]] as const) {
    assert.equal((await fetch(`${f.base}/api/phone-inbox/${route}`, { method: "POST", body })).status, 400);
  }
  assert.equal((await fetch(`${f.base}/api/phone-inbox/claim`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/phone-inbox?session=a`, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(calls.length, 3);
});

test("every inbox route reports an unreachable host", async t => {
  const f = await admin(t, { fetch: async () => { throw new Error("private"); } });
  for (const [route, init] of [["?session=a", {}], ["/claim", { method: "POST", body: '{"itemId":"a"}' }], ["/result", { method: "POST", body: '{"itemId":"a","outcome":"failed"}' }]] as const) {
    const response = await fetch(`${f.base}/api/phone-inbox${route}`, init);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("private"), false);
  }
});

test("settings job routes validate and forward through the authenticated host boundary", async t => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const f = await admin(t, { fetch: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("x-ripple-local"), "s".repeat(43));
    calls.push({ url: String(url), method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    return String(url).endsWith("/claim") ? Response.json({ error: "job unavailable" }, { status: 409 }) : Response.json(String(url).includes("?exclude=") ? { jobs: [] } : { ok: true });
  } });
  const list = await fetch(`${f.base}/api/settings-jobs?exclude=local_helper`);
  assert.equal(list.headers.get("cache-control"), "no-store"); assert.deepEqual(await list.json(), { jobs: [] });
  assert.equal((await fetch(`${f.base}/api/settings-jobs/claim`, { method: "POST", body: '{"jobId":"job-1","helper":"local_helper"}' })).status, 409);
  assert.equal((await fetch(`${f.base}/api/settings-jobs/result`, { method: "POST", body: '{"jobId":"job-1","outcome":"failed","detail":"refused"}' })).status, 200);
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:18797/local/settings-jobs?exclude=local_helper", method: "GET" },
    { url: "http://127.0.0.1:18797/local/settings-jobs/claim", method: "POST", body: '{"jobId":"job-1","helper":"local_helper"}' },
    { url: "http://127.0.0.1:18797/local/settings-jobs/result", method: "POST", body: '{"jobId":"job-1","outcome":"failed","detail":"refused"}' },
  ]);
  for (const query of ["", "?exclude=a%20b", "?exclude=a&exclude=b", `?exclude=${"x".repeat(101)}`]) assert.equal((await fetch(`${f.base}/api/settings-jobs${query}`)).status, 400);
  for (const [route, body] of [["claim", "{}"], ["claim", '{"jobId":"a","helper":"bad/id"}'], ["claim", '{"jobId":"a","helper":"b","extra":1}'], ["result", '{"jobId":"a","outcome":"other"}'], ["result", JSON.stringify({ jobId: "a", outcome: "failed", detail: "x".repeat(1001) })], ["claim", "x".repeat(4097)]] as const) assert.equal((await fetch(`${f.base}/api/settings-jobs/${route}`, { method: "POST", body })).status, 400);
  assert.equal((await fetch(`${f.base}/api/settings-jobs?exclude=a`, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${f.base}/api/settings-jobs/claim`)).status, 404);
  assert.equal(calls.length, 3);
});

test("all settings job routes report a stopped host", async t => {
  const f = await admin(t, { fetch: async () => { throw new Error("private"); } });
  for (const [route, init] of [["?exclude=a", {}], ["/claim", { method: "POST", body: '{"jobId":"a","helper":"b"}' }], ["/result", { method: "POST", body: '{"jobId":"a","outcome":"failed"}' }]] as const) {
    const response = await fetch(`${f.base}/api/settings-jobs${route}`, init);
    assert.equal(response.status, 503); assert.equal((await response.text()).includes("private"), false);
  }
});

test("host-down status gives the install hint; mutations fail without exposing errors or secrets", async t => {
  const f = await admin(t, { fetch: async () => { throw new Error("secret-sensitive transport details"); } });
  assert.deepEqual(await (await fetch(`${f.base}/api/phone/status`)).json(), { hostRunning: false, hint: "clauderipple remote install" });
  assert.equal((await fetch(`${f.base}/api/phone/pairing`)).status, 503);
  assert.equal((await fetch(`${f.base}/api/phone/rotate`, { method: "POST" })).status, 503);
  fs.unlinkSync(path.join(f.home, "local.secret"));
  assert.deepEqual(await (await fetch(`${f.base}/api/phone/status`)).json(), { hostRunning: false, hint: "clauderipple remote install" });
});

test("proxy preserves settings refusals, reports live incompatible hosts, and defaults to port 8797", async t => {
  let status = 400;
  const f = await admin(t, { fetch: async url => {
    assert.equal(new URL(String(url)).port, "8797");
    return Response.json({ error: "never reflect arbitrary upstream credential detail" }, { status });
  } });
  fs.unlinkSync(path.join(f.home, "host.json"));
  assert.equal((await fetch(`${f.base}/api/phone/settings`, { method: "POST", body: "{}" })).status, 400);
  status = 403;
  const denied = await fetch(`${f.base}/api/phone/status`);
  assert.equal(denied.status, 502);
  assert.equal((await denied.text()).includes("credential detail"), false);
  status = 200;
  // The byte limit is enforced before forwarding.
  assert.equal((await fetch(`${f.base}/api/phone/settings`, { method: "POST", body: "x".repeat(4097) })).status, 413);
});

test("phone vocabulary is complete in all six dashboard languages", () => {
  const source = fs.readFileSync(new URL("../../ui/i18n.js", import.meta.url), "utf8");
  const dictionaries = new Function(`${source.slice(0, source.indexOf("const LANGUAGES"))}; return I18N;`)() as Record<string, Record<string, string>>;
  const keys = Object.keys(dictionaries.en!).filter(key => key === "nav.phone" || key.startsWith("phone.")).sort();
  assert.ok(keys.length > 40);
  for (const language of ["ko", "en", "zh", "ja", "es", "pt"]) {
    const dictionary = dictionaries[language]!;
    assert.deepEqual(Object.keys(dictionary).filter(key => key === "nav.phone" || key.startsWith("phone.")).sort(), keys);
    for (const key of keys) assert.ok(dictionary[key]?.trim(), `${language}: ${key}`);
  }
});

test("QR is fetched only on reveal and late responses cannot undo hiding or leaving the view", async () => {
  const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("function hidePhoneQr()"), source.indexOf("function renderPhoneStatus("));
  type Node = { addEventListener(): void };
  type Controls = { showPhoneQr(button: { disabled: boolean }): Promise<void>; hidePhoneQr(): void; busy(value: boolean): void };
  const make = new Function("$", "api", "el", "t", "toast", `let phoneQrGeneration = 0, phoneBusy = false; ${block}; return { showPhoneQr, hidePhoneQr, busy(value) { phoneBusy = value; } };`) as
    (select: (selector: string) => unknown, api: () => Promise<{ url: string; svg: string }>, el: () => Node, t: (key: string) => string, toast: () => void) => Controls;
  let active = true;
  let children: Node[] = [];
  let calls = 0;
  let complete: (pairing: { url: string; svg: string }) => void = () => { throw new Error("no pending fetch"); };
  const controls = make(selector => selector === "#view-phone"
    ? { classList: { contains: () => active } }
    : { replaceChildren: (...nodes: Node[]) => { children = nodes; } },
  () => { calls++; return new Promise(resolve => { complete = resolve; }); },
  () => ({ addEventListener() {} }), key => key, () => assert.fail("unexpected QR error"));
  const button = { disabled: false };
  const pairing = { url: "https://relay.example/#pair=test-only", svg: "<svg/>" };
  assert.equal(calls, 0);
  controls.busy(true);
  await controls.showPhoneQr(button);
  assert.equal(calls, 0);
  controls.busy(false);
  let pending = controls.showPhoneQr(button);
  assert.equal(button.disabled, true);
  controls.hidePhoneQr();
  complete(pairing);
  await pending;
  assert.deepEqual(children, []);
  assert.equal(button.disabled, false);
  pending = controls.showPhoneQr(button);
  active = false;
  complete(pairing);
  await pending;
  assert.deepEqual(children, []);
  active = true;
  pending = controls.showPhoneQr(button);
  complete(pairing);
  await pending;
  assert.equal(children.length, 3);
  controls.hidePhoneQr();
  assert.deepEqual(children, []);
});

test("restart targets only the Mac host job or installs the Windows/Linux host service", async t => {
  const commands: [string, string[]][] = [];
  const f = await admin(t, { platform: "darwin", uid: 501, exec: async (file, args) => { commands.push([file, args]); } });
  assert.deepEqual(await (await fetch(`${f.base}/api/phone/restart`, { method: "POST" })).json(), { ok: true });
  assert.deepEqual(commands, [["launchctl", ["kickstart", "-k", "gui/501/com.clauderipple.host"]]]);
  for (const platform of ["linux", "win32"] as const) {
    commands.length = 0;
    const result = await phoneRequest("restart", "POST", undefined, { platform, exec: async (file, args) => { commands.push([file, args]); } });
    assert.deepEqual(result.body, { ok: true });
    assert.equal(commands[0]?.[0], process.execPath);
    assert.match(commands[0]?.[1][0] ?? "", /remote[/\\]src[/\\]main\.ts$/);
    assert.equal(commands[0]?.[1][1], "install");
  }
  const failed = await phoneRequest("restart", "POST", undefined, { platform: "darwin", uid: 501, exec: async () => { throw new Error("job not installed"); } });
  assert.equal(failed.status, 502);
});

test("mod approval and move routes forward through the authenticated host boundary and relay the host's status", async t => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const f = await admin(t, { fetch: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("x-ripple-local"), "s".repeat(43));
    assert.equal(init?.redirect, "error");
    calls.push({ url: String(url), method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/local/mod/moved") return Response.json({ error: "move unavailable" }, { status: 409 });
    if (pathname === "/local/mod/approval" && init?.method === "POST") return Response.json({ state: "hold" });
    if (pathname === "/local/mod/approval") return Response.json({ state: "pending" });
    return Response.json({ ok: true });
  } });
  const poll = await fetch(`${f.base}/api/mod/approval?askId=ask-1_A`);
  assert.equal(poll.status, 200);
  assert.equal(poll.headers.get("cache-control"), "no-store");
  assert.deepEqual(await poll.json(), { state: "pending" });
  const startBody = '{"askId":"ask-1_A","session":"sess","tool":"Bash","input":{"command":"ls"},"suggestions":[],"title":""}';
  const start = await fetch(`${f.base}/api/mod/approval`, { method: "POST", body: startBody });
  assert.equal(start.status, 200);
  assert.deepEqual(await start.json(), { state: "hold" });
  const done = await fetch(`${f.base}/api/mod/approval/done`, { method: "POST", body: '{"askId":"ask-1_A"}' });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { ok: true });
  // The mod's move probe sends an empty `to`; the host's 409 must reach the mod unchanged, not as a 502.
  const probe = await fetch(`${f.base}/api/mod/moved`, { method: "POST", body: '{"itemId":"item-1","from":"sess","to":""}' });
  assert.equal(probe.status, 409);
  assert.deepEqual(await probe.json(), { error: "move unavailable" });
  const move = await fetch(`${f.base}/api/mod/moved`, { method: "POST", body: '{"itemId":"item-1","from":"sess","to":"sess-2"}' });
  assert.equal(move.status, 409);
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:18797/local/mod/approval?askId=ask-1_A", method: "GET" },
    { url: "http://127.0.0.1:18797/local/mod/approval", method: "POST", body: startBody },
    { url: "http://127.0.0.1:18797/local/mod/approval/done", method: "POST", body: '{"askId":"ask-1_A"}' },
    { url: "http://127.0.0.1:18797/local/mod/moved", method: "POST", body: '{"itemId":"item-1","from":"sess","to":""}' },
    { url: "http://127.0.0.1:18797/local/mod/moved", method: "POST", body: '{"itemId":"item-1","from":"sess","to":"sess-2"}' },
  ]);
});

test("the mod poll's send time is forwarded to the host as sentAt, and a malformed one is refused before forwarding", async t => {
  const urls: string[] = [];
  const f = await admin(t, { fetch: async url => { urls.push(String(url)); return Response.json({ state: "pending" }); } });
  assert.equal((await fetch(`${f.base}/api/mod/approval?askId=ask-1&sentAt=1700000000000`)).status, 200);
  assert.equal((await fetch(`${f.base}/api/mod/approval?askId=ask-1`)).status, 200, "a mod that sends no send time is forwarded as before");
  for (const query of ["sentAt=", "sentAt=-1", "sentAt=1.5", "sentAt=soon", "sentAt=1&sentAt=2", `sentAt=${"9".repeat(16)}`]) {
    assert.equal((await fetch(`${f.base}/api/mod/approval?askId=ask-1&${query}`)).status, 400, query);
  }
  assert.deepEqual(urls, ["http://127.0.0.1:18797/local/mod/approval?askId=ask-1&sentAt=1700000000000", "http://127.0.0.1:18797/local/mod/approval?askId=ask-1"]);
  // The phone bridge itself takes a send time only on the approval poll, and only as a whole number of milliseconds.
  assert.equal((await phoneRequest("mod/approval", "GET", undefined, {}, "ask-1", "soon")).status, 404);
  assert.equal((await phoneRequest("inbox", "GET", undefined, {}, "sess", "1700000000000")).status, 404);
});

test("the mod approval poll is not cut before the host's long-poll answers", { timeout: 20_000 }, async t => {
  const f = await admin(t, { fetch: async (_url, init) => new Promise<Response>((resolve, reject) => {
    // The host answers at its full 3 s long-poll: the router's own timeout must not abort it first.
    const timer = setTimeout(() => resolve(Response.json({ state: "pending" })), APPROVAL_WAIT_MS + 500);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
  }) });
  const started = Date.now();
  const poll = await fetch(`${f.base}/api/mod/approval?askId=ask-1`);
  assert.equal(poll.status, 200);
  assert.ok(Date.now() - started >= APPROVAL_WAIT_MS);
  assert.deepEqual(await poll.json(), { state: "pending" });
});

test("mod routes refuse other methods, cross-site callers and malformed input before forwarding", async t => {
  const calls: string[] = [];
  const f = await admin(t, { fetch: async url => { calls.push(String(url)); return Response.json({ ok: true }); } });
  const post = (route: string, body: string, headers?: Record<string, string>) => fetch(`${f.base}/api/mod/${route}`, { method: "POST", body, ...(headers ? { headers } : {}) });
  // Poll: askId is required, exactly once, and at most 100 safe characters.
  for (const query of ["", "?askId=", "?askId=a/b", "?askId=a&askId=b", `?askId=${"x".repeat(101)}`]) assert.equal((await fetch(`${f.base}/api/mod/approval${query}`)).status, 400);
  // Start: a JSON object whose askId is safe.
  for (const body of ["{", "[]", "null", "{}", '{"askId":"a/b"}']) assert.equal((await post("approval", body)).status, 400);
  // Answer: askId only.
  for (const body of ["{}", '{"askId":"a","extra":1}', '{"askId":"a/b"}']) assert.equal((await post("approval/done", body)).status, 400);
  // Move: a safe itemId, two strings (an empty `to` is the probe), and no other fields.
  for (const body of ['{"from":"s","to":"t"}', '{"itemId":"a/b","from":"s","to":"t"}', '{"itemId":"a","from":5,"to":"t"}', '{"itemId":"a","from":"s","to":null}', '{"itemId":"a","from":"s","to":"t","extra":1}', `{"itemId":"a","from":"${"s".repeat(201)}","to":"t"}`, `{"itemId":"a","from":"s","to":"t","pad":"${"x".repeat(4096)}"}`]) {
    assert.equal((await post("moved", body)).status, 400);
  }
  // Methods: the poll is GET only; the answer and the move are POST only.
  assert.equal((await fetch(`${f.base}/api/mod/approval/done`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/mod/moved`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/mod/approval`, { method: "PUT", body: '{"askId":"a"}' })).status, 404);
  // Cross-site callers are refused on every route.
  assert.equal((await fetch(`${f.base}/api/mod/approval?askId=a`, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await post("approval", '{"askId":"a"}', { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("approval/done", '{"askId":"a"}', { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("moved", '{"itemId":"a","from":"s","to":"t"}', { origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(`${f.base}/api/mod/approval?askId=a`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal(calls.length, 0);
});

test("the approval start cap admits the mod's 480 KB and refuses more", async t => {
  const forwarded: number[] = [];
  const f = await admin(t, { fetch: async (_url, init) => { forwarded.push(String(init?.body ?? "").length); return Response.json({ state: "local" }); } });
  const body = (padding: number) => JSON.stringify({ askId: "ask-big", input: { content: "x".repeat(padding) } });
  // The mod sends at most 480 KB (its APPROVAL_BODY_CAP); this route accepts up to the host's 512 KB.
  assert.equal((await fetch(`${f.base}/api/mod/approval`, { method: "POST", body: body(480 * 1024 - 64) })).status, 200);
  assert.equal((await fetch(`${f.base}/api/mod/approval`, { method: "POST", body: body(512 * 1024) })).status, 400);
  assert.equal(forwarded.length, 1);
  assert.ok((forwarded[0] ?? 0) > 480 * 1024 - 64);
});

test("every mod route reports an unreachable host without exposing its error", async t => {
  const f = await admin(t, { fetch: async () => { throw new Error("private"); } });
  const responses = [
    await fetch(`${f.base}/api/mod/approval?askId=a`),
    await fetch(`${f.base}/api/mod/approval`, { method: "POST", body: '{"askId":"a"}' }),
    await fetch(`${f.base}/api/mod/approval/done`, { method: "POST", body: '{"askId":"a"}' }),
    await fetch(`${f.base}/api/mod/moved`, { method: "POST", body: '{"itemId":"a","from":"s","to":""}' }),
  ];
  for (const response of responses) {
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text.includes("private"), false);
    assert.ok(text.includes("phone host unavailable"));
  }
});

test("an older host without the mod routes answers with its own status, so the mod falls back", async t => {
  const f = await admin(t, { fetch: async () => Response.json({ error: "unknown local control endpoint or method" }, { status: 404 }) });
  assert.equal((await fetch(`${f.base}/api/mod/approval?askId=a`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/mod/approval`, { method: "POST", body: '{"askId":"a"}' })).status, 404);
  assert.equal((await fetch(`${f.base}/api/mod/moved`, { method: "POST", body: '{"itemId":"a","from":"s","to":""}' })).status, 404);
});
