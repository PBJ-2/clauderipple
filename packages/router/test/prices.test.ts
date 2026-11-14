import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelScoreCatalog, type ScoreDataset } from "../src/model-scores.ts";
import { chargeOf, priceOf, setAaPriceDataset } from "../src/prices.ts";

const ATTRIBUTION = "Data: Artificial Analysis (artificialanalysis.ai)";

/** A dataset with only what prices.ts reads: each model's AA base and per-MTok prices. */
function aa(models: { base: string; priceIn: number | null; priceOut: number | null }[]): ScoreDataset {
  return {
    attribution: ATTRIBUTION,
    generatedAt: "2026-11-09T00:00:00.000Z",
    models: models.map((m, i) => ({ slug: `${m.base}-${i}`, base: m.base, effort: null, intelligence: null, costPerTask: null, priceIn: m.priceIn, priceOut: m.priceOut })),
  };
}

afterEach(() => setAaPriceDataset(null));

test("Haiku 5.5 is priced at the base rate up to a 100K prompt, and at the long-prompt rate above it", () => {
  // Exactly 100K is still the base tier ("at most 100K"); one token more is the long-prompt tier.
  assert.deepEqual(priceOf("anthropic", "claude-haiku-5-5", 100_000), { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125, cacheReadOfficial: true, cacheWriteOfficial: true });
  assert.deepEqual(priceOf("anthropic", "claude-haiku-5-5", 100_001), { input: 0.50, output: 2.50, cacheRead: 0.05, cacheWrite: 0.625, cacheReadOfficial: true, cacheWriteOfficial: true });
  assert.deepEqual(priceOf("anthropic", "claude-haiku-5-5", 5_000), { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125, cacheReadOfficial: true, cacheWriteOfficial: true });
});

test("Claude ids take their official rate with a dated, account or effort suffix, and no AA data is needed", () => {
  assert.deepEqual(priceOf("anthropic", "claude-opus-5-5-8301ce12", 1), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheReadOfficial: true, cacheWriteOfficial: true });
  assert.deepEqual(priceOf("anthropic", "claude-opus-5-5@high", 1), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheReadOfficial: true, cacheWriteOfficial: true });
  assert.deepEqual(priceOf("anthropic", "claude-sonnet-5-5-20261001", 1), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheReadOfficial: true, cacheWriteOfficial: true });
  // Opus and Sonnet have no long-prompt rate: a 300K prompt still pays the base rate.
  assert.deepEqual(priceOf("anthropic", "claude-opus-5-5", 300_000), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheReadOfficial: true, cacheWriteOfficial: true });
});

test("Fable and the earlier Claude models take the official page's rates (2026-11-10), not AA's", () => {
  // Fable 5.2 showed no cost: it was missing from the table and AA had no match.
  assert.deepEqual(priceOf("anthropic", "claude-fable-5-2", 1), { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, cacheReadOfficial: true, cacheWriteOfficial: true });
  assert.deepEqual(priceOf("anthropic", "claude-fable-5-1-f952fac6", 1), { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheReadOfficial: true, cacheWriteOfficial: true });
  assert.deepEqual(priceOf("anthropic", "claude-fable-5", 1), { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheReadOfficial: true, cacheWriteOfficial: true });
  assert.deepEqual(priceOf("anthropic", "claude-opus-4-20250514", 1), { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheReadOfficial: true, cacheWriteOfficial: true });
  assert.deepEqual(priceOf("anthropic", "claude-haiku-4-5", 1), { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheReadOfficial: true, cacheWriteOfficial: true });
  setAaPriceDataset(aa([{ base: "claude-opus-5", priceIn: 99, priceOut: 99 }]));
  assert.deepEqual(priceOf("anthropic", "claude-opus-5", 1), { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheReadOfficial: true, cacheWriteOfficial: true });
});

test("a Claude model outside the table falls through to AA, and is unpriced when AA has no match", () => {
  assert.equal(priceOf("anthropic", "claude-opus-9", 1), null);
  setAaPriceDataset(aa([{ base: "claude-opus-9", priceIn: 5, priceOut: 25 }]));
  assert.deepEqual(priceOf("anthropic", "claude-opus-9", 1), { input: 5, output: 25, cacheRead: 5, cacheWrite: 5, cacheReadOfficial: false, cacheWriteOfficial: false });
});

test("a request's cost is input x input rate + cached x cache-read rate + cache-write x cache-write rate + output x output rate, per MTok", () => {
  const price = priceOf("anthropic", "claude-haiku-5-5", 3_500);
  assert.ok(price);
  // 1,000 x 0.10 + 2,000 x 0.01 + 500 x 0.125 + 300 x 0.50 = 332.5 (per MTok), so 0.0003325 USD.
  assert.equal(chargeOf(price, { input: 1_000, cached: 2_000, cacheWrite: 500, output: 300 }).usd, 0.0003325);
  assert.equal(chargeOf(price, { input: 0, cached: 0, cacheWrite: 0, output: 0 }).usd, 0);
});

