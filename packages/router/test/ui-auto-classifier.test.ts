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

function loadTranslation(): { classifierRowsOf: (settings: unknown) => Rows; classifierSettingOf: (first: Target | null, rest: Target | null) => Setting | undefined } {
  const source = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  const start = source.indexOf("/** The two rows a setting shows");
  const end = source.indexOf("\nconst CLASSIFIER_REFUSES_STAGE2");
  assert.ok(start > 0 && end > start, "app.js no longer holds the classifier translation where this test reads it");
  return new Function(`${source.slice(start, end)}; return { classifierRowsOf, classifierSettingOf };`)();
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

test("every language the dashboard speaks has the classifier rows", () => {
  const keys = ["title", "first", "firstHelp", "rest", "restHelp", "native", "effortDefault", "refusesStage2", "help", "claudeNeedsPool", "saved"].map((key) => `classifier.${key}`);
  for (const [lang, dict] of Object.entries(loadI18n())) {
    for (const key of keys) assert.ok(dict[key], `${lang}: ${key}`);
  }
});
