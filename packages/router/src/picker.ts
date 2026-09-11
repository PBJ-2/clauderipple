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

import type { CliModel } from "./config.ts";

export const BOOTSTRAP_PATHS = ["/edge-api/bootstrap", "/api/bootstrap"];

export function isBootstrapPath(path: string): boolean {
  return BOOTSTRAP_PATHS.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
}

type ModelEntry = Record<string, unknown> & { id?: string };
type Surface = Record<string, unknown> & { id?: string; models?: ModelEntry[] };

const CHAT_SURFACES = new Set(["chat"]);

function isClaudeEntry(m: ModelEntry): boolean {
  return typeof m.id === "string" && m.id.startsWith("claude-");
}

function pickTemplate(models: ModelEntry[]): ModelEntry | null {
  return models.find((m) => isClaudeEntry(m) && !m.disabled && m.section !== "deprecated" && m.section !== "legacy") ?? models.find(isClaudeEntry) ?? null;
}

export type InjectResult = { injected: number; surfaces: { id: string; models: string[] }[] };

/** Mutates `json` in place; returns what was done for logging. */
export function injectPickerModels(json: Record<string, unknown>, extra: CliModel[], contextWindow?: number): InjectResult {
  const result: InjectResult = { injected: 0, surfaces: [] };
  const msc = json.model_selector_config;
  if (!Array.isArray(msc) || extra.length === 0) return result;
  for (const surface of msc as Surface[]) {
    if (!surface || typeof surface !== "object" || !Array.isArray(surface.models)) continue;
    const id = String(surface.id ?? "");
    result.surfaces.push({ id, models: surface.models.map((m) => String(m.id ?? "?")) });
    if (CHAT_SURFACES.has(id)) continue;
    const template = pickTemplate(surface.models);
    if (!template) continue;
    const existing = new Set(surface.models.map((m) => m.id));
    for (const e of extra) {
      if (existing.has(e.model)) continue;
      const entry: ModelEntry = { ...structuredClone(template), id: e.model, name: e.name };
      if (e.description) entry.description = e.description;
      else delete entry.description;
      for (const k of ["disabled", "disabled_reason", "notice", "selection_notice", "badge", "badge_tooltip", "tooltip", "minimum_tier", "is_default"]) delete entry[k];
      entry.section = "main";
      surface.models.push(entry);
      result.injected++;
    }
    if (contextWindow) {
      for (const key of ["context_window_by_model", "contextWindowByModel"]) {
        const map = surface[key];
        if (map && typeof map === "object") for (const e of extra) (map as Record<string, number>)[e.model] = contextWindow;
      }
    }
  }
  return result;
}
