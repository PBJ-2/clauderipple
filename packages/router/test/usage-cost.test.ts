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
    // A non-Claude priced model: 1,000 x 5 + 100 x 30 = 8,000 per MTok, estimated because its cache-write price is AA's input price.
    log.add(record("d", "2026-10-20T10:20:00.000Z", { provider: "openai", target: "gpt-5.5", usage: usage(1_000, 0, 100) }));

    const before = log.usage(FROM, TO);
    near(before.total.costUsd, 0.0003325 + 0.008);
    assert.equal(before.total.unpricedRequests, 1);
    assert.equal(before.total.estimatedRequests, 1);
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
