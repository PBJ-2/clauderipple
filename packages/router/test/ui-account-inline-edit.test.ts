// An account row edits its fields in place. The dashboard also runs inside the desktop app, where
// window.prompt() is not available, so a button that asked the browser for a dialog did nothing there.
// The editor and the actions beside it run in a browser as a classic script; the test evaluates them
// straight from the source text against a small DOM stand-in, as the other ui-*.test.ts files do.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");
const source = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
const i18nSource = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
const start = i18nSource.indexOf("const I18N = {");
const end = i18nSource.indexOf("\n};", start);
assert.ok(start > 0 && end > start, "i18n.js no longer contains the dictionary");
const dictionaries = new Function(`${i18nSource.slice(start, end + 3)}; return I18N;`)() as Record<string, Record<string, string>>;
const translate = (lang: string) => (key: string, vars: Record<string, unknown> = {}) =>
  Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionaries[lang]![key] ?? key);

type Listener = (event: Record<string, unknown>) => void;
class Node {
  readonly tag: string;
  readonly attrs: Record<string, unknown>;
  children: Node[];
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(tag: string, attrs: Record<string, unknown> = {}, children: (Node | null | undefined)[] = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children.filter((child): child is Node => Boolean(child));
    if (typeof attrs.class === "string") this.className = attrs.class;
    if (typeof attrs.text === "string") this.textContent = attrs.text;
  }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  fire(type: string, event: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    const seen = { defaultPrevented: false };
    for (const listener of this.listeners.get(type) ?? []) listener({ ...event, preventDefault: () => { seen.defaultPrevented = true; } });
    return seen;
  }
  focus() {}
}
const el = (tag: string, attrs: Record<string, unknown> = {}, children: (Node | null | undefined)[] = []) => new Node(tag, attrs, children);
const findAll = (node: Node, predicate: (node: Node) => boolean): Node[] => [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
function block(from: string, to: string): string {
  const at = source.indexOf(from), until = source.indexOf(to, at);
  assert.ok(at > 0 && until > at, `app.js no longer contains ${from}`);
  return source.slice(at, until);
}

type Edit = { provider: string; kind: string; id: string; text: string; focus: boolean };
type EditorOptions = {
  edit: { text: string };
  label: string;
  number?: boolean;
  check?: (text: string) => string;
  save: (text: string) => Promise<unknown>;
  clear?: () => Promise<unknown>;
  clearText?: string;
  cancel: () => void;
};
const editorOf = new Function("el", "t", `${block("function inlineAccountEditor(", "function accountRowsFailed(")}; return inlineAccountEditor;`) as (el: unknown, t: unknown) => (options: EditorOptions) => Node;
const buildEditor = editorOf(el, translate("ko"));

function parts(root: Node) {
  const input = findAll(root, (n) => n.tag === "input")[0]!;
  const buttons = findAll(root, (n) => n.tag === "button");
  const byText = (text: string) => buttons.find((b) => b.textContent === text);
  const message = findAll(root, (n) => n.className.includes("account-inline-message"))[0]!;
  const type = (text: string) => { input.value = text; input.fire("input"); };
  const press = (key: string, extra: Record<string, unknown> = {}) => input.fire("keydown", { key, ...extra });
  return { input, buttons, byText, message, type, press };
}

/** A usage-cap editor as the ChatGPT rows build it. */
function capEditor(initial: string, hasCap: boolean) {
  const calls: string[] = [];
  let release: () => void = () => {};
  const edit = { text: initial };
  const root = buildEditor({
    edit,
    label: "사용량 상한(%)",
    number: true,
    check: (text) => { const v = Number(text); return Number.isInteger(v) && v >= 1 && v <= 99 ? "" : "INVALID"; },
    save: (text) => { calls.push(`save:${text}`); return new Promise<void>((resolve) => { release = resolve; }); },
    ...(hasCap ? { clear: async () => { calls.push("clear"); }, clearText: "상한 해제" } : {}),
    cancel: () => { calls.push("cancel"); },
  });
  return { root, edit, calls, release: () => release(), ...parts(root) };
}

test("cap editor: the box starts at the current cap, Enter saves the number, nothing asks the browser for a dialog", async () => {
  const e = capEditor("72", true);
  assert.equal(e.input.value, "72");
  assert.equal(e.input.attrs.type, "number");
  assert.equal(e.input.attrs.min, "1");
  assert.equal(e.input.attrs.max, "99");
  assert.equal(e.input.attrs["aria-label"], "사용량 상한(%)");
  e.type("65");
  assert.equal(e.edit.text, "65", "what is typed is kept for the next time the row is drawn");
  assert.equal(e.press("Enter").defaultPrevented, true);
  assert.deepEqual(e.calls, ["save:65"]);
  e.press("Enter");
  e.byText("저장")!.fire("click");
  assert.deepEqual(e.calls, ["save:65"], "a second Enter or click while the first request runs sends nothing");
  assert.equal(e.byText("저장")!.disabled, true);
  e.release();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(e.byText("저장")!.disabled, false, "and the row can be used again once the request has ended");
});

test("cap editor: a number outside 1-99 is refused in the row, an empty box cannot be saved, Escape cancels", () => {
  const e = capEditor("", false);
  assert.equal(e.byText("저장")!.disabled, true, "nothing typed, nothing to save");
  e.press("Enter");
  assert.deepEqual(e.calls, []);
  for (const bad of ["0", "100", "150", "7.5"]) {
    e.type(bad);
    e.press("Enter");
    assert.equal(e.message.textContent, "INVALID", bad);
    assert.deepEqual(e.calls, [], `${bad} is not sent`);
  }
  e.type("70");
  assert.equal(e.message.textContent, "", "the message goes once the box changes");
  e.press("Escape");
  assert.deepEqual(e.calls, ["cancel"]);
});

test("cap editor: Enter that only commits an input method's text does not save", () => {
  const e = capEditor("50", false);
  e.press("Enter", { isComposing: true });
  e.press("Enter", { keyCode: 229 });
  assert.deepEqual(e.calls, []);
});

test("cap editor: 'remove cap' is there only when the account has a cap, and cancel is always there", () => {
  const withCap = capEditor("72", true);
  assert.ok(withCap.byText("상한 해제"));
  withCap.byText("상한 해제")!.fire("click");
  assert.deepEqual(withCap.calls, ["clear"]);
  withCap.byText("취소")!.fire("click");
  assert.deepEqual(withCap.calls, ["clear", "cancel"]);
  const without = capEditor("", false);
  assert.equal(without.byText("상한 해제"), undefined);
  assert.ok(without.byText("취소"));
});

test("an editor drawn again (the list is fetched every ten seconds) starts from what was typed", () => {
  const edit = { text: "72" };
  const options = (): EditorOptions => ({ edit, label: "x", number: true, save: async () => {}, cancel: () => {} });
  const first = parts(buildEditor(options()));
  first.type("88");
  const second = parts(buildEditor(options()));
  assert.equal(second.input.value, "88");
  assert.equal(second.byText("저장")!.disabled, false);
});

test("the cap editor opens in the row for its own account only, and the dashboard source never asks for a dialog for it", () => {
  const accountEditOf = new Function(`${block("let accountEdit = null;", "function openAccountEdit(")}; return { accountEditOf, set: (v) => { accountEdit = v; } };`)() as { accountEditOf: (p: string, k: string, id: string) => Edit | null; set: (v: Edit | null) => void };
  const edit = { provider: "chatgpt", kind: "cap", id: "a1", text: "70", focus: true };
  accountEditOf.set(edit);
  assert.equal(accountEditOf.accountEditOf("chatgpt", "cap", "a1"), edit);
  assert.equal(accountEditOf.accountEditOf("chatgpt", "cap", "a2"), null);
  assert.equal(accountEditOf.accountEditOf("other", "cap", "a1"), null);
  assert.equal(accountEditOf.accountEditOf("chatgpt", "label", "a1"), null);
  assert.doesNotMatch(source, /chatgptCapPrompt/);
});

type Account = { preferred?: boolean; paused?: boolean; state?: string; cooldownSeconds?: number; restSeconds?: number; capRest?: unknown; external?: boolean };
function actionsFor(account: Account): string[] {
  const make = new Function("el", "t", "toast", `${block("function accountPoolActions(", "/**\n * A resting Antigravity quota group")}; return accountPoolActions;`) as (el: unknown, t: unknown, toast: unknown) => (account: Account, patch: (change: unknown) => Promise<unknown>) => Node[];
  return make(el, translate("en"), () => {})(account, async () => {}).map((button) => button.textContent);
}

test("'use now' is offered for a backend refusal, not for an account only the usage cap holds", () => {
  const useNow = dictionaries.en!["providers.chatgptClearCooldown"]!;
  const cap = { window: "weekly", used: 72, cap: 70 };
  assert.ok(actionsFor({ state: "cooling", cooldownSeconds: 3000, restSeconds: 3000 }).includes(useNow), "a 429 rest keeps its action");
  assert.ok(actionsFor({ state: "cooling", cooldownSeconds: 3000 }).includes(useNow), "and so does a row from an older answer with no detail");
  assert.equal(actionsFor({ state: "cooling", cooldownSeconds: 259_200, capRest: cap }).includes(useNow), false, "a cap hold has nothing to end");
  assert.ok(actionsFor({ state: "cooling", cooldownSeconds: 259_200, restSeconds: 600, capRest: cap }).includes(useNow), "a cap beside a real refusal: the refusal can still be ended");
  assert.equal(actionsFor({ state: "ready" }).includes(useNow), false);
});
