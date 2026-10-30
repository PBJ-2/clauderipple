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
import { setTimeout as sleep } from "node:timers/promises";
import type { GoogleProvider, ProviderModel } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { RequestUsage } from "../../requestlog.ts";
import { exhaustionHeaders, modelDeprecation, providerExhaustion, type ModelUnavailable, type ProviderExhaustion } from "../../health.ts";
import { CredentialPool, retryAfterMs } from "../../pool.ts";
import { credentialHeaderValues, redactErrorText } from "../../redact.ts";
import { SseParser } from "../chatgpt/sse.ts";
import { fetchWithRetry } from "../retry.ts";
import { estimateTokens, formatSse, GoogleStreamMapper, toGeminiRequest, type GeminiRequest } from "./translate.ts";
import { antigravityBaseUrl, createTransport, credentialParts, googleBaseUrl, resolveApiKey, type GoogleTransport } from "./transport.ts";
import { ThoughtSignatureStore, type ThoughtSignatureSink } from "./thoughtSignatures.ts";
import { conversationKey, serverToolNames, toolNameRestoreMap, type AnthropicRequest } from "../chatgpt/translate.ts";
import { GoogleAccountPool, type GoogleAccountSummary, type GoogleCredential, type FetchLike } from "./accounts.ts";
import { fetchAvailableModels, hostForModel, resolveAntigravityWireModel, staticAntigravityModels, GOOGLE_OAUTH, type HostMap, type MergedCatalogue } from "./antigravity.ts";
import { antigravityQuotaScope, GoogleUsage, type QuotaGroup } from "./usage.ts";
import { ANTIGRAVITY_PROMPT_REFUSAL_MESSAGE, isAntigravityPromptRefusal } from "./prompt-refusal.ts";
import { promptAdditions } from "../../identity.ts";
import type { RequestKind } from "../../routing.ts";

const PING_MS = 15_000;
/** How long the CCA model list is reused before asking again. */
const MODELS_CACHE_MS = 60 * 60 * 1000;

export type GoogleOutcome = { upstreamStatus?: number; retryAfterMs?: number | undefined; errorBody?: string; status: number; bytes: number; note?: string; usage?: RequestUsage; stopReason?: string; messageId?: string; upstreamCalled?: false; refusal?: "no-account" | "prompt-incompatible"; exhaustion?: ProviderExhaustion | undefined; modelUnavailable?: ModelUnavailable | undefined } & (
  | { kind?: "response" }
  // No status or bytes have reached the client; the proxy may try one route fallback.
  | { kind: "prompt-incompatible"; status: 400; bytes: 0; errorBody: string }
  // Google has no capacity for the model (see `isModelCapacityExhausted`). Unwritten as above.
  | { kind: "model-capacity"; status: 529; bytes: 0; errorBody: string }
);

/**
 * The credential this turn goes out on (`Credential.headers` from the provider's pool), and how to
 * ask for the next one when the upstream refuses this one. The same handoff the OpenAI-compatible
 * adapter takes: the proxy owns the pool, and nothing has reached the client here yet, so another
 * key can still answer the first ask (#112).
 */
export type GoogleCredentialHandoff = {
  headers: Record<string, string>;
  next?: (status: number, retryAfterMs: number | undefined, body: string) => Record<string, string> | null;
};

/**
 * How often a turn asks again when Google says it has no capacity for the model, and how long it
 * waits first. A few slower asks rather than the ten-in-a-row ladder: each refusal took seconds to
 * arrive (41–103 s for ten on 2026-10-20), and capacity does not come back in 250 ms. Mutable only so
 * tests can shorten the waits.
 */
export const capacityRetry = { delaysMs: [3_000, 6_000] as number[] };

/**
 * Cloud Code Assist saying the **model** has no capacity on its servers — not the account, not its
 * quota. Measured 2026-10-20 on the daily host for `gemini-3.8-flash-high`: HTTP 503,
 * `{"error":{"code":503,"status":"UNAVAILABLE","message":"No capacity available for model … on the
 * server","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":
 * "MODEL_CAPACITY_EXHAUSTED","domain":"cloudcode-pa.googleapis.com","metadata":{"model":…,
 * "OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST":"true",…}}]}}`. Recognised by the ErrorInfo reason alone;
 * any other 503 keeps the ordinary transient handling.
 */
export function isModelCapacityExhausted(status: number, text: string): boolean {
  if (status !== 503) return false;
  try {
    const details = (JSON.parse(text) as { error?: { details?: unknown } } | null)?.error?.details;
    return Array.isArray(details) && details.some((d) => typeof d === "object" && d !== null && (d as { reason?: unknown }).reason === "MODEL_CAPACITY_EXHAUSTED");
  } catch {
    return false;
  }
}

