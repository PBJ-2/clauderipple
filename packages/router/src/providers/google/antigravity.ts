// Google Antigravity / Cloud Code Assist (CCA): the wire facts, model-id resolution and the
// conversation session id this router uses. Kept apart from the account store (accounts.ts) and the
// OAuth session (login.ts) so each can be read and tested on its own.
//
// Every fact here is taken from the reference implementation opencodex (GitHub lidge-jun/opencodex,
// read 2026-10-01 as a behavioral spec — no code copied; the project rule forbids copying it). Each
// constant names its source file:line in a comment. **Nothing here is measured against a live
// Google endpoint** — this environment has no Antigravity subscription, so the whole file is
// doc/source-derived and unmeasured. That is recorded in docs/ARCHITECTURE.md §4d.

import crypto from "node:crypto";
import type { ProviderModel } from "../../config.ts";

// ── OAuth + Cloud Code Assist endpoints ─────────────────────────────────────────────────────────

/**
 * The public OAuth client embedded in the Antigravity desktop client. These are client identifiers,
 * not user secrets: opencodex ships them in the clear and they are overridable by environment there.
 * Source: opencodex `src/oauth/google-antigravity.ts:17-38`.
 */
export const GOOGLE_OAUTH = {
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  /** Project discovery (`loadCodeAssist`) is served by the prod host. */
  prodApi: "https://cloudcode-pa.googleapis.com",
  /** Streaming and `onboardUser` use the daily host. Source: opencodex `src/oauth/google-antigravity.ts:24-25`. */
  dailyApi: "https://daily-cloudcode-pa.googleapis.com",
  apiVersion: "v1internal",
  /** Preferred loopback port; the callback path is fixed. Source: opencodex `src/oauth/google-antigravity.ts:34-35`. */
  port: 51121,
  callbackPath: "/callback",
  /** Refresh this long before the access token expires. Source: opencodex `REFRESH_SKEW_MS`. */
  refreshLeadMs: 5 * 60 * 1000,
  /** How long a sign-in may stay open. Same as the other sign-in flows. */
  timeoutMs: 5 * 60 * 1000,
  requestTimeoutMs: 30_000,
} as const;

/**
 * The terms warning the CLI prints once and the admin API returns in a `warning` field. Facts only:
 * Google's Antigravity terms (clause 6) and the Gemini CLI FAQ state that using these credentials
 * from a third-party client is a violation, and Google blocked a large number of accounts in
 * February 2026. ClaudeRipple is not affiliated with Google.
 */
export const ANTIGRAVITY_WARNING =
  "Google's Antigravity terms (section 6) and the Gemini CLI FAQ say that using these credentials " +
  "from a client other than Google's own is not permitted, and Google blocked a large number of " +
  "accounts used this way in February 2026. ClaudeRipple is not affiliated with Google. Sign in only " +
  "if you accept that risk.";

/** Antigravity IDE version, mirrored so the request fingerprint matches the token's client. */
export const ANTIGRAVITY_IDE_VERSION = "2.5.5";

/**
 * The User-Agent the real Antigravity IDE sends. The CCA backend gates newer agent models on the
 * `antigravity/ide/...` client family and answers 404 to CLI-shaped UAs even with a valid OAuth
 * token. Source: opencodex `src/adapters/client-fingerprint.ts:44-65`, decompiled from the 2.5.5
 * language server.
 */
export function antigravityUserAgent(): string {
  const override = process.env.CLAUDERIPPLE_ANTIGRAVITY_USER_AGENT?.trim() || process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim();
  if (override) return override;
  const [osType, arch] = "windows/amd64".split("/");
  return `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`;
}

// ── Model id resolution ─────────────────────────────────────────────────────────────────────────

/**
 * Normalise a Claude Code effort onto Cloud Code Assist's three thinking levels. `xhigh`, `max` and
 * `ultra` all clamp to `high`; `none`/`minimal` to `low`. `minimal` is not itself a CCA level.
 * Source: opencodex `src/providers/antigravity-models.ts:resolveAntigravityThinkingLevel`.
 */
export function resolveAntigravityThinkingLevel(effort: string | undefined): "low" | "medium" | "high" | undefined {
  switch (effort) {
    case "none":
    case "minimal":
    case "low": return "low";
    case "medium": return "medium";
    case "high":
    case "xhigh":
    case "max":
    case "ultra": return "high";
    default: return undefined;
  }
}

