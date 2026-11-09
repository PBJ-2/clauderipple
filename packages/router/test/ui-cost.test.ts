// The dashboard's usage summary shows what a period's requests would cost at public API prices:
// a cost chip in the total (the chosen provider's, or all), a cost cell on each model row, and a
// note under the chips. The functions are plain ones in the dashboard's classic script, so the test
// evaluates them straight from the source text, as the output-rate test does. What is fixed here: an
// amount reads in dollars with a "—" for a row nothing of which was priced (never a free $0.00), a
// "≈" for one that includes an estimate, no cost at all from a router that sends none, the note
// carrying the unpriced and estimated counts, and every language having the words.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Bucket = { costUsd?: number | string; unpricedRequests?: number; estimatedRequests?: number; [key: string]: unknown };
type Fake = { tag: string; attrs: Record<string, unknown>; children: unknown[] };
type Cost = {
  costUsdText: (usd: number) => string;
  costFigureOf: (bucket: Bucket | null) => string | null;
  costCaveatsOf: (bucket: Bucket | null) => string[];
  modelCostCell: (entry: Bucket) => Fake;
};
type Summary = { chips: { label: string; value: string; sub?: string }[]; withCost: boolean | undefined; note: { hidden: boolean; lines: string[] } };

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");
const source = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start > 0 && end > start, `app.js no longer contains ${from} through ${to}`);
  return source.slice(start, end);
}

/** Stand-ins for the dashboard's translator, number format and element builder. */
const tt = (key: string, vars: Record<string, unknown> = {}): string => key + Object.entries(vars).map(([k, v]) => `|${k}=${v}`).join("");
const formatNumber = (n: number): string => n.toLocaleString("en-US");
const el = (tag: string, attrs: Record<string, unknown> = {}, children: unknown[] = []): Fake => ({ tag, attrs, children });

function loadCost(): Cost {
  const block = slice("// ---- Cost: what a period's", "const EMPTY_BUCKET") + slice("/** A model row's cost", "function modelUsageRow");
  return new Function("t", "formatNumber", "el", "$", `${block}; return { costUsdText, costFigureOf, costCaveatsOf, modelCostCell };`)(tt, formatNumber, el, () => ({})) as Cost;
}

/** The summary block, run against a fake document: what it puts in the chips and the note. */
function loadSummary(provider = ""): (summary: unknown) => Summary {
  const block = slice("// ---- Cost: what a period's", "// A long period runs the input");
  const out: Summary = { chips: [], withCost: undefined, note: { hidden: true, lines: [] } };
  const nodes: Record<string, unknown> = {
    "#logs-summary": { classList: { toggle: (_: string, on: boolean) => { out.withCost = on; } }, replaceChildren: (...chips: Summary["chips"]) => { out.chips = chips; } },
    "#logs-cost-note": { set hidden(value: boolean) { out.note.hidden = value; }, replaceChildren: (...lines: Fake[]) => { out.note.lines = lines.map((line) => String(line.attrs.text)); } },
  };
  const run = new Function("t", "formatNumber", "el", "$", "totalInputOf", "formatSeconds", "summaryChip", "fitSummaryValues", "requestProvider",
    `${block}; return renderSummary;`)(
    tt, formatNumber, el, (selector: string) => nodes[selector], (u: { input?: number }) => u.input ?? 0, (ms: number) => `${ms}ms`,
    (label: string, value: string, sub?: string) => ({ label, value, sub }), () => {}, provider) as (summary: unknown) => void;
  return (summary) => { out.chips = []; run(summary); return { ...out, chips: [...out.chips] }; };
}

const bucket = (costUsd: number, unpricedRequests = 0, estimatedRequests = 0) => ({ count: 10, ok: 10, failed: 0, input: 5, cached: 0, cacheWrite: 0, output: 1, avgMs: 100, cacheHitPercent: 0, conversationTokens: 2, costUsd, unpricedRequests, estimatedRequests });

test("an amount reads in dollars, less than a cent as <$0.01", () => {
  const { costUsdText } = loadCost();
  assert.equal(costUsdText(15.678), "$15.68");
  assert.equal(costUsdText(1234.5), "$1,234.50");
  assert.equal(costUsdText(1_000_000), "$1,000,000.00");
  assert.equal(costUsdText(0.004), "<$0.01");
  assert.equal(costUsdText(0.005), "$0.01");
  assert.equal(costUsdText(0), "$0.00");
  assert.equal(costUsdText(Number.NaN), "$0.00");
});

test("a bucket nothing of which was priced says \"—\", an estimate says \"≈\", and no cost from the router says nothing", () => {
  const { costFigureOf } = loadCost();
  assert.equal(costFigureOf(bucket(12.3)), "$12.30");
  assert.equal(costFigureOf(bucket(12.3, 2)), "$12.30");
  assert.equal(costFigureOf(bucket(12.3, 0, 4)), "≈$12.30");
  assert.equal(costFigureOf(bucket(0, 5)), "—");
  assert.equal(costFigureOf(bucket(0, 5, 5)), "—");
  assert.equal(costFigureOf(bucket(0)), "$0.00");
  const { costUsd: _, ...plain } = bucket(1);
  for (const none of [plain, null, { costUsd: "1.00" }, { costUsd: Number.NaN }]) assert.equal(costFigureOf(none as Bucket | null), null, JSON.stringify(none));
});

