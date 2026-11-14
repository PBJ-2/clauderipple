// What a request would cost at API list prices. These are API-price equivalents, not a bill: a Claude
// Code subscription pays a plan, and a provider's own price list may differ from the figures here.
// Every price is USD per million tokens (MTok).
import fs from "node:fs";
import { aaBaseIndex, normalizeAaBase, parseScoreDataset, type ScoreDataset } from "./model-scores.ts";

/**
 * Which rates are official is kept per component. A request is estimated only when it uses a
 * component that is not official (see `chargeOf`), so a request with no cache tokens is not.
 */
export type ModelPrice = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheReadOfficial: boolean; cacheWriteOfficial: boolean };
export type TokenCounts = { input: number; cached: number; cacheWrite: number; output: number };

type ClaudeRate = { input: number; output: number; cacheWrite: number; cacheRead: number };
type ClaudePrice = { rate: ClaudeRate; long?: ClaudeRate };

/**
 * Anthropic's official price page (https://platform.claude.com/docs/en/about-claude/pricing), read on
 * 2026-11-10: every model of its main and "Additional models" tables. `cacheWrite` is the 5-minute write
 * column. Haiku 5.5 costs more above a 100K-token prompt: `long` applies to prompts above
 * LONG_PROMPT_TOKENS (exactly 100K stays on the base rate). Fast mode (Fable 5.2, Opus 5.5, Opus 5,
 * Opus 4.8) is not priced: no record carries a field that says a request ran in it.
 */
