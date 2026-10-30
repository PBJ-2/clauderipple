// The ChatGPT provider's Fast switches in the dashboard: both must be offered, in every language the
// dashboard speaks, and the form must save what it shows. The dashboard is a classic script, so the
// dictionary is evaluated straight from the source text, the way the other UI tests read app.js.
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

test("every language the dashboard speaks has the ChatGPT Fast switches", () => {
  const i18n = loadI18n();
  for (const [lang, dict] of Object.entries(i18n)) {
    assert.ok(dict["providers.fastMain"], `${lang}: providers.fastMain`);
    assert.ok(dict["providers.fastSubagent"], `${lang}: providers.fastSubagent`);
    assert.ok(dict["providers.fastHelp"], `${lang}: providers.fastHelp`);
  }
  assert.equal(i18n.ko!["providers.fastMain"], "메인 세션에 Fast 적용");
  assert.equal(i18n.ko!["providers.fastSubagent"], "서브에이전트에 Fast 적용");
  assert.equal(i18n.ko!["providers.fastHelp"], "활성화하면 GPT 요청을 Codex의 Fast(고속) 등급으로 전송합니다. 응답 속도는 빨라지지만 구독 사용량이 더 빠르게 소진됩니다.");
});

test("the ChatGPT provider form shows both switches and saves them", () => {
  const source = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  // The two switches, read back from the saved provider.
  assert.match(source, /existing\.fast && existing\.fast\.main === true/);
  assert.match(source, /existing\.fast && existing\.fast\.subagent === true/);
  assert.match(source, /fast: \{ main: chat\.fastMain\.checked, subagent: chat\.fastSubagent\.checked \}/);
  // The form owns the field, so the saved one is not merged over it (and not dropped either).
  assert.match(source, /"instructionsAppend", "fast", "models"/);
});
