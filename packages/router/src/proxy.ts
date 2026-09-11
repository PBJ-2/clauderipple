// The proxy itself.
//
//   client ──CONNECT host:port──▶ net server
//       host == upstream  → TLS terminated here (leaf cert), requests handled by an http.Server
//       anything else     → blind tunnel
//
//   per request on the terminated connection:
//       model resolves to a provider → body rewritten, sent to provider (http/https)
//       otherwise                    → forwarded to https://<upstream> with headers preserved
//
// Reliability rules (see docs/ARCHITECTURE.md §5):
//   - every request is tracked from arrival to completion and logged exactly once
//   - client abort destroys the upstream request; upstream errors answer 502 if possible
//   - connect-level upstream failures feed UpstreamHealth

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import { UpstreamHealth } from "./health.ts";
import { BOOTSTRAP_PATH, injectBootstrap } from "./bootstrap.ts";
import { effortOf, resolve, rewriteBody } from "./routing.ts";
import { ChatGptAdapter } from "./providers/chatgpt/index.ts";
import type { AnthropicRequest } from "./providers/chatgpt/translate.ts";
import { terminateHosts } from "./config.ts";
import type { CertStore } from "./certs.ts";
import { injectPickerModels, isBootstrapPath } from "./picker.ts";

const MAX_BODY = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "content-length"]);

export type ProxyDeps = {
  config: () => Config;
  log: Logger;
  /** Leaf certificates per terminated host (api.anthropic.com always; claude.ai in picker mode). */
  certs: CertStore;
  health: UpstreamHealth;
  /** ClaudeRipple home (credentials for the chatgpt provider live here). */
  home: string;
};

export type Stats = {
  inFlight: number;
  /** Subset of inFlight that are model calls (/v1/messages). Long-poll worker streams are excluded. */
  messagesInFlight: number;
  started: number;
  completed: number;
  failed: number;
};

export class Proxy {
  readonly stats: Stats = { inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 };
  private readonly inFlightSockets = new Set<Duplex>();
  private readonly server: net.Server;
  private readonly httpServer: http.Server;
  private readonly upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  private readonly providerAgents = new Map<string, http.Agent | https.Agent>();
  private readonly chatgptAdapters = new Map<string, { key: string; adapter: ChatGptAdapter }>();
  private readonly deps: ProxyDeps;

  /** Latest rate-limit snapshot reported by any chatgpt provider (for the admin GUI). */
  get chatgptRateLimits(): Record<string, Record<string, unknown> | null> {
    const out: Record<string, Record<string, unknown> | null> = {};
    for (const [name, a] of this.chatgptAdapters) out[name] = a.adapter.lastRateLimits;
    return out;
  }

