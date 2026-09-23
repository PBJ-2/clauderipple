// ChatGPT subscription adapter: serves an Anthropic Messages request by calling the
// Codex backend (OpenAI Responses over SSE) and streaming the translated answer back.

import crypto from "node:crypto";
import http from "node:http";
import type { ChatGptProvider, ProviderModel } from "../../config.ts";
import type { Logger } from "../../log.ts";
import { CredentialPool, retryAfterMs } from "../../pool.ts";
import { ChatGptAccountPool, type ChatGptAccountSummary, type ChatGptCredential, type FetchLike } from "./accounts.ts";
import { SseParser } from "./sse.ts";
import { fetchWithRetry } from "../retry.ts";
import { looksLikeAuth } from "../openai/index.ts";
import { StreamMapper, conversationKey, estimateTokens, formatSse, serverToolNames, toResponsesRequest, toolNameRestoreMap, type AnthropicRequest } from "./translate.ts";
import type { RequestUsage } from "../../requestlog.ts";
import type { SearchBackend, SearchHit, WebSearchQuery } from "../../websearch.ts";
import { credentialHeaderValues, redactErrorText } from "../../redact.ts";
import { codexClientVersion, parseCodexCatalog } from "./catalog.ts";
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../../config.ts";

export const DEFAULT_BASE = "https://chatgpt.com/backend-api";
const PING_MS = 15_000;
/** Active quota lookup. Measured 2026-09-20: GET {base}/wham/usage → 200 JSON. The binary also
 * carries `/api/codex/usage`, but that path answers 403 here; `wham` is the one that works. */
const USAGE_PATH = "/wham/usage";
const USAGE_TIMEOUT_MS = 10_000;
/** Model catalogue. Measured 2026-09-23: the backend filters this list by `client_version`, and an
 * hour's cache is short enough that a model announced this morning shows up the same day. */
const MODELS_PATH = "/codex/models";
const MODELS_TIMEOUT_MS = 15_000;
const MODELS_CACHE_MS = 60 * 60 * 1000;

export type ChatGptOutcome = { status: number; bytes: number; note?: string; usage?: RequestUsage; stopReason?: string };

function anthropicError(status: number, type: string, message: string): { status: number; body: string } {
  return { status, body: JSON.stringify({ type: "error", error: { type, message } }) };
}

function mapHttpError(status: number, text: string): { status: number; body: string } {
  let msg = text.slice(0, 500);
  try {
    const j = JSON.parse(text) as { error?: { message?: string; code?: string }; detail?: string };
    msg = j.error?.message ?? j.detail ?? msg;
  } catch {
    /* keep raw */
  }
  if (status === 401) return anthropicError(401, "authentication_error", `ChatGPT: ${msg}`);
  // Same reasoning as the openai-compatible adapter: a 403 is often about what the account may do,
  // not about the credential, and naming it an auth error sends the user to check the wrong thing.
  if (status === 403) {
    return looksLikeAuth(text)
      ? anthropicError(401, "authentication_error", `ChatGPT: ${msg}`)
      : anthropicError(403, "permission_error", `ChatGPT: ${msg}`);
  }
  if (status === 429) return anthropicError(429, "rate_limit_error", `ChatGPT: ${msg}`);
  if (status >= 500) return anthropicError(529, "overloaded_error", `ChatGPT: ${msg}`);
  return anthropicError(400, "invalid_request_error", `ChatGPT: ${msg}`);
}

/**
 * Quota snapshot from the backend's `x-codex-*` response headers (measured 2026-09-13: the
 * backend reports limits there on every response; the `codex.rate_limits` SSE event is not
 * always sent). Same shape as the event so the GUI reads either.
 */
