import type { GeminiRequest } from "./translate.ts";

const SDK_PARAGRAPH = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const GENERIC_EXHAUSTED = "Resource has been exhausted (e.g. check quota).";

export const ANTIGRAVITY_PROMPT_REFUSAL_MESSAGE =
  `Google Antigravity rejected this Claude Agent SDK system prompt (upstream 429: ${GENERIC_EXHAUSTED}). ` +
  "This request is incompatible with Antigravity; waiting or changing Google accounts will not fix it. " +
  "Choose another provider for this Claude Code request.";

/**
 * Measured 2026-10-16: the same Gemini 3.8 Flash / Claude Opus 5.5 request got 429
 * with this standalone SDK paragraph and 200 without it. This is response-based
 * classification, never a prompt rewrite or a prediction before Google answers.
 * Keep any explicit quota/reset details on the ordinary rate-limit path.
 */
export function isAntigravityPromptRefusal(
  system: GeminiRequest["systemInstruction"], status: number, text: string, retryAfter: string | null,
): boolean {
  if (status !== 429 || retryAfter !== null) return false;
  if (!system?.parts.some(part => part.text?.split(/\r?\n\s*\r?\n/).some(paragraph => paragraph.trim() === SDK_PARAGRAPH))) return false;
  try {
    const error: unknown = (JSON.parse(text) as { error?: unknown } | null)?.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const e = error as Record<string, unknown>;
    return e.code === 429 && e.status === "RESOURCE_EXHAUSTED" && e.message === GENERIC_EXHAUSTED &&
      (e.details === undefined || Array.isArray(e.details) && e.details.length === 0);
  } catch {
    return false;
  }
}
