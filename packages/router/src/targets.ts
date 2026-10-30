/**
 * Shared facts about providers the router can target, the models they own, their effort ladders and
 * their server-side search capability. Validation refuses an Anthropic provider with
 * `accountPool: true` and auth other than `"claude-code"`, but startup adopts an invalid initial
 * config; such a provider is treated as ingress-only here everywhere instead of reaching the proxy
 * and answering 400.
 */

import type { Config } from "./config.ts";
import { resolveCompatibleCaps } from "./compat.ts";
import { PRESETS } from "./presets.ts";
import { CHATGPT_FALLBACK_MODELS } from "./providers/chatgpt/catalog.ts";
import { GROK_EFFORT_LEVELS } from "./providers/grok/catalog.ts";

/** A provider can take routed requests unless it is an `anthropic` provider without its OAuth account
 * pool. The pool is `accountPool: true` with `auth: "claude-code"`; anything else serves the OpenAI
 * ingress only. */
export function isTargetProvider(provider: Config["providers"][string] | undefined): boolean {
  if (!provider) return false;
  return provider.type !== "anthropic" || (provider.accountPool === true && provider.auth === "claude-code");
}

/** Whether this configured provider serves the OpenAI ingress but cannot take routed requests. */
export function ingressOnly(cfg: Config, name: string): boolean {
  const provider = cfg.providers[name];
  return provider?.type === "anthropic" && !isTargetProvider(provider);
}

/** A colon is a qualifier only when its prefix is a configured owner of the remaining id.
 * Otherwise the whole id (including Ollama's qwen3:8b) keeps its existing meaning. */
export function qualifiedModel(id: string, cfg: Config): { provider: string; model: string } | null {
  const base = id.split("@")[0]!;
  const colon = base.indexOf(":");
  if (colon <= 0) return null;
  const provider = base.slice(0, colon);
  const model = base.slice(colon + 1);
  return Object.hasOwn(cfg.providers, provider) && rawDeclaredBy(model, cfg).includes(provider) ? { provider, model } : null;
}

/** Declared owners, including ingress-only providers. Qualified ids select one declared owner;
 * dated and undated forms match just as they do for slots. Never guess an ambiguous bare id. */
export function declaredBy(id: string, cfg: Config): string[] {
  const qualified = qualifiedModel(id, cfg);
  return qualified ? [qualified.provider] : rawDeclaredBy(id.split("@")[0]!, cfg);
}

export function rawDeclaredBy(id: string, cfg: Config): string[] {
  const undated = id.replace(/-\d{8}$/, "");
  const owners: string[] = [];
  for (const [name, provider] of Object.entries(cfg.providers)) {
    const models = provider.models;
    if (!models?.length) continue;
    if (models.some((m) => m.id === id || m.id === undated || m.id.replace(/-\d{8}$/, "") === undated)) owners.push(name);
  }
  return owners;
}

/** The one provider declaring this id, or null when none or several do. */
export function soleOwner(id: string, cfg: Config): string | null {
  const owners = declaredBy(id, cfg);
  return owners.length === 1 ? owners[0]! : null;
}

