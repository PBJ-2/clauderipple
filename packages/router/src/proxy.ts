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

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import type { Duplex } from "node:stream";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import { UpstreamHealth } from "./health.ts";
import { BOOTSTRAP_PATH, injectBootstrap } from "./bootstrap.ts";
import { THREAD_UNSUPPORTED, effortOf, resolve, rewriteBody, stripThreadFields, threadDecision } from "./routing.ts";
import { forwardCompatibleHeader, resolveCompatibleCaps, sanitizeForCompatible } from "./compat.ts";
import { applyIdentityToAnthropicBody } from "./identity.ts";
import { webPluginBackend, webSearchBlocks, webSearchMessage, webSearchQuery, webSearchSse, type WebSearchQuery } from "./websearch.ts";
import { PRESETS } from "./presets.ts";
import { ChatGptAdapter } from "./providers/chatgpt/index.ts";
import { OpenAiCompatibleAdapter } from "./providers/openai/index.ts";
import type { AnthropicRequest } from "./providers/chatgpt/translate.ts";
import { terminateHosts } from "./config.ts";
import type { CertStore } from "./certs.ts";
import { injectPickerModels, isBootstrapPath } from "./picker.ts";
import { ResponseUsageTap, type RequestLog, type RequestRecord, type RequestUsage } from "./requestlog.ts";
import { credentialHeaderValues, redactErrorText, redactHeaders } from "./redact.ts";
import type { ObservedClaudeCodeAuth } from "./providers/anthropic-observed.ts";

const MAX_BODY = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "content-length"]);
// The caller's own Anthropic credentials. A routed request authenticates as the provider, so these
// are dropped rather than forwarded: the provider header replaces only the one it happens to share
// a name with, and the other would otherwise travel to an endpoint that is not Anthropic.
const CLIENT_AUTH = new Set(["authorization", "x-api-key"]);
/** How much of an upstream error body is kept for the log. */
const ERROR_HEAD_MAX = 4096;

/**
 * A bounded, decoded upstream error excerpt with credentials completely masked. Providers may
 * echo the key they rejected, including an opaque vendor-specific key format.
 */
export function errorSnippet(head: Buffer, encoding: string | string[] | undefined, secrets: readonly string[] = [], contentType?: string | string[]): string {
  // An HTML error page is never an API answer: the provider URL points at a website (a bare
  // vendor domain) or a login wall. Say that instead of quoting markup (measured 2026-09-13 with
  // OpenRouter answering 200 HTML when the /api prefix was lost).
  if (/text\/html/i.test(String(contentType ?? ""))) return `HTML page (${head.length}B) — the provider URL points at a website or a login page, not an API`;
  let out = head;
  const enc = String(encoding ?? "").toLowerCase();
  try {
    if (enc === "gzip" || enc === "x-gzip") out = zlib.gunzipSync(head);
    else if (enc === "deflate") out = zlib.inflateSync(head);
    else if (enc === "br") out = zlib.brotliDecompressSync(head);
  } catch {
    // A truncated compressed body decodes to nothing; fall through to what is readable.
  }
  const masked = redactErrorText(out.toString("utf8"), secrets, 300);
  return masked || "(empty body)";
}

