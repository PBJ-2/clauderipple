// Drive the real CONNECT/TLS proxy and the ordinary adapters against local HTTP/TLS origins.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { createCa, createLeaf } from "../src/x509.ts";

type Wire = "chatgpt" | "chat" | "responses" | "compatible";
const prompt = "\nWeb page content:\n---\nNode.js 24 is current.\n---\n\nWhich release is current?\n\nProvide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.\n";
const fixture = (stream = false) => ({ model: "claude-haiku-5-5", max_tokens: 8192, stream, system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }], messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [], output_config: { effort: "high" }, metadata: { user_id: "webfetch-test" } });

async function rig(wire: Wire = "chatgpt") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-proxy-webfetch-"));
  const ca = createCa({ cn: "webfetch test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  fs.writeFileSync(path.join(home, "chatgpt-auth.json"), JSON.stringify({ accessToken: "local-token", accountId: "local-account", expiresAt: Date.now() + 3600_000, source: "own" }));
  const seen: { body: Record<string, unknown>; headers: http.IncomingHttpHeaders; url: string }[] = [];
  const native: { raw: string; headers: http.IncomingHttpHeaders }[] = [];
  let failure = false;
  let brokenStream = false;
  let disconnect = false;
  const backend = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: req.headers, url: req.url ?? "" });
      if (disconnect) { req.socket.destroy(); return; }
      if (failure) { res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"local provider refused"}}'); return; }
      if (wire === "compatible") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_page", type: "message", role: "assistant", model: "reader", content: [{ type: "text", text: "Page answer" }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 3 } }));
        return;
      }
      const events = wire === "chat"
        ? [{ choices: [{ delta: { content: "Page answer" }, finish_reason: brokenStream ? null : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3 } }]
        : [{ type: "response.output_item.added", item: { type: "message", id: "msg_page" } }, { type: "response.output_text.delta", delta: "Page answer" }, ...brokenStream ? [] : [{ type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 3 } } }]];
      res.writeHead(200, { "content-type": "text/event-stream" }).end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  const origin = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      native.push({ raw: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message", id: "msg_native", role: "assistant", content: [{ type: "text", text: "Native answer" }], usage: { input_tokens: 7, output_tokens: 2 } }));
    });
  });
  const probe = net.createServer();
  await Promise.all([backend, origin, probe].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const url = `http://127.0.0.1:${(backend.address() as net.AddressInfo).port}`;
  const model = wire === "chatgpt" ? "gpt-6-luna" : "reader";
  const models = [{ id: model, effortLevels: ["low", "high"] }];
  const provider: Config["providers"][string] = wire === "chatgpt" ? { type: "chatgpt", auth: "own", url, models }
    : wire === "compatible" ? { type: "anthropic-compatible", url, headers: { "x-api-key": "reader-key" }, models }
      : { type: "openai-compatible", url, wire, headers: { authorization: "Bearer reader-key" }, caps: { reasoning: "effort", effortLevels: ["low", "high"] }, models };
  const cfg: Config = { ...DEFAULTS, upstream: "localhost", listen: { host: "127.0.0.1", port }, providers: { web: provider }, routes: {}, direct: [], aliases: {}, webSearch: { provider: "web", model } };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const agent = new https.Agent({ ca: ca.certPem, lookup: (_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]) });
  const proxy = new Proxy({ config: () => cfg, home, requests, agentDir: path.join(home, "agents"), log: new Logger(path.join(home, "router.log"), 1e6, 1, false), certs: new CertStore(home), health: new UpstreamHealth(() => 100, () => {}), upstreamPort: (origin.address() as net.AddressInfo).port, upstreamAgent: agent });
  await proxy.listen();
  async function send(body: Record<string, unknown> = fixture(), pathname = "/v1/messages") {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve, reject) => { socket.once("data", () => resolve()); socket.once("error", reject); });
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
    const raw = JSON.stringify(body);
    const result = new Promise<string>((resolve, reject) => {
      let text = "";
      secure.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        const split = text.indexOf("\r\n\r\n");
        if (split < 0) return;
        const length = /content-length:\s*(\d+)/i.exec(text.slice(0, split));
        if (text.endsWith("\r\n0\r\n\r\n") || (length && Buffer.byteLength(text.slice(split + 4)) >= Number(length[1]))) resolve(text);
      });
      secure.once("end", () => resolve(text));
      secure.once("error", reject);
      secure.setTimeout(15_000, () => { secure.destroy(); reject(new Error("local proxy response timed out")); });
    });
    secure.write(`POST ${pathname} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nx-claude-code-session-id: webfetch-session\r\nauthorization: Bearer original-auth\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`);
    const text = await result;
    secure.destroy();
    // A row for the caller's own login is written once its email lookup settles, which can be after
    // the response: wait for it as a drain does, or there is no row to read yet.
    await proxy.rows.settled();
    return { text, record: requests.list(1)[0]! };
  }
  return { cfg, seen, native, requests, proxy, send, fail: () => { failure = true; }, disconnect: () => { disconnect = true; }, breakStream: () => { brokenStream = true; }, stop: async () => {
    proxy.close(); agent.destroy();
    await Promise.all([backend, origin].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    fs.rmSync(home, { recursive: true, force: true });
  } };
}

