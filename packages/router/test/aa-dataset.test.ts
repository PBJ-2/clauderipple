import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildDataset, deriveEffort, meaningfulContent, parseDataset, selectVariants, WINDOW_DAYS, type ApiRow } from "../../../scripts/aa-dataset-lib.mjs";
import { runDataset } from "../../../scripts/aa-dataset.mjs";

const NOW = Date.parse("2026-10-10T00:00:00Z");
const DAY = 86_400_000;
const PRO_URL = "https://artificialanalysis.ai/api/v2/language/models";
const FREE_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
const rows: ApiRow[] = JSON.parse(fs.readFileSync(new URL("./fixtures/aa-api.json", import.meta.url), "utf8")).data;
const variants = selectVariants(rows, NOW);

/** A row for selection tests: the fixture's creator with its own slug, name, date and index. No cost, and no reasoning flag unless given. */
function row(slug: string, name: string, date: string, intelligence: number | null, extra: Partial<ApiRow> = {}): ApiRow {
  return { ...rows[0]!, slug, name, release_date: date, evaluations: { artificial_analysis_intelligence_index: intelligence }, artificial_analysis_intelligence_index_cost: null, ...extra };
}

/** One page of a V2 list, with the pagination the docs describe. */
function listPage(data: unknown[], page: number, total: number) {
  return { intelligence_index_version: "v5.0.1", tier: "pro", pagination: { page, page_size: 200, total_pages: total, has_more: page < total }, data };
}

/** The runner's network: the one-page V2 Pro list. Anything else is recorded in `other`, which a run must leave empty. */
function harness(data: unknown[] = rows) {
  const other: string[] = [];
  const logs: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const text = String(url);
    if (text !== PRO_URL) { other.push(text); return new Response(null, { status: 404 }); }
    assert.equal(new Headers(init?.headers).get("x-api-key"), "fixture-key");
    return Response.json(listPage(data, 1, 1));
  };
  return { other, logs, options: { apiKey: "fixture-key", fetchImpl, now: () => NOW, log: (line: string) => logs.push(line) } };
}

/** A V2 list served in pages (page n is `pages[n-1]`); `second` answers page 2 instead. Records the list calls only. */
function listFetch(pages: unknown[][], second?: () => Response) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async url => {
    const text = String(url);
    if (!text.startsWith("https://artificialanalysis.ai/api/v2/")) return new Response(null, { status: 404 });
    calls.push(text);
    const page = Number(new URL(text).searchParams.get("page") ?? 1);
    if (page === 2 && second) return second();
    return Response.json(listPage(pages[page - 1]!, page, pages.length));
  };
  return { calls, fetchImpl };
}

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

test("AA effort reads the reasoning flag when the name gives no level, and the name decides when the flag is absent", () => {
  const effortOf = (extra: Partial<ApiRow>) => selectVariants([row("test", "Test", "2026-09-01", 20, extra), row("test-high", "Test (High)", "2026-09-01", 30)], NOW).find(v => v.row.slug === "test")?.effort;
  assert.equal(effortOf({ reasoning_model: false }), "non-reasoning");
  assert.equal(effortOf({ reasoning_model: true }), "max");
  assert.equal(effortOf({}), "max");
});

test("AA selection groups irregular reasoning slugs by name and keeps creator boundaries", () => {
  const data = [row("gemini-flash-reasoning", "Gemini Flash Preview (Reasoning)", "2026-09-01", 40), row("gemini-flash", "Gemini Flash Preview (Non-reasoning)", "2020-01-01", null)];
  assert.deepEqual(selectVariants(data, NOW).map(v => [v.base, v.effort]), [["gemini-flash", "non-reasoning"], ["gemini-flash", "max"]]);
  const other = { ...data[1]!, slug: "other-flash", model_creator: { id: "other-creator", name: "Other" } };
  assert.equal(selectVariants([data[0]!, other], NOW).length, 1);
});

