import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEffort, extractPageRecords, meaningfulContent, mergeDataset, parseDataset, reusable, selectVariants, WINDOW_DAYS, type ApiRow } from "../../../scripts/aa-dataset-lib.mjs";
import { runDataset } from "../../../scripts/aa-dataset.mjs";

const NOW = Date.parse("2026-10-10T00:00:00Z");
const DAY = 86_400_000;
const html = fs.readFileSync(new URL("./fixtures/aa-flight.html", import.meta.url), "utf8");
const rows: ApiRow[] = JSON.parse(fs.readFileSync(new URL("./fixtures/aa-api.json", import.meta.url), "utf8")).data;
const variants = selectVariants(rows, NOW);
const records = extractPageRecords(html);

function row(slug: string, name: string, date: string, intelligence: number | null): ApiRow {
  return { ...rows[0]!, slug, name, release_date: date, evaluations: { artificial_analysis_intelligence_index: intelligence } };
}

test("AA flight extracts all records and matches slug rather than first position", () => {
  assert.equal(records.length, 3);
  assert.equal(records[0]?.slug, "gpt-6-1-sol");
  const high = records.find(r => r.slug === "gpt-6-1-sol-high")!;
  assert.equal(high.intelligenceIndex, 50.2377777519769);
  assert.equal(high.intelligenceIndexCostPerTask?.cost?.total, 0.31914442375664703);
});

test("AA extraction respects nested braces, escaped quotes, backslashes and flight chunk boundaries", () => {
  const record = { ...records[0], description: 'quoted "text" with {braces} and a \\ path' };
  const text = JSON.stringify([record]);
  const split = Math.floor(text.length / 2);
  const page = [text.slice(0, split), text.slice(split)].map(chunk => `self.__next_f.push([1,${JSON.stringify(chunk)}])`).join("\n");
  assert.deepEqual(extractPageRecords(page), [record]);
  assert.equal(extractPageRecords(JSON.stringify(record)).length, 1);
  assert.equal(extractPageRecords(JSON.stringify(records[0]).replaceAll('"', '\\"')).length, 1);
});

test("AA extraction refuses wrong cost/index shapes, keeps an unpriced model, never substitutes total cost", () => {
  assert.deepEqual(extractPageRecords("<html>layout changed</html>"), []);
  // A model AA runs but does not price (a-x-k2, 2026-10-10) is still a parsed record, with no cost.
  assert.equal(extractPageRecords(JSON.stringify({ ...records[0], intelligenceIndexCostPerTask: undefined })).length, 1);
  assert.deepEqual(extractPageRecords(JSON.stringify({ ...records[0], intelligenceIndexCostPerTask: { cost: { total: "0.3" } } })), []);
  assert.deepEqual(extractPageRecords(JSON.stringify({ ...records[0], intelligenceIndex: "50" })), []);
  assert.deepEqual(extractPageRecords('{"canonicalIntelligenceIndexTokenCount":null,broken}'), []);
  const nullable = { ...records[0], intelligenceIndex: null, intelligenceIndexCostPerTask: { cost: { total: null } } };
  assert.equal(extractPageRecords(JSON.stringify(nullable)).length, 1);
});

test("AA selection includes 365-day boundary and all old/null siblings, excludes future/old families", () => {
  const data = [
    row("test-high", "Test (High)", new Date(NOW - WINDOW_DAYS * DAY).toISOString(), 0),
    row("test-low", "Test (Low)", "2020-01-01", null),
    row("test", "Test (Max)", "2020-01-01", null),
    row("old", "Old", new Date(NOW - WINDOW_DAYS * DAY - 1).toISOString(), 20),
    row("future", "Future", "2027-01-01", 50),
    row("undated", "Undated", "invalid", 50),
    row("unmeasured", "Unmeasured", "2026-09-01", null),
  ];
  assert.deepEqual(selectVariants(data, NOW).map(v => [v.row.slug, v.base, v.effort]), [["test", "test", "max"], ["test-high", "test", "high"], ["test-low", "test", "low"]]);
  assert.deepEqual(selectVariants([], NOW), []);
});

