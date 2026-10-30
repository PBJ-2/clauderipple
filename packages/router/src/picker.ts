// Picker mode: put real model names into the Claude Desktop model picker.
//
// The picker list comes from claude.ai's bootstrap response (`model_selector_config`, an
// array of surfaces, each with `models[]`). The renderer forwards the chosen id to the app,
// which passes it to the CLI unchecked (docs/ARCHITECTURE.md §3). So when the app's own
// traffic goes through ClaudeRipple, we add our entries to the Code surface here.
//
// We do not know every field of a model entry, so we clone an existing enabled Claude
// entry as a template and override the identifying fields. Surfaces are matched by id
// heuristically (anything that is not the claude.ai chat surface); the ids we saw are
// logged once so the heuristic can be tightened.

import type { CliModel, Config } from "./config.ts";
import { resolve } from "./routing.ts";
import { clampEffort } from "./compat.ts";
import { isJudgeOnlyModel } from "./model-policy.ts";
import { chatgptModelWindow } from "./providers/chatgpt/windows.ts";

export const BOOTSTRAP_PATHS = ["/edge-api/bootstrap", "/api/bootstrap"];

export function isBootstrapPath(path: string): boolean {
  return BOOTSTRAP_PATHS.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
}

type ModelEntry = Record<string, unknown> & { id?: string };
type Surface = Record<string, unknown> & { id?: string; models?: ModelEntry[] };

// Surfaces whose sessions run through the Claude Code CLI (and therefore through the router).
// Measured 2026-09-13: app_start had chat, code, ccr, ccd, cowork, design, office_agent, chrome, voice,
// claude_science; the Code tab list matched code/ccd/ccr (9 entries). Chat & co. never reach the CLI.
const CLI_SURFACES = new Set(["code", "ccd", "ccr", "cowork"]);

function isClaudeEntry(m: ModelEntry): boolean {
  return typeof m.id === "string" && m.id.startsWith("claude-");
}

function pickTemplate(models: ModelEntry[]): ModelEntry | null {
  return models.find((m) => isClaudeEntry(m) && !m.disabled && m.section !== "deprecated" && m.section !== "legacy") ?? models.find(isClaudeEntry) ?? null;
}

/**
 * The effort menu for one routed model: the template's own options, narrowed to the levels the
 * model takes.
 *
 * The app builds the menu per entry from `thinking.effort_options` (`effortOptionsFor: e =>
 * …effort_options ?? []` in the Code tab bundle, read 2026-10-02), so a cloned Claude entry offered
 * Claude's whole ladder for a model that takes three of it. The template's option objects are kept
 * as they are — they carry the app's localised labels, and an id the app does not know (its list is
 * low/medium/high/xhigh/max) is not invented here. `recommended` moves to high, or the level nearest
 * it: when the selected level is not on the list, the app switches to the recommended one (`uw`).
 * A model that takes none of them gets no `thinking` at all, which the app reads as "no effort".
 */
function narrowThinking(entry: ModelEntry, levels: string[]): void {
  const thinking = entry.thinking as { effort_options?: { id?: unknown; recommended?: unknown }[] } | undefined;
  if (!thinking || !Array.isArray(thinking.effort_options)) return;
  const kept = thinking.effort_options.filter((option) => typeof option.id === "string" && levels.includes(option.id));
  if (kept.length === 0) {
    delete entry.thinking;
    return;
  }
  const preferred = clampEffort("high", kept.map((option) => option.id as string));
  entry.thinking = { ...thinking, effort_options: kept.map(({ recommended: _recommended, ...option }) => (option.id === preferred ? { ...option, recommended: true } : option)) };
}

/** Resolve aliases/routes before advertising an entry; a chat-looking alias can target a judge. */
export function chatPickerModels(cfg: Config): CliModel[] {
  return cfg.cli.extraModels
    .filter(entry => !isJudgeOnlyModel(entry.model) && !isJudgeOnlyModel(resolve(entry.model, {}, cfg)?.model ?? cfg.aliases[entry.model.split("@")[0]!] ?? ""))
    .map(entry => {
      // A window the operator set on this entry is the one the router advertises, catalogue or not
      // (`pickerWindowOverride`, §4 2026-10-30).
      if (pickerWindowOverride(cfg, entry.model) !== undefined) return entry;
      // Otherwise a ChatGPT-subscription model follows the live catalogue: config carried 272000
      // for 6.1 Sol while Codex runs 475000 (§4, 2026-10-23).
      const live = chatgptModelWindow(cfg, entry.model);
      if (live) return { ...entry, contextWindow: live };
      if (entry.contextWindow) return entry;
      const window = providerModelWindow(cfg, entry.model);
      return window ? { ...entry, contextWindow: window } : entry;
    });
}

/** The window a provider itself declares for `model`: its `/models` context length, or one set by hand. */
function declaredModelWindow(cfg: Config, model: string): number | undefined {
  const base = model.split("@")[0]!;
  const target = resolve(base, {}, cfg) ?? resolve(cfg.aliases[base] ?? base, {}, cfg);
  if (!target) return undefined;
  const undated = target.model.replace(/-\d{8}$/, "");
  const entry = cfg.providers[target.provider]?.models?.find(m => m.id === target.model || m.id.replace(/-\d{8}$/, "") === undated);
  return entry?.contextWindow;
}

/**
 * The window the operator set on a picker entry (`cli.extraModels[].contextWindow`), or undefined
 * when the entry says nothing of its own. Ticking a model in the dashboard copies the provider's
 * declared window onto its entry (`applyPickerSelections`), so an entry equal to that declaration is
 * the copy and not a choice — today's configs carry 6.1 Sol's stale 272000 exactly that way and
 * must keep following the live catalogue. An explicit `route.contextWindow` still wins over this
 * (docs/ARCHITECTURE.md §4, 2026-10-30).
 */
