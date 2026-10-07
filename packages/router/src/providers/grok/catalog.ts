// The models a Grok subscription offers, as the CLI chat proxy lists them (`GET /v1/models`).
//
// Measured 2026-10-08 (CLI 1.0.46, SuperGrok): four models, each with `context_window`,
// `reasoning_efforts` (`[{id, value, label, description, default}]`, listed high to low) and
// `api_backend: "responses"`. The listing is the truth about the ladder: grok-4.5 lists low..high,
// the others low..xhigh. (Chat Completions accepted `xhigh` on grok-4.5 too, but a 200 means only
// "not refused" — §4c — so the listing wins.) `max` and the string "none" are refused with 400
// `invalid-argument` on every model; omitting the field is accepted and the model's default (`high`)
// applies.

import type { ProviderModel } from "../../config.ts";

export const GROK_DEFAULT_URL = "https://cli-chat-proxy.grok.com/v1";

/** The ladder for a model the listing has not described. Ascending, as the picker expects. */
export const GROK_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** What the listing said on 2026-10-08, for when it cannot be asked (no session yet, offline). */
export const GROK_FALLBACK_MODELS: ProviderModel[] = [
  { id: "grok-4.7", name: "Grok 4.7", contextWindow: 256000, effortLevels: [...GROK_EFFORT_LEVELS] },
  { id: "grok-4.7-build-fast", name: "Grok 4.7 Fast", contextWindow: 256000, effortLevels: [...GROK_EFFORT_LEVELS] },
  { id: "grok-4.6", name: "Grok 4.6", contextWindow: 256000, effortLevels: [...GROK_EFFORT_LEVELS] },
  { id: "grok-4.5", name: "Grok 4.5", contextWindow: 256000, effortLevels: ["low", "medium", "high"] },
];

/**
 * Model entries from a `/v1/models` body. Only `id`, `name`, `contextWindow` and `effortLevels` are
 * kept: a Grok model never carries `wire`, `url` or `authHeader`, because `providerFor` would turn it
 * into an openai-compatible provider without the session headers.
 */
export function grokModelsFromListing(body: unknown): ProviderModel[] {
  const data = body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : [];
  return data.flatMap((item): ProviderModel[] => {
    if (!item || typeof item !== "object") return [];
    const m = item as { id?: unknown; name?: unknown; context_window?: unknown; supports_reasoning_effort?: unknown; reasoning_efforts?: unknown };
    if (typeof m.id !== "string" || !m.id) return [];
    const listed = Array.isArray(m.reasoning_efforts)
      ? m.reasoning_efforts.flatMap((effort) => {
          const value = effort && typeof effort === "object" ? (effort as { value?: unknown; id?: unknown }).value ?? (effort as { id?: unknown }).id : undefined;
          return typeof value === "string" ? [value] : [];
        })
      : undefined;
    const effortLevels = m.supports_reasoning_effort === false
      ? []
      : listed && listed.length > 0
        ? [...new Set(listed)].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))
        : undefined;
    return [{
      id: m.id,
      ...(typeof m.name === "string" && m.name ? { name: m.name } : {}),
      ...(typeof m.context_window === "number" && m.context_window > 0 ? { contextWindow: m.context_window } : {}),
      ...(effortLevels !== undefined ? { effortLevels } : {}),
    }];
  });
}
