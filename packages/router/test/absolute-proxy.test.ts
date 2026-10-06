import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { absoluteProxyRequest, Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { createCa, createLeaf } from "../src/x509.ts";

test("rewrites Remote Control HTTPS absolute-form registration", () => {
  const parsed = absoluteProxyRequest(Buffer.from(
    "POST https://api.anthropic.com/v1/environments/bridge?source=cli HTTP/1.1\r\n" +
      "Host: wrong.example\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: secret\r\nAuthorization: Bearer retained\r\nContent-Length: 2",
    "latin1",
  ));
  assert.ok(parsed);
  assert.equal(parsed.host, "api.anthropic.com");
  assert.equal(parsed.port, 443);
  const head = parsed.head.toString("latin1");
  assert.match(head, /^POST \/v1\/environments\/bridge\?source=cli HTTP\/1\.1\r\n/);
  assert.match(head, /\r\nHost: api\.anthropic\.com\r\n/);
  assert.match(head, /Authorization: Bearer retained/);
  assert.match(head, /\r\nConnection: close\r\n/);
  assert.doesNotMatch(head, /Proxy-(?:Connection|Authorization)/i);
  assert.doesNotMatch(head, /wrong\.example/);
});

test("accepts explicit ports and plain HTTP, and rejects unsafe or other-scheme targets", () => {
  const explicit = absoluteProxyRequest(Buffer.from("GET https://example.com:8443/x HTTP/1.1\r\nHost: example.com"));
  assert.equal(explicit?.port, 8443);
  assert.equal(explicit?.host, "example.com");
  assert.equal(explicit?.path, "/x");
  assert.equal(explicit?.tls, true);
  const ipv6 = absoluteProxyRequest(Buffer.from("GET https://[::1]:8443/x HTTP/1.1\r\nHost: wrong"));
  assert.equal(ipv6?.host, "::1");
  assert.match(ipv6?.head.toString("latin1") ?? "", /\r\nHost: \[::1\]:8443\r\n/);
  const plain = absoluteProxyRequest(Buffer.from("GET http://example.com/x HTTP/1.1\r\nHost: example.com"));
  assert.equal(plain?.tls, false);
  assert.equal(plain?.port, 80);
  assert.equal(absoluteProxyRequest(Buffer.from("GET ftp://example.com/x HTTP/1.1\r\nHost: example.com")), null);
  assert.equal(absoluteProxyRequest(Buffer.from("GET https://user:pass@example.com/x HTTP/1.1\r\nHost: example.com")), null);
  assert.equal(absoluteProxyRequest(Buffer.from("GET https://example.com/x#fragment HTTP/1.1\r\nHost: example.com")), null);
  assert.equal(absoluteProxyRequest(Buffer.from("GET https://example.com/x HTTP/2.0\r\nHost: example.com")), null);
  assert.equal(absoluteProxyRequest(Buffer.from("BROKEN\r\nHost: example.com")), null);
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

test("a live absolute-form request reaches the TLS origin with its body and closes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-absolute-"));
  const ca = createCa({ cn: "clauderipple absolute proxy test" });
  const leaf = createLeaf({ host: "api.anthropic.com", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  let seen = "";
  const upstream = tls.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (socket) => {
    socket.on("data", (chunk) => {
      seen += chunk.toString("latin1");
      const split = seen.indexOf("\r\n\r\n");
      const length = Number(/\r\nContent-Length:\s*(\d+)/i.exec(seen.slice(0, split))?.[1] ?? 0);
      if (split >= 0 && Buffer.byteLength(seen.slice(split + 4), "latin1") >= length) {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const proxyPort = await freePort();
  const cfg: Config = { ...DEFAULTS, listen: { host: "127.0.0.1", port: proxyPort } };
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests: new RequestLog(path.join(home, "requests.jsonl")),
    tlsConnect: (options) => tls.connect({ ...options, host: "127.0.0.1", port: upstreamPort, ca: ca.certPem }),
  });
  await proxy.listen();
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1");
      let received = "";
      socket.on("connect", () => socket.write(
        "POST https://api.anthropic.com/v1/environments/bridge?source=cli HTTP/1.1\r\n" +
        "Host: wrong.example\r\nProxy-Authorization: secret\r\nAuthorization: Bearer retained\r\n" +
        "Content-Length: 2\r\n\r\n{}",
      ));
      socket.on("data", (chunk) => { received += chunk.toString("latin1"); });
      socket.on("end", () => resolve(received));
      socket.on("error", reject);
    });
    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(seen, /^POST \/v1\/environments\/bridge\?source=cli HTTP\/1\.1\r\n/);
    assert.match(seen, /\r\nHost: api\.anthropic\.com\r\n/);
    assert.match(seen, /\r\nAuthorization: Bearer retained\r\n/);
    assert.doesNotMatch(seen, /Proxy-Authorization/i);
    assert.equal(seen.slice(seen.indexOf("\r\n\r\n") + 4), "{}");
  } finally {
    proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Claude Code 2.1.288 sends plain-http requests through HTTPS_PROXY too, loopback included: the
// status mod's read of the admin API (http://127.0.0.1:8792) reached the proxy and got 405.
test("a live plain-HTTP absolute-form request reaches a loopback origin", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-absolute-http-"));
  const ca = createCa({ cn: "clauderipple absolute proxy test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  let seen = "";
  const origin = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      seen += chunk.toString("latin1");
      if (seen.includes("\r\n\r\n")) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{"requests":[]}');
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as net.AddressInfo).port;
  const proxyPort = await freePort();
  const cfg: Config = { ...DEFAULTS, listen: { host: "127.0.0.1", port: proxyPort } };
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests: new RequestLog(path.join(home, "requests.jsonl")),
  });
  await proxy.listen();
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1");
      let received = "";
      socket.on("connect", () => socket.write(
        `GET http://127.0.0.1:${originPort}/api/requests?kind=messages&n=1 HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nProxy-Connection: keep-alive\r\n\r\n`,
      ));
      socket.on("data", (chunk) => { received += chunk.toString("latin1"); });
      socket.on("end", () => resolve(received));
      socket.on("error", reject);
    });
    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.match(response, /\{"requests":\[\]\}$/);
    assert.match(seen, /^GET \/api\/requests\?kind=messages&n=1 HTTP\/1\.1\r\n/);
    assert.match(seen, new RegExp(`\\r\\nHost: 127\\.0\\.0\\.1:${originPort}\\r\\n`));
    assert.doesNotMatch(seen, /Proxy-Connection/i);
  } finally {
    proxy.close();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
