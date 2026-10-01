// Google Gemini adapter (AI Studio / `auth: "api-key"`): Anthropic Messages in, Gemini
// `generateContent` (or its SSE stream) out, translated back to Anthropic Messages. The transport
// lives in transport.ts; the translation in translate.ts. This file is the I/O of one turn.
//
// The same reliability rules the other translated adapters follow apply here: the turn is retried
// with `fetchWithRetry` before any byte reaches the client, a stream that closes without Gemini
// saying it finished is an `overloaded_error` (§5 muse), and usage is reported only from what the
// vendor sent.

import http from "node:http";
import type { GoogleProvider } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { RequestUsage } from "../../requestlog.ts";
import { credentialHeaderValues, redactErrorText } from "../../redact.ts";
import { SseParser } from "../chatgpt/sse.ts";
import { fetchWithRetry } from "../retry.ts";
import { estimateTokens, formatSse, GoogleStreamMapper, toGeminiRequest, type GeminiRequest } from "./translate.ts";
import { createTransport, googleBaseUrl, resolveApiKey } from "./transport.ts";
import { ThoughtSignatureStore } from "./thoughtSignatures.ts";
import { conversationKey, serverToolNames, toolNameRestoreMap } from "../chatgpt/translate.ts";
import type { AnthropicRequest } from "../chatgpt/translate.ts";

const PING_MS = 15_000;

export type GoogleOutcome = { status: number; bytes: number; note?: string; usage?: RequestUsage; stopReason?: string };

function anthropicError(status: number, type: string, message: string): { status: number; body: string } {
  return { status, body: JSON.stringify({ type: "error", error: { type, message } }) };
}

/** The HTTP status Anthropic uses for each error type a mapper can report. */
function failureStatus(failure: { type: string } | undefined): number {
  return failure?.type === "overloaded_error" ? 529 : failure?.type === "rate_limit_error" ? 429 : failure?.type === "authentication_error" ? 401 : 502;
}

function vendorMessage(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown; status?: unknown }; message?: unknown };
    const message = json.error?.message ?? json.message;
    const status = json.error?.status;
    const detail = typeof message === "string" ? message : "";
    const suffix = typeof status === "string" ? ` (${status})` : "";
    if (detail || suffix) return `${detail}${suffix}`.slice(0, 500) || "upstream request failed";
  } catch { /* retain the response text */ }
  return text.replace(/\s+/g, " ").trim().slice(0, 500) || "upstream request failed";
}

/**
 * Google reports a bad key two ways: a 401/403, and a **400 whose body carries
 * `status: "API_KEY_INVALID"`** (the Generative Language API's own shape, and what the probe meets
 * for a wrong AI Studio key). Reading the 400 as a generic invalid request would send the user to
 * check their request body for a key that was never the problem.
 */
export function googleLooksLikeAuth(status: number, text: string): boolean {
  if (status === 401) return true;
  if (/\b(API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|API key not valid|invalid api key)\b/i.test(text)) return true;
  return false;
}

export function mapHttpError(status: number, text: string): { status: number; body: string } {
  const message = `Google provider: ${vendorMessage(text)}`;
  if (status === 429) return anthropicError(429, "rate_limit_error", message);
  if (googleLooksLikeAuth(status, text)) return anthropicError(401, "authentication_error", message);
  if (status === 403) return anthropicError(403, "permission_error", message);
  if (status >= 500) return anthropicError(529, "api_error", message);
  return anthropicError(400, "invalid_request_error", message);
}

function write(res: http.ServerResponse, value: string): number {
  if (res.writableEnded || res.destroyed) return 0;
  res.write(value);
  return Buffer.byteLength(value);
}

export class GoogleAdapter {
  readonly name: string;
  private readonly cfg: GoogleProvider;
  private readonly log: Logger;
  private readonly lastInputByKey = new Map<string, number>();
  /** Thought signatures keyed by the tool_use id we minted; survives across turns of one process. */
  private readonly thoughtSignatures = new ThoughtSignatureStore();

  constructor(name: string, cfg: GoogleProvider, log: Logger) {
    this.name = name;
    this.cfg = cfg;
    this.log = log;
  }