test("AA dataset fields come from the V2 list: names, dates, prices, index, cost per task and checkedAt", () => {
  const d = buildDataset(variants, NOW);
  assert.deepEqual(d.models.map(m => m.slug), ["deepseek-v4-1-flash", "deepseek-v4-1-flash-non-reasoning", "gpt-6-1-sol", "gpt-6-1-sol-high"]);
  const model = d.models.find(m => m.slug === "deepseek-v4-1-flash")!;
  assert.deepEqual(
    { name: model.name, creator: model.creator, releaseDate: model.releaseDate, base: model.base, effort: model.effort, intelligence: model.intelligence, intelligenceEstimated: model.intelligenceEstimated, costPerTask: model.costPerTask, priceIn: model.priceIn, priceOut: model.priceOut, checkedAt: model.checkedAt },
    { name: "DeepSeek V4.1 Flash (Max)", creator: "DeepSeek", releaseDate: "2026-09-10", base: "deepseek-v4-1-flash", effort: "max", intelligence: 39.5, intelligenceEstimated: null, costPerTask: 0.2652, priceIn: 0.3, priceOut: 1.2, checkedAt: new Date(NOW).toISOString() },
  );
  assert.equal(d.models.find(m => m.slug === "deepseek-v4-1-flash-non-reasoning")?.effort, "non-reasoning");
  assert.equal(d.models.find(m => m.slug === "deepseek-v4-1-flash-non-reasoning")?.costPerTask, null);
  assert.equal(d.models.find(m => m.slug === "gpt-6-1-sol-high")?.costPerTask, 0.3191);
  assert.equal(d.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(parseDataset(d), d);
});

test("AA comparison ignores only refresh timestamps; validators reject corrupt data", () => {
  const a = buildDataset(variants, NOW);
  const b = buildDataset(variants, NOW + DAY);
  assert.notEqual(a.generatedAt, b.generatedAt);
  assert.equal(meaningfulContent(a), meaningfulContent(b));
  b.models[0]!.costPerTask = 100;
  assert.notEqual(meaningfulContent(a), meaningfulContent(b));
  assert.deepEqual(parseDataset(a), a);
  assert.throws(() => parseDataset({ ...a, models: [...a.models, a.models[0]] }), /invalid/);
  assert.throws(() => parseDataset({ ...a, models: [{ ...a.models[0], costPerTask: "0.1" }] }), /invalid/);
});

test("AA runner reads the V2 list only: no model page is requested, and the dataset is built from the list", async () => {
  const h = harness();
  const d = await runDataset(h.options);
  assert.deepEqual(h.other, []);
  assert.ok(h.logs.includes(`AA: data from ${PRO_URL}`));
  assert.ok(h.logs.includes("AA: intelligence_index_version v5.0.1; 1 page"));
  assert.ok(h.logs.includes("AA: 4 variants"));
  assert.equal(meaningfulContent(d), meaningfulContent(buildDataset(variants, NOW)));
});

test("AA runner refuses a missing key, a failed key, and an answer with no models", async () => {
  await assert.rejects(runDataset({ apiKey: "" }), /AA_API_KEY is not set/);
  await assert.rejects(runDataset({ apiKey: "fixture", fetchImpl: async () => new Response(null, { status: 401 }) }), /API failed/);
  await assert.rejects(runDataset({ apiKey: "fixture", fetchImpl: async () => Response.json({ pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false }, data: [] }) }), /no model list/);
});

test("AA V2 a non-numeric cost per task skips that row rather than publishing a wrong cost", async () => {
  const bad = { ...rows[2]!, slug: "deepseek-v4-1-flash-bad", artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: "0.2" } } } as unknown as ApiRow;
  const h = harness([...rows, bad]);
  const d = await runDataset(h.options);
  assert.equal(d.models.some(m => m.slug === "deepseek-v4-1-flash-bad"), false);
  assert.equal(d.models.length, 4);
});

test("AA V2 reads every page of the Pro list and merges them in order", async () => {
  const list = listFetch([rows.slice(0, 2), rows.slice(2)]);
  const logs: string[] = [];
  const d = await runDataset({ apiKey: "fixture-key", fetchImpl: list.fetchImpl, log: line => logs.push(line) });
  assert.deepEqual(list.calls, [PRO_URL, `${PRO_URL}?page=2`]);
  assert.deepEqual(d.models.map(m => m.slug), ["deepseek-v4-1-flash", "deepseek-v4-1-flash-non-reasoning", "gpt-6-1-sol", "gpt-6-1-sol-high"]);
  assert.ok(logs.includes("AA: intelligence_index_version v5.0.1; 2 pages"));
});

