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
import type { Config, ProviderModel } from "./config.ts";
import type { Logger } from "./log.ts";
import { exhaustionHeaders, ModelHealth, modelDeprecation, ProviderHealth, providerExhaustion, UpstreamHealth } from "./health.ts";
import type { HoldGate } from "./hold.ts";
import { BOOTSTRAP_PATH, injectBootstrap } from "./bootstrap.ts";
import { readWorkerLadder, type WorkerLadderRoute } from "../../mod/hooks/ladder.ts";
import { routingSettings } from "../../mod/hooks/modes.ts";
import { candidateKey, isAllowed } from "../../mod/hooks/settings.ts";
import { readModRoutingSettings } from "./mod-settings.ts";
import { THREAD_UNSUPPORTED, continuesTranslatedTurn, decide, effortOf, requestKind, resolve, rewriteBody, stripThreadFields, threadDecision, type RequestKind, type Resolved } from "./routing.ts";
import { defaultAgentDir, imageLine, withAgentAliases } from "./agents.ts";
import { forwardCompatibleHeader, resolveCompatibleCaps, sanitizeForCompatible } from "./compat.ts";
import { applyIdentityToAnthropicBody, promptAdditions } from "./identity.ts";
import { anthropicServerToolBackend, webPluginBackend, webSearchBlocks, webSearchErrorBlocks, webSearchMessage, webSearchQuery, webSearchSse, type WebSearchQuery } from "./websearch.ts";
import { classify, CredentialPool, retryAfterMs, type Credential } from "./pool.ts";
import { PRESETS } from "./presets.ts";
import { ChatGptAdapter, type ChatGptAccountStatus, type ImageRequest, type ImageResult } from "./providers/chatgpt/index.ts";
import { OpenAiCompatibleAdapter } from "./providers/openai/index.ts";
import { GoogleAdapter, googleKeyRejected, type GoogleAccountStatus } from "./providers/google/index.ts";
import type { QuotaGroup } from "./providers/google/usage.ts";
import { OpenCodeUsage, isOpenCodeGo, type OpenCodeWindow } from "./providers/opencode-usage.ts";
import { GrokAdapter } from "./providers/grok/index.ts";
import type { GrokWindow } from "./providers/grok/usage.ts";
import { conversationKey, type AnthropicRequest } from "./providers/chatgpt/translate.ts";
import { adminPort, providerFor, searchProviderFor, terminateHosts } from "./config.ts";
import type { CertStore } from "./certs.ts";
import { chatPickerModels, injectPickerModels, isBootstrapPath } from "./picker.ts";
import { effortLevelsForModel } from "./admin.ts";
import { effortLevels, isTargetProvider, runsServerTools } from "./targets.ts";
import { requestConversationKey, ResponseUsageTap, requestId, type RequestLog, type RequestRecord, type RequestUsage } from "./requestlog.ts";
import { credentialHeaderValues, redactErrorText, redactHeaders } from "./redact.ts";
import type { ObservedClaudeCodeAuth } from "./providers/anthropic-observed.ts";
import type { ClaudeCodeCredentialReaders } from "./providers/anthropic.ts";
import { ClaudeAccountAuthPool } from "./providers/anthropic-account-pool.ts";
import { ClaudeModelCatalog } from "./providers/anthropic-models.ts";
import { ClaudeUsage } from "./providers/anthropic-usage.ts";
import { ClaudeCurrentIdentity } from "./providers/anthropic-identity.ts";
import { dropForeignThinking, ThinkingOrigins } from "./thinking.ts";

const MAX_BODY = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "content-length"]);
// The caller's own Anthropic credentials. A routed request authenticates as the provider, so these
// are dropped rather than forwarded: the provider header replaces only the one it happens to share
// a name with, and the other would otherwise travel to an endpoint that is not Anthropic.
const CLIENT_AUTH = new Set(["authorization", "x-api-key"]);
/** How much of an upstream error body is kept for the log. */
const ERROR_HEAD_MAX = 4096;
/** Methods safe to send twice (RFC 9110 §9.2.2), and so the only ones resent after a stale socket. */
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);

export type AbsoluteProxyRequest = { host: string; port: number; path: string; head: Buffer; tls: boolean };

/**
 * Claude Code's Remote Control registration uses HTTPS absolute-form proxy requests instead of
 * CONNECT (`POST https://api.anthropic.com/v1/environments/bridge HTTP/1.1`). Convert that legal
 * forward-proxy form to the origin form expected inside a TLS connection. Credentials and the
 * request body remain byte-for-byte client data; proxy-only headers never reach the destination.
 * Plain `http:` takes the same form and is relayed over TCP: Claude Code 2.1.288 sends its http
 * requests through HTTPS_PROXY too, loopback included (a mod reading the admin API got our 405).
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
  const secure = url.protocol === "https:";
  if ((!secure && url.protocol !== "http:") || url.username || url.password || url.hash || !url.hostname) return null;
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
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
  // One upstream connection serves one absolute-form request. Reusing it would send the next proxy-form
  // request target directly to the origin, so explicitly ask both peers to close after the response.
  const rewritten = [`${match[1]} ${path} ${match[3]}`, `Host: ${authority}`, "Connection: close", ...headers].join("\r\n") + "\r\n\r\n";
  return { host, port, path, head: Buffer.from(rewritten, "latin1"), tls: secure };
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
 * A Claude account's headers for one turn, with the client's beta flags kept. The account supplies
 * identity; the flags belong to the request, because they switch on body fields the client sent
 * (`cache_control.scope`, `context_management`, …) and the API refuses those fields without their
 * flag — `Extra inputs are not permitted` (issue #15). The account's own OAuth flags are added to
 * the client's, never used in their place. Only for native Claude accounts: a compatible vendor's
 * beta filtering happens elsewhere and must not be undone here.
 */
export function withClientBetas(credential: Record<string, string>, clientBeta: string | string[] | undefined): Record<string, string> {
  if (clientBeta === undefined) return credential;
  const name = Object.keys(credential).find((key) => key.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
  const flags = (raw: string) => raw.split(",").map((flag) => flag.trim()).filter(Boolean);
  const merged = [...new Set([...flags(([] as string[]).concat(clientBeta).join(",")), ...flags(credential[name] ?? "")])];
  return { ...credential, [name]: merged.join(",") };
}

/**
 * A body decoded for reading, as text. Bytes that cannot be decoded are read as they arrived.
 *
 * Text and not bytes, deliberately. What every caller wants from a compressed body is what it
 * says, and handing the bytes back is a one-way door: invalid UTF-8 sequences become U+FFFD and
 * never come back, while `content-encoding` still stands in the response — which is
 * `ERR_CONTENT_DECODING_FAILED` in the client (2026-09-22). Returning text leaves nothing here
 * that a later caller could mistake for something a client may be given.
 *
 * A body read to a cap stops mid-stream, and a strict decode of that throws (`Z_BUF_ERROR`,
 * measured Node 24), so these decode with a flush: it yields whatever completed, which is the head
 * of the message and the whole reason the body is read. An intact stream decodes identically.
 */
export function decodeBodyToText(body: Buffer, encoding: string | string[] | undefined): string {
  const enc = String(encoding ?? "").toLowerCase();
  const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer, o?: unknown) => Buffer }).zstdDecompressSync;
  const decode: ((b: Buffer) => Buffer) | undefined =
    enc === "gzip" || enc === "x-gzip" ? (b) => zlib.gunzipSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      : enc === "deflate" ? (b) => zlib.inflateSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
        : enc === "br" ? (b) => zlib.brotliDecompressSync(b, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
          // Chromium 152 asks for zstd, so anything the app talks to may answer with it.
          : enc === "zstd" && typeof zstd === "function" ? (b) => zstd(b, { finishFlush: zlib.constants.ZSTD_e_flush })
            : undefined;
  if (!decode) return body.toString("utf8");
  try {
    const out = decode(body);
    // A truncated zstd frame yields nothing at all and does not throw doing it, unlike the others
    // (measured 2026-09-22). Describe that instead of returning an empty body, which would read as
    // a provider that refused without saying anything.
    if (out.length === 0 && body.length > 0) return `(${body.length}B of ${enc} that stops mid-stream and cannot be decoded)`;
    return out.toString("utf8");
  } catch {
    // Nothing decodable even with a flush; fall through to what is readable in the bytes.
    return body.toString("utf8");
  }
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
  const masked = redactErrorText(decodeBodyToText(head, encoding), secrets, 300);
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
  /** Test seam for Claude Code's keychain and credential-file readers. */
  claudeCodeCredentialReaders?: ClaudeCodeCredentialReaders;
  /** Where agent definitions are read from. Defaults to `~/.claude/agents`; tests inject a tmp dir. */
  agentDir?: string;
  /** TLS dialer for absolute-form proxy requests. Production uses node:tls; integration tests inject a local CA. */
  tlsConnect?: (options: tls.ConnectionOptions) => tls.TLSSocket;
  /** Native Anthropic upstream seams for integration tests; production always uses port 443 and the default agent. */
  upstreamAgent?: https.Agent;
  upstreamPort?: number;
  /** While engaged (a network switch, tether.ts), new model calls wait here instead of starting. */
  hold?: HoldGate;
};

export type Stats = {
  inFlight: number;
  /** Subset of inFlight that are model calls (/v1/messages). Long-poll worker streams are excluded. */
  messagesInFlight: number;
  started: number;
  completed: number;
  failed: number;
  /** Epoch ms of the last model call that started / finished here; the awake and tether logic read them. */
  lastMessageStartedAt?: number;
  lastMessageEndedAt?: number;
};

