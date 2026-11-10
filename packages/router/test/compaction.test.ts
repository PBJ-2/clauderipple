import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { startAdmin } from "../src/admin.ts";
import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { promptAdditions } from "../src/identity.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { CompactPicks, requestKind } from "../src/routing.ts";
import { createCa, createLeaf } from "../src/x509.ts";

const instruction = "Your task is to create a detailed summary of the conversation so far,";
const fixture = () => ({ model: "claude-opus-5-5", max_tokens: 20000, system: "core system", tools: [],
  messages: [{ role: "user", content: "original request" }, { role: "assistant", content: "recent answer" }, { role: "user", content: instruction }],
  output_config: { effort: "high" } });

test("compaction classifier reads only the last user's direct text on Messages", () => {
  for (const text of [instruction, "Your task is to create a detailed summary of this conversation."]) {
    assert.equal(requestKind({ messages: [{ role: "user", content: text }] }, "/v1/messages"), "compaction");
    assert.equal(requestKind({ messages: [{ role: "user", content: [{ type: "text", text }] }] }, "/v1/messages"), "compaction");
  }
  for (const content of ["continue", [{ type: "tool_result", content: instruction }], []]) {
    assert.equal(requestKind({ messages: [...fixture().messages, { role: "user", content }] }, "/v1/messages"), "turn");
  }
  assert.equal(requestKind(fixture(), "/v1/messages/count_tokens"), "turn");
  assert.equal(requestKind(fixture(), "/v1/messages", "PUT"), "turn");
  // The CLI's request class wins: a person quoting the prompt in a main turn keeps their model, and a
  // class of `compaction` needs no prompt text.
  assert.equal(requestKind(fixture(), "/v1/messages", "POST", "main"), "turn");
  assert.equal(requestKind({ messages: [{ role: "user", content: "anything" }] }, "/v1/messages", "POST", "compaction"), "compaction");
  assert.deepEqual(promptAdditions("compaction", { identity: true, instructionsAppend: "extra" }, "image"), { identity: false });
});

test("one-shot > default > none, session overrides, expiry and worker isolation", () => {
  let now = 0;
  const picks = new CompactPicks(() => now);
  const fallback = () => "default";
  assert.equal(picks.take("main", false, () => undefined), undefined);
  assert.equal(picks.take("main", false, fallback), "default");
  picks.set("main", "picked@low");
  assert.equal(picks.take("main", true, fallback), undefined);
  assert.equal(picks.take("other", false, fallback), "default");
  assert.equal(picks.take("main", false, fallback), "picked@low");
  assert.equal(picks.take("main", false, fallback), "default");
  picks.set("main", "session");
  assert.equal(picks.take("main", false, fallback), undefined);
  assert.equal(picks.take("main", false, () => "session"), undefined);
  picks.set("main", "expired"); now = 600_000;
  assert.equal(picks.take("main", false, fallback), "default");
});

