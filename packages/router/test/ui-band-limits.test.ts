// The dashboard's Look card picks which providers and accounts the band's limits row shows
// (settings `bandLimits`). The picker lists what /api/limits answered (the page's limitsSnapshot),
// stores a provider's config name and its accounts' owner ids, and never drops a stored id by itself.
// The functions run in a browser as a classic script, so the test evaluates them straight from the
// source text against a small DOM stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");
// Some block markers below span lines, and a Windows checkout (core.autocrlf) ends lines with CRLF.
const source = fs.readFileSync(path.join(uiDir, "app.js"), "utf8").replaceAll("\r\n", "\n");
const i18nSource = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
const start = i18nSource.indexOf("const I18N = {");
const end = i18nSource.indexOf("\n};", start);
assert.ok(start > 0 && end > start, "i18n.js no longer contains the dictionary");
const dictionaries = new Function(`${i18nSource.slice(start, end + 3)}; return I18N;`)() as Record<string, Record<string, string>>;
const t = (key: string, vars: Record<string, unknown> = {}) =>
  Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionaries.en![key] ?? key);

class Node {
  style: Record<string, string> = {};
  disabled = false;
  readonly tag: string;
  readonly attrs: Record<string, unknown>;
  children: Node[];
  #listeners: Record<string, () => void> = {};
  constructor(tag: string, attrs: Record<string, unknown> = {}, children: Node[] = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children.filter(Boolean);
  }
  get checked() { return Boolean(this.attrs.checked); }
  set checked(value: boolean) { this.attrs.checked = value; }
  appendChild(child: Node) { this.children.push(child); }
  replaceChildren(...children: Node[]) { this.children = children; }
  setAttribute(key: string, value: unknown) { this.attrs[key] = value; }
  getAttribute(key: string) { return this.attrs[key]; }
  addEventListener(name: string, listener: () => void) { this.#listeners[name] = listener; }
  fire(name: string) { this.#listeners[name]?.(); }
}
const el = (tag: string, attrs: Record<string, unknown> = {}, children: Node[] = []) => new Node(tag, attrs, children);
const findAll = (node: Node, predicate: (node: Node) => boolean): Node[] => [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
function block(from: string, to: string): string {
  const at = source.indexOf(from), until = source.indexOf(to, at);
  assert.ok(at > 0 && until > at, `app.js no longer contains ${from}`);
  return source.slice(at, until);
}

type Account = { account: number; id?: string; sameAs?: string[]; label?: string; inUse?: true };
type Entry = { provider: string; type: string; title: string; accounts: Account[] };
type BandLimit = { provider: string; show: string; accounts?: string[] };
type Settings = { extras: string[]; hide: string[]; layout: string; appearance: string; skin: string; language: string; bandLimits: BandLimit[] };
type State = { snapshot: { providers: Entry[] } | null; mod: { settings: Settings; base?: unknown; revision?: number }; patches: Record<string, unknown>[]; redraws: number; box: Node | null; toasts: [string, boolean][] };
type Ui = { card(): Node; redraw(): void; section(): Node; setSnapshot(value: { providers: Entry[] } | null): void; adopt(snapshot: unknown, drop?: boolean): void; state: State };

function picker(bandLimits: BandLimit[], snapshot: { providers: Entry[] } | null, extras = ["limits"]): Ui {
  const state: State = {
    snapshot,
    mod: { settings: { extras, hide: [], layout: "dashboard", appearance: "auto", skin: "deep", language: "auto", bandLimits } },
    patches: [], redraws: 0, box: null, toasts: [],
  };
  const build = new Function("el", "t", "state", `
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const toast = (message, isError) => { state.toasts.push([message, Boolean(isError)]); };
    ${block("const modClaude = ", "// The compaction point presets")}
    ${block("function modNormalize(", "/**\n * The fields changed")}
    ${block("function modChanges(", "/** Take the router")}
    ${block("function modAdopt(", "\nfunction modCap(")}
    let limitsSnapshot = state.snapshot;
    const modState = state.mod;
    const MOD_PARTS = ["timer", "route"], MOD_EXTRAS = ["context", "limits"], MOD_LANGUAGES = [["en", "English"]];
    // The real providerDisplayName takes the provider's entry as a second argument; one passed by
    // mistake (Array#map's index) shows here instead of the name.
    const modCap = (text) => text, providerDisplayName = (name, ...entry) => entry.length ? "entry:" + String(entry[0]) : name, providerEntry = () => undefined;
    const vendorDot = () => el("span", { class: "vendor-dot" });
    const modPatch = (change) => { state.patches.push(change); modState.settings = { ...modState.settings, ...change }; };
    const modRedraw = (root, nodes) => { state.redraws += 1; root.replaceChildren(...nodes.filter(Boolean)); };
    const $ = (selector) => selector === "#mod-band-limits" ? state.box : null;
    // What refreshLimits calls once a read lands; the picker's block hooks itself on.
    let limitsReadDone = () => {};
    ${block("function cell(", "/** A titled group")}
    ${block("/** The router's generic names", "/**\n * Whether an account's row")}
    ${block("function modSwitch(", "// ---- Saving")}
    ${block("// ---- Look: the band's limits row", "// ---- Logs")}
    return { card: modLookCard, redraw: () => limitsReadDone(), section: modBandLimitsSection, setSnapshot: (value) => { limitsSnapshot = value; }, adopt: modAdopt };
  `) as (...args: unknown[]) => Omit<Ui, "state">;
  return { ...build(el, t, state), state };
}

const sectionOf = (ui: Ui) => findAll(ui.card(), (node) => node.attrs.id === "mod-band-limits")[0];
/** Each provider's row: its name, its choices and the one marked. */
function rowsOf(ui: Ui) {
  return findAll(sectionOf(ui)!, (node) => node.attrs.class === "cell wide").map((row) => {
    const name = findAll(row, (node) => node.attrs.class === "cell-label tick-name")[0]!.children.at(-1)!.attrs.text;
    const buttons = findAll(row, (node) => node.attrs.role === "radio");
    return { name, choices: buttons.map((button) => button.attrs.text), on: buttons.find((button) => button.attrs["aria-checked"] === "true")?.attrs.text, buttons };
  });
}
const pick = (ui: Ui, provider: string, value: string) => {
  const button = findAll(sectionOf(ui)!, (node) => node.attrs["data-key"] === `band-limits:${provider}:${value}`)[0];
  assert.ok(button, `no ${value} choice for ${provider}`);
  button.fire("click");
};
/** A provider's checkboxes, each with what its label reads (the name, then any tag), from one drawing. */
const boxesOf = (ui: Ui, provider: string) => findAll(sectionOf(ui)!, (node) => node.tag === "label" && String(node.children[0]?.attrs["data-key"]).startsWith(`band-account:${provider}:`))
  .map((label) => Object.assign(label.children[0]!, { reads: label.children.slice(1).map((child) => child.attrs.text).join(" | ") }));
const boxName = (box: Node & { reads: string }) => box.reads;

const claude: Entry = { provider: "claude-anthropic", type: "anthropic", title: "Claude", accounts: [
  { account: 0, id: "current", label: "me@example.test" },
  { account: 1, id: "1f0c3a52-0000-4000-8000-000000000001", label: "work@example.test", inUse: true },
] };
const gpt: Entry = { provider: "chatgpt", type: "chatgpt", title: "GPT", accounts: [
  { account: 0, id: "7c8ef9dc-0000-4000-8000-000000000002", label: "csa@example.test" },
  { account: 1, id: "fa928bf4-0000-4000-8000-000000000003", label: "relay@example.test" },
] };
const go: Entry = { provider: "opencode-go", type: "opencode-go", title: "Go", accounts: [{ account: 0, label: "main" }, { account: 1 }] };
const grok: Entry = { provider: "grok", type: "grok", title: "Grok", accounts: [{ account: 0 }] };
const live = { providers: [claude, gpt, go, grok] };

test("the picker is drawn only while the band shows limits; switching them off keeps the stored choice", () => {
  assert.equal(sectionOf(picker([], live, ["context"])), undefined);
  assert.equal(sectionOf(picker([], live, [])), undefined);
  const ui = picker([{ provider: "chatgpt", show: "all" }], live, ["context"]);
  assert.equal(sectionOf(ui), undefined);
  assert.deepEqual(ui.state.patches, [], "drawing the card writes nothing");
  assert.deepEqual(ui.state.mod.settings.bandLimits, [{ provider: "chatgpt", show: "all" }]);
  const section = sectionOf(picker([], live))!;
  assert.equal(findAll(section, (node) => node.attrs.class === "section-title")[0]!.attrs.text, t("mod.bandLimits"));
  // The hint names what removes the row (the Look card's Limits switch) and a provider's own switch
  // in Providers, and says the default's rule by the default's own name.
  const hint = findAll(section, (node) => node.attrs.class === "group-footer")[0]!.attrs.text as string;
  for (const part of [t("providers.limits"), t("nav.providers"), t("mod.part.limits"), t("mod.show"), t("mod.bandLimitsAuto")]) assert.ok(hint.includes(part), `${part} in ${hint}`);
  assert.doesNotMatch(hint, /\{\w+\}/, "every placeholder filled");
});

test("every language's hint fills the same placeholders, and none still promises which accounts drop first", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  const english = placeholders(dictionaries.en!["mod.bandLimitsHint"]!);
  assert.deepEqual(english, ["auto", "limits", "off", "providers", "show", "switch"]);
  // The dashboard fills every one of them.
  const call = /t\("mod\.bandLimitsHint", \{([^}]*)\}\)/.exec(source)?.[1] ?? "";
  assert.deepEqual([...call.matchAll(/(\w+):/g)].map((match) => match[1]).sort(), english);
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    assert.deepEqual(placeholders(dictionary["mod.bandLimitsHint"]!), english, language);
    assert.deepEqual(placeholders(dictionary["mod.bandLimitsFull"]!), ["max", "providers"], language);
    assert.ok(dictionary["mod.bandLimitsAuto"], language);
    assert.equal(dictionary["mod.bandLimitsFirst"], undefined, language);
    assert.equal(dictionary["mod.bandLimitsInUse"], undefined, language);
  }
  assert.doesNotMatch(dictionaries.en!["mod.bandLimitsHint"]!, /drop out first|everywhere/);
  assert.doesNotMatch(dictionaries.ko!["mod.bandLimitsHint"]!, /어디에서도|계정부터 빠집니다/);
});

