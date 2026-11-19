// Session commands and turn numbers: what happened to the conversation (compaction, a fresh start,
// a rewind) is drawn as its own state row, and a finished turn says which turn it was. These are
// displays only — nothing here restores files or re-runs a turn.
import test from "node:test";
import assert from "node:assert/strict";
import { controlCommand, controlTextKey, reduce, timelineItems } from "../web/timeline.ts";
import type { ControlCommand } from "../web/timeline.ts";
import { setLang, t, dictionaries } from "../web/i18n.ts";
import * as V from "../web/views.ts";
import type { UI } from "../web/views.ts";

const user = (seq: number, text: string) => ({ seq, at: seq, kind: "user" as const, text, clientMsgId: `m${seq}` });
const result = (seq: number, ok = true) => ({ seq, at: seq, kind: "result" as const, ok, ...(ok ? {} : { error: "boom" }), ms: 1200, turns: 1 });

function ui(): UI {
  return {
    now: 1_700_000_000_000, link: { state: "open", attempt: 0, nextAt: null, lastRx: 1, downSince: null },
    host: { name: "Mac", version: "t", routerOk: true }, home: "/Users/me", sessions: [], models: [], sheet: null,
    draft: { cwd: null, model: null, effort: null }, expanded: new Map(), workersOpen: false, permOpen: new Set(), toast: null, pins: [], folded: [], query: "", homeLimit: 40,
  };
}

test("only a whole command is a command; ordinary words, even ones starting with a slash, stay messages", () => {
  assert.equal(controlCommand("/compact"), "compact");
  assert.equal(controlCommand("  /compact "), "compact", "surrounding space does not change what was typed");
  assert.equal(controlCommand("/CLEAR"), "clear");
  assert.equal(controlCommand("/rewind"), "rewind");
  assert.equal(controlCommand("/compact and then explain"), null, "words around a command are the person's message");
  assert.equal(controlCommand("/compactx"), null);
  assert.equal(controlCommand("compact"), null, "a slash is what makes it a command");
  assert.equal(controlCommand("/review"), null, "an unknown command is left to the host and drawn as words");
});

test("a command is drawn as its state, answered by the end of the turn it started", () => {
  const compacting = reduce([user(1, "/compact")]);
  assert.deepEqual(compacting.items.map(item => item.type), ["control"]);
  const running = compacting.items[0];
  assert.ok(running?.type === "control");
  assert.equal(running.command, "compact");
  assert.equal(running.state, "running");
  assert.equal(t(controlTextKey("compact", "running") as never), "대화를 압축하는 중…");

  const done = reduce([user(1, "/compact"), result(2)]).items[0];
  assert.ok(done?.type === "control");
  assert.equal(done.state, "done");
  assert.equal(t(controlTextKey("compact", "done") as never), "대화를 압축했습니다");

  const failed = reduce([user(1, "/rewind"), result(2, false)]).items[0];
  assert.ok(failed?.type === "control");
  assert.equal(failed.state, "failed");
  assert.equal(failed.command, "rewind");

  // A turn that ends without the command it belongs to leaves the row running rather than guessing.
  const still = reduce([user(1, "/clear"), { seq: 2, at: 2, kind: "assistant", msg: "m", model: "x", text: "hi", tools: [] }]).items[0];
  assert.ok(still?.type === "control");
  assert.equal(still.state, "running", "text alone is not the end of the turn");

  // The person's own words are not swallowed when they are not a command.
  assert.deepEqual(reduce([user(1, "/review the diff")]).items.map(item => item.type), ["user"]);
});

test("a finished turn says which turn it was, but only when the conversation's first page is loaded", () => {
  const counted = reduce([user(1, "one"), result(2), user(3, "two"), result(4)], [], true);
  const turns = counted.items.flatMap(item => item.type === "result" ? [item.turn] : []);
  assert.deepEqual(turns, [1, 2]);
  const windowed = reduce([user(1, "one"), result(2), user(3, "two"), result(4)], [], false);
  assert.deepEqual(windowed.items.flatMap(item => item.type === "result" ? [item.turn ?? null] : []), [null, null], "a scrolled window does not claim to be the whole story");
});

test("both clients draw the command row and the turn number, and every wording exists", () => {
  setLang("ko");
  const view = reduce([user(1, "/compact"), result(2), user(3, "/rewind"), result(4, false)], [], true);
  const rows = timelineItems(view).filter(row => row.type !== "start");
  assert.deepEqual(rows.map(row => row.type), ["control", "result", "control", "result"], "a command is never folded into an activity group");
  const html = rows.map(row => V.item(row, ui())).join("");
  assert.ok(html.includes("대화를 압축했습니다"));
  assert.ok(html.includes("이전 지점으로 되돌리지 못했습니다"));
  assert.ok(html.includes("턴 1") && html.includes("턴 2"), "each finished turn names itself");
  // A command row is CSS-marked by its state and carries no control: nothing here acts on files.
  assert.ok(html.includes('class="notice control done"'));
  assert.ok(html.includes('class="notice control failed"'));
  assert.ok(!html.includes('data-act="retry"'), "a failed command is not retried by this display");

  setLang("en");
  const english = rows.map(row => V.item(row, ui())).join("");
  assert.ok(english.includes("Compacted the conversation"));
  assert.ok(english.includes("Turn 1"));
  setLang("ko");

  const commands: ControlCommand[] = ["compact", "clear", "rewind"];
  for (const command of commands) for (const state of ["running", "done", "failed"] as const) {
    const key = controlTextKey(command, state);
    for (const language of ["ko", "en"] as const) {
      assert.equal(typeof dictionaries[language][key as never], "string", `${language} has wording for ${key}`);
    }
  }
});

test("a user event the host voided (empty, taken back unrun) is not drawn, and the message's later event takes its place (#177)", () => {
  const voided = { seq: 1, at: 1, kind: "user" as const, text: "", clientMsgId: "unsent:m1" };
  assert.deepEqual(reduce([voided]).items.filter(item => item.type === "user"), []);
  const items = reduce([voided, { seq: 2, at: 2, kind: "user" as const, text: "Run this", clientMsgId: "m1" }]).items.filter(item => item.type === "user");
  assert.deepEqual(items.map(item => item.type === "user" ? item.text : ""), ["Run this"]);
});
