// End-to-end probe: CONNECT through the router, complete TLS against its leaf cert
// using only our CA, and fetch a cheap Anthropic path. 401 from Anthropic is a pass:
// it proves termination + passthrough without any credentials.

import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";

export type ProbeResult = { ok: boolean; detail: string; ms: number };

export function probe(opts: { host: string; port: number; caPem: string; upstream: string; path?: string; timeoutMs?: number }): Promise<ProbeResult> {
  const t0 = Date.now();
  const path = opts.path ?? "/api/claude_cli/bootstrap";
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, detail: string): void => {
      if (done) return;
      done = true;
      resolve({ ok, detail, ms: Date.now() - t0 });
      sock.destroy();
    };
    const sock = net.connect({ host: opts.host, port: opts.port });
    const timer = setTimeout(() => finish(false, "timeout"), opts.timeoutMs ?? 8000);
    sock.on("error", (e) => finish(false, `router unreachable: ${e.message}`));
    sock.once("connect", () => {
      sock.write(`CONNECT ${opts.upstream}:443 HTTP/1.1\r\nHost: ${opts.upstream}:443\r\n\r\n`);
    });
    sock.once("data", (d: Buffer) => {
      const line = d.toString("latin1").split("\r\n")[0] ?? "";
      if (!/^HTTP\/1\.[01] 200/.test(line)) return finish(false, `CONNECT refused: ${line}`);
      let ca: Buffer;
      try {
        ca = fs.readFileSync(opts.caPem);
      } catch (e) {
        return finish(false, `cannot read CA: ${(e as Error).message}`);
      }
      const t = tls.connect({ socket: sock, servername: opts.upstream, ca }, () => {
        if (!t.authorized) return finish(false, `TLS not authorized: ${t.authorizationError}`);
        t.write(`GET ${path} HTTP/1.1\r\nHost: ${opts.upstream}\r\nConnection: close\r\n\r\n`);
      });
      let resp = "";
      t.on("data", (c: Buffer) => {
        resp += c.toString("latin1");
        const status = resp.split("\r\n")[0] ?? "";
        if (/^HTTP\/1\.[01] \d{3}/.test(status)) {
          clearTimeout(timer);
          const code = Number(status.split(" ")[1]);
          finish(code === 401 || code === 200, `upstream answered ${status}`);
        }
      });
      t.on("error", (e) => finish(false, `TLS error: ${e.message}`));
      t.on("end", () => finish(false, "connection closed without a status line"));
    });
  });
}
