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
import { THREAD_UNSUPPORTED, effortOf, resolve, rewriteBody, stripThreadFields, threadDecision, unroutableReason, type Resolved } from "./routing.ts";
import { defaultAgentDir, withAgentAliases } from "./agents.ts";
import { forwardCompatibleHeader, resolveCompatibleCaps, sanitizeForCompatible } from "./compat.ts";
import { applyIdentityToAnthropicBody } from "./identity.ts";
import { anthropicServerToolBackend, webPluginBackend, webSearchBlocks, webSearchErrorBlocks, webSearchMessage, webSearchQuery, webSearchSse, type WebSearchQuery } from "./websearch.ts";
import { classify, CredentialPool, retryAfterMs, type Credential } from "./pool.ts";
import { PRESETS } from "./presets.ts";
import { ChatGptAdapter } from "./providers/chatgpt/index.ts";
import { OpenAiCompatibleAdapter } from "./providers/openai/index.ts";
import { conversationKey, type AnthropicRequest } from "./providers/chatgpt/translate.ts";
import { terminateHosts } from "./config.ts";
import type { CertStore } from "./certs.ts";
import { injectPickerModels, isBootstrapPath } from "./picker.ts";
import { ResponseUsageTap, type RequestLog, type RequestRecord, type RequestUsage } from "./requestlog.ts";
import { credentialHeaderValues, redactErrorText, redactHeaders } from "./redact.ts";
import type { ObservedClaudeCodeAuth } from "./providers/anthropic-observed.ts";
import { ClaudeAccountAuthPool } from "./providers/anthropic-account-pool.ts";

const MAX_BODY = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "content-length"]);
// The caller's own Anthropic credentials. A routed request authenticates as the provider, so these
// are dropped rather than forwarded: the provider header replaces only the one it happens to share
// a name with, and the other would otherwise travel to an endpoint that is not Anthropic.
const CLIENT_AUTH = new Set(["authorization", "x-api-key"]);
/** How much of an upstream error body is kept for the log. */
const ERROR_HEAD_MAX = 4096;

export type AbsoluteProxyRequest = { host: string; port: number; path: string; head: Buffer };

/**
 * Claude Code's Remote Control registration uses HTTPS absolute-form proxy requests instead of
 * CONNECT (`POST https://api.anthropic.com/v1/environments/bridge HTTP/1.1`). Convert that legal
 * forward-proxy form to the origin form expected inside a TLS connection. Credentials and the
 * request body remain byte-for-byte client data; proxy-only headers never reach the destination.
 */
export function absoluteProxyRequest(header: Buffer): AbsoluteProxyRequest | null {
  const lines = header.toString("latin1").split("\r\n");
  const first = lines.shift() ?? "";
  const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s+(\S+)\s+(HTTP\/1\.[01])$/.exec(first);
  if (!match) return null;
  let url: URL;
  try {
    url = new URL(match[2]!);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname) return null;
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // URL.hostname keeps brackets around IPv6 literals; net/tls expect the bare address while the
  // HTTP Host field requires brackets. Keep those two representations separate.
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  const headers = lines.filter((line) =>
    !/^proxy-(?:authorization|connection)\s*:/i.test(line) &&
    !/^host\s*:/i.test(line) &&
    !/^connection\s*:/i.test(line),
  );
  const authority = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const path = `${url.pathname || "/"}${url.search}`;
  // One TLS connection serves one absolute-form request. Reusing it would send the next proxy-form
  // request target directly to the origin, so explicitly ask both peers to close after the response.
  const rewritten = [`${match[1]} ${path} ${match[3]}`, `Host: ${authority}`, "Connection: close", ...headers].join("\r\n") + "\r\n\r\n";
  return { host, port, path, head: Buffer.from(rewritten, "latin1") };
}

/**
 * The same header list with one credential swapped for another. Names carried by either credential
 * are removed first: an observed Claude session can have fingerprint headers that a stored login
 * does not, and leaving those behind would combine two distinct client identities on the retry.
 */