test("AA V2 pages the free path after a Pro 403, with the same key on every page", async () => {
  const pages = [rows.slice(0, 2), rows.slice(2)];
  const keys: (string | null)[] = [];
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const text = String(url);
    if (!text.startsWith("https://artificialanalysis.ai/api/v2/")) return new Response(null, { status: 404 });
    calls.push(text);
    keys.push(new Headers(init?.headers).get("x-api-key"));
    if (text === PRO_URL) return new Response(null, { status: 403 });
    const page = Number(new URL(text).searchParams.get("page") ?? 1);
    return Response.json(listPage(pages[page - 1]!, page, 2));
  };
  const logs: string[] = [];
  const d = await runDataset({ apiKey: "fixture-key", fetchImpl, log: line => logs.push(line) });
  assert.deepEqual(calls, [PRO_URL, FREE_URL, `${FREE_URL}?page=2`]);
  assert.deepEqual(keys, ["fixture-key", "fixture-key", "fixture-key"]);
  assert.equal(d.models.length, 4);
  assert.ok(logs.includes(`AA: data from ${FREE_URL} (the Pro path answered 403 for this key)`));
});

test("AA V2 free shape has no reasoning flag: the name still decides effort, and cost per task still comes from the list", async () => {
  const freeRows = rows.map(({ reasoning_model: _omitted, ...r }) => r) as ApiRow[];
  const fetchImpl: typeof fetch = async url => {
    if (String(url) === PRO_URL) return new Response(null, { status: 403 });
    assert.equal(String(url), FREE_URL);
    return Response.json(listPage(freeRows, 1, 1));
  };
  const d = await runDataset({ apiKey: "fixture-key", fetchImpl, log: () => {} });
  assert.equal(d.models.find(m => m.slug === "deepseek-v4-1-flash-non-reasoning")?.effort, "non-reasoning");
  assert.equal(d.models.find(m => m.slug === "gpt-6-1-sol-high")?.costPerTask, 0.3191);
});

test("AA V2 a failed later page fails the run, and so does a page that answers another page", async () => {
  const pages = [rows.slice(0, 2), rows.slice(2)];
  const failed = listFetch(pages, () => new Response(null, { status: 503 }));
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: failed.fetchImpl }), { message: "AA API failed: HTTP 503" });
  assert.deepEqual(failed.calls, [PRO_URL, `${PRO_URL}?page=2`]);
  const wrong = listFetch(pages, () => Response.json(listPage(pages[1]!, 1, 2)));
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: wrong.fetchImpl }), { message: "AA API page 2 does not match the list's pagination" });
});

test("AA V2 refuses a list above the page cap before fetching it, and an inconsistent first page", async () => {
  const calls: string[] = [];
  const overFetch: typeof fetch = async url => { calls.push(String(url)); return Response.json(listPage(rows, 1, 21)); };
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: overFetch }), { message: "AA API list has 21 pages, above the cap of 20; refusing a partial list" });
  assert.deepEqual(calls, [PRO_URL]);
  const inconsistent: typeof fetch = async () => Response.json({ ...listPage(rows, 1, 1), pagination: { page: 1, page_size: 200, total_pages: 1, has_more: true } });
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: inconsistent }), { message: "AA API page 1 pagination is inconsistent" });
});

test("AA V2 refuses the retired slug-only creator shape rather than publishing a list without families", async () => {
  const legacy = rows.map(r => ({ ...r, model_creator: { name: r.model_creator.name, slug: "legacy" } }));
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: async () => Response.json({ pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false }, data: legacy }) }), { message: "AA API model list changed shape" });
});