for (const wire of ["chatgpt", "chat", "responses", "compatible"] as const) {
  test(`WebFetch uses ordinary ${wire} routing and records its purpose`, async () => {
    const r = await rig(wire);
    try {
      const { text, record } = await r.send();
      assert.match(text, /HTTP\/1.1 200/);
      assert.match(text, /Page answer/);
      assert.equal(r.native.length, 0);
      assert.equal(r.seen.length, 1);
      const { body, headers, url } = r.seen[0]!;
      assert.equal(body.model, r.cfg.webSearch!.model);
      assert.notEqual(headers.authorization, "Bearer original-auth", "routed auth, not caller auth");
      if (wire === "chatgpt" || wire === "responses") {
        assert.ok(Array.isArray(body.input), "ordinary Responses translation");
        assert.equal((body.reasoning as { effort?: string }).effort, "low");
        assert.match(url, /responses$/);
      } else if (wire === "chat") assert.match(url, /chat\/completions$/);
      else assert.equal((body.output_config as { effort?: string }).effort, "low");
      assert.equal(record.purpose, "web-fetch");
      assert.equal(record.provider, "web");
      assert.equal(record.source, "claude-haiku-5-5");
      assert.equal(record.target, r.cfg.webSearch!.model);
      assert.equal(record.session, "webfetch-session");
      assert.match(record.note!, /web fetch via web/);
      assert.equal(record.usage?.output, 3);
      assert.equal(r.requests.list(10).length, 1);
      assert.equal(r.proxy.stats.completed, 1);
      assert.equal(r.proxy.stats.inFlight, 0);
    } finally { await r.stop(); }
  });
  test(`WebFetch ${wire} failure before any bytes falls back with the original body and auth`, async () => {
    const r = await rig(wire);
    try {
      r.fail();
      const original = fixture();
      const { text, record } = await r.send(original);
      assert.match(text, /Native answer/);
      assert.doesNotMatch(text, /local provider refused/);
      assert.equal(r.native.length, 1);
      assert.equal(r.native[0]!.raw, JSON.stringify(original));
      assert.equal(r.native[0]!.headers.authorization, "Bearer original-auth");
      assert.equal(record.purpose, "web-fetch");
      assert.equal(record.provider, "anthropic");
      assert.equal(record.target, original.model);
      assert.match(record.note!, /original destination fallback/);
      assert.equal(r.requests.list(10).length, 1);
      assert.equal(r.proxy.stats.completed, 1);
      assert.equal(r.proxy.stats.inFlight, 0);
    } finally { await r.stop(); }
  });
}