test("AA effort handles suffix priority, fallback labels, single variants and product names", () => {
  for (const effort of ["max", "xhigh", "high", "medium", "low", "minimal"] as const) {
    assert.equal(deriveEffort({ slug: `test-${effort}`, name: `Test (${effort}, Default Fallback)` }, true), effort);
  }
  assert.equal(deriveEffort({ slug: "test-high", name: "Test", suffix: "Non-reasoning, High" }, true), "non-reasoning");
  assert.equal(deriveEffort({ slug: "test-thinking", name: "Test (Reasoning)" }, true), "max");
  assert.equal(deriveEffort({ slug: "test", name: "Test", isReasoning: false }, true), "non-reasoning");
  assert.equal(deriveEffort({ slug: "test", name: "Test (High)" }, false), null);
  const selected = selectVariants([row("qwen3-8-max", "Qwen3.8 Max", "2026-09-01", 40), row("preview", "Test (Preview)", "2026-09-01", 20), row("beta", "Test (Beta)", "2020-01-01", 20)], NOW);
  assert.equal(selected.find(v => v.row.slug === "qwen3-8-max")?.base, "qwen3-8-max");
  assert.equal(selected.some(v => v.row.slug === "beta"), false);
});

test("AA selection groups irregular reasoning slugs by name and keeps creator boundaries", () => {
  const data = [row("gemini-flash-reasoning", "Gemini Flash Preview (Reasoning)", "2026-09-01", 40), row("gemini-flash", "Gemini Flash Preview (Non-reasoning)", "2020-01-01", null)];
  assert.deepEqual(selectVariants(data, NOW).map(v => [v.base, v.effort]), [["gemini-flash", "non-reasoning"], ["gemini-flash", "max"]]);
  const other = { ...data[1]!, slug: "other-flash", model_creator: { name: "Other", slug: "other" } };
  assert.equal(selectVariants([data[0]!, other], NOW).length, 1);
});

test("AA merge preserves stale failed values/timestamps; new failed entries get null cost and checkedAt", () => {
  const previous = mergeDataset(variants, null, records, NOW - 8 * DAY);
  const merged = mergeDataset(variants, previous, [], NOW);
  assert.deepEqual(merged.models, previous.models);
  const unseen = merged.models.find(m => m.slug.endsWith("non-reasoning"))!;
  assert.equal(unseen.costPerTask, null);
  assert.equal(unseen.checkedAt, null);
  const high = mergeDataset(variants, previous, [records.find(r => r.slug.endsWith("-high"))!], NOW).models.find(m => m.slug.endsWith("-high"))!;
  assert.equal(high.checkedAt, new Date(NOW).toISOString());
  assert.equal(high.intelligence, 50.2377777519769);
  assert.deepEqual(merged.models.map(m => m.slug), [...merged.models.map(m => m.slug)].sort());
  assert.equal(JSON.stringify(merged).includes('"input"'), false);
});

test("AA seven-day reuse excludes exact expiry, missing/invalid and future timestamps", () => {
  const model = mergeDataset(variants, null, records, NOW).models[0]!;
  assert.equal(reusable({ ...model, checkedAt: new Date(NOW - 7 * DAY + 1).toISOString() }, NOW), true);
  for (const checkedAt of [null, "bad", new Date(NOW - 7 * DAY).toISOString(), new Date(NOW + 1).toISOString()]) assert.equal(reusable({ ...model, checkedAt }, NOW), false);
  assert.equal(reusable(undefined, NOW), false);
});

test("AA comparison ignores only refresh timestamps; validators reject corrupt previous data", () => {
  const a = mergeDataset(variants, null, records, NOW);
  const b = mergeDataset(variants, a, records, NOW + DAY);
  assert.equal(meaningfulContent(a), meaningfulContent(b));
  b.models[0]!.costPerTask = 100;
  assert.notEqual(meaningfulContent(a), meaningfulContent(b));
  assert.deepEqual(parseDataset(a), a);
  assert.throws(() => parseDataset({ ...a, models: [...a.models, a.models[0]] }), /invalid/);
  assert.throws(() => parseDataset({ ...a, models: [{ ...a.models[0], costPerTask: "0.1" }] }), /invalid/);
});

