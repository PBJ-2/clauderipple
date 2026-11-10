import test from "node:test";
import assert from "node:assert/strict";
import { reduce } from "../web/timeline.ts";
import { item, type UI } from "../web/views.ts";
import { setLang } from "../web/i18n.ts";
import type { SessionEvent } from "../src/protocol.ts";

const ui = (): UI => ({ now: 1, link: { state: "open", attempt: 0, nextAt: null, lastRx: 1, downSince: null }, host: null, home: undefined, sessions: [], draft: { cwd: null, model: null, effort: null }, models: [], sheet: null, expanded: new Map(), workersOpen: false, permOpen: new Set(), toast: null, pins: [], folded: [], query: "", homeLimit: 60 });

const APPROVAL_LOCAL = "Claude 앱에서 이 승인을 이미 처리했습니다. 휴대폰에서는 승인할 수 없습니다.";
const permission = (decided: SessionEvent): string => {
  setLang("ko");
  const events: SessionEvent[] = [{ seq: 1, at: 1, kind: "permission", id: "p", tool: "Bash", title: "", summary: "ls", input: "ls", canAlways: false }, decided];
  return item(reduce(events).items[0]!, ui());
};

test("an expired request with the host's reason closes as a muted card with that reason, not as a failure", () => {
  const html = permission({ seq: 2, at: 2, kind: "permission_decided", id: "p", decision: "expired", reason: APPROVAL_LOCAL });
  assert.ok(html.includes("perm-done quiet"), "not the red expired class");
  assert.ok(!html.includes("perm-done expired"));
  assert.ok(html.includes(`<div class="foot"><span class="why">${APPROVAL_LOCAL}</span></div>`));
});

test("a known reason word still reads as its translated sentence", () => {
  const html = permission({ seq: 2, at: 2, kind: "permission_decided", id: "p", decision: "expired", reason: "aborted" });
  assert.ok(html.includes("작업이 중단되어 요청이 종료되었습니다."));
  assert.ok(html.includes("perm-done quiet"));
});

test("an expired request without a reason stays as it was: the expired class and no reason line", () => {
  const html = permission({ seq: 2, at: 2, kind: "permission_decided", id: "p", decision: "expired" });
  assert.ok(html.includes("perm-done expired"));
  assert.ok(!html.includes('class="why"'));
  assert.ok(!html.includes("perm.reason"));
});

test("a bare machine reason the phone does not know is left out rather than shown as a key", () => {
  const html = permission({ seq: 2, at: 2, kind: "permission_decided", id: "p", decision: "expired", reason: "stale" });
  assert.ok(!html.includes("stale"));
  assert.ok(!html.includes("perm.reason"));
});

test("the Claude app's approval notice draws its own sentence in each language", () => {
  const notice: SessionEvent = { seq: 3, at: 3, kind: "notice", code: "desktop_approval", text: "승인 요청이 Claude 앱에 표시되었습니다. Claude 앱에서 승인해 주세요." };
  setLang("ko");
  assert.ok(item(reduce([notice]).items[0]!, ui()).includes("승인 요청이 Claude 앱에 표시되었습니다. Claude 앱에서 승인해 주세요."));
  setLang("en");
  const english = item(reduce([notice]).items[0]!, ui());
  assert.ok(english.includes("The approval request is shown in the Claude app on your computer. Approve it there."));
  assert.ok(!english.includes("desktop_approval"), "never the raw code");
  setLang("ko");
});
