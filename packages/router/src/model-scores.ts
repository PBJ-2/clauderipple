// AA benchmark scores are metadata only: this module never changes routing or calls providers.
import fs from "node:fs/promises";
import path from "node:path";
import type { Dataset, Effort, Model } from "../../../scripts/aa-dataset-lib.mjs";
import { homeDir, type Config } from "./config.ts";
import { declaredBy, resolve } from "./routing.ts";

export const AA_DATA_URL = "https://raw.githubusercontent.com/PBJ-2/clauderipple/data/aa-models.json";
const ATTRIBUTION = "Data: Artificial Analysis (artificialanalysis.ai)";
const TTL_MS = 24 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;
export type RouterEffort = "low" | "medium" | "high" | "xhigh" | "max";
type ScoreModel = Pick<Model, "slug" | "base" | "effort" | "intelligence" | "costPerTask">;
export type ScoreDataset = Pick<Dataset, "generatedAt" | "attribution"> & { models: ScoreModel[] };
export type ModelScores = {
  attribution: string;
  generatedAt: string | null;
  models: { model: string; provider: string; aaBase: string; variants: { effort: RouterEffort | null; intelligence: number | null; costPerTask: number | null }[]; matched: boolean }[];
};

/** Namespace, @effort and Claude snapshot date are transport spelling, not AA base identity. */
export function normalizeAaBase(model: string): string {
  return model.toLowerCase().split("/").at(-1)!.replace(/@[a-z]+$/, "").replace(/-\d{8}$/, "").replace(/[._]/g, "-");
}

/** AA minimal/non-reasoning have no equivalent in the picker's five-level ladder. Do not mislabel. */
export function mapAaEffort(effort: Effort): RouterEffort | null {
  return effort === "minimal" || effort === "non-reasoning" ? null : effort;
}

/** Only the fields consumed here are validated; full dataset schema belongs to the producer. */
export function parseScoreDataset(raw: unknown): ScoreDataset {
  if (!raw || typeof raw !== "object") throw new Error("invalid AA dataset");
  const d = raw as { source?: unknown; attribution?: unknown; generatedAt?: unknown; models?: unknown };
  if (d.source !== "https://artificialanalysis.ai" || d.attribution !== ATTRIBUTION || typeof d.generatedAt !== "string" || !Number.isFinite(Date.parse(d.generatedAt)) || !Array.isArray(d.models)) throw new Error("invalid AA dataset envelope");
  const models: ScoreModel[] = [];
  const slugs = new Set<string>();
  for (const value of d.models) {
    if (!value || typeof value !== "object") throw new Error("invalid AA model");
    const m = value as ScoreModel;
    const validNumber = (n: unknown): boolean => n === null || (typeof n === "number" && Number.isFinite(n));
    if (typeof m.slug !== "string" || !m.slug || slugs.has(m.slug) || typeof m.base !== "string" || !m.base || ![null, "low", "medium", "high", "xhigh", "max", "minimal", "non-reasoning"].includes(m.effort) || !validNumber(m.intelligence) || !validNumber(m.costPerTask)) throw new Error("invalid AA model score");
    slugs.add(m.slug);
    models.push({ slug: m.slug, base: m.base, effort: m.effort, intelligence: m.intelligence, costPerTask: m.costPerTask });
  }
  return { attribution: ATTRIBUTION, generatedAt: d.generatedAt, models };
}

/** Fetch at most daily, single-flight; offline keeps the last good disk/memory copy and retries hourly. */
export class ModelScoreCatalog {
  private dataset: ScoreDataset | null = null;
  private until = 0;
  private loaded = false;
  private pending: Promise<ScoreDataset | null> | null = null;
  private readonly options: { home?: string; fetch?: typeof fetch; now?: () => number; warn?: (message: string) => void };
  constructor(options: { home?: string; fetch?: typeof fetch; now?: () => number; warn?: (message: string) => void } = {}) { this.options = options; }

