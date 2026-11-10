// CONNECT validation must precede both the success response and any TLS/TCP dispatch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";

for (const host of ["127.0.0.1", "api.anthropic.com"]) {
  for (const port of ["bad", "65536", "0", "-1", "1.5", "", "1", "65535", undefined]) {
    const valid = port === undefined || port === "1" || port === "65535";
    const target = port === undefined ? host : `${host}:${port}`;
    test(`CONNECT ${target} ${valid ? "preserves valid dispatch" : "is rejected before success or dispatch"}`, (t) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-connect-"));
      const proxy = new Proxy({
        config: () => DEFAULTS,
        log: new Logger(null, 1e6, 1, false),
        certs: new CertStore(home),
        health: new UpstreamHealth(() => 100, () => {}),
        home,
        requests: new RequestLog(path.join(home, "requests.jsonl")),
      });
      const socket = new net.Socket();
      const replies: string[] = [];
      t.mock.method(socket, "write", (data: string) => { replies.push(data); return true; });
      t.mock.method(socket, "end", (data: string) => { replies.push(data); return socket; });
      // Emit synchronously so the original net.connect RangeError is an assertion failure, not an
      // uncaught exception in the test runner. No listener is opened and no valid target is dialled.
      const connect = proxy as unknown as {
        onConnect: (socket: net.Socket) => void;
        terminate: (socket: net.Socket, host: string) => void;
        tunnel: (socket: net.Socket, host: string, port: number) => void;
      };
      const terminate = t.mock.method(connect, "terminate", () => {});
      const tunnel = valid ? t.mock.method(connect, "tunnel", () => {}) : undefined;
      try {
        connect.onConnect(socket);
        assert.doesNotThrow(() => socket.emit("data", Buffer.from(`CONNECT ${target} HTTP/1.1\r\n\r\n`)));
        if (valid) {
          assert.equal(replies.join(""), "HTTP/1.1 200 Connection Established\r\n\r\n");
          assert.equal(terminate.mock.callCount(), host === "api.anthropic.com" ? 1 : 0);
          assert.equal(tunnel!.mock.callCount(), host === "127.0.0.1" ? 1 : 0);
          const args = host === "api.anthropic.com" ? terminate.mock.calls[0]!.arguments : tunnel!.mock.calls[0]!.arguments;
          assert.equal(args[1], host);
          if (host === "127.0.0.1") assert.equal(args[2], port === undefined ? 443 : Number(port));
        } else {
          assert.match(replies.join(""), /^HTTP\/1\.1 400 Bad Request\r\n/);
          assert.doesNotMatch(replies.join(""), /200 Connection Established/);
          assert.equal(terminate.mock.callCount(), 0, "invalid ports never reach TLS termination");
        }
      } finally {
        socket.destroy();
        proxy.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
}