test("a non-Claude model takes AA's input and output prices, with its cache prices falling back to the AA input price", () => {
  setAaPriceDataset(aa([{ base: "nova-pro", priceIn: 1.5, priceOut: 6 }]));
  // No page gives this model a cache price, so neither cache rate is official.
  assert.deepEqual(priceOf("opencode-go", "nova-pro", 10), { input: 1.5, output: 6, cacheRead: 1.5, cacheWrite: 1.5, cacheReadOfficial: false, cacheWriteOfficial: false });
});

test("an official cache-read price is used for the model it names; its cache write is not official", () => {
  setAaPriceDataset(aa([{ base: "gpt-5-5", priceIn: 5, priceOut: 30 }]));
  // The model id is matched through the same normalisation AA records get, so `@high` does not matter.
  assert.deepEqual(priceOf("openai", "gpt-5.5@high", 10), { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5, cacheReadOfficial: true, cacheWriteOfficial: false });
});

test("a tiered official cache-read price switches at its threshold (xAI: 200k)", () => {
  setAaPriceDataset(aa([{ base: "grok-4-7", priceIn: 2, priceOut: 6 }]));
  assert.equal(priceOf("xai-grok", "grok-4.7", 199_999)?.cacheRead, 0.5);
  assert.equal(priceOf("xai-grok", "grok-4.7", 200_000)?.cacheRead, 1);
});

test("a model in neither the Claude table nor the AA dataset is unpriced, and so is one whose AA record has no price", () => {
  assert.equal(priceOf("chatgpt", "mystery-model", 10), null);
  setAaPriceDataset(aa([{ base: "free-model", priceIn: null, priceOut: null }]));
  assert.equal(priceOf("opencode-go", "free-model", 10), null);
});

test("an undated model id is priced from the AA base that carries a release stamp, and a base's own name wins over it", () => {
  // AA files the snapshot (`deepseek-v4-1-flash-1017`); OpenCode Go serves `deepseek-v4.1-flash`, which showed no cost.
  setAaPriceDataset(aa([{ base: "deepseek-v4-1-flash-1017", priceIn: 0.3, priceOut: 1.2 }]));
  // Its cached read is the page's Peak row (0.006), not the input price: fifty times less.
  assert.deepEqual(priceOf("opencode-go", "deepseek-v4.1-flash", 10), { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3, cacheReadOfficial: true, cacheWriteOfficial: false });
  assert.equal(priceOf("opencode-go", "deepseek-v4.1-flash@max", 10)?.input, 0.3);
  assert.equal(priceOf("deepseek", "deepseek-v4-1-flash-1017", 10)?.output, 1.2);
  // Once AA files the undated name as well, that record is the id's price.
  setAaPriceDataset(aa([{ base: "deepseek-v4-1-flash-1017", priceIn: 0.3, priceOut: 1.2 }, { base: "deepseek-v4-1-flash", priceIn: 0.5, priceOut: 2 }]));
  assert.equal(priceOf("opencode-go", "deepseek-v4.1-flash", 10)?.input, 0.5);
  // Even without a price on it: the id is then unpriced, not priced as the snapshot.
  setAaPriceDataset(aa([{ base: "deepseek-v4-1-flash-1017", priceIn: 0.3, priceOut: 1.2 }, { base: "deepseek-v4-1-flash", priceIn: null, priceOut: null }]));
  assert.equal(priceOf("opencode-go", "deepseek-v4.1-flash", 10), null);
});

test("an undated id stays unpriced when two stamped snapshots share its name, or when the trailing number is no date", () => {
  setAaPriceDataset(aa([{ base: "deepseek-v4-1-flash-1017", priceIn: 0.3, priceOut: 1.2 }, { base: "deepseek-v4-1-flash-1105", priceIn: 0.4, priceOut: 1.6 }]));
  assert.equal(priceOf("opencode-go", "deepseek-v4.1-flash", 10), null);
  assert.equal(priceOf("opencode-go", "deepseek-v4-1-flash-1105", 10)?.input, 0.4);
  // 8000 is not a month and day: `nova-8000` is that model's own name, and `nova` is another model.
  setAaPriceDataset(aa([{ base: "nova-8000", priceIn: 1, priceOut: 2 }]));
  assert.equal(priceOf("opencode-go", "nova", 10), null);
  assert.equal(priceOf("opencode-go", "nova-8000", 10)?.input, 1);
});