export function rateLimitsFromHeaders(h: Headers): Record<string, unknown> | null {
  const num = (k: string): number | undefined => {
    const v = h.get(k);
    if (v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const window = (p: string): Record<string, number> | null => {
    const used = num(`x-codex-${p}-used-percent`);
    if (used === undefined) return null;
    const w: Record<string, number> = { used_percent: used };
    const wm = num(`x-codex-${p}-window-minutes`);
    const ra = num(`x-codex-${p}-reset-after-seconds`);
    const rt = num(`x-codex-${p}-reset-at`);
    if (wm !== undefined) w.window_minutes = wm;
    if (ra !== undefined) w.reset_after_seconds = ra;
    if (rt !== undefined) w.reset_at = rt;
    return w;
  };
  const primary = window("primary");
  if (!primary) return null;
  const secondary = window("secondary");
  return {
    type: "codex.rate_limits",
    plan_type: h.get("x-codex-plan-type") ?? undefined,
    rate_limits: { primary, secondary: secondary && secondary.window_minutes ? secondary : null },
    at: Date.now(),
  };
}

/**
 * Map the `/wham/usage` JSON body onto the same shape as `rateLimitsFromHeaders`, so `/api/status`
 * and the GUI read one thing whether the snapshot came from response headers or the active call.
 * Shape measured 2026-09-20: `{plan_type, rate_limit: {primary_window:{used_percent,
 * limit_window_seconds, reset_after_seconds, reset_at}, secondary_window}}`; window minutes are
 * derived (the body reports seconds), and as with the headers a secondary window only counts when
 * it has a real length.
 */
export function rateLimitsFromUsage(body: unknown): Record<string, unknown> | null {
  const b = body as {
    plan_type?: unknown;
    rate_limit?: {
      primary_window?: { used_percent?: unknown; limit_window_seconds?: unknown; reset_after_seconds?: unknown; reset_at?: unknown } | null;
      secondary_window?: { used_percent?: unknown; limit_window_seconds?: unknown; reset_after_seconds?: unknown; reset_at?: unknown } | null;
    } | null;
  } | null;
  const win = (w: { used_percent?: unknown; limit_window_seconds?: unknown; reset_after_seconds?: unknown; reset_at?: unknown } | null | undefined): Record<string, number> | null => {
    const used = typeof w?.used_percent === "number" ? w.used_percent : undefined;
    if (used === undefined) return null;
    const out: Record<string, number> = { used_percent: used };
    if (typeof w!.limit_window_seconds === "number") out.window_minutes = Math.round(w!.limit_window_seconds / 60);
    if (typeof w!.reset_after_seconds === "number") out.reset_after_seconds = w!.reset_after_seconds;
    if (typeof w!.reset_at === "number") out.reset_at = w!.reset_at;
    return out;
  };
  const primary = win(b?.rate_limit?.primary_window);
  if (!primary) return null;
  const secondary = win(b?.rate_limit?.secondary_window);
  return {
    type: "codex.rate_limits",
    plan_type: typeof b?.plan_type === "string" ? b.plan_type : undefined,
    rate_limits: { primary, secondary: secondary && secondary.window_minutes ? secondary : null },
    at: Date.now(),
  };
}

type Window = { used_percent?: number; reset_after_seconds?: number; reset_at?: number };

/** When a window is back, in ms from now: its own countdown, else its reset time (epoch seconds). */
function windowResetMs(w: Window, now: number): number | undefined {
  if (typeof w.reset_after_seconds === "number" && w.reset_after_seconds >= 0) return w.reset_after_seconds * 1000;
  if (typeof w.reset_at === "number" && w.reset_at * 1000 > now) return w.reset_at * 1000 - now;
  return undefined;
}

/**
 * How long an account is out, from a rate-limit snapshot: the latest reset among the windows it
 * has used up, since it is usable only once every full window has reset. Undefined when no window
 * is full — the account is not out, whatever else the snapshot says.
 */
export function exhaustedForMs(snapshot: Record<string, unknown> | null | undefined, now = Date.now()): number | undefined {
  const limits = (snapshot?.rate_limits ?? null) as { primary?: Window | null; secondary?: Window | null } | null;
  let out: number | undefined;
  for (const w of [limits?.primary, limits?.secondary]) {
    if (!w || typeof w.used_percent !== "number" || w.used_percent < 100) continue;
    const ms = windowResetMs(w, now) ?? 60_000;
    out = Math.max(out ?? 0, ms);
  }
  return out;
}

/** One account as the dashboard shows it: who, whether it is in rotation, and its last known quota. */
export type ChatGptAccountStatus = ChatGptAccountSummary & {
  state: "ready" | "cooling" | "quarantined" | "paused" | "needs-login";
  cooldownSeconds?: number;
  quota: Record<string, unknown> | null;
  active: boolean;
};

export class ChatGptAdapter {
  readonly name: string;
  private readonly cfg: ChatGptProvider;
  private readonly accounts: ChatGptAccountPool;
  /** Cooldowns and conversation stickiness, shared with the proxy's other credential pools. */
  private readonly pool: CredentialPool;
  private readonly log: Logger;
  /** Latest quota per account (owner id), from response headers or `/wham/usage`. */
  private readonly rateLimitsByAccount = new Map<string, Record<string, unknown>>();
  /** The account that answered last: the one whose quota the single-number readers see. */
  private activeOwner: string | null = null;

  constructor(name: string, cfg: ChatGptProvider, home: string, log: Logger, pool = new CredentialPool(), fetchImpl?: FetchLike) {
    this.name = name;
    this.cfg = cfg;
    this.log = log;
    this.pool = pool;
    this.accounts = new ChatGptAccountPool({ home, mode: cfg.auth ?? "auto", log, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  /**
   * The quota of the account in use, in the shape it always had. Readers that want one number
   * (the tray, the health line, other tools reading `/api/status`) keep getting one; the
   * per-account view is `accountStatus()`.
   */
  get lastRateLimits(): Record<string, unknown> | null {
    const credentials = this.accounts.peekCredentials();
    const active = credentials.find((c) => c.ownerId === this.activeOwner);
    if (active && this.pool.hasUsable(this.name, [active]) && this.rateLimitsByAccount.has(active.ownerId)) return this.rateLimitsByAccount.get(active.ownerId)!;
    // Otherwise the account the next turn would go to: a spent account's 100% is not what is left.
    const next = credentials.find((c) => this.pool.hasUsable(this.name, [c]) && this.rateLimitsByAccount.has(c.ownerId))
      ?? credentials.find((c) => this.rateLimitsByAccount.has(c.ownerId));
    return next ? this.rateLimitsByAccount.get(next.ownerId)! : null;
  }

  /** Record a snapshot for an account; a full window takes it out of rotation until that window resets. */
  private noteRateLimits(credential: ChatGptCredential, snapshot: Record<string, unknown> | null): void {
    if (!snapshot) return;
    this.rateLimitsByAccount.set(credential.ownerId, snapshot);
    const outMs = exhaustedForMs(snapshot);
    if (outMs !== undefined) this.pool.penalise(this.name, credential.id, 429, outMs);
  }

  describeAuth(): string {
    const all = this.accounts.summaries();
    const usable = this.accounts.peekCredentials().filter((c) => this.pool.hasUsable(this.name, [c])).length;
    return `accounts=${all.length} usable=${usable} mode=${this.cfg.auth ?? "auto"}`;
  }

  /** Whether any account could answer now, for the proxy's choice between this provider and a fallback. */
  hasUsable(): boolean {
    return this.pool.hasUsable(this.name, this.accounts.peekCredentials());
  }

  signedIn(): boolean {
    return this.accounts.signedIn();
  }

  /** Every account with its rotation state and last known quota. Metadata only — no token leaves. */
  accountStatus(): ChatGptAccountStatus[] {
    const credentials = this.accounts.peekCredentials();
    const reports = new Map(this.pool.report(this.name, credentials).map((r) => [r.id, r]));
    return this.accounts.summaries().map((summary) => {
      const credential = credentials.find((c) => c.ownerId === summary.id);
      const report = credential ? reports.get(credential.id) : undefined;
      const state: ChatGptAccountStatus["state"] = summary.paused ? "paused" : !credential ? "needs-login" : report?.state ?? "ready";
      return {
        ...summary,
        state,
        ...(report?.cooldownSeconds ? { cooldownSeconds: report.cooldownSeconds } : {}),
        quota: this.rateLimitsByAccount.get(summary.id) ?? null,
        active: summary.id === this.activeOwner,
      };
    });
  }

  /** Put a cooling account back into rotation now (dashboard action). */
  clearCooldown(ownerId: string): void {
    for (const c of this.accounts.peekCredentials()) if (c.ownerId === ownerId) this.pool.clear(this.name, c.id);
  }

  /**
   * An account for one turn: the conversation's own while it is healthy, else the first usable one.
   * "none" when nothing is signed in; null when every account is cooling or already tried.
   */
  private async pick(conversation: string | undefined, tried: ReadonlySet<string> = new Set()): Promise<ChatGptCredential | "none" | null> {
    const all = await this.accounts.credentials();
    if (all.length === 0) return "none";
    const rest = all.filter((c) => !tried.has(c.ownerId));
    return (this.pool.pick(this.name, rest, conversation) as ChatGptCredential | null);
  }

  /** For side calls (search, catalogue, quota) with no conversation: a usable account, else any. */
  private async anyCredential(): Promise<ChatGptCredential | Error> {
    const all = await this.accounts.credentials();
    if (all.length === 0) return new Error("no ChatGPT credentials: run `clauderipple login`, or sign in to the Codex CLI once");
    return (this.pool.pick(this.name, all) as ChatGptCredential | null) ?? all[0]!;
  }

  /** The soonest any account is back, for the message when all of them are out. */
  private soonestBackMs(): number | undefined {
    const reports = this.pool.report(this.name, this.accounts.peekCredentials());
    const cooling = reports.filter((r) => r.state === "cooling" && r.cooldownSeconds).map((r) => r.cooldownSeconds! * 1000);
    return cooling.length ? Math.min(...cooling) : undefined;
  }

  /**
   * Hosted web search through the same Codex backend and credential as ordinary ChatGPT turns.
   * Wire measured 2026-09-20 against the live backend: a `web_search` Responses tool emits one
   * `web_search_call`, URL citation annotations on the final output text, and
   * `response.completed.response.tool_usage.web_search.num_requests`.
   */
  webSearch(model: string, maxResults?: number): SearchBackend {
    return {
      name: this.name,
      search: (query, signal) => this.searchWeb(model, query, maxResults, signal),
    };
  }

  private async searchWeb(model: string, query: WebSearchQuery, maxResults = 10, signal?: AbortSignal): Promise<{ hits: SearchHit[]; text?: string }> {
    // The Responses tool exposes an allowed-domain filter but no exclusion filter. Ignoring a block
    // would violate the caller's request; fail visibly so the proxy can choose another backend.
    if (query.blockedDomains?.length) throw new Error("ChatGPT web search does not support blocked_domains");
    const tokens = await this.anyCredential();
    if (tokens instanceof Error) throw tokens;
    const id = crypto.randomUUID();
    const filters = query.allowedDomains?.length ? { allowed_domains: query.allowedDomains } : undefined;
    const tool = {
      type: "web_search",
      search_context_size: "low",
      external_web_access: true,
      ...(filters ? { filters } : {}),
    };
    const body = {
      model,
      instructions: "Perform the requested web search. Answer briefly and cite every source used.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query.query }] }],
      tools: [tool],
      tool_choice: "required",
      reasoning: { effort: "low", summary: "auto" },
      text: { verbosity: "low" },
      store: false,
      stream: true,
      prompt_cache_key: id,
      client_metadata: { session_id: id, thread_id: id, turn_id: crypto.randomUUID(), "x-codex-window-id": `${id}:0` },
    };
    const timeout = AbortSignal.timeout(60_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const res = await fetch(`${(this.cfg.url ?? DEFAULT_BASE).replace(/\/$/, "")}/codex/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${tokens.accessToken}`,
        "chatgpt-account-id": tokens.accountId,
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        "session-id": id,
        "thread-id": id,
        "x-client-request-id": id,
        "x-codex-window-id": `${id}:0`,
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    this.noteRateLimits(tokens, rateLimitsFromHeaders(res.headers));
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) void this.accounts.forceRefresh(tokens.ownerId);
      throw new Error(`ChatGPT web search: HTTP ${res.status}${text ? ` ${redactErrorText(text, [tokens.accessToken], 200)}` : ""}`);
    }

    const parser = new SseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const hits: SearchHit[] = [];
    let text = "";
    let searches = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          if (event.type === "response.output_text.delta") text += String(event.delta ?? "");
          if (event.type === "response.output_text.annotation.added") {
            const a = event.annotation as { type?: unknown; title?: unknown; url?: unknown } | undefined;
            if (a?.type === "url_citation" && typeof a.url === "string") hits.push({ title: typeof a.title === "string" && a.title ? a.title : a.url, url: a.url });
          }
          if (event.type === "response.completed") {
            const completed = event.response as { tool_usage?: { web_search?: { num_requests?: unknown } }; usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens?: number } } | undefined;
            searches = typeof completed?.tool_usage?.web_search?.num_requests === "number" ? completed.tool_usage.web_search.num_requests : searches;
          }
          if (event.type === "error") throw new Error(`ChatGPT web search: ${String((event.error as { message?: unknown } | undefined)?.message ?? "backend error")}`);
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    const unique = new Map<string, SearchHit>();
    for (const hit of hits) if (!unique.has(hit.url)) unique.set(hit.url, hit);
    const selected = [...unique.values()].slice(0, maxResults);
    if (searches < 1 || selected.length === 0) throw new Error(`ChatGPT web search: no cited results returned (searches=${searches})`);
    const prose = text.trim();
    return prose ? { hits: selected, text: prose } : { hits: selected };
  }

  /** One in-flight lookup shared by every caller (the status route and the startup refresh). */
  private rateLimitsInFlight: Promise<Record<string, unknown> | null> | null = null;

  /**
   * Ask the backend for the current quota instead of waiting for a request to carry it in the
   * response headers. Without this, `/api/status` shows the last time GPT traffic flowed — 11
   * hours stale in one measurement (2026-09-20) — and the product's GPT budget read is wrong.
   * Every account is asked, so the dashboard can show each one and an account that is already
   * spent leaves rotation before a turn finds out the hard way. Never throws and never clears a
   * good snapshot; returns the active account's new one, or null when none could be read.
   */
  fetchRateLimits(): Promise<Record<string, unknown> | null> {
    if (this.rateLimitsInFlight) return this.rateLimitsInFlight;
    this.rateLimitsInFlight = this.fetchAllRateLimits().finally(() => {
      this.rateLimitsInFlight = null;
    });
    return this.rateLimitsInFlight;
  }

  private async fetchAllRateLimits(): Promise<Record<string, unknown> | null> {
    const all = await this.accounts.credentials();
    if (all.length === 0) {
      this.log.warn(`chatgpt ${this.name}: rate-limit fetch skipped: no ChatGPT credentials`);
      return null;
    }
    const results = await Promise.all(all.map((c) => this.fetchRateLimitsOnce(c)));
    return results.some(Boolean) ? this.lastRateLimits : null;
  }

  private async fetchRateLimitsOnce(tokens: ChatGptCredential, replayed = false): Promise<Record<string, unknown> | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), USAGE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${(this.cfg.url ?? DEFAULT_BASE).replace(/\/$/, "")}${USAGE_PATH}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "chatgpt-account-id": tokens.accountId,
          originator: "codex_cli_rs",
          accept: "application/json",
        },
        signal: ac.signal,
      });
    } catch (e) {
      this.log.warn(`chatgpt ${this.name}: rate-limit fetch failed: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // A bare 401 here is usually a token that went stale early: one refresh and one replay, and
      // no more — asking again and again with a dead grant is the loop to avoid.
      if (res.status === 401 && !replayed && await this.accounts.forceRefresh(tokens.ownerId)) {
        const fresh = this.accounts.peekCredentials().find((c) => c.ownerId === tokens.ownerId);
        if (fresh) return this.fetchRateLimitsOnce(fresh, true);
      }
      this.log.warn(`chatgpt ${this.name}: rate-limit fetch HTTP ${res.status} (account ${tokens.ownerId.slice(0, 8)})`);
      return null;
    }
    const parsed = rateLimitsFromUsage(await res.json().catch(() => null));
    if (!parsed) {
      this.log.warn(`chatgpt ${this.name}: rate-limit fetch returned no primary window`);
      return null;
    }
    this.noteRateLimits(tokens, parsed);
    return parsed;
  }

  /** One in-flight catalogue lookup shared by every caller, and the last good list for an hour. */
  private modelsInFlight: Promise<ProviderModel[] | null> | null = null;
  private modelsCache: { at: number; models: ProviderModel[] } | null = null;

  /**
   * The models this subscription can actually reach, from the backend's own catalogue. Without it
   * a model OpenAI ships is invisible here until a router release names it (gpt-6-sol and gpt-6-luna,
   * 2026-09-23). Never throws; null on any failure, and null
   * rather than [] when parsing yields nothing, so the caller falls back instead of showing nothing.
   */
  fetchModels(): Promise<ProviderModel[] | null> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODELS_CACHE_MS) return Promise.resolve(this.modelsCache.models);
    if (this.modelsInFlight) return this.modelsInFlight;
    // A failed refresh keeps the last list it read: an expired catalogue is still closer to the
    // backend than the fallback written into this repo.
    this.modelsInFlight = this.fetchModelsOnce().then((models) => models ?? this.modelsCache?.models ?? null).finally(() => {
      this.modelsInFlight = null;
    });
    return this.modelsInFlight;
  }

  private async fetchModelsOnce(): Promise<ProviderModel[] | null> {
    const tokens = await this.anyCredential();
    if (tokens instanceof Error) {
      this.log.warn(`chatgpt ${this.name}: model-catalog fetch skipped: ${tokens.message}`);
      return null;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MODELS_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${(this.cfg.url ?? DEFAULT_BASE).replace(/\/$/, "")}${MODELS_PATH}?client_version=${encodeURIComponent(codexClientVersion())}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "chatgpt-account-id": tokens.accountId,
          originator: "codex_cli_rs",
          accept: "application/json",
        },
        signal: ac.signal,
      });
    } catch (e) {
      this.log.warn(`chatgpt ${this.name}: model-catalog fetch failed: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // The status only: the body can echo the request, and the token rides on it.
      if (res.status === 401) void this.accounts.forceRefresh(tokens.ownerId);
      this.log.warn(`chatgpt ${this.name}: model-catalog fetch HTTP ${res.status}`);
      return null;
    }
    const models = parseCodexCatalog(await res.json().catch(() => null));
    if (models.length === 0) {
      this.log.warn(`chatgpt ${this.name}: model catalog returned no listed models`);
      return null;
    }
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  /** Last measured total input (uncached + cached) per conversation, for the next message_start estimate. */
  private readonly lastInputByKey = new Map<string, number>();

  /**
   * The backend's `x-codex-turn-state` per conversation. Every response carries this opaque
   * token and the Codex CLI sends it back on the conversation's next turn (it sits in the
   * binary's request-header list beside `x-codex-installation-id`). Without it the backend
   * answered `cached_tokens: 0` on every turn of a conversation whose prompt_cache_key,
   * instructions, tools and input prefix were byte-identical 3–6s apart (measured 2026-09-20,
   * five turns, GPT-6 Astra) — the same adapter read 93% on 2026-09-13, so the backend began
   * keying cache affinity on this token in between. Keyed on the cache key, which is what a
   * conversation is to us.
   */
  private readonly turnStateByKey = new Map<string, string>();

  private rememberInput(key: string, u: { input_tokens: number; cache_read_input_tokens: number }): void {
    const total = u.input_tokens + u.cache_read_input_tokens;
    if (total > 0) {
      this.lastInputByKey.set(key, total);
      if (this.lastInputByKey.size > 500) this.lastInputByKey.delete(this.lastInputByKey.keys().next().value!);
    }
  }

  /** Troubleshooting aid (provider.debugDump): the failing exchange, secrets excluded (the request carries none). */
  private dump(status: number, anthropic: AnthropicRequest, upstreamReq: unknown, upstreamText: string): void {
    try {
      const dir = path.join(homeDir(), "debug");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `upstream-${new Date().toISOString().replace(/[:.]/g, "-")}-${status}.json`);
      fs.writeFileSync(file, JSON.stringify({ status, upstream: upstreamText, request: upstreamReq, anthropic }, null, 1));
      const files = fs.readdirSync(dir).filter((f) => f.startsWith("upstream-")).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 60))) fs.rmSync(path.join(dir, f), { force: true });
    } catch (e) {
      this.log.warn(`chatgpt ${this.name}: debug dump failed: ${(e as Error).message}`);
    }
  }

  /**
   * Send one turn, moving to the next account while nothing has reached the client:
   *
   * - 401, or a 403 that reads as a credential refusal: one refresh of that account and a replay;
   *   refused again, the account is quarantined (and marked for sign-in when it is ours).
   * - 429 and 402: the account rests until its window resets, from `retry-after` or the
   *   `x-codex-*` reset the backend reports, and the next account takes the turn.
   * - Any other 403, 5xx, or no connection at all: a short rest, and the next account.
   * - Anything else is the request's fault; another account would refuse it the same way.
   *
   * Each account is tried at most once per turn (a refreshed token is the same account).
   */
  private async sendToAnAccount(cacheKey: string, body: string, signal: AbortSignal): Promise<
    | { upstream: Response; credential: ChatGptCredential }
    | { error: { status: number; body: string; retryAfterSeconds?: number }; note: string; upstreamStatus?: number; aborted?: false; thrown?: undefined }
    | { error: true; aborted: true; thrown?: undefined; note?: undefined; upstreamStatus?: undefined }
    | { error: true; thrown: Error; aborted?: false; note?: undefined; upstreamStatus?: undefined }
  > {
    const tried = new Set<string>();
    const replayed = new Set<string>();
    const refreshed = new Set<string>();
    let last: { status: number; body: string; note: string; upstreamStatus: number; retryAfterSeconds?: number } | null = null;
    let lastThrown: Error | null = null;
    for (;;) {
      const credential = await this.pick(cacheKey, tried);
      if (credential === "none") {
        const e = anthropicError(401, "authentication_error", "no ChatGPT credentials: run `clauderipple login`, or sign in to the Codex CLI once");
        return { error: { status: e.status, body: e.body }, note: "no credentials" };
      }
      if (credential === null) {
        if (last) return { error: { status: last.status, body: last.body, ...(last.retryAfterSeconds ? { retryAfterSeconds: last.retryAfterSeconds } : {}) }, note: last.note, upstreamStatus: last.upstreamStatus };
        if (lastThrown) return { error: true, thrown: lastThrown };
        // Every account was already resting when the turn arrived.
        const backMs = this.soonestBackMs();
        const when = backMs ? ` The first is usable again at ${new Date(Date.now() + backMs).toLocaleTimeString()}.` : "";
        const e = anthropicError(429, "rate_limit_error", `ChatGPT: every signed-in account is at its usage limit.${when}`);
        return { error: { status: 429, body: e.body, ...(backMs ? { retryAfterSeconds: Math.ceil(backMs / 1000) } : {}) }, note: "all accounts resting" };
      }

      const turnKey = `${credential.ownerId}\0${cacheKey}`;
      const turnState = this.turnStateByKey.get(turnKey);
      const upstreamHeaders = {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...credential.headers,
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        // The conversation's identity, as the Codex CLI states it. This is what the backend keys
        // the prompt cache on since mid-September 2026 (see `conversationId` in translate.ts).
        "session-id": cacheKey,
        "thread-id": cacheKey,
        "x-client-request-id": cacheKey,
        "x-codex-window-id": `${cacheKey}:0`,
        // Turn state is issued per account; another account's would be meaningless to the backend.
        ...(turnState ? { "x-codex-turn-state": turnState } : {}),
      };
      let upstream: Response;
      try {
        // Retried here on the same account, before any status or byte reaches the client, so a
        // relay's hiccup is absorbed inside the turn instead of arriving as an error to retry by hand.
        upstream = await fetchWithRetry(`${(this.cfg.url ?? DEFAULT_BASE).replace(/\/$/, "")}/codex/responses`, {
          method: "POST",
          headers: upstreamHeaders,
          body,
          signal,
        }, { log: (line) => this.log.info(`chatgpt ${this.name}: ${line}`) });
      } catch (e) {
        if (signal.aborted) return { error: true, aborted: true };
        this.pool.penalise(this.name, credential.id, 0);
        tried.add(credential.ownerId);
        lastThrown = e as Error;
        this.log.info(`chatgpt ${this.name}: account ${credential.ownerId.slice(0, 8)} unreachable (${(e as Error).message}); trying another`);
        continue;
      }

      this.noteRateLimits(credential, rateLimitsFromHeaders(upstream.headers));
      const nextTurnState = upstream.headers.get("x-codex-turn-state");
      if (nextTurnState) {
        this.turnStateByKey.set(turnKey, nextTurnState);
        if (this.turnStateByKey.size > 500) this.turnStateByKey.delete(this.turnStateByKey.keys().next().value!);
      }

      if (upstream.ok && upstream.body) {
        this.pool.succeed(this.name, credential.id);
        this.activeOwner = credential.ownerId;
        return { upstream, credential };
      }

      const text = await upstream.text().catch(() => "");
      const safeText = redactErrorText(text, credentialHeaderValues(Object.entries(upstreamHeaders)));
      const status = upstream.status;
      this.log.warn(`chatgpt ${this.name}: account ${credential.ownerId.slice(0, 8)} answered ${status}: ${safeText.slice(0, 400)}`);
      const credentialRefused = status === 401 || (status === 403 && looksLikeAuth(text));

      if (credentialRefused) {
        if (!replayed.has(credential.ownerId)) {
          replayed.add(credential.ownerId);
          if (await this.accounts.forceRefresh(credential.ownerId)) {
            refreshed.add(credential.ownerId);
            this.log.info(`chatgpt ${this.name}: account ${credential.ownerId.slice(0, 8)} refreshed after ${status}; replaying`);
            continue;
          }
        } else if (refreshed.has(credential.ownerId)) {
          // A token minted a moment ago and refused anyway: the account itself is refused. A refresh
          // that merely failed to reach OpenAI proves nothing and leaves the account alone.
          this.accounts.reject(credential);
        }
      }

      const headerRecord = Object.fromEntries(upstream.headers.entries());
      const snapshot = rateLimitsFromHeaders(upstream.headers);
      const retryHeader = headerRecord["retry-after"] ? retryAfterMs({ "retry-after": headerRecord["retry-after"] }) : undefined;
      const waitMs = retryHeader ?? exhaustedForMs(snapshot) ?? retryAfterMs(headerRecord);
      const verdict = this.pool.penalise(this.name, credential.id, credentialRefused ? 401 : status, waitMs, text);
      const err = mapHttpError(status, safeText);
      last = { status: err.status, body: err.body, note: `upstream ${status}`, upstreamStatus: status, ...(status === 429 && waitMs ? { retryAfterSeconds: Math.ceil(waitMs / 1000) } : {}) };
      if (!verdict.retryable) return { error: { status: err.status, body: err.body }, note: last.note, upstreamStatus: status };
      tried.add(credential.ownerId);
    }
  }

  /** Handle a fully-read Messages request. `model`/`effort` already resolved by routing. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, json: AnthropicRequest, model: string, effort: string | undefined): Promise<ChatGptOutcome> {
    if (path.startsWith("/v1/messages/count_tokens")) {
      const body = JSON.stringify({ input_tokens: estimateTokens(json) });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) }).end(body);
      return { status: 200, bytes: body.length, note: "estimated" };
    }

    // Dropping a tool the model was meant to have is worth a line: the alternative to this drop is
    // an empty answer with nothing logged anywhere, which is what made it expensive to find.
    const serverTools = serverToolNames(json.tools);
    if (serverTools.size > 0) this.log.warn(`chatgpt ${this.name}: dropped server tools for ${model}: ${[...serverTools].join(", ")} (Anthropic runs these; this provider cannot)`);

    const upstreamReq = toResponsesRequest(json, {
      model,
      effort: effort ?? this.cfg.defaultEffort ?? "high",
      identity: this.cfg.identity ?? true,
      ...(this.cfg.instructionsAppend ? { instructionsAppend: this.cfg.instructionsAppend } : {}),
    });
    const body = JSON.stringify(upstreamReq);
    const cacheKey = upstreamReq.prompt_cache_key;
    // Input estimate for message_start: a conversation only grows, so the last measured total is a floor.
    const startInput = Math.max(estimateTokens(json), this.lastInputByKey.get(cacheKey) ?? 0);
    const ac = new AbortController();
    const onClose = (): void => ac.abort();
    res.on("close", onClose);

    // One account answers the turn. Which one is decided here, and a refusal before any byte has
    // reached the client moves the same turn to the next account, so the client is answered on its
    // first ask. The conversation stays on the account that answered: moving it costs the cache.
    const sent = await this.sendToAnAccount(cacheKey, body, ac.signal);
    if ("error" in sent) {
      res.off("close", onClose);
      if (sent.aborted) return { status: 0, bytes: 0, note: "client closed" };
      if (sent.thrown) {
        const err = anthropicError(502, "api_error", `ChatGPT backend unreachable: ${sent.thrown.message}`);
        if (!res.headersSent) res.writeHead(err.status, { "content-type": "application/json" }).end(err.body);
        throw sent.thrown; // let the proxy feed health with the connect error
      }
      const { status, body: errBody, retryAfterSeconds } = sent.error;
      if (this.cfg.debugDump && sent.upstreamStatus) this.dump(sent.upstreamStatus, json, upstreamReq, errBody);
      res.writeHead(status, { "content-type": "application/json", ...(retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {}) }).end(errBody);
      return { status, bytes: errBody.length, note: sent.note };
    }
    const { upstream, credential } = sent;

    if (this.cfg.debugDump === "all") this.dump(upstream.status, json, upstreamReq, "");
    const wantStream = json.stream === true;
    const mapper = new StreamMapper(model, startInput, toolNameRestoreMap(json));
    const parser = new SseParser();
    let bytes = 0;
    let ping: NodeJS.Timeout | null = null;

    if (wantStream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const ev of mapper.start()) bytes += write(res, formatSse(ev));
      ping = setInterval(() => {
        if (!res.writableEnded) bytes += write(res, formatSse({ event: "ping", data: { type: "ping" } }));
      }, PING_MS);
    }

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
          const outEvents = mapper.feed(ev);
          if (mapper.rateLimits && mapper.rateLimits !== this.rateLimitsByAccount.get(credential.ownerId)) this.noteRateLimits(credential, mapper.rateLimits);
          this.rememberInput(cacheKey, mapper.usage);
          if (wantStream) for (const o of outEvents) bytes += write(res, formatSse(o));
          if (mapper.isFinished) break;
        }
        if (mapper.isFinished) break;
      }
      if (!mapper.isFinished) {
        // Upstream ended without response.completed. This used to be finished as done-with-what-we-
        // have, which gave the client an empty or cut-off turn it accepted as final (gpt-6-astra,
        // 12 empty turns at a median 105s, 2026-09). Overloaded is what Claude Code retries.
        const tail = parser.sawDone
          ? mapper.finish()
          : mapper.fail(`${model}: upstream stream ended before the response completed`, "server_is_overloaded");
        if (wantStream) for (const o of tail) bytes += write(res, formatSse(o));
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        const tail = mapper.fail(`stream interrupted: ${(e as Error).message}`, "server_is_overloaded");
        if (wantStream) for (const o of tail) bytes += write(res, formatSse(o));
      }
    } finally {
      if (ping) clearInterval(ping);
      res.off("close", onClose);
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }

    const failure = mapper.failure;
    const failedStatus = failure?.type === "overloaded_error" ? 529 : failure?.type === "rate_limit_error" ? 429 : 502;
    if (!wantStream) {
      // A failed turn is an error here too, not a 200 carrying whatever arrived before it failed.
      const msg = failure ? anthropicError(failedStatus, failure.type, failure.message).body : JSON.stringify(mapper.message());
      res.writeHead(failure ? failedStatus : 200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(msg)) }).end(msg);
      bytes = msg.length;
    } else if (!res.writableEnded) {
      res.end();
    }
    const u = mapper.usage;
    return {
      // A stream has already sent 200; the record still says the turn failed.
      status: failure ? failedStatus : 200,
      bytes,
      note: failure
        ? `${wantStream ? "mid-stream " : ""}${failure.type}: ${failure.message} (in=${u.input_tokens} cached=${u.cache_read_input_tokens} out=${u.output_tokens})`
        : `in=${u.input_tokens} cached=${u.cache_read_input_tokens} out=${u.output_tokens} stop=${mapper.stopReason}`,
      usage: {
        input: u.input_tokens,
        cached: u.cache_read_input_tokens,
        ...(u.cache_creation_input_tokens > 0 ? { cacheWrite: u.cache_creation_input_tokens } : {}),
        output: u.output_tokens,
      },
      stopReason: mapper.stopReason,
    };
  }
}

function write(res: http.ServerResponse, s: string): number {
  if (res.writableEnded || res.destroyed) return 0;
  res.write(s);
  return s.length;
}