test("AA V2 keeps a null or absent release_date (never tracked, published with an empty date) and skips a null free-tier creator", async () => {
  const dated = rows[2]!;
  const { release_date: _removed, ...withoutDate } = dated;
  const nullDate = { ...dated, slug: "deepseek-v4-1-flash-low", name: "DeepSeek V4.1 Flash (Low)", release_date: null };
  const absentDate = { ...withoutDate, slug: "deepseek-v4-1-flash-high", name: "DeepSeek V4.1 Flash (High)" };
  const nullCreator = { ...dated, slug: "deepseek-v4-1-flash-free", model_creator: null };
  const h = harness([dated, nullDate, absentDate, nullCreator] as unknown as ApiRow[]);
  const d = await runDataset(h.options);
  // The dated sibling makes the family tracked; the undated siblings ride along, and the null creator is not a row.
  const checkedAt = new Date(NOW).toISOString();
  assert.deepEqual(d.models.map(m => [m.slug, m.effort, m.releaseDate, m.checkedAt]), [
    ["deepseek-v4-1-flash", "max", "2026-09-10", checkedAt],
    ["deepseek-v4-1-flash-high", "high", "", checkedAt],
    ["deepseek-v4-1-flash-low", "low", "", checkedAt],
  ]);
  assert.deepEqual(parseDataset(d), d);
});

test("AA V2 non-2xx answers name the status, its documented meaning and the body's error", async () => {
  const failWith = (response: () => Response) => runDataset({ apiKey: "fixture", fetchImpl: async () => response() });
  await assert.rejects(failWith(() => Response.json({ error: "Unauthorized" }, { status: 401 })), { message: "AA API failed: HTTP 401 (missing or invalid key; Unauthorized)" });
  await assert.rejects(failWith(() => new Response(null, { status: 429 })), { message: "AA API failed: HTTP 429 (daily quota exhausted)" });
  await assert.rejects(failWith(() => Response.json({ error: "Gone", message: "The legacy /api/v2/data/* endpoints were retired" }, { status: 410 })), { message: "AA API failed: HTTP 410 (Gone; The legacy /api/v2/data/* endpoints were retired)" });
  await assert.rejects(failWith(() => new Response("<html>bad gateway</html>", { status: 502 })), { message: "AA API failed: HTTP 502" });
});

test("AA V2 retries the free path once after a Pro 403, with the same key, and logs the path that served", async () => {
  const calls: { url: string; key: string | null }[] = [];
  const logs: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), key: new Headers(init?.headers).get("x-api-key") });
    if (String(url) === PRO_URL) return new Response(null, { status: 403 });
    if (String(url) === FREE_URL) return Response.json({ intelligence_index_version: "v5.0.1", tier: "free", pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false }, data: rows });
    return new Response(null, { status: 404 });
  };
  const d = await runDataset({ apiKey: "fixture-key", fetchImpl, log: line => logs.push(line) });
  assert.deepEqual(calls.slice(0, 2), [{ url: PRO_URL, key: "fixture-key" }, { url: FREE_URL, key: "fixture-key" }]);
  assert.equal(d.models.find(m => m.slug === "deepseek-v4-1-flash")?.intelligence, 39.5);
  assert.ok(logs.includes(`AA: data from ${FREE_URL} (the Pro path answered 403 for this key)`));
  assert.ok(!logs.includes(`AA: data from ${PRO_URL}`));
});

test("AA V2 403 on both paths fails and names both paths", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async url => { calls.push(String(url)); return Response.json({ error: "Forbidden" }, { status: 403 }); };
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl }), { message: "AA API failed: HTTP 403 on both /api/v2/language/models and /api/v2/language/models/free (the key tier covers neither endpoint; Forbidden)" });
  assert.deepEqual(calls, [PRO_URL, FREE_URL]);
});

test("AA V2 only a Pro 403 retries: other Pro errors stop at once, and a free-path error is reported as is", async () => {
  const proCalls: string[] = [];
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: async url => { proCalls.push(String(url)); return Response.json({ error: "Unauthorized" }, { status: 401 }); } }), { message: "AA API failed: HTTP 401 (missing or invalid key; Unauthorized)" });
  assert.deepEqual(proCalls, [PRO_URL]);
  const freeCalls: string[] = [];
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: async url => { freeCalls.push(String(url)); return String(url) === PRO_URL ? new Response(null, { status: 403 }) : new Response(null, { status: 429 }); } }), { message: "AA API failed: HTTP 429 (daily quota exhausted)" });
  assert.deepEqual(freeCalls, [PRO_URL, FREE_URL]);
});

test("AA V2 refuses a list without pagination: it may be page 1 of more", async () => {
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: async () => Response.json({ intelligence_index_version: "v5.0.1", tier: "pro", data: rows }) }), { message: "AA API list has no pagination; refusing what may be a partial list" });
});
