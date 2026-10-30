// One capacity and effective-compaction policy for bootstrap settings and usage readers.
import type { Config } from "./config.ts";
import { homeDir } from "./config.ts";
import { bootstrapModels, bootstrapWindows, CLI_WINDOW_MAX } from "./bootstrap.ts";
import { declaredBy, resolve } from "./routing.ts";
import { chatgptModelWindow } from "./providers/chatgpt/windows.ts";
import { claudeSettingsPath } from "./mod-settings.ts";
import { effectiveCompactWindow, readCompactSettings, syncCompactWindows } from "../../cli/src/compact-windows.ts";
import { readOwners } from "../../cli/src/owners.ts";
import { pickerWindowOverride, resolvedModelWindow } from "./picker.ts";

export type ResolvedWindow = { model: string; provider: string | null; contextWindow: number | null; compactWindow: number | null };

/** Never write native Claude settings, even when an account-pool route resolves to Anthropic. */
export function routedCompactWindows(cfg: Config, agentDirs?: string[]): Record<string, number> {
  const raw = bootstrapWindows(cfg, bootstrapModels(cfg, agentDirs));
  return Object.fromEntries(Object.entries(raw).filter(([id]) => {
    const target = resolve(id, {}, cfg);
    return target !== null && cfg.providers[target.provider]?.type !== "anthropic";
  }).map(([id, capacity]) => [id, Math.min(capacity, CLI_WINDOW_MAX)]));
}

export function syncContextWindows(cfg: Config, agentDirs?: string[], home = homeDir()): boolean {
  return syncCompactWindows(claudeSettingsPath(), home, routedCompactWindows(cfg, agentDirs));
}

export function contextWindowSnapshot(cfg: Config, natives: { id: string; contextWindow?: number }[], agentDirs?: string[]): { windows: Record<string, number>; catalogWindows: Record<string, number>; resolvedWindows: Record<string, ResolvedWindow> } {
  const windows: Record<string, number> = {};
  const catalogWindows: Record<string, number> = {};
  const resolvedWindows: Record<string, ResolvedWindow> = {};
  const settings = readCompactSettings(claudeSettingsPath());
  const record = readOwners(claudeSettingsPath());
  if (record.error) throw new Error(record.error);
  const advertised = bootstrapWindows(cfg, bootstrapModels(cfg, agentDirs));
  const put = (id: string, fallback?: number, native = false): void => {
    if (resolvedWindows[id]) return;
    const resolved = resolvedModelWindow(cfg, id, native ? fallback : undefined);
    // Unknown capacities remain unknown; only bootstrap's managed keys retain its historic fallback.
    const capacity = resolved.contextWindow;
    const cliCapacity = resolved.provider && cfg.providers[resolved.provider]?.type !== "anthropic" && capacity !== null ? Math.min(capacity, CLI_WINDOW_MAX) : capacity;
    resolvedWindows[id] = { ...resolved, compactWindow: effectiveCompactWindow(id, cliCapacity, settings, record.store) };
    const base = id.split("@")[0]!;
    if (!resolved.provider && declaredBy(base, cfg).length > 1) return;
    const route = cfg.routes[base] ?? cfg.routes[base.replace(/-\d{8}$/, "")];
    const live = chatgptModelWindow(cfg, id);
    // The window the operator set on the picker entry wins over the catalogue; a route window wins
    // over both (2026-10-30). The catalogue's own figure is still reported below so the editor can
    // prefill it as the default, whether or not it is the value in use.
    const saved = pickerWindowOverride(cfg, base) ?? pickerWindowOverride(cfg, resolved.model);
    const value = route?.contextWindow ?? saved ?? live ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
    windows[id] = Math.floor(value);
    if (live !== undefined && route?.contextWindow === undefined) catalogWindows[id] = Math.floor(live);
  };
  for (const model of natives) put(model.id, model.contextWindow, true);
  for (const model of cfg.cli.extraModels) put(model.model, model.contextWindow ?? cfg.cli.autoCompactWindow);
  for (const [name, provider] of Object.entries(cfg.providers)) {
    for (const model of provider.models ?? []) {
      put(model.id, model.contextWindow, provider.type === "anthropic");
      if (declaredBy(model.id, cfg).length > 1) put(`${name}:${model.id}`, model.contextWindow, provider.type === "anthropic");
    }
  }
  for (const id of new Set([...Object.keys(cfg.routes), ...Object.keys(cfg.aliases), ...Object.keys(advertised)])) put(id, advertised[id]);
  return { windows, catalogWindows, resolvedWindows };
}
