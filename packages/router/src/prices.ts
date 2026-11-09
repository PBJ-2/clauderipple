// What a request would cost at API list prices. These are API-price equivalents, not a bill: a Claude
// Code subscription pays a plan, and a provider's own price list may differ from the figures here.
// Every price is USD per million tokens (MTok).
import fs from "node:fs";
import { normalizeAaBase, parseScoreDataset, type ScoreDataset } from "./model-scores.ts";

/** `estimated` is true when any part of the price is not an official figure (see `priceOf`). */
export type ModelPrice = { input: number; output: number; cacheRead: number; cacheWrite: number; estimated: boolean };
export type TokenCounts = { input: number; cached: number; cacheWrite: number; output: number };

type ClaudeRate = { input: number; output: number; cacheWrite: number; cacheRead: number };
type ClaudePrice = { rate: ClaudeRate; long?: ClaudeRate };

/**
 * Anthropic's official price page, as the owner read it on 2026-11-09. Haiku 5.5 costs more above a
 * 100K-token prompt: `long` applies to prompts above LONG_PROMPT_TOKENS (exactly 100K stays on the base rate).
 * Opus 5.5's fast mode is not priced: no record carries a field that says a request ran in it.
 */
const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  "claude-haiku-5-5": {
    rate: { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
    long: { input: 0.50, output: 2.50, cacheWrite: 0.625, cacheRead: 0.05 },
  },
  "claude-sonnet-5-5": { rate: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 } },
  "claude-opus-5-5": { rate: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
};
const LONG_PROMPT_TOKENS = 100_000;

/**
 * One provider page's cache-read price. A tier applies to a prompt of at least `from` tokens; the
 * tiers are ascending and the first starts at 0.
 *
 * Sources, read on 2026-11-09 with WebFetch (the figures are as the fetch's summary returned them;
 * re-check them against the pages before relying on a cent):
 * - OpenAI: https://developers.openai.com/api/docs/pricing (redirected from platform.openai.com)
 * - xAI: https://docs.x.ai/docs/models
 * - MiniMax: https://platform.minimax.io/docs/guides/pricing-paygo
 * - Z.AI: https://docs.z.ai/guides/overview/pricing
 * - Google: https://aistudio.google.com/docs/pricing (redirected from ai.google.dev)
 *
 * Left out on purpose: Gemini 3.8/3.6 Flash (price changes 2027-01-01), Gemini 2.5 (deprecated),
 * DeepSeek (the cache price depends on the hour, peak or off-peak), and Kimi (its page shows no cache price).
 */
type CacheTier = { from: number; read: number };
const OFFICIAL_CACHE_READ: Record<string, CacheTier[]> = {
  // OpenAI API, cached input column (2026-11-09). Pro models show no cached-input price.
  "gpt-6-astra": [{ from: 0, read: 1.00 }],
  "gpt-6-sol": [{ from: 0, read: 0.20 }],
  "gpt-6-luna": [{ from: 0, read: 0.01 }],
  "gpt-6.1-sol": [{ from: 0, read: 0.10 }],
  "gpt-6.1-terra": [{ from: 0, read: 0.05 }],
  "gpt-5.6-sol": [{ from: 0, read: 0.40 }],
  "gpt-5.6-terra": [{ from: 0, read: 0.20 }],
  "gpt-5.6-luna": [{ from: 0, read: 0.02 }],
  "gpt-5.5": [{ from: 0, read: 0.50 }],
  "gpt-5.4": [{ from: 0, read: 0.25 }],
  "gpt-5.4-mini": [{ from: 0, read: 0.075 }],
  "gpt-5.4-nano": [{ from: 0, read: 0.02 }],
  "gpt-5.2": [{ from: 0, read: 0.175 }],
  "gpt-5.1": [{ from: 0, read: 0.125 }],
  "gpt-5": [{ from: 0, read: 0.125 }],
  "gpt-5-mini": [{ from: 0, read: 0.025 }],
  "gpt-5-nano": [{ from: 0, read: 0.005 }],
  "gpt-4.1": [{ from: 0, read: 0.50 }],
  "gpt-4.1-mini": [{ from: 0, read: 0.10 }],
  "gpt-4o": [{ from: 0, read: 1.25 }],
  "gpt-4o-mini": [{ from: 0, read: 0.075 }],
  "o3": [{ from: 0, read: 0.50 }],
  // xAI: the page's "< 200k" and "≥ 200k" rows.
  "grok-4.7": [{ from: 0, read: 0.50 }, { from: 200_000, read: 1.00 }],
  "grok-4.6": [{ from: 0, read: 0.50 }, { from: 200_000, read: 1.00 }],
  "grok-4.5": [{ from: 0, read: 0.30 }, { from: 200_000, read: 0.60 }],
  "grok-4.3": [{ from: 0, read: 0.20 }, { from: 200_000, read: 0.40 }],
  // MiniMax: standard tier; the priority tier is not told apart in a record. Cache write not shown.
  "MiniMax-M3.1-Flash": [{ from: 0, read: 0.015 }],
  "MiniMax-M3": [{ from: 0, read: 0.06 }, { from: 512_001, read: 0.12 }],
  // Z.AI: the page's cached input column.
  "glm-5.3": [{ from: 0, read: 0.26 }],
  "glm-5.3-flash": [{ from: 0, read: 0.03 }],
  "glm-5.2": [{ from: 0, read: 0.26 }],
  "glm-5.1": [{ from: 0, read: 0.26 }],
  "glm-5": [{ from: 0, read: 0.2 }],
  "glm-4.7": [{ from: 0, read: 0.11 }],
  "glm-4.6": [{ from: 0, read: 0.11 }],
  "glm-4.5": [{ from: 0, read: 0.11 }],
  // Google (Standard tier, paid): ≤200k and >200k rows for the Pro model.
  "gemini-3-flash-preview": [{ from: 0, read: 0.05 }],
  "gemini-3.5-flash-lite": [{ from: 0, read: 0.03 }],
  "gemini-3.1-flash-lite": [{ from: 0, read: 0.025 }],
  "gemini-3.1-pro-preview": [{ from: 0, read: 0.20 }, { from: 200_001, read: 0.40 }],
};
// Keys are normalised the same way AA records are, so `gpt-6.1-sol@high` and `gpt-6-1-sol` both match.
const CACHE_TABLE = new Map(Object.entries(OFFICIAL_CACHE_READ).map(([model, tiers]) => [normalizeAaBase(model), tiers] as const));