/**
 * Base models whose every effort rides on a different wire id that already names the tier. Here the
 * suffix IS the effort, so no `thinkingConfig` is sent beside it. Source: opencodex
 * `ANTIGRAVITY_EFFORT_WIRE_MAP` / `ANTIGRAVITY_SUFFIX_TIER_MODELS`.
 */
const SUFFIX_TIER_MODELS: Record<string, { wire: Record<string, string>; default: string }> = {
  "gemini-3.8-flash": {
    wire: { low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high" },
    default: "medium",
  },
};

/**
 * Base models whose efforts map to wire ids but where a `thinkingConfig.thinkingLevel` also travels
 * (the high rung `gemini-pro-agent` carries no tier in its name). Source: opencodex
 * `ANTIGRAVITY_EFFORT_WIRE_MAP` / `ANTIGRAVITY_MODEL_EFFORTS`.
 */
const EFFORT_WIRE_MODELS: Record<string, { wire: Record<string, string>; default: string }> = {
  "gemini-3.1-pro": { wire: { low: "gemini-3.1-pro-low", high: "gemini-pro-agent" }, default: "high" },
};

/**
 * Base models whose effort rides on a single `-tiered` wire id via `thinkingLevel`. Source:
 * opencodex `ANTIGRAVITY_THINKING_LEVEL_MODELS` / `ANTIGRAVITY_PICKER_TO_WIRE`.
 */
const THINKING_LEVEL_MODELS: Record<string, { wire: string; default: string }> = {
  "gemini-3.7-flash": { wire: "gemini-3.7-flash-tiered", default: "medium" },
};

export type AntigravityWireModel = {
  /** The id the CCA envelope's `model` field must carry. */
  wire: string;
  /** The thinking level to place on `request.generationConfig.thinkingConfig`, when this model takes one. */
  thinkingLevel?: "low" | "medium" | "high";
  /** True when this base id is one this module knows; an unknown id is forwarded verbatim and untouched. */
  known: boolean;
};

/**
 * Resolve a Claude Code model id onto the Cloud Code Assist wire id and thinking level. A base id
 * (`gemini-3.8-flash`) resolves to its tier wire id; an id already naming a tier is forwarded as it
 * is. Unknown ids pass through untouched so a model Google adds tomorrow is still directly routable.
 */
export function resolveAntigravityWireModel(model: string, effort: string | undefined): AntigravityWireModel {
  const level = resolveAntigravityThinkingLevel(effort);
  const suffix = SUFFIX_TIER_MODELS[model];
  if (suffix) {
    const wire = (level && suffix.wire[level]) || suffix.wire[suffix.default]!;
    // The suffix names the tier; sending `thinkingLevel` beside it would state the effort twice.
    return { wire, known: true };
  }
  const mapped = EFFORT_WIRE_MODELS[model];
  if (mapped) {
    const wire = (level && mapped.wire[level]) || mapped.wire[mapped.default]!;
    return { wire, ...(level ? { thinkingLevel: level } : {}), known: true };
  }
  const tiered = THINKING_LEVEL_MODELS[model];
  if (tiered) {
    return { wire: tiered.wire, thinkingLevel: (level ?? tiered.default) as "low" | "medium" | "high", known: true };
  }
  // Claude models on Antigravity take effort through thinkingConfig only, no suffix — CCA validates
  // the field against Google's ThinkingLevel enum. Source: opencodex rule 4.
  if (/^claude-/.test(model)) return { wire: model, ...(level ? { thinkingLevel: level } : {}), known: true };
  return { wire: model, known: false };
}

/**
 * The conversation's Cloud Code Assist session id. The real client puts one stable id on every turn
 * of a conversation so provider-side replay can associate a thoughtSignature with the call that
 * produced it; an unstable id loses that association. We derive it from `conversationKey`, which the
 * router already keeps stable per conversation (and identical to the prompt-cache key), and shape it
 * as the numeric string the wire carries — `sha256(key)` → BigEndian uint64 masked to 63 bits, with a
 * leading "-". Source: opencodex `antigravitySessionId` (CLIProxyAPI `generateStableSessionID`).
 */
export function antigravitySessionId(conversationKey: string): string {
  const digest = crypto.createHash("sha256").update(conversationKey, "utf8").digest();
  const masked = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${masked.toString()}`;
}

/** A fresh per-request id, as the envelope's `requestId`. Source: opencodex `agent-${uuid}`. */
export function antigravityRequestId(): string {
  return `agent-${crypto.randomUUID()}`;
}

// ── Model catalogue ─────────────────────────────────────────────────────────────────────────────

/**
 * Context windows per model, from CCA's own `maxTokens` for the wire ids. Source: opencodex
 * `ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS`.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-3.8-flash": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "gemini-3.1-pro": 1_048_576,
  "gemini-3.1-flash-image": 1_048_576,
  "claude-sonnet-4-6": 250_000,
  "claude-opus-4-6-thinking": 250_000,
  "gpt-oss-120b-medium": 131_072,
};

/**
 * The effort ladder per collapsed base model, for the GUI. The suffix-tier model's rungs are wire
 * ids, so the GUI shows them as one entry with a ladder rather than three rows (opencodex does the
 * same collapsing). Source: opencodex `ANTIGRAVITY_MODEL_EFFORTS`.
 */
const EFFORT_LEVELS: Record<string, string[]> = {
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "claude-sonnet-4-6": ["low", "medium", "high"],
  "claude-opus-4-6-thinking": ["low", "medium", "high"],
};

/** The collapsed base models the CCA backend serves. Source: opencodex `ANTIGRAVITY_MODELS`. */
export const ANTIGRAVITY_BASE_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.1-pro",
  "gemini-3.1-flash-image",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
] as const;

/** The static fallback list, used when `:fetchAvailableModels` cannot be read. */
export function staticAntigravityModels(): ProviderModel[] {
  return ANTIGRAVITY_BASE_MODELS.map((id) => ({
    id,
    ...(CONTEXT_WINDOWS[id] ? { contextWindow: CONTEXT_WINDOWS[id] } : {}),
    ...(EFFORT_LEVELS[id] ? { effortLevels: [...EFFORT_LEVELS[id]] } : {}),
  }));
}

function isBaseModel(id: string): boolean {
  return (ANTIGRAVITY_BASE_MODELS as readonly string[]).includes(id);
}

/**
 * Collapse a wire id back to the collapsed base id the picker shows, when it names a known tier. The
 * collapsed id is what the static catalogue lists and what `resolveAntigravityWireModel` maps back to
 * a wire id, so the picker shows one row per model and routing is the same whether the list came from
 * discovery or the fallback.
 */
function collapseWireId(wireId: string): string {
  if (isBaseModel(wireId)) return wireId;
  const tiered = wireId.endsWith("-tiered") ? wireId.slice(0, -"-tiered".length) : undefined;
  if (tiered && isBaseModel(tiered)) return tiered;
  const match = /^(.*)-(low|medium|high|max|minimal)$/.exec(wireId);
  if (match && isBaseModel(match[1]!)) return match[1]!;
  return wireId;
}

/**
 * Parse `POST {dailyApi}/v1internal:fetchAvailableModels`. The body groups agent-callable models
 * under `agentModelSorts[].groups[].modelIds`, with tiered Flash ids under `tieredModelIds.flash`, and
 * describes each in `models[wireId]` (`maxTokens`). Source: opencodex
 * `parseAntigravityAvailableModels` (src/providers/antigravity-models.ts:489-560).
 *
 * Returns null when the shape is unreadable, so the caller falls back instead of showing nothing.
 */
export function parseAvailableModels(payload: unknown, limit = 200): ProviderModel[] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const models = body.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;
  const known = models as Record<string, unknown>;
  const available = new Set(Object.keys(known));

  // Collapse each wire id to its base id first, then take the context window and display name from
  // the first wire id that carried that base. A collapsed id is what routing understands.
  const collapsed = new Map<string, string>();
  const add = (wireId: string): void => {
    if (typeof wireId !== "string" || !available.has(wireId)) return;
    const id = collapseWireId(wireId);
    if (!collapsed.has(id)) collapsed.set(id, wireId);
  };
  const sorts = Array.isArray(body.agentModelSorts) ? body.agentModelSorts : [];
  for (const sort of sorts) {
    const groups = sort && typeof sort === "object" ? (sort as { groups?: unknown }).groups : undefined;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const ids = group && typeof group === "object" ? (group as { modelIds?: unknown }).modelIds : undefined;
      if (Array.isArray(ids)) for (const id of ids) add(id as string);
    }
  }
  const tiered = body.tieredModelIds && typeof body.tieredModelIds === "object" ? (body.tieredModelIds as { flash?: unknown }).flash : undefined;
  if (Array.isArray(tiered)) for (const id of tiered) add(id as string);

  if (collapsed.size === 0) return null;
  const out: ProviderModel[] = [];
  for (const [id, wireId] of collapsed) {
    const info = known[wireId] && typeof known[wireId] === "object" ? (known[wireId] as { maxTokens?: unknown; displayName?: unknown }) : undefined;
    const contextWindow = typeof info?.maxTokens === "number" && Number.isFinite(info.maxTokens) && info.maxTokens > 0 ? Math.floor(info.maxTokens) : CONTEXT_WINDOWS[id];
    out.push({
      id,
      ...(typeof info?.displayName === "string" && info.displayName ? { name: info.displayName } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(EFFORT_LEVELS[id] ? { effortLevels: [...EFFORT_LEVELS[id]] } : {}),
    });
    if (out.length >= limit) break;
  }
  return out.length > 0 ? out : null;
}

// ── Project discovery ───────────────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function extractProjectId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  }
  return undefined;
}

function signalFor(outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(GOOGLE_OAUTH.requestTimeoutMs);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/**
 * Discover the account's Cloud Code Assist project: `loadCodeAssist` on the prod host, then
 * `onboardUser` polling on the daily host when the account has none yet. Returns undefined when
 * neither yields one. Source: opencodex `loadCodeAssistProject` / `onboardProject`.
 */
export async function discoverProject(accessToken: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string | undefined> {
  const loaded = await loadCodeAssistProject(accessToken, fetchImpl, signal);
  if (loaded) return loaded;
  return onboardProject(accessToken, fetchImpl, signal, sleep);
}

async function loadCodeAssistProject(accessToken: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`${GOOGLE_OAUTH.prodApi}/${GOOGLE_OAUTH.apiVersion}:loadCodeAssist`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, accept: "*/*", "content-type": "application/json", "user-agent": antigravityUserAgent() },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: signalFor(signal),
    });
    if (!response.ok) return undefined;
    return extractProjectId((await response.json().catch(() => undefined)) as Record<string, unknown> | undefined);
  } catch {
    return undefined;
  }
}

const ONBOARD_ATTEMPTS = 5;
const ONBOARD_POLL_MS = 2_000;

async function onboardProject(accessToken: string, fetchImpl: FetchLike, signal: AbortSignal | undefined, sleep: (ms: number) => Promise<void>): Promise<string | undefined> {
  for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt++) {
    if (signal?.aborted) return undefined;
    let response: Response;
    try {
      response = await fetchImpl(`${GOOGLE_OAUTH.dailyApi}/${GOOGLE_OAUTH.apiVersion}:onboardUser`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, accept: "*/*", "content-type": "application/json", "user-agent": antigravityUserAgent() },
        body: JSON.stringify({ tier_id: "free-tier", metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: ANTIGRAVITY_IDE_VERSION } }),
        signal: signalFor(signal),
      });
    } catch {
      return undefined;
    }
    if (!response.ok) {
      // A transient refusal (429/5xx) is worth polling through; a hard 4xx will not change.
      if (response.status === 429 || response.status >= 500) {
        await sleep(ONBOARD_POLL_MS);
        continue;
      }
      return undefined;
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.done === true) return extractProjectId(data.response as Record<string, unknown> | undefined);
    await sleep(ONBOARD_POLL_MS);
  }
  return undefined;
}

/** The account email from Google's pinned userinfo endpoint. Never persisted as a token. */
export async function fetchUserEmail(accessToken: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetchImpl(GOOGLE_OAUTH.userinfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: signalFor(signal),
    });
    if (!response.ok) return undefined;
    const body = (await response.json().catch(() => undefined)) as { email?: unknown } | undefined;
    return typeof body?.email === "string" && body.email.length > 0 ? body.email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** The models a CCA account can reach now, or null when the endpoint cannot be read. */
export async function fetchAvailableModels(accessToken: string, projectId: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<ProviderModel[] | null> {
  try {
    const response = await fetchImpl(`${GOOGLE_OAUTH.dailyApi}/${GOOGLE_OAUTH.apiVersion}:fetchAvailableModels`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, accept: "*/*", "content-type": "application/json", "user-agent": antigravityUserAgent() },
      body: JSON.stringify({ project: projectId }),
      signal: signalFor(signal),
    });
    if (!response.ok) return null;
    return parseAvailableModels(await response.json().catch(() => undefined));
  } catch {
    return null;
  }
}