  async get(): Promise<ScoreDataset | null> {
    if (this.pending) return this.pending;
    if (this.loaded && this.until > this.now()) return this.dataset;
    this.pending = this.refresh();
    try { return await this.pending; }
    finally { this.pending = null; }
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private warn(message: string): void { (this.options.warn ?? console.warn)(`AA model scores: ${message}`); }

  private async refresh(): Promise<ScoreDataset | null> {
    const file = path.join(this.options.home ?? homeDir(), "aa-models.json");
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.dataset = parseScoreDataset(JSON.parse(await fs.readFile(file, "utf8")));
        // Disk mtime records retrieval, not AA's measurement/publication time. Honour TTL on restart.
        const fetched = (await fs.stat(file)).mtimeMs;
        if (fetched <= this.now()) this.until = fetched + TTL_MS;
      } catch (e) {
        if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) this.warn(`cache unreadable: ${String(e)}`);
      }
    }
    if (this.until > this.now()) return this.dataset;
    let raw: unknown;
    try {
      const response = await (this.options.fetch ?? fetch)(AA_DATA_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      raw = await response.json();
      this.dataset = parseScoreDataset(raw);
      this.until = this.now() + TTL_MS;
    } catch (e) {
      this.until = this.now() + RETRY_MS;
      this.warn(`refresh failed; using ${this.dataset ? "cached scores" : "unmatched models"}: ${String(e)}`);
      return this.dataset;
    }
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(raw, null, 2) + "\n");
      await fs.rename(tmp, file);
    } catch (e) {
      this.warn(`could not persist cache: ${String(e)}`);
      await fs.rm(tmp, { force: true }).catch(error => this.warn(`could not remove temporary cache: ${String(error)}`));
    }
    return this.dataset;
  }
}

/**
 * Enumerate finite configured ids, not hypothetical ids a prefix could accept. Use resolve() so
 * explicit routes/direct precedence and ambiguous owners behave exactly like inference. Native
 * Anthropic declarations remain visible (they are routable via OpenAI ingress, not Messages).
 * Marker aliases contribute their target ids; a slot contributes its resolved target, not the
 * Claude source label. Deduplicate by (provider, model); ambiguous declarations without an
 * explicit rule are not routable and are excluded.
 */
export function buildModelScores(cfg: Config, dataset: ScoreDataset | null): ModelScores {
  const targets = new Map<string, { model: string; provider: string }>();
  const add = (model: string, provider: string): void => {
    if (cfg.providers[provider]) targets.set(`${provider}\0${model}`, { model, provider });
  };
  const declared = new Set(Object.values(cfg.providers).flatMap(p => (p.models ?? []).map(m => m.id)));
  const candidates = new Set([...declared, ...Object.values(cfg.aliases), ...cfg.cli.extraModels.map(m => m.model), ...Object.values(cfg.cli.models ?? {}), ...Object.keys(cfg.routes)]);
  // Fallbacks are explicit provider/model targets even when they are absent from declared lists.
  for (const route of Object.values(cfg.routes)) {
    for (const fallback of route.fallbacks ?? []) {
      const provider = cfg.providers[fallback.provider];
      if (provider && (provider.type !== "anthropic" || provider.accountPool)) add(fallback.model, fallback.provider);
    }
  }
  for (const candidate of candidates) {
    const result = resolve(candidate, {}, cfg);
    if (result) { add(result.model, result.provider); continue; }
    // Native ingress has a separate resolver; do not pretend ambiguous translated models route.
    const owners = declaredBy(candidate, cfg);
    if (owners.length === 1 && cfg.providers[owners[0]!]!.type === "anthropic") add(candidate.replace(/@[a-z]+$/, ""), owners[0]!);
  }
  const groups = new Map<string, ScoreModel[]>();
  for (const variant of dataset?.models ?? []) {
    const group = groups.get(variant.base) ?? [];
    group.push(variant);
    groups.set(variant.base, group);
  }
  const models = [...targets.values()].sort((a, b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider)).map(target => {
    const aaBase = normalizeAaBase(target.model);
    const found = groups.get(aaBase) ?? [];
    return {
      ...target, aaBase,
      variants: [...found].sort((a, b) => a.slug.localeCompare(b.slug)).map(v => ({ effort: mapAaEffort(v.effort), intelligence: v.intelligence, costPerTask: v.costPerTask })),
      matched: found.length > 0,
    };
  });
  return { attribution: dataset?.attribution ?? ATTRIBUTION, generatedAt: dataset?.generatedAt ?? null, models };
}
