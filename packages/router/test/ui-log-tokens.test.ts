// The recent requests list reads a request as it did before ba1ba32: the whole prompt in the input
// cell, with the cache's share on a pill inside it, and the output in a cell of its own. Only the
// summary gained a tokens chip (060cc48), now supplied by conversation accounting: the last whole
// prompt per conversation plus every output, rather than summing every request's prompt. The
// dashboard's counters are plain functions in a classic script, so the test evaluates them straight
// from the source text, as the picker test does. What is fixed here: a cache write is not a hit, a
// fully cached Anthropic turn (`input: 2`) is not a two-token request, and the row is not the
// two-column tokens/cache form the revert took out.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Usage = { input: number; cached: number; cacheWrite?: number; output: number };

type TokenBlock = {
  totalInputOf: (usage: Usage) => number;
};

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(uiDir, file), "utf8");
}

function slice(file: string, from: string, to: string): string {
  const source = sourceOf(file);
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start > 0 && end > start, `${file} no longer contains ${from} through ${to}`);
  return source.slice(start, end);
}

function loadTokenBlock(): TokenBlock {
  const source = sourceOf("app.js");
  const start = source.indexOf("function totalInputOf");
  const end = source.indexOf("function requestDetail");
  assert.ok(start > 0 && end > start, "app.js no longer contains the token-counting block");
  return new Function(`${source.slice(start, end)}; return { totalInputOf };`)() as TokenBlock;
}

function loadI18n(): Record<string, Record<string, string>> {
  const source = sourceOf("i18n.js");
  const start = source.indexOf("const I18N = {");
  const end = source.indexOf("\n};", start);
  assert.ok(start > 0 && end > start, "i18n.js no longer contains the dictionary");
  return new Function(`${source.slice(start, end + 3)}; return I18N;`)() as Record<string, Record<string, string>>;
}

const LANGUAGES = ["ko", "en", "zh", "ja", "es", "pt"];

test("a prompt is read whole: uncached, cache write and cache read", () => {
  const { totalInputOf } = loadTokenBlock();
  assert.equal(totalInputOf({ input: 2, cached: 45_000, cacheWrite: 1_200, output: 900 }), 46_202);
});

test("a record that reports no cache write still counts all it read", () => {
  const { totalInputOf } = loadTokenBlock();
  assert.equal(totalInputOf({ input: 100, cached: 900, output: 10 }), 1_000);
});

// The summary leads a period with the same figure the Agents card counts an agent by, and keeps the
// prompt's own total and the output on their own beside it.
test("the summary displays conversation tokens, not the sum of every prompt, including a provider filter", () => {
  const body = slice("app.js", "function renderSummary(", "function fitSummaryValues(");
  // The cost chip and note (ui-cost.test.ts) are not what this test is about: no cost, no note.
  const render = new Function("summary", "requestProvider", "EMPTY_BUCKET", "t", "formatNumber", "summaryChip", "$", "totalInputOf", "formatSeconds", "fitSummaryValues", "costFigureOf", "renderCostNote", `${body}; renderSummary(summary);`);
  const total = { count: 3, ok: 3, failed: 0, input: 2000, cached: 8000, output: 100, conversationTokens: 4100 };
  const provider = { ...total, conversationTokens: 2100 };
  for (const filter of ["", "chatgpt"]) {
    let chips: { label: string; value: unknown }[] = [];
    render({ total, providers: { chatgpt: provider } }, filter, {}, (key: string) => key,
      (n: number) => n, (label: string, value: unknown) => ({ label, value }),
      () => ({ classList: { toggle: () => {} }, replaceChildren: (...values: typeof chips) => { chips = values; } }),
      loadTokenBlock().totalInputOf, (n: number) => n, () => {}, () => null, () => {});
    assert.equal(chips[2]!.label, "logs.th.tokens");
    assert.equal(chips[2]!.value, filter ? 2100 : 4100);
    assert.equal(chips[3]!.value, 10000, "the independent input counter must not change");
    assert.equal(chips[4]!.value, 100);
  }
});

// The row went back to its earlier shape: the input and the output are columns of their own, and the
// tokens/cache pair ba1ba32 put in their place is gone.
test("the recent requests table has the input and output columns", () => {
  const html = sourceOf("index.html");
  const row = /<table id="requests-table"><thead><tr>([\s\S]*?)<\/tr>/.exec(html)?.[1];
  assert.ok(row, "index.html no longer has the requests table's head");
  const input = row.indexOf('data-i18n="logs.th.input"');
  const output = row.indexOf('data-i18n="logs.th.output"');
  assert.ok(input > 0 && output > input, "the requests table no longer reads input then output");
  assert.equal(row.includes('data-i18n="logs.th.tokens"'), false, "the requests table shows the tokens again");
  assert.equal(row.includes('data-i18n="logs.th.cache"'), false, "the requests table shows the cache again");
});

test("a request row keeps the cache's share on the input cell and the output on its own", () => {
  const row = slice("app.js", "function requestRow(", "function renderRequests(");
  assert.ok(row.includes('class: "c-in"'), "the row's input cell is gone");
  assert.ok(row.includes("cache-pill"), "the cache's share no longer rides in the input cell");
  assert.ok(row.includes("c-out"), "the row's output cell is gone");
  assert.equal(row.includes("logs.th.tokens"), false, "the row takes the tokens column again");
  assert.equal(row.includes("logs.th.cache"), false, "the row takes the cache column again");
  const detail = slice("app.js", "function requestDetail(", "function requestRow(");
  assert.equal(detail.includes("logs.detail.output"), false, "the detail row repeats the output");
});

// The summary chip's word stays in every language; the two words the row no longer uses are gone
// with it (ui-i18n-parity holds every language to the same keys).
test("the summary's tokens label is in every language and the row's labels are gone", () => {
  const i18n = loadI18n();
  for (const lang of LANGUAGES) {
    assert.ok(i18n[lang]?.["logs.th.tokens"], `${lang} lost the summary's tokens label`);
    assert.equal("logs.th.cache" in i18n[lang]!, false, `${lang} still carries the row's cache label`);
    assert.equal("logs.detail.output" in i18n[lang]!, false, `${lang} still carries the detail's output label`);
  }
});
