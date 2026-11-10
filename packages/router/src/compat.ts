// Sanitise Claude Code's Anthropic-only request extensions for providers that expose
// an Anthropic-shaped Messages endpoint without implementing Anthropic's full feature set.
// Pure: callers receive a new object and an audit list; the input is never mutated.

import { droppedServerToolNote, scrubSchema } from "./providers/chatgpt/translate.ts";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export type CompatibleCaps = {
  /** Empty means the provider does not accept output_config.effort. */
  effortLevels?: string[];
  /**
   * What the provider takes for Claude Code's `thinking: {type: "adaptive"}`: `adaptive` as sent
   * (minus Claude-only fields), the older `enabled` shape with a fixed budget, or nothing.
   */
  thinking?: "adaptive" | "enabled" | "none";
  /** Whether the provider accepts Anthropic beta flags. Default false. */
  betas?: boolean;
  /** Whether cache_control blocks are accepted. Default true. */
  cacheControl?: boolean;
  /**
   * Whether the provider runs Anthropic's server-side tools itself (`web_search`). Default false:
   * a provider that is only offered one it cannot run answers an empty search with no error.
   *
   * Not every vendor documents this. DeepSeek does not, and measuring said otherwise — a
   * `web_search_20250305` tool sent to `api.deepseek.com/anthropic` came back with
   * `server_tool_use`, a `web_search_tool_result` holding ten hits, and
   * `usage.server_tool_use.web_search_requests: 1` (2026-09-17). Dropping it was throwing away a
   * capability the user was already paying for, so this is measured per preset, not assumed.
   */
  serverTools?: boolean;
};

export type ResolvedCompatibleCaps = {
  effortLevels: string[];
  thinking: "adaptive" | "enabled" | "none";
  betas: boolean;
  cacheControl: boolean;
  serverTools: boolean;
};

export const STRICT_COMPAT_CAPS: ResolvedCompatibleCaps = {
  effortLevels: [],
  thinking: "none",
  betas: false,
  cacheControl: true,
  serverTools: false,
};

export function resolveCompatibleCaps(preset?: CompatibleCaps, override?: CompatibleCaps): ResolvedCompatibleCaps {
  return {
    effortLevels: [...(override?.effortLevels ?? preset?.effortLevels ?? STRICT_COMPAT_CAPS.effortLevels)],
    thinking: override?.thinking ?? preset?.thinking ?? STRICT_COMPAT_CAPS.thinking,
    betas: override?.betas ?? preset?.betas ?? STRICT_COMPAT_CAPS.betas,
    cacheControl: override?.cacheControl ?? preset?.cacheControl ?? STRICT_COMPAT_CAPS.cacheControl,
    serverTools: override?.serverTools ?? preset?.serverTools ?? STRICT_COMPAT_CAPS.serverTools,
  };
}

export type SanitizedCompatibleRequest = {
  json: Record<string, unknown>;
  /** Short, safe descriptions suitable for a single request log line. */
  changes: string[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** `anthropic-version` stays intact; only unsupported beta flags are removed. */
export function forwardCompatibleHeader(name: string, caps: ResolvedCompatibleCaps): boolean {
  return name.toLowerCase() !== "anthropic-beta" || caps.betas;
}

/**
 * Return the nearest supported canonical effort level. Unknown requested levels fall back
 * to the provider's lowest listed level, which is safer than forwarding a rejected value.
 *
 * Equally near on both sides goes up: `medium` on a `low`/`high`/`max` ladder — the shape most
 * OpenCode Go models list (models.dev, 2026-10-02) — is `high`. Asking for medium means "more
 * than low", and rounding it down cost a worker its reasoning for the sake of a tie.
 */
export function clampEffort(effort: string, supported: string[]): string {
  if (supported.includes(effort)) return effort;
  const requested = EFFORT_LEVELS.indexOf(effort as EffortLevel);
  const canonical = supported
    .map((value) => ({ value, index: EFFORT_LEVELS.indexOf(value as EffortLevel) }))
    .filter((entry) => entry.index >= 0);
  if (requested < 0 || canonical.length === 0) return supported[0] ?? effort;
  return canonical.reduce((best, candidate) => {
    const distance = Math.abs(candidate.index - requested);
    const bestDistance = Math.abs(best.index - requested);
    return distance < bestDistance || (distance === bestDistance && candidate.index > best.index) ? candidate : best;
  }).value;
}

function stripCacheControl(value: unknown): { value: unknown; count: number } {
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((item) => {
      const next = stripCacheControl(item);
      count += next.count;
      return next.value;
    });
    return { value: out, count };
  }
  const source = record(value);
  if (!source) return { value, count: 0 };
  let count = 0;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "cache_control") {
      count++;
      continue;
    }
    const next = stripCacheControl(child);
    out[key] = next.value;
    count += next.count;
  }
  return { value: out, count };
}

