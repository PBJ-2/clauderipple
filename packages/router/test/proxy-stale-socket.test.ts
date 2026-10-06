// A kept-alive upstream socket can be closed by the upstream just as the next request is written
// on it. The reset arrives before any response, so the request never reached the upstream: an
// idempotent one is sent again on a fresh socket instead of becoming a 502, and a POST is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function staleRig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-stale-socket-"));
  const ca = createCa({ cn: "clauderipple stale socket test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);

  // Every socket answers its first request and resets on its second: what a kept-alive socket the
  // upstream has already given up on looks like from the client side.
  const served = new WeakMap<object, number>();
  let answered = 0;
  let reset = 0;
  const upstream = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    const n = (served.get(req.socket) ?? 0) + 1;
    served.set(req.socket, n);
    if (n > 1) {
      reset++;
      req.socket.destroy();
      return;
    }
    answered++;
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;

  const proxyPort = await freePort();
  const cfg: Config = { ...DEFAULTS, upstream: "localhost", listen: { host: "127.0.0.1", port: proxyPort }, providers: {}, routes: {}, direct: [] };
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests: new RequestLog(path.join(home, "requests.jsonl")),
    upstreamPort,
    upstreamAgent: new https.Agent({ ca: ca.certPem, keepAlive: true, maxSockets: 1 }),
  });
  await proxy.listen();

  const send = async (method: string): Promise<number> => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve) => socket.once("data", resolve));
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve) => secure.once("secureConnect", resolve));
    secure.write(`${method} /api/bootstrap HTTP/1.1\r\nHost: localhost\r\ncontent-length: 0\r\n\r\n`);
    const first = await new Promise<Buffer>((resolve) => secure.once("data", resolve));
    secure.destroy();
    return Number(/^HTTP\/1\.1 (\d{3})/.exec(first.toString("latin1"))?.[1] ?? 0);
  };

  return {
    send,
    counts: () => ({ answered, reset }),
    stop: async () => {
      proxy.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a GET that meets a stale kept-alive socket is resent and answered, not a 502", async () => {
  const rig = await staleRig();
  try {
    assert.equal(await rig.send("GET"), 200);
    assert.equal(await rig.send("GET"), 200, "the second GET lands on the reused socket, is reset, and is resent");
    assert.deepEqual(rig.counts(), { answered: 2, reset: 1 });
  } finally {
    await rig.stop();
  }
});

test("a POST that meets a stale kept-alive socket is not resent", async () => {
  const rig = await staleRig();
  try {
    assert.equal(await rig.send("GET"), 200);
    assert.equal(await rig.send("POST"), 502);
    assert.deepEqual(rig.counts(), { answered: 1, reset: 1 });
  } finally {
    await rig.stop();
  }
});