test("with no limits read yet the picker says so, and still draws each stored choice so it can be put back", () => {
  const ui = picker([{ provider: "chatgpt", show: "off" }, { provider: "claude-anthropic", show: "accounts", accounts: ["current"] }], null);
  const notes = findAll(sectionOf(ui)!, (node) => node.attrs.class === "cell-note");
  assert.deepEqual(notes.map((note) => note.attrs.text), [t("mod.bandLimitsNone")]);
  assert.deepEqual(rowsOf(ui).map((row) => [row.name, row.choices, row.on]), [
    [`chatgpt${t("mod.unavailable")}`, ["Show", `Hide${t("mod.unavailable")}`], `Hide${t("mod.unavailable")}`],
    [`claude-anthropic${t("mod.unavailable")}`, ["Show", `Choose${t("mod.unavailable")}`], `Choose${t("mod.unavailable")}`],
  ]);
  assert.deepEqual(boxesOf(ui, "claude-anthropic").map((box) => [boxName(box), box.checked]), [[`Current Claude login${t("mod.unavailable")}`, true]]);
  assert.deepEqual(ui.state.patches, [], "drawing writes nothing");
  pick(ui, "chatgpt", "default");
  pick(ui, "claude-anthropic", "default");
  assert.deepEqual(ui.state.mod.settings.bandLimits, []);
  assert.deepEqual(rowsOf(ui), []);
  // A read that lists no provider says the same, and still lists a stored choice so it can be put back.
  const empty = picker([{ provider: "chatgpt", show: "off" }], { providers: [] });
  assert.equal(findAll(sectionOf(empty)!, (node) => node.attrs.class === "cell-note").length, 1);
  assert.deepEqual(rowsOf(empty).map((row) => row.name), [`chatgpt${t("mod.unavailable")}`]);
});