// Claude Code's first system block is Anthropic billing telemetry
// ("x-anthropic-billing-header: … cch=… cc_prompt_id=… cc_turn_origin=…"). The CLI adds those
// per-turn fields only when it believes it is talking to api.anthropic.com — which, behind this
// router's MITM proxy, it always does — and their values change on every turn. Left in, the block
// sits at the head of the prefix and nothing after it is ever cached by a vendor that keeps a
// plain stable-prefix cache. Measured 2026-09-25 on Bailian DeepSeek: all 399 requests of two days
// reported cached=0 over 69.8M input tokens; two identical bodies cached 3,584 of ~3,700 tokens
// with the block held constant and 0 on all three calls with its fields varied per request. The
// translated providers drop it for the same reason (`systemText` in providers/chatgpt/translate.ts,
// measured 2026-09-13), and it means nothing to a provider that is not Anthropic.
const BILLING_BLOCK = /^x-anthropic-billing-header:/;

// Anthropic-only block types Claude Code puts inside the `messages` array: `tool_addition` declares
// a deferred tool mid-conversation (`tool.definition` is a full tool definition) and `tool_removal`
// withdraws one by name (`tool.type: "tool_reference"`). Anthropic's own API reads them; a vendor's
// Anthropic skin validates the content union and answers 400 `Invalid Anthropic Messages API
// request` for the whole request (issue #92, CLI 2.1.308+).

/**
 * Deferred definitions follow the explicit tools without moving their cached prefix. Explicit
 * names win, then the first addition of each name wins. Removals do not erase declarations: the
 * stateless history may still contain calls to them. Shared by compatible and translated wires.
 */
export function deferredToolDefinitions(messages: unknown, tools: unknown): { name: string; [key: string]: unknown }[] {
  if (!Array.isArray(messages)) return [];
  const names = new Set<string>();
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const source = record(tool);
      if (source && typeof source.name === "string") names.add(source.name);
    }
  }
  const lifted: { name: string; [key: string]: unknown }[] = [];
  for (const message of messages) {
    const source = record(message);
    if (!Array.isArray(source?.content)) continue;
    for (const block of source.content) {
      const item = record(block);
      if (item?.type !== "tool_addition") continue;
      const definition = record(record(item.tool)?.definition);
      const name = typeof definition?.name === "string" ? definition.name : undefined;
      if (!definition || !name || names.has(name)) continue;
      names.add(name);
      const liftedTool: { name: string; [key: string]: unknown } = { ...definition, name };
      delete liftedTool.eager_input_streaming;
      lifted.push(liftedTool);
    }
  }
  return lifted;
}

/**
 * Fold those extensions into shapes an Anthropic-compatible vendor accepts: `system`/`developer`
 * messages become `user` (text byte-for-byte, adjacent user messages left unmerged so no cached
 * byte moves), extension blocks leave their message, and the tool definitions they carried come
 * back in `lifted` for the caller's tools loop to treat exactly like declared ones.
 */
