// Every language the dashboard speaks carries every key, with the same placeholders (G-D09).
// A missing key fell back to English, and the screens showed one language in the middle of another;
// a table added with only some translations is caught here rather than on a user's screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");

// The tables are the base `const I18N = {…}` plus the later `Object.assign(I18N.<lang>, {…})` blocks
// (domain ladders, phone, connection card, laptop page). The language list that follows them is where
// the dictionary ends: parity is checked on the combined table the dashboard actually reads.
const DICTIONARY_END = "/** The languages offered";

function loadI18n(): Record<string, Record<string, string>> {
  const source = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
  const start = source.indexOf("const I18N = {");
  const end = source.indexOf(DICTIONARY_END, start);
  assert.ok(start >= 0 && end > start, "i18n.js no longer contains the dictionary");
  return new Function(`${source.slice(start, end)}; return I18N;`)() as Record<string, Record<string, string>>;
}

const LANGUAGES = ["ko", "en", "zh", "ja", "es", "pt", "fr"];

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

test("every string the page markup translates exists in every language", () => {
  const html = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
  const i18n = loadI18n();
  const keys = [...html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(keys.length > 50, "index.html no longer carries data-i18n attributes");
  for (const lang of LANGUAGES) for (const key of keys) assert.ok(i18n[lang]![key] !== undefined, `${lang} ${key}`);
});

// Names, loanwords and labels that are the same word in French and English. A French entry
// outside this list that still reads as the English sentence is an untranslated paste.
const FRENCH_SAME_AS_ENGLISH = new Set([
  "brand", "nav.clients", "clients.title", "health.version", "providers.anthropic", "clients.desktop.title", "providers.google",
  "logs.th.effort", "logs.status.ok", "logs.compaction", "mod.effort.max", "nav.modShort", "mac.net.wifi", "mod.compaction", "mod.effort", "mod.auto", "mod.workers", "mod.haiku", "mod.jev",
  "mod.typesafe", "mod.zen", "mod.cache", "mod.modes", "mod.modeNone", "mod.domain.backend", "phone.notifications",
  "phone.promo.appStoreShort", "phone.promo.googlePlayShort", "conn.routeRipple", "conn.d.cli",
]);

test("the French table is translated, with no English entry left in it", () => {
  const i18n = loadI18n();
  for (const [key, english] of Object.entries(i18n.en!)) {
    if (FRENCH_SAME_AS_ENGLISH.has(key) || !/\p{L}{2}/u.test(english)) continue;
    assert.notEqual(i18n.fr![key], english, `fr ${key} is still English`);
  }
  for (const key of FRENCH_SAME_AS_ENGLISH) assert.ok(i18n.fr![key] !== undefined, `fr ${key}`);
});

test("the French table keeps its typography and its code spans", () => {
  const i18n = loadI18n();
  for (const [key, text] of Object.entries(i18n.fr!)) {
    assert.doesNotMatch(text, /[A-Za-zÀ-ÿ]'[A-Za-zÀ-ÿ]/, `fr ${key} uses a straight apostrophe inside a word`);
    assert.doesNotMatch(text, / [:;?!»%]|« /, `fr ${key} has a breaking space before French punctuation`);
  }
  // Commands, config keys and paths the English text shows are shown unchanged.
  for (const [key, english] of Object.entries(i18n.en!)) {
    for (const span of english.match(/`[^`]+`/g) ?? []) assert.ok(i18n.fr![key]!.includes(span), `fr ${key} lost ${span}`);
  }
  const shown: Record<string, string[]> = {
    "health.diagnosticSettings": ["clauderipple install --force"],
    "health.diagnosticPickerCa": ["clauderipple picker on"],
    "mod.compactAtHint": ["/autocompact"],
    "statusMod.help": ["`/ripple`", "ripple:auto"],
    "clients.codex.help": ["~/.codex/config.toml", "clauderipple"],
    "update.started": ["~/.clauderipple/logs/update.log"],
  };
  for (const [key, snippets] of Object.entries(shown)) {
    for (const snippet of snippets) {
      assert.ok(i18n.en![key]!.includes(snippet), `the English ${key} no longer shows ${snippet}`);
      assert.ok(i18n.fr![key]!.includes(snippet), `fr ${key} lost ${snippet}`);
    }
  }
});

/** Runs i18n.js against a fake page: the stored language, the ?lang= query and the browser language. */
function detect(page: { stored?: string | null; search?: string; navigatorLanguage?: string; storageThrows?: boolean }) {
  const source = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
  const context = vm.createContext({
    document: { readyState: "complete", title: "", querySelectorAll: () => [], addEventListener: () => {} },
    localStorage: {
      getItem: (key: string) => {
        if (page.storageThrows) throw new Error("storage unavailable");
        return key === "clauderipple_lang" ? (page.stored ?? null) : null;
      },
    },
    location: { search: page.search ?? "" },
    navigator: { language: page.navigatorLanguage ?? "en-US" },
    URLSearchParams,
  });
  return vm.runInContext(`${source}\n({ CURRENT_LANG, t, langOf, LANGUAGES, hasI18nKey })`, context) as {
    CURRENT_LANG: string;
    t: (key: string, vars?: Record<string, unknown>) => string;
    langOf: (tag: string) => string | null;
    LANGUAGES: [string, string][];
    hasI18nKey: (key: string) => boolean;
  };
}

test("the selector offers French, named in French, and English stays the default", () => {
  const page = detect({});
  // The array comes from another realm (vm), so compare its content rather than its prototype.
  assert.equal(JSON.stringify(page.LANGUAGES.find(([code]) => code === "fr")), JSON.stringify(["fr", "Français"]));
  assert.equal(page.CURRENT_LANG, "en", "an English browser keeps the English dashboard");
  assert.equal(detect({ navigatorLanguage: "de-DE" }).CURRENT_LANG, "en", "an unsupported language still falls back to English");
});

test("French is picked from ?lang=, from the browser language, and from a stored choice", () => {
  assert.equal(detect({ search: "?lang=fr" }).CURRENT_LANG, "fr");
  assert.equal(detect({ search: "?lang=fr-CA" }).CURRENT_LANG, "fr");
  assert.equal(detect({ navigatorLanguage: "fr" }).CURRENT_LANG, "fr");
  for (const tag of ["fr-FR", "fr-CA", "fr-BE", "fr_CH", "FR-ca"]) assert.equal(detect({ navigatorLanguage: tag }).CURRENT_LANG, "fr", tag);
  assert.equal(detect({ stored: "fr" }).CURRENT_LANG, "fr");
  assert.equal(detect({ stored: "fr-CA" }).CURRENT_LANG, "fr");
});

test("language precedence stays: stored choice, then ?lang=, then the browser", () => {
  assert.equal(detect({ stored: "ko", search: "?lang=fr", navigatorLanguage: "fr-CA" }).CURRENT_LANG, "ko");
  assert.equal(detect({ stored: "fr", search: "?lang=ja", navigatorLanguage: "en-US" }).CURRENT_LANG, "fr");
  assert.equal(detect({ search: "?lang=fr", navigatorLanguage: "ja-JP" }).CURRENT_LANG, "fr");
  assert.equal(detect({ search: "?lang=ja", navigatorLanguage: "fr-CA" }).CURRENT_LANG, "ja");
  // A stored or query value that is not one of ours is ignored rather than breaking the page.
  assert.equal(detect({ stored: "xx", search: "?lang=yy", navigatorLanguage: "fr-CA" }).CURRENT_LANG, "fr");
  assert.equal(detect({ storageThrows: true, search: "?lang=fr", navigatorLanguage: "en-US" }).CURRENT_LANG, "fr");
});

test("with French selected, t() answers in French and fills placeholders", () => {
  const page = detect({ search: "?lang=fr" });
  assert.equal(page.t("common.save"), "Enregistrer");
  assert.equal(page.t("update.install", { latest: "1.2.3" }), "Passer à la version 1.2.3");
  assert.equal(page.t("providers.keyDefaultLabel", { n: 2 }), "Compte 2");
  assert.ok(page.hasI18nKey("mac.unavailable.body"), "a late Object.assign key is in the French table");
  assert.ok(page.hasI18nKey("mod.domainLevelNote"));
  assert.ok(page.hasI18nKey("conn.okTitle"));
  assert.ok(page.hasI18nKey("phone.promo.compact"));
  const english = detect({ navigatorLanguage: "en-US" });
  assert.equal(english.t("common.save"), "Save");
});
