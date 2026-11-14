// The mod settings list a provider's models one account at a time. A tab that only says "Account 2"
// does not say whose account it is, so the tabs, the worker menus and the checkboxes' accessible
// names carry each account's own name. The functions run in a browser as a classic script, so the
// test evaluates them straight from the source text against a small DOM stand-in.
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

class Node {
  style: Record<string, string> = {};
  inert = false;
  readonly tag: string;
  readonly attrs: Record<string, unknown>;
  children: Node[];
  constructor(tag: string, attrs: Record<string, unknown> = {}, children: Node[] = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children.filter(Boolean);
  }
  appendChild(child: Node) { this.children.push(child); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener() {}
}
const el = (tag: string, attrs: Record<string, unknown> = {}, children: Node[] = []) => new Node(tag, attrs, children);
const findAll = (node: Node, predicate: (node: Node) => boolean): Node[] => [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
function block(from: string, to: string): string {
  const at = source.indexOf(from), until = source.indexOf(to, at);
  assert.ok(at > 0 && until > at, `app.js no longer contains ${from}`);
  return source.slice(at, until);
}

// The Status screen's rule for a label the router made up; the tabs follow the same one.
const placeholder = /const LIMITS_PLACEHOLDER = [^\n]*?;/.exec(source)?.[0];
assert.ok(placeholder, "app.js no longer contains LIMITS_PLACEHOLDER");

type Account = { number: number; label?: string; name?: string; current?: true };
type Agent = { name: string; model: string; provider: string; account?: string; accountNumber?: number };
type Choice = { value: string; label: string; provider: string | null; pinned?: boolean; accountNumber?: number | null; accountName?: string };
type MenuItem = { value: string; label: string };
type MenuGroup = { group: string; items: MenuItem[] };
type Ui = {
  rows(): Node[];
  pick(key: string, step: { target: { agent: string }; effort: string } | null, shown: string, label: string, onPick: () => void): Node;
  names(provider: string): Map<number, string>;
  choiceName(choice: Choice): string;
  choices(): Choice[];
};

/** One provider with an ordinary worker and a pinned worker per numbered account. */
function modUi(provider: string, accounts: Account[], pins: { id: string; account?: string; number?: number }[], lang = "en"): Ui {
  const agents: Agent[] = [
    { name: "model-x", model: "model-x", provider },
    ...pins.map((pin) => ({ name: `model-x-${pin.id}`, model: "model-x", provider, ...(pin.account !== undefined ? { account: pin.account } : {}), ...(pin.number !== undefined ? { accountNumber: pin.number } : {}) })),
  ];
  const options = { agents: agents.map((agent) => ({ ...agent, efforts: ["high"], billing: "subscription" })), providers: [{ name: provider, type: "chatgpt", usable: true, billing: "subscription", accounts }], claudeEfforts: ["high"] };
  const build = new Function("el", "t", "options", `
    const MOD_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
    ${placeholder}
    const MOD_CLAUDE_MODELS = ["opus"], MOD_CLAUDE_IDS = { opus: "claude-opus-5-5" };
    const modClaudeId = (alias) => MOD_CLAUDE_IDS[alias];
    const modState = { settings: { allow: [], allowKnown: [] }, options };
    const modAgents = () => options.agents, modProviderInfo = (name) => options.providers.find((entry) => entry.name === name);
    const effortLevelsFor = () => ["high"], providerHue = () => "#000", modRefresh = () => {}, modPatch = () => {};
    const modCap = (text) => text, modEffortName = (effort) => effort;
    const modTargetValue = (target) => target.agent, modTargetOf = (value) => ({ agent: value });
    const modSelect = (key, items, value, label) => el("select", { "data-key": key, items, value, "aria-label": label });
    ${block("function modChoices(", "// ---- The four workers: a meaning")}
    ${block("/** Two menus side by side", '/** @typedef {"general"')}
    return { rows: modTickRows, pick: modPickSelect, names: modAccountNames, choiceName: modChoiceName, choices: modChoices };
  `) as (...args: unknown[]) => Ui;
  return build(el, translate(lang), options);
}
const tabsOf = (ui: Ui, provider: string) => findAll(ui.rows().find((row) => findAll(row, (node) => node.attrs["aria-label"] === provider && node.attrs.role === "tablist").length)!, (node) => node.attrs.role === "tab");
const three: Account[] = [
  { number: 1, label: "csa@school.example", name: "csa" },
  { number: 2, label: "relay@private.example", name: "relay" },
  { number: 3, label: "Work · boss@corp.example", name: "Work" },
];
const threePins = [{ id: "aaaaaaaa", account: "csa", number: 1 }, { id: "bbbbbbbb", account: "relay", number: 2 }, { id: "cccccccc", account: "Work", number: 3 }];

test("an account tab says whose account it is; its number and whole label are on the tooltip", () => {
  const ui = modUi("chatgpt", three, threePins);
  const tabs = tabsOf(ui, "chatgpt");
  assert.deepEqual(tabs.map((tab) => tab.attrs.text), ["csa", "relay", "Work"]);
  assert.deepEqual(tabs.map((tab) => tab.attrs.title), ["Account 1 · csa@school.example", "Account 2 · relay@private.example", "Account 3 · Work · boss@corp.example"]);
  // What a tab is found and kept by does not move with a relabel.
  assert.deepEqual(tabs.map((tab) => tab.attrs["data-key"]), ["account-tab:chatgpt:1", "account-tab:chatgpt:2", "account-tab:chatgpt:3"]);
  assert.deepEqual(tabs.map((tab) => tab.attrs["aria-controls"]), ["mod-account-chatgpt-1", "mod-account-chatgpt-2", "mod-account-chatgpt-3"]);
  // Three checkboxes share one model name; each is told apart by its account's name. Account 1's
  // own pinned worker is not listed: the ordinary worker stands for it.
  const boxes = findAll(el("div", {}, ui.rows()), (node) => node.attrs.type === "checkbox" && String(node.attrs["data-key"]).startsWith("tick:model-x"));
  assert.deepEqual(boxes.map((box) => [box.attrs["data-key"], box.attrs["aria-label"]]), [
    ["tick:model-x", "model-x · chatgpt · csa"],
    ["tick:model-x-bbbbbbbb", "model-x · chatgpt · relay"],
    ["tick:model-x-cccccccc", "model-x · chatgpt · Work"],
  ]);
});

test("the Claude app login is named as the Status screen names it, apart from a stored sign-in of the same email", () => {
  const accounts: Account[] = [{ number: 1, label: "me@example.test", name: "me", current: true }, { number: 2, label: "me@example.test", name: "me" }];
  const pins = [{ id: "aaaaaaaa", account: "me", number: 2 }];
  assert.deepEqual(tabsOf(modUi("claude", accounts, pins), "claude").map((tab) => tab.attrs.text), ["Current Claude login", "me"]);
  assert.deepEqual(tabsOf(modUi("claude", accounts, pins, "ko"), "claude").map((tab) => tab.attrs.text), ["현재 Claude 로그인", "me"]);
  // The login's email is still one hover away.
  assert.equal(tabsOf(modUi("claude", accounts, pins), "claude")[0]!.attrs.title, "Account 1 · me@example.test");
});

test("accounts that would read alike are told apart: by their whole label, then by their number", () => {
  // The same local part at two domains: the short name says nothing, the address does. Matching ignores case.
  const twoDomains = modUi("p", [{ number: 1, label: "sam@home.example", name: "sam" }, { number: 2, label: "sam@work.example", name: "Sam" }, { number: 3, label: "kim@work.example", name: "kim" }], []);
  assert.deepEqual([...twoDomains.names("p")], [[1, "sam@home.example"], [2, "sam@work.example"], [3, "kim"]]);
  // Two sign-ins of one address: nothing but the number separates them. It leads, so a tab cut short keeps it.
  const sameAddress = modUi("p", [{ number: 1, label: "sam@home.example", name: "sam" }, { number: 2, label: "sam@home.example", name: "sam" }], []);
  assert.deepEqual([...sameAddress.names("p")], [[1, "1 · sam@home.example"], [2, "2 · sam@home.example"]]);
  // Two hand-given labels that match, with no address behind them.
  const sameLabel = modUi("p", [{ number: 1, name: "Team" }, { number: 2, name: "Team" }], []);
  assert.deepEqual([...sameLabel.names("p")], [[1, "1 · Team"], [2, "2 · Team"]]);
});

test("no two accounts ever read the same, whatever their names already hold", () => {
  const unique = (accounts: Account[]) => {
    const names = [...modUi("p", accounts, []).names("p").values()];
    assert.equal(new Set(names.map((name) => name.toLowerCase())).size, accounts.length, names.join(" | "));
    return names;
  };
  // A name that already looks like a numbered one meets the number given to its neighbours.
  assert.deepEqual(unique([{ number: 1, name: "Team" }, { number: 2, name: "Team" }, { number: 3, name: "1 · Team" }]), ["1 · 1 · Team", "2 · Team", "3 · 1 · Team"]);
  // An account someone named "Account 2" beside the unnamed account 2.
  assert.deepEqual(unique([{ number: 1, name: "Account 2" }, { number: 2 }]), ["1 · Account 2", "2 · Account 2"]);
  unique([{ number: 1, name: "a" }, { number: 2, name: "A" }, { number: 3, name: "1 · a" }, { number: 4, name: "2 · A" }, { number: 5 }]);
});

// An account signed in without an email is stored as "Claude account 2", counted from the stored
// accounts — not the limits' number. The Status screen shows the number instead, and so do the tabs.
test("a label the router made up for an unnamed account is not shown as its name", () => {
  const accounts: Account[] = [
    { number: 1, label: "me@example.test", name: "me", current: true },
    { number: 2, label: "Claude account 1", name: "Claude account 1" },
    { number: 3, label: "ChatGPT account", name: "ChatGPT account" },
    { number: 4, label: "Claude accountant", name: "Claude accountant" },
  ];
  const ui = modUi("claude", accounts, [{ id: "aaaaaaaa", account: "Claude account 1", number: 2 }, { id: "bbbbbbbb", account: "ChatGPT account", number: 3 }, { id: "cccccccc", account: "Claude accountant", number: 4 }]);
  const tabs = tabsOf(ui, "claude");
  assert.deepEqual(tabs.map((tab) => tab.attrs.text), ["Current Claude login", "Account 2", "Account 3", "Claude accountant"]);
  // No tooltip that says "Account 2 · Claude account 1".
  assert.deepEqual(tabs.map((tab) => tab.attrs.title), ["Account 1 · me@example.test", undefined, undefined, "Account 4 · Claude accountant"]);
});

test("an account with no name keeps its number, and so does a tab the provider no longer lists", () => {
  const ui = modUi("chatgpt", [{ number: 1 }, { number: 2, label: "relay@private.example", name: "relay" }], [{ id: "bbbbbbbb", account: "relay", number: 2 }, { id: "dddddddd", account: "gone", number: 4 }]);
  const tabs = tabsOf(ui, "chatgpt");
  assert.deepEqual(tabs.map((tab) => tab.attrs.text), ["Account 1", "relay", "Account 4"]);
  // A tab that already reads "Account n" with nothing more to say has no tooltip repeating it.
  assert.deepEqual(tabs.map((tab) => tab.attrs.title), [undefined, "Account 2 · relay@private.example", undefined]);
});

test("a provider with one account to show has no tabs and no account in a checkbox's name", () => {
  const ui = modUi("google", [{ number: 1, label: "me@example.test", name: "me" }], [{ id: "aaaaaaaa", account: "me", number: 1 }]);
  const rows = el("div", {}, ui.rows());
  assert.equal(findAll(rows, (node) => node.attrs.role === "tab").length, 0);
  assert.deepEqual(findAll(rows, (node) => node.attrs.type === "checkbox" && String(node.attrs["data-key"]).startsWith("tick:model-x")).map((box) => box.attrs["aria-label"]), ["model-x · google"]);
});

test("the worker menu names each account as its tab does", () => {
  const ui = modUi("chatgpt", three, threePins);
  // The model menu is the pick's first child; the effort menu beside it holds no account names.
  const menu = (picked: string) => ui.pick("k", { target: { agent: picked }, effort: "high" }, "high", "Light 1", () => {}).children[0]!.attrs.items as (MenuItem | MenuGroup)[];
  const groups = (items: (MenuItem | MenuGroup)[]) => items.filter((item): item is MenuGroup => "group" in item && item.items.length > 0 && item.group.startsWith("chatgpt"));
  const offered = groups(menu("model-x-bbbbbbbb"));
  assert.deepEqual(offered.map((group) => group.group), ["chatgpt · Subscription · csa", "chatgpt · Subscription · relay", "chatgpt · Subscription · Work"]);
  // A closed menu shows the option alone: account 1 is the provider's default and stays bare, the others say whose.
  assert.deepEqual(offered.map((group) => group.items.map((item) => item.label)), [["model-x"], ["model-x · relay"], ["model-x · Work"]]);
  // Account 1's own pinned worker is offered only where it is the pick already, and reads by name too.
  const hidden = groups(menu("model-x-aaaaaaaa"))[0]!;
  assert.deepEqual(hidden.items.map((item) => [item.value, item.label]), [["model-x", "model-x"], ["model-x-aaaaaaaa", "model-x · csa"]]);
});

test("a pinned worker shown outside its tab reads by its account's name", () => {
  const ui = modUi("chatgpt", three, [...threePins, { id: "eeeeeeee", account: "old" }]);
  const named = (value: string) => ui.choiceName(ui.choices().find((choice) => choice.value === value)!);
  assert.equal(named("model-x"), "model-x", "an ordinary worker has no account to name");
  assert.equal(named("model-x-aaaaaaaa"), "model-x · csa");
  assert.equal(named("model-x-cccccccc"), "model-x · Work");
  // A pin whose account is no longer stored has no number; it keeps the name it was made with.
  assert.equal(named("model-x-eeeeeeee"), "model-x · old");
});