test("unconfigured and non-matching requests are byte-exact passthrough, including count_tokens", async () => {
  const r = await rig();
  try {
    delete r.cfg.webSearch;
    const original = fixture();
    assert.equal((await r.send(original)).record.purpose, undefined);
    r.cfg.webSearch = { provider: "web", model: "gpt-6-luna" };
    const ordinary = { ...fixture(), messages: [{ role: "user", content: "Discuss web page content" }] };
    assert.equal((await r.send(ordinary)).record.purpose, undefined);
    assert.equal((await r.send(original, "/v1/messages/count_tokens")).record.purpose, undefined);
    assert.deepEqual(r.native.map((entry) => entry.raw), [original, ordinary, original].map((entry) => JSON.stringify(entry)));
    assert.equal(r.seen.length, 0);
  } finally { await r.stop(); }
});

test("an unusable web provider leaves the original destination untouched", async () => {
  const r = await rig();
  try {
    r.cfg.webSearch = { provider: "missing", model: "reader" };
    assert.match((await r.send()).text, /Native answer/);
    r.cfg.webSearch = { provider: "ingress", model: "claude-haiku-5-5" };
    r.cfg.providers.ingress = { type: "anthropic", auth: "claude-code" };
    assert.match((await r.send()).text, /Native answer/);
    assert.equal(r.seen.length, 0);
  } finally { await r.stop(); }
});

test("a WebFetch fallback still honours the original model's ordinary route", async () => {
  const r = await rig();
  try {
    r.fail();
    // Use a second local ordinary route to the same backend: its visible 400 proves the fallback
    // re-resolved the source, rather than bypassing a deliberate mapping to call Anthropic.
    r.cfg.providers.original = { type: "openai-compatible", url: (r.cfg.providers.web as { url: string }).url };
    r.cfg.routes["claude-haiku-5-5"] = { provider: "original", model: "original-reader" };
    const { text, record } = await r.send();
    assert.match(text, /HTTP\/1.1 400/);
    assert.equal(record.provider, "original");
    assert.equal(r.seen.length, 2);
    assert.equal(r.seen[1]!.body.model, "original-reader");
    assert.equal(r.native.length, 0);
  } finally { await r.stop(); }
});

test("a connection failure before any response falls back once, without losing or duplicating the request", async () => {
  const r = await rig("compatible");
  try {
    r.disconnect();
    const original = fixture();
    const { text, record } = await r.send(original);
    assert.match(text, /Native answer/);
    assert.equal(r.seen.length, 1);
    assert.equal(r.native[0]!.raw, JSON.stringify(original));
    assert.equal(record.purpose, "web-fetch");
    assert.equal(r.requests.list(10).length, 1);
    assert.equal(r.proxy.stats.inFlight, 0);
  } finally { await r.stop(); }
});

test("a local original-destination refusal does not erase the failed web provider call from accounting", async () => {
  const r = await rig();
  try {
    r.fail();
    const { text, record } = await r.send({ ...fixture(), model: "undeclared-helper" });
    assert.match(text, /HTTP\/1.1 400/);
    assert.equal(r.seen.length, 1);
    assert.equal(record.refusal, "unroutable");
    assert.equal(record.upstreamCalled, undefined);
    assert.equal(record.purpose, "web-fetch");
  } finally { await r.stop(); }
});

test("a model with no effort ladder receives no inherited high effort", async () => {
  const r = await rig("compatible");
  try {
    r.cfg.providers.web!.models![0]!.effortLevels = [];
    const { text, record } = await r.send();
    assert.match(text, /Page answer/);
    assert.equal((r.seen[0]!.body.output_config as { effort?: string } | undefined)?.effort, undefined);
    assert.equal(record.effort, undefined);
  } finally { await r.stop(); }
});

test("a stream already started is never replaced by an original-destination answer", async () => {
  const r = await rig();
  try {
    r.breakStream();
    const { text, record } = await r.send(fixture(true));
    assert.match(text, /Page answer/);
    assert.match(text, /overloaded_error/);
    assert.equal(r.native.length, 0);
    assert.equal(record.provider, "web");
    assert.equal(record.ok, false);
    assert.equal(r.requests.list(10).length, 1);
  } finally { await r.stop(); }
});
