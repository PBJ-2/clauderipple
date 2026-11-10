import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
const i18nSource = fs.readFileSync(new URL("../../ui/i18n.js", import.meta.url), "utf8");
const dictionaryStart = i18nSource.indexOf("const I18N = {");
const dictionaryEnd = i18nSource.indexOf("\n};", dictionaryStart);
const dictionaries = new Function(`${i18nSource.slice(dictionaryStart, dictionaryEnd + 3)}; return I18N;`)() as Record<string, Record<string, string>>;

function block(from: string, to: string) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
}

type Window = { used_percent: number; window_minutes?: number; reset_at?: number };
type Quota = { rate_limits: { primary: Window | null; secondary: Window | null } };
const quota = (used = 27, weekly = 35): Quota => ({ rate_limits: { primary: { used_percent: used, window_minutes: 300 }, secondary: { used_percent: weekly, window_minutes: 10080 } } });

class Element {
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: Element[] = [];
  textContent = "";
  title = "";
  value = "";
  disabled = false;
  listeners: Record<string, () => void> = {};
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  setAttribute(key: string, value: unknown) {
    this.attrs[key] = String(value);
    if (key === "data-quota-windows") this.dataset.quotaWindows = String(value);
  }
  addEventListener(event: string, fn: () => void) { this.listeners[event] = fn; }
  replaceChildren(...children: Element[]) { this.children = children; }
  contains(node: Element | null): boolean { return node === this || this.children.some(child => typeof child !== "string" && child.contains(node)); }
  click() { this.listeners.click?.(); }
}

type Config = { providers: Record<string, { type: string; account?: string; label?: string }>; autoUpdate?: boolean };
function harness(options: { stored?: string; blockedStorage?: boolean; lang?: string } = {}) {
  const nodes: Element[] = [];
  const health = new Element("health");
  const binding = new Element("binding");
  const storage = new Map(options.stored === undefined ? [] : [["clauderipple_quota_remaining", options.stored]]);
  const h = {
    nodes, health, binding, storage, writes: [] as Config[], toasts: [] as string[], failRead: false, failWrite: false,
    config: { providers: { a: { type: "chatgpt", account: "first" }, b: { type: "chatgpt", account: "second" } }, autoUpdate: true } as Config,
    status: { chatgpt: { quota: { a: quota(97, 98), b: quota() } }, providers: {} },
    selectedProviderName: "a", renders: 0, activeElement: null as Element | null,
  };
  const el = (tag: string, attrs: Record<string, unknown> = {}, children: Element[] = []) => {
    const node = new Element(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "text") node.textContent = String(value);
      else node.setAttribute(key, value);
    }
    node.children = children.filter(Boolean);
    nodes.push(node);
    return node;
  };
  const ui = new Function("h", "el", "dict", `
    const t = (key, vars = {}) => (dict[key] || key).replace(/\\{(\\w+)\\}/g, (_, name) => String(vars[name]));
    const localStorage = { getItem: key => { if (${Boolean(options.blockedStorage)}) throw Error('blocked'); return h.storage.get(key); }, setItem: (key, value) => { if (${Boolean(options.blockedStorage)}) throw Error('blocked'); h.storage.set(key, value); } };
    const $all = selector => h.nodes.filter(node => selector === '[data-quota-windows]' ? node.dataset.quotaWindows : node.attrs.class === 'quota-view-toggle');
    const $ = selector => selector === '#health-providers' ? h.health : selector === '#chatgpt-account-binding' ? h.binding : null;
    const document = { get activeElement() { return h.activeElement; } };
    const svgIcon = () => el('svg');
    const cell = (label, value, sub = []) => el('cell', {}, [typeof label === 'string' ? el('label', {text:label}) : label, ...(Array.isArray(value) ? value : [value]), ...sub].filter(Boolean));
    const providerLabel = (name, provider) => provider.label || name;
    const providerState = () => el('state');
    const credentialLine = () => null;
    const chevronIcon = () => el('svg');
    const hint = text => el('hint', {text});
    const openProvider = () => {};
    const clone = value => JSON.parse(JSON.stringify(value));
    let status = h.status, currentConfig = clone(h.config), slotsLoaded = true, clientsLoaded = true;
    let selectedProviderName = h.selectedProviderName, providerDetailTab = 'accounts';
    const api = async path => { if (h.failRead) throw Error('offline'); if (path !== '/api/config') throw Error(path); return clone(h.config); };
    const configRequest = async next => { h.writes.push(clone(next)); if (h.failWrite) throw Error('write failed'); h.config = clone(next); return {}; };
    const toast = message => h.toasts.push(message);
    const configSaved = (_, message) => h.toasts.push(message);
    const refreshHealth = async () => {};
    const renderProviderWorkspace = () => h.renders++;
    const modSelect = (key, items, value, label, onChange) => { const node = el('select', {'data-key':key, 'aria-label':label}, items.map(item => el('option', {value:item.value, text:item.label}))); node.value = value; node.addEventListener('change', () => onChange(node.value)); return node; };
    ${block("const QUOTA_VIEW_STORE =", "function shortError(")}
    ${block("function renderHealthProviders()", "let statusModBusy =")}
    ${block("function chatgptQuotaText(", "/** A wait people read")}
    ${block("async function saveChatgptBinding(", "function renderChatgptAccountRows(")}
    return { quotaLine, quotaWindowsText, chatgptQuotaText, accountQuotaNode, setQuotaRemaining, renderHealthProviders, saveChatgptBinding, renderChatgptBinding };
  `)(h, el, dictionaries[options.lang || "en"]!) as {
    quotaLine(name: string): string | null;
    quotaWindowsText(windows: (Window | null)[]): string;
    chatgptQuotaText(q: Quota | null): string;
    accountQuotaNode(q: Quota | null): Element | null;
    setQuotaRemaining(remaining: boolean): void;
    renderHealthProviders(): void;
    saveChatgptBinding(name: string, id: string, select: Element): Promise<void>;
    renderChatgptBinding(accounts: { id: string; label: string }[], name: string): void;
  };
  return { h, ui };
}

