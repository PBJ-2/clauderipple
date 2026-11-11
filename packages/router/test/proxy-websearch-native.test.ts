// `webSearch: "native"` (issue #158): a WebSearch whose route target runs no server tools goes to
// Anthropic as sent — original Claude model id, the app's own login — instead of being refused,
// while the same slot's other requests keep their route. Unset, or for a model that is not a Claude
// id, the refusal stays. Drives the real CONNECT/TLS proxy against a local OpenAI-compatible
// provider and a local Anthropic upstream.
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
import { DEFAULTS, validate, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import { createCa, createLeaf } from "../src/x509.ts";

const searchBody = (model: string) => ({
  model,
  max_tokens: 1024,
  messages: [{ role: "user", content: "Perform a web search for the query: latest Node.js 24 release" }],
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["nodejs.org"] }],
  tool_choice: { type: "auto" },
});
const turnBody = (model: string) => ({ model, max_tokens: 64, messages: [{ role: "user", content: "Say hello" }] });

async function rig(webSearch: Config["webSearch"] | undefined) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-proxy-websearch-native-"));
  const ca = createCa({ cn: "websearch native test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const routed: Record<string, unknown>[] = [];
  const backend = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      routed.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      const event = { choices: [{ delta: { content: "hello from the routed model" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
      res.writeHead(200, { "content-type": "text/event-stream" }).end(`data: ${JSON.stringify(event)}\n\n`);
    });
  });
  const native: { body: Record<string, unknown>; authorization: string | undefined }[] = [];
  const origin = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      native.push({ body, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "message", id: "msg_native", role: "assistant", model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: "Anthropic searched" }], usage: { input_tokens: 7, output_tokens: 2 } }));
    });
  });
  const probe = net.createServer();
  await Promise.all([backend, origin, probe].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const cfg: Config = {
    ...DEFAULTS,
    upstream: "localhost",
    listen: { host: "127.0.0.1", port },
    providers: {
      "ollama-cloud": {
        type: "openai-compatible",
        url: `http://127.0.0.1:${(backend.address() as net.AddressInfo).port}`,
        wire: "chat",
        headers: { authorization: "Bearer routed-key" },
        models: [{ id: "deepseek-v4.1-flash" }],
      },
    },
    routes: { "claude-haiku-5-5": { provider: "ollama-cloud", model: "deepseek-v4.1-flash" } },
    direct: [],
    aliases: {},
    ...(webSearch !== undefined ? { webSearch } : {}),
  };
  assert.deepEqual(validate(cfg), [], "the rig's config is valid");
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const agent = new https.Agent({ ca: ca.certPem, lookup: (_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]) });
  const logPath = path.join(home, "router.log");
  const proxy = new Proxy({ config: () => cfg, home, requests, agentDir: path.join(home, "agents"), log: new Logger(logPath, 1e6, 1, false), certs: new CertStore(home), health: new UpstreamHealth(() => 100, () => {}), upstreamPort: (origin.address() as net.AddressInfo).port, upstreamAgent: agent });
  await proxy.listen();

  async function send(body: Record<string, unknown>): Promise<{ text: string; record: RequestRecord }> {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve, reject) => { socket.once("data", () => resolve()); socket.once("error", reject); });
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
    const raw = JSON.stringify(body);
    const result = new Promise<string>((resolve, reject) => {
      let text = "";
      secure.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      secure.once("end", () => resolve(text));
      secure.once("close", () => resolve(text));
      secure.once("error", reject);
      secure.setTimeout(15_000, () => { secure.destroy(); reject(new Error("local proxy response timed out")); });
    });
    secure.write(`POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nauthorization: Bearer app-login\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`);
    const text = await result;
    secure.destroy();
    // The own-login row is written once its email lookup settles, which can trail the response.
    await proxy.rows.settled();
    return { text, record: requests.list(1)[0]! };
  }

  return { cfg, routed, native, send, log: () => fs.readFileSync(logPath, "utf8"), stop: async () => {
    proxy.close(); agent.destroy();
    await Promise.all([backend, origin].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    fs.rmSync(home, { recursive: true, force: true });
  } };
}

function assertRefused(r: Awaited<ReturnType<typeof rig>>, out: { text: string; record: RequestRecord }): void {
  assert.match(out.text, /web_search_tool_result_error/);
  assert.match(out.text, /"web_search_requests":0/);
  assert.equal(r.native.length, 0, "nothing reached Anthropic");
  assert.equal(r.routed.length, 0, "nothing reached the provider");
  assert.equal(out.record.refusal, "web-search-unsupported");
  assert.match(out.record.note ?? "", /web search refused: ollama-cloud runs no server tools/);
}

test('webSearch "native" passes a search routed to a provider without server tools to Anthropic unchanged', async () => {
  const r = await rig("native");
  try {
    const out = await r.send(searchBody("claude-haiku-5-5"));
    assert.match(out.text, /HTTP\/1.1 200/);
    assert.match(out.text, /Anthropic searched/);
    assert.equal(r.native.length, 1, "the search reached the Anthropic upstream once");
    assert.equal(r.routed.length, 0, "the routed provider never saw it");
    const seen = r.native[0]!;
    assert.deepEqual(seen.body, searchBody("claude-haiku-5-5"), "body, tool and original Claude model id are untouched");
    assert.equal(seen.authorization, "Bearer app-login", "the app's own login answered");
    assert.equal(out.record.purpose, "web-search");
    assert.equal(out.record.source, "claude-haiku-5-5");
    assert.equal(out.record.target, "claude-haiku-5-5");
    assert.equal(out.record.provider, "anthropic", "recorded like any un-routed pass-through, not as the routed provider");
    assert.equal(out.record.refusal, undefined);
    assert.equal(out.record.account, "current");
    assert.match(out.record.note ?? "", /web search passed to Anthropic \(webSearch: native\)/);
    assert.match(r.log(), /web search passed to Anthropic \(webSearch: native\): ollama-cloud runs no server tools; claude-haiku-5-5 sent unchanged/);

    // The rest of the slot keeps its route: the same model's ordinary request still goes to the provider.
    const turn = await r.send(turnBody("claude-haiku-5-5"));
    assert.match(turn.text, /HTTP\/1.1 200/);
    assert.equal(r.routed.length, 1, "the slot's other request was routed");
    assert.equal(r.routed[0]!.model, "deepseek-v4.1-flash");
    assert.equal(r.native.length, 1, "and did not go to Anthropic");
    assert.equal(turn.record.provider, "ollama-cloud");
  } finally { await r.stop(); }
});

test('webSearch "native" still refuses a search whose model is not a Claude id', async () => {
  const r = await rig("native");
  try {
    // A provider-declared model id resolves to its provider; passing it to Anthropic would only 404.
    assertRefused(r, await r.send(searchBody("deepseek-v4.1-flash")));
  } finally { await r.stop(); }
});

test("with webSearch unset the same search is refused as before", async () => {
  const r = await rig(undefined);
  try {
    assertRefused(r, await r.send(searchBody("claude-haiku-5-5")));
    assert.doesNotMatch(r.log(), /passed to Anthropic/);
  } finally { await r.stop(); }
});