export function withCredential(
  headers: readonly string[],
  credential: Record<string, string>,
  previous: Record<string, string> = {},
): string[] {
  const replaced = new Set([...Object.keys(previous), ...Object.keys(credential)].map((k) => k.toLowerCase()));
  const out: string[] = [];
  for (let i = 0; i < headers.length; i += 2) {
    if (replaced.has(headers[i]!.toLowerCase())) continue;
    out.push(headers[i]!, headers[i + 1]!);
  }
  for (const [k, v] of Object.entries(credential)) out.push(k, v);
  return out;
}

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
  /** Where agent definitions are read from. Defaults to `~/.claude/agents`; tests inject a tmp dir. */
  agentDir?: string;
  /** TLS dialer for absolute-form proxy requests. Production uses node:tls; integration tests inject a local CA. */
  tlsConnect?: (options: tls.ConnectionOptions) => tls.TLSSocket;
  /** Native Anthropic upstream seams for integration tests; production always uses port 443 and the default agent. */
  upstreamAgent?: https.Agent;
  upstreamPort?: number;
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
  private readonly claudeAccounts: ClaudeAccountAuthPool;
  private readonly deps: ProxyDeps;
  /**
   * Cooldowns, quarantines and conversation stickiness for provider credentials. In memory: a
   * cooldown that outlived a restart would make restarting worse, and a rejected credential earns
   * its quarantine again on the first request.
   */
  private readonly pool = new CredentialPool();

  /** Latest rate-limit snapshot reported by any chatgpt provider (for the admin GUI). */
  get chatgptRateLimits(): Record<string, Record<string, unknown> | null> {
    const out: Record<string, Record<string, unknown> | null> = {};
    for (const [name, a] of this.chatgptAdapters) out[name] = a.adapter.lastRateLimits;
    return out;
  }

  /**
   * Ask one chatgpt provider for its quota now. Adapters are created on first use, so a provider
   * nobody has called yet is instantiated from config here — otherwise the admin status would
   * report "no quota" until the first GPT turn of the day.
   */
  chatgptFetchRateLimits(name: string): Promise<Record<string, unknown> | null> {
    const cfg = this.deps.config().providers[name];
    if (!cfg || cfg.type !== "chatgpt") return Promise.resolve(null);
    return this.chatgpt(name, cfg).fetchRateLimits();
  }

  /** Startup refresh: every configured chatgpt provider, in the background, never awaited. */
  chatgptRefreshAll(): void {
    for (const [name, p] of Object.entries(this.deps.config().providers)) {
      if (p.type === "chatgpt") void this.chatgptFetchRateLimits(name);
    }
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
    this.claudeAccounts = new ClaudeAccountAuthPool({
      home: deps.home,
      log: deps.log,
      ...(deps.observedClaudeCodeAuth ? { observed: deps.observedClaudeCodeAuth } : {}),
    });
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
        const absolute = absoluteProxyRequest(head.subarray(0, end));
        if (absolute) {
          log.info(`ABSOLUTE ${method ?? "?"} https://${absolute.host}:${absolute.port}${absolute.path}`);
          this.forwardAbsolute(sock, absolute, rest);
          return;
        }
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

  /** Forward an HTTPS absolute-form request without terminating it through the routing layer. */
  private forwardAbsolute(sock: net.Socket, request: AbsoluteProxyRequest, rest: Buffer): void {
    const servername = net.isIP(request.host) ? undefined : request.host;
    const up = (this.deps.tlsConnect ?? tls.connect)({ host: request.host, port: request.port, ...(servername ? { servername } : {}), ALPNProtocols: ["http/1.1"] });
    const kill = (): void => {
      sock.destroy();
      up.destroy();
    };
    up.on("error", (e) => {
      this.deps.log.warn(`absolute upstream error ${request.host}:${request.port}: ${(e as Error).message}`);
      if (sock.writable) sock.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      up.destroy();
    });
    sock.on("error", kill);
    up.once("secureConnect", () => {
      up.write(request.head);
      if (rest.length) up.write(rest);
      sock.pipe(up);
      up.pipe(sock);
      sock.resume();
    });
    up.on("close", () => sock.destroy());
    sock.on("close", () => up.destroy());
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
    const log = this.deps.log;
    // The agent files' derived aliases join the config's own, so a marker naming a worker resolves
    // the same way here as it does everywhere else. Explicit aliases win; the scan is mtime-cached.
    const cfg = withAgentAliases(this.deps.config(), this.deps.agentDir ?? defaultAgentDir(), log);
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
    // forced `web_search` server tool rather than by its model id. Recognise it whether or not a
    // backend is configured: `cfg.webSearch` decides who answers it, but knowing that this is a
    // search is what lets the guard below refuse a provider that cannot run one. Tying the two
    // together meant an unconfigured router could not tell a search from any other turn.
    const search = json && isApiHost && pathname === "/v1/messages" ? webSearchQuery(json) : null;
    if (search && cfg.webSearch) {
      const served = await this.serveWebSearch(res, json!, search, cfg.webSearch, record, finish);
      if (served) return;
      // Fall through on failure: the ordinary path still answers, and a search that quietly
      // returns nothing is worse than one that costs what it always cost.
    }

    const resolved = json ? resolve(model, json, cfg) : null;

    // A non-Claude model this router cannot route is refused here, by name, instead of being
    // forwarded to Anthropic. `PASS` on such a request answers 404 from Anthropic and looks like
    // "the model vanished" (2026-09-20: an agent file named `deepseek` resolved, through a missing
    // alias, to a model no provider declared — thirty of them came back 404). A native `claude-*`
    // id is deliberately unrouted and must keep passing through (§5).
    if (!resolved && isApiHost && isMessages && json && typeof model === "string" && !model.startsWith("claude-")) {
      const reason = unroutableReason(model, json, cfg);
      if (reason) {
        const payload = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `ClaudeRipple: ${reason}` } });
        res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }).end(payload);
        tag = `REFUSE ${model}`;
        record = { ...record, provider: "refused" };
        finish("400", payload.length, `ClaudeRipple: ${reason}`, true);
        return;
      }
    }
    // A slot with fallbacks picks its provider before anything is sent, so a primary that is rate
    // limited for the next hour is skipped rather than rediscovered once per request. Failing over
    // mid-turn is not possible — once a byte of the answer has gone out, replacing it would splice
    // two answers together — so the choice has to be made here or not at all.
    const route = resolved ? this.chooseTarget(resolved, cfg, log) : null;
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

    // A `WebSearch` side request routed to a provider that cannot run the server tool must not be
    // sent. The tool is dropped on every translated path, which leaves "you are an assistant for
    // performing a web search tool use / perform a web search for the query: …" with no tool
    // attached — and a model told to search with nothing to search with narrates a tool call
    // instead. OpenCode Go's DeepSeek answered exactly that, in its own markup, as HTTP 200
    // (measured 2026-09-18), and the session reported the search tool as unresponsive.
    //
    // Say so in the shape the CLI prints. A search that fails visibly can be retried by a human;
    // one that returns prose shaped like an answer cannot.
    if (search && route && json && !this.canRunServerTools(route.provider, cfg)) {
      const blocks = webSearchErrorBlocks(search, "unavailable");
      const model = typeof json.model === "string" ? json.model : "unknown";
      const wantStream = json.stream === true;
      const payload = wantStream ? webSearchSse(model, blocks, 0) : JSON.stringify(webSearchMessage(model, blocks, 0));
      res.writeHead(200, wantStream
        ? { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }
        : { "content-type": "application/json" }).end(payload);
      log.warn(`web search: ${route.provider} cannot run server tools and no webSearch backend is configured; refused rather than answered with invented results`);
      finish("200", Buffer.byteLength(payload), `web search refused: ${route.provider} runs no server tools`, false);
      return;
    }

    let compatCaps: ReturnType<typeof resolveCompatibleCaps> | undefined;
    let compatChanges: string[] = [];
    /** The credential this attempt is using, and so the one a failure is charged to. */
    let chosen: Credential | null = null;
    let penalised: { provider: string; id: string } | null = null;
    let target: { protocol: "http:" | "https:"; host: string; port: number; agent: http.Agent | https.Agent; extraHeaders: Record<string, string>; basePath?: string; dropClientAuth?: boolean; dropHeaders?: Set<string>; dropHeaderPrefixes?: string[] };
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
          // Without this the pool never hears about this provider, so it always looks healthy and a
          // slot pointing at it can never fail over — which is most of the point on a subscription
          // that runs out. The credential here is the adapter's own OAuth, so there is one of it.
          this.recordOutcome(route.provider, o.status);
          finish(String(o.status), o.bytes, o.note, o.status >= 400, { ...(o.usage ? { usage: o.usage } : {}), ...(o.stopReason ? { stopReason: o.stopReason } : {}) });
        } catch (e) {
          this.recordOutcome(route.provider, 0);
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
          this.recordOutcome(route.provider, o.status);
          finish(String(o.status), o.bytes, o.note, o.status >= 400, { ...(o.usage ? { usage: o.usage } : {}), ...(o.stopReason ? { stopReason: o.stopReason } : {}) });
        } catch (e) {
          this.recordOutcome(route.provider, 0);
          finish("-", 0, `openai error ${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`);
          if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: (e as Error).message } }));
          else res.destroy();
        }
        return;
      }
      if (provider.type === "anthropic") {
        if (!provider.accountPool || provider.auth !== "claude-code") {
          finish("400", 0, "native Anthropic provider is available through OpenAI ingress only", false);
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", message: "native Anthropic provider is available through OpenAI ingress only" } }));
          return;
        }
        // Native Messages need no translation. Only authentication changes, so server-side threads,
        // prompt caching, beta features and the client's exact tool contract remain first-party.
        const credentials = await this.claudeAccounts.credentials();
        if (credentials.length === 0) {
          const out = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "ClaudeRipple: no usable Claude account; sign in or reauthenticate an account" } });
          res.writeHead(401, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
          finish("401", out.length, "no usable Claude account");
          return;
        }
        body = Buffer.from(JSON.stringify(json));
        chosen = this.pool.pick(route.provider, credentials, conversationKey(json as AnthropicRequest));
        const using = chosen ?? credentials[0]!;
        chosen = using;
        penalised = { provider: route.provider, id: using.id };
        target = {
          protocol: "https:",
          host: cfg.upstream,
          port: this.deps.upstreamPort ?? 443,
          agent: this.deps.upstreamAgent ?? this.agentFor(route.provider, "https:"),
          extraHeaders: using.headers,
          dropClientAuth: true,
          dropHeaders: new Set(credentials.flatMap((credential) => Object.keys(credential.headers).map((name) => name.toLowerCase()))),
          dropHeaderPrefixes: ["anthropic-client-", "x-stainless-"],
        };
        record = { ...record, target: route.model, provider: route.provider };
        const routeEffort = effortOf(json);
        if (routeEffort) record.effort = routeEffort;
        tag = `CLAUDE ${route.tag} account=${using.ownerId?.slice(0, 8) ?? "current"}`;
      } else {
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
      // Which credential answers this turn. The conversation keeps the one it is on while that one
      // is healthy, because moving it moves the prompt cache with it. Every credential cooling or
      // quarantined leaves `chosen` null, and the request goes out on the configured headers so the
      // provider — not us — gets to say no.
      const credentials = this.credentialsOf(route.provider, provider);
      // The same key the prompt cache is keyed on. `metadata.user_id` alone is one value for every
      // conversation a user has, so using it raw would drag all of them onto one credential at once
      // — the opposite of what stickiness is for (see conversationKey and ARCHITECTURE §4).
      chosen = this.pool.pick(route.provider, credentials, conversationKey(json as AnthropicRequest));
      // Nothing usable means every credential is cooling, and the turn still has to go somewhere:
      // the first one, so the request carries real credentials rather than none, and so the answer
      // is charged to the credential that actually produced it.
      const using = chosen ?? credentials[0]!;
      chosen = using;
      penalised = { provider: route.provider, id: using.id };
      target = {
        protocol,
        host: u.hostname,
        port: Number(u.port) || (protocol === "https:" ? 443 : 80),
        agent: this.agentFor(route.provider, protocol),
        // The credential wins over the session header: they are different names in practice, but a
        // vendor that reused one would mean the request going out unauthenticated.
        extraHeaders: provider.sessionHeader
          ? { [provider.sessionHeader]: conversationKey(json as AnthropicRequest), ...using.headers }
          : using.headers,
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
      }
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
      if (lk in target.extraHeaders || target.dropHeaders?.has(lk) || target.dropHeaderPrefixes?.some((prefix) => lk.startsWith(prefix))) continue;
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
    // Keep every credential this turn sends. A retry can use an opaque token that does not match a
    // known token shape; retaining its actual value is what keeps a reflected refusal out of logs.
    const errorSecrets = new Set(credentialHeaderValues(Array.from({ length: headers.length / 2 }, (_, i) => [headers[i * 2]!, headers[i * 2 + 1]!] as [string, string])));
    // Every retry is rebuilt from the first attempt's header list. Keep the union of identity header
    // names already used so a current-session fingerprint cannot reappear on a third account.
    let usedCredentialHeaders = { ...(chosen?.headers ?? {}) };

    const lib = target.protocol === "https:" ? https : http;
    /**
     * The attempt in flight. A routed turn may make more than one: when a credential is refused and
     * nothing has reached the client yet, the next credential takes over inside the same turn, so
     * the client is answered on its first ask instead of having to retry. `send` below replaces
     * this; everything that reaches for the upstream reaches for it through here.
     */
    let upReq!: http.ClientRequest;
    /** Credentials already spent on this turn, so a retry cannot pick one of them again. */
    const tried = new Set<string>(penalised ? [penalised.id] : []);
    const send = (attemptHeaders: string[]): void => {
      upReq = lib.request({
        protocol: target.protocol,
        host: target.host,
        port: target.port,
        method,
        path: target.basePath ? target.basePath + path : path,
        headers: attemptHeaders,
        agent: target.agent,
        ...(target.protocol === "https:" ? { servername: target.host } : {}),
      });
      upReq.on("error", onUpstreamError);
      upReq.on("response", onUpstreamResponse);
      upReq.end(body);
    };

    /**
     * The next credential to try inside this turn, or null to answer with what the provider said.
     * Only for a routed request whose provider has one we have not already spent — a failure that
     * is the request's own fault is not retried at all (see `classify`).
     */
    const nextCredential = (status: number, body = ""): Credential | null => {
      if (!route || !penalised || res.headersSent) return null;
      if (!classify(status, undefined, body).retryable) return null;
      const provider = cfg.providers[route.provider];
      if (!provider) return null;
      const available = provider.type === "anthropic" && provider.accountPool
        ? this.claudeAccounts.peekCredentials()
        : this.credentialsOf(route.provider, provider);
      const rest = available.filter((c) => !tried.has(c.id));
      if (rest.length === 0) return null;
      return this.pool.pick(route.provider, rest, conversationKey(json as AnthropicRequest));
    };

    // Destroying the upstream makes it emit ECONNRESET (measured, Node 24.15), which is
    // indistinguishable from the provider dropping us unless we remember that we did it. Without
    // this flag every cancelled turn charged the credential a failure and moved the conversation
    // off it, which costs the prompt cache — for a turn the user cancelled on purpose.
    let clientAborted = false;
    // Set when a 403 body was read ahead of the forward, so the forward knows to write that body
    // instead of the stream it came from.
    let headFilled = false;
    const abortUpstream = (): void => {
      clientAborted = true;
      if (upReq && !upReq.destroyed) upReq.destroy();
    };
    req.on("aborted", abortUpstream);
    res.on("close", () => {
      if (!finished) {
        abortUpstream();
        finish("-", 0, "client closed");
      }
    });

    const onUpstreamError = (e: Error): void => {
      if (target.host === cfg.upstream) this.deps.health.failure(e);
      // Nothing reached the provider, so this says nothing about the credential — but it does say
      // the route is unusable for a moment, and a pool with somewhere else to go should use it.
      // Our own abort is not the provider's fault and must not be charged to it.
      if (penalised && !clientAborted) this.pool.penalise(penalised.provider, penalised.id, 0);
      finish("-", 0, `upstream error ${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: { type: "clauderipple_upstream", message: `${target.host}: ${(e as Error).message}` } }));
      } else {
        res.destroy();
      }
    };

    const onUpstreamResponse = (upRes: http.IncomingMessage): void => {
      if (target.host === cfg.upstream) this.deps.health.success();
      const status = upRes.statusCode ?? 0;
      // A 403 is the one status whose meaning is in its body. A relay reporting a broken upstream
      // must not be charged to the credential — that is what made one working key answer every turn
      // with an authentication error for a minute (2026-09-21). Every other status is judged from
      // the status alone, and its body is left for the forward below, untouched.
      if (status === 403) {
        bufferBody(upRes, ERROR_HEAD_MAX).then((whole) => onUpstreamJudged(upRes, status, whole)).catch((e: Error) => {
          log.warn(`upstream ${status}: could not read the body: ${e.message}`);
          finish(String(status), 0, `upstream ${status}: body read failed`);
          res.destroy();
        });
        return;
      }
      onUpstreamJudged(upRes, status, "");
    };

    /**
     * The whole of a small body, read before anything is decided or written.
     *
     * A 403's meaning is in its body and cannot be judged before it arrives, so the bytes are read
     * and handed back as the head: `unshift` after a stream has ended throws, and reading a head and
     * forwarding the rest mid-flow is where a body can be lost to a pause nothing resumes. A 403 is
     * a refusal, so its body is small.
     *
     * Past `max` there is nothing worth identifying, so the rest is dropped — but the stream is
     * never destroyed. Tearing the connection down over a body size would turn a refusal the user
     * can read into a socket error, which is a worse bug than the one this handles; an unbounded
     * relay answer instead reaches the forward above the cap and is reported there.
     */
    const bufferBody = (stream: http.IncomingMessage, max: number): Promise<string> => new Promise((resolveBody) => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (c: Buffer) => {
        const room = max - size;
        if (room <= 0) { stream.resume(); return; }
        chunks.push(c.subarray(0, room));
        size += Math.min(c.length, room);
      });
      stream.once("end", () => {
        const body = Buffer.concat(chunks, size);
        headFilled = true;
        resolveBody(body.toString("utf8"));
      });
      // A dropped or failed stream still hands over what arrived; the caller's own upstream error
      // path is already attached, and duplicating it here would race it for the same response.
      stream.once("error", () => {
        headFilled = true;
        resolveBody(Buffer.concat(chunks, size).toString("utf8"));
      });
    });

    const onUpstreamJudged = (upRes: http.IncomingMessage, status: number, errBody: string): void => {
      // Charge the answer to the credential that produced it. A rate limit parks this one until its
      // stated reset so the next request takes another; an answer clears whatever it was carrying.
      // A 400 is our own request and is charged to nobody (see `classify`).
      if (penalised) {
        if (status >= 400) {
          this.pool.penalise(penalised.provider, penalised.id, status, retryAfterMs(upRes.headers), errBody);
          if (status === 401 && cfg.providers[penalised.provider]?.type === "anthropic") this.claudeAccounts.reject(penalised.id);
        } else this.pool.succeed(penalised.provider, penalised.id);
      }

      // Nothing has been written to the client yet, so a refused credential can still be replaced
      // and the client answered on its first ask. Only here: once the answer starts flowing the
      // turn is committed, because replacing a half-sent stream splices two answers together.
      const retry = status >= 400 ? nextCredential(status, errBody) : null;
      if (retry) {
        const previousId = retry.ownerId ? penalised!.id.split(":", 1)[0]! : penalised!.id;
        log.info(`RETRY ${route!.provider}: ${previousId} answered ${status}, trying ${retry.ownerId ?? retry.id}`);
        tried.add(retry.id);
        usedCredentialHeaders = { ...usedCredentialHeaders, ...(chosen?.headers ?? {}), ...retry.headers };
        chosen = retry;
        penalised = { provider: route!.provider, id: retry.id };
        for (const secret of credentialHeaderValues(Object.entries(retry.headers))) errorSecrets.add(secret);
        upRes.resume();
        upRes.destroy();
        // Remove every identity header used by any earlier attempt. The baseline is the first request,
        // so removing only the immediately previous account would resurrect first-attempt fingerprints.
        send(withCredential(headers, retry.headers, usedCredentialHeaders));
        return;
      }

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
            log.warn(`PICKER bootstrap upstream ${status}; headers: ${JSON.stringify(redactHeaders(upRes.headers))}; body: ${redactErrorText(out.toString("utf8"), [...errorSecrets], 300)}`);
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
      // The 403 body was read to judge it, so it is written here instead of read again from a
      // stream that has already ended. Its `content-length` came from the upstream and still fits.
      if (headFilled) {
        const body = Buffer.from(errBody, "utf8");
        bytes = body.length;
        res.end(body);
        finish(String(status), bytes, `upstream ${status}: ${redactErrorText(errBody, [...errorSecrets], 300)}`);
        return;
      }
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
        finish(String(status), bytes, status >= 400 ? `upstream ${status}: ${errorSnippet(Buffer.concat(errorHead), upRes.headers["content-encoding"], [...errorSecrets], upRes.headers["content-type"])}` : undefined);
      });
      upRes.on("error", (e) => {
        finish(String(status), bytes, `upstream stream error ${(e as Error).message}`);
        res.destroy();
      });
    };

    send(headers);
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
    if (!url && provider.type !== "chatgpt") {
      this.deps.log.warn(`web search: provider ${settings.provider} has no url; leaving the request alone`);
      return false;
    }
    // Which backend depends on how the provider is spoken to, not on the vendor. An
    // anthropic-compatible one is asked in Anthropic's own shape and hands back the blocks the CLI
    // already parses; an openai-compatible one is asked through its chat web plugin.
    const common = {
      name: settings.provider,
      url: url ?? "",
      headers: ("headers" in provider && provider.headers) || {},
      model: settings.model,
      ...(settings.maxResults ? { maxResults: settings.maxResults } : {}),
    };
    let backend;
    if (provider.type === "anthropic-compatible") {
      // Refuse before sending rather than after. A provider that cannot run the server tool is sent
      // "perform a web search" with no tool attached, and a model told to search with nothing to
      // search with narrates a tool call instead — an answer shaped like success, holding nothing.
      if (!this.canRunServerTools(settings.provider, this.deps.config())) {
        this.deps.log.warn(`web search: provider ${settings.provider} does not run server tools; leaving the request alone`);
        return false;
      }
      backend = anthropicServerToolBackend(common);
    } else if (provider.type === "openai-compatible") {
      backend = webPluginBackend(common);
    } else if (provider.type === "chatgpt") {
      backend = this.chatgpt(settings.provider, provider).webSearch(settings.model, settings.maxResults);
    } else {
      this.deps.log.warn(`web search: provider ${settings.provider} is a ${provider.type} provider, which has no search backend; leaving the request alone`);
      return false;
    }

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

  /**
   * Whether this provider executes Anthropic's server-side tools (`web_search`) itself, rather than
   * having them dropped on the way out. Only an anthropic-compatible provider whose preset or caps
   * say so, measured per provider — `serverTools` in compat.ts. Two routes to the same vendor can
   * differ: DeepSeek's own endpoint runs it, the same model through OpenCode Go does not.
   */
  private canRunServerTools(name: string, cfg: Config): boolean {
    const provider = cfg.providers[name];
    // A routed native account still calls Anthropic's Messages API unchanged, so Anthropic executes
    // its own server tools. Only translated/compatible providers need an explicit measured capability.
    if (provider?.type === "anthropic") return provider.accountPool === true && provider.auth === "claude-code";
    if (!provider || provider.type !== "anthropic-compatible") return false;
    const preset = provider.preset ? PRESETS.find((entry) => entry.id === provider.preset) : undefined;
    return resolveCompatibleCaps(preset ? { ...(preset.serverTools ? { serverTools: true } : {}) } : undefined, provider.caps).serverTools;
  }

  /**
   * The provider this turn actually goes to. The primary unless every one of its credentials is
   * cooling or quarantined, in which case the first fallback that has something usable takes it.
   *
   * When nothing anywhere is usable the primary is kept: the provider gets to refuse the request
   * rather than the router inventing a refusal, and the answer it gives is what updates the pool.
   */
  private chooseTarget(resolved: Resolved, cfg: Config, log: Logger): Resolved {
    if (!resolved.fallbacks?.length) return resolved;
    const usable = (name: string): boolean => {
      const provider = cfg.providers[name];
      if (!provider) return false;
      if (provider.type === "anthropic") {
        if (!provider.accountPool || provider.auth !== "claude-code") return false;
        const accounts = this.claudeAccounts.peekCredentials();
        return accounts.length > 0 && this.pool.hasUsable(name, accounts);
      }
      return this.pool.hasUsable(name, this.credentialsOf(name, provider));
    };
    if (usable(resolved.provider)) return resolved;
    for (const f of resolved.fallbacks) {
      if (f.provider === resolved.provider && f.model === resolved.model) continue;
      if (!usable(f.provider)) continue;
      log.info(`FAILOVER ${resolved.provider}/${resolved.model} exhausted → ${f.provider}/${f.model}`);
      // The tag names the model that answers, not the one that could not: a log line saying `->m1`
      // for a turn that ran on m2 is the kind of thing that costs an hour to disbelieve.
      const asked = resolved.tag.split("->")[0] ?? resolved.model;
      return {
        provider: f.provider,
        model: f.model,
        effort: f.effort ?? resolved.effort,
        tag: `${asked}->${f.model} (failover from ${resolved.provider})`,
      };
    }
    return resolved;
  }

  /**
   * Tell the pool how a translated provider's turn went. These adapters hold their own credential —
   * an OAuth grant, or configured headers — so there is one of it, but the pool still has to hear
   * about the result or `hasUsable` says yes forever and a slot can never fail over away.
   *
   * A status of 0 means the attempt threw before an answer, which is a connect failure.
   */
  private recordOutcome(provider: string, status: number): void {
    const id = "default";
    if (status >= 400 || status === 0) this.pool.penalise(provider, id, status);
    else if (status > 0) this.pool.succeed(provider, id);
  }

  /**
   * A provider's credentials as a pool. A provider that declares none has exactly the one it always
   * had, under a fixed id so its health survives config edits that do not touch it.
   */
  private credentialsOf(name: string, provider: Config["providers"][string]): Credential[] {
    const declared = (provider as { credentials?: Credential[] }).credentials;
    if (declared && declared.length > 0) return declared;
    const headers = ("headers" in provider && provider.headers) || {};
    return [{ id: "default", headers }];
  }

  /** Health of every credential the config declares, for the dashboard. */
  credentialHealth(): Record<string, ReturnType<CredentialPool["report"]>> {
    const cfg = this.deps.config();
    const out: Record<string, ReturnType<CredentialPool["report"]>> = {};
    for (const [name, provider] of Object.entries(cfg.providers)) {
      const creds = provider.type === "anthropic" && provider.accountPool
        ? this.claudeAccounts.peekCredentials()
        : this.credentialsOf(name, provider);
      if (creds.length === 0 || (creds.length === 1 && creds[0]!.id === "default")) continue; // nothing to report about a pool of one
      out[name] = this.pool.report(name, creds).map((report) => {
        const credential = creds.find((candidate) => candidate.id === report.id);
        return credential?.ownerId ? { ...report, id: credential.ownerId } : report;
      });
    }
    return out;
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