test("each provider offers the choices its accounts allow", () => {
  const rows = rowsOf(picker([], live));
  assert.deepEqual(rows.map((row) => [row.name, row.choices, row.on]), [
    // Accounts with owner ids can be picked one by one. The default is the band's own rule (the
    // account in use, else the first with a reading), so it claims neither.
    ["Claude", ["Auto", "All", "Choose", "Hide"], "Auto"],
    ["GPT", ["Auto", "All", "Choose", "Hide"], "Auto"],
    // Several keys without ids: the band's rule or all of them, never one by one; "First key" was
    // untrue when the first key had no reading and the band drew the second's.
    ["Go", ["Auto", "All", "Hide"], "Auto"],
    // One account: shown or hidden.
    ["Grok", ["Show", "Hide"], "Show"],
  ]);
  assert.deepEqual(rows[1]!.buttons.map((button) => button.attrs["data-key"]), ["band-limits:chatgpt:default", "band-limits:chatgpt:all", "band-limits:chatgpt:accounts", "band-limits:chatgpt:off"]);
});

test("two providers with the same title are told apart by their config name", () => {
  const work: Entry = { ...gpt, provider: "chatgpt-work" };
  assert.deepEqual(rowsOf(picker([], { providers: [claude, gpt, work] })).map((row) => row.name), ["Claude", "GPT · chatgpt", "GPT · chatgpt-work"]);
});

test("a stored choice is always one of the choices, marked when the provider no longer offers it", () => {
  const single: Entry = { ...gpt, accounts: [gpt.accounts[0]!] };
  const rows = rowsOf(picker([{ provider: "chatgpt", show: "accounts", accounts: [gpt.accounts[1]!.id!] }, { provider: "grok", show: "all" }], { providers: [single, grok] }));
  assert.deepEqual(rows.map((row) => [row.choices, row.on]), [
    [["Show", "Hide", `Choose${t("mod.unavailable")}`], `Choose${t("mod.unavailable")}`],
    [["Show", "Hide", `All${t("mod.unavailable")}`], `All${t("mod.unavailable")}`],
  ]);
});

test("all and hide write an entry in place, and the default takes it out", () => {
  const ui = picker([{ provider: "claude-anthropic", show: "off" }, { provider: "opencode-go", show: "all" }], live);
  pick(ui, "chatgpt", "all");
  assert.deepEqual(ui.state.mod.settings.bandLimits, [{ provider: "claude-anthropic", show: "off" }, { provider: "opencode-go", show: "all" }, { provider: "chatgpt", show: "all" }]);
  // A provider already stored keeps its place in the list.
  pick(ui, "claude-anthropic", "all");
  assert.deepEqual(ui.state.mod.settings.bandLimits.map((item) => [item.provider, item.show]), [["claude-anthropic", "all"], ["opencode-go", "all"], ["chatgpt", "all"]]);
  pick(ui, "opencode-go", "off");
  assert.deepEqual(ui.state.mod.settings.bandLimits[1], { provider: "opencode-go", show: "off" });
  pick(ui, "claude-anthropic", "default");
  assert.deepEqual(ui.state.mod.settings.bandLimits, [{ provider: "opencode-go", show: "off" }, { provider: "chatgpt", show: "all" }]);
  assert.equal(rowsOf(ui)[0]!.on, "Auto");
  // Picking the choice already on writes nothing.
  const patches = ui.state.patches.length;
  pick(ui, "chatgpt", "all");
  assert.equal(ui.state.patches.length, patches);
});

