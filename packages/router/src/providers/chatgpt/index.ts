// ChatGPT subscription adapter: serves an Anthropic Messages request by calling the
// Codex backend (OpenAI Responses over SSE) and streaming the translated answer back.

import crypto from "node:crypto";
import http from "node:http";
import type { ChatGptProvider } from "../../config.ts";
import type { Logger } from "../../log.ts";
import { CredentialStore } from "./auth.ts";
import { SseParser } from "./sse.ts";
import { looksLikeAuth } from "../openai/index.ts";
import { StreamMapper, conversationKey, estimateTokens, formatSse, serverToolNames, toResponsesRequest, toolNameRestoreMap, type AnthropicRequest } from "./translate.ts";
import type { RequestUsage } from "../../requestlog.ts";
import type { SearchBackend, SearchHit, WebSearchQuery } from "../../websearch.ts";
import { credentialHeaderValues, redactErrorText } from "../../redact.ts";
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../../config.ts";

export const DEFAULT_BASE = "https://chatgpt.com/backend-api";
const PING_MS = 15_000;
/** Active quota lookup. Measured 2026-09-20: GET {base}/wham/usage → 200 JSON. The binary also
 * carries `/api/codex/usage`, but that path answers 403 here; `wham` is the one that works. */
const USAGE_PATH = "/wham/usage";
const USAGE_TIMEOUT_MS = 10_000;

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

export class ChatGptAdapter {
  readonly name: string;
  private readonly cfg: ChatGptProvider;
  private readonly creds: CredentialStore;
  private readonly log: Logger;
  lastRateLimits: Record<string, unknown> | null = null;

  constructor(name: string, cfg: ChatGptProvider, home: string, log: Logger) {
    this.name = name;
    this.cfg = cfg;
    this.log = log;
    this.creds = new CredentialStore(home, cfg.auth ?? "auto");
  }

  describeAuth(): string {
    return this.creds.describe();
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
    const tokens = await this.creds.get();
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
    const rateLimits = rateLimitsFromHeaders(res.headers);
    if (rateLimits) this.lastRateLimits = rateLimits;
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) this.creds.invalidate();
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
   * Never throws and never clears a good snapshot; returns the new one, or null on failure.
   */
  fetchRateLimits(): Promise<Record<string, unknown> | null> {
    if (this.rateLimitsInFlight) return this.rateLimitsInFlight;
    this.rateLimitsInFlight = this.fetchRateLimitsOnce().finally(() => {
      this.rateLimitsInFlight = null;
    });
    return this.rateLimitsInFlight;
  }

  private async fetchRateLimitsOnce(): Promise<Record<string, unknown> | null> {
    const tokens = await this.creds.get();
    if (tokens instanceof Error) {
      this.log.warn(`chatgpt ${this.name}: rate-limit fetch skipped: ${tokens.message}`);
      return null;
    }
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
      if (res.status === 401) this.creds.invalidate();
      this.log.warn(`chatgpt ${this.name}: rate-limit fetch HTTP ${res.status}`);
      return null;
    }
    const parsed = rateLimitsFromUsage(await res.json().catch(() => null));
    if (!parsed) {
      this.log.warn(`chatgpt ${this.name}: rate-limit fetch returned no primary window`);
      return null;
    }
    this.lastRateLimits = parsed;
    return parsed;
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

  /** Handle a fully-read Messages request. `model`/`effort` already resolved by routing. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, json: AnthropicRequest, model: string, effort: string | undefined): Promise<ChatGptOutcome> {
    if (path.startsWith("/v1/messages/count_tokens")) {
      const body = JSON.stringify({ input_tokens: estimateTokens(json) });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) }).end(body);
      return { status: 200, bytes: body.length, note: "estimated" };
    }

    const tokens = await this.creds.get();
    if (tokens instanceof Error) {
      const e = anthropicError(401, "authentication_error", tokens.message);
      res.writeHead(e.status, { "content-type": "application/json" }).end(e.body);
      return { status: e.status, bytes: e.body.length, note: "no credentials" };
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

    const turnState = this.turnStateByKey.get(cacheKey);
    const upstreamHeaders = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${tokens.accessToken}`,
      "chatgpt-account-id": tokens.accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      // The conversation's identity, as the Codex CLI states it. This is what the backend keys
      // the prompt cache on since mid-September 2026 (see `conversationId` in translate.ts).
      "session-id": cacheKey,
      "thread-id": cacheKey,
      "x-client-request-id": cacheKey,
      "x-codex-window-id": `${cacheKey}:0`,
      ...(turnState ? { "x-codex-turn-state": turnState } : {}),
    };
    const upstreamSecrets = credentialHeaderValues(Object.entries(upstreamHeaders));
    let upstream: Response;
    try {
      upstream = await fetch(`${(this.cfg.url ?? DEFAULT_BASE).replace(/\/$/, "")}/codex/responses`, {
        method: "POST",
        headers: upstreamHeaders,
        body,
        signal: ac.signal,
      });
    } catch (e) {
      res.off("close", onClose);
      if (ac.signal.aborted) return { status: 0, bytes: 0, note: "client closed" };
      const err = anthropicError(502, "api_error", `ChatGPT backend unreachable: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(err.status, { "content-type": "application/json" }).end(err.body);
      throw e; // let the proxy feed health with the connect error
    }

    const fromHeaders = rateLimitsFromHeaders(upstream.headers);
    if (fromHeaders) this.lastRateLimits = fromHeaders;
    const nextTurnState = upstream.headers.get("x-codex-turn-state");
    if (nextTurnState) {
      this.turnStateByKey.set(cacheKey, nextTurnState);
      if (this.turnStateByKey.size > 500) this.turnStateByKey.delete(this.turnStateByKey.keys().next().value!);
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      const safeText = redactErrorText(text, upstreamSecrets);
      if (upstream.status === 401) this.creds.invalidate();
      const err = mapHttpError(upstream.status, safeText);
      this.log.warn(`chatgpt ${this.name}: upstream ${upstream.status} for ${model}: ${safeText.slice(0, 400)}`);
      if (this.cfg.debugDump) this.dump(upstream.status, json, upstreamReq, safeText);
      res.off("close", onClose);
      res.writeHead(err.status, { "content-type": "application/json" }).end(err.body);
      return { status: err.status, bytes: err.body.length, note: `upstream ${upstream.status}` };
    }

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

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
          const outEvents = mapper.feed(ev);
          if (mapper.rateLimits) this.lastRateLimits = mapper.rateLimits;
          this.rememberInput(cacheKey, mapper.usage);
          if (wantStream) for (const o of outEvents) bytes += write(res, formatSse(o));
          if (mapper.isFinished) break;
        }
        if (mapper.isFinished) break;
      }
      if (!mapper.isFinished) {
        // Upstream ended without response.completed: treat as done with what we have.
        const tail = mapper.finish();
        if (wantStream) for (const o of tail) bytes += write(res, formatSse(o));
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        const tail = mapper.fail(`stream interrupted: ${(e as Error).message}`);
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

    if (!wantStream) {
      const msg = JSON.stringify(mapper.message());
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(msg)) }).end(msg);
      bytes = msg.length;
    } else if (!res.writableEnded) {
      res.end();
    }
    const u = mapper.usage;
    return {
      status: 200,
      bytes,
      note: `in=${u.input_tokens} cached=${u.cache_read_input_tokens} out=${u.output_tokens} stop=${mapper.stopReason}`,
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