  chatgptAuthStatus(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, a] of this.chatgptAdapters) out[name] = a.adapter.describeAuth();
    return out;
  }

  private chatgpt(name: string, cfg: Extract<Config["providers"][string], { type: "chatgpt" }>): ChatGptAdapter {
    const key = JSON.stringify(cfg);
    const cur = this.chatgptAdapters.get(name);
    if (cur && cur.key === key) return cur.adapter;
    const adapter = new ChatGptAdapter(name, cfg, this.deps.home, this.deps.log);
    this.chatgptAdapters.set(name, { key, adapter });
    return adapter;
  }

  constructor(deps: ProxyDeps) {
    this.deps = deps;
    this.httpServer = http.createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => {
      void this.handle(req, res);
    });
    this.httpServer.keepAliveTimeout = 65_000;
    this.httpServer.on("clientError", (err, socket) => {
      if ((err as { code?: string }).code !== "ECONNRESET" && socket.writable) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      }
      socket.destroy();
    });
    this.httpServer.on("upgrade", (req, socket, head) => this.upgrade(req, socket as net.Socket, head));
    this.server = net.createServer((sock) => this.onConnect(sock));
  }

  /** Surfaces + model ids seen in the last injected bootstrap (admin GUI / debugging). */
  lastPickerInjection: { at: string; injected: number; surfaces: { id: string; models: string[] }[] } | null = null;

  listen(): Promise<void> {
    const { host, port } = this.deps.config().listen;
    return new Promise((resolveP, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolveP();
      });
    });
  }

  close(): void {
    this.server.close();
    this.httpServer.close();
    for (const s of this.inFlightSockets) s.destroy();
  }

  /**
   * Graceful shutdown: stop accepting new connections, let in-flight model calls finish
   * (up to `maxMs`), then drop everything else. Long-poll worker streams are not waited
   * for: the CLI reconnects those on its own, while a cut /v1/messages stream surfaces as
   * "Connection lost mid-response" to the user (observed 2026-09-11, in-flight=5).
   */
  async drain(maxMs: number, onProgress?: (n: number) => void): Promise<void> {
    this.server.close();
    const t0 = Date.now();
    while (this.stats.messagesInFlight > 0 && Date.now() - t0 < maxMs) {
      onProgress?.(this.stats.messagesInFlight);
      await new Promise((r) => setTimeout(r, 250));
    }
    this.close();
  }

  // ---- CONNECT handling -------------------------------------------------------------

  private onConnect(sock: net.Socket): void {
    const log = this.deps.log;
    let head = Buffer.alloc(0);
    sock.setNoDelay(true);
    this.inFlightSockets.add(sock);
    sock.once("close", () => this.inFlightSockets.delete(sock));
    sock.on("error", (e) => log.warn(`client socket error ${(e as Error).message}`));

    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 64 * 1024) sock.destroy();
        return;
      }
      sock.off("data", onData);
      sock.pause(); // flowing mode with no listener would silently drop the client's next bytes (TLS ClientHello)
      const rest = head.subarray(end + 4);
      const line = head.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
      const [method, target] = line.split(" ");
      if (method !== "CONNECT" || !target) {
        sock.end("HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
      }
      const colon = target.lastIndexOf(":");
      const host = colon > 0 ? target.slice(0, colon) : target;
      const port = colon > 0 ? Number(target.slice(colon + 1)) : 443;
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) sock.unshift(rest);
      if (terminateHosts(this.deps.config()).includes(host)) {
        this.terminate(sock, host);
      } else {
        this.tunnel(sock, host, port);
      }
    };
    sock.on("data", onData);
  }

  private terminate(sock: net.Socket, host: string): void {
    let ctx: tls.SecureContext;
    try {
      ctx = this.deps.certs.contextFor(host);
    } catch (e) {
      this.deps.log.error(`no certificate for ${host}: ${(e as Error).message}; tunnelling instead`);
      this.tunnel(sock, host, 443);
      return;
    }
    const tlsSock = new tls.TLSSocket(sock, {
      isServer: true,
      secureContext: ctx,
      ALPNProtocols: ["http/1.1"],
      // Chromium (picker mode) sends SNI; serve whichever terminated host it names.
      SNICallback: (servername, cb) => {
        try {
          cb(null, terminateHosts(this.deps.config()).includes(servername) ? this.deps.certs.contextFor(servername) : ctx);
        } catch (e) {
          cb(e as Error);
        }
      },
    });
    tlsSock.on("error", (e) => {
      const msg = (e as Error).message;
      if (!/ECONNRESET|ended by the other party/.test(msg)) this.deps.log.warn(`tls error ${msg}`);
    });
    this.httpServer.emit("connection", tlsSock);
    sock.resume();
  }

  /** WebSocket / other upgrades on a terminated host: re-open TLS upstream and splice the sockets. */
  private upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const cfg = this.deps.config();
    const host = (req.headers.host ?? cfg.upstream).split(":")[0]!;
    const up = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ["http/1.1"] });
    const kill = (): void => {
      socket.destroy();
      up.destroy();
    };
    up.on("error", (e) => {
      this.deps.log.warn(`upgrade upstream error ${host}: ${(e as Error).message}`);
      kill();
    });
    socket.on("error", kill);
    up.once("secureConnect", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
      this.deps.log.info(`UPGRADE ${host}${req.url}`);
    });
    up.on("close", () => socket.destroy());
    socket.on("close", () => up.destroy());
  }

  private tunnel(sock: net.Socket, host: string, port: number): void {
    const up = net.connect({ host, port });
    const kill = (): void => {
      sock.destroy();
      up.destroy();
    };
    up.on("error", kill);
    sock.on("error", kill);
    up.once("connect", () => {
      sock.pipe(up);
      up.pipe(sock);
    });
    up.on("close", () => sock.destroy());
    sock.on("close", () => up.destroy());
  }

  // ---- per-request handling ----------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cfg = this.deps.config();
    const log = this.deps.log;
    const t0 = Date.now();
    const method = req.method ?? "?";
    const path = req.url ?? "/";
    this.stats.started++;
    this.stats.inFlight++;
    const isMessages = path.startsWith("/v1/messages");
    if (isMessages) this.stats.messagesInFlight++;
    let tag = "PASS";
    let finished = false;
    const finish = (status: string, bytes: number, note?: string): void => {
      if (finished) return;
      finished = true;
      this.stats.inFlight--;
      if (isMessages) this.stats.messagesInFlight--;
      if (note) this.stats.failed++;
      else this.stats.completed++;
      log.info(`${tag} ${method} ${path} -> ${status} ${bytes}B ${((Date.now() - t0) / 1000).toFixed(1)}s${note ? " " + note : ""}`);
    };

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (e) {
      finish("-", 0, `body read failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(400).end();
      return;
    }

    // Which terminated host is this request for? Only the Anthropic API host is routed;
    // anything else (claude.ai in picker mode) is passed through, with bootstrap injection.
    const reqHost = (req.headers.host ?? cfg.upstream).split(":")[0]!;
    const isApiHost = reqHost === cfg.upstream;

    // Route decision: only Messages requests carry a model.
    let json: Record<string, unknown> | null = null;
    let model: unknown;
    if (isApiHost && path.startsWith("/v1/messages")) {
      try {
        json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        model = json.model;
      } catch {
        json = null;
      }
    }
    const route = json ? resolve(model, json, cfg) : null;

    let target: { protocol: "http:" | "https:"; host: string; port: number; agent: http.Agent | https.Agent; extraHeaders: Record<string, string> };
    if (route && json) {
      const provider = cfg.providers[route.provider];
      if (!provider) {
        finish("500", 0, `unknown provider ${route.provider}`);
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "clauderipple_config", message: `unknown provider ${route.provider}` } }));
        return;
      }
      rewriteBody(json, route, cfg.effortClamp);
      if (provider.type === "chatgpt") {
        tag = `CHATGPT ${route.tag} effort=${effortOf(json) ?? "-"}`;
        try {
          const o = await this.chatgpt(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, effortOf(json));
          finish(String(o.status), o.bytes, o.note);
        } catch (e) {
          finish("-", 0, `chatgpt error ${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`);
          if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: (e as Error).message } }));
          else res.destroy();
        }
        return;
      }
      body = Buffer.from(JSON.stringify(json));
      const u = new URL(provider.url);
      const protocol = u.protocol === "https:" ? "https:" : "http:";
      target = {
        protocol,
        host: u.hostname,
        port: Number(u.port) || (protocol === "https:" ? 443 : 80),
        agent: this.agentFor(route.provider, protocol),
        extraHeaders: provider.headers ?? {},
      };
      tag = `${route.provider.toUpperCase()} ${route.tag} effort=${effortOf(json) ?? "-"}`;
    } else if (isApiHost) {
      target = { protocol: "https:", host: cfg.upstream, port: 443, agent: this.upstreamAgent, extraHeaders: {} };
      tag = `PASS ${typeof model === "string" ? model : "-"}`;
    } else {
      target = { protocol: "https:", host: reqHost, port: 443, agent: this.agentFor(`host:${reqHost}`, "https:"), extraHeaders: {} };
      tag = `WEB ${reqHost}`;
    }

    // Two kinds of response editing: the CLI bootstrap (api host) and the claude.ai bootstrap (picker mode).
    const isCliBootstrap = isApiHost && !route && path.startsWith(BOOTSTRAP_PATH);
    const isPickerBootstrap = !isApiHost && !!cfg.picker?.enabled && method === "GET" && isBootstrapPath(path);
    const isBootstrap = isCliBootstrap || isPickerBootstrap;
    const headers: string[] = [];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i]!;
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (isBootstrap && lk === "accept-encoding") continue; // need a plain body to edit
      if (lk in target.extraHeaders) continue;
      headers.push(k, raw[i + 1]!);
    }
    for (const [k, v] of Object.entries(target.extraHeaders)) headers.push(k, v);
    headers.push("host", target.protocol === "https:" && target.port === 443 ? target.host : `${target.host}:${target.port}`);
    headers.push("content-length", String(body.length));

    const lib = target.protocol === "https:" ? https : http;
    const upReq = lib.request({
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      method,
      path,
      headers,
      agent: target.agent,
      ...(target.protocol === "https:" ? { servername: target.host } : {}),
    });

    const abortUpstream = (): void => {
      if (!upReq.destroyed) upReq.destroy();
    };
    req.on("aborted", abortUpstream);
    res.on("close", () => {
      if (!finished) {
        abortUpstream();
        finish("-", 0, "client closed");
      }
    });

    upReq.on("error", (e) => {
      if (target.host === cfg.upstream) this.deps.health.failure(e);
      finish("-", 0, `upstream error ${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: { type: "clauderipple_upstream", message: `${target.host}: ${(e as Error).message}` } }));
      } else {
        res.destroy();
      }
    });

    upReq.on("response", (upRes) => {
      if (target.host === cfg.upstream) this.deps.health.success();
      const status = upRes.statusCode ?? 0;
      const outHeaders: string[] = [];
      const r = upRes.rawHeaders;
      for (let i = 0; i < r.length; i += 2) {
        const lk = r[i]!.toLowerCase();
        if (lk === "connection" || lk === "keep-alive" || lk === "transfer-encoding") continue;
        if (isBootstrap && (lk === "content-length" || lk === "content-encoding")) continue;
        outHeaders.push(r[i]!, r[i + 1]!);
      }
      let bytes = 0;
      if (isBootstrap) {
        const chunks: Buffer[] = [];
        upRes.on("data", (c: Buffer) => chunks.push(c));
        upRes.on("end", () => {
          let out: Buffer = Buffer.concat(chunks);
          if (status === 200 && isCliBootstrap) {
            try {
              out = injectBootstrap(out, cfg);
            } catch (e) {
              log.warn(`bootstrap inject failed: ${(e as Error).message}`);
            }
          } else if (status === 200 && isPickerBootstrap) {
            try {
              const j = JSON.parse(out.toString("utf8")) as Record<string, unknown>;
              const r = injectPickerModels(j, cfg.cli.extraModels, cfg.cli.autoCompactWindow);
              this.lastPickerInjection = { at: new Date().toISOString(), ...r };
              if (r.surfaces.length > 0) {
                out = Buffer.from(JSON.stringify(j));
                log.info(`PICKER injected ${r.injected} model(s); surfaces: ${r.surfaces.map((s) => `${s.id}[${s.models.length}]`).join(" ")}`);
              } else {
                log.info(`PICKER bootstrap had no model_selector_config (${path.slice(0, 60)})`);
              }
            } catch (e) {
              log.warn(`picker inject failed: ${(e as Error).message}`);
            }
          }
          outHeaders.push("content-length", String(out.length));
          res.writeHead(status, outHeaders);
          res.end(out);
          finish(String(status), out.length);
        });
        upRes.on("error", (e) => {
          finish(String(status), bytes, `upstream stream error ${(e as Error).message}`);
          res.destroy();
        });
        return;
      }
      res.writeHead(status, outHeaders);
      upRes.on("data", (c: Buffer) => {
        bytes += c.length;
        if (!res.write(c)) upRes.pause();
      });
      res.on("drain", () => upRes.resume());
      upRes.on("end", () => {
        res.end();
        finish(String(status), bytes);
      });
      upRes.on("error", (e) => {
        finish(String(status), bytes, `upstream stream error ${(e as Error).message}`);
        res.destroy();
      });
    });

    upReq.end(body);
  }

  private agentFor(provider: string, protocol: "http:" | "https:"): http.Agent | https.Agent {
    const key = `${provider}|${protocol}`;
    let a = this.providerAgents.get(key);
    if (!a) {
      a = protocol === "https:" ? new https.Agent({ keepAlive: true, maxSockets: 64 }) : new http.Agent({ keepAlive: true, maxSockets: 64 });
      this.providerAgents.set(key, a);
    }
    return a;
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveP(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