async function rig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-compact-"));
  const ca = createCa({ cn: "compaction test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const native: { raw: string; headers: http.IncomingHttpHeaders }[] = [];
  const routed: Record<string, unknown>[] = [];
  let failure = 0;
  let nativeFailure = 0;
  let disconnect = false;
  let brokenStream = false;
  const receive = (req: http.IncomingMessage, done: (raw: string) => void) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  };
  const answer = (res: http.ServerResponse) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "msg_compact", type: "message", role: "assistant", content: [{ type: "text", text: "core summary" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 },
  }));
  const backend = http.createServer((req, res) => receive(req, raw => {
    routed.push(JSON.parse(raw));
    if (disconnect) { req.socket.destroy(); return; }
    if (failure) { res.writeHead(failure).end('{"error":{"message":"compact target refused"}}'); return; }
    if (req.url?.endsWith('/chat/completions')) {
      const event = { choices: [{ delta: { content: 'core summary' }, finish_reason: brokenStream ? null : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify(event)}\n\n`);
      return;
    }
    answer(res);
  }));
  const origin = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => receive(req, raw => {
    native.push({ raw, headers: req.headers });
    if (nativeFailure && JSON.parse(raw).model === "claude-haiku-5-5") { res.writeHead(nativeFailure).end('{"error":"native target refused"}'); return; }
    answer(res);
  }));
  const probe = net.createServer();
  await Promise.all([backend, origin, probe].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const cfg: Config = { ...DEFAULTS, upstream: "localhost", listen: { host: "127.0.0.1", port }, admin: { port: 0 }, routes: {}, direct: [], aliases: {},
    providers: { local: { type: "anthropic-compatible", url: `http://127.0.0.1:${(backend.address() as net.AddressInfo).port}`, models: [{ id: "summary", effortLevels: ["low", "high"] }], caps: { effortLevels: ["low", "high"] }, identity: true, instructionsAppend: "must not be added" } } };
  const log = new Logger(path.join(home, "router.log"), 1e6, 1, false);
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const agent = new https.Agent({ ca: ca.certPem, lookup: (_host, _options, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]) });
  // The app's own login (the Bearer these requests send) names its email, as `/api/oauth/profile` would.
  const claudeProfileFetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const token = String((init.headers as Record<string, string>).authorization ?? "").replace(/^Bearer\s+/i, "");
    return token === "original" ? new Response(JSON.stringify({ account: { uuid: "uuid-original", email: "original@example.test" } }), { status: 200 }) : new Response("{}", { status: 404 });
  };
  const proxy = new Proxy({ config: () => cfg, home, log, requests, certs: new CertStore(home), agentDir: path.join(home, "agents"), health: new UpstreamHealth(() => 100, () => {}), upstreamPort: (origin.address() as net.AddressInfo).port, upstreamAgent: agent, claudeProfileFetch });
  await proxy.listen();
  const admin = await startAdmin({ config: () => cfg, configFile: path.join(home, "config.json"), log, requests, stats: () => proxy.stats, health: () => 0, version: "test", compactPick: (session, model) => model === null ? proxy.compactPicks.clear(session) : proxy.compactPicks.set(session, model) });
  const pick = (body: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number }>((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${admin.port}/api/compact-pick`, { method: "POST", headers: { "content-type": "application/json", ...headers } }, res => {
      res.resume(); res.once("end", () => resolve({ status: res.statusCode! }));
    });
    req.once("error", reject); req.end(JSON.stringify(body));
  });
  async function send(body: Record<string, unknown> = fixture(), worker = false, pathname = "/v1/messages", method = "POST") {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve, reject) => { socket.once("data", () => resolve()); socket.once("error", reject); });
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
    const raw = JSON.stringify(body);
    const response = new Promise<string>((resolve, reject) => {
      let text = "";
      secure.on("data", chunk => {
        text += chunk.toString();
        const split = text.indexOf('\r\n\r\n');
        if (split < 0) return;
        const length = /content-length:\s*(\d+)/i.exec(text.slice(0, split));
        if (text.endsWith('\r\n0\r\n\r\n') || (length && Buffer.byteLength(text.slice(split + 4)) >= Number(length[1]))) resolve(text);
      });
      secure.once("end", () => resolve(text)); secure.once("error", reject);
      secure.setTimeout(10000, () => { secure.destroy(); reject(new Error("no compaction response")); });
    });
    secure.write(`${method} ${pathname} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nx-claude-code-session-id: main\r\n${worker ? "x-claude-code-agent-id: worker\r\n" : ""}authorization: Bearer original\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`);
    const text = await response; secure.destroy();
    return text;
  }
  return { home, cfg, proxy, requests, native, routed, send, pick,
    fail: (status: number) => { failure = status; }, failNative: (status: number) => { nativeFailure = status; }, disconnect: () => { disconnect = true; },
    breakStream: () => { brokenStream = true; },
    settings: (compactModel?: string) => fs.writeFileSync(path.join(home, "mod-settings.json"), JSON.stringify({ settings: { compactModel }, revision: 1, stored: true })),
    stop: async () => { admin.close(); proxy.close(); agent.destroy(); await Promise.all([backend, origin].map(server => new Promise<void>(resolve => server.close(() => resolve())))); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

test("admin validates input and same-origin rules; native pick preserves everything except model", async () => {
  const r = await rig();
  try {
    for (const body of [null, [], {}, { session: "bad id", model: "session" }, { session: "main", model: "" }, { session: "main", model: "x\n" }, { session: "main", model: "session", extra: true }]) assert.equal((await r.pick(body)).status, 400);
    assert.equal((await r.pick({ session: "main", model: "session" }, { origin: "https://foreign.example" })).status, 403);
    assert.equal((await r.pick({ session: "main", model: "session" }, { host: "foreign.example" })).status, 403);
    assert.equal((await r.pick({ session: "main", model: "claude-haiku-5-5" })).status, 200);
    assert.match(await r.send(), /core summary/);
    assert.deepEqual(JSON.parse(r.native[0]!.raw), { ...fixture(), model: "claude-haiku-5-5" });
    assert.equal(r.native[0]!.headers.authorization, "Bearer original");
    assert.equal(r.requests.list(1)[0]!.target, "claude-haiku-5-5");
    assert.match(r.requests.list(1)[0]!.note!, /compact→claude-haiku-5-5/);
    await r.send();
    assert.equal(r.native[1]!.raw, JSON.stringify(fixture()), "pick consumed once");
    // A null model forgets a pick that core never asked for.
    assert.equal((await r.pick({ session: "main", model: "claude-haiku-5-5" })).status, 200);
    assert.equal((await r.pick({ session: "main", model: null })).status, 200);
    await r.send();
    assert.equal(r.native[2]!.raw, JSON.stringify(fixture()), "cleared pick is not used");
  } finally { await r.stop(); }
});

test("default routing honours effort, preserves core prompt, and excludes workers without consuming main pick", async () => {
  const r = await rig();
  try {
    r.settings("summary@low");
    await r.pick({ session: "main", model: "session" });
    await r.send(fixture(), true);
    await r.send();
    assert.equal(r.native.length, 2); assert.equal(r.routed.length, 0);
    await r.send();
    assert.equal(r.routed.length, 1);
    const body = r.routed[0]!;
    assert.equal(body.model, "summary"); assert.equal((body.output_config as { effort: string }).effort, "low");
    assert.deepEqual(body.messages, fixture().messages); assert.equal(body.system, fixture().system); assert.deepEqual(body.tools, []);
    assert.equal(r.requests.list(1)[0]!.purpose, "compaction");
    await r.pick({ session: "main", model: "claude-haiku-5-5" });
    await r.send({ ...fixture(), messages: [{ role: "user", content: "ordinary turn" }] });
    await r.send(fixture(), false, "/v1/messages/count_tokens");
    await r.send(fixture(), false, "/v1/messages", "PUT");
    await r.send();
    assert.equal(JSON.parse(r.native.at(-1)!.raw).model, "claude-haiku-5-5", "unmatched requests do not consume");
  } finally { await r.stop(); }
});

for (const status of [400, 500]) test(`routed ${status} falls back before bytes with original body/auth, logs both attempts`, async () => {
  const r = await rig();
  try {
    r.settings("summary@low"); r.fail(status);
    const text = await r.send();
    assert.match(text, /HTTP\/1.1 200/); assert.match(text, /core summary/); assert.doesNotMatch(text, /target refused/);
    assert.equal(r.native[0]!.raw, JSON.stringify(fixture())); assert.equal(r.native[0]!.headers.authorization, "Bearer original");
    const records = r.requests.list(10);
    assert.equal(records.length, 2); assert.equal(records[0]!.ok, true); assert.equal(records[1]!.status, status);
    assert.match(records[1]!.note!, /compact target refused/); assert.match(records[0]!.note!, /fallback/);
    assert.equal(r.proxy.stats.inFlight, 0); assert.equal(r.proxy.stats.completed, 1);
  } finally { await r.stop(); }
});

test("missing target, unset setting and corrupt setting all retain a response on the original model", async () => {
  const r = await rig();
  try {
    await r.send();
    r.settings(); await r.send();
    r.settings('session'); await r.send();
    fs.writeFileSync(path.join(r.home, 'mod-settings.json'), '{broken'); await r.send();
    await r.pick({ session: 'main', model: 'missing-model' }); await r.send();
    assert.equal(r.native.length, 5);
    assert.ok(r.native.every(entry => entry.raw === JSON.stringify(fixture())));
    assert.equal(r.proxy.stats.inFlight, 0);
  } finally { await r.stop(); }
});

for (const scenario of ['success', 'refusal', 'started-stream'] as const) test(`translated compaction ${scenario} uses ordinary adapter and response commitment`, async () => {
  const r = await rig();
  try {
    const url = (r.cfg.providers.local as { url: string }).url;
    r.cfg.providers.local = { type: 'openai-compatible', url, wire: 'chat', models: [{ id: 'summary', effortLevels: ['low', 'high'] }], caps: { reasoning: 'effort', effortLevels: ['low', 'high'] }, instructionsAppend: 'must not be added' };
    r.settings('summary@low');
    if (scenario === 'refusal') r.fail(400);
    if (scenario === 'started-stream') r.breakStream();
    const text = await r.send({ ...fixture(), stream: true });
    assert.match(text, /core summary/);
    if (scenario === 'refusal') {
      assert.equal(r.native.length, 1);
      assert.equal(r.native[0]!.raw, JSON.stringify({ ...fixture(), stream: true }));
    } else {
      assert.equal(r.native.length, 0);
      const messages = r.routed[0]!.messages as { role: string; content: string }[];
      assert.equal(messages[0]!.content, fixture().system);
      assert.deepEqual(messages.slice(1), fixture().messages);
      assert.equal(r.routed[0]!.reasoning_effort, 'low');
      if (scenario === 'started-stream') {
        assert.match(text, /overloaded_error/);
        assert.equal(r.requests.list(10).length, 1);
        assert.equal(r.requests.list(1)[0]!.ok, false);
      }
    }
    assert.equal(r.proxy.stats.inFlight, 0);
  } finally { await r.stop(); }
});

test("a failed native compaction on the app's login keeps that login's email on its row", async () => {
  const r = await rig();
  try {
    await r.pick({ session: "main", model: "claude-haiku-5-5" }); r.failNative(500);
    assert.match(await r.send(), /core summary/);
    // The failed attempt's row is written as the answer arrives for its email; poll for it.
    let failed = r.requests.list(10).find((record) => record.account === "current" && record.ok === false);
    for (let i = 0; i < 100 && !failed?.accountEmail; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      failed = r.requests.list(10).find((record) => record.account === "current" && record.ok === false);
    }
    assert.ok(failed, "the failed attempt is recorded under the login");
    assert.equal(failed.accountEmail, "original@example.test");
  } finally { await r.stop(); }
});

test("native failure and connection failure each retry the original exactly once", async () => {
  const r = await rig();
  try {
    await r.pick({ session: "main", model: "claude-haiku-5-5" }); r.failNative(500);
    assert.match(await r.send(), /core summary/); assert.equal(r.native.length, 2);
    assert.equal(r.native[1]!.raw, JSON.stringify(fixture()));
    r.settings("summary"); r.disconnect();
    assert.match(await r.send(), /core summary/); assert.equal(r.native.length, 3); assert.equal(r.routed.length, 1);
    assert.equal(r.proxy.stats.inFlight, 0);
  } finally { await r.stop(); }
});
