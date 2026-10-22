// OpenAI-compatible adapter: Anthropic Messages in, vendor Chat Completions or
// Responses SSE out, translated back to Anthropic Messages. It never synthesizes
// cache figures; the request log reflects cached tokens only when the vendor sends them.

import http from "node:http";
import type { OpenAiCompatibleProvider, ProviderCredential } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { RequestUsage } from "../../requestlog.ts";
import { providerExhaustion, type ProviderExhaustion } from "../../health.ts";
import { retryAfterMs } from "../../pool.ts";
import { credentialHeaderValues, redactErrorText } from "../../redact.ts";
import { SseParser } from "../chatgpt/sse.ts";
import { fetchWithRetry } from "../retry.ts";
import { estimateTokens, formatSse, OpenAiStreamMapper, toOpenAiRequest, type ChatRequest, type ResponsesRequest } from "./translate.ts";
import { refusesReplayedReasoning } from "../../reasoning.ts";
import { PRESETS } from "../../presets.ts";
import { conversationKey, serverToolNames, toolNameRestoreMap } from "../chatgpt/translate.ts";
import type { AnthropicRequest } from "../chatgpt/translate.ts";

const PING_MS = 15_000;

export type OpenAiOutcome = { status: number; bytes: number; note?: string; usage?: RequestUsage; stopReason?: string; messageId?: string; servedTier?: string; exhaustion?: ProviderExhaustion | undefined; credentialId?: string; vendorRefusal?: OpenAiRefusal };
/**
 * The vendor's own account of a refusal, handed back with the outcome so the caller's terminal charge
 * can reach the same verdict as its mid-turn one: a 429's stated reset, and the body a 403's meaning
 * is read from. Both are the upstream's own text, already redacted by the time they are returned.
 *
 * `status` is the upstream's own status, which is not always the one the client was sent: this
 * adapter translates 402 to 400 for the client (mapHttpError), and the pool has to hear 402 or it
 * never classifies an out-of-credit key as `exhausted` (2026-10-22, the last key of a pool).
 */
export type OpenAiRefusal = { retryAfterMs?: number | undefined; body?: string; status?: number };

/**
 * The credential this turn uses, when the caller holds a pool. `next` offers the credential to try
 * after the upstream refused this one, before anything is written to the client; null ends the turn
 * with the provider's own answer. It may answer later (a vendor's reset time sometimes takes one
 * more request to learn), which is still before the first byte.
 */
export type OpenAiHandleOptions = {
  credential?: ProviderCredential;
  next?: (status: number, bodyText: string, headers: Record<string, string>) => ProviderCredential | null | Promise<ProviderCredential | null>;
};

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

function endpoint(base: string, wire: "chat" | "responses"): string {
  return `${base.replace(/\/+$/, "")}/${wire === "chat" ? "chat/completions" : "responses"}`;
}

/** The names a provider's headers may carry its key under; a credential supplies these instead. */
const AUTH_HEADERS = new Set(["authorization", "x-api-key"]);

