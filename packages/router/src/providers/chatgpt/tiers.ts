// The ChatGPT provider's service tier, decided in one place.
//
// Two tiers can be asked of the Codex backend, and both are plain strings on the wire:
// `priority` is Fast (codex-rs `ServiceTier::Fast`), `ultrafast` is Ultrafast (not part of that
// enum: the CLI passes the string through, codex-rs core/src/config/mod.rs, read 2026-11-24).
//
// The Codex CLI puts a tier on a request only when the model's catalogue entry lists it
// (`service_tiers[].id`, codex-rs protocol/src/openai_models.rs `supports_service_tier`), and the
// catalogue is what differs between plans and models. So Ultrafast is asked for here only when
// the catalogue this router read says the model offers it; an unread catalogue is not eligibility.
// Fast keeps the rule it had before Ultrafast existed, and is not checked against the catalogue.

/** A provider's two switches for one tier: `main` for the session's own turns, `subagent` for a subagent's. */
export type TierSwitches = { main?: boolean; subagent?: boolean };

/** The tiers this adapter writes into `service_tier`. */
export type WireTier = "priority" | "ultrafast";

/** The catalogue's id for the Ultrafast tier, which is also its wire value. */
export const ULTRAFAST_TIER = "ultrafast";

/**
 * The tier one turn is sent on, or undefined for standard.
 *
 * Ultrafast outranks Fast and falls back to it: with both switches on for the turn's scope, a
 * model that does not advertise Ultrafast still goes out on Fast. `speedFast` is Claude Code's own
 * `speed: "fast"`, which asks for Fast whatever the switches say.
 */
export function chooseServiceTier(input: { speedFast: boolean; subagent: boolean; fast?: TierSwitches | undefined; ultrafast?: TierSwitches | undefined; modelTiers?: readonly string[] | undefined }): WireTier | undefined {
  const scope = input.subagent ? "subagent" : "main";
  if (input.ultrafast?.[scope] === true && input.modelTiers?.includes(ULTRAFAST_TIER) === true) return "ultrafast";
  if (input.speedFast || input.fast?.[scope] === true) return "priority";
  return undefined;
}

/** The request-log note's suffix for the tier that was asked for. */
export function tierNote(tier: string | undefined): "" | " fast" | " ultrafast" {
  return tier === "ultrafast" ? " ultrafast" : tier === "priority" ? " fast" : "";
}

/**
 * Whether a refusal is about the service tier: a 4xx whose body names the tier. 401 and 429 are
 * the credential's and the limit's own answers and are never read as this.
 *
 * Not yet measured against the backend (2026-11-24): an eligible account has not been seen to
 * refuse, and OpenAI documents no answer for an ineligible one. Correct this once one is seen.
 */
export function refusesServiceTier(status: number, text: string): boolean {
  if (status < 400 || status >= 500 || status === 401 || status === 429) return false;
  return /service[_ ]tier|ultrafast/i.test(text);
}
