// A routed model reads Claude Code's system prompt, which opens with "You are Claude Code,
// Anthropic's official CLI for Claude". Nothing else tells the model what it is, so without a line
// of its own DeepSeek answers that it is Claude (measured 2026-09-16). This is that line, and the
// fixed addendum that may follow the prompt, shared by every provider that can carry one.
//
// The text must stay constant across the turns of a session or the prompt cache misses: the
// identity depends on the model and the effort only, both fixed for a route, and the addendum is
// configuration. Changing either costs one cache miss.

export type IdentityOptions = {
  model: string;
  effort?: string | undefined;
  /** Default true: the caller passes the provider's `identity` field as given. */
  identity?: boolean | undefined;
  instructionsAppend?: string | undefined;
};

/** The sentence put in front of the system prompt. Effort is named because a model cannot see its own setting. */
export function identityLine(model: string, effort?: string): string {
  const reasoning = effort ? ` (reasoning effort: ${effort})` : "";
  return `You are ${model}${reasoning}, answering through Claude Code, a terminal-based coding agent.`;
}

/** The identity line, when enabled, in the order it belongs: before the caller's own system text. */
export function identityPrefix(opts: IdentityOptions): string | null {
  return (opts.identity ?? true) ? identityLine(opts.model, opts.effort) : null;
}

/** The configured addendum, trimmed, or null when there is none to add. */
export function instructionsSuffix(opts: IdentityOptions): string | null {
  const text = opts.instructionsAppend?.trim();
  return text ? text : null;
}

type AnthropicSystemBlock = { type: "text"; text: string } & Record<string, unknown>;

/**
 * Wraps an Anthropic Messages body's `system` with the identity line and the addendum, in place.
 * A string system stays a string; a block array stays an array, and the added blocks carry no
 * cache_control of their own so the caller's breakpoints keep their meaning.
 */
export function applyIdentityToAnthropicBody(json: Record<string, unknown>, opts: IdentityOptions): void {
  const prefix = identityPrefix(opts);
  const suffix = instructionsSuffix(opts);
  if (!prefix && !suffix) return;
  const system = json.system;
  if (system === undefined || system === null || system === "") {
    json.system = [prefix, suffix].filter(Boolean).join("\n\n");
    return;
  }
  if (typeof system === "string") {
    json.system = [prefix, system, suffix].filter(Boolean).join("\n\n");
    return;
  }
  if (Array.isArray(system)) {
    const blocks = system as AnthropicSystemBlock[];
    json.system = [
      ...(prefix ? [{ type: "text" as const, text: prefix }] : []),
      ...blocks,
      ...(suffix ? [{ type: "text" as const, text: suffix }] : []),
    ];
  }
  // Any other shape is left alone: it is not something this router put together.
}
