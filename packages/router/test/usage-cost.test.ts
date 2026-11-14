import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import type { SummaryBucket } from "../src/usage-history.ts";
import { setAaPriceDataset } from "../src/prices.ts";
import type { ScoreDataset } from "../src/model-scores.ts";

const FROM = Date.parse("2026-10-20T00:00:00.000Z");
const TO = Date.parse("2026-10-21T00:00:00.000Z");
const HOUR = 3_600_000;

function record(id: string, at: string, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return { id, at, ms: 100, status: 200, ok: true, kind: "messages", source: "claude-opus", target: "claude-haiku-5-5", provider: "anthropic", stream: true, ...overrides };
}

function usage(input: number, cached: number, output: number, cacheWrite?: number): NonNullable<RequestRecord["usage"]> {
  return { input, cached, output, ...(cacheWrite === undefined ? {} : { cacheWrite }) };
}

function aa(models: { base: string; priceIn: number; priceOut: number }[]): ScoreDataset {
  return {
    attribution: "Data: Artificial Analysis (artificialanalysis.ai)",
    generatedAt: "2026-11-09T00:00:00.000Z",
    models: models.map((m, i) => ({ slug: `${m.base}-${i}`, base: m.base, effort: null, intelligence: null, costPerTask: null, priceIn: m.priceIn, priceOut: m.priceOut })),
  };
}

function withDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-usage-cost-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${expected}, got ${actual}`);
}

afterEach(() => setAaPriceDataset(null));

test("each request is priced when it is added, and the cost survives a restart", () => {
  withDir((dir) => {
    setAaPriceDataset(aa([{ base: "gpt-5-5", priceIn: 5, priceOut: 30 }]));
    const file = path.join(dir, "requests.jsonl");
    const log = new RequestLog(file);
    // Haiku: 1,000 x 0.10 + 2,000 x 0.01 + 500 x 0.125 + 300 x 0.50 = 332.5 per MTok.
    log.add(record("a", "2026-10-20T10:05:00.000Z", { usage: usage(1_000, 2_000, 300, 500) }));
    // A model neither the Claude table nor AA knows: it has tokens, so it is unpriced.
    log.add(record("b", "2026-10-20T10:10:00.000Z", { provider: "chatgpt", target: "mystery-model", usage: usage(10, 0, 5) }));
    // count_tokens costs nothing and is not unpriced, even though it names a model.
    log.add(record("c", "2026-10-20T10:15:00.000Z", { kind: "count_tokens", provider: "chatgpt", target: "mystery-model" }));
    // GPT-5.5 with no cache tokens: 1,000 x 5 + 100 x 30 = 8,000 per MTok, and not estimated (no cache used).
    log.add(record("d", "2026-10-20T10:20:00.000Z", { provider: "openai", target: "gpt-5.5", usage: usage(1_000, 0, 100) }));

    const before = log.usage(FROM, TO);
    near(before.total.costUsd, 0.0003325 + 0.008);
    assert.equal(before.total.unpricedRequests, 1);
    assert.equal(before.total.estimatedRequests, 0);
    near(before.providers["anthropic"]!.costUsd, 0.0003325);
    assert.equal(before.providers["anthropic"]!.estimatedRequests, 0);
    assert.equal(before.providers["chatgpt"]!.unpricedRequests, 1);

    // A fresh log reads the hourly lines it wrote, so the cost is the same after a restart.
    const restarted = new RequestLog(file);
    assert.deepEqual(restarted.usage(FROM, TO).total, before.total);
  });
});

test("the in-memory summary and the hourly usage carry the same cost fields, in both query forms", () => {
  withDir((dir) => {
    setAaPriceDataset(aa([{ base: "gpt-5-5", priceIn: 5, priceOut: 30 }]));
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    log.add(record("a", "2026-10-20T10:05:00.000Z", { usage: usage(1_000, 2_000, 300, 500) }));
    log.add(record("b", "2026-10-20T10:10:00.000Z", { provider: "chatgpt", target: "mystery-model", usage: usage(10, 0, 5) }));

    const fields: (keyof SummaryBucket)[] = ["costUsd", "unpricedRequests", "estimatedRequests"];
    const hourly = log.usage(FROM, TO);
    const memory = log.summary(FROM);
    for (const summary of [hourly, memory]) {
      for (const bucket of [summary.total, ...Object.values(summary.providers), ...summary.models]) {
        for (const field of fields) assert.equal(typeof bucket[field], "number", `${field} is a number`);
      }
    }
    assert.deepEqual(hourly.total, memory.total);
    assert.deepEqual(hourly.providers, memory.providers);
    assert.deepEqual(hourly.models.map((m) => m.costUsd), memory.models.map((m) => m.costUsd));
    // The JSON keeps full precision; rounding to cents is for display only.
    assert.ok(Number.isFinite(hourly.total.costUsd) && hourly.total.costUsd > 0);
  });
});

test("a legacy hourly line (written before costs existed) is priced at summary time, as estimated", () => {
  withDir((dir) => {
    const hour = Math.floor(Date.parse("2026-10-20T10:00:00.000Z") / HOUR);
    // Two Haiku requests with 1,000 input and 100 output tokens in all, and one unpriced request.
    const lines = [
      { h: hour, p: "anthropic", m: "claude-haiku-5-5", count: 2, ok: 2, failed: 0, input: 1_000, cached: 0, cacheWrite: 0, output: 100, ms: 200 },
      { h: hour, p: "chatgpt", m: "mystery-model", count: 1, ok: 1, failed: 0, input: 10, cached: 0, cacheWrite: 0, output: 5, ms: 50 },
    ];
    fs.writeFileSync(path.join(dir, "usage-hourly.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    setAaPriceDataset(null);
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    const summary = log.usage(FROM, TO);
    // Base tier: 1,000 x 0.10 + 100 x 0.50 = 150 per MTok = 0.00015 USD. Both requests count as estimated.
    near(summary.providers["anthropic"]!.costUsd, 0.00015);
    assert.equal(summary.providers["anthropic"]!.estimatedRequests, 2);
    assert.equal(summary.providers["anthropic"]!.unpricedRequests, 0);
    assert.equal(summary.providers["chatgpt"]!.costUsd, 0);
    assert.equal(summary.providers["chatgpt"]!.unpricedRequests, 1);
    near(summary.total.costUsd, 0.00015);
    assert.equal(summary.total.estimatedRequests, 2);
  });
});

test("a legacy line is priced again when the AA dataset arrives, because prices are read at summary time", () => {
  withDir((dir) => {
    const hour = Math.floor(Date.parse("2026-10-20T10:00:00.000Z") / HOUR);
    fs.writeFileSync(path.join(dir, "usage-hourly.jsonl"), JSON.stringify({ h: hour, p: "openai", m: "gpt-5.5", count: 1, ok: 1, failed: 0, input: 1_000, cached: 0, cacheWrite: 0, output: 100, ms: 50 }) + "\n");
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    assert.equal(log.usage(FROM, TO).total.unpricedRequests, 1, "no AA data yet");
    setAaPriceDataset(aa([{ base: "gpt-5-5", priceIn: 5, priceOut: 30 }]));
    const priced = log.usage(FROM, TO).total;
    near(priced.costUsd, 0.008);
    assert.equal(priced.unpricedRequests, 0);
    assert.equal(priced.estimatedRequests, 1);
  });
});

test("an image is billed per image: it costs nothing and is neither unpriced nor estimated", () => {
  withDir((dir) => {
    const hour = Math.floor(Date.parse("2026-10-20T10:00:00.000Z") / HOUR);
    // A legacy image hour (target `image`) with tokens, written before costs existed.
    fs.writeFileSync(path.join(dir, "usage-hourly.jsonl"), JSON.stringify({ h: hour, p: "chatgpt", m: "image", count: 3, ok: 3, failed: 0, input: 30, cached: 0, cacheWrite: 0, output: 300, ms: 900 }) + "\n");
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    log.add(record("img", "2026-10-20T10:30:00.000Z", { kind: "image", provider: "chatgpt", target: "image", usage: usage(10, 0, 5) }));
    const hourly = log.usage(FROM, TO);
    assert.equal(hourly.providers["chatgpt"]!.count, 4);
    assert.equal(hourly.providers["chatgpt"]!.costUsd, 0);
    assert.equal(hourly.providers["chatgpt"]!.unpricedRequests, 0);
    assert.equal(hourly.providers["chatgpt"]!.estimatedRequests, 0);
    // The in-memory ring holds only the new image record, and it costs nothing there too.
    const memory = log.summary(FROM).total;
    assert.equal(memory.count, 1);
    assert.equal(memory.costUsd, 0);
    assert.equal(memory.unpricedRequests, 0);
    assert.equal(memory.estimatedRequests, 0);
  });
});

test("a stored hour flushed while its model was unpriced is priced at read time, its requests counted as estimated", () => {
  withDir((dir) => {
    const hour = Math.floor(Date.parse("2026-10-20T10:00:00.000Z") / HOUR);
    // The line an hour writes when its three Fable 5.2 requests had no price: a cost of 0, all three unpriced.
    fs.writeFileSync(path.join(dir, "usage-hourly.jsonl"), JSON.stringify({ h: hour, p: "anthropic", m: "claude-fable-5-2", count: 3, ok: 3, failed: 0, input: 1_000, cached: 0, cacheWrite: 0, output: 100, ms: 300, cost: 0, unpriced: 3, estimated: 0 }) + "\n");
    setAaPriceDataset(null);
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    const summary = log.usage(FROM, TO);
    // Official rates at the base tier: 1,000 x 8 + 100 x 40 = 12,000 per MTok = 0.012 USD. Each request is estimated.
    near(summary.providers["anthropic"]!.costUsd, 0.012);
    assert.equal(summary.providers["anthropic"]!.unpricedRequests, 0);
    assert.equal(summary.providers["anthropic"]!.estimatedRequests, 3);
    near(summary.total.costUsd, 0.012);
    assert.equal(summary.total.unpricedRequests, 0);
    assert.equal(summary.total.estimatedRequests, 3);
    assert.equal(summary.total.count, 3);
  });
});

test("OpenCode Go's models are priced: the undated DeepSeek id from AA's stamped base, the Contributor variant from the provider page", () => {
  withDir((dir) => {
    // What AA files today: the dated DeepSeek snapshot, and the plain Muse Spark model only.
    setAaPriceDataset(aa([{ base: "deepseek-v4-1-flash-1017", priceIn: 0.3, priceOut: 1.2 }, { base: "muse-spark-1-3", priceIn: 1.25, priceOut: 4.25 }]));
    const hour = Math.floor(Date.parse("2026-10-20T09:00:00.000Z") / HOUR);
    // An hour flushed while the Contributor variant had no price, as the live history held six of them.
    fs.writeFileSync(path.join(dir, "usage-hourly.jsonl"), JSON.stringify({ h: hour, p: "opencode-go", m: "muse-spark-1.3-contributor", count: 6, ok: 6, failed: 0, input: 1_000_000, cached: 0, cacheWrite: 0, output: 100_000, ms: 600, cost: 0, unpriced: 6, estimated: 0 }) + "\n");
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    // DeepSeek: 1,000 x 0.30 + 50,000 x 0.006 + 100 x 1.20 = 720 per MTok. Its cached read price is the page's, so not estimated.
    log.add(record("d", "2026-10-20T10:05:00.000Z", { provider: "opencode-go", target: "deepseek-v4.1-flash", usage: usage(1_000, 50_000, 100) }));
    // Contributor: 1,000 x 0.10 + 2,000 x 0.002 + 100 x 0.20 = 124 per MTok. Its cached read price is the page's, so not estimated.
    log.add(record("m", "2026-10-20T10:10:00.000Z", { provider: "opencode-go", target: "muse-spark-1.3-contributor", usage: usage(1_000, 2_000, 100) }));

    const summary = log.usage(FROM, TO);
    const row = (model: string): SummaryBucket => summary.models.find((m) => m.model === model)!;
    near(row("deepseek-v4.1-flash").costUsd, 0.00072);
    assert.equal(row("deepseek-v4.1-flash").unpricedRequests, 0);
    assert.equal(row("deepseek-v4.1-flash").estimatedRequests, 0);
    // The stored hour is priced at read time (1,000,000 x 0.10 + 100,000 x 0.20 = 0.12 USD), its six requests as estimated.
    near(row("muse-spark-1.3-contributor").costUsd, 0.12 + 0.000124);
    assert.equal(row("muse-spark-1.3-contributor").unpricedRequests, 0);
    assert.equal(row("muse-spark-1.3-contributor").estimatedRequests, 6);
    assert.equal(summary.providers["opencode-go"]!.unpricedRequests, 0);
    near(summary.providers["opencode-go"]!.costUsd, 0.00072 + 0.12 + 0.000124);

    // A free model has tokens and costs nothing: it is priced at zero, not counted as unpriced.
    log.add(record("f", "2026-10-20T10:15:00.000Z", { provider: "opencode-go", target: "beam-free", usage: usage(1_000, 2_000, 100) }));
    // A page-priced model AA does not list. Hy3: 1,000 x 0.14 + 2,000 x 0.035 + 100 x 0.58 = 268 per MTok.
    log.add(record("h", "2026-10-20T10:20:00.000Z", { provider: "opencode-go", target: "hy3", usage: usage(1_000, 2_000, 100) }));
    const after = log.usage(FROM, TO);
    const free = after.models.find((m) => m.model === "beam-free")!;
    assert.equal(free.costUsd, 0);
    assert.equal(free.unpricedRequests, 0);
    assert.equal(free.estimatedRequests, 0);
    near(after.models.find((m) => m.model === "hy3")!.costUsd, 0.000268);
    assert.equal(after.providers["opencode-go"]!.unpricedRequests, 0);
  });
});

test("a stored hour whose model is still unpriced stays unpriced", () => {
  withDir((dir) => {
    const hour = Math.floor(Date.parse("2026-10-20T10:00:00.000Z") / HOUR);
    fs.writeFileSync(path.join(dir, "usage-hourly.jsonl"), JSON.stringify({ h: hour, p: "chatgpt", m: "mystery-model", count: 1, ok: 1, failed: 0, input: 10, cached: 0, cacheWrite: 0, output: 5, ms: 50, cost: 0, unpriced: 1, estimated: 0 }) + "\n");
    setAaPriceDataset(aa([{ base: "gpt-5-5", priceIn: 5, priceOut: 30 }]));
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    const total = log.usage(FROM, TO).total;
    assert.equal(total.costUsd, 0);
    assert.equal(total.unpricedRequests, 1);
    assert.equal(total.estimatedRequests, 0);
  });
});

test("a stored hour that is already priced is read as stored, not priced again", () => {
  withDir((dir) => {
    const hour = Math.floor(Date.parse("2026-10-20T10:00:00.000Z") / HOUR);
    // The stored cost (0.5) differs from the official figure (0.012), so a second pricing would show.
    fs.writeFileSync(path.join(dir, "usage-hourly.jsonl"), JSON.stringify({ h: hour, p: "anthropic", m: "claude-fable-5-2", count: 3, ok: 3, failed: 0, input: 1_000, cached: 0, cacheWrite: 0, output: 100, ms: 300, cost: 0.5, unpriced: 0, estimated: 0 }) + "\n");
    setAaPriceDataset(null);
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    const total = log.usage(FROM, TO).total;
    near(total.costUsd, 0.5);
    assert.equal(total.unpricedRequests, 0);
    assert.equal(total.estimatedRequests, 0);
  });
});

test("a stored hour mixing priced and unpriced requests of one model stays as stored, since its tokens cannot be split", () => {
  withDir((dir) => {
    setAaPriceDataset(aa([{ base: "gpt-5-5", priceIn: 5, priceOut: 30 }]));
    const hour = Math.floor(Date.parse("2026-10-20T10:00:00.000Z") / HOUR);
    // Three GPT-5.5 requests: one priced when it arrived (cost 0.008), two unpriced before the AA data loaded.
    fs.writeFileSync(path.join(dir, "usage-hourly.jsonl"), JSON.stringify({ h: hour, p: "openai", m: "gpt-5.5", count: 3, ok: 3, failed: 0, input: 1_000, cached: 0, cacheWrite: 0, output: 100, ms: 300, cost: 0.008, unpriced: 2, estimated: 0 }) + "\n");
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    const total = log.usage(FROM, TO).total;
    // Not 0.016 (the priced request would be counted twice) and not 0.008 plus the unpriced tokens: left as stored.
    near(total.costUsd, 0.008);
    assert.equal(total.unpricedRequests, 2);
    assert.equal(total.estimatedRequests, 0);
  });
});

test("a request is estimated only when a cache component it used is not official", () => {
  withDir((dir) => {
    setAaPriceDataset(aa([{ base: "nova-pro", priceIn: 1.5, priceOut: 6 }, { base: "gpt-5-5", priceIn: 5, priceOut: 30 }]));
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    // Kimi, no cache tokens: not estimated.
    log.add(record("k1", "2026-10-20T10:00:00.000Z", { provider: "opencode-go", target: "nova-pro", usage: usage(1_000, 0, 100) }));
    // Kimi, cache reads: the read price is AA's input price, so estimated.
    log.add(record("k2", "2026-10-20T10:01:00.000Z", { provider: "opencode-go", target: "nova-pro", usage: usage(1_000, 500, 100) }));
    // GPT-5.5, cache reads only: the read price is official, so not estimated.
    log.add(record("g1", "2026-10-20T10:02:00.000Z", { provider: "openai", target: "gpt-5.5", usage: usage(1_000, 500, 100) }));
    // GPT-5.5 with a cache write: its write price is not official, so estimated.
    log.add(record("g2", "2026-10-20T10:03:00.000Z", { provider: "openai", target: "gpt-5.5", usage: usage(1_000, 500, 100, 10) }));
    // Haiku with a cache write: Claude's prices are official, so not estimated.
    log.add(record("h1", "2026-10-20T10:04:00.000Z", { usage: usage(1_000, 500, 100, 10) }));

    const total = log.usage(FROM, TO).total;
    assert.equal(total.count, 5);
    assert.equal(total.estimatedRequests, 2);
    assert.equal(total.unpricedRequests, 0);
    assert.equal(log.usage(FROM, TO).providers["anthropic"]!.estimatedRequests, 0);
    assert.equal(log.usage(FROM, TO).providers["openai"]!.estimatedRequests, 1);
    assert.equal(log.usage(FROM, TO).providers["opencode-go"]!.estimatedRequests, 1);
  });
});
