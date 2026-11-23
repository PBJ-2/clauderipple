// Phone photos through the proxy: an un-routed Claude turn is given the picture of this session's photo,
// and when the API refuses it the turn is sent again as text and the file stays text.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
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
import { photoLine } from "../../remote/src/mod-photos.ts";

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);
const SESSION = "aaaaaaaa-1111-4222-8333-444444444444";

async function rig(t: TestContext, refuse: (body: string) => boolean = () => false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-photo-proxy-"));
  const root = path.join(home, "mod-photos");
  const ca = createCa({ cn: "photo test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const seen: { raw: string; length: string | undefined }[] = [];
  const origin = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({ raw, length: req.headers["content-length"] });
      if (refuse(raw)) { res.writeHead(400, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1.image.source.base64: image exceeds 5 MB maximum"}}'); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const relay = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ raw: Buffer.concat(chunks).toString("utf8"), length: req.headers["content-length"] });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_2", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const probe = net.createServer();
  await Promise.all([origin, relay, probe].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const cfg: Config = { ...DEFAULTS, upstream: "localhost", listen: { host: "127.0.0.1", port }, admin: { port: 0 }, direct: [], aliases: {},
    routes: { "claude-routed-x": { provider: "relay", model: "text-model" } },
    providers: { relay: { type: "anthropic-compatible", url: `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}`, headers: { "x-api-key": "k" } } } };
  const agent = new https.Agent({ ca: ca.certPem, lookup: (_host, _options, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]) });
  const proxy = new Proxy({ config: () => cfg, home, log: new Logger(path.join(home, "router.log"), 1e6, 1, false), requests: new RequestLog(path.join(home, "requests.jsonl")),
    certs: new CertStore(home), agentDir: path.join(home, "agents"), health: new UpstreamHealth(() => 100, () => {}), upstreamPort: (origin.address() as net.AddressInfo).port,
    upstreamAgent: agent, claudeProfileFetch: async () => new Response("{}", { status: 404 }), modPhotosRoot: root });
  await proxy.listen();
  t.after(async () => { proxy.close(); agent.destroy(); for (const server of [origin, relay]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } if (process.env.KEEP) console.log(home); else fs.rmSync(home, { recursive: true, force: true }); });

  const clients: tls.TLSSocket[] = [];
  async function send(body: Record<string, unknown>, session: string | null = SESSION): Promise<{ status: number }> {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve, reject) => { socket.once("data", () => resolve()); socket.once("error", reject); });
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    clients.push(secure);
    await new Promise<void>((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
    const raw = JSON.stringify(body);
    const answer = new Promise<{ status: number }>((resolve, reject) => {
      let text = "";
      secure.on("data", chunk => { text += chunk.toString(); });
      secure.once("end", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0) }));
      secure.once("error", reject);
      secure.setTimeout(10000, () => { secure.destroy(); reject(new Error("no response")); });
    });
    secure.write(`POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${session ? `x-claude-code-session-id: ${session}\r\n` : ""}authorization: Bearer original\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`);
    return answer;
  }
  const photo = (session = SESSION, name = "item-1.png") => {
    const file = path.join(root, session, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PNG);
    return file;
  };
  const turn = (file: string, model = "claude-opus-5-5") => ({ model, max_tokens: 10, messages: [{ role: "user", content: [{ type: "text", text: `Look\n\n${photoLine(file)}` }] }] });
  const content = (index: number) => (JSON.parse(seen[index]!.raw) as { messages: { content: { type: string; text?: string }[] }[] }).messages[0]!.content;
  return { home, seen, send, photo, turn, content, proxy, clients };
}

test("an un-routed Claude turn is given its own session's photo as an image, with the text unchanged", async t => {
  const r = await rig(t);
  const file = r.photo();
  assert.equal((await r.send(r.turn(file))).status, 200);
  assert.deepEqual(r.content(0).map(block => block.type), ["text", "image"]);
  assert.equal(r.content(0)[0]!.text, `Look\n\n${photoLine(file)}`);
  assert.equal(r.seen[0]!.length, String(Buffer.byteLength(r.seen[0]!.raw)), "the length sent is the length of the body with the image");
});

test("a photo of another session, a request without a session, and a relay model get the line only", async t => {
  const r = await rig(t);
  const theirs = r.photo("bbbbbbbb-1111-4222-8333-444444444444");
  assert.equal((await r.send(r.turn(theirs))).status, 200);
  const own = r.photo();
  assert.equal((await r.send(r.turn(own), null)).status, 200);
  assert.equal((await r.send(r.turn(own, "claude-routed-x"))).status, 200);
  assert.equal(r.seen.length, 3);
  for (let i = 0; i < 3; i++) assert.deepEqual(r.content(i).map(block => block.type), ["text"], `request ${i}`);
});

test("an image the API refuses is sent again as text once, the file stays text, and later replays read the same", async t => {
  const r = await rig(t, raw => raw.includes('"type":"image"'));
  const file = r.photo();
  assert.equal((await r.send(r.turn(file))).status, 200, "the client is answered on its first ask");
  assert.deepEqual(r.seen.map((_, i) => r.content(i).map(block => block.type)), [["text", "image"], ["text"]]);
  assert.equal(r.seen[1]!.length, String(Buffer.byteLength(r.seen[1]!.raw)), "the resent body has its own length");
  assert.equal(r.content(1)[0]!.text, `Look\n\n${photoLine(file)}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.home, "photo-blocked.json"), "utf8")), [file]);
  // The same history again, as the next turn sends it: no image, no refused attempt.
  assert.equal((await r.send(r.turn(file))).status, 200);
  assert.equal(r.seen.length, 3);
  assert.equal(r.seen[2]!.raw, r.seen[1]!.raw, "the replay is the retry's request byte for byte");
});

test("a client that leaves while the photo is being read gets no upstream call, and the request is released", async t => {
  const r = await rig(t);
  const file = r.photo();
  const readFile = fsp.readFile;
  let reads = 0;
  // The first read of the photo is held until the client has hung up and the router has seen it close.
  (fsp as { readFile: unknown }).readFile = async (...args: Parameters<typeof readFile>) => {
    if (args[0] === file) {
      reads++;
      r.clients.at(-1)!.destroy();
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return readFile(...args);
  };
  t.after(() => { (fsp as { readFile: unknown }).readFile = readFile; });
  void r.send(r.turn(file)).catch(() => {});
  const deadline = Date.now() + 5000;
  while (r.proxy.stats.started === 0 || r.proxy.stats.inFlight > 0) {
    if (Date.now() > deadline) assert.fail("the request was never released");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(reads, 1, "the photo was being read when the client left");
  assert.equal(r.seen.length, 0, "nothing was sent upstream");
  assert.equal(r.proxy.stats.inFlight, 0);
  assert.equal(r.proxy.stats.messagesInFlight, 0);
});

test("when the turn without images is refused too, the images are not blamed: nothing is recorded", async t => {
  const r = await rig(t, () => true);
  const file = r.photo();
  assert.equal((await r.send(r.turn(file))).status, 400, "the second refusal is returned as it is");
  assert.deepEqual(r.seen.map((_, i) => r.content(i).map(block => block.type)), [["text", "image"], ["text"]]);
  assert.equal(fs.existsSync(path.join(r.home, "photo-blocked.json")), false);
});
