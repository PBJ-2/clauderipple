// ChatGPT subscription adapter: serves an Anthropic Messages request by calling the
// Codex backend (OpenAI Responses over SSE) and streaming the translated answer back.

import http from "node:http";
import type { ChatGptProvider } from "../../config.ts";
import type { Logger } from "../../log.ts";
import { CredentialStore } from "./auth.ts";
import { SseParser } from "./sse.ts";
import { StreamMapper, estimateTokens, formatSse, toResponsesRequest, type AnthropicRequest } from "./translate.ts";

export const DEFAULT_BASE = "https://chatgpt.com/backend-api";
const PING_MS = 15_000;

export type ChatGptOutcome = { status: number; bytes: number; note?: string };

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
  if (status === 401 || status === 403) return anthropicError(401, "authentication_error", `ChatGPT: ${msg}`);
  if (status === 429) return anthropicError(429, "rate_limit_error", `ChatGPT: ${msg}`);
  if (status >= 500) return anthropicError(529, "overloaded_error", `ChatGPT: ${msg}`);
  return anthropicError(400, "invalid_request_error", `ChatGPT: ${msg}`);
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

    const upstreamReq = toResponsesRequest(json, {
      model,
      effort: effort ?? this.cfg.defaultEffort ?? "high",
      identity: this.cfg.identity ?? true,
      ...(this.cfg.instructionsAppend ? { instructionsAppend: this.cfg.instructionsAppend } : {}),
    });
    const body = JSON.stringify(upstreamReq);
    const ac = new AbortController();
    const onClose = (): void => ac.abort();
    res.on("close", onClose);

    let upstream: Response;
    try {
      upstream = await fetch(`${(this.cfg.url ?? DEFAULT_BASE).replace(/\/$/, "")}/codex/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${tokens.accessToken}`,
          "chatgpt-account-id": tokens.accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: "codex_cli_rs",
        },
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

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      if (upstream.status === 401) this.creds.invalidate();
      const err = mapHttpError(upstream.status, text);
      res.off("close", onClose);
      res.writeHead(err.status, { "content-type": "application/json" }).end(err.body);
      return { status: err.status, bytes: err.body.length, note: `upstream ${upstream.status}` };
    }

    const wantStream = json.stream === true;
    const mapper = new StreamMapper(model);
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
    };
  }
}

function write(res: http.ServerResponse, s: string): number {
  if (res.writableEnded || res.destroyed) return 0;
  res.write(s);
  return s.length;
}
