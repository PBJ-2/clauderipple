// A google provider is a normal translated provider: the real proxy must route a declared model to
// it over CONNECT/TLS, tag the request log GOOGLE, and refuse a `thread: continue` the way the other
// threadless providers do (§4d). Drives the real proxy, the way Claude Code reaches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import { createCa } from "../src/x509.ts";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type Rig = { home: string; send: (body: unknown, path?: string) => Promise<{ status: number; body: string }>; records: () => RequestRecord[]; stop: () => Promise<void>; seen: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] };

async function rig(): Promise<Rig> {
  const seen: Rig["seen"] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          { candidates: [{ content: { parts: [{ text: "Hi" }] } }] },
          { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } },
        ]
          .map((record) => `data: ${JSON.stringify(record)}\n\n`)
          .join(""),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-proxy-google-"));
  const ca = createCa({ cn: "clauderipple google test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const proxyPort = await freePort();
  const cfg: Config = {
    ...DEFAULTS,
    listen: { host: "127.0.0.1", port: proxyPort },
    providers: { google: { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}`, models: [{ id: "gemini-3-pro-preview" }] } },
    routes: {},
    direct: [],
    aliases: {},
  };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests,
    agentDir: path.join(home, "agents"),
  });
  await proxy.listen();

  const send = async (body: unknown, pathName = "/v1/messages"): Promise<{ status: number; body: string }> => {
    const sock = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
    await new Promise<void>((r) => sock.once("data", () => r()));
    const secure = tls.connect({ socket: sock, servername: "api.anthropic.com", ca: ca.certPem });
    await new Promise<void>((r) => secure.once("secureConnect", () => r()));
    const raw = JSON.stringify(body);
    secure.write(
      `POST ${pathName} HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`,
    );
    // Anthropic streams chunked; wait for the terminal message_stop (or a short settle) so the whole
    // SSE body is present before we assert on it.
    const text = await new Promise<string>((resolve, reject) => {
      let received = "";
      let settle: NodeJS.Timeout | undefined;
      secure.on("data", (d: Buffer) => {
        received += d.toString("latin1");
        if (/message_stop|"type":"error"/.test(received)) return resolve(received);
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => resolve(received), 150);
      });
      secure.once("error", reject);
    });
    secure.destroy();
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
    const split = text.indexOf("\r\n\r\n");
    const head = split >= 0 ? text.slice(0, split) : "";
    let raw2 = split >= 0 ? text.slice(split + 4) : "";
    if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) {
      let out = "";
      let offset = 0;
      while (offset < raw2.length) {
        const lineEnd = raw2.indexOf("\r\n", offset);
        if (lineEnd < 0) break;
        const length = Number.parseInt(raw2.slice(offset, lineEnd), 16);
        if (!Number.isFinite(length) || length === 0) break;
        const start = lineEnd + 2;
        out += raw2.slice(start, start + length);
        offset = start + length + 2;
      }
      raw2 = out;
    }
    return { status, body: raw2 };
  };

  return {
    home,
    send,
    records: () => requests.list(20),
    seen,
    stop: async () => {
      proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a declared google model is routed to the provider over TLS and logged GOOGLE", async () => {
  const r = await rig();
  try {
    const { status, body } = await r.send({ model: "gemini-3-pro-preview", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(status, 200);
    assert.match(body, /"stop_reason":"end_turn"/);
    const sent = r.seen.at(-1)!;
    assert.equal(sent.path, "/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse");
    assert.equal(sent.headers["x-goog-api-key"], "test-key");
    assert.equal(sent.body.model, undefined, "the model is in the path, not the body");
    const rec = r.records().find((x) => x.kind === "messages")!;
    assert.equal(rec.provider, "google");
    assert.equal(rec.target, "gemini-3-pro-preview");
    assert.equal(rec.ok, true);
  } finally {
    await r.stop();
  }
});

test("a google model is refused a web_search side request, not sent upstream", async () => {
  const r = await rig();
  try {
    const before = r.seen.length;
    const { status, body } = await r.send({
      model: "gemini-3-pro-preview",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "Perform a web search for the query: latest Node.js 24 release" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      tool_choice: { type: "auto" },
    });
    // Answered with a visible "unavailable" result, not prose shaped like an answer, and nothing sent.
    assert.equal(status, 200);
    assert.equal(r.seen.length, before, "nothing was sent upstream");
    const rec = r.records().find((x) => x.kind === "messages")!;
    assert.match(rec.note ?? "", /web search refused/);
  } finally {
    await r.stop();
  }
});

test("a thread: continue to a google provider is refused 400, not forwarded", async () => {
  const r = await rig();
  try {
    const before = r.seen.length;
    const { status, body } = await r.send({
      model: "gemini-3-pro-preview",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      thread: { type: "continue", id: "t1" },
    });
    assert.equal(status, 400);
    assert.match(body, /without server-side threads/);
    assert.equal(r.seen.length, before, "nothing was sent upstream");
  } finally {
    await r.stop();
  }
});
