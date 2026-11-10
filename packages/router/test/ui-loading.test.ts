// A page's first read, a period or provider change, and a failed read each show something definite: a
// skeleton where nothing has landed, the previous figures dimmed while a new selection's read is in
// flight, the figures themselves, or a failure line. The decision is the plain function `readState` in
// the dashboard's classic script, so the test evaluates it from the source text, as the other UI tests
// do. Also pinned: the loading line exists in every language, every element the loading code names is in
// the markup, and no read is discarded because a newer one started (that starved the Logs page: any read
// slower than the 3-second refresh never drew).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ReadState = (drawnKey: string | null, failedKey: string | null, key: string) => string;

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");
// readState's end marker spans lines, and a Windows checkout (core.autocrlf) ends lines with CRLF.
const appSource = fs.readFileSync(path.join(uiDir, "app.js"), "utf8").replaceAll("\r\n", "\n");
const indexSource = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");

function loadReadState(): ReadState {
  const start = appSource.indexOf("function readState(");
  const end = appSource.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start, "app.js no longer contains readState");
  return new Function(`${appSource.slice(start, end + 3)}; return readState;`)() as ReadState;
}

function loadI18n(): Record<string, Record<string, string>> {
  const source = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
  const start = source.indexOf("const I18N = {");
  const end = source.indexOf("\n};", start);
  assert.ok(start > 0 && end > start, "i18n.js no longer contains the dictionary");
  return new Function(`${source.slice(start, end + 3)}; return I18N;`)() as Record<string, Record<string, string>>;
}

test("a selection shows its figures, dimmed figures of an earlier one, a skeleton, or a failure", () => {
  const readState = loadReadState();
  // Nothing landed yet: a skeleton, whatever the selection.
  assert.equal(readState(null, null, "hour"), "skeleton");
  // The figures on screen are for this selection: they show as they are, even when a later read failed.
  assert.equal(readState("7d", null, "7d"), "current");
  assert.equal(readState("7d", "7d", "7d"), "current");
  // Figures of an earlier selection stay readable, dimmed, while this one's read is in flight.
  assert.equal(readState("hour", null, "7d"), "dimmed");
  // This selection's latest read failed and nothing for it is drawn: the failure shows, not the old figures.
  assert.equal(readState("hour", "7d", "7d"), "failed");
  // A failure of this selection with nothing drawn at all is the failure too, not a skeleton forever.
  assert.equal(readState(null, "hour", "hour"), "failed");
  // A failure for an earlier selection does not touch the figures of the current one.
  assert.equal(readState("7d", "hour", "7d"), "current");
});

test("the loading line is in every language", () => {
  const i18n = loadI18n();
  for (const lang of ["ko", "en", "zh", "ja", "es", "pt"]) {
    const text = i18n[lang]?.["common.loading"];
    assert.ok(text && text !== "common.loading", `${lang} has no common.loading`);
  }
  assert.equal(i18n.ko!["common.loading"], "불러오는 중입니다");
});

test("a newer read does not discard an older one that is still in flight", () => {
  // The poll starts a new read every 3 seconds; a read slower than that used to be superseded and never drawn.
  assert.ok(!appSource.includes("requestsGeneration"), "the superseding counter is back");
  assert.ok(appSource.includes("summarySeqNow < summaryApplied"), "the usage read no longer applies only its newest answer");
  assert.ok(appSource.includes("requestsSeqNow < requestsApplied"), "the requests read no longer applies only its newest answer");
});

test("every element the loading code names is in the markup", () => {
  for (const id of ["logs-updating", "logs-usage-error", "models-error", "requests-error", "clients-status", "logs-summary", "models-table", "requests-table"]) {
    assert.ok(indexSource.includes(`id="${id}"`), `index.html has no #${id}`);
    assert.ok(appSource.includes(`#${id}`) || appSource.includes(`"${id}"`), `app.js does not use #${id}`);
  }
});
