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
import { ProviderHealth, providerExhaustion, UpstreamHealth } from "./health.ts";
import type { HoldGate } from "./hold.ts";
import { BOOTSTRAP_PATH, injectBootstrap } from "./bootstrap.ts";
import { THREAD_UNSUPPORTED, effortOf, isAutoModeClassifier, resolve, rewriteBody, stripThreadFields, threadDecision, unroutableReason, type Resolved } from "./routing.ts";
import { defaultAgentDir, withAgentAliases } from "./agents.ts";
import { forwardCompatibleHeader, resolveCompatibleCaps, sanitizeForCompatible } from "./compat.ts";
import { applyIdentityToAnthropicBody } from "./identity.ts";
import { anthropicServerToolBackend, webPluginBackend, webSearchBlocks, webSearchErrorBlocks, webSearchMessage, webSearchQuery, webSearchSse, type WebSearchQuery } from "./websearch.ts";
import { aboutCredential, classify, CredentialPool, retryAfterMs, type Credential } from "./pool.ts";
import { PRESETS } from "./presets.ts";
import { ChatGptAdapter, type ChatGptAccountStatus, type ImageRequest, type ImageResult } from "./providers/chatgpt/index.ts";
import { OpenAiCompatibleAdapter } from "./providers/openai/index.ts";
import { GoogleAdapter, type GoogleAccountStatus } from "./providers/google/index.ts";
import type { QuotaGroup } from "./providers/google/usage.ts";
import { OpenCodeUsage, isOpenCodeGo, refusalResetAt, spentWindowReset, type OpenCodeAccountState, type OpenCodeLimit, type OpenCodeWindow } from "./providers/opencode-usage.ts";
import { CreditBalances, creditVendor, type CreditBalance, type CreditLimit, type CreditVendor } from "./providers/credit-balance.ts";
import { isKeyProvider } from "./config.ts";
import { GrokAdapter } from "./providers/grok/index.ts";
import type { GrokWindow } from "./providers/grok/usage.ts";
import { conversationKey, type AnthropicRequest } from "./providers/chatgpt/translate.ts";
import { providerFor, searchProviderFor, terminateHosts } from "./config.ts";
import type { CertStore } from "./certs.ts";
import { chatPickerModels, injectPickerModels, isBootstrapPath } from "./picker.ts";
import { effortLevels, effortLevelsForModel } from "./admin.ts";
import { isWebFetchRequest } from "./webfetch.ts";
import { ResponseUsageTap, requestId, type RequestLog, type RequestRecord, type RequestUsage } from "./requestlog.ts";
import { credentialHeaderValues, redactErrorText, redactHeaders } from "./redact.ts";
import type { ObservedClaudeCodeAuth } from "./providers/anthropic-observed.ts";
import { ClaudeAccountAuthPool } from "./providers/anthropic-account-pool.ts";
import { ClaudeModelCatalog } from "./providers/anthropic-models.ts";
import { ClaudeUsage } from "./providers/anthropic-usage.ts";
import { dropForeignThinking } from "./thinking.ts";

const MAX_BODY = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "content-length"]);

/**
 * One key of any key-based provider, as `GET /api/provider-keys` reports it. Ids and labels only;
 * `windows` is OpenCode Go's usage, `credit` a prepaid balance — every other provider has neither.
 */
export type ProviderKeyState = {
  id: string;
  label?: string;
  state: "in-use" | "standby" | "cooling" | "paused" | "quarantined" | "unknown";
  cooldown_seconds?: number;
  /** epoch ms of the reading behind this row (usage or balance); 0 when there is none. */
  at: number;
  windows: OpenCodeWindow[];
  credit?: CreditBalance;
};

/** One credit-selling key's balance, as `/api/limits` and the dashboard read it. */
export type CreditKeyLimit = { id: string; label?: string; credit: CreditBalance; at: number };
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
 * The names a provider's headers may carry its key under; a credential supplies these instead.
 * The openai-compatible adapter has the same rule for its own header merge.
 */
const AUTH_HEADERS = new Set(["authorization", "x-api-key"]);

