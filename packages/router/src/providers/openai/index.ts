// OpenAI-compatible adapter: Anthropic Messages in, vendor Chat Completions or
// Responses SSE out, translated back to Anthropic Messages. It never synthesizes
// cache figures; the request log reflects cached tokens only when the vendor sends them.

import http from "node:http";
import type { OpenAiCompatibleProvider } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { RequestUsage } from "../../requestlog.ts";
import { exhaustionHeaders, modelDeprecation, providerExhaustion, type ModelUnavailable, type ProviderExhaustion } from "../../health.ts";
import { retryAfterMs } from "../../pool.ts";
import { credentialHeaderValues, redactErrorText } from "../../redact.ts";
import { SseParser } from "../chatgpt/sse.ts";
import { fetchWithRetry } from "../retry.ts";
import { StartInputs } from "../start-input.ts";
import { estimateTokens, formatSse, OpenAiStreamMapper, toOpenAiRequest, type ChatRequest, type ResponsesRequest } from "./translate.ts";
import { refusesReplayedReasoning, requiresThinkingReplay } from "../../reasoning.ts";
import { PRESETS } from "../../presets.ts";
import { conversationKey, serverToolNames, toolNameRestoreMap } from "../chatgpt/translate.ts";
import type { AnthropicRequest } from "../chatgpt/translate.ts";
import { promptAdditions } from "../../identity.ts";
import type { RequestKind } from "../../routing.ts";

const PING_MS = 15_000;

export type OpenAiCredential = {
  headers: Record<string, string>;
  next?: (status: number, retryAfterMs: number | undefined, body: string) => Record<string, string> | null;
};

