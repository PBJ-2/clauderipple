// A routed request must authenticate as the provider and only as the provider. The caller's own
// Anthropic credentials are dropped: the provider header replaces only the one it shares a name
// with, so before this was enforced the other one travelled on to a third-party endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy, errorSnippet } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import zlib from "node:zlib";
import { createCa } from "../src/x509.ts";

const CLIENT_TOKEN = "Bearer sk-ant-oat01-CLIENTTOKEN";
const CLIENT_KEY = "CLIENT-X-API-KEY";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type ProviderReply = { status: number; headers: Record<string, string>; body: Buffer };
const OK_REPLY: ProviderReply = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [], model: "x", usage: {} })),
};

/** Sends one routed /v1/messages through the proxy; returns the headers the provider saw. */
async function forwardedHeaders(providerHeaders: Record<string, string>): Promise<http.IncomingHttpHeaders> {
  return (await roundTrip(providerHeaders, OK_REPLY)).seen;
}

/** One routed request against a provider that answers `reply`; returns what it saw and what was logged. */
async function roundTrip(providerHeaders: Record<string, string>, reply: ProviderReply): Promise<{ seen: http.IncomingHttpHeaders; records: RequestRecord[]; clientStatus: number }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-proxy-headers-"));
  const ca = createCa({ cn: "clauderipple test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);

  let seen: http.IncomingHttpHeaders = {};
  const provider = http.createServer((req, res) => {
    seen = req.headers;
    req.resume();
    req.on("end", () => {
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const providerPort = (provider.address() as net.AddressInfo).port;
  const proxyPort = await freePort();

  const cfg: Config = {
    ...DEFAULTS,
    listen: { host: "127.0.0.1", port: proxyPort },
    providers: { p: { type: "anthropic-compatible", url: `http://127.0.0.1:${providerPort}/anthropic`, headers: providerHeaders } as Provider },
    routes: { "claude-opus-4-8": { provider: "p", model: "some-model" } },
    direct: [],
  };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    // A file, not null: a Logger with no file echoes every line to stdout.
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests,
  });
  await proxy.listen();

  const sock = net.connect(proxyPort, "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
  await new Promise<void>((r) => sock.once("data", () => r()));
  const secure = tls.connect({ socket: sock, servername: "api.anthropic.com", ca: ca.certPem });
  await new Promise<void>((r) => secure.once("secureConnect", () => r()));

  const body = JSON.stringify({ model: "claude-opus-4-8", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
  secure.write(
    "POST /v1/messages HTTP/1.1\r\n" +
      "Host: api.anthropic.com\r\n" +
      "content-type: application/json\r\n" +
      `authorization: ${CLIENT_TOKEN}\r\n` +
      `x-api-key: ${CLIENT_KEY}\r\n` +
      "anthropic-version: 2023-06-01\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
  const first = await new Promise<Buffer>((r) => secure.once("data", (d: Buffer) => setTimeout(() => r(d), 50)));
  const clientStatus = Number(/^HTTP\/1\.1 (\d{3})/.exec(first.toString("latin1"))?.[1] ?? 0);

  secure.destroy();
  proxy.close();
  await new Promise<void>((r) => provider.close(() => r()));
  const records = requests.list(10);
  fs.rmSync(home, { recursive: true, force: true });
  return { seen, records, clientStatus };
}

test("an x-api-key provider never receives the caller's authorization header", async () => {
  const seen = await forwardedHeaders({ "x-api-key": "PROVIDER-KEY" });
  assert.equal(seen["x-api-key"], "PROVIDER-KEY");
  assert.equal(seen.authorization, undefined);
});

test("a bearer provider never receives the caller's x-api-key header", async () => {
  const seen = await forwardedHeaders({ authorization: "Bearer PROVIDER-KEY" });
  assert.equal(seen.authorization, "Bearer PROVIDER-KEY");
  assert.equal(seen["x-api-key"], undefined);
});

// The status code alone left a DeepSeek 401 unexplained for a day; the body says which key was
// refused. It is kept masked: a provider that echoes a whole key must not put it in the log.
test("a provider error body is recorded with credentials masked, and still reaches the client", async () => {
  const body = Buffer.from(JSON.stringify({ error: { message: "Authentication Fails, Your api key: sk-abcdef0123456789 is invalid", type: "authentication_error" } }));
  const { records, clientStatus } = await roundTrip({ "x-api-key": "PROVIDER-KEY" }, { status: 401, headers: { "content-type": "application/json" }, body });
  assert.equal(clientStatus, 401);
  const record = records.find((r) => r.kind === "messages");
  assert.ok(record, "the request was logged");
  assert.equal(record.ok, false);
  assert.match(record.note ?? "", /^upstream 401: .*Authentication Fails/);
  assert.match(record.note ?? "", /\[REDACTED\] is invalid/);
  assert.doesNotMatch(record.note ?? "", /sk-abcdef/);
});

test("errorSnippet decodes gzip, masks bearer tokens and explicit opaque credentials, and bounds its length", () => {
  const gz = zlib.gzipSync(Buffer.from('{"error":"token Bearer sk-ant-oat01-SECRETSECRET1234 expired"}'));
  const s = errorSnippet(gz, "gzip");
  assert.match(s, /Bearer \[REDACTED\] expired/);
  assert.doesNotMatch(s, /SECRET/);
  const opaque = "vendor_key_not_matching_a_known_pattern";
  const reflected = errorSnippet(Buffer.from(`provider rejected ${opaque}`), undefined, [opaque]);
  assert.match(reflected, /provider rejected \[REDACTED\]/);
  assert.doesNotMatch(reflected, /vendor_key/);
  assert.equal(errorSnippet(Buffer.alloc(0), undefined), "(empty body)");
  assert.ok(errorSnippet(Buffer.from("x".repeat(1000)), undefined).length <= 301);
});

test("non-credential headers still reach the provider", async () => {
  const seen = await forwardedHeaders({ "x-api-key": "PROVIDER-KEY" });
  assert.equal(seen["anthropic-version"], "2023-06-01");
});
