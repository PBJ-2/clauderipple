// ChatGPT subscription adapter: serves an Anthropic Messages request by calling the
// Codex backend (OpenAI Responses over SSE) and streaming the translated answer back.

import http from "node:http";
import type { ChatGptProvider } from "../../config.ts";
import type { Logger } from "../../log.ts";
import { CredentialStore } from "./auth.ts";
import { SseParser } from "./sse.ts";
import { looksLikeAuth } from "../openai/index.ts";
import { StreamMapper, conversationKey, estimateTokens, formatSse, serverToolNames, toResponsesRequest, toolNameRestoreMap, type AnthropicRequest } from "./translate.ts";
import type { RequestUsage } from "../../requestlog.ts";
import { credentialHeaderValues, redactErrorText } from "../../redact.ts";
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../../config.ts";

export const DEFAULT_BASE = "https://chatgpt.com/backend-api";
const PING_MS = 15_000;

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

  /** Last measured total input (uncached + cached) per conversation, for the next message_start estimate. */
  private readonly lastInputByKey = new Map<string, number>();

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

    const upstreamHeaders = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${tokens.accessToken}`,
      "chatgpt-account-id": tokens.accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
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