export class Proxy {
  readonly stats: Stats = { inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 };
  private readonly inFlightSockets = new Set<Duplex>();
  /** Set by drain(): new model calls are refused with a retryable 503 so the count can only fall. */
  private draining = false;
  /** Model calls waiting at the hold gate (not yet in `stats`): drain() waits for them too. */
  private held = 0;
  private readonly server: net.Server;
  private readonly httpServer: http.Server;
  private readonly upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  private readonly providerAgents = new Map<string, http.Agent | https.Agent>();
  private readonly chatgptAdapters = new Map<string, { key: string; adapter: ChatGptAdapter }>();
  private readonly openaiAdapters = new Map<string, { key: string; adapter: OpenAiCompatibleAdapter }>();
  private readonly googleAdapters = new Map<string, { key: string; adapter: GoogleAdapter }>();
  private readonly grokAdapters = new Map<string, { key: string; adapter: GrokAdapter }>();
  private readonly claudeAccounts: ClaudeAccountAuthPool;
  /** Each Claude subscription account's usage, for the admin status (never a token). */
  readonly claudeUsage: ClaudeUsage;
  /** The Claude models the signed-in account can use, from Anthropic's own list. */
  readonly claudeModels: ClaudeModelCatalog;
  /** Who the current Claude login is (never a token), so admin can spot a stored copy of it. */
  readonly claudeIdentity: ClaudeCurrentIdentity;
  /** Each OpenCode Go provider's usage windows, for the status bar's limits row (never a key). */
  private readonly opencodeUsage: OpenCodeUsage;
  private readonly deps: ProxyDeps;
  /**
   * Cooldowns, quarantines and conversation stickiness for provider credentials. In memory: a
   * cooldown that outlived a restart would make restarting worse, and a rejected credential earns
   * its quarantine again on the first request.
   */
  private readonly pool = new CredentialPool();
  /** Last configured implicit headers, not model-folded headers: changing wire must not reset health. */
  private readonly implicitCredentialHeaders = new Map<string, string>();
  /** Recent non-Anthropic answers whose vendor ids cannot identify the route by their shape. */
  private readonly routedMessageIds = new Set<string>();
  private readonly thinkingOrigins = new ThinkingOrigins();
  readonly providerHealth = new ProviderHealth();
  readonly modelHealth = new ModelHealth();
  private readonly healthConfig = new Map<string, { config: string; credentials: string; keys: Record<string, string> }>();
  /** Agent/session-scoped spawn snapshots survive compaction, never shared by model id. */
  private readonly workerLadders = new Map<string, WorkerLadderRoute>();

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

  /**
   * The models that provider can reach, from the Codex backend's own catalogue, so a model OpenAI
   * ships appears in the GUI and the picker without a release here. Null when the catalogue cannot
   * be read; the caller falls back to a measured list.
   */
  chatgptFetchModels(name: string): Promise<ProviderModel[] | null> {
    const cfg = this.deps.config().providers[name];
    if (!cfg || cfg.type !== "chatgpt") return Promise.resolve(null);
    return this.chatgpt(name, cfg).fetchModels();
  }

  /** Startup refresh: every configured chatgpt provider, in the background, never awaited. */
  chatgptRefreshAll(): void {
    for (const [name, p] of Object.entries(this.deps.config().providers)) {
      if (p.type === "chatgpt") void this.chatgptFetchRateLimits(name);
    }
  }

  /**
   * Read every configured chatgpt provider's model catalogue now, in the background. Nothing else
   * asks for it unless the dashboard is open, yet it is where a model's real window comes from
   * (6.1 Sol: 500000 × 95% = 475000, ARCHITECTURE §4). The adapter keeps its own hour-long cache,
   * so a caller may ask as often as it likes; the startup call and the periodic one in index.ts
   * share that cache. Never throws.
   */
  chatgptRefreshCatalog(): void {
    for (const [name, p] of Object.entries(this.deps.config().providers)) {
      if (p.type === "chatgpt") void this.chatgptFetchModels(name).catch(() => {});
    }
  }