test("choosing accounts starts from the account in use, else the first, so the row is never empty", () => {
  const ui = picker([], live);
  pick(ui, "claude-anthropic", "accounts");
  assert.deepEqual(ui.state.mod.settings.bandLimits, [{ provider: "claude-anthropic", show: "accounts", accounts: [claude.accounts[1]!.id] }]);
  // No account marked in use: the first with an id.
  pick(ui, "chatgpt", "accounts");
  assert.deepEqual(ui.state.mod.settings.bandLimits[1], { provider: "chatgpt", show: "accounts", accounts: [gpt.accounts[0]!.id] });
  // Leaving the choice drops the accounts with it.
  pick(ui, "chatgpt", "all");
  assert.deepEqual(ui.state.mod.settings.bandLimits[1], { provider: "chatgpt", show: "all" });
});

test("chosen accounts are ticked by name; the last tick cannot go off", () => {
  const ui = picker([{ provider: "claude-anthropic", show: "accounts", accounts: ["current"] }], live);
  const boxes = boxesOf(ui, "claude-anthropic");
  assert.deepEqual(boxes.map((box) => [box.attrs["data-key"], box.attrs["aria-label"], box.checked, box.disabled]), [
    ["band-account:claude-anthropic:current", "Current Claude login · Claude", true, true],
    [`band-account:claude-anthropic:${claude.accounts[1]!.id}`, "work@example.test · Claude", false, false],
  ]);
  // The account in use carries the Status screen's badge.
  assert.equal(boxName(boxes[1]!), `work@example.test | ${t("limits.active")}`);
  boxes[1]!.checked = true;
  boxes[1]!.fire("change");
  assert.deepEqual(ui.state.mod.settings.bandLimits, [{ provider: "claude-anthropic", show: "accounts", accounts: ["current", claude.accounts[1]!.id] }]);
  // Two ticked: either can go off now.
  const again = boxesOf(ui, "claude-anthropic");
  assert.deepEqual(again.map((box) => [box.checked, box.disabled]), [[true, false], [true, false]]);
  again[0]!.checked = false;
  again[0]!.fire("change");
  assert.deepEqual(ui.state.mod.settings.bandLimits, [{ provider: "claude-anthropic", show: "accounts", accounts: [claude.accounts[1]!.id] }]);
  // Providers on another choice draw no list.
  assert.equal(boxesOf(ui, "chatgpt").length, 0);
});

test("a chosen account the read left out stays ticked, marked unavailable, until it is unticked", () => {
  const gone = "0dd0c0de-0000-4000-8000-00000000000f";
  const ui = picker([
    { provider: "chatgpt", show: "accounts", accounts: [gpt.accounts[1]!.id!, gone] },
    { provider: "claude-anthropic", show: "accounts", accounts: ["current", claude.accounts[1]!.id!] },
  ], { providers: [{ ...claude, accounts: [claude.accounts[1]!] }, gpt] });
  const boxes = boxesOf(ui, "chatgpt");
  // The unavailable id is not an account the row can draw: the last listed tick stays on, so the
  // row is never left with only ids that draw nothing; the unavailable one can go.
  assert.deepEqual(boxes.map((box) => [boxName(box), box.checked, box.disabled]), [
    ["csa@example.test", false, false],
    ["relay@example.test", true, true],
    [`0dd0c0de${t("mod.unavailable")}`, true, false],
  ]);
  // The Claude app login is named as the Status screen names it, even when the read did not list it.
  assert.deepEqual(boxesOf(ui, "claude-anthropic").map((box) => [boxName(box), box.checked]), [
    [`work@example.test | ${t("limits.active")}`, true],
    [`Current Claude login${t("mod.unavailable")}`, true],
  ]);
  assert.deepEqual(ui.state.patches, [], "nothing is dropped by drawing");
  boxes[2]!.checked = false;
  boxes[2]!.fire("change");
  assert.deepEqual(ui.state.mod.settings.bandLimits[0], { provider: "chatgpt", show: "accounts", accounts: [gpt.accounts[1]!.id] });
});