export type ProxyDeps = {
  config: () => Config;
  log: Logger;
  /** Leaf certificates per terminated host (api.anthropic.com always; claude.ai in picker mode). */
  certs: CertStore;
  health: UpstreamHealth;
  /** ClaudeRipple home (credentials for the chatgpt provider live here). */
  home: string;
  /** Bounded structured history for the local admin Logs page. */
  requests: RequestLog;
  /** Process-memory only; captures a real passthrough Claude Code OAuth header set. */
  observedClaudeCodeAuth?: ObservedClaudeCodeAuth;
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
  /** Set by drain(): new model calls are refused with a retryable 503 so the count can only fall. */
  private draining = false;
  private readonly server: net.Server;
  private readonly httpServer: http.Server;
  private readonly upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  private readonly providerAgents = new Map<string, http.Agent | https.Agent>();
  private readonly chatgptAdapters = new Map<string, { key: string; adapter: ChatGptAdapter }>();
  private readonly openaiAdapters = new Map<string, { key: string; adapter: OpenAiCompatibleAdapter }>();
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

  private openai(name: string, cfg: Extract<Config["providers"][string], { type: "openai-compatible" }>): OpenAiCompatibleAdapter {
    const key = JSON.stringify(cfg);
    const cur = this.openaiAdapters.get(name);
    if (cur && cur.key === key) return cur.adapter;
    const adapter = new OpenAiCompatibleAdapter(name, cfg, this.deps.log);
    this.openaiAdapters.set(name, { key, adapter });
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
  lastPickerInjection: { at: string; injected: number; surfaces: { id: string; models: string[]; entries: { id: string; name: string }[] }[] } | null = null;

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
    // server.close() only stops new TCP connections; the CLI keeps sending new requests down
    // its existing tunnels (measured 2026-09-13: in-flight went 2→1→2 and the budget ran out).
    this.draining = true;
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
    // The CLI sends `/v1/messages?beta=true`: compare the pathname, not the raw path.
    const pathname = path.split("?")[0] ?? path;
    const isLoggedRequest = pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens";
    if (isMessages) this.stats.messagesInFlight++;
    let tag = "PASS";
    let finished = false;
    let record: Omit<RequestRecord, "at" | "id" | "ms" | "status" | "ok" | "usage" | "stopReason" | "note"> = {
      kind: pathname === "/v1/messages/count_tokens" ? "count_tokens" : pathname === "/v1/messages" ? "messages" : "other",
      source: "-",
      target: "-",
      provider: "anthropic",
      stream: false,
    };
    let observedUsage: RequestUsage | undefined;
    let observedStopReason: string | undefined;
    // `failed` counts requests that did not get a proper response (vanished, upstream error,
    // provider error). A note alone is not a failure: adapters attach usage notes on success.
    const finish = (status: string, bytes: number, note?: string, failed: boolean = note !== undefined, extra?: { usage?: RequestUsage; stopReason?: string }): void => {
      if (finished) return;
      finished = true;
      this.stats.inFlight--;
      if (isMessages) this.stats.messagesInFlight--;
      if (failed) this.stats.failed++;
      else this.stats.completed++;
      const ms = Date.now() - t0;
      log.info(`${tag} ${method} ${path} -> ${status} ${bytes}B ${(ms / 1000).toFixed(1)}s${note ? " " + note : ""}`);
      if (isLoggedRequest) {
        const numericStatus = Number(status);
        const usage = extra?.usage ?? observedUsage;
        const stopReason = extra?.stopReason ?? observedStopReason;
        const completed: RequestRecord = {
          ...record,
          id: crypto.randomUUID(),
          at: new Date(t0).toISOString(),
          ms,
          status: Number.isFinite(numericStatus) ? numericStatus : status,
          ok: Number.isFinite(numericStatus) && numericStatus >= 200 && numericStatus < 400,
        };
        if (usage) completed.usage = usage;
        if (stopReason) completed.stopReason = stopReason;
        if (note) completed.note = note;
        this.deps.requests.add(completed);
      }
    };

    if (this.draining && isMessages) {
      // Refuse before reading the body: the client (Anthropic SDK) retries 5xx with backoff and
      // honors retry-after; connection: close makes it reconnect, to the relaunched router.
      tag = "DRAIN";
      const msg = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "ClaudeRipple is restarting; retry" } });
      res.writeHead(503, { "content-type": "application/json", "retry-after": "3", connection: "close", "content-length": String(Buffer.byteLength(msg)) }).end(msg);
      req.resume();
      finish("503", msg.length, "refused during drain (client retries)", false);
      return;
    }

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
    // A WebSearch arrives as its own request aimed at ANTHROPIC_SMALL_FAST_MODEL, recognised by the
    // forced `web_search` server tool rather than by its model id. Answer it from the configured
    // provider's hosted search, so a routed session does not have to spend Claude quota to search
    // (§4). Without `cfg.webSearch` nothing is intercepted and the request takes its normal path.
    const search = cfg.webSearch && json && isApiHost && pathname === "/v1/messages" ? webSearchQuery(json) : null;
    if (search && cfg.webSearch) {
      const served = await this.serveWebSearch(res, json!, search, cfg.webSearch, record, finish);
      if (served) return;
      // Fall through on failure: the ordinary path still answers, and a search that quietly
      // returns nothing is worse than one that costs what it always cost.
    }

    const route = json ? resolve(model, json, cfg) : null;
    const source = typeof model === "string" ? model : "-";
    record = {
      ...record,
      source,
      target: source,
      stream: json?.stream === true,
    };
    const requestedEffort = effortOf(json ?? {});
    if (requestedEffort) record.effort = requestedEffort;

    // Only a real, un-routed Claude Code Messages request may refresh this RAM-only source.
    // Do not inspect it elsewhere: it must never enter logs, RequestLog, picker diagnostics, or admin data.
    if (isApiHost && pathname === "/v1/messages" && !route) this.deps.observedClaudeCodeAuth?.observe(req.rawHeaders);

    let compatCaps: ReturnType<typeof resolveCompatibleCaps> | undefined;
    let compatChanges: string[] = [];
    let target: { protocol: "http:" | "https:"; host: string; port: number; agent: http.Agent | https.Agent; extraHeaders: Record<string, string>; basePath?: string; dropClientAuth?: boolean };
    if (route && json) {
      const provider = cfg.providers[route.provider];
      if (!provider) {
        finish("500", 0, `unknown provider ${route.provider}`);
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "clauderipple_config", message: `unknown provider ${route.provider}` } }));
        return;
      }
      rewriteBody(json, route, cfg.effortClamp);
      if (provider.type === "chatgpt") {
        const td = threadDecision(json);
        if (td === "refuse") {
          const out = JSON.stringify(THREAD_UNSUPPORTED);
          res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
          finish("400", out.length, "thread continue refused → CLI resends stateless", false);
          return;
        }
        if (td === "strip") stripThreadFields(json);
        record = { ...record, target: route.model, provider: route.provider };
        const routeEffort = effortOf(json);
        if (routeEffort) record.effort = routeEffort;
        tag = `CHATGPT ${route.tag} effort=${routeEffort ?? "-"}`;
        try {
          const o = await this.chatgpt(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, effortOf(json));
          finish(String(o.status), o.bytes, o.note, o.status >= 400, { ...(o.usage ? { usage: o.usage } : {}), ...(o.stopReason ? { stopReason: o.stopReason } : {}) });
        } catch (e) {
          finish("-", 0, `chatgpt error ${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`);
          if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: (e as Error).message } }));
          else res.destroy();
        }
        return;
      }
      if (provider.type === "openai-compatible") {
        const td = threadDecision(json);
        if (td === "refuse") {
          const out = JSON.stringify(THREAD_UNSUPPORTED);
          res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
          finish("400", out.length, "thread continue refused → CLI resends stateless", false);
          return;
        }
        if (td === "strip") stripThreadFields(json);
        record = { ...record, target: route.model, provider: route.provider };
        const routeEffort = effortOf(json);
        if (routeEffort) record.effort = routeEffort;
        tag = `OPENAI ${route.tag} wire=${provider.wire ?? "chat"} effort=${routeEffort ?? "-"}`;
        try {
          const o = await this.openai(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, routeEffort);
          finish(String(o.status), o.bytes, o.note, o.status >= 400, { ...(o.usage ? { usage: o.usage } : {}), ...(o.stopReason ? { stopReason: o.stopReason } : {}) });
        } catch (e) {
          finish("-", 0, `openai error ${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`);
          if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: (e as Error).message } }));
          else res.destroy();
        }
        return;
      }
      // Unreachable in practice: resolve() drops rules naming a native provider so the request
      // passes through instead. Kept as a guard — reaching a native endpoint from here would send
      // it a request assembled for a translating provider.
      if (provider.type === "anthropic") {
        finish("400", 0, "native Anthropic provider is available through OpenAI ingress only", false);
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", message: "native Anthropic provider is available through OpenAI ingress only" } }));
        return;
      }
      const preset = provider.preset ? PRESETS.find((entry) => entry.id === provider.preset) : undefined;
      const modelEffortLevels = provider.models?.find((entry) => entry.id === route.model)?.effortLevels;
      compatCaps = resolveCompatibleCaps(
        preset ? { effortLevels: preset.effortLevels, thinking: preset.thinking, ...(preset.serverTools ? { serverTools: true } : {}) } : undefined,
        modelEffortLevels === undefined ? provider.caps : { ...provider.caps, effortLevels: modelEffortLevels },
      );
      const sanitized = sanitizeForCompatible(json, compatCaps);
      json = sanitized.json;
      compatChanges = sanitized.changes;
      // The upstream would otherwise read Claude Code's own system prompt and answer that it is
      // Claude. After sanitizing, so the effort named is the one the provider actually receives.
      applyIdentityToAnthropicBody(json, {
        model: route.model,
        effort: effortOf(json),
        identity: provider.identity,
        instructionsAppend: provider.instructionsAppend,
      });
      body = Buffer.from(JSON.stringify(json));
      const u = new URL(provider.url);
      const protocol = u.protocol === "https:" ? "https:" : "http:";
      target = {
        protocol,
        host: u.hostname,
        port: Number(u.port) || (protocol === "https:" ? 443 : 80),
        agent: this.agentFor(route.provider, protocol),
        extraHeaders: provider.headers ?? {},
        dropClientAuth: true,
        // Providers mount their Anthropic-compatible API under a path (DeepSeek /anthropic, OpenRouter /api,
        // Qwen /apps/anthropic): the CLI's /v1/messages is appended to it. Dropping it sent requests to the
        // vendor's website, which answered 200 with HTML (measured 2026-09-13 with OpenRouter).
        basePath: u.pathname.replace(/\/+$/, ""),
      };
      record = { ...record, target: route.model, provider: route.provider };
      const routeEffort = effortOf(json);
      if (routeEffort) record.effort = routeEffort;
      tag = `${route.provider.toUpperCase()} ${route.tag} effort=${routeEffort ?? "-"}`;
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
      // Bootstrap responses are edited: keep the client's accept-encoding as-is (some edges misbehave without it)
      // and decompress whatever comes back before editing.
      if (lk in target.extraHeaders) continue;
      if (target.dropClientAuth && CLIENT_AUTH.has(lk)) continue;
      // Anthropic beta flags opt into features most compatible providers have not implemented.
      if (compatCaps && !forwardCompatibleHeader(lk, compatCaps)) {
        compatChanges.push("anthropic-beta");
        continue;
      }
      // Picker bootstrap: never let the renderer revalidate against a cached (unedited) copy.
      if (isPickerBootstrap && (lk === "if-none-match" || lk === "if-modified-since")) continue;
      headers.push(k, raw[i + 1]!);
    }
    for (const [k, v] of Object.entries(target.extraHeaders)) headers.push(k, v);
    if (route && compatChanges.length > 0) log.info(`COMPAT ${route.provider}: ${compatChanges.join(", ")}`);
    headers.push("host", target.protocol === "https:" && target.port === 443 ? target.host : `${target.host}:${target.port}`);
    // No content-length on body-less GET/HEAD: some edges reject it; Chromium never sends it.
    if (body.length > 0 || (method !== "GET" && method !== "HEAD")) headers.push("content-length", String(body.length));
    if (isPickerBootstrap) {
      const shown: string[] = [];
      for (const [rawName, value] of Array.from({ length: headers.length / 2 }, (_, i) => [headers[i * 2]!, headers[i * 2 + 1]!] as [string, string])) {
        const safe = redactHeaders({ [rawName]: value })[rawName];
        shown.push(safe === "[REDACTED]" ? `${rawName.toLowerCase()}=<${value.length}B>` : `${rawName.toLowerCase()}=${value}`);
      }
      log.info(`PICKER request ${method} ${path.slice(0, 80)} headers: ${shown.join(" | ")}`);
    }
    // Keep only actual credentials named by the outbound headers. This covers arbitrary vendor
    // key formats when a provider reflects the key in its error body.
    const errorSecrets = credentialHeaderValues(Array.from({ length: headers.length / 2 }, (_, i) => [headers[i * 2]!, headers[i * 2 + 1]!] as [string, string]));

    const lib = target.protocol === "https:" ? https : http;
    const upReq = lib.request({
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      method,
      path: target.basePath ? target.basePath + path : path,
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
        if (isPickerBootstrap && (lk === "etag" || lk === "last-modified")) continue;
        outHeaders.push(r[i]!, r[i + 1]!);
      }
      let bytes = 0;
      if (isBootstrap) {
        const chunks: Buffer[] = [];
        upRes.on("data", (c: Buffer) => chunks.push(c));
        upRes.on("end", () => {
          let out: Buffer = Buffer.concat(chunks);
          const enc = String(upRes.headers["content-encoding"] ?? "").toLowerCase();
          try {
            if (enc === "gzip" || enc === "x-gzip") out = zlib.gunzipSync(out);
            else if (enc === "deflate") out = zlib.inflateSync(out);
            else if (enc === "br") out = zlib.brotliDecompressSync(out);
            else if (enc === "zstd" && typeof (zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function")
              out = (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(out);
          } catch (e) {
            log.warn(`bootstrap decode (${enc}) failed: ${(e as Error).message}`);
          }
          if (status === 200 && isCliBootstrap) {
            try {
              out = injectBootstrap(out, cfg);
            } catch (e) {
              log.warn(`bootstrap inject failed: ${(e as Error).message}`);
            }
          } else if (isPickerBootstrap && status !== 200 && status !== 304) {
            log.warn(`PICKER bootstrap upstream ${status}; headers: ${JSON.stringify(redactHeaders(upRes.headers))}; body: ${redactErrorText(out.toString("utf8"), errorSecrets, 300)}`);
          } else if (status === 200 && isPickerBootstrap) {
            try {
              const j = JSON.parse(out.toString("utf8")) as Record<string, unknown>;
              const r = injectPickerModels(j, cfg.cli.extraModels, cfg.cli.autoCompactWindow);
              if (r.surfaces.length > 0) {
                this.lastPickerInjection = { at: new Date().toISOString(), ...r };
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
      // This observer is deliberately side-band: it sees the exact chunks after they are written
      // to the client, retains only a 64 KiB line/object fragment, and never changes backpressure.
      const tap = new ResponseUsageTap(
        typeof upRes.headers["content-type"] === "string" ? upRes.headers["content-type"] : undefined,
        typeof upRes.headers["content-encoding"] === "string" ? upRes.headers["content-encoding"] : undefined,
      );
      // An error body is the only thing that says why the provider refused; keep its head for the
      // log and the Logs page. A DeepSeek 401 went unexplained for a day because only the status
      // code was recorded (2026-09-15).
      const errorHead: Buffer[] = [];
      let errorHeadBytes = 0;
      upRes.on("data", (c: Buffer) => {
        bytes += c.length;
        const writable = res.write(c);
        tap.feed(c);
        if (status >= 400 && errorHeadBytes < ERROR_HEAD_MAX) {
          const remaining = ERROR_HEAD_MAX - errorHeadBytes;
          errorHead.push(c.subarray(0, remaining));
          errorHeadBytes += Math.min(c.length, remaining);
        }
        if (!writable) upRes.pause();
      });
      res.on("drain", () => upRes.resume());
      upRes.on("end", () => {
        const observed = tap.finish();
        observedUsage = observed.usage;
        observedStopReason = observed.stopReason;
        res.end();
        finish(String(status), bytes, status >= 400 ? `upstream ${status}: ${errorSnippet(Buffer.concat(errorHead), upRes.headers["content-encoding"], errorSecrets, upRes.headers["content-type"])}` : undefined);
      });
      upRes.on("error", (e) => {
        finish(String(status), bytes, `upstream stream error ${(e as Error).message}`);
        res.destroy();
      });
    });

    upReq.end(body);
  }

  /**
   * Answer a WebSearch side request from a provider's hosted search instead of letting it reach a
   * model. Returns false when it could not be served, and the caller falls back to the normal path:
   * an empty search result is the one outcome worth avoiding, because nothing anywhere reports it.
   */
  private async serveWebSearch(
    res: http.ServerResponse,
    json: Record<string, unknown>,
    query: WebSearchQuery,
    settings: NonNullable<Config["webSearch"]>,
    record: { source?: string; target?: string },
    finish: (status: string, bytes: number, note?: string, failed?: boolean) => void,
  ): Promise<boolean> {
    const provider = this.deps.config().providers[settings.provider];
    if (!provider) {
      this.deps.log.warn(`web search: unknown provider ${settings.provider}; leaving the request alone`);
      return false;
    }
    const url = "url" in provider && typeof provider.url === "string" ? provider.url : undefined;
    if (!url) {
      this.deps.log.warn(`web search: provider ${settings.provider} has no url; leaving the request alone`);
      return false;
    }
    const backend = webPluginBackend({
      name: settings.provider,
      url,
      headers: ("headers" in provider && provider.headers) || {},
      model: settings.model,
      ...(settings.maxResults ? { maxResults: settings.maxResults } : {}),
    });

    const model = typeof json.model === "string" ? json.model : "unknown";
    let blocks;
    try {
      const outcome = await backend.search(query);
      blocks = webSearchBlocks(query, outcome).blocks;
    } catch (e) {
      this.deps.log.warn(`web search via ${settings.provider}: ${(e as Error).message}`);
      return false;
    }

    record.target = `${settings.provider}/${settings.model}`;
    const wantStream = json.stream === true;
    const payload = wantStream ? webSearchSse(model, blocks, 1) : JSON.stringify(webSearchMessage(model, blocks, 1));
    const headers = wantStream
      ? { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }
      : { "content-type": "application/json" };
    res.writeHead(200, headers).end(payload);
    finish("200", Buffer.byteLength(payload), `web search via ${settings.provider}`, false);
    return true;
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