test("a provider's own variant that AA has no record of takes the provider page's price, not the plain model's", () => {
  // AA lists the plain model only. The Contributor variant is OpenCode Go's discounted offer (0.10 in, 0.20 out, 0.002 cached read).
  setAaPriceDataset(aa([{ base: "muse-spark-1-3", priceIn: 1.25, priceOut: 4.25 }]));
  const page = { input: 0.10, output: 0.20, cacheRead: 0.002, cacheWrite: 0.10, cacheReadOfficial: true, cacheWriteOfficial: false };
  assert.deepEqual(priceOf("opencode-go", "muse-spark-1.3-contributor", 10), page);
  assert.deepEqual(priceOf("opencode-go", "muse-spark-1.3-contributor@high", 10), page);
  assert.deepEqual(priceOf("opencode-go", "muse-spark-1.2-contributor", 10), page);
  assert.equal(priceOf("opencode-go", "muse-spark-1.3", 10)?.input, 1.25);
  // The page gives the cached read price, so a cache read is no estimate; it shows no cache-write price.
  assert.equal(chargeOf(page, { input: 1_000, cached: 500, cacheWrite: 0, output: 100 }).estimated, false);
  assert.equal(chargeOf(page, { input: 1_000, cached: 500, cacheWrite: 10, output: 100 }).estimated, true);
  // The page price needs no AA data.
  setAaPriceDataset(null);
  assert.deepEqual(priceOf("opencode-go", "muse-spark-1.3-contributor", 10), page);
  // AA wins once it has a record of the variant: the table fills a gap, it does not correct AA.
  setAaPriceDataset(aa([{ base: "muse-spark-1-3-contributor", priceIn: 0.12, priceOut: 0.24 }]));
  assert.deepEqual(priceOf("opencode-go", "muse-spark-1.3-contributor", 10), { input: 0.12, output: 0.24, cacheRead: 0.002, cacheWrite: 0.12, cacheReadOfficial: true, cacheWriteOfficial: false });
});

test("a model of OpenCode Go's table that AA has no record of takes the table's price, tiered where the table is", () => {
  // No AA data at all: these come from the provider page alone.
  assert.deepEqual(priceOf("opencode-go", "hy3", 10), { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0.14, cacheReadOfficial: true, cacheWriteOfficial: false });
  assert.deepEqual(priceOf("opencode-go", "glm-5.2", 10), { input: 1.40, output: 4.40, cacheRead: 0.26, cacheWrite: 1.40, cacheReadOfficial: true, cacheWriteOfficial: false });
  assert.deepEqual(priceOf("opencode-go", "kimi-k2.7-code@high", 10), { input: 0.95, output: 4.00, cacheRead: 0.19, cacheWrite: 0.95, cacheReadOfficial: true, cacheWriteOfficial: false });
  // Qwen3.7 Plus: "≤ 256K tokens" is the base row, one token more is the long-prompt row, cached read included.
  assert.deepEqual(priceOf("opencode-go", "qwen3.7-plus", 256_000), { input: 0.40, output: 1.60, cacheRead: 0.04, cacheWrite: 0.40, cacheReadOfficial: true, cacheWriteOfficial: false });
  assert.deepEqual(priceOf("opencode-go", "qwen3.7-plus", 256_001), { input: 1.20, output: 4.80, cacheRead: 0.12, cacheWrite: 1.20, cacheReadOfficial: true, cacheWriteOfficial: false });
  // Every paid id of the table that AA lacked on 2026-11-14 is priced.
  for (const model of ["longcat-2.0", "step-5-preview", "mimo-v2.5", "mimo-v2.5-pro", "qwen3.8-flash", "hy4", "hy4-preview"]) assert.ok((priceOf("opencode-go", model, 10)?.input ?? 0) > 0, model);
  // AA still wins for a model it lists; the table then gives only the cached read.
  setAaPriceDataset(aa([{ base: "hy3", priceIn: 0.2, priceOut: 0.8 }, { base: "mimo-v2-6-pro", priceIn: 0.435, priceOut: 0.87 }]));
  assert.equal(priceOf("opencode-go", "hy3", 10)?.input, 0.2);
  assert.deepEqual(priceOf("opencode-go", "mimo-v2.6-pro", 10), { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0.435, cacheReadOfficial: true, cacheWriteOfficial: false });
});

test("a free model costs nothing and is priced, not unpriced", () => {
  for (const model of ["beam-free", "iceman-contributor-free", "longcat-2.5-free"]) {
    const price = priceOf("opencode-go", model, 10);
    assert.deepEqual(price, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheReadOfficial: true, cacheWriteOfficial: false }, model);
    assert.equal(chargeOf(price!, { input: 1_000_000, cached: 1_000_000, cacheWrite: 0, output: 1_000_000 }).usd, 0);
  }
});

