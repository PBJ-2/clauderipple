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

test("a Claude model outside the table falls through to AA, and is unpriced when AA has no match", () => {
  assert.equal(priceOf("anthropic", "claude-opus-5", 1), null);
  setAaPriceDataset(aa([{ base: "claude-opus-5", priceIn: 5, priceOut: 25 }]));
  assert.deepEqual(priceOf("anthropic", "claude-opus-5", 1), { input: 5, output: 25, cacheRead: 5, cacheWrite: 5, cacheReadOfficial: false, cacheWriteOfficial: false });
});

test("a request's cost is input x input rate + cached x cache-read rate + cache-write x cache-write rate + output x output rate, per MTok", () => {
  const price = priceOf("anthropic", "claude-haiku-5-5", 3_500);
  assert.ok(price);
  // 1,000 x 0.10 + 2,000 x 0.01 + 500 x 0.125 + 300 x 0.50 = 332.5 (per MTok), so 0.0003325 USD.
  assert.equal(chargeOf(price, { input: 1_000, cached: 2_000, cacheWrite: 500, output: 300 }).usd, 0.0003325);
  assert.equal(chargeOf(price, { input: 0, cached: 0, cacheWrite: 0, output: 0 }).usd, 0);
});

test("a non-Claude model takes AA's input and output prices, with its cache prices falling back to the AA input price", () => {
  setAaPriceDataset(aa([{ base: "kimi-k3", priceIn: 1.5, priceOut: 6 }]));
  // Kimi's page shows no cache price, so neither cache rate is official.
  assert.deepEqual(priceOf("opencode-go", "kimi-k3", 10), { input: 1.5, output: 6, cacheRead: 1.5, cacheWrite: 1.5, cacheReadOfficial: false, cacheWriteOfficial: false });
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

test("a request is estimated only when it uses a cache component that is not official", () => {
  setAaPriceDataset(aa([{ base: "kimi-k3", priceIn: 1.5, priceOut: 6 }, { base: "gpt-5-5", priceIn: 5, priceOut: 30 }]));
  const kimi = priceOf("opencode-go", "kimi-k3", 10);
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
      models: [{ slug: "kimi-k3-0", base: "kimi-k3", name: "Kimi K3", creator: "x", releaseDate: "2026-10-01", effort: null, intelligence: null, costPerTask: null, priceIn, priceOut: 6, intelligenceEstimated: null, checkedAt: null }],
    });
    // A fetch refreshes the dataset, and the prices follow it.
    const fetched = new ModelScoreCatalog({
      home,
      fetch: (async () => new Response(JSON.stringify(envelope(1.5)))) as unknown as typeof fetch,
      onDataset: setAaPriceDataset,
      warn: () => {},
    });
    assert.equal(priceOf("opencode-go", "kimi-k3", 10), null);
    assert.ok(await fetched.get());
    assert.equal(priceOf("opencode-go", "kimi-k3", 10)?.input, 1.5);

    // A fresh catalog reads the disk cache the fetch wrote, and the prices follow that load too.
    fs.writeFileSync(path.join(home, "aa-models.json"), JSON.stringify(envelope(2.5)));
    setAaPriceDataset(null);
    const fromDisk = new ModelScoreCatalog({ home, onDataset: setAaPriceDataset, warn: () => {} });
    assert.ok(await fromDisk.get());
    assert.equal(priceOf("opencode-go", "kimi-k3", 10)?.input, 2.5);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
