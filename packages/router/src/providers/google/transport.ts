// The Google transport: endpoint, authentication, envelope and response unwrapping, kept apart from
// the translation so the two Google backends share one `translate.ts`.
//
//   api-key      the AI Studio Generative Language API, called with a key on `x-goog-api-key`.
//   antigravity  Cloud Code Assist / Antigravity: an OAuth bearer, the Gemini body wrapped in a
//                `{ project, model, request: {…} }` envelope on `v1internal:`, and the answer nested
//                back under `response`. Account selection, refresh and retry live in index.ts; this
//                file only builds the bytes and unwraps the frames.
//
// The antigravity wire is taken from the reference implementation opencodex as a behavioral spec
// (src/adapters/google.ts:1056-1160, src/adapters/google-antigravity-wire.ts) and is **not measured
// live** — this environment has no Antigravity subscription. See docs/ARCHITECTURE.md §4d.

import type { GeminiRequest } from "./translate.ts";
import { antigravityRequestId, antigravitySessionId, antigravityUserAgent, GOOGLE_OAUTH, resolveAntigravityWireModel } from "./antigravity.ts";

export type GoogleTransportRequest = { url: string; headers: Record<string, string>; body: string };

/** The per-account credential and conversation a turn's antigravity request is built from. */
export type AntigravityAuth = { accessToken: string; projectId: string; conversationKey: string };

export type GoogleTransportBuildOptions = {
  model: string;
  stream: boolean;
  effort?: string;
  /** Present only for the antigravity mode; the api-key mode ignores it. */
  antigravity?: AntigravityAuth;
};

export type GoogleTransport = {
  kind: "api-key" | "antigravity";
  /** A complete upstream request for one turn. Pure: no I/O, no clock (the requestId is random by design). */
  build(req: GeminiRequest, opts: GoogleTransportBuildOptions): GoogleTransportRequest;
  /**
   * One SSE data payload as the Gemini chunk shape this translator reads. AI Studio sends it whole;
   * Antigravity nests the standard payload under `response`, so that mode unwraps here.
   */
  unwrap(raw: Record<string, unknown>): Record<string, unknown>;
};

const DEFAULT_BASE = "https://generativelanguage.googleapis.com";

/** The AI Studio key: the provider's own, or the environment names Google's own SDKs read. Never logged. */
export function resolveApiKey(configured?: string): string | undefined {
  const key = configured?.trim();
  if (key) return key;
  const env = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  return env && env.trim() ? env.trim() : undefined;
}

export function googleBaseUrl(configured?: string): string {
  return (configured?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}

/** The Cloud Code Assist base; the daily host, overridable by the provider's `url`. */
export function antigravityBaseUrl(configured?: string): string {
  return (configured?.trim() || GOOGLE_OAUTH.dailyApi).replace(/\/+$/, "");
}

export function createTransport(mode: "api-key" | "antigravity", opts: { apiKey?: string; url?: string }): GoogleTransport {
  if (mode === "antigravity") {
    const base = antigravityBaseUrl(opts.url);
    return {
      kind: "antigravity",
      build(req, o) {
        const auth = o.antigravity;
        if (!auth) throw new Error("ClaudeRipple: the Google Antigravity mode needs a signed-in account; run `clauderipple google-login`");
        const resolved = resolveAntigravityWireModel(o.model, o.effort);
        const request: GeminiRequest & { sessionId?: string } = { ...req, sessionId: antigravitySessionId(auth.conversationKey) };
        // The transport owns `thinkingConfig` on this wire. The translation guesses a level from the
        // base id, but CCA's wire id already encodes the tier for some models (gemini-3.8-flash-low);
        // sending a level beside one states the effort twice and the run tier becomes unknowable. So
        // whatever the translation set is replaced by exactly what the resolved wire id wants — a
        // level, or nothing.
        const generationConfig = { ...(request.generationConfig ?? {}) };
        if (resolved.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: resolved.thinkingLevel };
        else delete generationConfig.thinkingConfig;
        if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
        else delete request.generationConfig;
        // Claude models on CCA force validated function calling (the real client always sets it). A
        // client that asked for no tools is honoured by dropping the declarations, the wire shape of a
        // tool-less turn. Source: opencodex src/adapters/google.ts:1109-1120.
        if (/^claude-/.test(resolved.wire) && request.tools) {
          if (request.toolConfig?.functionCallingConfig?.mode === "NONE") {
            delete request.tools;
            delete request.toolConfig;
          } else {
            request.toolConfig = { functionCallingConfig: { ...(request.toolConfig?.functionCallingConfig ?? {}), mode: "VALIDATED" } };
          }
        }
        const method = o.stream ? "streamGenerateContent" : "generateContent";
        const query = o.stream ? "?alt=sse" : "";
        const envelope = {
          model: resolved.wire,
          // A protocol constant, distinct from the HTTP User-Agent header below. Source: opencodex
          // src/adapters/google.ts:1149-1155.
          userAgent: "antigravity",
          requestType: "agent",
          project: auth.projectId,
          requestId: antigravityRequestId(),
          request,
        };
        return {
          url: `${base}/${GOOGLE_OAUTH.apiVersion}:${method}${query}`,
          headers: {
            "content-type": "application/json",
            accept: o.stream ? "text/event-stream" : "application/json",
            // The IDE client family is required to unlock newer agent models. Never a giveaway literal.
            "user-agent": antigravityUserAgent(),
            authorization: `Bearer ${auth.accessToken}`,
          },
          body: JSON.stringify(envelope),
        };
      },
      unwrap(raw) {
        const wrapped = raw.response;
        // A top-level `{ error: … }` frame has no `response`; it is returned as it is so the mapper
        // still sees the error.
        return wrapped && typeof wrapped === "object" && !Array.isArray(wrapped) ? (wrapped as Record<string, unknown>) : raw;
      },
    };
  }
  const base = googleBaseUrl(opts.url);
  const apiKey = resolveApiKey(opts.apiKey);
  return {
    kind: "api-key",
    build(req, o) {
      if (!apiKey) throw new Error("ClaudeRipple: this Google provider has no API key; set apiKey or GEMINI_API_KEY");
      const method = o.stream ? "streamGenerateContent" : "generateContent";
      const query = o.stream ? "?alt=sse" : "";
      return {
        url: `${base}/v1beta/models/${encodeURIComponent(o.model)}:${method}${query}`,
        headers: { "content-type": "application/json", accept: o.stream ? "text/event-stream" : "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(req),
      };
    },
    unwrap(raw) {
      return raw;
    },
  };
}