// The CLI's `--effort` takes the same five; Opus, Sonnet and Haiku 5.5 answered `xhigh` (requests.jsonl, 2026-10-14, #56).
const ANTHROPIC_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CHATGPT_DEFAULT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** Shared catalog for the GUI: model-specific values override provider defaults. */
export function effortLevels(cfg: Config): { providers: Record<string, { default: string[]; models?: Record<string, string[]> }> } {
  const providers: Record<string, { default: string[]; models?: Record<string, string[]> }> = {
    anthropic: { default: ANTHROPIC_EFFORT_LEVELS },
  };
  for (const [name, provider] of Object.entries(cfg.providers)) {
    if (provider.type === "chatgpt") {
      // The backend's catalogue is the truth about which models exist and what each supports, but
      // it lives behind a login and a network call, so the measured fallback list carries the
      // per-model ladders (ultra on astra/sol/5.6 terra+sol, not on either Luna) and any config
      // entries the user has saved override them.
      const models: Record<string, string[]> = Object.fromEntries(
        CHATGPT_FALLBACK_MODELS.filter((model) => model.effortLevels !== undefined).map((model) => [model.id, [...model.effortLevels!]]),
      );
      for (const model of provider.models ?? []) if (model.effortLevels !== undefined) models[model.id] = [...model.effortLevels];
      providers[name] = { default: CHATGPT_DEFAULT_EFFORT_LEVELS, ...(Object.keys(models).length ? { models } : {}) };
      continue;
    }
    const modelLevels = Object.fromEntries(
      (provider.models ?? [])
        .filter((model) => model.effortLevels !== undefined)
        .map((model) => [model.id, [...model.effortLevels!]]),
    );
    if (provider.type === "openai-compatible") {
      providers[name] = {
        default: provider.caps?.reasoning === "effort" ? (provider.caps.effortLevels ?? []) : [],
        ...(Object.keys(modelLevels).length ? { models: modelLevels } : {}),
      };
      continue;
    }
    if (provider.type === "google") {
      // Gemini exposes its ladder per model (the probe fills `effortLevels`); there is no
      // provider-wide default, so the union of what the models declared is the fallback.
      const levels = [...new Set((provider.models ?? []).flatMap((model) => model.effortLevels ?? []))];
      providers[name] = { default: levels, ...(Object.keys(modelLevels).length ? { models: modelLevels } : {}) };
      continue;
    }
    if (provider.type === "anthropic") {
      providers[name] = { default: ANTHROPIC_EFFORT_LEVELS };
      continue;
    }
    if (provider.type === "grok") {
      // The proxy's listing gives each model its ladder (the probe saves it); a model it has not
      // described gets the common one, which is also what the adapter sends it.
      providers[name] = { default: [...GROK_EFFORT_LEVELS], ...(Object.keys(modelLevels).length ? { models: modelLevels } : {}) };
      continue;
    }
    const preset = provider.preset ? PRESETS.find((entry) => entry.id === provider.preset) : undefined;
    providers[name] = {
      default: resolveCompatibleCaps(preset ? { effortLevels: preset.effortLevels, thinking: preset.thinking, ...(preset.serverTools ? { serverTools: true } : {}) } : undefined, provider.caps).effortLevels,
      ...(Object.keys(modelLevels).length ? { models: modelLevels } : {}),
    };
  }
  return { providers };
}

/**
 * Whether this provider executes Anthropic's server-side tools (`web_search`) itself, rather than
 * having them dropped on the way out. Only an anthropic-compatible provider whose preset or caps
 * say so, measured per provider. Two routes to the same vendor can differ: DeepSeek's own endpoint
 * runs it, while the same model through OpenCode Go does not.
 */
/**
 * Whether this provider executes Anthropic's server-side tools (`web_search`) itself, rather than
 * having them dropped on the way out. Only an anthropic-compatible provider whose preset or caps
 * say so, measured per provider (`serverTools` in compat.ts). Two routes to the same vendor can
 * differ: DeepSeek's own endpoint runs it, the same model through OpenCode Go does not.
 */
export function runsServerTools(cfg: Config, name: string): boolean {
  const provider = cfg.providers[name];
  // A routed native account still calls Anthropic's Messages API unchanged, so Anthropic executes
  // its own server tools. Only translated/compatible providers need an explicit measured capability.
  if (provider?.type === "anthropic") return isTargetProvider(provider);
  if (!provider || provider.type !== "anthropic-compatible") return false;
  const preset = provider.preset ? PRESETS.find((entry) => entry.id === provider.preset) : undefined;
  return resolveCompatibleCaps(preset ? { ...(preset.serverTools ? { serverTools: true } : {}) } : undefined, provider.caps).serverTools;
}

/**
 * Whether this provider can actually run a web search: measured capability, not an assumption from
 * the vendor name. Native and compatible providers through server tools (above), ChatGPT through its
 * hosted search, an `openai-compatible` provider never: its web plugin is a vendor extension, and
 * OpenCode Go's silently ignores it, leaving the model to answer with invented results. A configured
 * `webSearch` backend is deliberately not counted: it serves the search for the session, but a model
 * still cannot search by itself, which is what a slot points at.
 */
export function answersWebSearch(cfg: Config, name: string): boolean {
  if (cfg.providers[name]?.type === "chatgpt") return true;
  return runsServerTools(cfg, name);
}

/** Rules the config accepts but routing ignores, one sentence each. */
export function targetWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  for (const [alias, route] of Object.entries(cfg.routes)) {
    if (ingressOnly(cfg, route.provider)) warnings.push(`route "${alias}" names "${route.provider}", which serves the OpenAI ingress only; requests for it pass through to Anthropic`);
  }
  for (const rule of cfg.direct) {
    if (ingressOnly(cfg, rule.provider)) warnings.push(`direct rule "${rule.prefix}" names "${rule.provider}", which serves the OpenAI ingress only; requests it matches pass through to Anthropic`);
  }
  return warnings;
}
