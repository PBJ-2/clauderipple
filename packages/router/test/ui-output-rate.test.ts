// The recent requests list shows an output rate beside a request's duration: output tokens over the
// request's whole recorded time, which includes the wait for the first token. The rate is a plain
// function in the dashboard's classic script, so the test evaluates it straight from the source text,
// as the token test does. What is fixed here: only a finished model answer with a real output count
// gets a rate, and every language says what the figure measures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Rate = (record: unknown) => number | null;

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");

function loadRate(): Rate {
  const source = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  const start = source.indexOf("// Below this a request is mostly fixed overhead");
  const end = source.indexOf("function formatRate", start);
  assert.ok(start > 0 && end > start, "app.js no longer contains the output-rate block");
  return new Function(`${source.slice(start, end)}; return outputRateOf;`)() as Rate;
}

function loadI18n(): Record<string, Record<string, string>> {
  const source = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
  const start = source.indexOf("const I18N = {");
  const end = source.indexOf("\n};", start);
  assert.ok(start > 0 && end > start, "i18n.js no longer contains the dictionary");
  return new Function(`${source.slice(start, end + 3)}; return I18N;`)() as Record<string, Record<string, string>>;
}

const answer = { kind: "messages", ok: true, status: 200, ms: 4_000, usage: { input: 10, cached: 0, output: 800 } };

test("a finished answer's rate is its output over its whole time", () => {
  assert.equal(loadRate()(answer), 200);
});

test("a request with no real answer or output has no rate", () => {
  const rate = loadRate();
  for (const record of [
    { ...answer, ok: false, status: 502 },
    { ...answer, ok: false, status: "aborted" },
    { ...answer, resent: true },
    { ...answer, upstreamCalled: false },
    { ...answer, purpose: "web-search" },
    { ...answer, kind: "image" },
    { ...answer, kind: "count_tokens" },
    { ...answer, usage: undefined },
    { ...answer, usage: { input: 10, cached: 0, output: 0 } },
    { ...answer, ms: 120 },
    { ...answer, ms: 0 },
    { ...answer, ms: Number.NaN },
  ]) assert.equal(rate(record), null, JSON.stringify(record));
});

test("every language names the rate and says the first-token wait is in it", () => {
  const i18n = loadI18n();
  for (const [lang, table] of Object.entries(i18n)) {
    assert.match(table["logs.rate"] ?? "", /\{value\}/, lang);
    assert.ok((table["logs.rateHelp"] ?? "").length > 20, lang);
  }
});
