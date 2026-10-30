// The dashboard's CPU priority row (About view): the page's own priorityRow and savePriority,
// evaluated from app.js against stub elements, and the strings in every language it speaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROCESS_PRIORITIES, validate, DEFAULTS } from "../src/config.ts";

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");

type State = { supported: boolean; setting: string; current: string | null };
type Select = { key: string; items: { value: string; label: string }[]; value: string; disabled: boolean; onChange: (value: string) => void };
type Row = { label: string; value: Select; sub: (string | { text: string; class: string })[] };

function loadRow(state: State | undefined, answers: { confirm?: boolean } = {}) {
  const source = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  const start = source.indexOf("// How much CPU priority");
  const end = source.indexOf("function versionRow(", start);
  assert.ok(start > 0 && end > start, "app.js no longer holds the priority row where this test reads it");
  const h = {
    status: { processPriority: state } as Record<string, unknown>,
    config: { autoUpdate: true } as Record<string, unknown>,
    saved: [] as Record<string, unknown>[],
    toasts: [] as string[],
    confirms: [] as string[],
  };
  const run = new Function("h", `
    let status = h.status, currentConfig = null;
    const t = (key, vars) => vars ? key + JSON.stringify(vars) : key;
    const el = (tag, attrs) => ({ tag, ...attrs });
    const cell = (label, value, sub) => ({ label, value, sub });
    const modSelect = (key, items, value, label, onChange) => ({ key, items, value, label, onChange, disabled: false });
    const confirm = (text) => { h.confirms.push(text); return ${answers.confirm ?? true}; };
    const api = async () => JSON.parse(JSON.stringify(h.config));
    const configRequest = async (next) => { h.saved.push(JSON.parse(JSON.stringify(next))); return {}; };
    const configSaved = (out, message) => h.toasts.push(message);
    const toast = (message) => h.toasts.push(message);
    const refreshHealth = async () => {};
    ${source.slice(start, end)}
    return { priorityRow, savePriority };
  `)(h) as { priorityRow: () => Row | null; savePriority: (value: string, select: Select) => Promise<void> };
  return { h, ...run };
}

const texts = (row: Row) => row.sub.map((line) => (typeof line === "string" ? line : line.text));

test("the row is drawn only where the router reports the levels", () => {
  assert.equal(loadRow(undefined).priorityRow(), null, "an older router says nothing about it");
  assert.equal(loadRow({ supported: false, setting: "normal", current: null }).priorityRow(), null, "macOS and Linux");
  const row = loadRow({ supported: true, setting: "normal", current: "normal" }).priorityRow()!;
  assert.equal(row.label, "priority.label");
  assert.deepEqual(row.value.items.map((item) => item.value), ["below-normal", "normal", "above-normal", "high"]);
  assert.deepEqual(row.value.items.map((item) => item.label), ["priority.belowNormal", "priority.normal", "priority.aboveNormal", "priority.high"]);
  assert.equal(row.value.value, "normal");
  assert.deepEqual(texts(row), ["priority.help"]);
});

test("High carries its warning, and a level Windows reports otherwise is named", () => {
  assert.deepEqual(texts(loadRow({ supported: true, setting: "high", current: "high" }).priorityRow()!), ["priority.help", "priority.highWarning"]);
  const changed = loadRow({ supported: true, setting: "normal", current: "idle" }).priorityRow()!;
  assert.deepEqual(texts(changed), ["priority.help", 'priority.current{"level":"priority.idle"}']);
});

test("choosing High asks first, and a refusal saves nothing", async () => {
  const { h, priorityRow, savePriority } = loadRow({ supported: true, setting: "normal", current: "normal" }, { confirm: false });
  const select = priorityRow()!.value;
  select.value = "high";
  await savePriority("high", select);
  assert.deepEqual(h.confirms, ["priority.highConfirm"]);
  assert.equal(h.saved.length, 0);
  assert.equal(select.value, "normal", "the menu goes back to what is saved");
});

test("a chosen level is saved into the config the router holds now", async () => {
  const { h, priorityRow, savePriority } = loadRow({ supported: true, setting: "normal", current: "normal" });
  await savePriority("above-normal", priorityRow()!.value);
  assert.deepEqual(h.confirms, [], "only High asks");
  assert.deepEqual(h.saved, [{ autoUpdate: true, processPriority: "above-normal" }]);
  assert.deepEqual(h.toasts, ["common.saved"]);
  await savePriority("high", priorityRow()!.value);
  assert.deepEqual(h.confirms, ["priority.highConfirm"]);
  assert.equal(h.saved.at(-1)!.processPriority, "high");
});

test("every level the menu offers is one the router accepts", () => {
  assert.deepEqual([...PROCESS_PRIORITIES], ["below-normal", "normal", "above-normal", "high"]);
  for (const level of PROCESS_PRIORITIES) assert.deepEqual(validate({ ...DEFAULTS, processPriority: level }), [], level);
});

test("every language the dashboard speaks has the priority row", () => {
  const source = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
  const start = source.indexOf("const I18N = {");
  const end = source.indexOf("\n};", start);
  const dict = new Function(`${source.slice(start, end + 3)}; return I18N;`)() as Record<string, Record<string, string>>;
  const keys = ["label", "help", "belowNormal", "normal", "aboveNormal", "high", "idle", "realtime", "highWarning", "highConfirm", "current"].map((key) => `priority.${key}`);
  for (const [lang, table] of Object.entries(dict)) {
    for (const key of keys) assert.ok(table[key], `${lang}: ${key}`);
    assert.equal(table["priority.current"]!.split("{level}").length, 2, `${lang}: priority.current names {level} once`);
  }
});
