// Sanitise Claude Code's Anthropic-only request extensions for providers that expose
// an Anthropic-shaped Messages endpoint without implementing Anthropic's full feature set.
// Pure: callers receive a new object and an audit list; the input is never mutated.

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export type CompatibleCaps = {
  /** Empty means the provider does not accept output_config.effort. */
  effortLevels?: string[];
  /** Whether the provider accepts Anthropic's enabled thinking shape. */
  thinking?: "enabled" | "none";
  /** Whether the provider accepts Anthropic beta flags. Default false. */
  betas?: boolean;
  /** Whether cache_control blocks are accepted. Default true. */
  cacheControl?: boolean;
};

export type ResolvedCompatibleCaps = {
  effortLevels: string[];
  thinking: "enabled" | "none";
  betas: boolean;
  cacheControl: boolean;
};

export const STRICT_COMPAT_CAPS: ResolvedCompatibleCaps = {
  effortLevels: [],
  thinking: "none",
  betas: false,
  cacheControl: true,
};

export function resolveCompatibleCaps(preset?: CompatibleCaps, override?: CompatibleCaps): ResolvedCompatibleCaps {
  return {
    effortLevels: [...(override?.effortLevels ?? preset?.effortLevels ?? STRICT_COMPAT_CAPS.effortLevels)],
    thinking: override?.thinking ?? preset?.thinking ?? STRICT_COMPAT_CAPS.thinking,
    betas: override?.betas ?? preset?.betas ?? STRICT_COMPAT_CAPS.betas,
    cacheControl: override?.cacheControl ?? preset?.cacheControl ?? STRICT_COMPAT_CAPS.cacheControl,
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
 */
export function clampEffort(effort: string, supported: string[]): string {
  if (supported.includes(effort)) return effort;
  const requested = EFFORT_LEVELS.indexOf(effort as EffortLevel);
  const canonical = supported
    .map((value) => ({ value, index: EFFORT_LEVELS.indexOf(value as EffortLevel) }))
    .filter((entry) => entry.index >= 0);
  if (requested < 0 || canonical.length === 0) return supported[0] ?? effort;
  return canonical.reduce((best, candidate) =>
    Math.abs(candidate.index - requested) < Math.abs(best.index - requested) ? candidate : best,
  ).value;
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

/**
 * Remove extensions Claude Code sends only to Anthropic. This deliberately retains content
 * verbatim except cache_control when the provider explicitly rejects prompt caching.
 */
export function sanitizeForCompatible(json: Record<string, unknown>, caps: ResolvedCompatibleCaps): SanitizedCompatibleRequest {
  const out: Record<string, unknown> = { ...json };
  const changes: string[] = [];

  const thinking = record(out.thinking);
  if (thinking) {
    if (thinking.type === "adaptive") {
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

  if (Array.isArray(out.tools)) {
    const kept: unknown[] = [];
    const droppedNames = new Set<string>();
    let deferred = 0;
    let dropped = 0;
    for (const tool of out.tools) {
      const source = record(tool);
      if (!source) {
        kept.push(tool);
        continue;
      }
      if (source.type !== undefined && source.type !== "custom") {
        dropped++;
        if (typeof source.name === "string") droppedNames.add(source.name);
        continue;
      }
      const next = { ...source };
      if ("defer_loading" in next) {
        delete next.defer_loading;
        deferred++;
      }
      kept.push(next);
    }
    if (deferred > 0) changes.push(`defer_loading×${deferred}`);
    if (dropped > 0) changes.push(`server_tools×${dropped}`);
    if (deferred > 0 || dropped > 0) out.tools = kept;
    const toolChoice = record(out.tool_choice);
    if (toolChoice && typeof toolChoice.name === "string" && droppedNames.has(toolChoice.name)) {
      delete out.tool_choice;
      changes.push("tool_choice");
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
