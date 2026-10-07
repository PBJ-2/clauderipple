// OpenAI-compatible adapter: Anthropic Messages in, vendor Chat Completions or
// Responses SSE out, translated back to Anthropic Messages. It never synthesizes
// cache figures; the request log reflects cached tokens only when the vendor sends them.

import http from "node:http";
import type { OpenAiCompatibleProvider } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { RequestUsage } from "../../requestlog.ts";
import { credentialHeaderValues, redactErrorText } from "../../redact.ts";
import { SseParser } from "../chatgpt/sse.ts";
import { fetchWithRetry } from "../retry.ts";
import { estimateTokens, formatSse, OpenAiStreamMapper, toOpenAiRequest } from "./translate.ts";
import { conversationKey, serverToolNames, toolNameRestoreMap } from "../chatgpt/translate.ts";
import type { AnthropicRequest } from "../chatgpt/translate.ts";

const PING_MS = 15_000;

export type OpenAiOutcome = { status: number; bytes: number; note?: string; usage?: RequestUsage; stopReason?: string };

function anthropicError(status: number, type: string, message: string): { status: number; body: string } {
  return { status, body: JSON.stringify({ type: "error", error: { type, message } }) };
}

/** The HTTP status Anthropic uses for each error type a mapper can report. */
function failureStatus(failure: { type: string } | undefined): number {
  return failure?.type === "overloaded_error" ? 529 : failure?.type === "rate_limit_error" ? 429 : 502;
}

function vendorMessage(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    // Most vendors nest the message; some (the Grok CLI proxy) send `{"error": "<message>"}`.
    const candidate = typeof json.error === "string" ? json.error : json.error?.message ?? json.message ?? json.detail;
    if (typeof candidate === "string") return candidate.slice(0, 500);
  } catch { /* retain the response text */ }
  return text.replace(/\s+/g, " ").trim().slice(0, 500) || "upstream request failed";
}

/** Whether a 403 body is about the credential rather than about what the account may do. */
export function looksLikeAuth(text: string): boolean {
  return /\b(api[_ -]?key|token|credential|unauthori[sz]ed|authentication|invalid[_ -]?key|expired)\b/i.test(text);
}

/**
 * `label` names the provider in the message the user reads; `authHint`, when given, is appended to an
 * authentication error to say what to do about it — a credential the user can fix in another tool is
 * only fixable if the error names the tool.
 */
export function mapHttpError(status: number, text: string, label = "OpenAI-compatible provider", authHint?: string): { status: number; body: string } {
  const message = `${label}: ${vendorMessage(text)}`;
  const authMessage = authHint ? `${message} — ${authHint}` : message;
  if (status === 401) return anthropicError(401, "authentication_error", authMessage);
  // A 403 is often not the credential at all: a data-sharing policy that needs opting into, a
  // region, a model the account may not use. Calling it an authentication error sends the user
  // back to check a key that was never the problem — which is most of an afternoon.
  if (status === 403) {
    return looksLikeAuth(text)
      ? anthropicError(401, "authentication_error", authMessage)
      : anthropicError(403, "permission_error", message);
  }
  if (status === 429) return anthropicError(429, "rate_limit_error", message);
  if (status >= 500) return anthropicError(529, "api_error", message);
  return anthropicError(400, "invalid_request_error", message);
}

function endpoint(base: string, wire: "chat" | "responses"): string {
  return `${base.replace(/\/+$/, "")}/${wire === "chat" ? "chat/completions" : "responses"}`;
}

function write(res: http.ServerResponse, value: string): number {
  if (res.writableEnded || res.destroyed) return 0;
  res.write(value);
  return Buffer.byteLength(value);
}

/**
 * What a provider built on this adapter can add without a translator of its own. All optional: the
 * openai-compatible provider uses none of them.
 */
export type OpenAiAdapterHooks = {
  /** Names the provider in errors the user reads. Default "OpenAI-compatible provider". */
  label?: string;
  /** Prefixes this adapter's log lines. Default "openai". */
  logTag?: string;
  /**
   * Headers resolved for each request, laid over the configured ones. For a credential that rotates
   * under the router (a CLI's session token), where a value fixed in the config would go stale.
   */
  headers?: (model: string) => Promise<Record<string, string>>;
  /**
   * Called once when the vendor answers 401, with the headers that were refused, before anything is
   * written to the client. Resolving true means the credential has changed since, and the request is
   * asked again with fresh headers; `fetchWithRetry` deliberately never retries a 401, because a
   * fixed key asked twice refuses twice.
   */
  unauthorized?: (model: string, sent: Record<string, string>) => Promise<boolean>;
  /** Appended to an authentication error the user reads. */
  authHint?: string;
};