const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  "claude-fable-5-2": { rate: { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 } },
  "claude-mythos-5-2": { rate: { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 } },
  "claude-opus-5-5": { rate: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
  "claude-sonnet-5-5": { rate: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 } },
  "claude-haiku-5-5": {
    rate: { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
    long: { input: 0.50, output: 2.50, cacheWrite: 0.625, cacheRead: 0.05 },
  },
  "claude-fable-5-1": { rate: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 } },
  "claude-mythos-5-1": { rate: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 } },
  "claude-fable-5": { rate: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
  "claude-mythos-5": { rate: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
  "claude-opus-5": { rate: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  "claude-opus-4-8": { rate: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  "claude-opus-4-7": { rate: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  "claude-opus-4-6": { rate: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  "claude-opus-4-5": { rate: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  "claude-opus-4-1": { rate: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  "claude-opus-4": { rate: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 } },
  "claude-sonnet-5": { rate: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
  "claude-sonnet-4-6": { rate: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  "claude-sonnet-4-5": { rate: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  "claude-sonnet-4": { rate: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  "claude-haiku-4-5": { rate: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
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
 * - OpenCode Go: https://opencode.ai/docs/go/ ("Usage limits" table), read 2026-11-14 in a browser
 *
 * Left out on purpose: Gemini 3.8/3.6 Flash (price changes 2027-01-01), Gemini 2.5 (deprecated),
 * and Gemini 4 Argon (OpenCode Go's table halves it through 2026-11-30, and Google's own page was
 * not read for it). Kimi's own page shows no cache price: its entries are OpenCode Go's.
 *
 * OpenCode Go's rows agree with the provider pages above wherever both give a figure (GLM, MiniMax,
 * Grok 4.7, GPT Luna), so its rows stand in for the models whose own page was not read. An entry
 * is found by model id alone, so it prices that id on any provider that serves it.
 *
 * DeepSeek's price depends on the hour, peak or off-peak (half). It was left out for that until
 * 2026-11-14, when its requests were first priced at all: the fallback read 34M cached tokens of a
 * month at the input price, $11.28 where the peak rate gives $1.29. Its entries are the Peak row,
 * the rate AA's input and output prices already are (0.30 / 1.20, 1.32 / 3.96), so an off-peak
 * request is priced at up to twice what it cost. No record's hour is priced.
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
  // OpenCode Go: the Contributor variants' cached read column. Cache write not shown.
  "muse-spark-1.3-contributor": [{ from: 0, read: 0.002 }],
  "muse-spark-1.2-contributor": [{ from: 0, read: 0.002 }],
  // DeepSeek, from OpenCode Go's table: the Peak rows (see above). Cache write not shown.
  "deepseek-v4.1-flash": [{ from: 0, read: 0.006 }],
  "deepseek-v4-pro": [{ from: 0, read: 0.044 }],
  // OpenCode Go's table, cached read column (2026-11-14), for the rest of its models.
  "kimi-k3.1-pro": [{ from: 0, read: 0.20 }],
  "kimi-k3": [{ from: 0, read: 0.30 }],
  "kimi-k2.7-code": [{ from: 0, read: 0.19 }],
  "longcat-2.0": [{ from: 0, read: 0.006 }],
  "step-5-preview": [{ from: 0, read: 0.10 }],
  "mimo-v2.6-flash": [{ from: 0, read: 0.0028 }],
  "mimo-v2.6-pro": [{ from: 0, read: 0.003625 }],
  "mimo-v2.5": [{ from: 0, read: 0.0028 }],
  "mimo-v2.5-pro": [{ from: 0, read: 0.003625 }],
  "qwen3.8-max": [{ from: 0, read: 0.25 }],
  "qwen3.8-flash": [{ from: 0, read: 0.016 }],
  // The page's "≤ 256K tokens" and "> 256K tokens" rows.
  "qwen3.7-plus": [{ from: 0, read: 0.04 }, { from: 256_001, read: 0.12 }],
  "hy4": [{ from: 0, read: 0.042 }],
  "hy4-preview": [{ from: 0, read: 0.042 }],
  "hy3": [{ from: 0, read: 0.035 }],
  // Free for a limited time: the page's row is "Free" in every column.
  "beam-free": [{ from: 0, read: 0 }],
  "iceman-contributor-free": [{ from: 0, read: 0 }],
  "longcat-2.5-free": [{ from: 0, read: 0 }],
};
// Keys are normalised the same way AA records are, so `gpt-6.1-sol@high` and `gpt-6-1-sol` both match.
const CACHE_TABLE = new Map(Object.entries(OFFICIAL_CACHE_READ).map(([model, tiers]) => [normalizeAaBase(model), tiers] as const));

/**
 * A provider page's input and output price for a model the AA dataset has no record of. AA wins
 * where it has one: this fills a gap, it does not correct AA.
 *
 * OpenCode Go's Contributor variants (https://opencode.ai/docs/go/, "Usage limits" table, read
 * 2026-11-14) are a provider's own offer, not a model AA lists: the page sells them at a heavy
 * discount in exchange for training on the prompts. AA's `muse-spark-1-3` ($1.25 in, $4.25 out) is
 * the plain model, so reading the variant as that base would price it 12 to 21 times too high.
 *
 * The other entries are the models of that table AA had no record of on 2026-11-14 (its dataset
 * keeps a year of measured models). A tier applies to a prompt of at least `from` tokens, as a
 * cache tier does. A free model is priced at zero: it costs nothing, which is not "no known price".
 */
type PageTier = { from: number; priceIn: number; priceOut: number };
const PAGE_PRICES: Record<string, PageTier[]> = {
  "muse-spark-1.3-contributor": [{ from: 0, priceIn: 0.10, priceOut: 0.20 }],
  "muse-spark-1.2-contributor": [{ from: 0, priceIn: 0.10, priceOut: 0.20 }],
  "glm-5.2": [{ from: 0, priceIn: 1.40, priceOut: 4.40 }],
  "kimi-k2.7-code": [{ from: 0, priceIn: 0.95, priceOut: 4.00 }],
  "longcat-2.0": [{ from: 0, priceIn: 0.30, priceOut: 1.20 }],
  "step-5-preview": [{ from: 0, priceIn: 1.00, priceOut: 2.70 }],
  "mimo-v2.5": [{ from: 0, priceIn: 0.14, priceOut: 0.28 }],
  "mimo-v2.5-pro": [{ from: 0, priceIn: 0.435, priceOut: 0.87 }],
  "qwen3.8-flash": [{ from: 0, priceIn: 0.15, priceOut: 0.47 }],
  // The page's "≤ 256K tokens" and "> 256K tokens" rows.
  "qwen3.7-plus": [{ from: 0, priceIn: 0.40, priceOut: 1.60 }, { from: 256_001, priceIn: 1.20, priceOut: 4.80 }],
  "hy4": [{ from: 0, priceIn: 0.834, priceOut: 2.501 }],
  "hy4-preview": [{ from: 0, priceIn: 0.834, priceOut: 2.501 }],
  "hy3": [{ from: 0, priceIn: 0.14, priceOut: 0.58 }],
  // Free for a limited time.
  "beam-free": [{ from: 0, priceIn: 0, priceOut: 0 }],
  "iceman-contributor-free": [{ from: 0, priceIn: 0, priceOut: 0 }],
  "longcat-2.5-free": [{ from: 0, priceIn: 0, priceOut: 0 }],
};
const PAGE_TABLE = new Map(Object.entries(PAGE_PRICES).map(([model, tiers]) => [normalizeAaBase(model), tiers] as const));

function pagePriceOf(key: string, promptTokens: number): PageTier | null {
  const tiers = PAGE_TABLE.get(key);
  if (!tiers) return null;
  let price = tiers[0]!;
  for (const tier of tiers) if (promptTokens >= tier.from) price = tier;
  return price;
}

/** AA price per MTok, under every normalised id a base answers to (`aaBaseIndex`). Empty until a dataset loads. */
let aaPrices = new Map<string, { priceIn: number; priceOut: number }>();

/**
 * Replace the AA prices with those of a dataset (null clears them). The first variant with both prices
 * wins for a base, the same way the model table reads a base's first variant. A base is found under
 * the ids the score table finds it under, so a release-stamped base prices the undated id too.
 */
export function setAaPriceDataset(dataset: ScoreDataset | null): void {
  const models = dataset?.models ?? [];
  const byBase = new Map<string, { priceIn: number; priceOut: number }>();
  for (const model of models) {
    if (byBase.has(model.base) || model.priceIn === null || model.priceOut === null) continue;
    byBase.set(model.base, { priceIn: model.priceIn, priceOut: model.priceOut });
  }
  // Indexed over every base, priced or not: an unpriced base keeps its own name from a stamped sibling.
  const next = new Map<string, { priceIn: number; priceOut: number }>();
  for (const [id, base] of aaBaseIndex(models.map(model => model.base))) {
    const price = byBase.get(base);
    if (price) next.set(id, price);
  }
  aaPrices = next;
}

/**
 * Load the AA dataset from the disk cache the score catalog keeps (`aa-models.json` in the router's home).
 * Called once at startup, so a request made before the scores page is ever opened is still priced.
 * A missing or unreadable cache leaves the table empty and every request AA would have priced unpriced.
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
  return { input: rate.input, output: rate.output, cacheRead: rate.cacheRead, cacheWrite: rate.cacheWrite, cacheReadOfficial: true, cacheWriteOfficial: true };
}

function cacheReadOf(model: string, promptTokens: number): number | null {
  const tiers = CACHE_TABLE.get(normalizeAaBase(model));
  if (!tiers) return null;
  let read = tiers[0]!.read;
  for (const tier of tiers) if (promptTokens >= tier.from) read = tier.read;
  return read;
}

/**
 * Models whose provider's page says a cache write is billed as normal input, so the write is official
 * too. OpenCode Go's table gives Kimi K3 and K3.1 Pro a cached write price equal to their input price
 * (3.00, 2.00; read 2026-11-14). No other model is here: OpenAI's page prices cache writes at a
 * model-dependent rate, Google's implicit caching page does not say how writes are billed, and the
 * xAI page could not be read (404), while MiniMax and Z.AI show no cache-write price. OpenCode Go's
 * Qwen rows give a write price above the input price, which no field here carries, so a Qwen cache
 * write stays an estimate. Add a normalised base here only with a page that says so.
 */
const WRITE_BILLED_AS_INPUT = new Set<string>(["kimi-k3", "kimi-k3-1-pro"]);

/**
 * The USD per MTok price of one request, or null when the model is unpriced.
 *
 * Claude models (provider `anthropic`, or a model id whose base is one of the table's Claude ids) use
 * the official table. Every other model takes input and output from the AA dataset, or from
 * PAGE_PRICES when AA has no record of it. Its cache-read price is the provider's page figure where
 * the table has one (`cacheReadOfficial`), otherwise its input price. Its cache-write price is its
 * input price, official only for a model in WRITE_BILLED_AS_INPUT.
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
  const key = normalizeAaBase(model);
  const listed = aaPrices.get(key) ?? pagePriceOf(key, promptTokens);
  if (!listed) return null;
  const read = cacheReadOf(model, promptTokens);
  return {
    input: listed.priceIn, output: listed.priceOut,
    cacheRead: read ?? listed.priceIn, cacheWrite: listed.priceIn,
    cacheReadOfficial: read !== null, cacheWriteOfficial: WRITE_BILLED_AS_INPUT.has(key),
  };
}

/**
 * One request's USD cost at a price, and whether it is estimated: true only when a component the
 * request actually uses (cache reads, cache writes) is not official. Counts are tokens, not MTok.
 */
export function chargeOf(price: ModelPrice, tokens: TokenCounts): { usd: number; estimated: boolean } {
  const usd = (tokens.input * price.input + tokens.cached * price.cacheRead + tokens.cacheWrite * price.cacheWrite + tokens.output * price.output) / 1_000_000;
  const estimated = (tokens.cached > 0 && !price.cacheReadOfficial) || (tokens.cacheWrite > 0 && !price.cacheWriteOfficial);
  return { usd, estimated };
}
