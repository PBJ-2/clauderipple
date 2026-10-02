// Google Gemini adapter. Two backends, one translation:
//
//   auth "api-key"     AI Studio: Anthropic Messages in, Gemini `generateContent` (or its SSE stream)
//                      out, translated back. Key on `x-goog-api-key`.
//   auth "antigravity" Cloud Code Assist / Antigravity: a Google subscription OAuth token, the same
//                      Gemini body wrapped in the CCA envelope, several accounts rotating.
//
// The transport lives in transport.ts, the translation in translate.ts, the account store in
// accounts.ts, the sign-in in login.ts, and the CCA wire facts in antigravity.ts.
//
// The same reliability rules the other translated adapters follow apply here: the turn is retried
// with `fetchWithRetry` before any byte reaches the client, a stream that closes without Gemini
// saying it finished is an `overloaded_error` (§5 muse), and usage is reported only from what the
// vendor sent. The antigravity path picks the account the conversation is sticky to and moves to the
// next one only on a refusal that has not reached the client (§4 Credential pools).

import http from "node:http";
import type { GoogleProvider, ProviderModel } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { RequestUsage } from "../../requestlog.ts";
import { CredentialPool, retryAfterMs } from "../../pool.ts";
import { credentialHeaderValues, redactErrorText } from "../../redact.ts";
import { SseParser } from "../chatgpt/sse.ts";
import { fetchWithRetry } from "../retry.ts";
import { estimateTokens, formatSse, GoogleStreamMapper, toGeminiRequest, type GeminiRequest } from "./translate.ts";
import { createTransport, googleBaseUrl, resolveApiKey, type GoogleTransport } from "./transport.ts";
import { ThoughtSignatureStore } from "./thoughtSignatures.ts";
import { conversationKey, serverToolNames, toolNameRestoreMap, type AnthropicRequest } from "../chatgpt/translate.ts";
import { GoogleAccountPool, type GoogleAccountSummary, type GoogleCredential, type FetchLike } from "./accounts.ts";
import { fetchAvailableModels, staticAntigravityModels } from "./antigravity.ts";

const PING_MS = 15_000;
/** How long the CCA model list is reused before asking again. */
const MODELS_CACHE_MS = 60 * 60 * 1000;

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
 * check their request body for a key that was never the problem. Cloud Code Assist answers a refused
 * OAuth token with `UNAUTHENTICATED`/`PERMISSION_DENIED` in the same shape.
 */
export function googleLooksLikeAuth(status: number, text: string): boolean {
  if (status === 401) return true;
  if (/\b(API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|API key not valid|invalid api key)\b/i.test(text)) return true;
  return false;
}

/**
 * The wait a Google 429 asks for. Google APIs state it in the error body rather than a header — a
 * `google.rpc.RetryInfo` detail with `retryDelay: "<seconds>s"`
 * (https://cloud.google.com/apis/design/errors#error_details) — so an account would otherwise rest
 * for the pool's default whether the limit lifts in seconds or in hours.
 */
export function googleRetryDelayMs(text: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  return match ? Math.ceil(Number(match[1]) * 1000) : undefined;
}

/**
 * The page Google sends an account to when it wants the person behind it checked before Cloud
 * Code Assist will answer: a 403 `PERMISSION_DENIED` whose ErrorInfo reason is
 * `VALIDATION_REQUIRED`, with the page in `metadata.validation_url` (measured 2026-10-02 on a newly
 * signed-in account). A fresh token does not help — only the person finishing that page does — so
 * this is not read as a credential refusal. Only a Google accounts URL is passed on, because the
 * dashboard turns it into a link.
 */
