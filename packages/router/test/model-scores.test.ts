import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, type Config } from "../src/config.ts";
import { AA_DATA_URL, ModelScoreCatalog, buildModelScores, mapAaEffort, normalizeAaBase, parseScoreDataset } from "../src/model-scores.ts";
import { extractPageRecords, mergeDataset, selectVariants, type ApiRow } from "../../../scripts/aa-dataset-lib.mjs";

const NOW = Date.now();
const HOUR = 60 * 60_000;
const rows: ApiRow[] = JSON.parse(fs.readFileSync(new URL("./fixtures/aa-api.json", import.meta.url), "utf8")).data;
const dataset = mergeDataset(selectVariants(rows, Date.parse("2026-10-10")), null, extractPageRecords(fs.readFileSync(new URL("./fixtures/aa-flight.html", import.meta.url), "utf8")), NOW);

export function scoreConfig(): Config {
  return {
    ...DEFAULTS, admin: { port: 0 },
    providers: {
      codex: { type: "chatgpt", models: [{ id: "gpt-6.1-sol" }, { id: "unknown-model" }] },
      deepseek: { type: "anthropic-compatible", url: "https://example.invalid", models: [{ id: "deepseek-v4.1-flash" }] },
      native: { type: "anthropic", auth: "claude-code", models: [{ id: "claude-opus-5-5" }] },
    },
    routes: { "claude-sonnet-5": { provider: "codex", model: "gpt-6.1-sol" } },
    direct: [{ prefix: "gpt-", provider: "codex" }],
    aliases: { sol: "gpt-6.1-sol", other: "gpt-alias-only" },
  };
}

test("AA normalization handles decimal versions, namespaces, Claude snapshots and effort tags", () => {
  for (const [model, base] of [["gpt-6.1-sol", "gpt-6-1-sol"], ["claude-opus-5-5", "claude-opus-5-5"], ["deepseek-v4.1-flash", "deepseek-v4-1-flash"], ["anthropic/claude-opus-5-5-20260921@high", "claude-opus-5-5"], ["z-ai/GLM_5.3", "glm-5-3"]]) assert.equal(normalizeAaBase(model!), base);
});

test("AA effort mapping preserves five picker levels and never fabricates low from non-reasoning/minimal", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) assert.equal(mapAaEffort(level), level);
  assert.equal(mapAaEffort(null), null);
  assert.equal(mapAaEffort("minimal"), null);
  assert.equal(mapAaEffort("non-reasoning"), null);
});

test("AA projection includes configured/alias-only targets and unmatched ids without slot source duplicates", () => {
  const result = buildModelScores(scoreConfig(), parseScoreDataset(dataset));
  assert.equal(result.attribution, dataset.attribution);
  assert.equal(result.generatedAt, dataset.generatedAt);
  const sol = result.models.find(m => m.model === "gpt-6.1-sol")!;
  assert.equal(sol.provider, "codex");
  assert.equal(sol.aaBase, "gpt-6-1-sol");
  assert.equal(sol.matched, true);
  assert.deepEqual(sol.variants.map(v => v.effort), ["max", "high"]);
  assert.equal(sol.variants[1]?.costPerTask, 0.31914442375664703);
  assert.equal(result.models.filter(m => m.model === "gpt-6.1-sol").length, 1);
  assert.ok(result.models.some(m => m.model === "gpt-alias-only" && !m.matched));
  assert.ok(result.models.some(m => m.model === "unknown-model" && !m.matched && !m.variants.length));
  assert.ok(result.models.some(m => m.model === "claude-opus-5-5"));
  assert.equal(result.models.some(m => m.model === "claude-sonnet-5"), false);
  assert.equal(buildModelScores(scoreConfig(), null).models.every(m => !m.matched), true);
});