/** Include escaped/folded spellings that a transport exception may echo. */
function redactGoogleError(text: string, secrets: readonly string[]): string {
  return redactErrorText(text, secrets.flatMap(secret => [
    secret, secret.replace(/\s+/g, " ").trim(), JSON.stringify(secret).slice(1, -1),
  ]), 2000);
}

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
 * Stricter than `googleLooksLikeAuth`, for walking an api-key pool on HTTP 400/403 only: the
 * structured error must name an auth reason, so a prompt that merely quotes one never rotates keys.
 */
export function googleKeyRejected(status: number, text: string): boolean {
  if (status !== 400 && status !== 403) return false;
  try {
    const error = (JSON.parse(text) as { error?: { status?: unknown; details?: { reason?: unknown }[] } } | null)?.error;
    const authReasons = new Set(["API_KEY_INVALID", "PERMISSION_DENIED", "UNAUTHENTICATED"]);
    return typeof error?.status === "string" && authReasons.has(error.status) ||
      Array.isArray(error?.details) && error.details.some(detail => typeof detail?.reason === "string" && authReasons.has(detail.reason));
  } catch {
    return false;
  }
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
 * Whether a 429 says one quota group of the account is spent, not the account: an ErrorInfo with
 * `reason: "QUOTA_EXHAUSTED"` naming a `metadata.model` in the same group as the turn's model.
 * Measured 2026-10-23 for claude-opus-5-5-low ("Individual quota reached … Resets in 4h51m35s",
 * `quotaResetDelay` beside it), while the account's Gemini group read 0.3% used. A 429 without that
 * proof (a per-minute limit, the generic RESOURCE_EXHAUSTED, a detail naming no model) is still read
 * as the whole account's.
 */
export function isGroupQuotaExhausted(status: number, text: string, scope: string): boolean {
  if (status !== 429) return false;
  try {
    const details = (JSON.parse(text) as { error?: { details?: unknown } } | null)?.error?.details;
    if (!Array.isArray(details)) return false;
    return details.some((d) => {
      const detail = d as { reason?: unknown; metadata?: { model?: unknown } } | null;
      const model = detail?.metadata?.model;
      return detail?.reason === "QUOTA_EXHAUSTED" && typeof model === "string" && antigravityQuotaScope(model) === scope;
    });
  } catch {
    return false;
  }
}

/**
 * The pool scope (pool.ts) a quota group rests in: the group on one Cloud Code Assist host, as
 * `3p@daily-cloudcode-pa.googleapis.com`. Each host counts its own quota (usage.ts reads them apart),
 * so a group spent on one host still answers on the other.
 */
export function antigravityScopeKey(group: string, host: string): string {
  return `${group}@${new URL(host).host}`;
}

/** The group's name in a refusal: what is spent, and what still answers. */
const GROUP_NAMES: Record<string, { spent: string; other: string }> = {
  "3p": { spent: "Claude/GPT", other: "Gemini" },
  gemini: { spent: "Gemini", other: "Claude/GPT" },
  argon: { spent: "Gemini 4 Argon", other: "other Gemini and Claude/GPT" },
};

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
  /**
   * Seconds until each resting quota group is usable again, keyed by group and host
   * (`antigravityScopeKey`, e.g. `3p@daily-cloudcode-pa.googleapis.com`), while the account itself
   * stays in rotation for the others. Absent when no group rests.
   */
  quotaCooldowns?: Record<string, number>;
  /** Google's page for finishing the check, while the account is `needs-verification`. */
  verifyUrl?: string;
  active: boolean;
  inUse: boolean;
};

/** How a send across the accounts ended. */
type SendResult =
  | { kind: "ok"; upstream: Response; credential: GoogleCredential }
  | { kind: "prompt-refused" }
  | { kind: "no-capacity"; text: string; asks: number }
  | { kind: "refused"; status: number; text: string; retryAfterSeconds?: number; verify?: { url: string; account: string }; group?: string }
  /** `group`: only that quota group rests everywhere; the accounts still answer the other one. */
  | { kind: "all-resting"; backMs?: number; group?: string }
  | { kind: "no-account" }
  | { kind: "unreachable"; error: Error }
  | { kind: "aborted" };

export class GoogleAdapter {
  readonly name: string;
  private readonly cfg: GoogleProvider;
  private readonly log: Logger;
  private readonly accounts: GoogleAccountPool;
  /** Per-account quota, for the status bar's limits row (`GET /api/limits`). */
  private readonly usage: GoogleUsage;
  /** Cooldowns and conversation stickiness, shared with the proxy's other credential pools. */
  private readonly pool: CredentialPool;
  private readonly lastInputByKey = new Map<string, number>();
  /** Thought signatures keyed by the tool_use id we minted; survives across turns of one process. */
  private readonly thoughtSignatures = new ThoughtSignatureStore();
  /** The account that answered last, for the dashboard's "active" mark. */
  private activeOwner: string | null = null;
  /** Accounts Google wants checked, with its page for it; cleared when the account next answers. */
  private readonly verifyUrls = new Map<string, string>();
  private modelsCache: { at: number; models: ProviderModel[]; hosts: HostMap } | null = null;
  private modelsInFlight: Promise<ProviderModel[] | null> | null = null;
  /** When the last listing attempt failed, so a turn does not retry an unreadable catalogue every time. */
  private modelsFailedAt = Number.NEGATIVE_INFINITY;
  /** The fetch the adapter's side calls use (model listing, and the account store); injectable for tests. */
  private readonly fetchImpl: FetchLike | undefined;