  private rememberInput(key: string, usage: { input_tokens: number; cache_read_input_tokens: number }): void {
    const total = usage.input_tokens + usage.cache_read_input_tokens;
    if (total <= 0) return;
    this.lastInputByKey.set(key, total);
    if (this.lastInputByKey.size > 500) this.lastInputByKey.delete(this.lastInputByKey.keys().next().value!);
  }

  /** Handle a fully-read Messages request. Model/effort have already been resolved by routing. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, json: AnthropicRequest, model: string, effort: string | undefined): Promise<GoogleOutcome> {
    if (path.startsWith("/v1/messages/count_tokens")) {
      const body = JSON.stringify({ input_tokens: estimateTokens(json) });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }).end(body);
      return { status: 200, bytes: Buffer.byteLength(body), note: "estimated" };
    }

    if (this.cfg.auth === "antigravity") {
      const out = anthropicError(400, "invalid_request_error", 'ClaudeRipple: the Google Antigravity (Cloud Code Assist) mode is not implemented yet; use auth "api-key" (AI Studio)');
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)) }).end(out.body);
      return { status: out.status, bytes: Buffer.byteLength(out.body), note: "antigravity not implemented" };
    }

    const apiKey = resolveApiKey(this.cfg.apiKey);
    if (!apiKey) {
      const out = anthropicError(401, "authentication_error", "Google provider: no API key; set apiKey or GEMINI_API_KEY");
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)) }).end(out.body);
      return { status: out.status, bytes: Buffer.byteLength(out.body), note: "no api key" };
    }

    // Dropping a tool the model was meant to have is worth a line: the alternative to this drop is
    // an empty answer with nothing logged anywhere.
    const serverTools = serverToolNames(json.tools);
    if (serverTools.size > 0) this.log.warn(`google ${this.name}: dropped server tools for ${model}: ${[...serverTools].join(", ")} (Anthropic runs these; this provider cannot)`);

    const effortLevels = this.cfg.models?.find((entry) => entry.id === model)?.effortLevels;
    const caps = effortLevels ? { effortLevels } : {};
    // A request that names no effort gets the provider's configured one, as the ChatGPT one does.
    const useEffort = effort ?? this.cfg.defaultEffort;
    const upstreamRequest: GeminiRequest = toGeminiRequest(json, {
      model,
      ...(useEffort ? { effort: useEffort } : {}),
      caps,
      ...(this.cfg.identity === undefined ? {} : { identity: this.cfg.identity }),
      ...(this.cfg.instructionsAppend ? { instructionsAppend: this.cfg.instructionsAppend } : {}),
      thoughtSignatures: this.thoughtSignatures,
      signatureSentinel: true,
    });

    const wantStream = json.stream === true;
    const transport = createTransport(this.cfg.auth, { ...(this.cfg.apiKey ? { apiKey: this.cfg.apiKey } : {}), ...(this.cfg.url ? { url: this.cfg.url } : {}) });
    let built;
    try {
      built = transport.build(upstreamRequest, { model, stream: wantStream });
    } catch (error) {
      const out = anthropicError(400, "invalid_request_error", (error as Error).message);
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)) }).end(out.body);
      return { status: out.status, bytes: Buffer.byteLength(out.body), note: (error as Error).message };
    }

    const upstreamSecrets = [apiKey, ...credentialHeaderValues(Object.entries(built.headers))];
    // The same input floor behavior as the other translated adapters: the CLI snapshots
    // message_start before usage arrives, so announce an estimate and correct it in message_delta.
    const key = JSON.stringify({ model, system: json.system ?? "", user: json.messages.find((message) => message.role === "user")?.content ?? "" });
    const startInput = Math.max(estimateTokens(json), this.lastInputByKey.get(key) ?? 0);
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    res.on("close", onClose);

    let upstream: Response;
    try {
      upstream = await fetchWithRetry(built.url, {
        method: "POST",
        headers: built.headers,
        body: built.body,
        signal: controller.signal,
      }, { log: (line) => this.log.info(`google ${this.name}: ${line}`) });
    } catch (error) {
      res.off("close", onClose);
      if (controller.signal.aborted) return { status: 0, bytes: 0, note: "client closed" };
      const out = anthropicError(502, "api_error", `Google provider unreachable: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(out.status, { "content-type": "application/json" }).end(out.body);
      throw error;
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      const safeText = redactErrorText(text, upstreamSecrets);
      const out = mapHttpError(upstream.status, safeText);
      this.log.warn(`google ${this.name}: upstream ${upstream.status} for ${model}: ${safeText.slice(0, 400)}`);
      res.off("close", onClose);
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)) }).end(out.body);
      return { status: out.status, bytes: Buffer.byteLength(out.body), note: `upstream ${upstream.status}` };
    }

    const mapper = new GoogleStreamMapper(model, startInput, toolNameRestoreMap(json), (info) => {
      if (info.signature) this.thoughtSignatures.set(info.id, info.signature);
    });
    const parser = new SseParser();
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let ping: NodeJS.Timeout | undefined;

    if (wantStream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const event of mapper.start()) bytes += write(res, formatSse(event));
      ping = setInterval(() => {
        if (!res.writableEnded) bytes += write(res, formatSse({ event: "ping", data: { type: "ping" } }));
      }, PING_MS);
    }

    try {
      if (wantStream) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const raw of parser.feed(decoder.decode(value, { stream: true }))) {
            const output = mapper.feed(transport.unwrap(raw) as never);
            this.rememberInput(key, mapper.usage);
            for (const anthropic of output) bytes += write(res, formatSse(anthropic));
            if (mapper.isFinished) break;
          }
          if (mapper.isFinished) break;
        }
      } else {
        // A non-streaming `generateContent` is one JSON object, so the body is gathered whole before
        // it is parsed — a `DecoderStream` of a JSON document is not a stream of documents.
        let whole = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          whole += decoder.decode(value, { stream: true });
        }
        whole += decoder.decode();
        for (const raw of parseWholeBody(whole, transport)) {
          mapper.feed(raw as never);
          this.rememberInput(key, mapper.usage);
        }
      }
      if (!mapper.isFinished) {
        // Only a vendor that said it was done is finished. A body that ends without a `finishReason`
        // is reported as overloaded so the client asks again, instead of taking a half answer as the
        // model's final one. Non-streaming writes no SSE here; the failure becomes the HTTP status below.
        const tail = mapper.completed || parser.sawDone
          ? mapper.finish()
          : mapper.fail(`${model}: upstream ended before the response completed`, "UNAVAILABLE");
        if (wantStream) for (const event of tail) bytes += write(res, formatSse(event));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const tail = mapper.fail(`stream interrupted: ${(error as Error).message}`, "UNAVAILABLE");
        if (wantStream) for (const event of tail) bytes += write(res, formatSse(event));
      }
    } finally {
      if (ping) clearInterval(ping);
      res.off("close", onClose);
      try { await reader.cancel(); } catch { /* already closed */ }
    }

    const failure = mapper.failure;
    const failedStatus = failureStatus(failure);
    if (!wantStream) {
      const body = failure ? anthropicError(failedStatus, failure.type, failure.message).body : JSON.stringify(mapper.message());
      bytes = Buffer.byteLength(body);
      res.writeHead(failure ? failedStatus : 200, { "content-type": "application/json", "content-length": String(bytes) }).end(body);
    } else if (!res.writableEnded) {
      res.end();
    }
    const usage = mapper.usage;
    return {
      status: failure ? failedStatus : 200,
      bytes,
      note: failure
        ? `${wantStream ? "mid-stream " : ""}${failure.type}: ${failure.message} (in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens})`
        : `in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens} stop=${mapper.stopReason}`,
      usage: { input: usage.input_tokens, cached: usage.cache_read_input_tokens, output: usage.output_tokens },
      stopReason: mapper.stopReason,
    };
  }

  /** Convenience for tests and diagnostics. */
  get signatureCount(): number { return this.thoughtSignatures.size; }
}

/** The whole JSON body of a non-streaming response, as the one chunk the mapper reads. */
function parseWholeBody(text: string, transport: { unwrap(raw: Record<string, unknown>): Record<string, unknown> }): Record<string, unknown>[] {
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return [transport.unwrap(parsed)];
  } catch {
    return [];
  }
}

export { googleBaseUrl };