/** A provider's headers without whatever authenticates it, so the credential is the only key sent. */
function withoutAuthHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !AUTH_HEADERS.has(name.toLowerCase())));
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
  /** Where agent definitions are read from. Defaults to `~/.claude/agents`; tests inject a tmp dir. */
  agentDir?: string;
  /** TLS dialer for absolute-form proxy requests. Production uses node:tls; integration tests inject a local CA. */
  tlsConnect?: (options: tls.ConnectionOptions) => tls.TLSSocket;
  /** Native Anthropic upstream seams for integration tests; production always uses port 443 and the default agent. */
  upstreamAgent?: https.Agent;
  upstreamPort?: number;
  /** While engaged (a network switch, tether.ts), new model calls wait here instead of starting. */
  hold?: HoldGate;
  /**
   * Test seam for the OpenCode Go `/usage` reader. Production uses the global fetch and a five-minute
   * cache period; a test needs both to be decided by the test rather than by the network and a clock.
   */
  opencodeUsage?: { fetch?: (url: string, init?: RequestInit) => Promise<Response>; ttlMs?: number };
  /**
   * The same seam for the credit-balance reader (sail, OpenRouter); `/api/limits` and the key cards.
   * `vendor` overrides the host test production uses, so a turn against a local fake can still be
   * the turn of a credit-selling provider.
   */
  creditBalance?: { fetch?: (url: string, init?: RequestInit) => Promise<Response>; ttlMs?: number; vendor?: (provider: { url?: string }) => CreditVendor | null };
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
  /** Each OpenCode Go provider's usage windows, for the status bar's limits row (never a key). */
  private readonly opencodeUsage: OpenCodeUsage;
  /** Each credit-selling provider's remaining balance, for the limits row (never a key). */
  private readonly creditBalances: CreditBalances;
  private readonly deps: ProxyDeps;
  /**
   * Cooldowns, quarantines and conversation stickiness for provider credentials. In memory: a
   * cooldown that outlived a restart would make restarting worse, and a rejected credential earns
   * its quarantine again on the first request.
   */
  private readonly pool = new CredentialPool();
  readonly providerHealth = new ProviderHealth();

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

  /**
   * An OpenCode Go provider's usage windows, one entry per credential, for the status bar's limits
   * row. A provider with no `credentials` keeps the single entry it always had. Empty otherwise.
   */
  async opencodeLimits(name: string): Promise<OpenCodeLimit[]> {
    const cfg = this.deps.config().providers[name];
    if (!cfg || cfg.type !== "openai-compatible" || !isOpenCodeGo(cfg)) return [];
    const credentials = this.credentialsOf(name, cfg);
    // One lookup per key, and the usage reader caches per account: two keys of the same provider
    // have separate quotas, so keying the cache on the provider alone would show one key's numbers
    // under every entry.
    return Promise.all(credentials.map(async (credential) => ({
      id: credential.id,
      ...(credential.label ? { label: credential.label } : {}),
      windows: await this.opencodeUsage.windows(`${name}/${credential.id}`, cfg.url, credential.headers),
    })));
  }

  /** The balance reader a provider belongs to. A seam for tests, which cannot reach a real vendor. */
  private creditVendorOf(provider: object): CreditVendor | null {
    return this.deps.creditBalance?.vendor ? this.deps.creditBalance.vendor(provider) : creditVendor(provider);
  }

  /**
   * A credit-selling provider's remaining balance, per key, for the status bar's limits row. A
   * balance belongs to the key that asked for it, so every key of the provider is read with its own
   * headers and gets its own row; a key whose read fails is left out rather than shown as zero.
   * Empty for a provider that sells no credit.
   */
  async creditLimits(name: string): Promise<CreditKeyLimit[]> {
    const cfg = this.deps.config().providers[name];
    if (!cfg) return [];
    const vendor = this.creditVendorOf(cfg);
    if (!vendor) return [];
    const credentials = this.credentialsOf(name, cfg);
    const rows = await Promise.all(credentials.map(async (credential): Promise<CreditKeyLimit | null> => {
      const cacheKey = `${name}/${credential.id}`;
      const balance = await this.creditBalances.balance(cacheKey, vendor, credential.headers);
      if (!balance) return null;
      // An empty balance is not a failure, it is a spent key: parked the same way a spent usage
      // window is, so a new conversation is never sent to a key that cannot pay. A later read that
      // finds money releases it here, so the dashboard's own poll is what brings a topped-up key back
      // without a restart.
      if (balance.remaining_usd > 0) this.pool.releaseEmpty(name, credential.id);
      else this.parkEmptyBalance(name, credential.id);
      return { id: credential.id, ...(credential.label ? { label: credential.label } : {}), credit: balance, at: this.creditBalances.readAt(cacheKey) };
    }));
    return rows.filter((row): row is CreditKeyLimit => row !== null);
  }

  /**
   * Re-read the balance of every credit-selling key whose last read said nothing is left, so a key
   * topped up while nobody has the dashboard (or `/api/limits`) open comes back by itself. The
   * request path only reads the cached balance, and a cached zero re-parks a key on every turn — so
   * without this, a topped-up key would stay out of rotation until someone opened the GUI.
   *
   * Cheap by construction: it proceeds only while a key is parked, and it reads only those keys —
   * one forced read per parked key, at the timer's five-minute pace, and never for a funded or
   * paused one. The timer that calls it lives in index.ts, never on the request path.
   */
  async refreshParkedBalances(): Promise<void> {
    for (const [name, provider] of Object.entries(this.deps.config().providers)) {
      const vendor = this.creditVendorOf(provider);
      if (!vendor) continue;
      const credentials = this.credentialsOf(name, provider);
      const parked = credentials.filter((credential) => {
        if (credential.paused) return false;
        const known = this.creditBalances.peek(`${name}/${credential.id}`);
        return known !== undefined && known.remaining_usd <= 0;
      });
      await Promise.all(parked.map(async (credential) => {
        const cacheKey = `${name}/${credential.id}`;
        // A forced read: the cached zero is what parked this key, so the cache cannot be the answer.
        const balance = await this.creditBalances.refresh(cacheKey, vendor, credential.headers);
        if (!balance) return;
        if (balance.remaining_usd > 0) {
          if (this.pool.emptySince(name, credential.id) > 0) this.deps.log.info(`credit balance ${cacheKey}: money is back, key released`);
          this.pool.releaseEmpty(name, credential.id);
        } else this.parkEmptyBalance(name, credential.id);
      }));
    }
  }

  /**
   * One credit-selling provider's balance, for callers that still want a single figure (the CLI's
   * status line). The first key that has a readable balance answers.
   */
  async creditLimit(name: string): Promise<CreditLimit | null> {
    const rows = await this.creditLimits(name);
    const first = rows[0];
    return first ? { credit: first.credit, at: first.at } : null;
  }

  /** Dashboard action: put one resting Google account back into rotation now. */
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

  constructor(deps: ProxyDeps) {
    this.deps = deps;
    this.claudeAccounts = new ClaudeAccountAuthPool({
      home: deps.home,
      log: deps.log,
      ...(deps.observedClaudeCodeAuth ? { observed: deps.observedClaudeCodeAuth } : {}),
    });
    this.claudeUsage = new ClaudeUsage(this.claudeAccounts, {
      upstream: () => this.deps.config().upstream,
      warn: (message) => deps.log.warn(message),
    });
    this.claudeModels = new ClaudeModelCatalog(this.claudeAccounts, {
      upstream: () => this.deps.config().upstream,
      warn: (message) => deps.log.warn(message),
    });
    this.opencodeUsage = new OpenCodeUsage({
      warn: (message) => deps.log.warn(message),
      ...(deps.opencodeUsage?.fetch ? { fetch: deps.opencodeUsage.fetch } : {}),
      ...(deps.opencodeUsage?.ttlMs !== undefined ? { ttlMs: deps.opencodeUsage.ttlMs } : {}),
    });
    this.creditBalances = new CreditBalances({
      warn: (message) => deps.log.warn(message),
      ...(deps.creditBalance?.fetch ? { fetch: deps.creditBalance.fetch } : {}),
      ...(deps.creditBalance?.ttlMs !== undefined ? { ttlMs: deps.creditBalance.ttlMs } : {}),
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
      if (unwrittenFallbackNote) note = [unwrittenFallbackNote, note].filter(Boolean).join("; ");
      this.stats.inFlight--;
      if (isMessages) {
        this.stats.messagesInFlight--;
        this.stats.lastMessageEndedAt = Date.now();
      }
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
        if (extra?.resent && !completed.ok) completed.resent = true;
        if (extra?.messageId !== undefined) completed.messageId = extra.messageId;
        if (extra?.requestedTier !== undefined) completed.requestedTier = extra.requestedTier;
        if (extra?.servedTier !== undefined) completed.servedTier = extra.servedTier;
        if (extra?.upstreamCalled === false && !unwrittenSeen) completed.upstreamCalled = false;
        if (extra?.refusal !== undefined) completed.refusal = extra.refusal;
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
    // A WebSearch arrives as its own request aimed at ANTHROPIC_SMALL_FAST_MODEL, recognised by the
    // forced `web_search` server tool rather than by its model id. Recognise it whether or not a
    // backend is configured: `cfg.webSearch` decides who answers it, but knowing that this is a
    // search is what lets the guard below refuse a provider that cannot run one. Tying the two
    // together meant an unconfigured router could not tell a search from any other turn.
    if (json) {
      record.source = record.target = typeof model === "string" ? model : "-";
      record.stream = json.stream === true;
      if (isAutoModeClassifier(json)) record.purpose = "auto-mode-classifier";
    }
    const search = json && isApiHost && pathname === "/v1/messages" ? webSearchQuery(json) : null;
    let searchAttempted = false;
    const markSearchAttempted = (): void => { searchAttempted = true; };
    if (search && cfg.webSearch) {
      const served = await this.serveWebSearch(res, json!, search, cfg.webSearch, record, finish, markSearchAttempted);
      if (served) return;
      // Fall through on failure: the ordinary path still answers, and a search that quietly
      // returns nothing is worse than one that costs what it always cost.
    }

    const webFetch = !!(cfg.webSearch && json && pathname === "/v1/messages" && isWebFetchRequest(json));
    let fetchRoute: Resolved | null = null;
    if (webFetch) record.purpose = "web-fetch";
    if (webFetch && cfg.webSearch) {
      const settings = cfg.webSearch;
      if (this.targetUsable(settings, cfg)) {
        const ladder = effortLevels(cfg).providers[settings.provider];
        const levels = ladder?.models?.[settings.model] ?? ladder?.default ?? [];
        fetchRoute = { ...settings, effort: levels.includes("low") ? "low" : undefined, tag: `${String(model)}->${settings.model} (web fetch)` };
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
      const resolved = fetchTarget ?? (json ? resolve(model, json, cfg) : null);

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
          finish("400", payload.length, `ClaudeRipple: ${reason}`, true, { ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "unroutable" });
          return;
        }
      }
      // A slot with fallbacks picks its provider before anything is sent, so a primary that is rate
      // limited for the next hour is skipped rather than rediscovered once per request. A distinct
      // prompt refusal can also select one fallback below, but only before any response is written.
      let route = resolved ? this.chooseTarget(resolved, cfg, log) : null;
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
      if (search && route && json && !this.canRunServerTools(route.provider, cfg)) {
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
              const o = await this.chatgpt(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, effortOf(json), { subagent });
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
          // Which key answers this turn. The conversation keeps the one it is on while that one is
          // healthy, because moving it moves the prompt cache with it (§4); with nothing usable the
          // first configured one is still sent, so the provider — not an empty header set — refuses.
          const credentials = this.credentialsOf(route.provider, provider);
          const providerName = route.provider;
          // Every key paused is the operator's decision, not a failure, so there is no key to send
          // the turn on — falling back to the first one would quietly use a key the dashboard says is
          // out of rotation. Answered here instead, retryable, the way a draining router answers.
          // Cooling keys are different: the turn still goes out on the first one, as before.
          if (!path.startsWith("/v1/messages/count_tokens") && credentials.length > 0 && credentials.every((credential) => credential.paused)) {
            const message = isOpenCodeGo(provider) ? "every OpenCode Go key is paused" : `every key of ${providerName} is paused`;
            const out = JSON.stringify({ type: "error", error: { type: "overloaded_error", message } });
            res.writeHead(503, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
            finish("503", Buffer.byteLength(out), message, true, { ...(!searchAttempted ? { upstreamCalled: false as const } : {}) });
            return;
          }
          // A key whose 5-hour, weekly or monthly window is already full is out of rotation until that
          // window resets, the way a ChatGPT account at 100% is. This reads the usage cache only —
          // never fetches on the request path — so an empty cache simply means "nothing known yet".
          this.parkSpentOpenCodeKeys(providerName, provider, credentials);
          // The same pre-emptive rule for a prepaid key: one whose cached balance read says zero is
          // skipped until the next read can say otherwise.
          this.parkEmptyBalanceKeys(providerName, provider, credentials);
          const conversation = conversationKey(json as AnthropicRequest);
          // With nothing usable the turn still has to go somewhere (cooling keys are not the
          // operator's decision, unlike pausing), but never on a paused key: the 503 above already
          // took every-paused out, so the first non-paused key is the fallback, and `credentials[0]`
          // only remains for the empty-pool case that cannot happen.
          const first = this.pool.pick(providerName, credentials, conversation) ?? credentials.find((credential) => !credential.paused) ?? credentials[0]!;
          const triedKeys = new Set<string>([first.id]);
          // The key the attempt in flight is on, so a failure is charged to the key that produced it
          // rather than to the one the turn happened to start on.
          let charging = first;
          try {
            const o = await this.openai(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, routeEffort, {
              credential: first,
              // Nothing has been written to the client when this is asked, so a refused key can be
              // replaced inside the same turn (the adapter re-asks before its first byte). A failure
              // that is the request's own fault is not retried at all, and one that is not about the
              // credential at all — a relay's 403 "Upstream request failed", an edge 5xx — must not
              // move the conversation: `aboutCredential` decides, as `nextCredential` does for the
              // anthropic-compatible wire.
              next: async (status, text, headers) => {
                if (res.headersSent) return null;
                const verdict = classify(status, undefined, text);
                if (!verdict.retryable) return null;
                if (!aboutCredential(verdict)) return null;
                const rest = credentials.filter((credential) => !triedKeys.has(credential.id));
                // A vendor that states when the key comes back is believed over the pool's default;
                // that is a cooling time, not a failure, so it is set rather than added to.
                const spent = await this.refusedUntil(providerName, provider, charging, status, text, headers);
                if (spent !== undefined) this.pool.coolUntil(providerName, charging.id, spent);
                // Charged here so the key that just refused is cooling when the next one is picked.
                // With nothing left to try the turn ends instead, and `recordOutcome` charges it —
                // twice on one failure would stretch a vendor's cooldown. The vendor's own reset and
                // body travel with it: a 429 whose `retry-after` says an hour must not cool for the
                // default minute, and a relay's 403 says what it is about in its body.
                else if (rest.length > 0) this.pool.penalise(providerName, charging.id, status, retryAfterMs(headers), text);
                if (rest.length === 0) return null;
                const next = this.pool.pick(providerName, rest, conversation);
                if (next) {
                  triedKeys.add(next.id);
                  charging = next;
                }
                return next;
              },
            });
            // Charged to the key that actually answered, not to the one the turn started on. The
            // vendor's own status, reset and body go with it, so this terminal charge reaches the
            // same verdict as the mid-turn one (a stated 429 reset, a 402 that the client saw as a
            // 400, a relay 403 that is not about the key). A refusal that is not about the key is
            // charged to nobody at all, the way the anthropic-compatible wire's `onUpstreamJudged`
            // already does for a 400: the credential answered, and a transient verdict would only
            // reset (or stretch) a cooldown it did not earn. `count_tokens` is answered locally
            // without naming a key, so it is charged to nobody: a local 200 must not `succeed`
            // either, or it would lift a quarantine it never earned.
            if (!path.startsWith("/v1/messages/count_tokens")) {
              const outcome = o.vendorRefusal?.status ?? o.status;
              const verdict = classify(outcome, o.vendorRefusal?.retryAfterMs, o.vendorRefusal?.body);
              if (outcome < 400 || outcome === 0 || aboutCredential(verdict)) {
                this.recordOutcome(providerName, outcome, o.credentialId ?? first.id, o.vendorRefusal?.retryAfterMs, o.vendorRefusal?.body);
              }
              this.providerHealth.observe(providerName, o.status, o.exhaustion);
            }
            finish(String(o.status), o.bytes, o.note, o.status >= 400, { ...o, ...(searchAttempted ? { upstreamCalled: undefined } : {}) });
          } catch (e) {
            this.recordOutcome(providerName, 0, charging.id);
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
            try {
              const o = await this.google(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, routeEffort);
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
              this.recordOutcome(route.provider, o.status);
              if (!path.startsWith("/v1/messages/count_tokens")) this.providerHealth.observe(route.provider, o.status, o.exhaustion);
              finish(String(o.status), o.bytes, o.note, o.status >= 400, { ...o, ...(searchAttempted ? { upstreamCalled: undefined } : {}) });
            } catch (e) {
              this.recordOutcome(route.provider, 0);
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
              const o = await this.grok(route.provider, provider).handle(req, res, path, json as unknown as AnthropicRequest, route.model, routeEffort);
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
              finish("401", out.length, "no usable Claude account", true, { ...(!searchAttempted ? { upstreamCalled: false as const } : {}), refusal: "no-account" });
              return;
            }
            dropForeignThinking(json);
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
          // Every key paused is the operator's decision, not a failure, so there is no key this turn
          // may be sent on — the same local refusal the openai-compatible branch makes. Cooling keys
          // are different: the turn still goes out, on the first one that is not paused.
          if (credentials.length > 0 && credentials.every((credential) => credential.paused)) {
            const message = `every key of ${route.provider} is paused`;
            const out = JSON.stringify({ type: "error", error: { type: "overloaded_error", message } });
            res.writeHead(503, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out)) }).end(out);
            finish("503", Buffer.byteLength(out), message, true, { ...(!searchAttempted ? { upstreamCalled: false as const } : {}) });
            return;
          }
          // A prepaid key whose cached balance says zero is skipped for a new conversation, exactly as
          // a spent OpenCode Go window is; OpenCode-only usage parking stays inside its own helper.
          this.parkEmptyBalanceKeys(route.provider, provider, credentials);
          // The same key the prompt cache is keyed on. `metadata.user_id` alone is one value for every
          // conversation a user has, so using it raw would drag all of them onto one credential at once
          // — the opposite of what stickiness is for (see conversationKey and ARCHITECTURE §4).
          chosen = this.pool.pick(route.provider, credentials, conversationKey(json as AnthropicRequest));
          // Nothing usable means every credential is cooling, and the turn still has to go somewhere:
          // the first one that is not paused, so the request carries real credentials rather than none,
          // and so the answer is charged to the credential that actually produced it.
          const using = chosen ?? credentials.find((credential) => !credential.paused) ?? credentials[0]!;
          chosen = using;
          penalised = { provider: route.provider, id: using.id };
          target = {
            protocol,
            host: u.hostname,
            port: Number(u.port) || (protocol === "https:" ? 443 : 80),
            agent: this.agentFor(route.provider, protocol),
            // The provider's own headers travel with every key — an org id, a vendor flag — but its
            // authentication does not: the credential is the complete auth set (config.ts
            // ProviderCredential), and a leftover auth header beside it would send a key that is not in
            // rotation. The credential wins over the session header too: they are different names in
            // practice, but a vendor that reused one would mean the request going out unauthenticated.
            extraHeaders: {
              ...withoutAuthHeaders("headers" in provider ? provider.headers : undefined),
              ...(provider.sessionHeader ? { [provider.sessionHeader]: conversationKey(json as AnthropicRequest) } : {}),
              ...using.headers,
            },
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
          if (json && dropForeignThinking(json) > 0) body = Buffer.from(JSON.stringify(json));
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
       * is the request's own fault is not retried at all, and one that says nothing about the
       * credential is retried on the *same* one (see `aboutCredential`).
       */
      const nextCredential = (status: number, body = ""): Credential | null => {
        if (!route || !penalised || res.headersSent) return null;
        const verdict = classify(status, undefined, body);
        if (!verdict.retryable) return null;
        // A relay's broken upstream, an edge 5xx, a 408: the credential did nothing, so only the
        // attempt moves. Answering the client with the refusal while the key stays where it is keeps
        // the conversation (and its prompt cache) on the key that worked before this turn.
        if (!aboutCredential(verdict)) return null;
        const owner = cfg.providers[route.provider];
        if (!owner) return null;
        // The model's own shape again: its credential pool is the provider's, but an auth convention
        // this model overrides has to be the one the retry actually sends.
        const provider = providerFor(owner, route.model);
        const native = provider.type === "anthropic" && provider.accountPool;
        const available = native ? this.claudeAccounts.peekCredentials() : this.credentialsOf(route.provider, provider);
        const rest = available.filter((c) => !tried.has(c.id));
        if (rest.length === 0) return null;
        const next = this.pool.pick(route.provider, rest, conversationKey(json as AnthropicRequest));
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
        // stream that has already ended. The bytes go back exactly as they arrived, so a compressed
        // body still matches the `content-encoding` and `content-length` the upstream stated; only a
        // truncated one is sent decoded, and both headers were dropped above for it.
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
    finish: (status: string, bytes: number, note?: string, failed?: boolean) => void,
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
    const userHeaders = "headers" in provider && provider.headers ? provider.headers : {};
    // A key-based provider authenticates through its credential pool, not `headers`: once a provider
    // that kept its key in `headers` gains a key (POST /api/provider-keys migrates it into
    // `credentials`), `headers` no longer carries authentication. A search side request rides the same
    // key rotation as an ordinary turn — the first usable key, never a paused one — because a search
    // that went out under nobody's key would answer 401 on a provider whose models work.
    const keyBased = provider.type === "openai-compatible" || provider.type === "anthropic-compatible";
    const credentials = keyBased ? this.credentialsOf(settings.provider, provider) : [];
    const using = keyBased ? this.pool.pick(settings.provider, credentials) ?? credentials.find((credential) => !credential.paused) : undefined;
    const common = {
      name: settings.provider,
      url: url ?? "",
      headers: {
        ...(keyBased ? withoutAuthHeaders(userHeaders) : userHeaders),
        ...(using ? using.headers : {}),
        ...(sessionHeader ? { [sessionHeader]: crypto.randomUUID() } : {}),
      },
      model: settings.model,
      ...(settings.maxResults ? { maxResults: settings.maxResults } : {}),
    };
    let backend;
    if (provider.type === "anthropic-compatible") {
      // Refuse before sending rather than after. A provider that cannot run the server tool is sent
      // "perform a web search" with no tool attached, and a model told to search with nothing to
      // search with narrates a tool call instead — an answer shaped like success, holding nothing.
      if (!searchVia && !this.canRunServerTools(settings.provider, this.deps.config())) {
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
      markAttempted();
      const outcome = await backend.search(query);
      blocks = webSearchBlocks(query, outcome).blocks;
    } catch (e) {
      this.deps.log.warn(`web search via ${settings.provider}: ${(e as Error).message}`);
      return false;
    }

    record.target = `${settings.provider}/${settings.model}`;
    record.provider = settings.provider;
    record.purpose = "web-search";
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
    if (this.targetUsable(resolved, cfg)) return resolved;
    for (const f of resolved.fallbacks) {
      if (f.provider === resolved.provider && f.model === resolved.model) continue;
      if (!this.targetUsable(f, cfg)) continue;
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

  /** Only configured route fallbacks, not another account or an invented provider. */
  private unwrittenFallback(resolved: Resolved, attempted: Resolved, cfg: Config, why: "prompt" | "capacity"): Resolved | null {
    for (const f of resolved.fallbacks ?? []) {
      if (f.provider === attempted.provider && f.model === attempted.model) continue;
      if (!this.targetUsable(f, cfg)) continue;
      return {
        provider: f.provider, model: f.model, effort: f.effort ?? resolved.effort,
        tag: `${resolved.tag.split("->")[0] ?? resolved.model}->${f.model} (${why} fallback from ${attempted.provider})`,
      };
    }
    return null;
  }

  private targetUsable(target: Pick<Resolved, "provider" | "model">, cfg: Config): boolean {
    const configured = cfg.providers[target.provider];
    if (!configured) return false;
    const provider = providerFor(configured, target.model);
    if (provider.type === "anthropic") {
      if (!provider.accountPool || provider.auth !== "claude-code") return false;
      const accounts = this.claudeAccounts.peekCredentials();
      return accounts.length > 0 && this.pool.hasUsable(target.provider, accounts);
    }
    if (provider.type === "chatgpt") return this.chatgpt(target.provider, provider).hasUsable();
    if (provider.type === "google" && provider.auth === "antigravity") return this.google(target.provider, provider).hasUsable();
    return this.pool.hasUsable(target.provider, this.credentialsOf(target.provider, provider));
  }

  /**
   * Tell the pool how a translated provider's turn went, for the credential that produced it. These
   * adapters hold one credential at a time — an OAuth grant, configured headers, or one key of an
   * openai-compatible pool — but the pool still has to hear about the result or `hasUsable` says yes
   * forever and a slot can never fail over away.
   *
   * A status of 0 means the attempt threw before an answer, which is a connect failure. `id` is the
   * credential the turn ended on; absent, this is the single-credential providers' fixed id.
   *
   * `retryAfterMs` and `body` are the vendor's own account of a refusal, when there is one: without
   * them a 429 stating an hour, or a relay's 403 naming its own broken upstream, was judged as if it
   * had said nothing at all. The status itself must be the vendor's too — a translated adapter
   * reports the client its own error code (a 402 reaches Claude Code as a 400), and judging by that
   * never parks the last out-of-credit key.
   */
  private recordOutcome(provider: string, status: number, id = "default", retryAfterMs?: number, body?: string): void {
    if (status >= 400 || status === 0) this.pool.penalise(provider, id, status, retryAfterMs, body);
    else if (status > 0) this.pool.succeed(provider, id);
  }

  /**
   * Park every key of a credit-selling provider whose last balance read said nothing is left, until
   * the next read is due — the same pre-emptive rule a spent usage window follows, so a key that
   * cannot pay is never chosen for a new conversation. Only the cached balance is read: this is the
   * request path, and a turn must not wait on a balance lookup (that is `/api/provider-keys` and
   * `/api/limits`). A read that finds money again releases the key before the next pick.
   */
  private parkEmptyBalanceKeys(name: string, provider: { type: string; url?: string }, credentials: readonly Credential[]): void {
    if (!this.creditVendorOf(provider)) return;
    for (const credential of credentials) {
      if (credential.paused) continue;
      const known = this.creditBalances.peek(`${name}/${credential.id}`);
      if (!known) continue;
      if (known.remaining_usd > 0) this.pool.releaseEmpty(name, credential.id);
      else this.parkEmptyBalance(name, credential.id);
    }
  }

  /**
   * Park every OpenCode Go key whose last usage snapshot shows a full window (5-hour, weekly or
   * monthly) until that window resets — the same rule a ChatGPT account at 100% follows, so a key
   * that is spent is never picked for a new conversation. Only the cached snapshot is read: this is
   * the request path, and a turn must not wait on a second request. The cache is refreshed in the
   * background at the reader's own pace (a few minutes), and an answer that arrives later is applied
   * then, before the next turn picks a key.
   */
  private parkSpentOpenCodeKeys(name: string, provider: { type: string; url?: string; preset?: string }, credentials: readonly Credential[]): void {
    if (!isOpenCodeGo(provider) || typeof provider.url !== "string") return;
    const url = provider.url;
    for (const credential of credentials) {
      if (credential.paused) continue;
      const key = `${name}/${credential.id}`;
      const known = this.opencodeUsage.peek(key);
      const until = known ? spentWindowReset(known, Date.now()) : null;
      if (until) this.pool.coolUntil(name, credential.id, until);
      void this.opencodeUsage.windows(key, url, credential.headers).then((windows) => {
        const reset = spentWindowReset(windows, Date.now());
        if (reset) this.pool.coolUntil(name, credential.id, reset);
      }).catch(() => { /* the reader keeps its last answer and logs the status itself */ });
    }
  }

  /**
   * When a key the vendor just refused may be used again, or undefined to let the pool's own
   * `classify` decide. OpenCode Go is the only provider here whose refusal states a quota window,
   * so for everything else this is not its business.
   *
   * A stated reset wins: `retry-after`, or a reset field in the body. OpenCode's console proxies the
   * inference backend's response through unchanged, so the 429 body is the backend's and no single
   * shape is documented — `refusalResetAt` reads the fields vendors actually use instead of assuming
   * one. With nothing stated the cached snapshot is worthless here (it is the one that said this key
   * was fine), so the key's usage is read once more and the full window's own reset is used. Only
   * then does the pool's default for a rate limit apply.
   */
  private async refusedUntil(
    name: string,
    provider: { type: string; url?: string; preset?: string },
    credential: Credential,
    status: number,
    text: string,
    headers: Record<string, string>,
  ): Promise<number | undefined> {
    if (status !== 429 || !isOpenCodeGo(provider) || typeof provider.url !== "string") return undefined;
    const now = Date.now();
    const stated = refusalResetAt(text, now, retryAfterMs(headers));
    if (stated !== undefined) return stated;
    const windows = await this.opencodeUsage.refresh(`${name}/${credential.id}`, provider.url, credential.headers);
    const reset = spentWindowReset(windows, Date.now());
    if (reset !== null) return reset;
    return Date.now() + 60_000;
  }

  /** Operator action: give one credential another chance now (the dashboard's "다시 사용"). */
  credentialClear(provider: string, id: string): void {
    this.pool.clear(provider, id);
  }

  /**
   * Hold a key out of rotation because its prepaid balance read said nothing is left. The park lasts
   * one balance-read period: that read is the only thing that can say money has come back, and until
   * it answers, sending a new conversation to this key would only fail at the vendor.
   */
  private parkEmptyBalance(name: string, id: string): void {
    this.pool.parkEmpty(name, id, Date.now() + this.creditBalances.ttlMs());
  }

  /**
   * One provider's keys as the dashboard's account cards show them, in configured order: id, label,
   * state, and whatever this provider publishes about the key — usage windows for OpenCode Go, a
   * prepaid balance for a credit vendor, nothing for the rest. Never a header, which is what carries
   * the key.
   *
   * "in-use" is the key a new conversation would go to right now (the first usable one, because the
   * list order is the priority), so after a window resets it is key 1 again without anything having
   * to move a conversation back.
   *
   * A key whose usage has never been read is `unknown` rather than "standby": the dashboard must not
   * present a key it knows nothing about as one that is fine. Only OpenCode Go has a usage read at
   * all, so only there can a key be unknown; everywhere else the pool's own health is the whole
   * story.
   */
  async providerKeys(name: string): Promise<ProviderKeyState[]> {
    const cfg = this.deps.config().providers[name];
    if (!cfg || !isKeyProvider(cfg)) return [];
    const credentials = this.credentialsOf(name, cfg);
    const opencode = isOpenCodeGo(cfg) && cfg.type === "openai-compatible";
    const vendor = this.creditVendorOf(cfg);
    // Read what this provider publishes before deciding states: this is the dashboard, where waiting
    // for the answer is the point, and the snapshots it fills are what the request path then reads.
    const windows = opencode
      ? await Promise.all(credentials.map((credential) => this.opencodeUsage.windows(`${name}/${credential.id}`, (cfg as { url: string }).url, credential.headers)))
      : credentials.map((): OpenCodeWindow[] => []);
    const credits = vendor
      ? await Promise.all(credentials.map((credential) => {
        const cacheKey = `${name}/${credential.id}`;
        return this.creditBalances.balance(cacheKey, vendor, credential.headers).then((balance) => ({ balance, at: this.creditBalances.readAt(cacheKey) }));
      }))
      : credentials.map(() => ({ balance: null, at: 0 }));
    // Park from the answer just read rather than starting a second lookup per key: the dashboard
    // already waited for this one, and a background read of the same key would only race it.
    const now = Date.now();
    credentials.forEach((credential, index) => {
      if (credential.paused) return;
      if (opencode) {
        const reset = spentWindowReset(windows[index]!, now);
        if (reset !== null) this.pool.coolUntil(name, credential.id, reset);
      }
      const balance = credits[index]?.balance;
      if (!balance) return;
      if (balance.remaining_usd > 0) this.pool.releaseEmpty(name, credential.id);
      else this.parkEmptyBalance(name, credential.id);
    });
    const chosen = this.pool.pick(name, credentials);
    const reports = this.pool.report(name, credentials);
    return credentials.map((credential, index) => {
      const report = reports[index]!;
      const readAt = opencode ? this.opencodeUsage.readAt(`${name}/${credential.id}`) : credits[index]?.at ?? 0;
      const state: ProviderKeyState["state"] = report.state === "paused" || report.state === "quarantined"
        ? report.state
        : report.state === "cooling" ? "cooling"
        : opencode && readAt === 0 ? "unknown" // never read: nothing has been said about this key yet
        : chosen?.id === credential.id ? "in-use" : "standby";
      const credit = credits[index]?.balance;
      return {
        id: credential.id,
        ...(credential.label ? { label: credential.label } : {}),
        state,
        ...(report.cooldownSeconds !== undefined ? { cooldown_seconds: report.cooldownSeconds } : {}),
        at: readAt,
        windows: opencode ? windows[index]! : [],
        ...(credit ? { credit: { remaining_usd: credit.remaining_usd, low: credit.low, ...(credit.days_remaining !== undefined ? { days_remaining: credit.days_remaining } : {}) } } : {}),
      };
    });
  }

  /** OpenCode Go's account cards, kept for the old endpoint's shape (same rows, usage only). */
  async opencodeAccounts(name: string): Promise<OpenCodeAccountState[]> {
    const rows = await this.providerKeys(name);
    return rows.map((row) => ({
      id: row.id,
      ...(row.label ? { label: row.label } : {}),
      state: row.state,
      ...(row.cooldown_seconds !== undefined ? { cooldown_seconds: row.cooldown_seconds } : {}),
      at: row.at,
      windows: row.windows,
    }));
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
