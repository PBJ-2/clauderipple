// The dashboard's Auto mode classifier rows: one per stage, each a provider and model or Claude Code's
// own choice. The two pure functions that turn the config into rows and back are evaluated straight
// from app.js, and what they save has to pass the router's own validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, validate, type Config } from "../src/config.ts";

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");

type Target = { provider: string; model: string; effort?: string };
type Rows = { first: Target | null; rest: Target | null };
type Setting = NonNullable<Config["autoModeClassifier"]>;

type Translation = {
  classifierRowsOf: (settings: unknown) => Rows;
  classifierSettingOf: (first: Target | null, rest: Target | null) => Setting | undefined;
  classifierNames: (settings: unknown, provider: string) => boolean;
  classifierWithout: (settings: unknown, provider: string) => Setting | undefined;
};

function loadTranslation(): Translation {
  const source = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  const start = source.indexOf("/** The two rows a setting shows");
  const end = source.indexOf("// Claude Code refuses these", start);
  assert.ok(start > 0 && end > start, "app.js no longer holds the classifier translation where this test reads it");
  // The slice may end in a line comment, so the return starts on a line of its own.
  return new Function(`${source.slice(start, end)}\nreturn { classifierRowsOf, classifierSettingOf, classifierNames, classifierWithout };`)();
}

function loadI18n(): Record<string, Record<string, string>> {
  const source = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
  const start = source.indexOf("const I18N = {");
  const end = source.indexOf("\n};", start);
  assert.ok(start > 0 && end > start, "i18n.js no longer contains the dictionary");
  return new Function(`${source.slice(start, end + 3)}; return I18N;`)() as Record<string, Record<string, string>>;
}

const luna = { provider: "chatgpt", model: "gpt-6-luna", effort: "high" };
const sonnet = { provider: "cls", model: "claude-sonnet-5-5" };
const haiku = { provider: "cls", model: "claude-haiku-5-5" };
const providers: Config["providers"] = { chatgpt: { type: "chatgpt" }, cls: { type: "anthropic", auth: "claude-code", accountPool: true } };

test("the classifier rows read every way the config can say them", () => {
  const { classifierRowsOf } = loadTranslation();
  assert.deepEqual(classifierRowsOf(undefined), { first: null, rest: null });
  assert.deepEqual(classifierRowsOf(luna), { first: luna, rest: luna }, "without stage1 the first stage follows the main target");
  assert.deepEqual(classifierRowsOf({ ...luna, stage1: sonnet }), { first: sonnet, rest: luna });
  assert.deepEqual(classifierRowsOf({ ...luna, stage1: "native" }), { first: null, rest: luna });
  assert.deepEqual(classifierRowsOf({ stage1: haiku }), { first: haiku, rest: null });
});

test("whatever two rows the person picks save as a setting the router accepts, and read back the same", () => {
  const { classifierRowsOf, classifierSettingOf } = loadTranslation();
  const picks: [string, Target | null, Target | null][] = [
    ["both on one model", haiku, haiku],
    ["a fast first stage and a GPT second", sonnet, luna],
    ["the first stage alone", haiku, null],
    ["the second stage alone", null, luna],
    ["one model, two efforts", { ...luna, effort: "low" }, luna],
  ];
  for (const [name, first, rest] of picks) {
    const setting = classifierSettingOf(first, rest)!;
    assert.deepEqual(validate({ ...DEFAULTS, providers, autoModeClassifier: setting }), [], name);
    assert.deepEqual(classifierRowsOf(setting), { first, rest }, name);
  }
  assert.deepEqual(classifierSettingOf(haiku, haiku), haiku, "one model for both is written without stage1");
  assert.equal(classifierSettingOf(null, null), undefined, "both left to Claude Code removes the field");
});

test("removing a provider clears each stage that named it and keeps the other", () => {
  const { classifierNames, classifierWithout } = loadTranslation();
  const others: Config["providers"] = { chatgpt: providers.chatgpt! };
  const cases: [string, Setting, Setting | undefined][] = [
    ["a first stage on the removed provider goes back to Claude Code", { ...luna, stage1: sonnet }, { ...luna, stage1: "native" }],
    ["a first stage on another provider outlives the rest's", { ...sonnet, stage1: luna }, { stage1: luna }],
    ["one target on both stages leaves nothing", haiku, undefined],
    ["the first stage alone leaves nothing", { stage1: haiku }, undefined],
    ["a native first stage leaves nothing once the rest goes", { ...haiku, stage1: "native" }, undefined],
  ];
  for (const [name, setting, kept] of cases) {
    assert.equal(classifierNames(setting, "cls"), true, name);
    assert.deepEqual(classifierWithout(setting, "cls"), kept, name);
    if (kept) assert.deepEqual(validate({ ...DEFAULTS, providers: others, autoModeClassifier: kept }), [], `${name}: the next save is accepted`);
  }
  assert.equal(classifierNames({ ...luna, stage1: "native" }, "cls"), false, "a setting that never names the provider is left alone");
  assert.equal(classifierNames(undefined, "cls"), false);
});

