// Every language the dashboard speaks carries every key, with the same placeholders (G-D09).
// A missing key fell back to English, and the screens showed one language in the middle of another;
// a table added with only some translations is caught here rather than on a user's screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");

function loadI18n(): Record<string, Record<string, string>> {
  const source = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
  const start = source.indexOf("const I18N = {");
  const end = source.indexOf("\n};", start);
  assert.ok(start > 0 && end > start, "i18n.js no longer contains the dictionary");
  return new Function(`${source.slice(start, end + 3)}; return I18N;`)() as Record<string, Record<string, string>>;
}

const LANGUAGES = ["ko", "en", "zh", "ja", "es", "pt"];

test("every dashboard language has the same keys as English", () => {
  const i18n = loadI18n();
  assert.deepEqual(Object.keys(i18n).sort(), [...LANGUAGES].sort());
  const english = i18n.en!;
  for (const lang of LANGUAGES) {
    const table = i18n[lang]!;
    assert.deepEqual(Object.keys(table).sort(), Object.keys(english).sort(), lang);
  }
});

test("a placeholder in one language is in all of them", () => {
  const i18n = loadI18n();
  const english = i18n.en!;
  // A placeholder used twice in one sentence (ja "{app} も… {app} が…") still has to be present everywhere.
  const vars = (text: string): string[] => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
  for (const lang of LANGUAGES) {
    for (const key of Object.keys(english)) assert.deepEqual(vars(i18n[lang]![key]!), vars(english[key]!), `${lang} ${key}`);
  }
});

test("no screen shows a raw key: every key resolves in every language", () => {
  const source = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
  const i18n = loadI18n();
  // The dashboard's own t(): the dictionary entry, or English, or the key itself as a last resort.
  const t = (lang: string, key: string): string => i18n[lang]![key] ?? i18n.en![key] ?? key;
  assert.match(source, /function t\(key, vars\)/, "i18n.js no longer defines t()");
  for (const lang of LANGUAGES) {
    for (const key of Object.keys(i18n.en!)) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
  }
});