function texts(node: Element | string): string { return typeof node === "string" ? node : [node.textContent, ...node.children.map(texts)].filter(Boolean).join(" "); }

test("status shows both quota windows, including a weekly-only primary window", () => {
  const { ui } = harness();
  assert.equal(ui.quotaLine("b"), "5h 27% used · weekly 35% used");
  assert.equal(ui.chatgptQuotaText({ rate_limits: { primary: { used_percent: 97, window_minutes: 10080 }, secondary: null } }), "weekly 97% used");
  assert.equal(ui.quotaLine("missing"), null);
  assert.equal(ui.chatgptQuotaText(null), "");
});

test("an icon-only account button switches every account and status to remaining limits", () => {
  const { h, ui } = harness();
  const first = ui.accountQuotaNode(quota())!;
  const second = ui.accountQuotaNode(quota(97, 100))!;
  ui.renderHealthProviders();
  const button = first.children[1]!;
  assert.equal(button.textContent, "");
  assert.equal(button.children[0]!.tag, "svg");
  assert.equal(button.attrs["aria-label"], "Show remaining limits");
  assert.equal(button.attrs["aria-pressed"], "false");
  button.click();
  assert.equal(first.children[0]!.textContent, "5h 73% remaining · weekly 65% remaining");
  assert.match(second.children[0]!.textContent, /^5h 3% remaining · weekly 0% remaining/);
  assert.equal(button.attrs["aria-pressed"], "true");
  assert.equal(second.children[1]!.attrs["aria-label"], "Show usage");
  assert.match(texts(h.health), /5h 73% remaining · weekly 65% remaining/);
  assert.equal(h.storage.get("clauderipple_quota_remaining"), "true");
  second.children[1]!.click();
  assert.equal(first.children[0]!.textContent, "5h 27% used · weekly 35% used");
  assert.match(texts(h.health), /5h 27% used · weekly 35% used/);
  assert.deepEqual(h.writes, [], "the preference must not change account routing or quota data");
});

test("remaining preference survives reload and does not require browser storage", () => {
  assert.equal(harness({ stored: "true" }).ui.quotaLine("b"), "5h 73% remaining · weekly 65% remaining");
  const { ui } = harness({ blockedStorage: true });
  assert.doesNotThrow(() => ui.setQuotaRemaining(true));
  assert.equal(ui.quotaLine("b"), "5h 73% remaining · weekly 65% remaining");
});