function foldMessageExtensions(messages: unknown, tools: unknown): { messages: unknown; lifted: unknown[]; changes: string[] } {
  if (!Array.isArray(messages)) return { messages, lifted: [], changes: [] };
  const lifted = deferredToolDefinitions(messages, tools);
  const kept: unknown[] = [];
  let folded = 0;
  let additions = 0;
  let removals = 0;
  for (const message of messages) {
    const source = record(message);
    if (!source) {
      kept.push(message);
      continue;
    }
    let next = source;
    if (Array.isArray(source.content)) {
      const content: unknown[] = [];
      let touched = false;
      for (const block of source.content) {
        const item = record(block);
        if (item?.type === "tool_addition") {
          touched = true;
          additions++;
          continue;
        }
        if (item?.type === "tool_removal") {
          touched = true;
          removals++;
          continue;
        }
        content.push(block);
      }
      // A message that held nothing but extension blocks would go out as an empty content array,
      // which vendors reject; what it carried is in `tools` or withdrawn, so it goes whole.
      if (touched && content.length === 0) continue;
      if (touched) next = { ...source, content };
    }
    if (next.role === "system" || next.role === "developer") {
      next = { ...next, role: "user" };
      folded++;
    }
    kept.push(next);
  }
  const changes: string[] = [];
  if (folded > 0) changes.push(`system_role×${folded}`);
  if (additions > 0) changes.push(`tool_addition×${additions}`);
  if (removals > 0) changes.push(`tool_removal×${removals}`);
  return { messages: changes.length > 0 ? kept : messages, lifted, changes };
}

function appendSystemText(system: unknown, text: string): unknown {
  if (system === undefined || system === null || system === "") return text;
  if (typeof system === "string") return `${system}\n\n${text}`;
  if (Array.isArray(system)) return [...system, { type: "text", text }];
  return system;
}

function stripBillingHeader(system: unknown): { value: unknown; removed: number } {
  if (typeof system === "string") {
    const value = system.replace(/^x-anthropic-billing-header:[^\n]*\n*/, "");
    return { value, removed: value === system ? 0 : 1 };
  }
  if (!Array.isArray(system)) return { value: system, removed: 0 };
  const value = system.filter((block) => {
    const source = record(block);
    return !(source && typeof source.text === "string" && BILLING_BLOCK.test(source.text));
  });
  return { value, removed: system.length - value.length };
}

/**
 * Remove extensions Claude Code sends only to Anthropic. This deliberately retains content
 * verbatim except cache_control when the provider explicitly rejects prompt caching.
 */