test("a chosen account the router stops listing (paused) stays saved and is drawn unavailable, never as one the row can show", () => {
  const [a, b] = [gpt.accounts[0]!.id!, gpt.accounts[1]!.id!];
  const ui = picker([{ provider: "chatgpt", show: "accounts", accounts: [a, b] }], live);
  ui.state.box = ui.section();
  assert.deepEqual(boxesOf(ui, "chatgpt").map((box) => [boxName(box), box.checked, box.disabled]), [
    ["csa@example.test", true, false],
    ["relay@example.test", true, false],
  ]);
  // The next read leaves the paused account out, and numbers the other from 0.
  ui.setSnapshot({ providers: [claude, { ...gpt, accounts: [{ ...gpt.accounts[1]!, account: 0 }] }, go, grok] });
  ui.redraw();
  assert.equal(ui.state.redraws, 1);
  assert.deepEqual(ui.state.patches, [], "the read drops nothing on file");
  assert.deepEqual(ui.state.mod.settings.bandLimits, [{ provider: "chatgpt", show: "accounts", accounts: [a, b] }]);
  // One account the read lists: Choose is not offered, so the stored choice is marked; its list keeps
  // the paused id, ticked and unavailable.
  const row = rowsOf(ui).find((entry) => entry.name === "GPT")!;
  assert.deepEqual([row.choices, row.on], [["Show", "Hide", `Choose${t("mod.unavailable")}`], `Choose${t("mod.unavailable")}`]);
  assert.deepEqual(boxesOf(ui, "chatgpt").map((box) => [boxName(box), box.checked, box.disabled]), [
    ["relay@example.test", true, true],
    [`7c8ef9dc${t("mod.unavailable")}`, true, false],
  ]);
  // Back from pause: drawn as the account it is again, nothing lost.
  ui.setSnapshot(live);
  assert.deepEqual(boxesOf(ui, "chatgpt").map((box) => [boxName(box), box.checked]), [["csa@example.test", true], ["relay@example.test", true]]);
});

test("two accounts of a provider that read the same lead with their number, as the model picker names them", () => {
  const twins: Entry = { provider: "chatgpt", type: "chatgpt", title: "GPT", accounts: [
    { account: 0, id: "a0", label: "Team" }, { account: 1, id: "a1", label: "solo@example.test" }, { account: 2, id: "a2", label: "team" },
  ] };
  const ui = picker([{ provider: "chatgpt", show: "accounts", accounts: ["a0"] }], { providers: [twins] });
  const boxes = boxesOf(ui, "chatgpt");
  assert.deepEqual(boxes.map(boxName), ["1 · Team", "solo@example.test", "3 · team"]);
  assert.deepEqual(boxes.map((box) => box.attrs["aria-label"]), ["1 · Team · GPT", "solo@example.test · GPT", "3 · team · GPT"]);
  // Names that differ stay as the Status screen writes them.
  assert.deepEqual(boxesOf(picker([{ provider: "chatgpt", show: "accounts", accounts: [gpt.accounts[0]!.id!] }], live), "chatgpt").map(boxName), ["csa@example.test", "relay@example.test"]);
});

test("no more than eight accounts can be ticked", () => {
  const many: Entry = { provider: "chatgpt", type: "chatgpt", title: "GPT", accounts: Array.from({ length: 9 }, (_, account) => ({ account, id: `acct-${account}` })) };
  const ui = picker([{ provider: "chatgpt", show: "accounts", accounts: many.accounts.slice(0, 8).map((account) => account.id!) }], { providers: [many] });
  assert.deepEqual(boxesOf(ui, "chatgpt").map((box) => box.disabled), [false, false, false, false, false, false, false, false, true]);
});

test("a stored provider the read does not list gets a row that can put it back", () => {
  const ui = picker([{ provider: "old-gpt", show: "off" }, { provider: "chatgpt", show: "all" }, { provider: "gone", show: "accounts", accounts: ["current"] }], live);
  const rows = rowsOf(ui);
  assert.deepEqual(rows.slice(4).map((row) => [row.name, row.choices, row.on]), [
    [`old-gpt${t("mod.unavailable")}`, ["Show", `Hide${t("mod.unavailable")}`], `Hide${t("mod.unavailable")}`],
    [`gone${t("mod.unavailable")}`, ["Show", `Choose${t("mod.unavailable")}`], `Choose${t("mod.unavailable")}`],
  ]);
  assert.deepEqual(boxesOf(ui, "gone").map((box) => [boxName(box), box.checked]), [[`Current Claude login${t("mod.unavailable")}`, true]]);
  pick(ui, "old-gpt", "default");
  pick(ui, "gone", "default");
  assert.deepEqual(ui.state.mod.settings.bandLimits, [{ provider: "chatgpt", show: "all" }]);
  assert.equal(rowsOf(ui).length, 4);
});

