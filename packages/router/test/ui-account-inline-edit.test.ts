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
/** The page's focus: a node taken out of the page while it holds the focus loses it, as in a browser. */
const doc: { activeElement: Node | null } = { activeElement: null };
class Node {
  readonly tag: string;
  readonly attrs: Record<string, unknown>;
  children: Node[] = [];
  parentNode: Node | null = null;
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  [expando: string]: unknown;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(tag: string, attrs: Record<string, unknown> = {}, children: (Node | null | undefined)[] = []) {
    this.tag = tag;
    this.attrs = attrs;
    for (const child of children) if (child) this.insertBefore(child, null);
    if (typeof attrs.class === "string") this.className = attrs.class;
    if (typeof attrs.text === "string") this.textContent = attrs.text;
  }
  get childNodes(): Node[] { return this.children; }
  get classList() { return { contains: (name: string) => this.className.split(/\s+/).includes(name) }; }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  fire(type: string, event: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    const seen = { defaultPrevented: false };
    for (const listener of this.listeners.get(type) ?? []) listener({ ...event, preventDefault: () => { seen.defaultPrevented = true; } });
    return seen;
  }
  contains(node: Node | null): boolean { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false; }
  insertBefore(node: Node, ref: Node | null): Node {
    node.remove();
    const index = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    node.parentNode = this;
    return node;
  }
  remove() {
    if (!this.parentNode) return;
    if (this.contains(doc.activeElement)) doc.activeElement = null;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  replaceWith(other: Node) { const parent = this.parentNode!; parent.insertBefore(other, this); this.remove(); }
  /** Only the one-class selectors the page uses. */
  querySelector(selector: string): Node | null { return findAll(this, (n) => n !== this && n.classList.contains(selector.slice(1)))[0] ?? null; }
  focus() { doc.activeElement = this; }
  select() {}
  setSelectionRange() {}
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
  const accountEditOf = new Function(`${block("const accountEdits = new Map();", "function openAccountEdit(")}; return { accountEditOf, set: (edit) => { accountEdits.set(accountEditKey(edit.provider, edit.kind, edit.id), edit); } };`)() as { accountEditOf: (p: string, k: string, id: string) => Edit | null; set: (v: Edit) => void };
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

// ---- Renaming an account: the same box, for every kind of account row

type Account2 = { id: string; label: string };
function renameRig() {
  const redraws: unknown[] = [];
  const make = new Function("el", "t", "redrawAccountRows", `
    ${block("const accountEdits = new Map();", "function accountRowsFailed(")}
    return { accountRenameEditor, open: (provider, kind, id, text) => { accountEdits.set(accountEditKey(provider, kind, id), { provider, kind, id, text, focus: true, node: null }); }, current: () => accountEditOf("p", "label", "a1") };
  `) as (el: unknown, t: unknown, redraw: (target: unknown) => void) => {
    accountRenameEditor: (target: unknown, provider: string, account: Account2, rename: (label: string, applied: () => void) => Promise<boolean>) => Node | null;
    open: (provider: string, kind: string, id: string, text: string) => void;
    current: () => Edit | null;
  };
  return { ...make(el, translate("ko"), (target) => { redraws.push(target); }), redraws };
}

test("rename: the box opens on the account's name, saves the trimmed name through the request, and closes only once it was taken", async () => {
  const rig = renameRig();
  const account = { id: "a1", label: "개인 계정" };
  const requests: string[] = [];
  let outcome = false;
  const rename = async (label: string, applied: () => void) => { requests.push(label); if (outcome) applied(); return outcome; };
  assert.equal(rig.accountRenameEditor("rows", "p", account, rename), null, "closed unless this account's rename is open");
  rig.open("p", "label", "a1", account.label);
  const root = rig.accountRenameEditor("rows", "p", account, rename)!;
  const e = parts(root);
  assert.equal(e.input.value, "개인 계정");
  assert.equal(e.input.attrs.type, "text");
  assert.equal(e.input.attrs.maxlength, "80", "the store keeps 80 characters");
  assert.equal(e.byText("상한 해제"), undefined, "a name has nothing to clear");
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  e.type("  업무용  ");
  e.press("Enter");
  await settle();
  assert.deepEqual(requests, ["업무용"]);
  assert.ok(rig.current(), "a refused request leaves the box open to try again");
  outcome = true;
  e.press("Enter");
  await settle();
  assert.deepEqual(requests, ["업무용", "업무용"]);
  assert.equal(rig.current(), null, "taken: the edit is over before the list is drawn from the new answer");
});

test("rename: an unchanged name or Cancel closes the box without a request; a blank name cannot be saved", async () => {
  const rig = renameRig();
  const account = { id: "a1", label: "Work" };
  const requests: string[] = [];
  const rename = async (label: string) => { requests.push(label); return true; };
  rig.open("p", "label", "a1", "Work");
  const same = parts(rig.accountRenameEditor("rows", "p", account, rename)!);
  same.press("Enter");
  await Promise.resolve();
  assert.deepEqual(requests, []);
  assert.equal(rig.current(), null);
  assert.deepEqual(rig.redraws, ["rows"], "the row is drawn again without the box");
  rig.open("p", "label", "a1", "Work");
  const blank = parts(rig.accountRenameEditor("rows", "p", account, rename)!);
  blank.type("   ");
  assert.equal(blank.byText("저장")!.disabled, true);
  blank.press("Enter");
  assert.deepEqual(requests, []);
  blank.press("Escape");
  assert.equal(rig.current(), null);
});

test("no account row asks the browser for a dialog: the desktop app has no prompt()", () => {
  assert.doesNotMatch(source, /(?<![\w.$])prompt\(/);
  assert.doesNotMatch(source, /window\.prompt/);
  assert.equal(source.match(/renameEditor = (?:own \? )?accountRenameEditor\(target/g)?.length, 3, "Claude, ChatGPT and Google rows open the same rename box");
});

// ---- The list drawn again while an editor is open: the real ChatGPT rows, the real list code, a stand-in page

type Row = { id: string; label: string; source: "own"; state: string; usageCap?: number; cooldownSeconds?: number; quota: null; inUse: boolean; paused: boolean; preferred: boolean };
type Patch = { id: string; body: Record<string, unknown>; resolve: () => void; reject: (error: Error) => void };

function listRig(initial: { id: string; label: string; usageCap?: number }[]) {
  const row = (a: { id: string; label: string; usageCap?: number }): Row => ({ source: "own", state: "ready", quota: null, inUse: false, paused: false, preferred: false, ...a });
  const server = { accounts: initial.map(row) };
  const patches: Patch[] = [];
  const toasts: string[] = [];
  const target = el("div", { class: "account-card-list" });
  const api = (url: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    if (init?.method !== "PATCH") return Promise.resolve(JSON.parse(JSON.stringify({ accounts: server.accounts })));
    return new Promise<void>((resolve, reject) => { patches.push({ id: decodeURIComponent(url.split("/").pop()!), body: JSON.parse(init.body!), resolve, reject }); });
  };
  const make = new Function("el", "t", "document", "api", "toast", "state", `
    let providerDetailGeneration = 0;
    const confirm = () => true, $ = () => null, hint = (text) => el("p", { class: "hint", text }, []);
    const accountPoolActions = () => [], startChatgptLogin = async () => {}, chatgptQuotaText = () => "", quotaMeters = () => null, quotaWindowName = () => "weekly";
    const accountPoolBadges = (account) => [el("span", { class: "badge", text: account.state + ":" + (account.cooldownSeconds || 0) }, [])];
    ${block("const accountRowsDrawn = new WeakMap();", "function accountRowsFailed(")}
    async function refreshChatgptAccountPanel(name) {
      const data = await api("/api/chatgpt-accounts");
      drawAccountRows(state.target, data, () => renderChatgptAccountRows(state.target, data, name, providerDetailGeneration));
    }
    ${block("async function patchChatgptAccount(", "let googleLoginBusy")}
    return { poll: () => refreshChatgptAccountPanel("chatgpt"), openAccountEdit, accountEditOf };
  `) as (...args: unknown[]) => { poll: () => Promise<void>; openAccountEdit: (target: Node, provider: string, kind: string, id: string, text: string) => void; accountEditOf: (p: string, k: string, id: string) => Edit | null };
  const page = make(el, translate("ko"), doc, api, (message: string) => { toasts.push(message); }, { target });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const rowAt = (index: number): Node => target.children[index]!;
  const editorIn = (row: Node): Node | null => row.querySelector(".account-inline-edit");
  const text = (node: Node): string => [node.textContent, ...node.children.map(text)].join(" ");
  return { server, patches, toasts, target, page, settle, rowAt, editorIn, text };
}

test("list: an editor open on one account survives another account's save, and its draft is the one that was typed", async () => {
  const rig = listRig([{ id: "a1", label: "Work", usageCap: 70 }, { id: "a2", label: "Home" }]);
  await rig.page.poll();
  rig.page.openAccountEdit(rig.target, "chatgpt", "cap", "a1", "70");
  rig.page.openAccountEdit(rig.target, "chatgpt", "label", "a2", "Home");
  const capInput = parts(rig.editorIn(rig.rowAt(0))!);
  const nameInput = parts(rig.editorIn(rig.rowAt(1))!);
  capInput.type("65");
  nameInput.type("Holiday");
  nameInput.press("Enter");
  assert.equal(rig.patches.length, 1);
  rig.server.accounts[1]!.label = "Holiday";
  rig.patches[0]!.resolve();
  await rig.settle();
  assert.equal(rig.editorIn(rig.rowAt(1)), null, "the saved row is a plain row again");
  assert.equal(rig.text(rig.rowAt(1)).includes("Holiday"), true, "and shows the new name");
  const still = rig.editorIn(rig.rowAt(0));
  assert.ok(still, "the other account's editor is still open");
  assert.equal(parts(still!).input, capInput.input, "on the same input element");
  assert.equal(capInput.input.value, "65");
  assert.equal(rig.page.accountEditOf("chatgpt", "cap", "a1")!.text, "65", "and its draft is kept");
});

test("list: a request's answer closes the edit it was made for, not the same field opened again meanwhile", async () => {
  const rig = listRig([{ id: "a1", label: "Work", usageCap: 70 }]);
  await rig.page.poll();
  rig.page.openAccountEdit(rig.target, "chatgpt", "cap", "a1", "70");
  const first = parts(rig.editorIn(rig.rowAt(0))!);
  first.type("60");
  first.press("Enter");
  first.press("Escape");
  assert.equal(rig.editorIn(rig.rowAt(0)), null, "cancelled while the request runs");
  rig.page.openAccountEdit(rig.target, "chatgpt", "cap", "a1", "70");
  const again = parts(rig.editorIn(rig.rowAt(0))!);
  again.type("55");
  rig.server.accounts[0]!.usageCap = 60;
  rig.patches[0]!.resolve();
  await rig.settle();
  assert.ok(rig.editorIn(rig.rowAt(0)), "the new edit is still open");
  assert.equal(rig.page.accountEditOf("chatgpt", "cap", "a1")!.text, "55");
});

test("list: while a request runs the buttons stay disabled through a redraw, and come back when it is refused", async () => {
  const rig = listRig([{ id: "a1", label: "Work", usageCap: 70 }]);
  await rig.page.poll();
  rig.page.openAccountEdit(rig.target, "chatgpt", "cap", "a1", "70");
  const editor = rig.editorIn(rig.rowAt(0))!;
  const e = parts(editor);
  e.type("60");
  e.press("Enter");
  assert.equal(e.byText("저장")!.disabled, true);
  rig.server.accounts[0]!.state = "cooling";
  rig.server.accounts[0]!.cooldownSeconds = 600;
  await rig.page.poll();
  const after = rig.editorIn(rig.rowAt(0))!;
  assert.equal(after, editor, "the redraw leaves the editor element alone");
  assert.equal(parts(after).byText("저장")!.disabled, true, "still waiting for the request");
  assert.equal(parts(after).byText("상한 해제")!.disabled, true);
  assert.match(rig.text(rig.rowAt(0)), /cooling:600/, "the rest of the row is drawn from the new answer");
  rig.patches[0]!.reject(new Error("refused"));
  await rig.settle();
  assert.equal(parts(after).byText("저장")!.disabled, false, "refused: the row can be tried again");
  assert.ok(rig.toasts.length > 0);
  assert.ok(rig.editorIn(rig.rowAt(0)), "and the box is still open");
});

test("list: a poll while typing keeps the input element, the cursor and what is half typed", async () => {
  const rig = listRig([{ id: "a1", label: "Work" }, { id: "a2", label: "Home" }]);
  await rig.page.poll();
  rig.page.openAccountEdit(rig.target, "chatgpt", "label", "a1", "Work");
  const editor = rig.editorIn(rig.rowAt(0))!;
  const e = parts(editor);
  assert.equal(doc.activeElement, e.input, "opening puts the cursor in the box");
  e.type("업"); // an input method's text not yet committed is in the box too
  for (let tick = 1; tick <= 3; tick++) {
    rig.server.accounts[0]!.state = "cooling";
    rig.server.accounts[0]!.cooldownSeconds = 600 - tick;
    rig.server.accounts[1]!.cooldownSeconds = tick;
    await rig.page.poll();
    assert.equal(rig.editorIn(rig.rowAt(0)), editor, `tick ${tick}: the same editor`);
    assert.equal(parts(rig.editorIn(rig.rowAt(0))!).input, e.input);
    assert.equal(doc.activeElement, e.input, "which still has the cursor");
    assert.equal(e.input.value, "업");
    assert.match(rig.text(rig.rowAt(0)), new RegExp(`cooling:${600 - tick}`), "the row around it counts down");
    assert.match(rig.text(rig.rowAt(1)), new RegExp(`ready:${tick}`), "and other rows are drawn again");
  }
  assert.equal(rig.target.children.length, 2);
  // Escape: the box goes and the row is drawn plain from the latest answer.
  e.press("Escape");
  assert.equal(rig.editorIn(rig.rowAt(0)), null);
  assert.equal(rig.target.children.length, 2);
});

test("list: the editor acts on the row as the last answer drew it, not as it was when the box opened", async () => {
  const rig = listRig([{ id: "a1", label: "Work", usageCap: 70 }]);
  await rig.page.poll();
  rig.page.openAccountEdit(rig.target, "chatgpt", "cap", "a1", "70");
  const e = parts(rig.editorIn(rig.rowAt(0))!);
  rig.server.accounts[0]!.usageCap = 80; // changed elsewhere meanwhile
  await rig.page.poll();
  e.press("Enter");
  assert.equal(rig.patches.length, 1, "70 is no longer the cap in force, so it is a change, not 'unchanged'");
  assert.deepEqual(rig.patches[0]!.body, { usageCap: 70 });
});

test("list: after a save the box is drawn away even when the answer fetched next is the same as the last", async () => {
  const rig = listRig([{ id: "a1", label: "Work" }]);
  await rig.page.poll();
  rig.page.openAccountEdit(rig.target, "chatgpt", "label", "a1", "Work");
  const e = parts(rig.editorIn(rig.rowAt(0))!);
  e.type("Office");
  e.press("Enter");
  // The new name has already reached the list through a poll while the request ran.
  rig.server.accounts[0]!.label = "Office";
  await rig.page.poll();
  assert.ok(rig.editorIn(rig.rowAt(0)), "the box stays while the request runs");
  rig.patches[0]!.resolve();
  await rig.settle();
  assert.equal(rig.editorIn(rig.rowAt(0)), null, "the follow-up answer is identical, and the row is still redrawn");
  assert.equal(rig.target.children.length, 1);
  assert.equal(rig.text(rig.rowAt(0)).includes("Office"), true);
});

test("list: an account that disappears takes its editor with it, and the others stay as they are", async () => {
  const rig = listRig([{ id: "a1", label: "Work" }, { id: "a2", label: "Home", usageCap: 70 }]);
  await rig.page.poll();
  rig.page.openAccountEdit(rig.target, "chatgpt", "cap", "a2", "70");
  const editor = rig.editorIn(rig.rowAt(1))!;
  rig.server.accounts.splice(0, 1);
  await rig.page.poll();
  assert.equal(rig.target.children.length, 1);
  assert.equal(rig.editorIn(rig.rowAt(0)), editor, "the surviving row keeps its open editor at its new place");
});