export class OpenAiCompatibleAdapter {
  readonly name: string;
  private readonly cfg: OpenAiCompatibleProvider;
  private readonly log: Logger;
  private readonly hooks: OpenAiAdapterHooks;
  private readonly tag: string;
  private readonly lastInputByKey = new Map<string, number>();

  constructor(name: string, cfg: OpenAiCompatibleProvider, log: Logger, hooks: OpenAiAdapterHooks = {}) {
    this.name = name;
    this.cfg = cfg;
    this.log = log;
    this.hooks = hooks;
    this.tag = hooks.logTag ?? "openai";
  }

  private rememberInput(key: string, usage: { input_tokens: number; cache_read_input_tokens: number }): void {
    const total = usage.input_tokens + usage.cache_read_input_tokens;
    if (total <= 0) return;
    this.lastInputByKey.set(key, total);
    if (this.lastInputByKey.size > 500) this.lastInputByKey.delete(this.lastInputByKey.keys().next().value!);
  }

  /** Handle a fully-read Messages request. Model/effort have already been resolved by routing. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, json: AnthropicRequest, model: string, effort: string | undefined): Promise<OpenAiOutcome> {
    if (path.startsWith("/v1/messages/count_tokens")) {
      const body = JSON.stringify({ input_tokens: estimateTokens(json) });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }).end(body);
      return { status: 200, bytes: Buffer.byteLength(body), note: "estimated" };
    }

    const wire = this.cfg.wire ?? "chat";
    const modelEffortLevels = this.cfg.models?.find((entry) => entry.id === model)?.effortLevels;
    const caps = this.cfg.caps && modelEffortLevels === undefined
      ? this.cfg.caps
      : {
          ...(this.cfg.caps ?? {}),
          reasoning: modelEffortLevels && modelEffortLevels.length > 0 ? "effort" as const : "none" as const,
          effortLevels: modelEffortLevels ?? this.cfg.caps?.effortLevels ?? [],
        };
    // Dropping a tool the model was meant to have is worth a line: the alternative to this drop is
    // an empty answer with nothing logged anywhere.
    const serverTools = serverToolNames(json.tools);
    if (serverTools.size > 0) this.log.warn(`${this.tag} ${this.name}: dropped server tools for ${model}: ${[...serverTools].join(", ")} (Anthropic runs these; this provider cannot)`);

    const upstreamRequest = toOpenAiRequest(json, {
      model,
      wire,
      ...(effort ? { effort } : {}),
      caps,
      ...(this.cfg.identity === undefined ? {} : { identity: this.cfg.identity }),
      ...(this.cfg.instructionsAppend ? { instructionsAppend: this.cfg.instructionsAppend } : {}),
    });
    const requestBody = JSON.stringify(upstreamRequest);
    // Some vendors key their prompt cache on a session header rather than on the request's own
    // shape, and hand a cold cache to anyone who does not send one. `conversationKey` is the value
    // this codebase already trusts to be stable for one conversation and different between two.
    const sessionHeader = this.cfg.sessionHeader
      ? { [this.cfg.sessionHeader]: conversationKey(json) }
      : {};
    const label = this.hooks.label ?? "OpenAI-compatible provider";
    const headersNow = async (): Promise<Record<string, string>> => ({
      "content-type": "application/json",
      accept: "text/event-stream",
      ...sessionHeader,
      ...(this.cfg.headers ?? {}),
      ...(this.hooks.headers ? await this.hooks.headers(model) : {}),
    });
    let upstreamHeaders: Record<string, string> = {};
    let upstreamSecrets: string[] = [];
    // Same input floor behavior as the ChatGPT adapter: the CLI snapshots message_start before usage arrives.
    const key = JSON.stringify({ model, wire, system: json.system ?? "", user: json.messages.find((message) => message.role === "user")?.content ?? "" });
    const startInput = Math.max(estimateTokens(json), this.lastInputByKey.get(key) ?? 0);
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    res.on("close", onClose);

    const ask = async (): Promise<Response> => {
      upstreamHeaders = await headersNow();
      upstreamSecrets = credentialHeaderValues(Object.entries(upstreamHeaders));
      // Nothing has been written to the client yet, so a failure another attempt could answer is
      // asked again here rather than handed to the user as an error they would have to retry by
      // hand. Once this returns, the response is written straight through (see `fetchWithRetry`).
      return fetchWithRetry(endpoint(this.cfg.url, wire), {
        method: "POST",
        headers: upstreamHeaders,
        body: requestBody,
        signal: controller.signal,
      }, { log: (line) => this.log.info(`${this.tag} ${this.name}: ${line}`) });
    };

    let upstream: Response;
    try {
      upstream = await ask();
      // A credential that rotates under us can be refused for being the one we read a moment before
      // its owner replaced it. Still nothing written, so the turn can be asked once more.
      if (upstream.status === 401 && this.hooks.unauthorized) {
        const refusal = await upstream.text().catch(() => "");
        if (await this.hooks.unauthorized(model, upstreamHeaders)) {
          this.log.info(`${this.tag} ${this.name}: 401 for ${model}; credential changed, asking again`);
          upstream = await ask();
        } else {
          upstream = new Response(refusal, { status: 401 });
        }
      }
    } catch (error) {
      res.off("close", onClose);
      if (controller.signal.aborted) return { status: 0, bytes: 0, note: "client closed" };
      const out = anthropicError(502, "api_error", `${label} unreachable: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(out.status, { "content-type": "application/json" }).end(out.body);
      throw error;
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      const safeText = redactErrorText(text, upstreamSecrets);
      const out = mapHttpError(upstream.status, safeText, label, this.hooks.authHint);
      this.log.warn(`${this.tag} ${this.name}: upstream ${upstream.status} for ${model}: ${safeText.slice(0, 400)}`);
      res.off("close", onClose);
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)) }).end(out.body);
      return { status: out.status, bytes: Buffer.byteLength(out.body), note: `upstream ${upstream.status}` };
    }

    const wantStream = json.stream === true;
    const mapper = new OpenAiStreamMapper(model, startInput, toolNameRestoreMap(json));
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
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          const output = mapper.feed(event, wire);
          this.rememberInput(key, mapper.usage);
          if (wantStream) for (const anthropic of output) bytes += write(res, formatSse(anthropic));
          if (mapper.isFinished) break;
        }
        if (mapper.isFinished) break;
      }
      if (!mapper.isFinished) {
        // Only a vendor that said it was done is finished. A stream that just stopped — muse went
        // quiet for up to 300s and then closed, 2026-09-19 — is reported as overloaded so the
        // client asks again, instead of taking an empty turn as the model's final answer.
        const tail = mapper.completed || parser.sawDone
          ? mapper.finish()
          : mapper.fail(`${model}: upstream stream ended before the response completed`, "server_is_overloaded");
        if (wantStream) for (const event of tail) bytes += write(res, formatSse(event));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const tail = mapper.fail(`stream interrupted: ${(error as Error).message}`, "server_is_overloaded");
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
      // A failed turn is an error here too: answering it as a 200 with whatever content had
      // arrived is the same silent truncation the stream path used to commit.
      const body = failure ? anthropicError(failedStatus, failure.type, failure.message).body : JSON.stringify(mapper.message());
      bytes = Buffer.byteLength(body);
      res.writeHead(failure ? failedStatus : 200, { "content-type": "application/json", "content-length": String(bytes) }).end(body);
    } else if (!res.writableEnded) {
      res.end();
    }
    const usage = mapper.usage;
    return {
      // A stream has already sent 200; the record still says the turn failed.
      status: failure ? failedStatus : 200,
      bytes,
      note: failure
        ? `${wantStream ? "mid-stream " : ""}${failure.type}: ${failure.message} (in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens})`
        : `in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens} stop=${mapper.stopReason}`,
      usage: { input: usage.input_tokens, cached: usage.cache_read_input_tokens, output: usage.output_tokens },
      stopReason: mapper.stopReason,
    };
  }
}
