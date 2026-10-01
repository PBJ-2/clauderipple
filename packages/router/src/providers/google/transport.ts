// The Google transport: endpoint, authentication, envelope and response unwrapping, kept apart from
// the translation so a second Google backend can be added without touching translate.ts.
//
// Stage 1 implements `api-key` — the AI Studio Generative Language API, called with an API key on
// `x-goog-api-key`. The Antigravity / Cloud Code Assist mode is deliberately not implemented: it is
// a different envelope (`v1internal:streamGenerateContent`, the body wrapped in
// `{ project, model, request: {…} }`, an OAuth bearer) and guessing at it would send a request to
// an endpoint that answers nothing useful. It refuses with a named error instead.

import type { GeminiRequest } from "./translate.ts";

export type GoogleTransportRequest = { url: string; headers: Record<string, string>; body: string };

export type GoogleTransport = {
  kind: "api-key" | "antigravity";
  /** A complete upstream request for one turn. Pure: no I/O, no clock. */
  build(req: GeminiRequest, opts: { model: string; stream: boolean }): GoogleTransportRequest;
  /**
   * One SSE data payload as the Gemini chunk shape this translator reads. AI Studio sends it whole;
   * Antigravity nests the standard payload under `response`, so that mode would unwrap here.
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

export function createTransport(mode: "api-key" | "antigravity", opts: { apiKey?: string; url?: string }): GoogleTransport {
  if (mode === "antigravity") {
    // Fail closed and by name: a mode that is not implemented must not silently behave like the one
    // that is, or the user reads a working provider as a broken one.
    return {
      kind: "antigravity",
      build() {
        throw new Error("ClaudeRipple: the Google Antigravity (Cloud Code Assist) mode is not implemented yet; use auth \"api-key\" (AI Studio)");
      },
      unwrap(raw) {
        return raw;
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