  constructor(name: string, cfg: GoogleProvider, home: string, log: Logger, pool = new CredentialPool(), fetchImpl?: FetchLike) {
    this.name = name;
    this.cfg = cfg;
    this.log = log;
    this.pool = pool;
    this.fetchImpl = fetchImpl;
    this.accounts = new GoogleAccountPool({ home, log, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    // Quota: each Cloud Code Assist host counts its own, so the limits row reads every host a
    // selected model lives on (resolved lazily from the cached model catalogue below).
    this.usage = new GoogleUsage(this.accounts, {
      baseUrl: antigravityBaseUrl(cfg.url),
      hosts: () => this.quotaHosts(),
      warn: (message) => log.warn(message),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }

  /**
   * The hosts whose quota the limits row must read: one per host that offers a model this provider
   * routes (the configured model list, or the discovered catalogue when it lists none). A pinned
   * `url` is the only host, because generation never leaves it.
   */
  private quotaHosts(): string[] {
    if (this.cfg.url) return [antigravityBaseUrl(this.cfg.url)];
    const hosts = this.modelsCache?.hosts;
    // Without a catalogue we cannot tell which host the models go to; read the default one only,
    // rather than showing an unused host's numbers.
    if (!hosts) return [GOOGLE_OAUTH.dailyApi];
    const models = this.cfg.models ?? [];
    // No configured model list means the provider routes whatever the client asks for; both hosts
    // are then in use in principle, so both quotas are read.
    if (models.length === 0) return [...GOOGLE_OAUTH.hosts];
    const fallback = antigravityBaseUrl(this.cfg.url);
    const used: string[] = [];
    for (const entry of models) {
      // The host the model is actually sent to, not every host that lists it: a shared model goes
      // to the preferred (daily) host, so only that host's quota is spent by this provider. The
      // default effort stands in for the configured model because the config carries no per-turn
      // effort; its tier's host is the representative one.
      const wire = resolveAntigravityWireModel(entry.id, this.cfg.defaultEffort).wire;
      const host = hostForModel(hosts, entry.id, wire, fallback);
      if (!used.includes(host)) used.push(host);
    }
    return used.length ? used : [GOOGLE_OAUTH.dailyApi];
  }

  describeAuth(): string {
    const all = this.accounts.summaries();
    const usable = this.accounts.peekCredentials().filter((c) => this.pool.hasUsable(this.name, [c])).length;
    return `accounts=${all.length} usable=${usable}`;
  }

  /**
   * Whether any account could answer now, for the proxy's choice between this provider and a fallback.
   * With a model, that model's quota group must have room on the account, on the host it goes to.
   */
  hasUsable(model?: string, effort?: string): boolean {
    return this.pool.hasUsable(this.name, this.accounts.peekCredentials(), model ? this.quotaScopeOf(model, effort) : undefined);
  }

  /**
   * The pool scope a turn for `model` rests in: its quota group on the host it would be sent to
   * (`antigravityScopeKey`). A `model@effort` id takes its effort from the suffix. Undefined for a
   * model outside the two groups.
   */
  quotaScopeOf(model: string, effort?: string): string | undefined {
    const at = model.lastIndexOf("@");
    const base = at > 0 ? model.slice(0, at) : model;
    const group = antigravityQuotaScope(base);
    if (!group) return undefined;
    return antigravityScopeKey(group, this.hostFor(base, (at > 0 ? model.slice(at + 1) : effort) ?? this.cfg.defaultEffort));
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
      const quotaCooldowns = credential ? this.pool.scopeCooldowns(this.name, credential.id) : {};
      return {
        ...summary,
        state,
        ...(state === "needs-verification" && verifyUrl ? { verifyUrl } : {}),
        ...(report?.cooldownSeconds ? { cooldownSeconds: report.cooldownSeconds } : {}),
        ...(Object.keys(quotaCooldowns).length ? { quotaCooldowns } : {}),
        active: summary.id === this.activeOwner,
        inUse: report?.inUse === true,
      };
    });
  }

  /**
   * Each account's quota groups by owner id, for the status bar's limits row. Never a token; a
   * failed lookup keeps that account's last good groups.
   */
  usageSnapshot(): Promise<Record<string, QuotaGroup[]>> {
    // Knowing which hosts hold the selected models needs the catalogue; a cold cache would read
    // daily only and show the wrong host's numbers. The listing is cached for an hour.
    return this.ensureHostMap().then(() => this.usage.snapshot());
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
      { model, stream: false, antigravity: { accessToken: credential.accessToken, projectId: credential.projectId, conversationKey: `recheck:${ownerId}` }, antigravityBaseUrl: this.hostFor(model, undefined) },
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
    this.pool.clear(this.name, ownerId);
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
    // No account is not a failed listing: a sign-in must take effect at once, not an hour later.
    if (credential instanceof Error) return null;
    // Both Cloud Code Assist hosts are asked; one host failing must not hide the other's models.
    const hosts = this.cfg.url ? [antigravityBaseUrl(this.cfg.url)] : GOOGLE_OAUTH.hosts;
    const catalogue: MergedCatalogue | null = await fetchAvailableModels(credential.accessToken, credential.projectId, {
      hosts,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      // The IDE list still answers, so without this line Gemini 4 Argon just goes missing.
      cliFailed: (host, reason) => this.log.warn(`google ${this.name}: CLI model list on ${host} failed (${reason}); models served only to the CLI client, such as Gemini 4 Argon, are left out`),
    });
    if (!catalogue) {
      this.log.warn(`google ${this.name}: fetchAvailableModels returned nothing; falling back to the static list`);
      // A cold host is not asked again on every turn while it is unreadable.
      this.modelsFailedAt = Date.now();
      return staticAntigravityModels();
    }
    this.modelsCache = { at: Date.now(), models: catalogue.models, hosts: catalogue.hosts };
    if (catalogue.byHost.size < hosts.length) {
      const answered = [...catalogue.byHost.keys()].map((h) => new URL(h).host);
      const missing = hosts.filter((h) => !catalogue.byHost.has(h)).map((h) => new URL(h).host);
      this.log.warn(`google ${this.name}: fetchAvailableModels answered on ${answered.join(", ")}; ${missing.join(", ")} failed, its models are hidden`);
    }
    return catalogue.models;
  }

  /**
   * Make sure the host map is loaded, within the same hour-long cache as `fetchModels`. A listing
   * that just failed is not retried on every turn; the default host is used meanwhile.
   */
  private async ensureHostMap(): Promise<void> {
    if (this.modelsCache || this.cfg.url) return;
    if (!this.accounts.signedIn()) return;
    if (Date.now() - this.modelsFailedAt < MODELS_CACHE_MS) return;
    await this.fetchModels();
  }

  /**
   * The host a turn for `model` must go to: the one that offers its resolved wire id, preferring
   * daily when both do, else the provider's default. Unknown models and an unread catalogue fall
   * back to the default, exactly as before the second host existed.
   */
  private hostFor(model: string, effort: string | undefined): string {
    const fallback = antigravityBaseUrl(this.cfg.url);
    if (this.cfg.url || !this.modelsCache) return fallback;
    const wire = resolveAntigravityWireModel(model, effort).wire;
    return hostForModel(this.modelsCache.hosts, model, wire, fallback);
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
  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, json: AnthropicRequest, model: string, effort: string | undefined, credential?: GoogleCredentialHandoff, options?: { kind?: RequestKind }): Promise<GoogleOutcome> {
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
    // A model that only one CCA host offers must be sent there. The catalogue is the only source of
    // that routing, so a cold cache (first turn after a restart) is filled before the turn is built.
    // It is a no-op within the hour after that, and a failure silently keeps the default host.
    if (this.cfg.auth === "antigravity") await this.ensureHostMap();
    const host = this.cfg.auth === "antigravity" ? this.hostFor(model, useEffort) : undefined;
    // Thought signatures are per host: CCA runs its state separately on each, and replaying one
    // host's signature to the other is refused (see thoughtSignatures.ts). The API-key path keeps
    // the unscoped store.
    const signatures: ThoughtSignatureSink = host ? this.thoughtSignatures.scope(host) : this.thoughtSignatures;
    const upstreamRequest: GeminiRequest = toGeminiRequest(json, {
      model,
      ...(useEffort ? { effort: useEffort } : {}),
      caps,
      ...promptAdditions(options?.kind ?? "turn", this.cfg),
      thoughtSignatures: signatures,
      // The CCA path never adds the sentinel: the signature goes back on the exact functionCall the
      // model signed (or nothing at all), rather than a fabricated validator bypass.
      signatureSentinel: this.cfg.auth === "api-key",
    });

    const wantStream = json.stream === true;
    // The same input floor behavior as the other translated adapters: the CLI snapshots message_start
    // before usage arrives, so announce an estimate and correct it in message_delta.
    const key = conversationKey(json);
    const startInput = Math.max(estimateTokens(json), this.lastInputByKey.get(key) ?? 0);

    const transport = createTransport(this.cfg.auth, {
      ...(this.cfg.apiKey ? { apiKey: this.cfg.apiKey } : {}),
      ...(this.cfg.url ? { url: this.cfg.url } : {}),
      ...(this.cfg.sessionHeader ? { sessionHeader: this.cfg.sessionHeader } : {}),
      ...(this.cfg.headers ? { headers: this.cfg.headers } : {}),
    });

    if (this.cfg.auth === "antigravity") {
      return this.handleAntigravity(res, json, upstreamRequest, transport, model, useEffort, wantStream, key, startInput, host!, signatures);
    }

    // The key this attempt goes out on: the pool's own when the proxy chose one, else the provider's
    // (`apiKey`, or the environment). A single-key provider declares no key on its credential, so this
    // is exactly the key it always sent.
    let credentialHeaders = credential?.headers;
    const pooled = !!this.cfg.credentials?.length || Object.keys(credentialHeaders ?? {}).length > 0;
    const providerApiKey = resolveApiKey(this.cfg.apiKey);
    const firstKey = credentialParts(credentialHeaders).apiKey ?? providerApiKey;
    if (!firstKey) {
      const out = anthropicError(401, "authentication_error", "Google provider: no API key; set apiKey or GEMINI_API_KEY");
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)) }).end(out.body);
      return { status: out.status, bytes: Buffer.byteLength(out.body), note: "no api key", upstreamCalled: false, refusal: "no-account" };
    }

    // One attempt's wire, rebuilt per credential because moving to another key moves the key header
    // with it. Never throws for a missing key: `firstKey` above proves `apiKey` answers if this
    // credential states none.
    const attempt = (headers: Record<string, string> | undefined): { built: { url: string; headers: Record<string, string>; body: string }; secrets: string[] } => {
      const parts = credentialParts(headers);
      const apiKey = parts.apiKey ?? providerApiKey;
      const wire = createTransport("api-key", {
        pooled,
        ...(apiKey ? { apiKey } : {}),
        ...(this.cfg.url ? { url: this.cfg.url } : {}),
        ...(this.cfg.sessionHeader ? { sessionHeader: this.cfg.sessionHeader } : {}),
        // Only explicit pool credentials replace base authentication. The implicit single-key
        // path keeps the provider's headers byte-for-byte, including its auth conventions.
        headers: pooled
          ? Object.fromEntries([
              ...Object.entries(this.cfg.headers ?? {}).filter(([name]) => !/^(authorization|x-api-key|x-goog-api-key)$/i.test(name)),
              ...Object.entries(parts.headers),
            ].map(([name, value]) => [name.toLowerCase(), value]))
          : this.cfg.headers ?? {},
      });
      const built = wire.build(upstreamRequest, { model, stream: wantStream, conversationKey: key });
      return { built, secrets: [...(apiKey ? [apiKey] : []), ...credentialHeaderValues(Object.entries(built.headers))] };
    };

    // Every credential sent on any attempt: after a retry the vendor's error may still echo the
    // first one.
    const upstreamSecrets = [
      ...(providerApiKey ? [providerApiKey] : []),
      ...credentialHeaderValues(Object.entries(this.cfg.headers ?? {})),
      ...Object.entries(this.cfg.headers ?? {}).filter(([name]) => /^x-goog-api-key$/i.test(name)).map(([, value]) => value),
    ];
    // Header-parser exceptions may quote escaped bytes or fold whitespace before echoing a key.
    // Supply those spellings to the shared redactor rather than maintaining another redactor here.
    const redact = (text: string): string => redactGoogleError(text, upstreamSecrets);
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    res.on("close", onClose);

    let upstream: Response;
    try {
      for (;;) {
        const { built, secrets } = attempt(credentialHeaders);
        for (const secret of secrets) if (!upstreamSecrets.includes(secret)) upstreamSecrets.push(secret);
        upstream = await fetchWithRetry(built.url, {
          method: "POST",
          headers: built.headers,
          body: built.body,
          signal: controller.signal,
        }, { log: (line) => this.log.info(`google ${this.name}: ${redact(line)}`) });
        // Nothing has been written to the client, so a refusal another key could answer is asked
        // again here rather than handed to the user as a 429 they would have to retry by hand. The
        // proxy decides which key is next and charges the refusal to the one that answered (§4
        // Credential pools); an answer that is the request's own fault is never retried.
        if (upstream.ok || !upstream.body || res.headersSent || controller.signal.aborted || !credential?.next) break;
        const text = await upstream.clone().text().catch(() => "");
        const next = credential.next(upstream.status, retryAfterMs(Object.fromEntries(upstream.headers)) ?? googleRetryDelayMs(text), text);
        if (!next) break;
        await upstream.body.cancel().catch(() => { /* already closed */ });
        credentialHeaders = next;
      }
    } catch (error) {
      res.off("close", onClose);
      if (controller.signal.aborted) return { status: 0, bytes: 0, note: "client closed" };
      (error as Error).message = redact((error as Error).message);
      const out = anthropicError(502, "api_error", `Google provider unreachable: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(out.status, { "content-type": "application/json" }).end(out.body);
      throw error;
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      const safeText = redact(text);
      const out = mapHttpError(upstream.status, safeText);
      this.log.warn(`google ${this.name}: upstream ${upstream.status} for ${model}: ${safeText.slice(0, 400)}`);
      res.off("close", onClose);
      // A spending cap or a used-up quota: the client is told not to retry, in the same answer.
      const exhaustion = providerExhaustion(upstream.status, text, retryAfterMs(Object.fromEntries(upstream.headers)) ?? googleRetryDelayMs(text));
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)), ...(exhaustion ? exhaustionHeaders(exhaustion) : {}) }).end(out.body);
      return { upstreamStatus: upstream.status, retryAfterMs: retryAfterMs(Object.fromEntries(upstream.headers)) ?? googleRetryDelayMs(text), errorBody: text,
        status: out.status, bytes: Buffer.byteLength(out.body), note: `upstream ${upstream.status}`, exhaustion, modelUnavailable: modelDeprecation(upstream.status, text) };
    }

    return this.streamBack(res, upstream, transport, json, model, wantStream, key, startInput, controller, onClose, this.thoughtSignatures, redact);
  }

  /**
   * One Antigravity turn: pick the conversation's account, send, and — before any byte reaches the
   * client — let a refusal the account caused move the turn to the next account. The account choice
   * and its failure handling mirror the ChatGPT pool (accounts.ts), because the cache cost of moving
   * a conversation off its account is the same (§4).
   */
  private async handleAntigravity(res: http.ServerResponse, json: AnthropicRequest, upstreamRequest: GeminiRequest, transport: GoogleTransport, model: string, effort: string | undefined, wantStream: boolean, key: string, startInput: number, host: string, signatures: ThoughtSignatureSink): Promise<GoogleOutcome> {
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    res.on("close", onClose);

    const upstreamSecrets = new Set<string>();
    const redact = (text: string): string => redactGoogleError(text, [...upstreamSecrets]);
    const sent = await this.sendToAnAccount({
      conversation: key,
      redact,
      signal: controller.signal,
      system: upstreamRequest.systemInstruction,
      model,
      host,
      build: (credential) => {
        const built = transport.build(upstreamRequest, {
          model,
          stream: wantStream,
          ...(effort ? { effort } : {}),
          antigravity: { accessToken: credential.accessToken, projectId: credential.projectId, conversationKey: key },
          antigravityBaseUrl: host,
        });
        const secrets = [credential.accessToken, ...credentialHeaderValues(Object.entries(built.headers))];
        for (const secret of secrets) upstreamSecrets.add(secret);
        return { built };
      },
    });

    if (sent.kind !== "ok") {
      res.off("close", onClose);
      if (sent.kind === "aborted") return { status: 0, bytes: 0, note: "client closed" };
      if (sent.kind === "prompt-refused") {
        const err = anthropicError(400, "invalid_request_error", ANTIGRAVITY_PROMPT_REFUSAL_MESSAGE);
        return { kind: "prompt-incompatible", status: 400, bytes: 0, errorBody: err.body,
          note: "upstream 429: suspected Antigravity SDK prompt refusal with remaining quota", refusal: "prompt-incompatible" };
      }
      if (sent.kind === "no-capacity") {
        // Overloaded, so Claude Code asks again on its own when no fallback takes the turn.
        const err = anthropicError(529, "overloaded_error", `Google provider: ${vendorMessage(sent.text)} — Google is out of capacity for this model (MODEL_CAPACITY_EXHAUSTED), asked ${sent.asks} times. This is Google's server capacity, not your account or its quota; try again shortly, or give the route a fallback.`);
        return { kind: "model-capacity", status: 529, bytes: 0, errorBody: err.body,
          note: `upstream 503 MODEL_CAPACITY_EXHAUSTED after ${sent.asks} asks; account not rested` };
      }
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
        const names = sent.group ? GROUP_NAMES[sent.group] : undefined;
        err = anthropicError(429, "rate_limit_error", names
          ? `Google Antigravity: the ${names.spent} quota is spent on every signed-in account; ${names.other} models still answer.${when}`
          : `Google Antigravity: every signed-in account is at its limit.${when}`);
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
      // A spent quota group is not the provider's exhaustion: the pool rests that group on the account
      // and the mod reads it from there (admin.ts), so the provider's other models stay in the ladder.
      const exhaustion = sent.kind === "refused" && !sent.group
        ? providerExhaustion(sent.status, sent.text, sent.retryAfterSeconds === undefined ? undefined : sent.retryAfterSeconds * 1000)
        : undefined;
      res.writeHead(err.status, { "content-type": "application/json", ...(retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {}), ...(exhaustion ? exhaustionHeaders(exhaustion) : {}) }).end(err.body);
      return { status: err.status, bytes: Buffer.byteLength(err.body), note,
        ...(sent.kind === "no-account" ? { upstreamCalled: false as const, refusal: "no-account" as const } : {}),
        ...(exhaustion ? { exhaustion } : {}),
        ...(sent.kind === "refused" ? { modelUnavailable: modelDeprecation(sent.status, sent.text) } : {}),
      };
    }

    return this.streamBack(res, sent.upstream, transport, json, model, wantStream, key, startInput, controller, onClose, signatures, redact);
  }

  /** Stream (or buffer) an already-ok upstream response back to the client as Anthropic SSE. */
  private async streamBack(res: http.ServerResponse, upstream: Response, transport: GoogleTransport, json: AnthropicRequest, model: string, wantStream: boolean, key: string, startInput: number, controller: AbortController, onClose: () => void, signatures: ThoughtSignatureSink, redact: (text: string) => string): Promise<GoogleOutcome> {
    const mapper = new GoogleStreamMapper(model, startInput, toolNameRestoreMap(json), (info) => {
      if (info.signature) signatures.set(info.id, info.signature);
    });
    mapper.redactError = redact;
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
    const exhaustion = failure ? providerExhaustion(429, failure.message, retryAfterMs(Object.fromEntries(upstream.headers))) : undefined;
    if (!wantStream) {
      const body = failure ? anthropicError(failedStatus, failure.type, failure.message).body : JSON.stringify(mapper.message());
      bytes = Buffer.byteLength(body);
      res.writeHead(failure ? failedStatus : 200, { "content-type": "application/json", "content-length": String(bytes), ...(exhaustion && failedStatus === 429 ? exhaustionHeaders(exhaustion) : {}) }).end(body);
    } else if (!res.writableEnded) {
      res.end();
    }
    const usage = mapper.usage;
    return {
      status: failure ? failedStatus : 200,
      exhaustion,
      bytes,
      note: failure
        ? `${wantStream ? "mid-stream " : ""}${failure.type}: ${failure.message} (in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens})`
        : `in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens} stop=${mapper.stopReason}`,
      usage: { input: usage.input_tokens, cached: usage.cache_read_input_tokens, output: usage.output_tokens },
      stopReason: mapper.stopReason,
      ...(wantStream || !failure ? { messageId: mapper.messageId } : {}),
    };
  }

  /**
   * Send one Antigravity turn, moving to the next account while nothing has reached the client:
   *
   * - 401, or a 403 that reads as a credential refusal: one refresh of that account and a replay;
   *   refused again with a 401, the account is marked for sign-in.
   * - 429 and 402: the account rests until its stated reset (or a default), and the next takes over.
   *   A 429 that proves one quota group spent (`isGroupQuotaExhausted`) rests only that group of the
   *   account: Google counts Gemini and Claude/GPT models separately, and a spent Claude group used to
   *   refuse Gemini turns with "all accounts resting" for hours while Gemini's quota sat unused.
   * - A 503 `MODEL_CAPACITY_EXHAUSTED`: no rest and no other account — the model is out of capacity
   *   on Google's side, not this account. The same account is asked again after `capacityRetry`'s
   *   waits, then the turn ends unwritten so the proxy can try a route fallback (§5, 2026-10-20).
   * - Any other 403, 5xx, or no connection: a short rest, and the next account.
   * - Anything else is the request's fault; another account would refuse it the same way.
   *
   * Each account is tried at most once per turn (a refreshed token is the same account).
   */
  private async sendToAnAccount(spec: {
    conversation: string | undefined;
    redact: (text: string) => string;
    signal: AbortSignal;
    system: GeminiRequest["systemInstruction"];
    model: string;
    /** The CCA host this turn goes to; quota evidence is read from the same host. */
    host: string;
    build: (credential: GoogleCredential) => { built: { url: string; headers: Record<string, string>; body: string } };
  }): Promise<SendResult> {
    const tried = new Set<string>();
    const replayed = new Set<string>();
    const refreshed = new Set<string>();
    let last: Extract<SendResult, { kind: "refused" }> | null = null;
    let lastThrown: Error | null = null;
    let capacityAsks = 0;
    // The model's quota group on the host this turn goes to: each host counts its own quota.
    const group = antigravityQuotaScope(spec.model);
    const scope = group ? antigravityScopeKey(group, spec.host) : undefined;
    for (;;) {
      const credential = await this.pickAccount(spec.conversation, tried, scope);
      if (credential === "none") return { kind: "no-account" };
      if (credential === null) {
        if (last) return last;
        if (lastThrown) return { kind: "unreachable", error: lastThrown };
        const backMs = this.soonestBackMs(scope);
        const resting = group && this.pool.hasUsable(this.name, this.accounts.peekCredentials()) ? group : undefined;
        return { kind: "all-resting", ...(backMs ? { backMs } : {}), ...(resting ? { group: resting } : {}) };
      }

      const { built } = spec.build(credential);
      let upstream: Response;
      try {
        // Retried on the same account, before any status or byte reaches the client, so a relay's
        // hiccup is absorbed inside the turn instead of arriving as an error to retry by hand.
        upstream = await fetchWithRetry(built.url, {
          method: "POST",
          headers: built.headers,
          body: built.body,
          signal: spec.signal,
        }, { log: (line) => this.log.info(`google ${this.name}: ${spec.redact(line)}`), stopOn: isModelCapacityExhausted });
      } catch (e) {
        if (spec.signal.aborted) return { kind: "aborted" };
        this.pool.penalise(this.name, credential.id, 0);
        tried.add(credential.ownerId);
        lastThrown = e as Error;
        lastThrown.message = spec.redact(lastThrown.message);
        this.log.info(`google ${this.name}: account ${credential.ownerId.slice(0, 8)} unreachable (${lastThrown.message}); trying another`);
        continue;
      }

      if (upstream.ok && upstream.body) {
        this.pool.succeed(this.name, credential.id, scope);
        this.verifyUrls.delete(credential.ownerId);
        this.activeOwner = credential.ownerId;
        return { kind: "ok", upstream, credential };
      }

      const text = await upstream.text().catch(() => "");
      const safeText = spec.redact(text);
      const status = upstream.status;
      this.log.warn(`google ${this.name}: account ${credential.ownerId.slice(0, 8)} answered ${status}: ${safeText.slice(0, 400)}`);
      // The model, not the account, is out of capacity: resting the account refused every other turn
      // with "all accounts resting" for its ten seconds (10 times in 3 minutes, 2026-10-20), and
      // another account would meet the same model on the same host. So nothing is charged to it.
      if (isModelCapacityExhausted(status, text)) {
        capacityAsks++;
        const delay = capacityRetry.delaysMs[capacityAsks - 1];
        if (delay === undefined) return { kind: "no-capacity", text: safeText, asks: capacityAsks };
        this.log.info(`google ${this.name}: ${spec.model} out of capacity (ask ${capacityAsks}); asking again in ${delay}ms without resting the account`);
        try {
          await sleep(delay, undefined, { signal: spec.signal });
        } catch {
          return { kind: "aborted" };
        }
        continue;
      }
      // The generic 429 is also real exhaustion. Only fresh quota evidence for this
      // account/model permits a request-specific refusal; otherwise keep ordinary
      // cooldown and account rotation. The proxy can still try a route fallback.
      if (isAntigravityPromptRefusal(spec.system, status, text, upstream.headers.get("retry-after")) &&
          this.usage.hasRemainingQuota(credential, spec.model, spec.host)) {
        return { kind: "prompt-refused" };
      }
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
      const spent = group && isGroupQuotaExhausted(status, text, group) ? group : undefined;
      const verdict = this.pool.penalise(this.name, credential.id, credentialRefused ? 403 : status, waitMs, text, spent ? scope : undefined);
      last = { kind: "refused", status, text: safeText, ...(status === 429 && waitMs ? { retryAfterSeconds: Math.ceil(waitMs / 1000) } : {}), ...(spent ? { group: spent } : {}) };
      if (!verdict.retryable) return last;
      tried.add(credential.ownerId);
    }
  }

  /**
   * An account for one turn: the conversation's own while it is healthy, else the first usable one.
   * With a quota scope, an account whose quota for that group rests is passed over too.
   */
  private async pickAccount(conversation: string | undefined, tried: ReadonlySet<string> = new Set(), scope?: string): Promise<GoogleCredential | "none" | null> {
    const all = await this.accounts.credentials();
    if (all.length === 0) return "none";
    const rest = all.filter((c) => !tried.has(c.ownerId));
    return this.pool.pick(this.name, rest, conversation, scope) as GoogleCredential | null;
  }

  /** When the first account can take a turn in `scope` again: the later of its own rest and the scope's. */
  private soonestBackMs(scope?: string): number | undefined {
    const credentials = this.accounts.peekCredentials();
    const reports = new Map(this.pool.report(this.name, credentials).map((r) => [r.id, r]));
    const waits = credentials.flatMap((c) => {
      const report = reports.get(c.id);
      if (report?.state === "quarantined") return [];
      const own = report?.state === "cooling" ? report.cooldownSeconds ?? 0 : 0;
      const scoped = scope ? this.pool.scopeCooldowns(this.name, c.id)[scope] ?? 0 : 0;
      const seconds = Math.max(own, scoped);
      return seconds > 0 ? [seconds * 1000] : [];
    });
    return waits.length ? Math.min(...waits) : undefined;
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