test("remaining percentages clamp to the valid range and missing values stay missing", () => {
  const { ui } = harness({ stored: "true" });
  assert.equal(ui.quotaWindowsText([{ used_percent: 0, window_minutes: 300 }]), "5h 100% remaining");
  assert.equal(ui.quotaWindowsText([{ used_percent: 125, window_minutes: 300 }]), "5h 0% remaining");
  assert.equal(ui.quotaWindowsText([{ used_percent: -3, window_minutes: 300 }]), "5h 100% remaining");
  assert.equal(ui.quotaWindowsText([null, { used_percent: NaN }, { used_percent: Infinity }]), "");
  const full = ui.quotaWindowsText([{ used_percent: 100, window_minutes: 300, reset_at: 1893456000 }]);
  assert.match(full, /^5h 0% remaining · resets /, "a full window keeps its reset information");
});

test("account selection preserves all choices, including a missing saved account", () => {
  const { h, ui } = harness();
  ui.renderChatgptBinding([{ id: "first", label: "First" }, { id: "second", label: "Second" }], "a");
  const select = h.binding.children[0]!.children[1]!;
  assert.equal(select.value, "first");
  assert.deepEqual(select.children.map(node => node.attrs.value), ["", "first", "second"]);
  h.activeElement = select;
  ui.renderChatgptBinding([{ id: "second", label: "Second" }], "a");
  assert.equal(h.binding.children[0]!.children[1], select, "polling preserves a focused account menu");
  h.activeElement = null;
  ui.renderChatgptBinding([{ id: "second", label: "Second" }], "a");
  assert.match(texts(h.binding), /Unavailable account · first/);
});

test("binding saves only that provider's account onto fresh config and automatic clears it", async () => {
  const { h, ui } = harness();
  h.config.autoUpdate = false;
  h.config.providers.b!.label = "Changed elsewhere";
  const select = new Element("select");
  await ui.saveChatgptBinding("a", "second", select);
  assert.equal(h.writes[0]!.providers.a!.account, "second");
  assert.equal(h.writes[0]!.providers.b!.label, "Changed elsewhere");
  assert.equal(h.writes[0]!.autoUpdate, false);
  assert.equal(select.disabled, false);
  await ui.saveChatgptBinding("a", "", select);
  assert.equal(Object.hasOwn(h.writes[1]!.providers.a!, "account"), false);
});

test("failed binding reads or writes never claim success and restore the selection", async () => {
  for (const failure of ["failRead", "failWrite"] as const) {
    const { h, ui } = harness();
    h[failure] = true;
    const select = new Element("select");
    select.value = "second";
    await ui.saveChatgptBinding("a", "second", select);
    assert.equal(select.value, "first");
    assert.equal(select.disabled, false);
    assert.equal(h.renders, 0);
    assert.deepEqual(h.toasts, ["Could not save."]);
    if (failure === "failRead") assert.deepEqual(h.writes, []);
  }
});

test("connection probes carry the provider's selected account and auth mode", async () => {
  const sent: { auth?: string; account?: string }[] = [];
  const probeProvider = new Function("api", `
    const probeStates = new Map();
    const renderHealthProviders = () => {};
    ${block("async function probeProvider(", "// ---- Capability measurement")}
    return probeProvider;
  `)(async (url: string, options: { body: string }) => {
    assert.equal(url, "/api/providers/probe");
    sent.push(JSON.parse(options.body));
    return { ok: true };
  }) as (name: string, provider: { type: string; auth: string; account?: string }) => Promise<unknown>;
  await probeProvider("a", { type: "chatgpt", auth: "own", account: "first" });
  await probeProvider("b", { type: "chatgpt", auth: "auto" });
  assert.deepEqual(sent, [{ type: "chatgpt", auth: "own", account: "first" }, { type: "chatgpt", auth: "auto" }]);
});

test("quota and account-selection strings are translated in every dashboard language", () => {
  const keys = ["quota.usedLine", "quota.remainingLine", "quota.showUsed", "quota.showRemaining", "providers.chatgptAccountBinding", "providers.chatgptAccountAuto", "providers.chatgptAccountMissing", "providers.chatgptAccountBindingHelp"];
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    for (const key of keys) assert.ok(dictionary[key], `${language}: ${key}`);
  }
  const { ui } = harness({ lang: "ko", stored: "true" });
  assert.equal(ui.quotaLine("b"), "5시간 73% 남음 · 주간 65% 남음");
});