test("a limits read redraws the picker only when what it lists has changed", () => {
  // refreshLimits' finally runs limitsReadDone, which the picker's block points at its redraw.
  assert.match(block("function refreshLimits(", "// Whether a status has been drawn"), /\.finally\(\(\) => \{[^}]*limitsReadDone\(\);/);
  const ui = picker([], { providers: [claude, grok] });
  ui.redraw();
  assert.equal(ui.state.redraws, 0, "no picker on screen, nothing to redraw");
  ui.state.box = ui.section();
  const sig = ui.state.box.attrs["data-sig"];
  ui.redraw();
  assert.equal(ui.state.redraws, 0, "the same providers and accounts");
  // New figures alone change nothing the picker lists.
  ui.setSnapshot({ providers: [{ ...claude, accounts: claude.accounts.map((account) => ({ ...account, windows: [{ used_percent: 40 }] })) }, grok] });
  ui.redraw();
  assert.equal(ui.state.redraws, 0);
  // Another account comes into use, or a provider shows up: the picker alone is drawn again.
  ui.setSnapshot({ providers: [claude, gpt, grok] });
  ui.redraw();
  assert.equal(ui.state.redraws, 1);
  assert.notEqual(ui.state.box.attrs["data-sig"], sig);
  assert.deepEqual(findAll(ui.state.box, (node) => node.attrs.class === "cell wide").map((row) => findAll(row, (node) => node.attrs.class === "cell-label tick-name")[0]!.children.at(-1)!.attrs.text), ["Claude", "GPT", "Grok"]);
  ui.redraw();
  assert.equal(ui.state.redraws, 1);
  // A stored copy leaving the login's row, or an account renumbered when one before it paused, is drawn again too.
  ui.setSnapshot({ providers: [{ ...claude, accounts: [{ ...claude.accounts[0]!, sameAs: ["copy"] }, claude.accounts[1]!] }, gpt, grok] });
  ui.redraw();
  assert.equal(ui.state.redraws, 2);
  ui.setSnapshot({ providers: [{ ...claude, accounts: [{ ...claude.accounts[0]!, sameAs: ["copy"] }, claude.accounts[1]!] }, { ...gpt, accounts: gpt.accounts.map((account) => ({ ...account, account: account.account + 1 })) }, grok] });
  ui.redraw();
  assert.equal(ui.state.redraws, 3);
});

// The page's own copy of the mod's defaults, its normalizer and its keyed merge.
const settings = new Function(`
  const clone = (value) => JSON.parse(JSON.stringify(value));
  ${block("const modClaude = ", "// The compaction point presets")}
  ${block("function modNormalize(", "/**\n * The fields changed")}
  ${block("function modChanges(", "/** Take the router")}
  return { MOD_DEFAULTS, modNormalize, modChanges, modApply };
`)() as {
  MOD_DEFAULTS: Record<string, unknown>;
  modNormalize(raw: unknown): Record<string, unknown> & { bandLimits: BandLimit[] };
  modChanges(before: unknown, after: unknown): { path: string[] }[];
  modApply<T>(base: T, changes: unknown[]): T;
};

test("the page fills bandLimits as [] for a router that leaves it out, and keeps a stored one", () => {
  assert.deepEqual(settings.MOD_DEFAULTS.bandLimits, []);
  assert.deepEqual(settings.modNormalize({}).bandLimits, []);
  settings.modNormalize({}).bandLimits.push({ provider: "chatgpt", show: "off" });
  assert.deepEqual(settings.modNormalize(null).bandLimits, [], "the default is not shared");
  assert.deepEqual(settings.modNormalize({ bandLimits: "chatgpt" }).bandLimits, []);
  const stored = [{ provider: "chatgpt", show: "accounts", accounts: ["a"] }];
  assert.deepEqual(settings.modNormalize({ bandLimits: stored }).bandLimits, stored);
});

test("two tabs that change different providers both keep their choice through a 409's re-apply", () => {
  const base = settings.modNormalize({ bandLimits: [{ provider: "claude-anthropic", show: "off" }, { provider: "grok", show: "off" }] });
  // This tab hides GPT, chooses one Claude account and puts Grok back on the default.
  const mine = { ...base, bandLimits: [{ provider: "claude-anthropic", show: "accounts", accounts: ["current"] }, { provider: "chatgpt", show: "off" }] };
  // Meanwhile another tab showed every Go key and saved first.
  const router = { ...base, bandLimits: [...base.bandLimits, { provider: "opencode-go", show: "all" }] };
  const changes = settings.modChanges(base, mine);
  assert.ok(changes.every((change) => change.path[0] === "bandLimits" && change.path.length > 1), "changed entry by entry, not as one list");
  assert.deepEqual(settings.modApply(router, changes).bandLimits, [
    { provider: "claude-anthropic", show: "accounts", accounts: ["current"] },
    { provider: "opencode-go", show: "all" },
    { provider: "chatgpt", show: "off" },
  ]);
  // The keyed modes merge is kept.
  const modes = settings.modChanges({ modes: [{ id: "a", name: "A" }] }, { modes: [{ id: "a", name: "B" }] });
  assert.deepEqual(modes.map((change) => change.path), [["modes", "a", "name"]]);
});

test("a provider's choice is one unit through a 409's re-apply, so a change to it is never rebuilt without its show", () => {
  const a = gpt.accounts[0]!.id!, b = gpt.accounts[1]!.id!;
  const base = settings.modNormalize({ bandLimits: [{ provider: "chatgpt", show: "accounts", accounts: [a] }] });
  // This tab ticks a second account; another tab had put GPT back on the default first.
  const mine = { ...base, bandLimits: [{ provider: "chatgpt", show: "accounts", accounts: [a, b] }] };
  const changes = settings.modChanges(base, mine);
  assert.deepEqual(changes, [{ path: ["bandLimits", "chatgpt"], value: { provider: "chatgpt", show: "accounts", accounts: [a, b] } }]);
  assert.deepEqual(settings.modApply({ ...base, bandLimits: [] }, changes).bandLimits, [{ provider: "chatgpt", show: "accounts", accounts: [a, b] }]);
  // Another tab had set GPT to all: this tab's whole choice replaces it, accounts and all.
  assert.deepEqual(settings.modApply({ ...base, bandLimits: [{ provider: "chatgpt", show: "all" }] }, changes).bandLimits, [{ provider: "chatgpt", show: "accounts", accounts: [a, b] }]);
  // Taking a provider back to the default removes its entry, whatever the other tab left there.
  const reset = settings.modChanges(base, { ...base, bandLimits: [] });
  assert.deepEqual(reset, [{ path: ["bandLimits", "chatgpt"], remove: true }]);
  assert.deepEqual(settings.modApply({ ...base, bandLimits: [{ provider: "chatgpt", show: "off" }, { provider: "grok", show: "off" }] }, reset).bandLimits, [{ provider: "grok", show: "off" }]);
});

test("a provider whose config name is \"mode\" merges as any other, and never wipes the list", () => {
  const base = settings.modNormalize({ bandLimits: [{ provider: "mode", show: "off" }] });
  const mine = { ...base, bandLimits: [{ provider: "mode", show: "off" }, { provider: "chatgpt", show: "all" }] };
  const changes = settings.modChanges(base, mine);
  assert.deepEqual(changes, [{ path: ["bandLimits", "chatgpt"], value: { provider: "chatgpt", show: "all" } }]);
  const router = { ...base, bandLimits: [{ provider: "mode", show: "off" }, { provider: "opencode-go", show: "all" }] };
  const merged = settings.modApply(router, changes).bandLimits;
  assert.ok(Array.isArray(merged));
  assert.deepEqual(merged, [{ provider: "mode", show: "off" }, { provider: "opencode-go", show: "all" }, { provider: "chatgpt", show: "all" }]);
});

test("providers named after Object's own fields (constructor, __proto__, toString) merge as any other", () => {
  for (const provider of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const base = settings.modNormalize({ bandLimits: [{ provider, show: "off" }, { provider: "grok", show: "off" }] });
    // Taking it back to the default: a remove, never its prototype's function as the new value.
    const reset = settings.modChanges(base, { ...base, bandLimits: [{ provider: "grok", show: "off" }] });
    assert.deepEqual(reset, [{ path: ["bandLimits", provider], remove: true }], provider);
    const router = { ...base, bandLimits: [{ provider, show: "off" }, { provider: "grok", show: "off" }, { provider: "chatgpt", show: "all" }] };
    assert.deepEqual(settings.modApply(router, reset).bandLimits, [{ provider: "grok", show: "off" }, { provider: "chatgpt", show: "all" }], provider);
    // Adding it where the other side has none.
    const none = settings.modNormalize({ bandLimits: [] });
    const add = settings.modChanges(none, { ...none, bandLimits: [{ provider, show: "all" }] });
    assert.deepEqual(add, [{ path: ["bandLimits", provider], value: { provider, show: "all" } }], provider);
    assert.deepEqual(settings.modApply(router, add).bandLimits.find((item) => item.provider === provider), { provider, show: "all" });
    // Changing it in place.
    const change = settings.modChanges(base, { ...base, bandLimits: [{ provider, show: "all" }, { provider: "grok", show: "off" }] });
    assert.deepEqual(change, [{ path: ["bandLimits", provider], value: { provider, show: "all" } }], provider);
  }
  // A field of an object map by such a name (a provider's settings under `providers`) is stored as its
  // own field, and never reaches Object.prototype.
  const base = settings.modNormalize({});
  const mine = { ...base, providers: JSON.parse('{"__proto__": {"limits": false}, "constructor": {"limits": false}}') };
  const changes = settings.modChanges(base, mine);
  assert.deepEqual(changes.map((change) => change.path), [["providers", "__proto__"], ["providers", "constructor"]]);
  const merged = settings.modApply(base, changes) as unknown as { providers: Record<string, unknown> };
  assert.ok(Object.hasOwn(merged.providers, "__proto__") && Object.hasOwn(merged.providers, "constructor"));
  assert.equal(Object.getPrototypeOf(merged.providers), Object.prototype);
  assert.equal(({} as Record<string, unknown>).limits, undefined, "Object.prototype untouched");
  assert.deepEqual(settings.modChanges(mine, base).map((change) => change.path), [["providers", "__proto__"], ["providers", "constructor"]]);
  assert.deepEqual(Object.keys(settings.modApply(merged, settings.modChanges(mine, base)).providers), []);
  // A provider named "mode" is a provider like any other, not a rule's `mode`: the change is that one
  // provider's switch, so a re-apply keeps another tab's switch of a different provider.
  const theirs = { ...base, providers: { grok: { limits: false } } };
  const named = settings.modChanges(base, { ...base, providers: { mode: { limits: false } } });
  assert.deepEqual(named.map((change) => change.path), [["providers", "mode"]]);
  assert.deepEqual((settings.modApply(theirs, named) as unknown as { providers: unknown }).providers, { grok: { limits: false }, mode: { limits: false } });
  // A mode whose id is "constructor" is a mode like any other.
  const modes = settings.modChanges({ modes: [{ id: "constructor", name: "A" }] }, { modes: [{ id: "constructor", name: "B" }] });
  assert.deepEqual(modes.map((change) => change.path), [["modes", "constructor", "name"]]);
});

test("a 409's re-apply never sends more providers than the settings keep: this tab's additions past the cap are taken back, and the owner told", () => {
  const fifteen = Array.from({ length: 15 }, (_, i) => ({ provider: `p${i}`, show: "off" }));
  /** A tab whose copy came from the router as `list`, and the router's copy after another tab added `theirs`. */
  const tab = (list: BandLimit[]) => {
    const ui = picker(list, live);
    ui.state.mod.settings = settings.modNormalize({ ...ui.state.mod.settings }) as unknown as Settings;
    ui.state.mod.base = JSON.parse(JSON.stringify(ui.state.mod.settings));
    return ui;
  };
  const routerWith = (ui: Ui, bandLimits: BandLimit[]) => ({ settings: { ...(ui.state.mod.base as object), bandLimits }, revision: 2 });
  const providers = (ui: Ui) => ui.state.mod.settings.bandLimits.map((item) => item.provider);
  const ui = tab(fifteen);
  // This tab hides GPT (the sixteenth) and, at the cap, sees no more providers offered.
  pick(ui, "chatgpt", "off");
  assert.equal(ui.state.mod.settings.bandLimits.length, 16);
  // Another tab had added Grok first: laid over its copy, this tab's would be the seventeenth.
  ui.adopt(routerWith(ui, [...fifteen, { provider: "grok", show: "off" }]));
  assert.deepEqual(providers(ui), [...fifteen.map((item) => item.provider), "grok"]);
  assert.deepEqual(ui.state.toasts, [[t("mod.bandLimitsFull", { max: 16, providers: "chatgpt" }), true]]);
  // Within the cap nothing is taken back or said.
  const room = tab(fifteen.slice(0, 14));
  pick(room, "chatgpt", "off");
  room.adopt(routerWith(room, [...fifteen.slice(0, 14), { provider: "grok", show: "off" }]));
  assert.deepEqual(providers(room), [...fifteen.slice(0, 14).map((item) => item.provider), "grok", "chatgpt"]);
  assert.deepEqual(room.state.toasts, []);
  // A change to a provider already stored never counts as an addition.
  const stored = tab([...fifteen, { provider: "chatgpt", show: "off" }]);
  pick(stored, "chatgpt", "all");
  stored.adopt(routerWith(stored, [...fifteen, { provider: "chatgpt", show: "off" }]));
  assert.deepEqual(stored.state.mod.settings.bandLimits.at(-1), { provider: "chatgpt", show: "all" });
  assert.deepEqual(stored.state.toasts, []);
  // The router's copy adopted as it is (after a save, or a dropped conflict) is never trimmed here.
  const plain = tab(fifteen);
  plain.adopt(routerWith(plain, [...fifteen, { provider: "grok", show: "off" }]), true);
  assert.equal(plain.state.mod.settings.bandLimits.length, 16);
  assert.deepEqual(plain.state.toasts, []);
});

test("the picker offers only the default where a choice could not be stored: a name past 64 characters, or a seventeenth provider", () => {
  const long: Entry = { provider: "x".repeat(65), type: "chatgpt", title: "Long", accounts: [{ account: 0, id: "l1" }, { account: 1, id: "l2" }] };
  const ui = picker([], { providers: [long, gpt] });
  const rows = rowsOf(ui);
  assert.equal(rows[0]!.choices.length, 1);
  assert.ok(rows[1]!.choices.length > 1, "a provider with a storable name keeps its choices");
  const sixteen = Array.from({ length: 16 }, (_, i) => ({ provider: `p${i}`, show: "off" }));
  const full = picker(sixteen, { providers: [gpt, grok] });
  assert.deepEqual(rowsOf(full).slice(0, 2).map((row) => row.choices.length), [1, 1], "no seventeenth entry is offered");
  // A provider already stored keeps every choice, so it can still be changed or put back.
  const stored = picker([...sixteen.slice(0, 15), { provider: "chatgpt", show: "off" }], { providers: [gpt] });
  assert.ok(rowsOf(stored)[0]!.choices.length > 1);
});

test("a stored Claude account the app has logged into stays ticked on the login's row, and unticking it drops both ids", () => {
  const stored = claude.accounts[1]!.id!;
  // The router hides the stored copy behind the login's row and names it there.
  const login: Entry = { ...claude, accounts: [{ account: 0, id: "current", sameAs: [stored], label: "work@example.test", inUse: true }] };
  const ui = picker([{ provider: "claude-anthropic", show: "accounts", accounts: [stored, gpt.accounts[0]!.id!] }], { providers: [login] });
  const boxes = boxesOf(ui, "claude-anthropic");
  assert.deepEqual(boxes.map((box) => [box.attrs["data-key"], box.checked]), [
    ["band-account:claude-anthropic:current", true],
    [`band-account:claude-anthropic:${gpt.accounts[0]!.id}`, true],
  ], "no unavailable row for the stored id the login stands for");
  boxes[0]!.checked = false;
  boxes[0]!.fire("change");
  assert.deepEqual(ui.state.mod.settings.bandLimits, [{ provider: "claude-anthropic", show: "accounts", accounts: [gpt.accounts[0]!.id] }]);
});
