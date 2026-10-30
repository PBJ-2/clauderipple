// A model/effort answer is a notice, and which notice it is says what happened: a `pending` answer
// was accepted and applies after the running response, not a failure. Both receivers (the timeline
// and the phone's composer) read the outcome from one helper, so these are its only rules.
import test from "node:test";
import assert from "node:assert/strict";
import { settingsOutcome } from "../src/settings-notice.ts";
import type { SettingsResult } from "../src/protocol.ts";
import { reduce } from "../web/timeline.ts";
import { dictionaries, setLang, t } from "../web/i18n.ts";

const outcome = (body: SettingsResult) => settingsOutcome(body);
const answer = (seq: number, body: SettingsResult) => ({ seq, at: seq, kind: "settings" as const, reqId: "r1", ...body });

test("a pending answer is accepted, whatever status it carries", () => {
  assert.equal(outcome({ status: "partial", pending: { model: "m2", effort: "low" } }), "pending");
  assert.equal(outcome({ status: "applied", pending: { model: "m2", effort: "low" } }), "pending");
  assert.equal(outcome({ status: "partial", pending: { model: "m1", effort: null } }), "pending", "a null effort is the default, not a missing value");
});

test("only a partial answer that names an error is a partial failure", () => {
  assert.equal(outcome({ status: "partial", errors: { effort: "not supported" } }), "partial");
  assert.equal(outcome({ status: "partial" }), "pending", "a host that predates `pending` still only meant it waits");
  assert.equal(outcome({ status: "applied", model: "m1", effort: "high" }), "applied");
  assert.equal(outcome({ status: "unknown" }), "unknown");
});

test("the timeline draws a pending answer as waiting, naming what will apply", () => {
  const view = reduce([answer(1, { status: "partial", model: "m1", effort: "high", pending: { model: "m2", effort: "low" } })]);
  const notice = view.items[0];
  assert.ok(notice?.type === "notice");
  assert.equal(notice.code, "settings_pending");
  assert.equal(notice.text, "m2 · low", "the values that will apply, not the ones still in force");
});

test("a partial failure keeps its own notice and its errors", () => {
  const view = reduce([answer(1, { status: "partial", model: "m1", effort: "high", errors: { effort: "not supported" } })]);
  const notice = view.items[0];
  assert.ok(notice?.type === "notice");
  assert.equal(notice.code, "settings_partial");
  assert.match(notice.text ?? "", /not supported/);
});

test("every language names the pending answer in its own words", () => {
  try {
    setLang("ko");
    assert.match(t("notice.settings_pending", { text: "" }).trim(), /^진행 중인 답변이 끝나면 새 설정이 적용됩니다\.$/);
    setLang("en");
    assert.match(t("notice.settings_pending", { text: "" }).trim(), /^The new settings apply when the current response finishes\.$/);
  } finally { setLang("ko"); }
  assert.equal(dictionaries.en["notice.settings_pending"], "The new settings apply when the current response finishes. {text}");
});
