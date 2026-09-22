// The Codex backend's own model catalogue, so a model OpenAI ships appears in ClaudeRipple without
// a router release.
//
// Measured 2026-09-23: GET {base}/codex/models?client_version=<ver> with the subscription's bearer
// answers `{ models: [{ slug, display_name, visibility: "list"|"hide", supported_in_api,
// context_window, supported_reasoning_levels: [{ effort, description }] }] }`. The server filters on
// client_version: 0.146.0 omits the gpt-6-* models that 0.155.0 lists, so the version is read from
// the installed Codex CLI's cache rather than pinned to whatever was current when this was written.
// Everything here tolerates a shape change by returning [] — a catalogue we cannot read must leave
// the caller on its fallback list, not empty the model picker.

import fs from "node:fs";
import path from "node:path";
import type { ProviderModel } from "../../config.ts";
import { codexHome } from "../../../../cli/src/codex.ts";

/** The client_version floor: below this the backend hides models ClaudeRipple already supports. */
export const CODEX_CLIENT_VERSION_FLOOR = "0.155.0";

/**
 * Copied from the Codex catalog 2026-09-23, used only when the live catalog cannot be read. The
 * catalog lists `ultra` on astra, sol and 5.6 terra/sol and not on either Luna — the reverse of a
 * 2026-09-11 measurement (ARCHITECTURE §4); `effortClamp` keeps `ultra` off the wire regardless.
 */
export const CHATGPT_FALLBACK_MODELS: ProviderModel[] = [
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 272000 },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 272000 },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", effortLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 272000 },
  { id: "gpt-6-astra", name: "GPT-6 Astra", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 272000 },
  { id: "gpt-6-sol", name: "GPT-6 Sol", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 272000 },
  { id: "gpt-6-luna", name: "GPT-6 Luna", effortLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 272000 },
];

/** A hyphen that joins a capitalised word ("GPT-6-Sol", "GPT-6-Astra") reads as a space. */
const JOINING_HYPHEN = /-(?=[A-Z])/g;

function displayName(slug: string, display: unknown): string {
  const raw = typeof display === "string" && display.trim() !== "" ? display.trim() : slug;
  return raw.replace(JOINING_HYPHEN, " ");
}

/**
 * The catalogue's `list` entries as provider models. `hide` entries (codex-auto-review,
 * gpt-reserve) are for the CLI's own machinery, not for the user's picker, so they are dropped.
 * Anything unrecognisable yields [].
 */
export function parseCodexCatalog(json: unknown): ProviderModel[] {
  const entries = (json as { models?: unknown } | null | undefined)?.models;
  if (!Array.isArray(entries)) return [];
  const out: ProviderModel[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { slug?: unknown; display_name?: unknown; visibility?: unknown; context_window?: unknown; supported_reasoning_levels?: unknown };
    if (typeof e.slug !== "string" || e.slug === "" || e.visibility !== "list") continue;
    const model: ProviderModel = { id: e.slug, name: displayName(e.slug, e.display_name) };
    if (Array.isArray(e.supported_reasoning_levels)) {
      const levels = e.supported_reasoning_levels
        .map((level) => (level && typeof level === "object" ? (level as { effort?: unknown }).effort : undefined))
        .filter((effort): effort is string => typeof effort === "string" && effort !== "");
      // An empty ladder is meaningful to the config (it disables the provider fallback), so it is
      // carried through rather than omitted.
      model.effortLevels = [...new Set(levels)];
    }
    if (typeof e.context_window === "number" && Number.isFinite(e.context_window) && e.context_window > 0) model.contextWindow = e.context_window;
    out.push(model);
  }
  return out;
}

/** Numeric major.minor.patch comparison; the prerelease suffix is not part of the version. */
function compareVersions(a: string, b: string): number {
  const segments = (v: string): number[] => v.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const x = segments(a);
  const y = segments(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The version to ask the catalogue with: the installed Codex CLI's, from the cache it writes
 * (`<codexHome>/models_cache.json`, honouring `CODEX_HOME`), but never below the floor — an older
 * CLI must not cost us the models the newer backend would list. Missing or unreadable file, or a
 * version that is not numeric, answers the floor.
 */
export function codexClientVersion(home = codexHome()): string {
  let cached: unknown;
  try {
    cached = (JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8")) as { client_version?: unknown }).client_version;
  } catch {
    return CODEX_CLIENT_VERSION_FLOOR;
  }
  if (typeof cached !== "string" || !/^\d+(\.\d+)*/.test(cached)) return CODEX_CLIENT_VERSION_FLOOR;
  // "0.155.1-nightly.3" is 0.155.1 as far as the backend's filter is concerned.
  const core = cached.split("-")[0]!;
  return compareVersions(core, CODEX_CLIENT_VERSION_FLOOR) > 0 ? core : CODEX_CLIENT_VERSION_FLOOR;
}