test("AA projection honors explicit provider precedence and excludes unroutable ambiguous offerings", () => {
  const cfg = scoreConfig();
  cfg.providers.second = { type: "chatgpt", models: [{ id: "gpt-6.1-sol" }, { id: "unknown-model" }] };
  const result = buildModelScores(cfg, parseScoreDataset(dataset));
  assert.deepEqual(result.models.filter(m => m.model === "gpt-6.1-sol").map(m => m.provider), ["codex"]);
  assert.deepEqual(result.models.filter(m => m.model === "unknown-model"), []);
});

test("AA projection includes explicit fallbacks and CLI slots not declared in provider lists", () => {
  const cfg = scoreConfig();
  cfg.cli = { ...cfg.cli, models: { smallFast: "gpt-slot-only@low" } };
  cfg.routes["claude-sonnet-5"]!.fallbacks = [{ provider: "deepseek", model: "fallback-only" }, { provider: "native", model: "ingress-only-fallback" }];
  const result = buildModelScores(cfg, null);
  assert.ok(result.models.some(m => m.model === "gpt-slot-only" && m.provider === "codex"));
  assert.ok(result.models.some(m => m.model === "fallback-only" && m.provider === "deepseek"));
  assert.equal(result.models.some(m => m.model === "ingress-only-fallback"), false);
});

test("AA score schema rejects corrupt payloads while retaining nullable measurements", () => {
  assert.equal(parseScoreDataset(dataset).models.length, dataset.models.length);
  for (const raw of [null, {}, { ...dataset, source: "https://wrong.invalid" }, { ...dataset, models: [{ ...dataset.models[0], costPerTask: "0.1" }] }, { ...dataset, models: [...dataset.models, dataset.models[0]] }]) assert.throws(() => parseScoreDataset(raw), /invalid AA/);
});

test("AA cache coalesces requests, persists the full dataset, honors 24h across restart and refreshes on expiry", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-scores-"));
  let clock = NOW;
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), AA_DATA_URL);
    assert.ok(init?.signal);
    return Response.json(dataset);
  };
  try {
    const catalog = new ModelScoreCatalog({ home, fetch: fetchImpl, now: () => clock });
    const [a, b] = await Promise.all([catalog.get(), catalog.get()]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "aa-models.json"), "utf8")), dataset);
    await catalog.get();
    const restart = new ModelScoreCatalog({ home, fetch: fetchImpl, now: () => clock + HOUR });
    await restart.get();
    assert.equal(calls, 1);
    clock += 24 * HOUR;
    await catalog.get();
    assert.equal(calls, 2);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("AA failure uses stale disk offline, retries after 1h, rejects malformed refresh and preserves disk", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-scores-offline-"));
  let clock = NOW;
  let calls = 0;
  const warnings: string[] = [];
  try {
    const file = path.join(home, "aa-models.json");
    fs.writeFileSync(file, JSON.stringify(dataset));
    fs.utimesSync(file, new Date(NOW - 25 * HOUR), new Date(NOW - 25 * HOUR));
    const catalog = new ModelScoreCatalog({ home, now: () => clock, warn: s => warnings.push(s), fetch: async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      if (calls === 2) return Response.json({ models: [] });
      return Response.json(dataset);
    } });
    assert.equal((await catalog.get())?.generatedAt, dataset.generatedAt);
    clock += HOUR - 1;
    await catalog.get();
    assert.equal(calls, 1);
    clock++;
    await catalog.get();
    assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), dataset);
    clock += HOUR;
    await catalog.get();
    assert.equal(calls, 3);
    assert.equal(warnings.length, 2);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("AA missing/corrupt disk plus HTTP failure returns null with an hourly retry", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-scores-missing-"));
  let calls = 0;
  const warnings: string[] = [];
  try {
    fs.writeFileSync(path.join(home, "aa-models.json"), "broken");
    const catalog = new ModelScoreCatalog({ home, warn: s => warnings.push(s), fetch: async () => { calls++; return new Response(null, { status: 503 }); } });
    assert.equal(await catalog.get(), null);
    assert.equal(await catalog.get(), null);
    assert.equal(calls, 1);
    assert.equal(warnings.length, 2);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