/** AA price per MTok, keyed the way `buildModelScores` keys them (`variant.base`). Empty until a dataset loads. */
let aaPrices = new Map<string, { priceIn: number; priceOut: number }>();

/**
 * Replace the AA prices with those of a dataset (null clears them). The first variant with both prices
 * wins for a base, the same way the model table reads a base's first variant.
 */
export function setAaPriceDataset(dataset: ScoreDataset | null): void {
  const next = new Map<string, { priceIn: number; priceOut: number }>();
  for (const model of dataset?.models ?? []) {
    if (next.has(model.base) || model.priceIn === null || model.priceOut === null) continue;
    next.set(model.base, { priceIn: model.priceIn, priceOut: model.priceOut });
  }
  aaPrices = next;
}

/**
 * Load the AA dataset from the disk cache the score catalog keeps (`aa-models.json` in the router's home).
 * Called once at startup, so a request made before the scores page is ever opened is still priced.
 * A missing or unreadable cache leaves the table empty and every non-Claude request unpriced.
 */
export function loadAaPricesFrom(file: string): void {
  try {
    setAaPriceDataset(parseScoreDataset(JSON.parse(fs.readFileSync(file, "utf8"))));
  } catch {
    setAaPriceDataset(null);
  }
}

function claudeBase(model: string): string {
  return model.toLowerCase().split("/").at(-1)!.replace(/@[a-z]+$/, "").replace(/-(?:\d{8}|[0-9a-f]{8})$/, "");
}

function claudePrice(model: string, promptTokens: number): ModelPrice | null {
  const entry = CLAUDE_PRICES[claudeBase(model)];
  if (!entry) return null;
  const rate = entry.long && promptTokens > LONG_PROMPT_TOKENS ? entry.long : entry.rate;
  return { input: rate.input, output: rate.output, cacheRead: rate.cacheRead, cacheWrite: rate.cacheWrite, estimated: false };
}

function cacheReadOf(model: string, promptTokens: number): number | null {
  const tiers = CACHE_TABLE.get(normalizeAaBase(model));
  if (!tiers) return null;
  let read = tiers[0]!.read;
  for (const tier of tiers) if (promptTokens >= tier.from) read = tier.read;
  return read;
}

/**
 * The USD per MTok price of one request, or null when the model is unpriced.
 *
 * Claude models (provider `anthropic`, or a model id whose base is one of the table's Claude ids) use
 * the official table and are not estimated. Every other model takes its input and output from the AA
 * dataset. Its cache-read price is the provider's own page's figure where one exists, and its
 * cache-write price is the AA input price. No provider page here shows a separate cache-write price,
 * so every non-Claude price is `estimated: true`.
 *
 * `servedTier` is accepted so a tier-specific price can be added once a record carries one; no
 * current field says a request ran in a fast or priority tier, so it does not change the price.
 */
export function priceOf(provider: string, model: string, promptTokens: number, servedTier?: string): ModelPrice | null {
  // The provider is not needed for a Claude id (the id alone names the price) and does not change the AA match.
  void provider;
  void servedTier;
  const claude = claudePrice(model, promptTokens);
  if (claude) return claude;
  const aa = aaPrices.get(normalizeAaBase(model));
  if (!aa) return null;
  const read = cacheReadOf(model, promptTokens) ?? aa.priceIn;
  return { input: aa.priceIn, output: aa.priceOut, cacheRead: read, cacheWrite: aa.priceIn, estimated: true };
}

/** USD for one request's counts at a price. Counts are tokens, not MTok. */
export function costUsd(price: ModelPrice, tokens: TokenCounts): number {
  return (tokens.input * price.input + tokens.cached * price.cacheRead + tokens.cacheWrite * price.cacheWrite + tokens.output * price.output) / 1_000_000;
}
