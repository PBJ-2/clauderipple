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

/**
 * The client_version floor: below this the backend hides models ClaudeRipple already supports.
 * 0.158.0 omits gpt-6.1-sol and 0.159.0 lists it (measured 2026-10-10). A floor always trails the
 * next release, so the newest published Codex version is asked for as well (`latestCodexVersion`):
 * a Windows user with no Codex CLI was asking with this floor and never saw 6.1 Sol (issue #50).
 */
export const CODEX_CLIENT_VERSION_FLOOR = "0.159.0";

/**
 * Copied from the Codex catalog 2026-09-23, used only when the live catalog cannot be read. The
 * catalog lists `ultra` on astra, sol and 5.6 terra/sol and not on either Luna — the reverse of a
 * 2026-09-11 measurement (ARCHITECTURE §4); `effortClamp` keeps `ultra` off the wire regardless.
 * gpt-6.1-sol was measured on 2026-10-23 (`context_window: 500000`,
 * `effective_context_window_percent: 95`, so 475000 — the window Codex itself runs with).
 */
export const CHATGPT_FALLBACK_MODELS: ProviderModel[] = [
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 272000 },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 272000 },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", effortLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 272000 },
  { id: "gpt-6-astra", name: "GPT-6 Astra", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 272000 },
  { id: "gpt-6-sol", name: "GPT-6 Sol", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 272000 },
  { id: "gpt-6-luna", name: "GPT-6 Luna", effortLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 272000 },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], contextWindow: 475000 },
];

/**
 * The window Codex itself runs with: `context_window` times `effective_context_window_percent`,
 * rounded down (gpt-6.1-sol: 500000 × 95% = 475000, 2026-10-23). The backend leaves the percent
 * out (2026-10-23, client_version 0.163.0 and 0.164.0: gpt-6.1-sol came back as context_window
 * 500000 alone) while Codex's own models_cache.json records 95 for every model, so Codex fills in
 * 95 itself; a missing or nonsensical percent (not a number, ≤ 0, > 100) gets that same 95.
 */
const CODEX_DEFAULT_WINDOW_PERCENT = 95;

function effectiveWindow(contextWindow: number, percent: unknown): number {
  const pct = typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent : CODEX_DEFAULT_WINDOW_PERCENT;
  return Math.floor((contextWindow * pct) / 100);
}

/** A hyphen that joins a capitalised word ("GPT-6-Sol", "GPT-6-Astra") reads as a space. */
const JOINING_HYPHEN = /-(?=[A-Z])/g;

function displayName(slug: string, display: unknown): string {
  const raw = typeof display === "string" && display.trim() !== "" ? display.trim() : slug;
  return raw.replace(JOINING_HYPHEN, " ");
}

/**
 * The catalogue's `list` entries as provider models. `hide` entries (codex-auto-review,
 * gpt-reserve) are for the CLI's own machinery, not for the user's picker, so they are dropped.
 * `contextWindow` is the effective window Codex runs with (see `effectiveWindow`), not the raw
 * `context_window` — the two differ whenever the backend keeps back a fraction.
 * Anything unrecognisable yields [].
 */
export function parseCodexCatalog(json: unknown): ProviderModel[] {
  const entries = (json as { models?: unknown } | null | undefined)?.models;
  if (!Array.isArray(entries)) return [];
  const out: ProviderModel[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { slug?: unknown; display_name?: unknown; visibility?: unknown; context_window?: unknown; effective_context_window_percent?: unknown; supported_reasoning_levels?: unknown };
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
    if (typeof e.context_window === "number" && Number.isFinite(e.context_window) && e.context_window > 0) model.contextWindow = effectiveWindow(e.context_window, e.effective_context_window_percent);
    out.push(model);
  }
  return out;
}

/**
 * The service tiers each catalogue entry advertises: slug → the ids in `service_tiers` (`priority`
 * is Fast, `ultrafast` is Ultrafast), in the catalogue's order and without repeats.
 *
 * Shape from codex-rs `ModelServiceTier { id, name, description }` (protocol/src/openai_models.rs,
 * read 2026-11-24). The catalogue bundled with the Codex CLI lists `priority` alone; `ultrafast`
 * arrives only in the live answer for a signed-in account, which is why it is read from here and
 * never written into a table. Hidden entries are kept: visibility decides the picker, not the tier.
 * An entry with no readable `service_tiers` maps to []; anything unrecognisable yields an empty map.
 */
export function parseCodexServiceTiers(json: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const entries = (json as { models?: unknown } | null | undefined)?.models;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { slug?: unknown; service_tiers?: unknown };
    if (typeof e.slug !== "string" || e.slug === "") continue;
    const ids = Array.isArray(e.service_tiers)
      ? e.service_tiers
        .map((tier) => (tier && typeof tier === "object" ? (tier as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === "string" && id !== "")
      : [];
    out.set(e.slug, [...new Set(ids)]);
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
 * CLI must not cost us the models the newer backend would list. `latest` (the newest published
 * Codex) wins when it is higher still. Missing or unreadable file, or a version that is not
 * numeric, answers the floor.
 */
export function codexClientVersion(home = codexHome(), latest?: string | null): string {
  let best = CODEX_CLIENT_VERSION_FLOOR;
  const consider = (value: unknown) => {
    if (typeof value !== "string" || !/^\d+(\.\d+)*/.test(value)) return;
    // "0.155.1-nightly.3" is 0.155.1 as far as the backend's filter is concerned.
    const core = value.split("-")[0]!;
    if (compareVersions(core, best) > 0) best = core;
  };
  try {
    consider((JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8")) as { client_version?: unknown }).client_version);
  } catch { /* no Codex CLI here */ }
  consider(latest);
  return best;
}

const NPM_LATEST = "https://registry.npmjs.org/@openai/codex/latest";
const LATEST_TTL_MS = 24 * 60 * 60_000;
const LATEST_RETRY_MS = 60 * 60_000;
let latestCache: { version: string | null; until: number } | null = null;

/**
 * The newest published Codex CLI version, from the npm registry, kept a day; null when the
 * registry cannot be read, which is then not asked again for an hour. Never throws.
 */
export async function latestCodexVersion(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<string | null> {
  if (latestCache && latestCache.until > now) return latestCache.version;
  let version: string | null = null;
  try {
    const res = await fetchImpl(NPM_LATEST, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3_000) });
    const value = res.ok ? ((await res.json()) as { version?: unknown }).version : undefined;
    if (typeof value === "string" && /^\d+\.\d+\.\d+/.test(value)) version = value;
  } catch { /* offline or blocked: the floor and the local CLI still answer */ }
  latestCache = { version, until: now + (version ? LATEST_TTL_MS : LATEST_RETRY_MS) };
  return version;
}