test("Kimi's cached read and write are the page's: a read at its own rate, a write at the input rate, neither an estimate", () => {
  setAaPriceDataset(aa([{ base: "kimi-k3", priceIn: 3, priceOut: 15 }, { base: "kimi-k3-1-pro", priceIn: 2, priceOut: 10 }, { base: "qwen3-8-max", priceIn: 2, priceOut: 6 }]));
  const k3 = priceOf("opencode-go", "kimi-k3", 10);
  assert.deepEqual(k3, { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3, cacheReadOfficial: true, cacheWriteOfficial: true });
  assert.deepEqual(priceOf("opencode-go", "kimi-k3.1-pro", 10), { input: 2, output: 10, cacheRead: 0.20, cacheWrite: 2, cacheReadOfficial: true, cacheWriteOfficial: true });
  assert.equal(chargeOf(k3!, { input: 1_000, cached: 500, cacheWrite: 10, output: 100 }).estimated, false);
  // Qwen3.8 Max: the read is the page's (0.25), but its write costs more than input, so a write is still an estimate.
  const qwen = priceOf("opencode-go", "qwen3.8-max", 10);
  assert.equal(qwen?.cacheRead, 0.25);
  assert.equal(chargeOf(qwen!, { input: 1_000, cached: 500, cacheWrite: 0, output: 100 }).estimated, false);
  assert.equal(chargeOf(qwen!, { input: 1_000, cached: 500, cacheWrite: 10, output: 100 }).estimated, true);
});

test("a request is estimated only when it uses a cache component that is not official", () => {
  setAaPriceDataset(aa([{ base: "nova-pro", priceIn: 1.5, priceOut: 6 }, { base: "gpt-5-5", priceIn: 5, priceOut: 30 }]));
  const kimi = priceOf("opencode-go", "nova-pro", 10);
  const gpt = priceOf("openai", "gpt-5.5", 10);
  const claude = priceOf("anthropic", "claude-haiku-5-5", 10);
  assert.ok(kimi && gpt && claude);
  // No cache tokens at all: priced from AA input and output alone, so not estimated.
  assert.equal(chargeOf(kimi, { input: 1_000, cached: 0, cacheWrite: 0, output: 100 }).estimated, false);
  // Cache reads on Kimi: the read price is AA's input price, not an official figure.
  assert.equal(chargeOf(kimi, { input: 1_000, cached: 500, cacheWrite: 0, output: 100 }).estimated, true);
  // Cache reads on GPT-5.5: the read price is official, and no write happened.
  assert.equal(chargeOf(gpt, { input: 1_000, cached: 500, cacheWrite: 0, output: 100 }).estimated, false);
  // Any cache write on GPT-5.5 uses a price that is not official, however the reads were priced.
  assert.equal(chargeOf(gpt, { input: 1_000, cached: 500, cacheWrite: 10, output: 100 }).estimated, true);
  // Claude's cache prices are official, writes included.
  assert.equal(chargeOf(claude, { input: 1_000, cached: 500, cacheWrite: 10, output: 100 }).estimated, false);
});

test("the AA dataset a ModelScoreCatalog loads or refreshes is the one prices follow", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-prices-catalog-"));
  try {
    const envelope = (priceIn: number) => ({
      source: "https://artificialanalysis.ai",
      attribution: ATTRIBUTION,
      generatedAt: "2026-11-09T00:00:00.000Z",
      models: [{ slug: "nova-pro-0", base: "nova-pro", name: "Kimi K3", creator: "x", releaseDate: "2026-10-01", effort: null, intelligence: null, costPerTask: null, priceIn, priceOut: 6, intelligenceEstimated: null, checkedAt: null }],
    });
    // A fetch refreshes the dataset, and the prices follow it.
    const fetched = new ModelScoreCatalog({
      home,
      fetch: (async () => new Response(JSON.stringify(envelope(1.5)))) as unknown as typeof fetch,
      onDataset: setAaPriceDataset,
      warn: () => {},
    });
    assert.equal(priceOf("opencode-go", "nova-pro", 10), null);
    assert.ok(await fetched.get());
    assert.equal(priceOf("opencode-go", "nova-pro", 10)?.input, 1.5);

    // A fresh catalog reads the disk cache the fetch wrote, and the prices follow that load too.
    fs.writeFileSync(path.join(home, "aa-models.json"), JSON.stringify(envelope(2.5)));
    setAaPriceDataset(null);
    // No network: without its own fetch the catalog reached the published dataset, whose real price won.
    const fromDisk = new ModelScoreCatalog({ home, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, onDataset: setAaPriceDataset, warn: () => {} });
    assert.ok(await fromDisk.get());
    assert.equal(priceOf("opencode-go", "nova-pro", 10)?.input, 2.5);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