export function sanitizeForCompatible(json: Record<string, unknown>, caps: ResolvedCompatibleCaps): SanitizedCompatibleRequest {
  const out: Record<string, unknown> = { ...json };
  const changes: string[] = [];

  const thinking = record(out.thinking);
  if (thinking) {
    // A provider that documents adaptive thinking itself keeps it, with only the Claude-only fields
    // removed below: turning it into a fixed budget changes how long the model thinks (2026-11-08,
    // MiniMax M3.1 Flash under `enabled` 8192 thought ~25× longer per step at high than at max).
    if (thinking.type === "adaptive" && caps.thinking !== "adaptive") {
      if (caps.thinking === "enabled") {
        out.thinking = { type: "enabled", budget_tokens: 8192 };
        changes.push("thinking adaptive→enabled");
      } else {
        delete out.thinking;
        changes.push("thinking");
      }
    } else {
      const next = { ...thinking };
      let removed = false;
      for (const key of ["block_binding", "display"]) {
        if (key in next) {
          delete next[key];
          removed = true;
        }
      }
      if (removed) {
        out.thinking = next;
        changes.push("thinking");
      }
    }
  }

  for (const key of ["context_management", "container", "thread", "diagnostics"]) {
    if (key in out) {
      delete out[key];
      changes.push(key);
    }
  }

  const outputConfig = record(out.output_config);
  if (outputConfig) {
    const effort = typeof outputConfig.effort === "string" ? outputConfig.effort : undefined;
    if (!effort || caps.effortLevels.length === 0) {
      delete out.output_config;
      changes.push(effort ? `effort ${effort}→removed` : "output_config");
    } else {
      const clamped = clampEffort(effort, caps.effortLevels);
      out.output_config = { effort: clamped };
      if (clamped !== effort) changes.push(`effort ${effort}→${clamped}`);
      else if (Object.keys(outputConfig).length !== 1) changes.push("output_config");
    }
  }

  // Mid-conversation system messages (issue #92). Handled before `tools` so the definitions they
  // lift meet the same loop as the caller's own.
  const folded = foldMessageExtensions(out.messages, out.tools);
  changes.push(...folded.changes);
  if (folded.changes.length > 0) out.messages = folded.messages;
  // Lifted definitions go after the caller's tools, in the order the messages named them. Appending
  // keeps every byte of the prefix the vendor has already cached where it was; a later turn that
  // adds another deferred tool extends the list without moving the tools before it.
  const toolsSource = folded.lifted.length > 0
    ? [...(Array.isArray(out.tools) ? out.tools : []), ...folded.lifted]
    : out.tools;

  if (Array.isArray(toolsSource)) {
    const kept: unknown[] = [];
    const droppedNames = new Set<string>();
    let deferred = 0;
    let dropped = 0;
    const patterns = { count: 0 };
    for (const tool of toolsSource) {
      const source = record(tool);
      if (!source) {
        kept.push(tool);
        continue;
      }
      // A provider that runs server tools keeps them: dropping one it can execute throws away a
      // capability the user is paying for, and the loss is invisible (see `serverTools`).
      if (source.type !== undefined && source.type !== "custom" && !caps.serverTools) {
        dropped++;
        if (typeof source.name === "string") droppedNames.add(source.name);
        continue;
      }
      const next = { ...source };
      if ("defer_loading" in next) {
        delete next.defer_loading;
        deferred++;
      }
      // A strict regex engine refuses the whole request over one pattern it cannot compile:
      // DeepSeek's Anthropic endpoint answers 400 `"^[^\\0]*$" is not a "regex"` for the Artifact
      // tool (issue #51). The client validates its own tool input, so the pattern adds nothing here.
      if (next.input_schema !== undefined) next.input_schema = scrubSchema(next.input_schema, patterns);
      kept.push(next);
    }
    if (deferred > 0) changes.push(`defer_loading×${deferred}`);
    if (dropped > 0) changes.push(`server_tools×${dropped}`);
    if (patterns.count > 0) changes.push(`pattern×${patterns.count}`);
    if (deferred > 0 || dropped > 0 || patterns.count > 0 || folded.lifted.length > 0) {
      // Every lifted tool dropped leaves nothing to declare; an empty array is a field the vendor
      // still validates, so it goes rather than going empty.
      if (kept.length === 0 && !Array.isArray(out.tools)) delete out.tools;
      else out.tools = kept;
    }
    const toolChoice = record(out.tool_choice);
    if (toolChoice && typeof toolChoice.name === "string" && droppedNames.has(toolChoice.name)) {
      delete out.tool_choice;
      changes.push("tool_choice");
    }
    // The instruction text for a dropped tool stays in the prompt unless withdrawn (see the note's
    // own comment). Appended after the caller's blocks, without cache_control, so the prefix up to
    // Claude Code's breakpoints is untouched.
    const note = droppedServerToolNote(droppedNames);
    if (note) {
      out.system = appendSystemText(out.system, note);
      changes.push("server_tool_note");
    }
  }

  if ("system" in out) {
    const next = stripBillingHeader(out.system);
    if (next.removed > 0) {
      // An emptied array would be a system the provider has to reject; the field goes with the block.
      if (Array.isArray(next.value) && next.value.length === 0) delete out.system;
      else out.system = next.value;
      changes.push(`billing_header×${next.removed}`);
    }
  }

  if (!caps.cacheControl) {
    let removed = 0;
    for (const key of ["system", "messages"]) {
      if (!(key in out)) continue;
      const next = stripCacheControl(out[key]);
      out[key] = next.value;
      removed += next.count;
    }
    if (removed > 0) changes.push(`cache_control×${removed}`);
  }

  return { json: out, changes };
}