function harness(pageFor: (slug: string, count: number) => Response, data = rows) {
  let clock = NOW;
  const pages: { slug: string; at: number }[] = [];
  const logs: string[] = [];
  const counts = new Map<string, number>();
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).includes("/api/v2/")) {
      assert.equal(new Headers(init?.headers).get("x-api-key"), "fixture-key");
      return Response.json({ data });
    }
    if (String(url).includes("raw.githubusercontent")) return new Response(null, { status: 404 });
    const slug = String(url).split("/").at(-1)!;
    assert.match(new Headers(init?.headers).get("user-agent")!, /ClaudeRipple dataset \(github.com\/PBJ-2\/clauderipple\)/);
    assert.ok(init?.signal);
    pages.push({ slug, at: clock });
    const count = (counts.get(slug) ?? 0) + 1;
    counts.set(slug, count);
    return pageFor(slug, count);
  };
  return { pages, logs, options: { apiKey: "fixture-key", fetchImpl, now: () => clock, wait: async (ms: number) => { clock += ms; }, log: (s: string) => logs.push(s) } };
}

test("AA runner caps actual pages, retries 429 once, spaces attempts and opportunistically reuses embedded defaults", async () => {
  const h = harness((_slug, count) => count === 1 ? new Response(null, { status: 429 }) : new Response(html));
  const d = await runDataset({ ...h.options, limit: 1 });
  assert.equal(h.pages.length, 2);
  assert.ok(h.pages[1]!.at - h.pages[0]!.at >= 5000);
  assert.equal(d.models.find(m => m.slug === "gpt-6-1-sol-high")?.costPerTask, 0.31914442375664703);
  const sequential = harness(() => new Response(html));
  await runDataset(sequential.options);
  assert.deepEqual(sequential.pages.map(p => p.slug), ["deepseek-v4-1-flash", "deepseek-v4-1-flash-non-reasoning"]);
  assert.ok(sequential.pages[1]!.at - sequential.pages[0]!.at >= 1500);
});

test("AA runner fails below 50% exact-slug parse, accepts exactly 50%, and fails API/missing key", async () => {
  const failure = harness(() => new Response("layout changed"));
  await assert.rejects(runDataset(failure.options), /below 50%/);
  const half = harness(() => new Response(html));
  const result = await runDataset(half.options);
  assert.equal(result.models.find(m => m.slug.endsWith("non-reasoning"))?.costPerTask, null);
  const httpFailure = harness(() => new Response(null, { status: 503 }));
  await assert.rejects(runDataset({ ...httpFailure.options, limit: 1 }), /below 50%/);
  assert.equal(httpFailure.pages.length, 2);
  await assert.rejects(runDataset({ apiKey: "" }), /AA_API_KEY/);
  await assert.rejects(runDataset({ apiKey: "fixture", fetchImpl: async () => new Response(null, { status: 401 }) }), /API failed/);
  await assert.rejects(runDataset({ apiKey: "fixture", fetchImpl: async () => Response.json({ data: [] }) }), /no model list/);
});

test("AA runner uses previous file for seven-day reuse and refetches only new/expired variants", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-dataset-"));
  try {
    const previous = mergeDataset(variants, null, records, NOW - DAY);
    previous.models = previous.models.map(m => ({ ...m, checkedAt: new Date(NOW - DAY).toISOString() }));
    const file = path.join(home, "previous.json");
    fs.writeFileSync(file, JSON.stringify(previous));
    const h = harness(() => new Response(html));
    await runDataset({ ...h.options, previous: file });
    assert.equal(h.pages.length, 0);
    previous.models.find(m => m.slug === "gpt-6-1-sol-high")!.checkedAt = new Date(NOW - 7 * DAY).toISOString();
    fs.writeFileSync(file, JSON.stringify(previous));
    await runDataset({ ...h.options, previous: file });
    assert.deepEqual(h.pages.map(p => p.slug), ["gpt-6-1-sol-high"]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
