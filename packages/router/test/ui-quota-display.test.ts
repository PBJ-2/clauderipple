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
  click() { this.listeners.click?.(); }
}

function harness(options: { stored?: string; blockedStorage?: boolean; lang?: string } = {}) {
  const nodes: Element[] = [];
  const health = new Element("health");
  const storage = new Map(options.stored === undefined ? [] : [["clauderipple_quota_remaining", options.stored]]);
  const h = {
    nodes, health, storage, writes: [] as unknown[],
    config: { providers: { a: { type: "chatgpt" }, b: { type: "chatgpt" } } },
    status: { chatgpt: { quota: { a: quota(97, 98), b: quota() } }, providers: {} },
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
    const $ = selector => selector === '#health-providers' ? h.health : null;
    const svgIcon = () => el('svg');
    const cell = (label, value, sub = []) => el('cell', {}, [typeof label === 'string' ? el('label', {text:label}) : label, ...(Array.isArray(value) ? value : [value]), ...sub].filter(Boolean));
    const providerLabel = (name, provider) => provider.label || name;
    const providerState = () => el('state');
    const credentialLine = () => null;
    const chevronIcon = () => el('svg');
    const hint = text => el('hint', {text});
    const openProvider = () => {};
    const status = h.status, currentConfig = h.config;
    const configRequest = next => { h.writes.push(next); throw Error('display must not save config'); };
    ${block("const QUOTA_VIEW_STORE =", "function shortError(")}
    ${block("function renderHealthProviders()", "let statusModBusy =")}
    ${block("function chatgptQuotaText(", "/** A wait people read")}
    const chatgptLoginBusy = false;
    const queueMicrotask = () => {};
    ${block("function chatgptAccountsPanel(", "// ---- API-key accounts")}
    return { quotaLine, quotaWindowsText, chatgptQuotaText, accountQuotaNode, setQuotaRemaining, renderHealthProviders, chatgptAccountsPanel };
  `)(h, el, dictionaries[options.lang || "en"]!) as {
    quotaLine(name: string): string | null;
    quotaWindowsText(windows: (Window | null)[]): string;
    chatgptQuotaText(q: Quota | null): string;
    accountQuotaNode(q: Quota | null): Element | null;
    setQuotaRemaining(remaining: boolean): void;
    renderHealthProviders(): void;
    chatgptAccountsPanel(name: string): Element;
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
  const originalConfig = structuredClone(h.config);
  const originalStatus = structuredClone(h.status);
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
  assert.deepEqual(h.writes, [], "the display control must not save config");
  assert.deepEqual(h.config, originalConfig);
  assert.deepEqual(h.status, originalStatus, "displaying remaining limits must not mutate backend quota");
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

test("quota display adds no provider-local account controls or config saves", () => {
  const { h, ui } = harness();
  const panel = ui.chatgptAccountsPanel("a");
  assert.equal(panel.children.length, 1, "no extra account-selection section");
  assert.equal(panel.children[0]!.children.at(-1)!.textContent, dictionaries.en!["providers.chatgptAccountsSubtitle"]);
  assert.equal(h.nodes.some(node => node.tag === "select"), false);
  assert.doesNotMatch(source, /saveChatgptBinding|renderChatgptBinding|chatgpt-account-binding|chatgpt-account-selection/);
  assert.doesNotMatch(block("async function probeProvider(", "// ---- Capability measurement"), /provider\.account/);
  for (const dictionary of Object.values(dictionaries)) {
    for (const key of ["providers.chatgptAccountBinding", "providers.chatgptAccountAuto", "providers.chatgptAccountMissing", "providers.chatgptAccountBindingHelp"]) {
      assert.equal(Object.hasOwn(dictionary, key), false, key);
    }
  }
  assert.deepEqual(h.writes, []);
});

test("status renders the existing backend active-account snapshot", () => {
  const { h, ui } = harness();
  h.status.chatgpt.quota.a = quota(27, 35);
  assert.equal(ui.quotaLine("a"), "5h 27% used · weekly 35% used");
  ui.renderHealthProviders();
  assert.match(texts(h.health), /5h 27% used · weekly 35% used/);
  assert.doesNotMatch(texts(h.health), /97% used|98% used/);
});

test("quota display strings are translated in every dashboard language", () => {
  const keys = ["quota.usedLine", "quota.remainingLine", "quota.showUsed", "quota.showRemaining"];
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    for (const key of keys) assert.ok(dictionary[key], `${language}: ${key}`);
  }
  const { ui } = harness({ lang: "ko", stored: "true" });
  assert.equal(ui.quotaLine("b"), "5시간 73% 남음 · 주간 65% 남음");
});