  chatgptAuthStatus(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, a] of this.chatgptAdapters) out[name] = a.adapter.describeAuth();
    return out;
  }

  /** Every configured chatgpt provider's accounts: rotation state and last known quota, no tokens. */
  chatgptAccounts(): Record<string, ChatGptAccountStatus[]> {
    const out: Record<string, ChatGptAccountStatus[]> = {};
    for (const [name, p] of Object.entries(this.deps.config().providers)) {
      if (p.type === "chatgpt") out[name] = this.chatgpt(name, p).accountStatus();
    }
    return out;
  }

  /**
   * The accounts Codex's own GPT traffic goes out on: the named chatgpt provider, else the first
   * one configured, else Codex's own login alone — so pointing Codex here works before anyone has
   * set a ChatGPT provider up, and shares the pool (cooldowns included) once someone has.
   */
  chatgptForCodex(name: string | null): ChatGptAdapter {
    const providers = this.deps.config().providers;
    const named = name ? providers[name] : undefined;
    if (named?.type === "chatgpt") return this.chatgpt(name!, named);
    const first = Object.entries(providers).find(([, p]) => p.type === "chatgpt");
    if (first && first[1].type === "chatgpt") return this.chatgpt(first[0], first[1]);
    return this.chatgpt("codex-login", { type: "chatgpt", auth: "borrow-codex" });
  }

  /**
   * One image for `/api/image`, on the first chatgpt provider and the first model it declares. The
   * model only runs the tool call — the image comes from the backend's own image model — so which
   * one it is barely matters. The call is recorded like a proxied request, success or failure, so
   * the dashboard's usage and request list show the subscription's image traffic.
   */
  async generateImage(req: ImageRequest, signal?: AbortSignal, meta?: { session?: string }): Promise<ImageResult> {
    const first = Object.entries(this.deps.config().providers).find(([, p]) => p.type === "chatgpt");
    if (!first || first[1].type !== "chatgpt") throw new Error("image generation needs a ChatGPT provider; add one in the dashboard");
    const model = first[1].models?.[0]?.id;
    if (!model) throw new Error(`provider ${first[0]} declares no models`);
    const at = new Date().toISOString();
    const started = Date.now();
    try {
      const image = await this.chatgpt(first[0], first[1]).generateImage(model, req, signal);
      const record: RequestRecord = {
        kind: "image",
        source: model,
        target: "image",
        provider: first[0],
        stream: false,
        id: requestId(),
        at,
        ms: Date.now() - started,
        ok: true,
        status: 200,
        ...(image.usage ? { usage: image.usage } : {}),
        note: `${image.size ?? "?"} ${image.quality ?? "?"} ${image.format}, ${req.images?.length ?? 0} reference(s)`,
        ...(meta?.session ? { session: meta.session } : {}),
      };
      this.deps.requests.add(record);
      return image;
    } catch (e) {
      const record: RequestRecord = {
        kind: "image",
        source: model,
        target: "image",
        provider: first[0],
        stream: false,
        id: requestId(),
        at,
        ms: Date.now() - started,
        ok: false,
        status: signal?.aborted ? "aborted" : 502,
        note: (e as Error).message.slice(0, 300),
        ...(meta?.session ? { session: meta.session } : {}),
      };
      this.deps.requests.add(record);
      throw e;
    }
  }

  /** Dashboard action: put one resting ChatGPT account back into rotation now. */
  chatgptClearCooldown(ownerId: string): void {
    for (const [name, p] of Object.entries(this.deps.config().providers)) {
      if (p.type === "chatgpt") this.chatgpt(name, p).clearCooldown(ownerId);
    }
  }

  private chatgpt(name: string, cfg: Extract<Config["providers"][string], { type: "chatgpt" }>): ChatGptAdapter {
    const key = JSON.stringify(cfg);
    const cur = this.chatgptAdapters.get(name);
    if (cur && cur.key === key) return cur.adapter;
    const adapter = new ChatGptAdapter(name, cfg, this.deps.home, this.deps.log, this.pool);
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

  private grok(name: string, cfg: Extract<Config["providers"][string], { type: "grok" }>): GrokAdapter {
    const key = JSON.stringify(cfg);
    const cur = this.grokAdapters.get(name);
    if (cur && cur.key === key) return cur.adapter;
    const adapter = new GrokAdapter(name, cfg, this.deps.log);
    this.grokAdapters.set(name, { key, adapter });
    return adapter;
  }

  private google(name: string, cfg: Extract<Config["providers"][string], { type: "google" }>): GoogleAdapter {
    const key = JSON.stringify(cfg);
    const cur = this.googleAdapters.get(name);
    if (cur && cur.key === key) return cur.adapter;
    const adapter = new GoogleAdapter(name, cfg, this.deps.home, this.deps.log, this.pool);
    this.googleAdapters.set(name, { key, adapter });
    return adapter;
  }

  /**
   * Every configured google provider's Antigravity accounts: rotation state only, never a token.
   * Empty for api-key providers and for an adapter that has not been created yet.
   */
  googleAccounts(): Record<string, GoogleAccountStatus[]> {
    const out: Record<string, GoogleAccountStatus[]> = {};
    for (const [name, p] of Object.entries(this.deps.config().providers)) {
      if (p.type === "google" && p.auth === "antigravity") out[name] = this.google(name, p).accountStatus();
    }
    return out;
  }

  /** The models a google provider can reach now, from Cloud Code Assist's own catalogue. */
  googleFetchModels(name: string): Promise<ProviderModel[] | null> {
    const cfg = this.deps.config().providers[name];
    if (!cfg || cfg.type !== "google" || cfg.auth !== "antigravity") return Promise.resolve(null);
    return this.google(name, cfg).fetchModels();
  }

  /** Each google provider account's quota groups by owner id, for the status bar's limits row. */
  googleUsage(name: string): Promise<Record<string, QuotaGroup[]>> {
    const cfg = this.deps.config().providers[name];
    if (!cfg || cfg.type !== "google" || cfg.auth !== "antigravity") return Promise.resolve({});
    return this.google(name, cfg).usageSnapshot();
  }

  /** A Grok provider's usage pool, for the status bar's limits row. Empty otherwise. */
  grokLimits(name: string): Promise<GrokWindow[]> {
    const cfg = this.deps.config().providers[name];
    if (!cfg || cfg.type !== "grok") return Promise.resolve([]);
    return this.grok(name, cfg).usage();
  }

  /** An OpenCode Go provider's usage windows, for the status bar's limits row. Empty otherwise. */
  opencodeLimits(name: string, credentialId?: string): Promise<OpenCodeWindow[]> {
    const cfg = this.deps.config().providers[name];
    if (!cfg || cfg.type !== "openai-compatible" || !isOpenCodeGo(cfg)) return Promise.resolve([]);
    const credential = credentialId === undefined ? undefined : cfg.credentials?.find((c) => c.id === credentialId);
    if (credentialId !== undefined && !credential) return Promise.resolve([]);
    return this.opencodeUsage.windows(credential ? `${name}/${credential.id}` : name, cfg.url, credential?.headers ?? cfg.headers ?? {});
  }

  /** Dashboard action: put one resting Google account back into rotation now. */
  /** The pool scope a turn for `model` rests in on one antigravity provider (its quota group on its host). */
  googleQuotaScope(name: string, model: string): string | undefined {
    const p = this.deps.config().providers[name];
    return p?.type === "google" && p.auth === "antigravity" ? this.google(name, p).quotaScopeOf(model) : undefined;
  }

  googleClearCooldown(ownerId: string): void {
    for (const [name, p] of Object.entries(this.deps.config().providers)) {
      if (p.type === "google" && p.auth === "antigravity") this.google(name, p).clearCooldown(ownerId);
    }
  }

  /** Ask again whether an account still needs Google's verification page; the first provider that knows answers. */
  async googleRecheckVerification(ownerId: string): Promise<"verified" | "still-required" | "unknown"> {
    for (const [name, p] of Object.entries(this.deps.config().providers)) {
      if (p.type !== "google" || p.auth !== "antigravity") continue;
      const result = await this.google(name, p).recheckVerification(ownerId);
      if (result !== "unknown") return result;
    }
    return "unknown";
  }

  /** ConfigStore calls this on reload; requests also reconcile injected/mutable configs. */
  reconcileConfig(cfg: Config): void {
    const digest = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    for (const [name, provider] of Object.entries(cfg.providers)) {
      const authentication = Object.entries(provider).filter(([field]) =>
        ["type", "auth", "headers", "credentials", "apiKey", "accountPool", "home"].includes(field));
      const credentials = digest(authentication);
      const config = digest([...authentication, ...Object.entries(provider).filter(([field]) =>
        ["url", "models", "wire"].includes(field))]);
      const declared = "credentials" in provider ? provider.credentials : undefined;
      const keys = declared?.length ? Object.fromEntries(declared.map(key => [key.id, digest(key.headers)])) : { default: credentials };
      const previous = this.healthConfig.get(name);
      if (previous && previous.config !== config) this.modelHealth.clear(name);
      if (previous && previous.credentials !== credentials) {
        this.providerHealth.clear(name);
        // Preserve unchanged spent keys when a new one is added; only replaced generations revive.
        for (const [id, generation] of Object.entries(previous.keys)) {
          if (keys[id] !== generation) this.pool.clear(name, id);
        }
      }
      this.healthConfig.set(name, { config, credentials, keys });
    }
    for (const name of this.healthConfig.keys()) {
      if (cfg.providers[name]) continue;
      this.healthConfig.delete(name);
      this.modelHealth.clear(name);
      this.providerHealth.clear(name);
      this.pool.clear(name);
    }
  }

  constructor(deps: ProxyDeps) {
    this.deps = deps;
    this.reconcileConfig(deps.config());
    this.claudeAccounts = new ClaudeAccountAuthPool({
      home: deps.home,
      log: deps.log,
      ...(deps.observedClaudeCodeAuth ? { observed: deps.observedClaudeCodeAuth } : {}),
      ...(deps.claudeCodeCredentialReaders ? { credentialReaders: deps.claudeCodeCredentialReaders } : {}),
    });
    this.claudeUsage = new ClaudeUsage(this.claudeAccounts, {
      upstream: () => this.deps.config().upstream,
      warn: (message) => deps.log.warn(message),
    });
    this.claudeModels = new ClaudeModelCatalog(this.claudeAccounts, {
      upstream: () => this.deps.config().upstream,
      warn: (message) => deps.log.warn(message),
    });
    this.claudeIdentity = new ClaudeCurrentIdentity(this.claudeAccounts, {
      upstream: () => this.deps.config().upstream,
      warn: (message) => deps.log.warn(message),
    });
    this.opencodeUsage = new OpenCodeUsage({ warn: (message) => deps.log.warn(message) });
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
    // A call held for a network switch (hold.ts) goes on now and meets the 503 below; until it has,
    // it is counted in `held`, so it is not cut by close(). A closed gate never holds again.
    const released = this.deps.hold?.close() ?? 0;
    if (released) this.deps.log.info(`drain: released ${released} model call(s) held for a network switch`);
    this.server.close();
    const t0 = Date.now();
    while ((this.stats.messagesInFlight > 0 || this.held > 0) && Date.now() - t0 < maxMs) {
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
          log.info(`ABSOLUTE ${method ?? "?"} ${absolute.tls ? "https" : "http"}://${absolute.host}:${absolute.port}${absolute.path}`);
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
    const up = request.tls
      ? (this.deps.tlsConnect ?? tls.connect)({ host: request.host, port: request.port, ...(servername ? { servername } : {}), ALPNProtocols: ["http/1.1"] })
      : net.connect({ host: request.host, port: request.port });
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
    up.once(request.tls ? "secureConnect" : "connect", () => {
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
    // A network switch is making a gap (hold.ts): a new model call waits here, before its body is
    // read or it is counted, so the switch only waits for calls that were already running. Nothing
    // is written and nothing refused; it goes ahead on release or after the longest hold. A draining
    // router refuses below instead, so it never holds.
    const hold = this.deps.hold;
    if (hold?.engaged && !this.draining && (req.url ?? "/").startsWith("/v1/messages")) {
      this.held++;
      const held = await hold.wait().finally(() => this.held--);
      log.info(`HOLD ${req.method ?? "?"} ${req.url ?? "/"} waited ${(held.ms / 1000).toFixed(1)}s${held.timedOut ? " (longest hold reached; going ahead)" : ""}`);
      if (req.socket?.destroyed) {
        log.warn(`HOLD ${req.method ?? "?"} ${req.url ?? "/"}: the client left while held`);
        return;
      }
    }
    // The agent files' derived aliases join the config's own, so a marker naming a worker resolves
    // the same way here as it does everywhere else. Explicit aliases win; the scan is mtime-cached.
    const cfg = withAgentAliases(this.deps.config(), this.deps.agentDir ?? defaultAgentDir(), log);
    this.reconcileConfig(cfg);
    const t0 = Date.now();
    const method = req.method ?? "?";
    const path = req.url ?? "/";
    this.stats.started++;
    this.stats.inFlight++;
    const isMessages = path.startsWith("/v1/messages");
    // The CLI sends `/v1/messages?beta=true`: compare the pathname, not the raw path.
    const pathname = path.split("?")[0] ?? path;
    const isLoggedRequest = pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens";
    if (isMessages) {
      this.stats.messagesInFlight++;
      this.stats.lastMessageStartedAt = t0;
    }
    let tag = "PASS";
    let finished = false;
    let clientClosed = false;
    res.once("close", () => { clientClosed = !res.writableEnded; });
    let record: Omit<RequestRecord, "at" | "id" | "ms" | "status" | "ok" | "usage" | "stopReason" | "note"> = {
      kind: pathname === "/v1/messages/count_tokens" ? "count_tokens" : pathname === "/v1/messages" ? "messages" : "other",
      source: "-",
      target: "-",
      provider: "anthropic",
      stream: false,
    };
    const session = req.headers["x-claude-code-session-id"];
    if (typeof session === "string" && /^[\w-]{1,128}$/.test(session)) record.session = session;
    // Claude Code names the agent a request was made inside, and only a subagent's request carries
    // the name (CLI 2.1.304: `...Y?.agentId&&{"x-claude-code-agent-id":…}`). This one bit is what
    // tells the main session from a subagent's turns, so it is recorded for every provider and read
    // by the ChatGPT adapter to choose its tier.
    const agentId = req.headers["x-claude-code-agent-id"];
    const subagent = typeof agentId === "string" && agentId.length > 0;
    if (subagent) record.subagent = true;
    let observedUsage: RequestUsage | undefined;
    let observedStopReason: string | undefined;
    // Set once a Google turn came back unwritten (a prompt refusal or no model capacity), which allows
    // one route fallback per request.
    let unwrittenFallbackNote: string | undefined;
    let unwrittenSeen = false;
    // `failed` counts requests that did not get a proper response (vanished, upstream error,
    // provider error). A note alone is not a failure: adapters attach usage notes on success.
    const finish = (status: string, bytes: number, note?: string, failed: boolean = note !== undefined, extra?: { usage?: RequestUsage; stopReason?: string; resent?: boolean; messageId?: string; requestedTier?: string; servedTier?: string; upstreamCalled?: false | undefined; refusal?: RequestRecord["refusal"] }): void => {
      if (finished) return;
      finished = true;
      // A translated adapter may have sent 200 before the client left. That is not a
      // completed turn; reuse the request log's existing string-status contract.
      const cancelled = clientClosed || (res.destroyed && !res.writableEnded);
      if (cancelled) {
        status = "aborted";
        failed = true;
        note = "client closed";
      }
      if (unwrittenFallbackNote) note = [unwrittenFallbackNote, note].filter(Boolean).join("; ");
      this.stats.inFlight--;
      if (isMessages) {
        this.stats.messagesInFlight--;
        this.stats.lastMessageEndedAt = Date.now();
      }
      if (failed) this.stats.failed++;
      else this.stats.completed++;
      const ms = Date.now() - t0;
      log.info(`${tag} ${method} ${path} -> ${status} ${bytes}B ${(ms / 1000).toFixed(1)}s${record.credential ? ` credential=${record.credential}` : ""}${note ? " " + note : ""}`);
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
          ok: !failed && Number.isFinite(numericStatus) && numericStatus >= 200 && numericStatus < 400,
        };
        if (usage) completed.usage = usage;
        if (stopReason && !cancelled) completed.stopReason = stopReason;
        if (note) completed.note = note;
        if (extra?.resent && !completed.ok) completed.resent = true;
        if (extra?.messageId !== undefined) completed.messageId = extra.messageId;
        if (extra?.requestedTier !== undefined) completed.requestedTier = extra.requestedTier;
        if (extra?.servedTier !== undefined) completed.servedTier = extra.servedTier;
        if (extra?.upstreamCalled === false && !unwrittenSeen) completed.upstreamCalled = false;
        if (extra?.refusal !== undefined) completed.refusal = extra.refusal;
        const provider = cfg.providers[completed.provider];
        if (completed.ok && completed.kind === "messages" && completed.messageId && provider && provider.type !== "anthropic") {
          this.routedMessageIds.delete(completed.messageId);
          this.routedMessageIds.add(completed.messageId);
          // In memory only, bounded independently of the persistent request log.
          if (this.routedMessageIds.size > 10_000) {
            const oldest = this.routedMessageIds.values().next().value;
            if (oldest !== undefined) this.routedMessageIds.delete(oldest);
          }
        }
        if (completed.ok && completed.kind === "messages" && numericStatus >= 200 && numericStatus < 300 && extra?.upstreamCalled !== false) {
          this.modelHealth.success(completed.provider, completed.target);
        }
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
      finish("503", msg.length, "refused during drain (client retries)", false, { resent: true, upstreamCalled: false, refusal: "drain" });
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
    const kind: RequestKind = json && isApiHost && path.startsWith("/v1/messages") ? requestKind(json, pathname) : "turn";
    // A WebSearch arrives as its own request aimed at ANTHROPIC_SMALL_FAST_MODEL, recognised by the
    // forced `web_search` server tool rather than by its model id. Recognise it whether or not a
    // backend is configured: `cfg.webSearch` decides who answers it, but knowing that this is a
    // search is what lets the guard below refuse a provider that cannot run one. Tying the two
    // together meant an unconfigured router could not tell a search from any other turn.
    if (json) {
      record.source = record.target = typeof model === "string" ? model : "-";
      record.stream = json.stream === true;
      if (pathname === "/v1/messages") {
        const conversation = requestConversationKey(json, record.session, typeof agentId === "string" ? agentId : undefined);
        if (conversation) record.conversation = conversation;
      }
      if (kind === "auto-mode-classifier") record.purpose = "auto-mode-classifier";
      if (cfg.webSearch && kind === "web-fetch") record.purpose = "web-fetch";
    }
    // Pool affinity must distinguish workers whose injected first 4000 characters are identical.
    // Capture before routing/sanitizing rewrites the prompt; retries use exactly this same identity.
    // Metadata-less side requests retain their shared cache-class key, never a per-request id.
    const cacheRequest = json && Array.isArray(json.messages) ? json as AnthropicRequest : null;
    const sideRequest = cacheRequest && !subagent && !cacheRequest.metadata?.user_id && cacheRequest.messages.length <= 1;
    const affinity = cacheRequest ? (!sideRequest ? requestConversationKey(json!, record.session, subagent ? agentId : undefined) : undefined) ?? conversationKey(cacheRequest) : undefined;
    const recordCredential = (name: string, using: Credential, credentials: readonly Credential[], retry = false): void => {
      // count_tokens is answered locally by the translated adapters: no key was actually sent.
      const type = cfg.providers[name]?.type;
      if (pathname === "/v1/messages/count_tokens" && (type === "openai-compatible" || type === "google")) return;
      record.credential = this.credentialLabel(name, using, credentials);
      const first = this.pool.pick(name, credentials);
      const reason = retry ? "retry" : !first ? "all-unavailable" : first.id !== using.id ? "affinity" : "configured-order";
      const states = this.pool.report(name, credentials).map((row, i) => `${this.credentialLabel(name, credentials[i]!, credentials)}:${row.paused ? "paused" : row.state}`).join(", ");
      log.info(`KEY ${name} credential=${record.credential} conversation=${affinity ?? "-"} reason=${reason} candidates=[${states}]`);
    };
    const search = kind === "web-search" ? webSearchQuery(json!) : null;
    let searchAttempted = false;
    const markSearchAttempted = (): void => { searchAttempted = true; };
    if (search && cfg.webSearch) {
      const served = await this.serveWebSearch(res, json!, search, cfg.webSearch, record, finish, markSearchAttempted);
      if (served) return;
      // Fall through on failure: the ordinary path still answers, and a search that quietly
      // returns nothing is worse than one that costs what it always cost.
    }

    const webFetch = !!cfg.webSearch && kind === "web-fetch";
    let fetchRoute: Resolved | null = null;
    if (webFetch && cfg.webSearch) {
      const settings = cfg.webSearch;
      if (this.targetUsable(settings, cfg)) {
        const ladder = effortLevels(cfg).providers[settings.provider];
        const levels = ladder?.models?.[settings.model] ?? ladder?.default ?? [];
        fetchRoute = {
          ...settings,
          effort: levels.includes("low") ? "low" : undefined,
          tag: `${String(model)}->${settings.model} (web fetch)`,
          kind: "web-fetch",
          asked: String(model),
        };
      } else {
        unwrittenFallbackNote = `web fetch via ${settings.provider} unavailable; original destination fallback`;
        log.warn(`web fetch via ${settings.provider}: provider unusable; leaving the request alone`);
      }
    }
    const originalBody = body;
    const originalJson = fetchRoute ? structuredClone(json) : null;
    const originalRecord = { ...record };
    const response = res;
    const complete = finish;
    // Every provider still uses the ordinary path below. Only this opt-in side request may
    // withhold an error response and retry the original destination, before the first byte.
    const run = async (fetchTarget: Resolved | null): Promise<void> => {
      let attemptDone = false;
      const res = fetchTarget ? deferErrorResponse(response, () => attemptDone) : response;
      const finish: typeof complete = (status, bytes, note, failed, extra) => {
        if (attemptDone) return;
        if (fetchTarget && !response.headersSent && !response.destroyed && !req.aborted && (Number(status) >= 400 || !Number.isFinite(Number(status)) || Number(status) <= 0)) {
          attemptDone = true;
          // A later local refusal must not claim that no upstream was called on this request.
          searchAttempted ||= extra?.upstreamCalled !== false;
          log.warn(`web fetch via ${fetchTarget.provider}: ${note ?? status}; falling back to original destination`);
          body = originalBody;
          json = structuredClone(originalJson);
          record = { ...originalRecord, purpose: "web-fetch" };
          unwrittenFallbackNote = `web fetch via ${fetchTarget.provider} failed; original destination fallback`;
          void run(null).catch((error: Error) => {
            complete("502", 0, `web fetch fallback error: ${error.message}`);
            if (!response.headersSent) response.writeHead(502).end();
            else response.destroy();
          });
          return;
        }
        if (!fetchTarget) { complete(status, bytes, note, failed, extra); return; }
        complete(status, bytes, [`web fetch via ${fetchTarget.provider}`, note].filter(Boolean).join("; "), failed ?? (!!note || Number(status) >= 400), extra);
      };
      if (fetchTarget && json) {
        record.purpose = "web-fetch";
        const output = { ...(json.output_config as Record<string, unknown> | undefined) };
        delete output.effort;
        json.output_config = output;
      }
      const decision = fetchTarget
        ? { route: fetchTarget, refusal: null }
        : json ? decide(model, json, cfg, kind) : { route: null, refusal: null };
      let resolved = decision.route;
      if (!fetchTarget && subagent && resolved && json) {
        resolved = this.workerFallbacks(resolved, json, cfg, typeof model === "string" ? model : "", record.session && `${record.session}:${agentId}`);
      }

      // A non-Claude model this router cannot route is refused here, by name, instead of being
      // forwarded to Anthropic. `PASS` on such a request answers 404 from Anthropic and looks like
      // "the model vanished" (2026-09-20: an agent file named `deepseek` resolved, through a missing
      // alias, to a model no provider declared — thirty of them came back 404). A native `claude-*`
      // id is deliberately unrouted and must keep passing through (§5).
      if (!resolved && isApiHost && isMessages && json) {
        const reason = decision.refusal;
        if (reason) {
          const payload = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `ClaudeRipple: ${reason}` } });
          res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }).end(payload);
          tag = `REFUSE ${String(model)}`;
          record = { ...record, provider: "refused" };
          finish("400", payload.length, `ClaudeRipple: ${reason}`, true, { ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "unroutable" });
          return;
        }
      }
      // A continue of a turn a translated provider answered carries no marker to route by and would
      // pass through to Anthropic, which has no such thread (404). Refused the way a translated route
      // refuses it, so the CLI resends the whole conversation, marker included, and stays stateless.
      if (!resolved && isApiHost && isMessages && json && continuesTranslatedTurn(json, this.routedMessageIds)) {
        const out = JSON.stringify(THREAD_UNSUPPORTED);
        res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
        finish("400", out.length, "continue of a translated turn refused → CLI resends stateless", false, { resent: true, ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "thread-continue" });
        return;
      }
      // A slot with fallbacks picks its provider before anything is sent, so a primary that is rate
      // limited for the next hour is skipped rather than rediscovered once per request. A distinct
      // prompt refusal can also select one fallback below, but only before any response is written.
      let route = resolved ? this.chooseTarget(resolved, cfg, log) : null;
      if (resolved?.ladderPick && route && (route.provider !== resolved.provider || route.model !== resolved.model)) {
        unwrittenFallbackNote = `ladder pick=${resolved.ladderPick} fallback ${resolved.provider}/${resolved.model} → ${route.provider}/${route.model}: ${this.unavailableReason(resolved) ?? "provider_unusable"}`;
      }
      /** The request before any target rewrote it, kept only when a Google target may hand the turn back. */
      let pristine: typeof json | undefined;
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
      if (search && route && json && !runsServerTools(cfg, route.provider)) {
        // A ChatGPT provider has a search of its own — the backend `webSearch` names — so a search
        // routed there is served by it, not refused. Requiring `webSearch` as well refused every
        // search of a `smallFast` slot pointed at Luna while the Clients screen called that provider
        // searchable (2026-10-07: 41 searches failed with nothing on screen to say why). A configured
        // backend on this same provider has already had its try above.
        // The same holds for a plan that searches on another of its endpoints (`anthropicSearch`).
        const own = (cfg.providers[route.provider]?.type === "chatgpt" || searchProviderFor(cfg.providers[route.provider], route.model) !== undefined) &&
          cfg.webSearch?.provider !== route.provider;
        if (own && (await this.serveWebSearch(res, json, search, { provider: route.provider, model: route.model }, record, finish, markSearchAttempted))) return;
        const blocks = webSearchErrorBlocks(search, "unavailable");
        const model = typeof json.model === "string" ? json.model : "unknown";
        const wantStream = json.stream === true;
        const payload = wantStream ? webSearchSse(model, blocks, 0) : JSON.stringify(webSearchMessage(model, blocks, 0));
        res.writeHead(200, wantStream
          ? { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }
          : { "content-type": "application/json" }).end(payload);
        log.warn(`web search: ${route.provider} cannot run server tools and no webSearch backend is configured; refused rather than answered with invented results`);
        record = { ...record, target: route.model, provider: route.provider, purpose: "web-search" };
        finish("200", Buffer.byteLength(payload), `web search refused: ${route.provider} runs no server tools`, false, { ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "web-search-unsupported" });
        return;
      }

      let compatCaps: ReturnType<typeof resolveCompatibleCaps> | undefined;
      let compatChanges: string[] = [];
      /** The credential this attempt is using, and so the one a failure is charged to. */
      let chosen: Credential | null = null;
      let credentialCandidates: readonly Credential[] = [];
      let penalised: { provider: string; id: string } | null = null;
      let target: { protocol: "http:" | "https:"; host: string; port: number; agent: http.Agent | https.Agent; extraHeaders: Record<string, string>; basePath?: string; dropClientAuth?: boolean; dropHeaders?: Set<string>; dropHeaderPrefixes?: string[] };
      // Re-enter only for the one unwritten Google turn (prompt refusal or no model capacity). Each target sees the original
      // request, not the primary's rewritten effort, stripped thread, or translated body.
      for (;;) {
        if (pristine) json = structuredClone(pristine);
        if (route && json) {
          record = { ...record, target: route.model, provider: route.provider };
          delete record.effort;
          const configured = cfg.providers[route.provider];
          if (!configured) {
            finish("500", 0, `unknown provider ${route.provider}`, true, { ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "unknown-provider" });
            res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "clauderipple_config", message: `unknown provider ${route.provider}` } }));
            return;
          }
          // A model may speak another wire than the rest of its provider: one subscription serving
          // several protocols is one provider, and this is where the model's own shape is folded in so
          // the branches below pick the adapter it actually needs.
          const provider = providerFor(configured, route.model);
          // Translators scope reasoning themselves. A native/compatible fallback cannot validate
          // the original provider's opaque signatures, whether selected by a ladder or a route.
          if (provider.type === "anthropic-compatible" || provider.type === "anthropic") {
            const targetProvider = route.provider;
            if (resolved && (targetProvider !== resolved.provider || route.model !== resolved.model)) {
              dropForeignThinking(json, targetProvider !== resolved.provider
                ? block => this.thinkingOrigins.owns(targetProvider, block) : undefined);
            } else {
              this.thinkingOrigins.dropKnownForeign(json, targetProvider);
            }
          }
          // Only the Google adapter can return a turn unwritten, so only it pays for the copy.
          if (!pristine && provider.type === "google") pristine = structuredClone(json);
          rewriteBody(json, route, cfg.effortClamp);
          if (provider.type === "chatgpt") {
            const td = threadDecision(json);
            if (td === "refuse") {
              const out = JSON.stringify(THREAD_UNSUPPORTED);
              res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
              finish("400", out.length, "thread continue refused → CLI resends stateless", false, { resent: true, ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "thread-continue" });
              return;
            }
            if (td === "strip") stripThreadFields(json);
            const routeEffort = effortOf(json);
            if (routeEffort) record.effort = routeEffort;
            tag = `CHATGPT ${route.tag} effort=${routeEffort ?? "-"}`;
            try {
              // The adapter reports each account's outcome to the shared pool itself, so a slot pointing
              // here fails over once every account is out (chooseTarget asks the adapter).
              const o = await this.chatgpt(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, effortOf(json), { subagent, imageHint: imageLine(adminPort(cfg)), kind: route.kind });
              if (!path.startsWith("/v1/messages/count_tokens")) this.providerHealth.observe(route.provider, o.status, o.exhaustion);
              finish(String(o.status), o.bytes, o.note, o.status >= 400, { ...o, ...(searchAttempted ? { upstreamCalled: undefined } : {}) });
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
              finish("400", out.length, "thread continue refused → CLI resends stateless", false, { resent: true, ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "thread-continue" });
              return;
            }
            if (td === "strip") stripThreadFields(json);
            const routeEffort = effortOf(json);
            if (routeEffort) record.effort = routeEffort;
            tag = `OPENAI ${route.tag} wire=${provider.wire ?? "chat"} effort=${routeEffort ?? "-"}`;
            const credentials = this.credentialsOf(route.provider, provider);
            if (credentials.length === 0) {
              const out = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "모든 API 키가 일시 중지되어 있습니다." } });
              res.writeHead(503, { "content-type": "application/json" }).end(out);
              finish("503", out.length, "all credentials paused", false, { upstreamCalled: false });
              return;
            }
            let using = this.pool.pick(route.provider, credentials, affinity) ?? credentials[0]!;
            recordCredential(route.provider, using, credentials);
            const tried = new Set([using.id]);
            const poolName = route.provider;
            const next = credentials.length > 1 ? (status: number, retryAfter: number | undefined, body: string): Record<string, string> | null => {
              if (!classify(status, undefined, body).retryable) return null;
              const candidate = this.pool.pick(poolName, credentials.filter((c) => !tried.has(c.id)), affinity);
              if (!candidate) return null;
              this.pool.penalise(poolName, using.id, status, retryAfter, body);
              log.info(`RETRY ${poolName}: ${this.credentialLabel(poolName, using, credentials)} answered ${status}, trying ${this.credentialLabel(poolName, candidate, credentials)}`);
              using = candidate;
              recordCredential(poolName, using, credentials, true);
              tried.add(using.id);
              return using.headers;
            } : undefined;
            try {
              const o = await this.openai(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, routeEffort, { headers: using.headers, ...(next ? { next } : {}) }, { kind: route.kind });
              if (o.status >= 400) this.pool.penalise(poolName, using.id, o.upstreamStatus ?? o.status, o.retryAfterMs, o.errorBody);
              else if (o.status > 0) this.pool.succeed(poolName, using.id);
              if (!path.startsWith("/v1/messages/count_tokens")) {
                this.providerHealth.observe(route.provider, o.status, o.exhaustion);
                this.modelHealth.observe(route.provider, route.model, o.modelUnavailable);
              }
              finish(String(o.status), o.bytes, o.note, o.status >= 400, { ...o, ...(searchAttempted ? { upstreamCalled: undefined } : {}) });
            } catch (e) {
              if (!res.destroyed && !req.aborted) this.pool.penalise(poolName, using.id, 0);
              finish("-", 0, `openai error ${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`);
              if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: (e as Error).message } }));
              else res.destroy();
            }
            return;
          }
          if (provider.type === "google") {
            // Google holds no server-side thread either, so a `continue` is refused as it is for the
            // other translated providers; the CLI resends the turn with the full history.
            const td = threadDecision(json);
            if (td === "refuse") {
              const out = JSON.stringify(THREAD_UNSUPPORTED);
              res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
              finish("400", out.length, "thread continue refused → CLI resends stateless", false, { resent: true, ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "thread-continue" });
              return;
            }
            if (td === "strip") stripThreadFields(json);
            const routeEffort = effortOf(json);
            if (routeEffort) record.effort = routeEffort;
            tag = `GOOGLE ${route.tag} effort=${routeEffort ?? "-"}`;
            // The api-key wire takes its key from the provider's pool like every other translated
            // wire: folding a relay's Gemini model into a `google` provider used to leave only its
            // first key, so a spent key answered 429 to every turn, with no failover and no
            // `credential` in the log (#112). The antigravity accounts are the adapter's own pool
            // and rotate inside it, exactly as before.
            const credentials = provider.auth === "api-key" ? this.credentialsOf(route.provider, provider) : [];
            if (provider.auth === "api-key" && credentials.length === 0) {
              const out = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "모든 API 키가 일시 중지되어 있습니다." } });
              res.writeHead(503, { "content-type": "application/json" }).end(out);
              finish("503", out.length, "all credentials paused", false, { upstreamCalled: false });
              return;
            }
            const poolName = route.provider;
            let using = provider.auth === "api-key" ? this.pool.pick(poolName, credentials, affinity) ?? credentials[0]! : null;
            if (using) recordCredential(poolName, using, credentials);
            const tried = new Set(using ? [using.id] : []);
            // Nothing has reached the client here yet, so a refusal another key could answer is asked
            // again inside the turn instead of being handed to the user to retry by hand.
            // Google can reject a key with HTTP 400. Only structured auth evidence makes that
            // a credential refusal; an ordinary invalid request must never walk the pool.
            const poolStatus = (status: number, body: string): number => status === 400 && googleKeyRejected(status, body) ? 401 : status;
            const next = using && credentials.length > 1 ? (status: number, retryAfter: number | undefined, body: string): Record<string, string> | null => {
              const judgedStatus = poolStatus(status, body);
              if (!classify(judgedStatus, undefined, body).retryable) return null;
              const current = using!;
              const candidate = this.pool.pick(poolName, credentials.filter((c) => !tried.has(c.id)), affinity);
              if (!candidate) return null;
              this.pool.penalise(poolName, current.id, judgedStatus, retryAfter, body);
              log.info(`RETRY ${poolName}: ${this.credentialLabel(poolName, current, credentials)} answered ${status}, trying ${this.credentialLabel(poolName, candidate, credentials)}`);
              using = candidate;
              recordCredential(poolName, candidate, credentials, true);
              tried.add(candidate.id);
              return candidate.headers;
            } : undefined;
            try {
              const o = await this.google(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, routeEffort, using ? { headers: provider.credentials?.length ? using.headers : {}, ...(next ? { next } : {}) } : undefined, { kind: route.kind });
              if (o.kind === "prompt-incompatible" || o.kind === "model-capacity") {
                const why = o.kind === "prompt-incompatible" ? "prompt" : "capacity";
                const alreadyRetried = unwrittenSeen;
                unwrittenSeen = true;
                if (res.destroyed || res.writableEnded || res.headersSent) {
                  finish("0", 0, `client closed before ${why} fallback`, true);
                  if (!res.destroyed && !res.writableEnded) res.destroy();
                  return;
                }
                const fallback = !alreadyRetried && resolved
                  ? this.unwrittenFallback(resolved, route, cfg, why) : null;
                if (fallback) {
                  unwrittenFallbackNote = `${o.note}; fallback ${route.provider}/${route.model} → ${fallback.provider}/${fallback.model}`;
                  log.info(`FAILOVER ${unwrittenFallbackNote}`);
                  route = fallback;
                  continue;
                }
                // Neither is about the account or the provider (a refusal is request-specific, missing
                // capacity is the model's on Google's side): neither cool nor mark success.
                res.writeHead(o.status, { "content-type": "application/json" }).end(o.errorBody);
                finish(String(o.status), Buffer.byteLength(o.errorBody), o.note, true, o.kind === "prompt-incompatible" ? { refusal: "prompt-incompatible" } : undefined);
                return;
              }
              // The answer is charged to the key that actually produced it, which after a retry is a
              // later one than the turn started on.
              if (using) {
                if (o.status >= 400) this.pool.penalise(poolName, using.id, poolStatus(o.upstreamStatus ?? o.status, o.errorBody ?? ""), o.retryAfterMs, o.errorBody);
                else if (o.status > 0) this.pool.succeed(poolName, using.id);
              } else this.recordOutcome(route.provider, o.status);
              if (!path.startsWith("/v1/messages/count_tokens")) {
                this.providerHealth.observe(route.provider, o.status, o.exhaustion);
                this.modelHealth.observe(route.provider, route.model, o.modelUnavailable);
              }
              finish(String(o.status), o.bytes, o.note, o.status >= 400, { ...o, ...(searchAttempted ? { upstreamCalled: undefined } : {}) });
            } catch (e) {
              if (using) this.pool.penalise(poolName, using.id, 0);
              else this.recordOutcome(route.provider, 0);
              finish("-", 0, `google error ${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`);
              if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: (e as Error).message } }));
              else res.destroy();
            }
            return;
          }
          if (provider.type === "grok") {
            // The chat proxy keeps no server-side thread, so a `continue` is refused like on the other
            // translated providers and the CLI resends the turn with the full history.
            const td = threadDecision(json);
            if (td === "refuse") {
              const out = JSON.stringify(THREAD_UNSUPPORTED);
              res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
              finish("400", out.length, "thread continue refused → CLI resends stateless", false, { resent: true });
              return;
            }
            if (td === "strip") stripThreadFields(json);
            record = { ...record, target: route.model, provider: route.provider };
            const routeEffort = effortOf(json);
            if (routeEffort) record.effort = routeEffort;
            tag = `GROK ${route.tag} effort=${routeEffort ?? "-"}`;
            try {
              const o = await this.grok(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, routeEffort, { kind: route.kind });
              this.recordOutcome(route.provider, o.status);
              finish(String(o.status), o.bytes, o.note, o.status >= 400, { ...(o.usage ? { usage: o.usage } : {}), ...(o.stopReason ? { stopReason: o.stopReason } : {}) });
            } catch (e) {
              this.recordOutcome(route.provider, 0);
              finish("-", 0, `grok error ${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`);
              if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: (e as Error).message } }));
              else res.destroy();
            }
            return;
          }
          if (provider.type === "anthropic") {
            if (!isTargetProvider(provider)) {
              finish("400", 0, "native Anthropic provider is available through OpenAI ingress only", false);
              res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", message: "native Anthropic provider is available through OpenAI ingress only" } }));
              return;
            }
            // Native Messages need no translation. Only authentication changes, so server-side threads,
            // prompt caching, beta features and the client's exact tool contract remain first-party.
            const credentials = await this.claudeAccounts.credentials();
            // With no account of the pool usable, the app's own sign-in still is: the turn goes out on
            // it, as it did before the provider was added. A pool whose only stored account lost its
            // grant refused every main-chat turn with this 401 until the provider was deleted, the
            // current login having aged out of the observed source unseen (#88, 2026-10-24).
            const clientAuth = req.headers.authorization;
            const ownSignIn = credentials.length === 0 && typeof clientAuth === "string" && /^Bearer\s+\S+$/i.test(clientAuth);
            if (credentials.length === 0 && !ownSignIn) {
              const out = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "ClaudeRipple: no usable Claude account; sign in or reauthenticate an account" } });
              res.writeHead(401, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
              finish("401", out.length, "no usable Claude account", true, { ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "no-account" });
              return;
            }
            dropForeignThinking(json);
            body = Buffer.from(JSON.stringify(json));
            if (ownSignIn) {
              target = { protocol: "https:", host: cfg.upstream, port: this.deps.upstreamPort ?? 443, agent: this.deps.upstreamAgent ?? this.agentFor(route.provider, "https:"), extraHeaders: {} };
              const routeEffort = effortOf(json);
              if (routeEffort) record.effort = routeEffort;
              tag = `CLAUDE ${route.tag} account=app (no usable pool account)`;
              break;
            }
            chosen = this.pool.pick(route.provider, credentials, affinity);
            const using = chosen ?? credentials[0]!;
            chosen = using;
            credentialCandidates = credentials;
            recordCredential(route.provider, using, credentials);
            penalised = { provider: route.provider, id: using.id };
            target = {
              protocol: "https:",
              host: cfg.upstream,
              port: this.deps.upstreamPort ?? 443,
              agent: this.deps.upstreamAgent ?? this.agentFor(route.provider, "https:"),
              extraHeaders: withClientBetas(using.headers, req.headers["anthropic-beta"]),
              dropClientAuth: true,
              dropHeaders: new Set(credentials.flatMap((credential) => Object.keys(credential.headers).map((name) => name.toLowerCase()))),
              dropHeaderPrefixes: ["anthropic-client-", "x-stainless-"],
            };
            const routeEffort = effortOf(json);
            if (routeEffort) record.effort = routeEffort;
            tag = `CLAUDE ${route.tag} account=${using.ownerId?.slice(0, 8) ?? "current"}`;
          } else {
          // An Anthropic-shaped endpoint keeps no server-side thread either, so a `continue` is refused
          // here as it is for the translated providers. sanitizeForCompatible used to strip the field
          // and forward the rest, which is only the delta: DeepSeek (via Bailian) received two orphan
          // tool_results with no task and answered that none had been given (measured 2026-09-24, CLI
          // 2.1.280). Refused, the CLI resends the turn with the full history.
          if (threadDecision(json) === "refuse") {
            const out = JSON.stringify(THREAD_UNSUPPORTED);
            res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
            finish("400", out.length, "thread continue refused → CLI resends stateless", false, { resent: true, ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "thread-continue" });
            return;
          }
          const preset = provider.preset ? PRESETS.find((entry) => entry.id === provider.preset) : undefined;
          const routeModel = route.model;
          const modelEffortLevels = provider.models?.find((entry) => entry.id === routeModel)?.effortLevels;
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
            ...promptAdditions(route.kind, provider),
          });
          body = Buffer.from(JSON.stringify(json));
          const u = new URL(provider.url);
          const protocol = u.protocol === "https:" ? "https:" : "http:";
          // Which credential answers this turn. The conversation keeps the one it is on while that one
          // is healthy, because moving it moves the prompt cache with it. Every credential cooling or
          // quarantined leaves `chosen` null, and the request goes out on the configured headers so the
          // provider — not us — gets to say no.
          const credentials = this.credentialsOf(route.provider, provider);
          if (credentials.length === 0) {
            const out = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "모든 API 키가 일시 중지되어 있습니다." } });
            res.writeHead(503, { "content-type": "application/json" }).end(out);
            finish("503", out.length, "all credentials paused", false, { upstreamCalled: false });
            return;
          }
          // Use the original conversation/agent identity, not the truncated provider cache key.
          chosen = this.pool.pick(route.provider, credentials, affinity);
          // Nothing usable means every credential is cooling, and the turn still has to go somewhere:
          // the first one, so the request carries real credentials rather than none, and so the answer
          // is charged to the credential that actually produced it.
          const using = chosen ?? credentials[0]!;
          chosen = using;
          credentialCandidates = credentials;
          recordCredential(route.provider, using, credentials);
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
          const routeEffort = effortOf(json);
          if (routeEffort) record.effort = routeEffort;
          tag = `${route.provider.toUpperCase()} ${route.tag} effort=${routeEffort ?? "-"}`;
          }
        } else if (isApiHost) {
          target = { protocol: "https:", host: cfg.upstream, port: this.deps.upstreamPort ?? 443, agent: this.deps.upstreamAgent ?? this.upstreamAgent, extraHeaders: {} };
          tag = `PASS ${typeof model === "string" ? model : "-"}`;
          // Passthrough stays byte-exact unless another model's thinking would get the turn refused.
          if (json) {
            const removed = this.thinkingOrigins.dropKnownForeign(json, "anthropic");
            if (dropForeignThinking(json) + removed > 0) body = Buffer.from(JSON.stringify(json));
          }
        } else {
          target = { protocol: "https:", host: reqHost, port: 443, agent: this.agentFor(`host:${reqHost}`, "https:"), extraHeaders: {} };
          tag = `WEB ${reqHost}`;
        }
        break;
      }

      if (json && typeof json.service_tier === "string") record.requestedTier = json.service_tier;

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
      /** The headers of the attempt in flight, so a stale-socket resend repeats exactly that attempt. */
      let lastAttemptHeaders: string[] = headers;
      let staleRetries = 0;
      const send = (attemptHeaders: string[]): void => {
        // Buffered refusal bytes and truncation belong only to the response of this attempt.
        headFilled = false;
        errRaw = Buffer.alloc(0);
        errTruncated = false;
        lastAttemptHeaders = attemptHeaders;
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
        const owner = cfg.providers[route.provider];
        if (!owner) return null;
        // The model's own shape again: its credential pool is the provider's, but an auth convention
        // this model overrides has to be the one the retry actually sends.
        const provider = providerFor(owner, route.model);
        const native = provider.type === "anthropic" && provider.accountPool;
        const available = native ? this.claudeAccounts.peekCredentials() : this.credentialsOf(route.provider, provider);
        const rest = available.filter((c) => !tried.has(c.id));
        if (rest.length === 0) return null;
        const next = this.pool.pick(route.provider, rest, affinity);
        return next && native ? { ...next, headers: withClientBetas(next.headers, req.headers["anthropic-beta"]) } : next;
      };

      // Destroying the upstream makes it emit ECONNRESET (measured, Node 24.15), which is
      // indistinguishable from the provider dropping us unless we remember that we did it. Without
      // this flag every cancelled turn charged the credential a failure and moved the conversation
      // off it, which costs the prompt cache — for a turn the user cancelled on purpose.
      let clientAborted = false;
      // Set when a 403 body was read ahead of the forward, so the forward knows to write that body
      // instead of the stream it came from.
      let headFilled = false;
      // The 403 body exactly as it arrived. It is what the client is given: the judgement below
      // reads a decoded copy, but a compressed body cannot survive a round trip through a UTF-8
      // string — invalid sequences become U+FFFD and never come back. Returning that while
      // `content-encoding` still stands is `ERR_CONTENT_DECODING_FAILED` in the app (2026-09-22).
      let errRaw: Buffer = Buffer.alloc(0);
      // Set when the body was longer than the read cap, so its bytes are no longer a whole
      // compressed stream and only the decoded head can be forwarded.
      let errTruncated = false;
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
        // A kept-alive socket the upstream had already closed: the reset arrives before any response,
        // so the request never reached it. claude.ai did this 259 times in four days of picker mode
        // (2026-10-03..06), each one a 502 on an app request such as `current_user_access`. Send an
        // idempotent request again on a fresh attempt instead of failing it; a POST is never resent,
        // since a reset cannot prove the upstream did not act on it.
        const code = (e as NodeJS.ErrnoException).code;
        if (upReq.reusedSocket && (code === "ECONNRESET" || code === "EPIPE") && IDEMPOTENT.has(method) && !clientAborted && !res.headersSent && staleRetries < 2) {
          staleRetries++;
          log.info(`STALE ${reqHost}: kept-alive socket was closed (${code}); resending ${method} ${path.slice(0, 60)}`);
          send(lastAttemptHeaders);
          return;
        }
        // Our own abort is neither a stuck router nor a failed credential. The close
        // handler records it; do not count the ECONNRESET that destroy() caused.
        if (clientAborted) return;
        if (target.host === cfg.upstream) this.deps.health.failure(e);
        // Nothing reached the provider, so this says nothing about the credential — but it does say
        // the route is unusable for a moment, and a pool with somewhere else to go should use it.
        if (penalised) this.pool.penalise(penalised.provider, penalised.id, 0);
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
        // Read body-dependent refusals before committing headers. A relay 403 can report its own
        // broken upstream, while the narrowly classified workspace-region 400 (#101) rests this key
        // and can be answered by another. Other 400s remain request errors and never walk the pool.
        // 402 and 429 are read ahead as well: a definite billing/quota exhaustion must be answered
        // with `x-should-retry: false` before the headers go out, and only its body says whether a
        // 429 is exhausted or an ordinary rate limit (#89). A bootstrap response is never a model
        // turn and is forwarded as it arrives.
        if (status === 403 || (!isBootstrap && (status === 400 || status === 402 || status === 429))) {
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
       * a refusal, so its body is small. A 402/429 is read the same way, because the headers that tell
       * the client to stop retrying must be decided before they go out (#89).
       *
       * What is returned is the body **decoded for reading**, because the judgement is about what the
       * body says. The bytes themselves are kept in `errRaw` for the client: a compressed body is
       * arbitrary binary, and text is a one-way door for it.
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
          if (room <= 0) { errTruncated = true; stream.resume(); return; }
          if (c.length > room) errTruncated = true;
          chunks.push(c.subarray(0, room));
          size += Math.min(c.length, room);
        });
        const handOver = (): void => {
          errRaw = Buffer.concat(chunks, size);
          headFilled = true;
          resolveBody(decodeBodyToText(errRaw, stream.headers["content-encoding"]));
        };
        stream.once("end", handOver);
        // A dropped or failed stream still hands over what arrived; the caller's own upstream error
        // path is already attached, and duplicating it here would race it for the same response.
        stream.once("error", handOver);
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
          const credentials = credentialCandidates;
          log.info(`RETRY ${route!.provider}: ${this.credentialLabel(route!.provider, chosen!, credentials)} answered ${status}, trying ${this.credentialLabel(route!.provider, retry, credentials)}`);
          recordCredential(route!.provider, retry, credentials, true);
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

        const native = isApiHost && (!route || cfg.providers[route.provider]?.type === "anthropic");
        if (native && typeof upRes.headers["request-id"] === "string") record.upstreamRequestId = upRes.headers["request-id"];
        const outHeaders: string[] = [];
        const r = upRes.rawHeaders;
        for (let i = 0; i < r.length; i += 2) {
          const lk = r[i]!.toLowerCase();
          if (lk === "connection" || lk === "keep-alive" || lk === "transfer-encoding") continue;
          if (isBootstrap && (lk === "content-length" || lk === "content-encoding")) continue;
          if (isPickerBootstrap && (lk === "etag" || lk === "last-modified")) continue;
          // A truncated 403 is forwarded decoded (its bytes are no longer a whole compressed
          // stream), so neither the upstream's encoding nor its length describes what is sent.
          if (errTruncated && (lk === "content-length" || lk === "content-encoding")) continue;
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
                const r = injectPickerModels(j, chatPickerModels(cfg), cfg.cli.autoCompactWindow, (model) => effortLevelsForModel(cfg, model));
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
        // A definite exhaustion (a spending cap, a used-up quota) is not worth asking again in the
        // same minute, and a worker that does retries the plain 429 for about two and a half minutes
        // before failing (#89, 2026-10-24). Its body was read ahead for 402/429, so the answer is
        // known before the headers go out; a bare rate limit is left exactly as it was.
        if (headFilled) {
          const exhaustion = providerExhaustion(status, errBody, retryAfterMs(upRes.headers));
          if (exhaustion) {
            for (let i = outHeaders.length - 2; i >= 0; i -= 2) {
              const name = outHeaders[i]!.toLowerCase();
              if (name === "retry-after" || name === "x-should-retry") outHeaders.splice(i, 2);
            }
            for (const [name, value] of Object.entries(exhaustionHeaders(exhaustion))) outHeaders.push(name, value);
          }
          // The stream forward below cannot reach its own end handler when the body is already here.
          if (route && path.startsWith("/v1/messages") && !path.startsWith("/v1/messages/count_tokens")) {
            this.providerHealth.observe(route.provider, status, exhaustion);
          }
        }
        res.writeHead(status, outHeaders);
        // This observer is deliberately side-band: it sees the exact chunks after they are written
        // to the client, retains only a 64 KiB line/object fragment, and never changes backpressure.
        const tap = new ResponseUsageTap(
          typeof upRes.headers["content-type"] === "string" ? upRes.headers["content-type"] : undefined,
          typeof upRes.headers["content-encoding"] === "string" ? upRes.headers["content-encoding"] : undefined,
          status >= 200 && status < 300 && pathname === "/v1/messages"
            ? block => this.thinkingOrigins.remember(route?.provider ?? "anthropic", block) : undefined,
        );
        // An error body is the only thing that says why the provider refused; keep its head for the
        // log and the Logs page. A DeepSeek 401 went unexplained for a day because only the status
        // code was recorded (2026-09-15).
        const errorHead: Buffer[] = [];
        let errorHeadBytes = 0;
        // A buffered body (a 403, or a 402/429 read for its verdict) is written here instead of read
        // again from a stream that has already ended. The bytes go back exactly as they arrived, so a
        // compressed body still matches the `content-encoding` and `content-length` the upstream
        // stated; only a truncated one is sent decoded, and both headers were dropped above for it.
        if (headFilled) {
          const body = errTruncated ? Buffer.from(errBody, "utf8") : errRaw;
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
          if (!native && observed.messageId !== undefined) record.messageId = observed.messageId;
          if (observed.servedTier !== undefined) record.servedTier = observed.servedTier;
          res.end();
          const errorBody = status >= 400 ? decodeBodyToText(Buffer.concat(errorHead), upRes.headers["content-encoding"]) : "";
          if (route && path.startsWith("/v1/messages") && !path.startsWith("/v1/messages/count_tokens")) {
            this.providerHealth.observe(route.provider, status, providerExhaustion(status, errorBody, retryAfterMs(upRes.headers)));
            this.modelHealth.observe(route.provider, route.model, modelDeprecation(status, errorBody));
          }
          const note = status >= 400 ? `upstream ${status}: ${errorSnippet(Buffer.concat(errorHead), upRes.headers["content-encoding"], [...errorSecrets], upRes.headers["content-type"])}` : undefined;
          // Anthropic forgets a conversation's server-side thread after a few idle minutes, and the CLI
          // answers the 404 by replaying the whole conversation, which hits the prompt cache. From CLI
          // 2.1.288 this is about half the turns after five idle minutes (2026-10-07: 105 of 217, none
          // of 69 before), so it is recorded as resent rather than failed.
          if (status === 404 && note && /thread_not_found|No thread state was found/.test(note)) {
            finish(String(status), bytes, note, false, { resent: true });
            return;
          }
          finish(String(status), bytes, note);
        });
        upRes.on("error", (e) => {
          finish(String(status), bytes, `upstream stream error ${(e as Error).message}`);
          res.destroy();
        });
      };

      send(headers);
    };
    await run(fetchRoute);
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
    record: { source?: string; target?: string; provider?: string; purpose?: RequestRecord["purpose"] },
    finish: (status: string, bytes: number, note?: string, failed?: boolean, extra?: { usage?: RequestUsage }) => void,
    markAttempted: () => void,
  ): Promise<boolean> {
    const configured = this.deps.config().providers[settings.provider];
    if (!configured) {
      this.deps.log.warn(`web search: unknown provider ${settings.provider}; leaving the request alone`);
      return false;
    }
    // Which backend is chosen below depends on the wire the search model speaks, which may not be
    // the provider's own — or on the endpoint its plan searches on, which may not be the model's.
    const searchVia = searchProviderFor(configured, settings.model);
    const provider = searchVia ?? providerFor(configured, settings.model);
    const url = "url" in provider && typeof provider.url === "string" ? provider.url : undefined;
    if (!url && provider.type !== "chatgpt") {
      this.deps.log.warn(`web search: provider ${settings.provider} has no url; leaving the request alone`);
      return false;
    }
    // Which backend depends on how the provider is spoken to, not on the vendor. An
    // anthropic-compatible one is asked in Anthropic's own shape and hands back the blocks the CLI
    // already parses; an openai-compatible one is asked through its chat web plugin.
    // OpenCode Go refuses a request without its session header outright (400 MissingSessionID).
    const sessionHeader = "sessionHeader" in provider ? provider.sessionHeader : undefined;
    const common = {
      name: settings.provider,
      url: url ?? "",
      headers: { ...(("headers" in provider && provider.headers) || {}), ...(sessionHeader ? { [sessionHeader]: crypto.randomUUID() } : {}) },
      model: settings.model,
      ...(settings.maxResults ? { maxResults: settings.maxResults } : {}),
    };
    let backend;
    if (provider.type === "anthropic-compatible") {
      // Refuse before sending rather than after. A provider that cannot run the server tool is sent
      // "perform a web search" with no tool attached, and a model told to search with nothing to
      // search with narrates a tool call instead — an answer shaped like success, holding nothing.
      if (!searchVia && !runsServerTools(this.deps.config(), settings.provider)) {
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
    let usage: RequestUsage | undefined;
    try {
      markAttempted();
      const outcome = await backend.search(query);
      blocks = webSearchBlocks(query, outcome).blocks;
      usage = outcome.usage;
    } catch (e) {
      this.deps.log.warn(`web search via ${settings.provider}: ${(e as Error).message}`);
      return false;
    }

    // The row is the model that searched, not the provider that billed for it: `target` is the id
    // the search ran on, and `purpose` keeps it out of that model's own turns on the model table
    // (a provider-named target read as a model of its own, 2026-10-26).
    record.target = settings.model;
    record.provider = settings.provider;
    record.purpose = "web-search";
    const wantStream = json.stream === true;
    const payload = wantStream ? webSearchSse(model, blocks, 1) : JSON.stringify(webSearchMessage(model, blocks, 1));
    const headers = wantStream
      ? { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }
      : { "content-type": "application/json" };
    res.writeHead(200, headers).end(payload);
    finish("200", Buffer.byteLength(payload), `web search via ${settings.provider}`, false, usage ? { usage } : undefined);
    return true;
  }

  /** Bind the task's spawn snapshot to its agent, not to x@effort (several tiers can use it). */
  private workerFallbacks(resolved: Resolved, json: Record<string, unknown>, cfg: Config, model: string, key?: string): Resolved {
    let snapshot = key ? this.workerLadders.get(key) : undefined;
    if (!snapshot && Array.isArray(json.messages)) {
      // register.tsx prepends this line to the spawn prompt, not to later history or blocks.
      // Only leading engine reminders may precede it; removing reminders elsewhere can expose prose.
      const content: unknown = json.messages.find(message => message?.role === "user")?.content;
      const first: unknown = Array.isArray(content) ? content[0] : undefined;
      const text = typeof content === "string" ? content : first && typeof first === "object" &&
        "type" in first && first.type === "text" && "text" in first && typeof first.text === "string" ? first.text : "";
      snapshot = readWorkerLadder(text.replace(/^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+\s*/, ""));
    }
    // Never override an explicit marker/rule that resolved somewhere other than the spawn's model.
    if (!snapshot || snapshot.model !== model) return resolved;
    const picked = resolve(snapshot.model, {}, cfg);
    if (!picked || picked.provider !== resolved.provider || picked.model !== resolved.model || picked.effort !== resolved.effort) return resolved;
    if (key && !this.workerLadders.has(key)) {
      this.workerLadders.set(key, snapshot);
      if (this.workerLadders.size > 10_000) this.workerLadders.delete(this.workerLadders.keys().next().value!);
    }
    const allowed = this.savedLadderTargets(cfg);
    const fallbacks = snapshot.fallbacks.flatMap(id => {
      const target = resolve(id, {}, cfg);
      return target && allowed.some(step => step.provider === target.provider && step.model === target.model && step.effort === target.effort)
        ? [{ provider: target.provider, model: target.model, ...(target.effort ? { effort: target.effort } : {}) }] : [];
    });
    return { ...resolved, fallbacks, ladderPick: snapshot.pick };
  }

  /** Task text is not authority: even a bound snapshot must remain on the current saved worker set. */
  private savedLadderTargets(cfg: Config): Resolved[] {
    try {
      const saved = readModRoutingSettings(this.deps.home);
      if (!saved.stored) return [];
      const settings = routingSettings(saved.settings);
      const rules = [settings.rules.general, ...Object.values(settings.domainRules ?? {})];
      return rules.flatMap(rule => Object.values(rule.rungs).flatMap(steps => (steps ?? []).flatMap(step => {
        const model = step.target.agent === "general-purpose" ? step.target.model : cfg.aliases[step.target.agent];
        if (!model) return [];
        const target = resolve(`${model.replace(/@[^@]*$/, "")}@${step.effort}`, {}, cfg);
        return target && settings.providers[target.provider] !== false &&
          isAllowed(candidateKey(step.target), target.provider, settings.allow, settings.allowKnown) ? [target] : [];
      })));
    } catch (error) {
      this.deps.log.warn(`worker ladder: saved settings unavailable; not rerouting (${(error as Error).message})`);
      return [];
    }
  }

  private unavailableReason(target: Pick<Resolved, "provider" | "model">): string | undefined {
    const retired = this.modelHealth.get(target.provider, target.model)?.reason;
    if (retired) return retired;
    const exhaustion = this.providerHealth.snapshot()[target.provider];
    if (!exhaustion) return undefined;
    const configured = this.deps.config().providers[target.provider];
    const provider = configured && providerFor(configured, target.model);
    // An explicit key pool knows more than a provider-wide advisory from one spent key.
    if (provider && "credentials" in provider && provider.credentials?.length &&
        this.pool.hasUsable(target.provider, this.credentialsOf(target.provider, provider))) return undefined;
    return exhaustion.reason;
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
    const reason = this.unavailableReason(resolved);
    const provider = cfg.providers[resolved.provider];
    // An ordinary API rate limit is not definite exhaustion. OAuth adapters additionally know
    // when every account (or the model's quota group) is unavailable without a billing error.
    const accounts = provider?.type === "chatgpt" || provider?.type === "anthropic" || provider?.type === "google" && provider.auth === "antigravity";
    if (resolved.ladderPick && !reason && !accounts) return resolved;
    if (this.targetUsable(resolved, cfg)) return resolved;
    for (const f of resolved.fallbacks) {
      if (f.provider === resolved.provider && f.model === resolved.model) continue;
      if (!this.targetUsable({ ...f, effort: f.effort ?? resolved.effort }, cfg)) continue;
      log.info(`${resolved.ladderPick ? `LADDER pick=${resolved.ladderPick}` : "FAILOVER"} ${resolved.provider}/${resolved.model} → ${f.provider}/${f.model} reason=${reason ?? "provider_unusable"}`);
      // The tag names the model that answers, not the one that could not: a log line saying `->m1`
      // for a turn that ran on m2 is the kind of thing that costs an hour to disbelieve.
      return {
        provider: f.provider,
        model: f.model,
        effort: f.effort ?? resolved.effort,
        tag: `${resolved.asked}->${f.model} (failover from ${resolved.provider})`,
        kind: resolved.kind,
        asked: resolved.asked,
      };
    }
    return resolved;
  }

  /** Only configured route fallbacks, not another account or an invented provider. */
  private unwrittenFallback(resolved: Resolved, attempted: Resolved, cfg: Config, why: "prompt" | "capacity"): Resolved | null {
    for (const f of resolved.fallbacks ?? []) {
      if (f.provider === attempted.provider && f.model === attempted.model) continue;
      if (!this.targetUsable({ ...f, effort: f.effort ?? resolved.effort }, cfg)) continue;
      return {
        provider: f.provider, model: f.model, effort: f.effort ?? resolved.effort,
        tag: `${resolved.asked}->${f.model} (${why} fallback from ${attempted.provider})`,
        kind: resolved.kind, asked: resolved.asked,
      };
    }
    return null;
  }

  private targetUsable(target: Pick<Resolved, "provider" | "model"> & { effort?: string | undefined }, cfg: Config): boolean {
    const configured = cfg.providers[target.provider];
    if (!configured || this.unavailableReason(target)) return false;
    const provider = providerFor(configured, target.model);
    if (provider.type === "anthropic") {
      if (!isTargetProvider(provider)) return false;
      const accounts = this.claudeAccounts.peekCredentials();
      return accounts.length > 0 && this.pool.hasUsable(target.provider, accounts);
    }
    if (provider.type === "chatgpt") return this.chatgpt(target.provider, provider).hasUsable();
    if (provider.type === "google" && provider.auth === "antigravity") return this.google(target.provider, provider).hasUsable(target.model, target.effort);
    return this.pool.hasUsable(target.provider, this.credentialsOf(target.provider, provider));
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
  private credentialsOf(name: string, provider: Config["providers"][string], includePaused = false): Credential[] {
    const declared = (provider as { credentials?: Credential[] }).credentials;
    if (declared && declared.length > 0) return includePaused ? declared : declared.filter((credential) => !credential.paused);
    const headers = ("headers" in provider && provider.headers) || {};
    const configured = this.deps.config().providers[name] ?? provider;
    const configuredHeaders = ("headers" in configured && configured.headers) || {};
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(
      Object.entries(configuredHeaders).map(([key, value]): [string, string] => [key.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b)),
    )).digest("hex");
    const previous = this.implicitCredentialHeaders.get(name);
    if (previous !== undefined && previous !== fingerprint) this.pool.clear(name, "default");
    this.implicitCredentialHeaders.set(name, fingerprint);
    return [{ id: "default", headers }];
  }

  /** Only explicit labels or configured ordinals are public; runtime ids may be secrets. */
  private credentialLabel(name: string, credential: Credential, available: readonly Credential[]): string {
    const provider = this.deps.config().providers[name];
    const configured = provider && "credentials" in provider ? provider.credentials : undefined;
    const credentials = configured?.length ? configured : available;
    const index = credentials.findIndex((candidate) => candidate.id === credential.id);
    const secrets = credentialHeaderValues(credentials.flatMap((candidate) => Object.entries(candidate.headers)));
    // OAuth labels are derived from account emails, not operator-supplied key labels.
    const label = !credential.ownerId && credential.label ? redactErrorText(credential.label, secrets, 80) : "";
    return label || `#${index + 1}`;
  }

  clearCredentialCooldown(provider: string, id: string): void {
    this.pool.clear(provider, id);
  }

  claudeClearCooldown(ownerId: string): void {
    const owners = this.claudeAccounts.cooldownOwners(ownerId);
    for (const [name, provider] of Object.entries(this.deps.config().providers)) {
      if (provider.type !== "anthropic" || provider.auth !== "claude-code") continue;
      for (const owner of owners) this.pool.clearOwner(name, owner);
    }
  }

  /** Health of every credential the config declares, for the dashboard. */
  credentialHealth(): Record<string, ReturnType<CredentialPool["report"]>> {
    const cfg = this.deps.config();
    const out: Record<string, ReturnType<CredentialPool["report"]>> = {};
    for (const [name, provider] of Object.entries(cfg.providers)) {
      const creds = provider.type === "anthropic" && provider.accountPool
        ? this.claudeAccounts.peekCredentials()
        : this.credentialsOf(name, provider, true);
      if (!(provider.type === "anthropic" && provider.accountPool) && !("credentials" in provider && provider.credentials?.length)) continue;
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

/**
 * Let the ordinary adapters prepare their usual errors without committing one to the client.
 * Successful responses stream directly, with real backpressure; no body is buffered. Once a
 * success header is sent this becomes a transparent response, including mid-stream failures.
 */
function deferErrorResponse(response: http.ServerResponse, discarded: () => boolean): http.ServerResponse {
  let error = false;
  const guarded = new globalThis.Proxy(response, {
    get(target, key) {
      if (key === "writeHead") return (...args: unknown[]) => {
        if (discarded()) return guarded;
        error = typeof args[0] === "number" && args[0] >= 400 && !target.headersSent;
        return error ? guarded : Reflect.apply(target.writeHead, target, args);
      };
      if (key === "write" || key === "end" || key === "flushHeaders" || key === "destroy") return (...args: unknown[]) => {
        if (discarded() || error || (key === "destroy" && !target.headersSent)) return guarded;
        return Reflect.apply(target[key], target, args);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return guarded;
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
