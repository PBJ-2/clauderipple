import type { GeminiRequest } from "./translate.ts";

const SDK_SENTENCE = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const GENERIC_EXHAUSTED = "Resource has been exhausted (e.g. check quota).";

export const ANTIGRAVITY_PROMPT_REFUSAL_MESSAGE =
  `Google Antigravity rejected this Claude Agent SDK system prompt (upstream 429: ${GENERIC_EXHAUSTED}). ` +
  "This request appears incompatible with Antigravity; retrying or waiting on this account is unlikely to fix it. " +
  "Choose another provider for this Claude Code request.";

/**
 * Measured 2026-10-16: the same Gemini 3.8 Flash / Claude Opus 5.5 request got 429
 * with this standalone SDK paragraph and 200 without it. The sentence is matched at the
 * start of any line of any system part, so it also counts when more text follows on the
 * same line or on the next line of the same block, not only as a paragraph of its own.
 * This is response-based classification, never a prompt rewrite or a prediction before
 * Google answers.
 * Keep any explicit quota/reset details on the ordinary rate-limit path. This shape
 * alone also occurs on real exhaustion; callers must require fresh quota evidence.
 */
export function isAntigravityPromptRefusal(
  system: GeminiRequest["systemInstruction"], status: number, text: string, retryAfter: string | null,
): boolean {
  if (status !== 429 || retryAfter !== null) return false;
  if (!system?.parts.some(part => part.text?.split(/\r?\n/).some(line => line.trim().startsWith(SDK_SENTENCE)))) return false;
  try {
    const error: unknown = (JSON.parse(text) as { error?: unknown } | null)?.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const e = error as Record<string, unknown>;
    return e.code === 429 && e.status === "RESOURCE_EXHAUSTED" && e.message === GENERIC_EXHAUSTED &&
      (e.details === undefined || (Array.isArray(e.details) && e.details.length === 0));
  } catch {
    return false;
  }
}