/** A provider's headers without whatever authenticates it, so a key from the pool is the only one sent. */
function withoutAuth(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !AUTH_HEADERS.has(name.toLowerCase())));
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
  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, json: AnthropicRequest, model: string, effort: string | undefined, opts: OpenAiHandleOptions = {}): Promise<OpenAiOutcome> {
    if (path.startsWith("/v1/messages/count_tokens")) {
      const body = JSON.stringify({ input_tokens: estimateTokens(json) });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }).end(body);
      return { status: 200, bytes: Buffer.byteLength(body), note: "estimated" };
    }
    // The credential this attempt authenticates as. A pool hands it in per call rather than per
    // adapter, because one adapter serves every key of its provider and the pool owns which one is up.
    let credential = opts.credential;

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
      carried,
      log: (line) => this.log.info(`${this.tag} ${this.name}: ${line} (${model})`),
      ...(this.cfg.identity === undefined ? {} : { identity: this.cfg.identity }),
      ...(this.cfg.instructionsAppend ? { instructionsAppend: this.cfg.instructionsAppend } : {}),
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
    const headersNow = async (): Promise<Record<string, string>> => ({
      "content-type": "application/json",
      accept: "text/event-stream",
      ...sessionHeader,
      // The provider's own headers travel with every key — an organization id, a beta flag — but its
      // authentication does not: the credential's headers are the complete auth set (config.ts
      // ProviderCredential), so a leftover `authorization` beside it would be a key that is not in
      // rotation. With no credential configured, the provider's headers are the whole set, as before.
      ...(credential ? { ...withoutAuth(this.cfg.headers), ...credential.headers } : (this.cfg.headers ?? {})),
      ...(this.hooks.headers ? await this.hooks.headers(model) : {}),
    });
    let upstreamHeaders: Record<string, string> = {};
    // Every credential sent on any attempt: after a 401 retry the vendor's error may still echo the
    // first one.
    const upstreamSecrets = new Set<string>();
    const redact = (text: string): string => redactErrorText(text, [...upstreamSecrets], 2000);
    // Same input floor behavior as the ChatGPT adapter: the CLI snapshots message_start before usage arrives.
    const key = JSON.stringify({ model, wire, system: json.system ?? "", user: json.messages.find((message) => message.role === "user")?.content ?? "" });
    const startInput = Math.max(estimateTokens(json), this.lastInputByKey.get(key) ?? 0);
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
      // A 4xx that names reasoning is this vendor refusing the reasoning the conversation carried
      // back — a field it does not take, or a value from another model. The turn goes again without
      // it: replaying is an optimisation the user's turn must never depend on (reasoning.ts).
      if (carried.replayed > 0 && refusesReplayedReasoning(upstream.status, await upstream.clone().text().catch(() => ""))) {
        const refusal = await upstream.text().catch(() => "");
        this.log.warn(`${this.tag} ${this.name}: upstream ${upstream.status} refused ${carried.replayed} replayed reasoning turn(s) for ${model}; asking again without them: ${refusal.replace(/\s+/g, " ").slice(0, 200)}`);
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

    // A credential the vendor refused is replaced inside the same turn, while nothing has been
    // written to the client: after the first byte the turn is committed (ARCHITECTURE §4). The
    // caller's `next` is the judge of whether another credential could answer — a 400 is the
    // request's own fault and is not walked across the pool. A credential is tried once per turn.
    let failureText: string | null = null;
    const triedIds = new Set<string>(credential ? [credential.id] : []);
    while ((!upstream.ok || !upstream.body) && opts.next) {
      const text = await upstream.text().catch(() => "");
      const next = await opts.next(upstream.status, text, Object.fromEntries(upstream.headers));
      if (!next || triedIds.has(next.id)) {
        failureText = text;
        break;
      }
      triedIds.add(next.id);
      // Ids only, never a header value: this line goes to the log the user may share.
      this.log.info(`RETRY ${this.name}: ${credential?.id ?? "default"} answered ${upstream.status}, trying ${next.id}`);
      credential = next;
      upstream = await ask();
    }
    if (!upstream.ok || !upstream.body) {
      const text = failureText ?? await upstream.text().catch(() => "");
      // Re-serialised first, so an escaped credential in a JSON body is spelled out before it is matched.
      let plain = text;
      try { plain = JSON.stringify(JSON.parse(text)); } catch { /* not JSON: matched as it came */ }
      const safeText = redactErrorText(plain, [...upstreamSecrets]);
      const out = mapHttpError(upstream.status, text, label, this.hooks.authHint, redact);
      this.log.warn(`${this.tag} ${this.name}: upstream ${upstream.status} for ${model}: ${safeText.slice(0, 400)}`);
      const retryAfter = retryAfterMs(Object.fromEntries(upstream.headers));
      res.off("close", onClose);
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)) }).end(out.body);
      return {
        status: out.status,
        bytes: Buffer.byteLength(out.body),
        note: `upstream ${upstream.status}`,
        exhaustion: providerExhaustion(upstream.status, text, retryAfter),
        ...(credential ? { credentialId: credential.id } : {}),
        // The same facts the caller's own pool would have used: the refusal's own status, its
        // cooldown and what it said. `out.status` is the client's — a 402 reaches it as a 400 — so
        // the upstream's is carried here rather than re-derived from the answer. Redacted, because
        // this travels to a place that may be logged.
        vendorRefusal: { status: upstream.status, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}), ...(safeText ? { body: safeText } : {}) },
      };
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
      exhaustion: failure ? providerExhaustion(429, `${failure.code ?? ""} ${failure.message}`, retryAfterMs(Object.fromEntries(upstream.headers))) : undefined,
      bytes,
      note: failure
        ? `${wantStream ? "mid-stream " : ""}${failure.type}: ${failure.message} (in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens} replayed=${carried.replayed} reasoning=${mapper.reasoningCount})`
        : `in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens} stop=${mapper.stopReason} replayed=${carried.replayed} reasoning=${mapper.reasoningCount}`,
      usage: { input: usage.input_tokens, cached: usage.cache_read_input_tokens, output: usage.output_tokens },
      stopReason: mapper.stopReason,
      ...(wantStream || !failure ? { messageId: mapper.messageId } : {}),
      ...(mapper.servedTier !== undefined ? { servedTier: mapper.servedTier } : {}),
      ...(credential ? { credentialId: credential.id } : {}),
    };
  }
}
