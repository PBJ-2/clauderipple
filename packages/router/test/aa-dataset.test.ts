import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEffort, extractPageRecords, meaningfulContent, mergeDataset, parseDataset, reusable, selectVariants, WINDOW_DAYS, type ApiRow } from "../../../scripts/aa-dataset-lib.mjs";
import { runDataset } from "../../../scripts/aa-dataset.mjs";

const NOW = Date.parse("2026-10-10T00:00:00Z");
const DAY = 86_400_000;
const PRO_URL = "https://artificialanalysis.ai/api/v2/language/models";
const FREE_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
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
  const other = { ...data[1]!, slug: "other-flash", model_creator: { id: "other-creator", name: "Other" } };
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
    if (String(url).startsWith("https://artificialanalysis.ai/api/v2/")) {
      assert.ok(String(url) === PRO_URL || String(url) === FREE_URL, String(url));
      assert.equal(new Headers(init?.headers).get("x-api-key"), "fixture-key");
      return Response.json({ intelligence_index_version: "v5.0.1", tier: "pro", pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false }, data });
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
  await assert.rejects(runDataset({ apiKey: "fixture", fetchImpl: async () => Response.json({ pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false }, data: [] }) }), /no model list/);
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

test("AA V2 rows map documented names to the dataset without fetching pages", async () => {
  const h = harness(() => new Response(html));
  const d = await runDataset({ ...h.options, limit: 0 });
  assert.equal(h.pages.length, 0);
  assert.ok(h.logs.some(line => line.includes("intelligence_index_version v5.0.1")));
  assert.ok(h.logs.includes(`AA: data from ${PRO_URL}`));
  const model = d.models.find(m => m.slug === "deepseek-v4-1-flash")!;
  assert.deepEqual(
    { name: model.name, creator: model.creator, releaseDate: model.releaseDate, intelligence: model.intelligence, priceIn: model.priceIn, priceOut: model.priceOut, checkedAt: model.checkedAt },
    { name: "DeepSeek V4.1 Flash (Max)", creator: "DeepSeek", releaseDate: "2026-09-10", intelligence: 39.5, priceIn: 0.3, priceOut: 1.2, checkedAt: null },
  );
});

/** One page of a V2 list, with the pagination the docs describe. */
function listPage(data: unknown[], page: number, total: number) {
  return { intelligence_index_version: "v5.0.1", tier: "pro", pagination: { page, page_size: 200, total_pages: total, has_more: page < total }, data };
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

test("AA V2 reads every page of the Pro list and merges them in order", async () => {
  const list = listFetch([rows.slice(0, 2), rows.slice(2)]);
  const logs: string[] = [];
  const d = await runDataset({ apiKey: "fixture-key", fetchImpl: list.fetchImpl, limit: 0, log: line => logs.push(line) });
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
  const d = await runDataset({ apiKey: "fixture-key", fetchImpl, limit: 0, log: line => logs.push(line) });
  assert.deepEqual(calls, [PRO_URL, FREE_URL, `${FREE_URL}?page=2`]);
  assert.deepEqual(keys, ["fixture-key", "fixture-key", "fixture-key"]);
  assert.equal(d.models.length, 4);
  assert.ok(logs.includes(`AA: data from ${FREE_URL} (the Pro path answered 403 for this key)`));
});

test("AA V2 a failed later page fails the run, and so does a page that answers another page", async () => {
  const pages = [rows.slice(0, 2), rows.slice(2)];
  const failed = listFetch(pages, () => new Response(null, { status: 503 }));
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: failed.fetchImpl, limit: 0 }), { message: "AA API failed: HTTP 503" });
  assert.deepEqual(failed.calls, [PRO_URL, `${PRO_URL}?page=2`]);
  const wrong = listFetch(pages, () => Response.json(listPage(pages[1]!, 1, 2)));
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: wrong.fetchImpl, limit: 0 }), { message: "AA API page 2 does not match the list's pagination" });
});

test("AA V2 refuses a list above the page cap before fetching it, and an inconsistent first page", async () => {
  const calls: string[] = [];
  const overFetch: typeof fetch = async url => { calls.push(String(url)); return Response.json(listPage(rows, 1, 21)); };
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: overFetch, limit: 0 }), { message: "AA API list has 21 pages, above the cap of 20; refusing a partial list" });
  assert.deepEqual(calls, [PRO_URL]);
  const inconsistent: typeof fetch = async () => Response.json({ ...listPage(rows, 1, 1), pagination: { page: 1, page_size: 200, total_pages: 1, has_more: true } });
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: inconsistent, limit: 0 }), { message: "AA API page 1 pagination is inconsistent" });
});

test("AA V2 refuses the retired slug-only creator shape rather than publishing a list without families", async () => {
  const legacy = rows.map(r => ({ ...r, model_creator: { name: r.model_creator.name, slug: "legacy" } }));
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: async () => Response.json({ pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false }, data: legacy }), limit: 0 }), { message: "AA API model list changed shape" });
});

test("AA V2 keeps a null or absent release_date (never tracked, published with an empty date) and skips a null free-tier creator", async () => {
  const dated = rows[2]!;
  const { release_date: _removed, ...withoutDate } = dated;
  const nullDate = { ...dated, slug: "deepseek-v4-1-flash-low", name: "DeepSeek V4.1 Flash (Low)", release_date: null };
  const absentDate = { ...withoutDate, slug: "deepseek-v4-1-flash-high", name: "DeepSeek V4.1 Flash (High)" };
  const nullCreator = { ...dated, slug: "deepseek-v4-1-flash-free", model_creator: null };
  const h = harness(() => new Response(html), [dated, nullDate, absentDate, nullCreator] as unknown as ApiRow[]);
  const d = await runDataset({ ...h.options, limit: 0 });
  // The dated sibling makes the family tracked; the undated siblings ride along, and the null creator is not a row.
  assert.deepEqual(d.models.map(m => [m.slug, m.effort, m.releaseDate, m.checkedAt]), [
    ["deepseek-v4-1-flash", "max", "2026-09-10", null],
    ["deepseek-v4-1-flash-high", "high", "", null],
    ["deepseek-v4-1-flash-low", "low", "", null],
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
  const d = await runDataset({ apiKey: "fixture-key", fetchImpl, limit: 0, log: line => logs.push(line) });
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
  await assert.rejects(runDataset({ apiKey: "fixture-key", fetchImpl: async () => Response.json({ intelligence_index_version: "v5.0.1", tier: "pro", data: rows }), limit: 0 }), { message: "AA API list has no pagination; refusing what may be a partial list" });
});