test("a model row has its amount, \"—\" without a price or from an older router, and its caveats on hover", () => {
  const { modelCostCell } = loadCost();
  const cell = (entry: Bucket) => modelCostCell(entry);
  assert.deepEqual(cell({ model: "m", ...bucket(2.4) }).children, ["$2.40"]);
  assert.equal(cell({ model: "m", ...bucket(2.4) }).attrs.title, undefined);
  assert.deepEqual(cell({ model: "m", ...bucket(9.9, 0, 12) }).children, ["≈$9.90"]);
  assert.equal(cell({ model: "m", ...bucket(9.9, 0, 12) }).attrs.title, "logs.cost.estimated|count=12");
  assert.deepEqual(cell({ model: "m", ...bucket(0, 3) }).children, ["—"]);
  assert.equal(cell({ model: "m", ...bucket(0, 3) }).attrs.title, "logs.cost.unpriced|count=3");
  assert.deepEqual(cell({ model: "m", ...bucket(1, 3, 2) }).attrs.title, "logs.cost.unpriced|count=3 logs.cost.estimated|count=2");
  // A router that sends no cost: a dash, not a $0.00.
  const { costUsd: _, ...plain } = bucket(1);
  assert.deepEqual(cell({ model: "m", ...plain }).children, ["—"]);
  assert.equal(cell({ model: "m", ...bucket(1) }).attrs.class, "c-cost");
  assert.equal(cell({ model: "m", ...bucket(1) }).attrs["data-label"], "logs.th.cost");
});

test("the total has a cost chip before the duration, and a note with what the amount leaves out", () => {
  const summary = { total: bucket(15.678, 3, 12), providers: { anthropic: bucket(12.3), chatgpt: bucket(0, 3) }, models: [] };
  const all = loadSummary()(summary);
  assert.deepEqual(all.chips.map((chip) => chip.label), ["logs.summary.requests", "logs.summary.success", "logs.th.tokens", "logs.summary.input", "logs.summary.output", "logs.summary.cost", "logs.summary.duration"]);
  const chip = all.chips.find((c) => c.label === "logs.summary.cost")!;
  assert.equal(chip.value, "≈$15.68");
  assert.equal(chip.sub, "logs.cost.basis");
  assert.equal(all.withCost, true);
  assert.deepEqual(all.note, { hidden: false, lines: ["logs.cost.note", "logs.cost.unpriced|count=3", "logs.cost.estimated|count=12"] });
  // One provider chosen: its own bucket, its own caveats.
  const one = loadSummary("anthropic")(summary);
  assert.equal(one.chips.find((c) => c.label === "logs.summary.cost")!.value, "$12.30");
  assert.deepEqual(one.note.lines, ["logs.cost.note"]);
  const unpriced = loadSummary("chatgpt")(summary);
  assert.equal(unpriced.chips.find((c) => c.label === "logs.summary.cost")!.value, "—");
  assert.deepEqual(unpriced.note.lines, ["logs.cost.note", "logs.cost.unpriced|count=3"]);
});

test("a router that sends no cost, or no summary yet, shows no cost chip and no note", () => {
  const { costUsd: _, ...plain } = bucket(1);
  for (const summary of [{ total: plain, providers: {}, models: [] }, null, {}]) {
    const drawn = loadSummary()(summary);
    assert.equal(drawn.chips.some((c) => c.label === "logs.summary.cost"), false);
    assert.equal(drawn.chips.length, 6);
    assert.equal(drawn.withCost, false);
    assert.equal(drawn.note.hidden, true);
    assert.deepEqual(drawn.note.lines, []);
  }
  // A period with nothing in it is a real $0.00.
  assert.equal(loadSummary()({ total: bucket(0), providers: {}, models: [] }).chips.find((c) => c.label === "logs.summary.cost")!.value, "$0.00");
});

test("every dashboard language has the cost words, with the counts the note fills", () => {
  const text = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
  const dictionaries = new Function(`${text.slice(0, text.indexOf("const LANGUAGES"))}; return I18N;`)() as Record<string, Record<string, string>>;
  const keys = ["logs.summary.cost", "logs.th.cost", "logs.cost.basis", "logs.cost.note", "logs.cost.unpriced", "logs.cost.estimated"];
  for (const lang of ["ko", "en", "zh", "ja", "es", "pt"]) {
    for (const key of keys) assert.ok(dictionaries[lang]?.[key]?.trim(), `${lang}: ${key}`);
    assert.ok(dictionaries[lang]!["logs.cost.unpriced"]!.includes("{count}"), `${lang} unpriced`);
    assert.ok(dictionaries[lang]!["logs.cost.estimated"]!.includes("{count}") && dictionaries[lang]!["logs.cost.estimated"]!.includes("≈"), `${lang} estimated`);
  }
  assert.equal(dictionaries.ko!["logs.summary.cost"], "비용");
  assert.equal(dictionaries.ko!["logs.cost.unpriced"], "가격을 알 수 없는 요청 {count}건은 금액에 포함되지 않았습니다.");
});

test("the model table has a cost column between the output and the duration", () => {
  const html = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
  const table = html.slice(html.indexOf('<table id="models-table">'), html.indexOf("</table>", html.indexOf('<table id="models-table">')));
  assert.deepEqual([...table.matchAll(/<th data-i18n="([^"]+)"/g)].map((m) => m[1]), ["logs.th.models", "logs.th.count", "logs.th.input", "logs.th.output", "logs.th.cost", "logs.th.avg"]);
  assert.ok(html.includes('id="logs-cost-note"'));
});