export type OpenAiOutcome = { upstreamStatus?: number; retryAfterMs?: number | undefined; errorBody?: string; status: number; bytes: number; note?: string; usage?: RequestUsage; stopReason?: string; messageId?: string; servedTier?: string; exhaustion?: ProviderExhaustion | undefined; modelUnavailable?: ModelUnavailable | undefined };

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
export function mapHttpError(status: number, text: string, label = "OpenAI-compatible provider", authHint?: string, redact: (message: string) => string = (message) => message): { status: number; body: string } {
  // Cleaned after decoding: a credential escaped inside the JSON (`\u0074ok…`) only reads as itself
  // once the string is parsed.
  const message = `${label}: ${redact(vendorMessage(text))}`;
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

/** Fixed block names only: even an unrecognised client-supplied type must not leak into the log. */
function assistantTurnShapes(json: AnthropicRequest): { turn: number; blocks: Record<string, number> }[] {
  const kinds = new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result", "image", "document", "server_tool_use", "tool_addition", "tool_removal"]);
  return json.messages.flatMap((message, turn) => {
    if (message.role !== "assistant") return [];
    const blocks: Record<string, number> = {};
    if (typeof message.content === "string") blocks.text = 1;
    else if (Array.isArray(message.content)) for (const block of message.content) {
      const kind = kinds.has(block.type) ? block.type : "unknown";
      blocks[kind] = (blocks[kind] ?? 0) + 1;
    }
    return [{ turn, blocks }];
  });
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
  /** `fetchWithRetry`'s attempt ceiling. Test seam; the default is its own. */
  attempts?: number;
};

export class OpenAiCompatibleAdapter {
  readonly name: string;
  private readonly cfg: OpenAiCompatibleProvider;
  private readonly log: Logger;
  private readonly hooks: OpenAiAdapterHooks;
  private readonly tag: string;
  private readonly startInputs = new StartInputs();

  constructor(name: string, cfg: OpenAiCompatibleProvider, log: Logger, hooks: OpenAiAdapterHooks = {}) {
    this.name = name;
    this.cfg = cfg;
    this.log = log;
    this.hooks = hooks;
    this.tag = hooks.logTag ?? "openai";
  }

  /** Handle a fully-read Messages request. Model/effort have already been resolved by routing. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, json: AnthropicRequest, model: string, effort: string | undefined, credential?: OpenAiCredential, options?: { kind?: RequestKind }): Promise<OpenAiOutcome> {
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

    // The conversation is the storage for a reasoning model's reasoning (reasoning.ts), so what to
    // replay is read out of the request itself and the tally is reported in the request log. `env`
    // names this provider and model: reasoning sealed by another model is never replayed here.
    const carried = { replayed: 0, undecodable: 0 };
    const translate = (replay = true): ChatRequest | ResponsesRequest => toOpenAiRequest(json, {
      model,
      wire,
      ...(effort ? { effort } : {}),
      caps,
      replay,
      env: { p: this.name, m: model },
      ...(PRESETS.find((entry) => entry.id === this.cfg.preset)?.sealedReasoning ? { sealedReasoning: true } : {}),
      ...(PRESETS.find((entry) => entry.id === this.cfg.preset)?.promptCacheKey ? { promptCacheKey: conversationKey(json) } : {}),
      carried,
      log: (line) => this.log.info(`${this.tag} ${this.name}: ${line} (${model})`),
      ...promptAdditions(options?.kind ?? "turn", this.cfg),
    });
    const upstreamRequest = translate();
    let requestBody = JSON.stringify(upstreamRequest);
    // Some vendors key their prompt cache on a session header rather than on the request's own
    // shape, and hand a cold cache to anyone who does not send one. `conversationKey` is the value
    // this codebase already trusts to be stable for one conversation and different between two.
    const sessionHeader = this.cfg.sessionHeader
      ? { [this.cfg.sessionHeader]: conversationKey(json) }
      : {};
    const label = this.hooks.label ?? "OpenAI-compatible provider";
    let credentialHeaders = credential?.headers;
    const headersNow = async (): Promise<Record<string, string>> => ({
      "content-type": "application/json",
      accept: "text/event-stream",
      ...sessionHeader,
      ...(credentialHeaders ?? this.cfg.headers ?? {}),
      ...(this.hooks.headers ? await this.hooks.headers(model) : {}),
    });
    let upstreamHeaders: Record<string, string> = {};
    // Every credential sent on any attempt: after a 401 retry the vendor's error may still echo the
    // first one.
    const upstreamSecrets = new Set<string>();
    const redact = (text: string): string => redactErrorText(text, [...upstreamSecrets], 2000);
    // Same input floor behavior as the ChatGPT adapter: the CLI snapshots message_start before usage arrives.
    const key = JSON.stringify({ model, wire, system: json.system ?? "", user: json.messages.find((message) => message.role === "user")?.content ?? "" });
    const startInput = this.startInputs.start(key, estimateTokens(json));
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    res.on("close", onClose);

    const ask = async (): Promise<Response> => {
      upstreamHeaders = await headersNow();
      for (const secret of credentialHeaderValues(Object.entries(upstreamHeaders))) upstreamSecrets.add(secret);
      // Nothing has been written to the client yet, so a failure another attempt could answer is
      // asked again here rather than handed to the user as an error they would have to retry by
      // hand. Once this returns, the response is written straight through (see `fetchWithRetry`).
      return fetchWithRetry(endpoint(this.cfg.url, wire), {
        method: "POST",
        headers: upstreamHeaders,
        body: requestBody,
        signal: controller.signal,
      }, { log: (line) => this.log.info(`${this.tag} ${this.name}: ${redact(line)}`), ...(this.hooks.attempts ? { attempts: this.hooks.attempts } : {}) });
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
      while (!upstream.ok && !res.headersSent && !controller.signal.aborted && credential?.next) {
        const text = await upstream.clone().text();
        if (requiresThinkingReplay(upstream.status, text)) break;
        const next = credential.next(upstream.status, retryAfterMs(Object.fromEntries(upstream.headers)), text);
        if (!next) break;
        await upstream.body?.cancel();
        credentialHeaders = next;
        upstream = await ask();
      }
      // A 4xx that names reasoning is this vendor refusing the reasoning the conversation carried
      // back — a field it does not take, or a value from another model. The turn goes again without
      // it: replaying is an optimisation the user's turn must never depend on (reasoning.ts).
      if (carried.replayed > 0 && upstream.status >= 400 && upstream.status < 500 && refusesReplayedReasoning(upstream.status, await upstream.clone().text().catch(() => ""))) {
        const refusal = await upstream.text().catch(() => "");
        this.log.warn(`${this.tag} ${this.name}: upstream ${upstream.status} refused ${carried.replayed} replayed reasoning turn(s) for ${model}; asking again without them: ${redact(refusal).replace(/\s+/g, " ").slice(0, 200)}`);
        carried.replayed = 0;
        carried.undecodable = 0;
        requestBody = JSON.stringify(translate(false));
        upstream = await ask();
      }
    } catch (error) {
      res.off("close", onClose);
      if (controller.signal.aborted) return { status: 0, bytes: 0, note: "client closed" };
      // fetch names an invalid header value in full, credential included; the message also reaches the
      // request log through whoever catches this.
      (error as Error).message = redact((error as Error).message);
      const out = anthropicError(502, "api_error", `${label} unreachable: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(out.status, { "content-type": "application/json" }).end(out.body);
      throw error;
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      // Re-serialised first, so an escaped credential in a JSON body is spelled out before it is matched.
      let plain = text;
      try { plain = JSON.stringify(JSON.parse(text)); } catch { /* not JSON: matched as it came */ }
      const safeText = redactErrorText(plain, [...upstreamSecrets]);
      const out = mapHttpError(upstream.status, text, label, this.hooks.authHint, redact);
      this.log.warn(`${this.tag} ${this.name}: upstream ${upstream.status} for ${model}: ${safeText.slice(0, 400)}`);
      res.off("close", onClose);
      // A definite exhaustion is answered as such: the client must not retry it (#89).
      const exhaustion = providerExhaustion(upstream.status, text, retryAfterMs(Object.fromEntries(upstream.headers)));
      const missingThinking = requiresThinkingReplay(upstream.status, text);
      if (missingThinking) this.log.warn(`${this.tag} ${this.name}: missing required thinking for ${model}; assistantTurns=${JSON.stringify(assistantTurnShapes(json))}`);
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)), ...(exhaustion ? exhaustionHeaders(exhaustion) : {}), ...(missingThinking ? { "x-should-retry": "false" } : {}) }).end(out.body);
      return { upstreamStatus: upstream.status, retryAfterMs: retryAfterMs(Object.fromEntries(upstream.headers)), errorBody: safeText, status: out.status, bytes: Buffer.byteLength(out.body), note: `upstream ${upstream.status}`, exhaustion, modelUnavailable: modelDeprecation(upstream.status, text) };
    }

    const wantStream = json.stream === true;
    const mapper = new OpenAiStreamMapper(model, startInput, toolNameRestoreMap(json), { p: this.name, m: model });
    mapper.wire = wire;
    mapper.redactError = redact;
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
          this.startInputs.note(key, mapper.usage);
          if (wantStream) for (const anthropic of output) bytes += write(res, formatSse(anthropic));
          if (mapper.isFinished) break;
        }
        // Chat's finish_reason can precede a usage-only chunk. Only [DONE] ends reads;
        // Responses finishes inside the mapper on its terminal event.
        if (wire === "chat" && parser.sawDone && !mapper.isFinished) {
          const tail = mapper.finish();
          if (wantStream) for (const event of tail) bytes += write(res, formatSse(event));
        }
        if (mapper.isFinished) break;
      }
      if (!mapper.isFinished && !controller.signal.aborted) {
        // Only a vendor that said it was done is finished. A stream that just stopped — muse went
        // quiet for up to 300s and then closed, 2026-09-19 — is reported as overloaded so the
        // client asks again, instead of taking an empty turn as the model's final answer.
        const tail = mapper.completed || (wire === "chat" && parser.sawDone)
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

    if (controller.signal.aborted) {
      const usage = mapper.usage;
      return { status: 0, bytes, note: "client closed", usage: { input: usage.input_tokens, cached: usage.cache_read_input_tokens, output: usage.output_tokens } };
    }

    const failure = mapper.failure;
    const failedStatus = failureStatus(failure);
    const exhaustion = failure ? providerExhaustion(429, `${failure.code ?? ""} ${failure.message}`, retryAfterMs(Object.fromEntries(upstream.headers))) : undefined;
    if (!wantStream) {
      // A failed turn is an error here too: answering it as a 200 with whatever content had
      // arrived is the same silent truncation the stream path used to commit.
      const body = failure ? anthropicError(failedStatus, failure.type, failure.message).body : JSON.stringify(mapper.message());
      bytes = Buffer.byteLength(body);
      res.writeHead(failure ? failedStatus : 200, { "content-type": "application/json", "content-length": String(bytes), ...(exhaustion && failedStatus === 429 ? exhaustionHeaders(exhaustion) : {}) }).end(body);
    } else if (!res.writableEnded) {
      res.end();
    }
    const usage = mapper.usage;
    return {
      // A stream has already sent 200; the record still says the turn failed.
      status: failure ? failedStatus : 200,
      exhaustion,
      bytes,
      note: failure
        ? `${wantStream ? "mid-stream " : ""}${failure.type}: ${failure.message} (in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens} replayed=${carried.replayed} reasoning=${mapper.reasoningCount})`
        : `in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens} stop=${mapper.stopReason} replayed=${carried.replayed} reasoning=${mapper.reasoningCount}`,
      usage: { input: usage.input_tokens, cached: usage.cache_read_input_tokens, output: usage.output_tokens },
      stopReason: mapper.stopReason,
      ...(wantStream || !failure ? { messageId: mapper.messageId } : {}),
      ...(mapper.servedTier !== undefined ? { servedTier: mapper.servedTier } : {}),
    };
  }
}