// The row save from app.js, run against two stub selects. The router's GET and PUT wait until the test
// lets each one through, and a landed save redraws the selects from what it stored, as the page does.
// `redraw` is the status refresh's redraw, which can come at any moment.
function loadSave(stored: Record<string, unknown> = { providers }) {
  const source = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  const block = (from: string, to: string) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start > 0 && end > start, `app.js no longer holds ${from}`);
    return source.slice(start, end);
  };
  const h = {
    rows: { first: "", rest: "" } as Record<string, string>,
    stored,
    gets: [] as (() => void)[],
    puts: [] as (() => void)[],
    writes: [] as Record<string, unknown>[],
  };
  const save = new Function("h", `
    let currentConfig = JSON.parse(JSON.stringify(h.stored));
    const clone = (value) => JSON.parse(JSON.stringify(value)), t = (key) => key, toast = () => {};
    const routeFromTarget = (value) => { if (!value) return null; const [provider, model] = JSON.parse(value); return { provider, model }; };
    const $ = (selector) => {
      if (selector === "#client-auto-classifier") return { replaceChildren: () => {} };
      if (selector === "#client-auto-classifier-note") return null;
      const match = /data-classifier(-effort)?="(\\w+)"/.exec(selector);
      return match && !match[1] ? { value: h.rows[match[2]] } : { value: "" };
    };
    // The page's own renderAutoClassifier runs below; drawing a row records what it would select.
    const classifierGroups = () => [];
    const classifierRow = (stage, saved) => { h.rows[stage] = saved ? JSON.stringify([saved.provider, saved.model]) : ""; return null; };
    const latestConfig = () => new Promise((resolve) => h.gets.push(() => resolve(currentConfig = clone(h.stored))));
    const configRequest = (next) => new Promise((resolve) => h.puts.push(() => { h.stored = clone(next); h.writes.push(clone(next)); resolve({}); }));
    ${block("function isTargetProvider(", "function groupedModels(")}
    ${block("/** The two rows a setting shows", "// Claude Code refuses these")}
    ${block("function renderAutoClassifier(", "function clientPickerSelections(")}
    return { save: saveAutoClassifier, redraw: renderAutoClassifier };
  `)(h) as { save: () => Promise<void>; redraw: () => void };
  return { h, ...save };
}

test("overlapping classifier saves store the last choice", async () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const pick = (target: Target) => JSON.stringify([target.provider, target.model]);
  // The stub effort selects are empty, so no effort is saved.
  const last = { provider: luna.provider, model: luna.model, stage1: haiku };

  // B is chosen while A's write is on its way: A lands and redraws, and B still saves B.
  {
    const { h, save } = loadSave();
    h.rows.first = pick(sonnet); h.rows.rest = pick(luna);
    void save();
    await flush(); h.gets.shift()!(); await flush();
    assert.equal(h.puts.length, 1, "A is being written");
    h.rows.first = pick(haiku);
    const second = save();
    h.puts.shift()!(); await flush();
    h.gets.shift()!(); await flush(); h.puts.shift()!();
    await second;
    assert.equal(h.writes.length, 2);
    assert.deepEqual(h.writes.at(-1)!.autoModeClassifier, last, "the newer choice is the one stored");
    assert.equal(h.rows.first, pick(haiku), "the rows show what was stored last");
  }

  // B is chosen while A is still reading the config: A never writes.
  {
    const { h, save } = loadSave();
    h.rows.first = pick(sonnet); h.rows.rest = pick(luna);
    void save();
    await flush();
    h.rows.first = pick(haiku);
    const second = save();
    h.gets.shift()!(); await flush();
    h.gets.shift()!(); await flush(); h.puts.shift()!();
    await second;
    assert.deepEqual(h.writes.map((write) => write.autoModeClassifier), [last], "an overtaken save is dropped");
  }
});

test("a status redraw between two classifier choices keeps the first one", async () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const pick = (target: Target) => JSON.stringify([target.provider, target.model]);
  const terra = { provider: "chatgpt", model: "gpt-5.6-terra" };
  const { h, save, redraw } = loadSave({ providers, autoModeClassifier: { provider: luna.provider, model: luna.model, stage1: sonnet } });
  redraw();
  assert.equal(h.rows.first, pick(sonnet));

  // Haiku is chosen and its save waits on the config read while the status refresh redraws.
  h.rows.first = pick(haiku);
  void save();
  await flush();
  redraw();
  assert.equal(h.rows.first, pick(haiku), "the redraw shows the choice being saved, not the stored one");

  // The second row changes next, and that save carries both choices.
  h.rows.rest = pick(terra);
  const second = save();
  h.gets.shift()!(); await flush();
  h.gets.shift()!(); await flush(); h.puts.shift()!();
  await second;
  assert.deepEqual(h.writes.map((write) => write.autoModeClassifier), [{ ...terra, stage1: haiku }]);
  redraw();
  assert.deepEqual([h.rows.first, h.rows.rest], [pick(haiku), pick(terra)], "once stored, the rows are drawn from the config again");
});

test("every language the dashboard speaks has the classifier rows", () => {
  const keys = ["title", "first", "firstHelp", "rest", "restHelp", "native", "effortDefault", "refusesStage2", "help", "claudeNeedsPool", "saved"].map((key) => `classifier.${key}`);
  for (const [lang, dict] of Object.entries(loadI18n())) {
    for (const key of keys) assert.ok(dict[key], `${lang}: ${key}`);
  }
});