export function pickerWindowOverride(cfg: Config, model: string): number | undefined {
  const base = model.split("@")[0]!;
  const saved = cfg.cli.extraModels.find(m => m.model.split("@")[0] === base)?.contextWindow;
  if (!(typeof saved === "number" && Number.isFinite(saved) && saved > 0)) return undefined;
  return saved === declaredModelWindow(cfg, model) ? undefined : saved;
}

/**
 * The window a provider declared for `model` (its `/models` context length, or one set by hand),
 * by id without an `@effort` suffix or through an alias. A picker entry saved without a window of
 * its own used to fall to `cli.autoCompactWindow` although its provider knew better: a 1M MiniMax
 * subagent compacted twice at ~240K (2026-10-21). A ChatGPT-subscription model answers from the
 * live catalogue first, ahead of the provider's own stored figure (`chatgptModelWindow`, §4
 * 2026-10-23); an operator's override is handled by the callers above and wins over both.
 */
export function providerModelWindow(cfg: Config, model: string): number | undefined {
  const live = chatgptModelWindow(cfg, model);
  if (live) return live;
  return declaredModelWindow(cfg, model);
}

/** Provider-bound capacity, shared by bootstrap's keys and the context-window API. */
export function resolvedModelWindow(cfg: Config, id: string, nativeWindow?: number): { model: string; provider: string | null; contextWindow: number | null } {
  const base = id.split("@")[0]!;
  const route = cfg.routes[base] ?? cfg.routes[base.replace(/-\d{8}$/, "")];
  const target = resolve(id, {}, cfg) ?? (cfg.aliases[base] ? resolve(cfg.aliases[base], {}, cfg) : null);
  const model = target?.model.split("@")[0] ?? base;
  const provider = target ? cfg.providers[target.provider] : undefined;
  const explicit = target && !cfg.direct.some(d => base.startsWith(d.prefix)) ? route?.contextWindow : undefined;
  // The window the operator set on the picker entry, then the live catalogue, then whatever the
  // provider declares (the entry holds a copy of that same figure when nothing was chosen).
  const chosen = pickerWindowOverride(cfg, base) ?? pickerWindowOverride(cfg, model);
  const declared = provider?.models?.find(m => m.id === model || m.id.replace(/-\d{8}$/, "") === model.replace(/-\d{8}$/, ""))?.contextWindow;
  const known = target ? explicit ?? chosen ?? chatgptModelWindow(cfg, id) ?? declared : nativeWindow;
  return { model, provider: target?.provider ?? null, contextWindow: typeof known === "number" && Number.isFinite(known) && known > 0 ? Math.floor(known) : null };
}

export type PickerModelEntry = { id: string; name: string };
export type InjectResult = { injected: number; surfaces: { id: string; models: string[]; entries: PickerModelEntry[] }[] };

/**
 * Mutates `json` in place; returns what was done for logging. `effortFor` names the levels a model
 * takes (by its id without an `@effort` suffix); undefined leaves the template's menu as it is.
 */
export function injectPickerModels(json: Record<string, unknown>, extra: CliModel[], contextWindow?: number, effortFor?: (model: string) => string[] | undefined): InjectResult {
  const result: InjectResult = { injected: 0, surfaces: [] };
  extra = extra.filter(e => !isJudgeOnlyModel(e.model));
  const msc = json.model_selector_config;
  if (!Array.isArray(msc) || extra.length === 0) return result;
  for (const surface of msc as Surface[]) {
    if (!surface || typeof surface !== "object" || !Array.isArray(surface.models)) continue;
    const id = String(surface.id ?? "");
    result.surfaces.push({
      id,
      models: surface.models.map((m) => String(m.id ?? "?")),
      entries: surface.models.map((m) => ({ id: String(m.id ?? "?"), name: typeof m.name === "string" ? m.name : String(m.id ?? "?") })),
    });
    if (!CLI_SURFACES.has(id)) continue;
    const template = pickTemplate(surface.models);
    if (!template) continue;
    const existing = new Set(surface.models.map((m) => m.id));
    for (const e of extra) {
      if (existing.has(e.model)) continue;
      const entry: ModelEntry = { ...structuredClone(template), id: e.model, name: e.name };
      const w = e.contextWindow ?? contextWindow;
      if (w) entry.context_window = w;
      else delete entry.context_window;
      if (e.description) entry.description = e.description;
      else delete entry.description;
      for (const k of ["disabled", "disabled_reason", "notice", "selection_notice", "badge", "badge_tooltip", "tooltip", "minimum_tier", "is_default"]) delete entry[k];
      entry.section = "main";
      const levels = effortFor?.(e.model.split("@")[0]!);
      if (levels) narrowThinking(entry, levels);
      surface.models.push(entry);
      result.injected++;
    }
    // Per-entry window first: routed models do not share one, and `contextWindow` is only the fallback.
    for (const key of ["context_window_by_model", "contextWindowByModel"]) {
      const map = surface[key];
      if (!map || typeof map !== "object") continue;
      for (const e of extra) {
        const w = e.contextWindow ?? contextWindow;
        if (w) (map as Record<string, number>)[e.model] = w;
      }
    }
    const recorded = result.surfaces[result.surfaces.length - 1]!;
    recorded.models = surface.models.map((m) => String(m.id ?? "?"));
    recorded.entries = surface.models.map((m) => ({ id: String(m.id ?? "?"), name: typeof m.name === "string" ? m.name : String(m.id ?? "?") }));
  }
  return result;
}