export function googleValidationUrl(text: string): string | undefined {
  try {
    const details = (JSON.parse(text) as { error?: { details?: { reason?: string; metadata?: { validation_url?: unknown } }[] } }).error?.details ?? [];
    const url = details.find((d) => d.reason === "VALIDATION_REQUIRED")?.metadata?.validation_url;
    return typeof url === "string" && url.startsWith("https://accounts.google.com/") ? url : undefined;
  } catch {
    return undefined;
  }
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

/** One account as the dashboard shows it: who, whether it is in rotation, and why it is not. */
export type GoogleAccountStatus = GoogleAccountSummary & {
  state: "ready" | "cooling" | "quarantined" | "paused" | "needs-login" | "needs-verification";
  cooldownSeconds?: number;
  /** Google's page for finishing the check, while the account is `needs-verification`. */
  verifyUrl?: string;
  active: boolean;
};

/** How a send across the accounts ended. */
type SendResult =
  | { kind: "ok"; upstream: Response; credential: GoogleCredential }
  | { kind: "refused"; status: number; text: string; retryAfterSeconds?: number; verify?: { url: string; account: string } }
  | { kind: "all-resting"; backMs?: number }
  | { kind: "no-account" }
  | { kind: "unreachable"; error: Error }
  | { kind: "aborted" };

export class GoogleAdapter {
  readonly name: string;
  private readonly cfg: GoogleProvider;
  private readonly log: Logger;
  private readonly accounts: GoogleAccountPool;
  /** Cooldowns and conversation stickiness, shared with the proxy's other credential pools. */
  private readonly pool: CredentialPool;
  private readonly lastInputByKey = new Map<string, number>();
  /** Thought signatures keyed by the tool_use id we minted; survives across turns of one process. */
  private readonly thoughtSignatures = new ThoughtSignatureStore();
  /** The account that answered last, for the dashboard's "active" mark. */
  private activeOwner: string | null = null;
  /** Accounts Google wants checked, with its page for it; cleared when the account next answers. */
  private readonly verifyUrls = new Map<string, string>();
  private modelsCache: { at: number; models: ProviderModel[] } | null = null;
  private modelsInFlight: Promise<ProviderModel[] | null> | null = null;

  constructor(name: string, cfg: GoogleProvider, home: string, log: Logger, pool = new CredentialPool(), fetchImpl?: FetchLike) {
    this.name = name;
    this.cfg = cfg;
    this.log = log;
    this.pool = pool;
    this.accounts = new GoogleAccountPool({ home, log, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  describeAuth(): string {
    const all = this.accounts.summaries();
    const usable = this.accounts.peekCredentials().filter((c) => this.pool.hasUsable(this.name, [c])).length;
    return `accounts=${all.length} usable=${usable}`;
  }

  /** Whether any account could answer now, for the proxy's choice between this provider and a fallback. */
  hasUsable(): boolean {
    return this.pool.hasUsable(this.name, this.accounts.peekCredentials());
  }

  signedIn(): boolean {
    return this.accounts.signedIn();
  }

  /** Every account with its rotation state. Metadata only — no token leaves. */
  accountStatus(): GoogleAccountStatus[] {
    const credentials = this.accounts.peekCredentials();
    const reports = new Map(this.pool.report(this.name, credentials).map((r) => [r.id, r]));
    return this.accounts.summaries().map((summary) => {
      const credential = credentials.find((c) => c.ownerId === summary.id);
      const report = credential ? reports.get(credential.id) : undefined;
      const verifyUrl = this.verifyUrls.get(summary.id);
      const state: GoogleAccountStatus["state"] = summary.paused ? "paused" : !credential ? "needs-login" : verifyUrl ? "needs-verification" : report?.state ?? "ready";
      return {
        ...summary,
        state,
        ...(state === "needs-verification" && verifyUrl ? { verifyUrl } : {}),
        ...(report?.cooldownSeconds ? { cooldownSeconds: report.cooldownSeconds } : {}),
        active: summary.id === this.activeOwner,
      };
    });
  }

  /**
   * Ask Google again whether an account still needs its verification page (dashboard action). The
   * mark otherwise clears only when the account next answers a turn, so a person who had just
   * finished the page kept seeing "verification needed" until they sent something (2026-10-02).
   * One small turn on the provider's first model; only the status is read.
   */
  async recheckVerification(ownerId: string): Promise<"verified" | "still-required" | "unknown"> {
    const credential = (await this.accounts.credentials()).find((c) => c.ownerId === ownerId);
    if (!credential || !this.verifyUrls.has(ownerId)) return "unknown";
    const model = this.cfg.models?.[0]?.id ?? staticAntigravityModels()[0]!.id;
    const transport = createTransport("antigravity", this.cfg.url ? { url: this.cfg.url } : {});
    const built = transport.build(
      { contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 16 } },
      { model, stream: false, antigravity: { accessToken: credential.accessToken, projectId: credential.projectId, conversationKey: `recheck:${ownerId}` } },
    );
    try {
      const upstream = await fetch(built.url, { method: "POST", headers: built.headers, body: built.body, signal: AbortSignal.timeout(30_000) });
      const text = await upstream.text().catch(() => "");
      if (upstream.ok) {
        this.verifyUrls.delete(ownerId);
        return "verified";
      }
      const verifyUrl = upstream.status === 403 ? googleValidationUrl(text) : undefined;
      if (verifyUrl) {
        this.verifyUrls.set(ownerId, verifyUrl);
        return "still-required";
      }
      // Any other answer is not about verification; the next real turn sorts it out.
      this.log.info(`google ${this.name}: verification recheck of ${ownerId.slice(0, 8)} answered ${upstream.status}`);
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Put a cooling account back into rotation now (dashboard action). */
  clearCooldown(ownerId: string): void {
    for (const c of this.accounts.peekCredentials()) if (c.ownerId === ownerId) this.pool.clear(this.name, c.id);
  }

  /**
   * The models a signed-in Antigravity account can reach, from CCA's own `:fetchAvailableModels`,
   * falling back to the static list. Null when nothing is signed in. Never throws.
   */
  fetchModels(): Promise<ProviderModel[] | null> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODELS_CACHE_MS) return Promise.resolve(this.modelsCache.models);
    if (this.modelsInFlight) return this.modelsInFlight;
    this.modelsInFlight = this.fetchModelsOnce().then((models) => models ?? this.modelsCache?.models ?? null).finally(() => {
      this.modelsInFlight = null;
    });
    return this.modelsInFlight;
  }

  private async fetchModelsOnce(): Promise<ProviderModel[] | null> {
    const credential = await this.anyCredential();
    if (credential instanceof Error) return null;
    const models = await fetchAvailableModels(credential.accessToken, credential.projectId);
    if (!models) {
      this.log.warn(`google ${this.name}: fetchAvailableModels returned nothing; falling back to the static list`);
      return staticAntigravityModels();
    }
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  /** For side calls (models, project refresh) with no conversation: a usable account, else any. */
  private async anyCredential(): Promise<GoogleCredential | Error> {
    const all = await this.accounts.credentials();
    if (all.length === 0) return new Error("no Google account: run `clauderipple google-login`");
    return (this.pool.pick(this.name, all) as GoogleCredential | null) ?? all[0]!;
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

    // Dropping a tool the model was meant to have is worth a line: the alternative to this drop is an
    // empty answer with nothing logged anywhere.
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
      // The CCA path never adds the sentinel: the signature goes back on the exact functionCall the
      // model signed (or nothing at all), rather than a fabricated validator bypass.
      signatureSentinel: this.cfg.auth === "api-key",
    });

    const wantStream = json.stream === true;
    // The same input floor behavior as the other translated adapters: the CLI snapshots message_start
    // before usage arrives, so announce an estimate and correct it in message_delta.
    const key = conversationKey(json);
    const startInput = Math.max(estimateTokens(json), this.lastInputByKey.get(key) ?? 0);

    const transport = createTransport(this.cfg.auth, { ...(this.cfg.apiKey ? { apiKey: this.cfg.apiKey } : {}), ...(this.cfg.url ? { url: this.cfg.url } : {}) });

    if (this.cfg.auth === "antigravity") {
      return this.handleAntigravity(res, json, upstreamRequest, transport, model, useEffort, wantStream, key, startInput);
    }

    const apiKey = resolveApiKey(this.cfg.apiKey);
    if (!apiKey) {
      const out = anthropicError(401, "authentication_error", "Google provider: no API key; set apiKey or GEMINI_API_KEY");
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)) }).end(out.body);
      return { status: out.status, bytes: Buffer.byteLength(out.body), note: "no api key" };
    }

    let built;
    try {
      built = transport.build(upstreamRequest, { model, stream: wantStream });
    } catch (error) {
      const out = anthropicError(400, "invalid_request_error", (error as Error).message);
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)) }).end(out.body);
      return { status: out.status, bytes: Buffer.byteLength(out.body), note: (error as Error).message };
    }

    const upstreamSecrets = [apiKey, ...credentialHeaderValues(Object.entries(built.headers))];
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

    return this.streamBack(res, upstream, transport, json, model, wantStream, key, startInput, controller, onClose);
  }

  /**
   * One Antigravity turn: pick the conversation's account, send, and — before any byte reaches the
   * client — let a refusal the account caused move the turn to the next account. The account choice
   * and its failure handling mirror the ChatGPT pool (accounts.ts), because the cache cost of moving
   * a conversation off its account is the same (§4).
   */
  private async handleAntigravity(res: http.ServerResponse, json: AnthropicRequest, upstreamRequest: GeminiRequest, transport: GoogleTransport, model: string, effort: string | undefined, wantStream: boolean, key: string, startInput: number): Promise<GoogleOutcome> {
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    res.on("close", onClose);

    const sent = await this.sendToAnAccount({
      conversation: key,
      signal: controller.signal,
      build: (credential) => {
        const built = transport.build(upstreamRequest, {
          model,
          stream: wantStream,
          ...(effort ? { effort } : {}),
          antigravity: { accessToken: credential.accessToken, projectId: credential.projectId, conversationKey: key },
        });
        return { built, secrets: [credential.accessToken, ...credentialHeaderValues(Object.entries(built.headers))] };
      },
    });

    if (sent.kind !== "ok") {
      res.off("close", onClose);
      if (sent.kind === "aborted") return { status: 0, bytes: 0, note: "client closed" };
      if (sent.kind === "unreachable") {
        const err = anthropicError(502, "api_error", `Google provider unreachable: ${sent.error.message}`);
        if (!res.headersSent) res.writeHead(err.status, { "content-type": "application/json" }).end(err.body);
        throw sent.error; // let the proxy feed health with the connect error
      }
      let err: { status: number; body: string };
      let retryAfterSeconds: number | undefined;
      let note: string;
      if (sent.kind === "no-account") {
        err = anthropicError(401, "authentication_error", "no Google account: run `clauderipple google-login`");
        note = "no credentials";
      } else if (sent.kind === "all-resting") {
        const when = sent.backMs ? ` The first is usable again at ${new Date(Date.now() + sent.backMs).toLocaleTimeString()}.` : "";
        err = anthropicError(429, "rate_limit_error", `Google Antigravity: every signed-in account is at its limit.${when}`);
        if (sent.backMs) retryAfterSeconds = Math.ceil(sent.backMs / 1000);
        note = "all accounts resting";
      } else if (sent.verify) {
        // Said plainly, with the page: the vendor's own line ("Verify your account to continue.")
        // names neither the account nor where to go, and the URL sat past the cut of its body.
        err = anthropicError(403, "permission_error", `Google wants the account ${sent.verify.account} verified before Antigravity will answer for it. Open this page in a browser signed in to that account, finish Google's check, then try again: ${sent.verify.url}`);
        note = "upstream 403 verification required";
      } else {
        // A bare 403 here is a permission/region/policy problem, not a bad token (mapHttpError reads it).
        err = mapHttpError(sent.status, sent.text);
        retryAfterSeconds = sent.retryAfterSeconds;
        note = `upstream ${sent.status}`;
      }
      res.writeHead(err.status, { "content-type": "application/json", ...(retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {}) }).end(err.body);
      return { status: err.status, bytes: Buffer.byteLength(err.body), note };
    }

    return this.streamBack(res, sent.upstream, transport, json, model, wantStream, key, startInput, controller, onClose);
  }

  /** Stream (or buffer) an already-ok upstream response back to the client as Anthropic SSE. */
  private async streamBack(res: http.ServerResponse, upstream: Response, transport: GoogleTransport, json: AnthropicRequest, model: string, wantStream: boolean, key: string, startInput: number, controller: AbortController, onClose: () => void): Promise<GoogleOutcome> {
    const mapper = new GoogleStreamMapper(model, startInput, toolNameRestoreMap(json), (info) => {
      if (info.signature) this.thoughtSignatures.set(info.id, info.signature);
    });
    const parser = new SseParser();
    const reader = upstream.body!.getReader();
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

  /**
   * Send one Antigravity turn, moving to the next account while nothing has reached the client:
   *
   * - 401, or a 403 that reads as a credential refusal: one refresh of that account and a replay;
   *   refused again with a 401, the account is marked for sign-in.
   * - 429 and 402: the account rests until its stated reset (or a default), and the next takes over.
   * - Any other 403, 5xx, or no connection: a short rest, and the next account.
   * - Anything else is the request's fault; another account would refuse it the same way.
   *
   * Each account is tried at most once per turn (a refreshed token is the same account).
   */
  private async sendToAnAccount(spec: {
    conversation: string | undefined;
    signal: AbortSignal;
    build: (credential: GoogleCredential) => { built: { url: string; headers: Record<string, string>; body: string }; secrets: string[] };
  }): Promise<SendResult> {
    const tried = new Set<string>();
    const replayed = new Set<string>();
    const refreshed = new Set<string>();
    let last: Extract<SendResult, { kind: "refused" }> | null = null;
    let lastThrown: Error | null = null;
    for (;;) {
      const credential = await this.pickAccount(spec.conversation, tried);
      if (credential === "none") return { kind: "no-account" };
      if (credential === null) {
        if (last) return last;
        if (lastThrown) return { kind: "unreachable", error: lastThrown };
        const backMs = this.soonestBackMs();
        return { kind: "all-resting", ...(backMs ? { backMs } : {}) };
      }

      const { built, secrets } = spec.build(credential);
      let upstream: Response;
      try {
        // Retried on the same account, before any status or byte reaches the client, so a relay's
        // hiccup is absorbed inside the turn instead of arriving as an error to retry by hand.
        upstream = await fetchWithRetry(built.url, {
          method: "POST",
          headers: built.headers,
          body: built.body,
          signal: spec.signal,
        }, { log: (line) => this.log.info(`google ${this.name}: ${line}`) });
      } catch (e) {
        if (spec.signal.aborted) return { kind: "aborted" };
        this.pool.penalise(this.name, credential.id, 0);
        tried.add(credential.ownerId);
        lastThrown = e as Error;
        this.log.info(`google ${this.name}: account ${credential.ownerId.slice(0, 8)} unreachable (${(e as Error).message}); trying another`);
        continue;
      }

      if (upstream.ok && upstream.body) {
        this.pool.succeed(this.name, credential.id);
        this.verifyUrls.delete(credential.ownerId);
        this.activeOwner = credential.ownerId;
        return { kind: "ok", upstream, credential };
      }

      const text = await upstream.text().catch(() => "");
      const safeText = redactErrorText(text, secrets);
      const status = upstream.status;
      this.log.warn(`google ${this.name}: account ${credential.ownerId.slice(0, 8)} answered ${status}: ${safeText.slice(0, 400)}`);
      // Not a rest and not a refresh: the account works again the moment its person finishes
      // Google's page, so it stays in rotation and the next turn finds out.
      const verifyUrl = status === 403 ? googleValidationUrl(text) : undefined;
      if (verifyUrl) {
        this.verifyUrls.set(credential.ownerId, verifyUrl);
        const summary = this.accounts.summaries().find((s) => s.id === credential.ownerId);
        last = { kind: "refused", status, text: safeText, verify: { url: verifyUrl, account: summary?.email ?? summary?.label ?? credential.ownerId.slice(0, 8) } };
        tried.add(credential.ownerId);
        continue;
      }
      const credentialRefused = status === 401 || (status === 403 && googleLooksLikeAuth(status, text));

      if (credentialRefused) {
        if (!replayed.has(credential.ownerId)) {
          replayed.add(credential.ownerId);
          if (await this.accounts.forceRefresh(credential.ownerId)) {
            refreshed.add(credential.ownerId);
            this.log.info(`google ${this.name}: account ${credential.ownerId.slice(0, 8)} refreshed after ${status}; replaying`);
            continue;
          }
        } else if (refreshed.has(credential.ownerId) && status === 401) {
          // A token minted a moment ago and refused with a 401 anyway: the account itself is refused.
          this.accounts.reject(credential);
        }
      }

      const retryHeader = upstream.headers.get("retry-after");
      const waitMs = retryHeader ? retryAfterMs({ "retry-after": retryHeader }) : googleRetryDelayMs(text);
      const verdict = this.pool.penalise(this.name, credential.id, credentialRefused ? 403 : status, waitMs, text);
      last = { kind: "refused", status, text: safeText, ...(status === 429 && waitMs ? { retryAfterSeconds: Math.ceil(waitMs / 1000) } : {}) };
      if (!verdict.retryable) return last;
      tried.add(credential.ownerId);
    }
  }

  /** An account for one turn: the conversation's own while it is healthy, else the first usable one. */
  private async pickAccount(conversation: string | undefined, tried: ReadonlySet<string> = new Set()): Promise<GoogleCredential | "none" | null> {
    const all = await this.accounts.credentials();
    if (all.length === 0) return "none";
    const rest = all.filter((c) => !tried.has(c.ownerId));
    return this.pool.pick(this.name, rest, conversation) as GoogleCredential | null;
  }

  private soonestBackMs(): number | undefined {
    const reports = this.pool.report(this.name, this.accounts.peekCredentials());
    const cooling = reports.filter((r) => r.state === "cooling" && r.cooldownSeconds).map((r) => r.cooldownSeconds! * 1000);
    return cooling.length ? Math.min(...cooling) : undefined;
  }

  /** Convenience for tests and diagnostics. */
  get signatureCount(): number { return this.thoughtSignatures.size; }
}

/** The whole JSON body of a non-streaming response, as the one chunk the mapper reads. */
function parseWholeBody(text: string, transport: GoogleTransport): Record<string, unknown>[] {
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return [transport.unwrap(parsed)];
  } catch {
    return [];
  }
}

export { googleBaseUrl };
