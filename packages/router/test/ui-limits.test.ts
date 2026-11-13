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
const t = (key: string, vars: Record<string, unknown> = {}) => Object.entries(vars).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), dictionaries.en![key] ?? key);

class Element {
  style: Record<string, string> = {};
  tabIndex = 0;
  readonly tag: string;
  readonly attrs: Record<string, unknown>;
  children: Element[];
  constructor(tag: string, attrs: Record<string, unknown> = {}, children: Element[] = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children.filter(Boolean);
  }
  appendChild(child: Element) { this.children.push(child); }
  replaceChildren(...children: Element[]) { this.children = children; }
  #listeners: Record<string, () => void> = {};
  addEventListener(name: string, listener: () => void) { this.#listeners[name] = listener; }
  click() { this.#listeners.click?.(); }
  querySelector(selector: string) { return findAll(this, hasClass(selector.slice(1)))[0] ?? null; }
  setAttribute(name: string, value: unknown) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name]; }
  get dataset() { return { quotaWindows: this.attrs["data-quota-windows"] }; }
  get title() { return this.attrs.title; }
  set title(value: unknown) { this.attrs.title = value; }
  set innerHTML(_value: string) { throw new Error("innerHTML is forbidden"); }
}
const el = (tag: string, attrs: Record<string, unknown> = {}, children: Element[] = []) => new Element(tag, attrs, children);
const text = (node: Element): string => [node.attrs.text, ...node.children.map(text)].filter(Boolean).join(" ");
const findAll = (node: Element, predicate: (node: Element) => boolean): Element[] => [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
const hasClass = (name: string) => (node: Element) => String(node.attrs.class ?? "").split(" ").includes(name);
function block(from: string, to: string): string {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start > 0 && end > start, `app.js no longer contains ${from}`);
  return source.slice(start, end);
}

type LimitsUi = {
  refreshHealth(): Promise<void>;
  renderHealthProviders(): void;
  limitsAccountRow(entry: unknown, account: unknown, now: number, credential?: unknown): Element;
  limitsWindowRow(label: string, window: unknown, now: number, accountName?: string): Element;
  limitsUsageWindow(window: unknown): unknown;
  settleLimits(): Promise<unknown>;
  providerLimits(name: string): { accounts: Record<string, unknown>[] } | null;
  limitsSnapshotPeek(): unknown;
  quotaMeters(windows: unknown, at?: number): Element | null;
  claudeQuotaNode(account: unknown): Element | null;
  renderChatgptAccountRows(target: Element, data: unknown, name: string, generation: number): void;
  quotaWindowsText(windows: unknown): string;
  setQuotaRemaining(remaining: boolean): void;
  quotaLine(name: string): string | null;
  providersUsageTitle(): string;
  selectProvider(name: string): void;
  renderCount(): number;
};
const defaultConfig = { providers: { claude: { type: "anthropic", auth: "claude-code" }, gpt: { type: "chatgpt" }, other: { type: "openai-compatible" } } };
// `config` null is the screen before the config has loaded: the status alone names the providers.
function limitsUi(api: (path: string) => Promise<unknown>, status: Record<string, unknown> = {}, config: Record<string, unknown> | null = defaultConfig, storage = { getItem: (_key: string): string | null => null, setItem: (_key: string, _value: string) => {} }) {
  const card = el("div"), desktop = el("div"), header = el("div"), meters = el("div");
  const selectAll = () => [card, desktop, meters].flatMap((root) => findAll(root, (node) => node.attrs["data-quota-windows"] !== undefined));
  const build = new Function("api", "el", "t", "$", "status", "config", "localStorage", "$all", `
    let currentConfig = config;
    const stateFor = () => null, chevronIcon = () => null, openProvider = () => {}, refreshProviderUsage = () => {}, chatgptLoginButton = () => el("button", { text: "Sign in" }), chatgptLoginMessage = "", providerLabel = (name) => name, providerTitle = (name) => name, providerDisplayName = (name) => name, offline = () => false, providerHue = () => "#000";
    const svgIcon = () => el("svg", { "aria-hidden": "true" });
    const APP = null, clientsLoaded = false, modState = {}, updateState = {}, renderDiagnostics = () => {}, modRedraw = () => {}, versionRow = () => null, autoUpdateRow = () => null, priorityRow = () => null;
    let loadedUiRevision = null;
    let selectedProviderName = null, providerDetailRenders = 0, providerDetailTab = "overview";
    const renderProviderDetail = () => { providerDetailRenders += 1; };
    ${block("function badge(", "/** A titled group")}
    ${block("let limitsSnapshot = null;", "// ---- Diagnostics:")}
    ${block("const QUOTA_VIEW_STORE =", "/**\n * One line a person can read")}
    ${block("function credentialLine(", "/**\n * One verdict")}
    ${block("function providerConnection(", "let statusModBusy")}
    ${block("function claudeAccountLabel(", '/** "5h 14%')}
    ${block("function chatgptQuotaText(", "async function patchChatgptAccount(")}
    ${block("function claudeQuotaNode(", '/** "Use first"')}
    ${block("function accountPoolBadges(", "function renderClaudeAccountRows(")}
    ${block("function renderChatgptAccountRows(", "let googleLoginBusy")}
    const providerDetailGeneration = 0;
    return { refreshHealth, renderHealthProviders, limitsAccountRow, limitsWindowRow, limitsUsageWindow, settleLimits: () => limitsRead ?? Promise.resolve(), providerLimits, limitsSnapshotPeek: () => limitsSnapshot, quotaMeters, quotaWindowsText, setQuotaRemaining, claudeQuotaNode, renderChatgptAccountRows, quotaLine, providersUsageTitle, selectProvider: (name) => { selectedProviderName = name; }, renderCount: () => providerDetailRenders };
  `) as (...args: unknown[]) => LimitsUi;
  const ui = build(async (path: string) => {
    // The config a status poll may re-read answers with the config this screen was given, or fails while it has none.
    if (path === "/api/config") { if (!config) throw new Error("config not loaded"); return config; }
    const response = await api(path);
    return path === "/api/status" ? { settings: {}, ...status, ...(response && typeof response === "object" ? response : {}) } : response;
  }, el, t, (selector: string) => selector === "#health-providers" ? card : selector === "#health-desktop" ? desktop : selector === "#health-quota-toggle" ? header : el("div"), status, config, storage, selectAll);
  // A poll draws the status at once and the gauges when the limits read lands; tests wait for both.
  return { ...ui, card, desktop, header, meters, refresh: async () => { await ui.refreshHealth(); await ui.settleLimits(); } };
}
// The render path reads the real clock, so the fixtures' resets must be ahead of it. Whole seconds,
// as the wire states a reset: `quotaMeters` rounds one to the second, and a fixture half a second
// short of the minute would then read a minute later there than in the text it is compared with.
const now = Math.floor(Date.now() / 1000) * 1000;
const five = { kind: "five_hour", used_percent: 23, window_minutes: 300, reset_at: (now + 255 * 60_000) / 1000 };
const weekly = { kind: "seven_day", used_percent: 125, window_minutes: 10080, reset_at: (now + 86400_000) / 1000 };
const current = { id: "current", account: 0, inUse: true, at: now, windows: [weekly, five] };
const connected = { claude: { reachable: true }, gpt: { reachable: true }, other: { reachable: true } };

test("Status's header toggle stays mounted and changes figures, not account states or source data", async () => {
  const accounts = [
    { id: "a", label: "Work", inUse: true, stale: true, windows: [{ ...five, used_percent: 93 }] },
    { id: "b", label: "Spare", inUse: false, paused: true, windows: [{ ...weekly, used_percent: 100 }] },
  ];
  const limits = { providers: [{ type: "chatgpt", provider: "gpt", title: "GPT", accounts }] };
  const status = { providers: connected };
  const before = JSON.stringify({ status, limits });
  const ui = limitsUi(async (route) => route === "/api/limits" ? limits : {}, status);
  await ui.refresh();
  const button = ui.header.children[0]!;
  assert.equal(button.attrs.type, "button");
  assert.equal(text(button), "");
  assert.equal(button.children[0]!.tag, "svg");
  assert.equal(findAll(ui.card, hasClass("quota-view-toggle")).length, 0);
  assert.equal(button.attrs["aria-label"], t("quota.showRemaining"));
  const markers = () => findAll(ui.card, (node) => node.tag === "strong" || hasClass("badge")(node) || hasClass("limits-window-foot")(node)).map(text);
  const originalMarkers = markers();
  const tones = () => findAll(ui.card, hasClass("limits-window")).map((node) => node.attrs.class);
  const originalTones = tones();
  const meters = ui.quotaMeters(accounts.flatMap((account) => account.windows))!;
  ui.meters.appendChild(meters);
  for (const remaining of [true, false]) {
    button.click();
    assert.equal(ui.header.children[0], button, "a poll or toggle must never replace the focused button");
    assert.equal(ui.header.children.length, 1);
    assert.equal(button.attrs["aria-pressed"], String(remaining));
    assert.equal(button.title, t(remaining ? "quota.showUsed" : "quota.showRemaining"));
    const values = remaining ? [7, 0] : [93, 100];
    assert.deepEqual(findAll(ui.card, (node) => node.attrs.role === "progressbar").map((node) => node.attrs["aria-valuenow"]), values);
    assert.deepEqual(findAll(meters, hasClass("meter-fill")).map((node) => node.style.width), values.map((n) => `${n}%`));
    assert.equal(meters.attrs["aria-label"], ui.quotaWindowsText(accounts.flatMap((account) => account.windows)));
    assert.deepEqual(markers(), originalMarkers);
    assert.deepEqual(tones(), originalTones);
    await ui.refresh();
    assert.equal(ui.header.children[0], button);
  }
  assert.equal(JSON.stringify({ status, limits }), before);
  const html = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
  assert.match(html, /class="section-head health-providers-head"[^\n]*data-i18n="health.providers"[^\n]*id="health-quota-toggle"/);
});

test("toggling account meters keeps their original reset instants as the clock advances", (context) => {
  const fetchedAt = Date.UTC(2026, 10, 12, 13, 28);
  context.mock.timers.enable({ apis: ["Date"], now: fetchedAt });
  const windows = Object.freeze([
    Object.freeze({ used_percent: 100, window_minutes: 300, reset_after_seconds: 600 }),
    Object.freeze({ used_percent: 100, window_minutes: 10080, reset_at: fetchedAt / 1000 + 3600 }),
    Object.freeze({ used_percent: 82, window_minutes: 300, reset_after_seconds: 600 }),
    Object.freeze({ used_percent: 100, window_minutes: 300 }),
  ]);
  const before = JSON.stringify(windows);
  const ui = limitsUi(async () => ({}));
  const meters = ui.quotaMeters(windows)!;
  ui.meters.appendChild(meters);
  const resets = () => findAll(meters, hasClass("account-meter-reset")).map(text);
  const initialResets = resets();
  assert.equal(initialResets.length, 2);
  const expectedReset = t("quota.resetAt", { time: new Date(fetchedAt + 600_000).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) });
  assert.equal(initialResets[0], expectedReset);
  const tones = findAll(meters, hasClass("account-meter")).map((node) => node.attrs.class);
  const stored = String(meters.dataset.quotaWindows);
  for (const remaining of [true, false, true, false]) {
    context.mock.timers.tick(300_000);
    ui.setQuotaRemaining(remaining);
    assert.deepEqual(resets(), initialResets, "toggling must not move a full window's reset into the future");
    assert.ok(String(meters.title).includes(expectedReset));
    assert.equal(meters.attrs["aria-label"], meters.title);
    assert.deepEqual(findAll(meters, hasClass("account-meter-figure")).map(text), remaining ? ["0% remaining", "0% remaining", "18% remaining", "0% remaining"] : ["100%", "100%", "82%", "100%"]);
    assert.deepEqual(findAll(meters, hasClass("account-meter")).map((node) => node.attrs.class), tones);
    assert.equal(meters.dataset.quotaWindows, stored);
  }
  const saved = JSON.parse(stored);
  assert.equal(saved[0].reset_at, fetchedAt / 1000 + 600);
  assert.equal(saved[2].reset_at, fetchedAt / 1000 + 600, "relative resets are fixed even before a window is full");
  assert.ok(saved.every((window: Record<string, unknown>) => !("reset_after_seconds" in window)));
  assert.equal(JSON.stringify(windows), before, "normalization never changes the API response");
});

test("new account readings establish new reset instants without changing older meters", (context) => {
  const fetchedAt = Date.UTC(2026, 10, 12, 13, 28);
  context.mock.timers.enable({ apis: ["Date"], now: fetchedAt });
  const ui = limitsUi(async () => ({}));
  const window = Object.freeze({ used_percent: 100, window_minutes: 300, reset_after_seconds: 600 });
  const first = ui.quotaMeters([window])!;
  ui.meters.appendChild(first);
  const originalReset = text(findAll(first, hasClass("account-meter-reset"))[0]!);
  context.mock.timers.tick(300_000);
  const next = ui.quotaMeters([window])!;
  ui.meters.appendChild(next);
  const nextReset = text(findAll(next, hasClass("account-meter-reset"))[0]!);
  assert.notEqual(nextReset, originalReset, "a newly received relative duration starts from its own reading time");
  ui.setQuotaRemaining(true);
  assert.equal(text(findAll(first, hasClass("account-meter-reset"))[0]!), originalReset);
  assert.equal(text(findAll(next, hasClass("account-meter-reset"))[0]!), nextReset);
  assert.equal(JSON.parse(String(next.dataset.quotaWindows))[0].reset_at, (fetchedAt + 900_000) / 1000);
});

test("account meters prefer the server reset used by Status over a cached relative duration", (context) => {
  const fetchedAt = Date.UTC(2026, 10, 12, 13, 28);
  context.mock.timers.enable({ apis: ["Date"], now: fetchedAt + 39 * 60_000 });
  const ui = limitsUi(async () => ({}));
  const resetAt = fetchedAt / 1000 + 3600;
  for (const absolute of [resetAt, resetAt * 1000]) {
    const window = Object.freeze({ used_percent: 100, window_minutes: 300, reset_at: absolute, reset_after_seconds: 3600 });
    const before = JSON.stringify(window);
    const meters = ui.quotaMeters([window], fetchedAt)!;
    ui.meters.appendChild(meters);
    assert.equal(JSON.parse(String(meters.dataset.quotaWindows))[0].reset_at, resetAt);
    const expected = ui.quotaWindowsText([{ ...window, reset_at: resetAt, reset_after_seconds: undefined }]);
    assert.equal(meters.title, expected, "the account card uses the same absolute deadline as Status");
    context.mock.timers.tick(300_000);
    ui.setQuotaRemaining(true);
    const saved = JSON.parse(String(meters.dataset.quotaWindows));
    assert.equal(saved[0].reset_at, resetAt);
    assert.ok(!("reset_after_seconds" in saved[0]));
    assert.equal(JSON.stringify(window), before);
    ui.setQuotaRemaining(false);
  }
});

test("ChatGPT and Claude cards anchor cached relative resets to the quota snapshot time", (context) => {
  const fetchedAt = Date.UTC(2026, 10, 12, 13, 28);
  context.mock.timers.enable({ apis: ["Date"], now: fetchedAt + 39 * 60_000 });
  const ui = limitsUi(async () => ({}));
  const resetAt = fetchedAt / 1000 + 3600;
  for (const absolute of [undefined, resetAt]) {
    const primary = Object.freeze({ used_percent: 100, window_minutes: 300, reset_after_seconds: 3600, ...(absolute === undefined ? {} : { reset_at: absolute }) });
    const quota = Object.freeze({ at: fetchedAt, rate_limits: Object.freeze({ primary }) });
    const account = Object.freeze({ id: "cached", label: "Cached", source: "codex", state: "ready", quota });
    const before = JSON.stringify(account);
    const target = el("div");
    ui.renderChatgptAccountRows(target, { accounts: [account] }, "gpt", 0);
    const chatgpt = findAll(target, hasClass("account-meters"))[0]!;
    const claude = ui.claudeQuotaNode(account)!;
    const expected = ui.quotaWindowsText([{ used_percent: 100, window_minutes: 300, reset_at: resetAt }]);
    for (const meter of [chatgpt, claude]) {
      assert.equal(meter.title, expected);
      assert.equal(JSON.parse(String(meter.dataset.quotaWindows))[0].reset_at, resetAt);
      ui.meters.appendChild(meter);
    }
    context.mock.timers.tick(300_000);
    ui.setQuotaRemaining(true);
    for (const meter of [chatgpt, claude]) {
      assert.equal(JSON.parse(String(meter.dataset.quotaWindows))[0].reset_at, resetAt);
      assert.equal(meter.attrs["aria-label"], ui.quotaWindowsText([{ used_percent: 100, window_minutes: 300, reset_at: resetAt }]));
    }
    assert.equal(JSON.stringify(account), before);
    ui.setQuotaRemaining(false);
  }
});

test("quota display preference persists locally, tolerates blocked storage and filters nonfinite figures", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const ui = limitsUi(async () => ({}), {}, defaultConfig, storage);
  ui.setQuotaRemaining(true);
  assert.equal(data.get("clauderipple_quota_remaining"), "true");
  const reloaded = limitsUi(async () => ({}), {}, defaultConfig, storage);
  assert.match(text(reloaded.quotaMeters([{ used_percent: 93 }])!), /7% remaining/);
  const blocked = limitsUi(async () => ({}), {}, defaultConfig, { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); } });
  assert.doesNotThrow(() => blocked.setQuotaRemaining(true));
  assert.equal(blocked.quotaMeters([{ used_percent: NaN }, { used_percent: Infinity }]), null);
  assert.match(text(blocked.quotaMeters([{ used_percent: 125 }])!), /0% remaining/);
  for (const dict of Object.values(dictionaries)) {
    for (const key of ["quota.remainingLine", "quota.showUsed", "quota.showRemaining", "providers.usage", "providers.remaining"]) assert.ok(dict[key]);
  }
});

test("the used/remaining toggle reaches the one-line quota text and the overview's usage heading, and redraws the open overview", () => {
  const status = { chatgpt: { quota: { gpt: { rate_limits: { primary: { ...five, used_percent: 80 } } } } } };
  const ui = limitsUi(async () => ({}), status);
  assert.equal(ui.quotaLine("gpt"), t("health.quota", { percent: 80, reset: "" }));
  assert.equal(ui.quotaLine("missing"), null);
  assert.equal(ui.providersUsageTitle(), t("providers.usage"));
  // No provider open: nothing is drawn on the hidden page; the toggle only redraws what is open.
  ui.setQuotaRemaining(true);
  assert.equal(ui.renderCount(), 0);
  ui.setQuotaRemaining(false);
  ui.selectProvider("gpt");
  const before = ui.renderCount();
  ui.setQuotaRemaining(true);
  assert.equal(ui.quotaLine("gpt"), "20% remaining");
  assert.equal(ui.providersUsageTitle(), t("providers.remaining"));
  assert.equal(ui.providersUsageTitle(), "Remaining limits");
  assert.equal(ui.renderCount(), before + 1, "the open overview is drawn again");
  ui.setQuotaRemaining(false);
  assert.equal(ui.quotaLine("gpt"), t("health.quota", { percent: 80, reset: "" }));
  assert.equal(ui.providersUsageTitle(), t("providers.usage"));
  assert.equal(ui.renderCount(), before + 2);
});

test("Status replaces subscription text lines with per-account gauges, leaving other providers alone", async () => {
  const paths: string[] = [];
  const ui = limitsUi(async (path) => {
    paths.push(path);
    if (path === "/api/status") return {};
    return { providers: [
      { type: "anthropic", provider: "claude", title: "Claude", accounts: [current] },
      { type: "chatgpt", provider: "gpt", title: "GPT", accounts: [{ ...current, inUse: false }] },
    ] };
  }, { providers: connected, chatgpt: { quota: { gpt: { rate_limits: { primary: five } }, other: { rate_limits: { primary: five } } } } });
  await ui.refresh();
  assert.deepEqual(paths, ["/api/status", "/api/limits"]);
  assert.equal(ui.card.children.length, 3, "one row per provider, no separate Limits card");
  assert.equal(findAll(ui.card, hasClass("provider-block")).length, 2);
  assert.equal(findAll(ui.card.children[0]!.children[0]!, hasClass("limits-account")).length, 0, "the clickable header holds no gauges");
  assert.match(text(ui.card), /Current Claude login/);
  // GPT's only account has no label: no made-up "GPT 1" name, its windows stand under the provider, and the
  // gauges are named by the provider for a screen reader.
  assert.doesNotMatch(text(ui.card), /GPT 1/);
  const gpt = findAll(ui.card.children[1]!, hasClass("limits-account"))[0]!;
  assert.ok(hasClass("unnamed")(gpt));
  assert.equal(findAll(gpt, (node) => node.tag === "strong").length, 0);
  assert.deepEqual(findAll(gpt, (node) => node.attrs.role === "progressbar").map((bar) => bar.attrs["aria-label"]), ["GPT · Weekly", "GPT · 5-hour"]);
  assert.equal(findAll(ui.card, (node) => node.attrs.text === "Active").length, 1);
  assert.match(text(ui.card.children[0]!), /23%/);
  assert.doesNotMatch(text(ui.card.children[1]!), /used/);
  assert.match(text(ui.card.children[2]!), /23%/, "a provider outside the view keeps its text quota");
  assert.equal(findAll(ui.card, (node) => node.attrs.text === "Connected").length, 3);
});

test("ChatGPT accounts keep saved order, states and empty accounts without shifting the figures", async () => {
  const accounts = [
    { id: "a", label: "First", state: "ready" },
    { id: "p", label: "Paused", state: "paused", paused: true },
    { id: "n", label: "Expired", state: "needs-login" },
    { id: "b", email: "waiting@example.test", state: "ready" },
    { id: "c", label: "Last", state: "cooling", cooldownSeconds: 90, quota: { stale: true } },
  ];
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "chatgpt", provider: "gpt", title: "GPT", accounts: [{ account: 2, id: "c", at: now, windows: [weekly] }, { ...current, id: "a" }] },
  ] } : {}, { providers: connected, chatgpt: { accounts: { gpt: accounts } } });
  await ui.refresh();
  const rows = findAll(ui.card.children[1]!, hasClass("limits-account"));
  assert.deepEqual(rows.map((row) => row.children[0]!.children[0]!.attrs.text), ["First", "Paused", "Expired", "waiting@example.test", "Last"]);
  assert.match(text(rows[0]!), /23%/);
  assert.match(text(rows[1]!), /Paused/);
  assert.match(text(rows[2]!), /Sign in again/);
  for (const row of rows.slice(1, 4)) {
    assert.equal(findAll(row, hasClass("limits-windows")).length, 0, "no empty gauges for an account with no reading");
    assert.match(text(row), /No usage snapshot yet|Paused|Sign in again/);
    assert.doesNotMatch(text(row), /23%|125%/);
  }
  assert.match(text(rows[4]!), /125%/);
  assert.match(text(rows[4]!), /Stale/);
  assert.match(text(rows[4]!), /available again in/);
});

test("Claude renders only limits entries, preserving their labels, order and active account", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "anthropic", provider: "claude", title: "Claude", accounts: [{ account: 2, id: "pref", label: "Preferred", at: now, windows: [five] }, { ...current, inUse: false }] },
  ] } : {}, { providers: connected, claude: { accounts: [
    { id: "current", quota: {} },
    { id: "pref", label: "Preferred", quota: {}, inUse: true },
    { id: "unread", label: "Unread", quota: {} },
  ] } });
  await ui.refresh();
  const rows = findAll(ui.card.children[0]!, hasClass("limits-account"));
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]!), /Preferred.*Active.*23%/);
  assert.match(text(rows[1]!), /Current Claude login.*23%/);
  assert.doesNotMatch(text(rows[1]!), /Active/);
  assert.doesNotMatch(text(ui.card.children[0]!), /Unread/);
});

test("ChatGPT's provider-level refresh failure marks its retained figures stale", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "chatgpt", provider: "gpt", title: "GPT", accounts: [current] },
  ] } : {}, { providers: connected, chatgpt: { stale: true, staleReason: { gpt: "lookup failed; showing last known value" } } });
  await ui.refresh();
  assert.match(text(ui.card.children[1]!), /Stale.*23%/);
  assert.doesNotMatch(text(ui.card.children[0]!), /Stale/);
});

test("a failed limit read shows the text lines until one succeeds, then keeps the last gauges marked stale", async () => {
  let fail = true;
  const quota = { rate_limits: { primary: five } };
  const ui = limitsUi(async (path) => {
    if (path !== "/api/limits") return {};
    if (fail) throw new Error("HTTP 404");
    return { providers: [{ type: "anthropic", provider: "claude", title: "Claude", accounts: [current] }] };
  }, {
    providers: connected, claude: { accounts: [{ id: "current", quota }] },
    chatgpt: { quota: { gpt: quota } }, credentials: { gpt: [{ label: "Stored", state: "quarantined" }] },
  });
  // [this read fails, gauges shown, stale mark shown]
  for (const [failed, gauges, stale] of [[true, 0, 0], [false, 1, 0], [true, 1, 1], [false, 1, 0]] as const) {
    fail = failed;
    await ui.refresh();
    assert.equal(findAll(ui.card, hasClass("provider-block")).length, gauges);
    assert.equal(findAll(ui.card, (node) => node.attrs.text === t("limits.stale")).length, stale);
    assert.match(text(ui.card.children[0]!), /23%/);
    assert.match(text(ui.card.children[1]!), /23%.*Stored: rejected/);
    assert.equal(ui.card.children.length, 3);
  }
});

test("an older limits response or a provider with no accounts never makes an empty card", async () => {
  for (const response of [{}, { providers: [] }]) {
    const ui = limitsUi(async (path) => path === "/api/limits" ? response : {}, { providers: { ...connected, gpt: { reachable: true, needsLogin: true } } });
    await ui.refresh();
    assert.equal(findAll(ui.card, hasClass("limits-account")).length, 0);
    assert.equal(ui.card.children.length, 3);
    assert.ok(text(ui.card.children[1]!).includes(t("providerStatus.loginNeeded")));
    assert.equal(findAll(ui.card.children[1]!, (node) => node.tag === "button").length, 1);
  }
});

test("accounts without any figures still have cards and a provider's sign-in action stays available", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [] } : {}, {
    providers: { ...connected, gpt: { reachable: true, needsLogin: true } },
    chatgpt: { accounts: { gpt: [{ id: "p", label: "Paused account", paused: true, state: "paused" }, { id: "n", label: "Expired account", state: "needs-login" }] } },
  });
  await ui.refresh();
  const row = ui.card.children[1]!;
  assert.equal(findAll(row, hasClass("limits-account")).length, 2);
  assert.equal(findAll(row, hasClass("limits-windows")).length, 0, "no gauge stands in for a window nobody reported");
  assert.equal(findAll(row, (node) => node.tag === "button").length, 1);
  assert.ok(text(row).includes(t("providerStatus.loginNeeded")));
});

test("each Status poll requests only status and limits, in parallel", async () => {
  const paths: string[] = [];
  let resolveStatus: (value: unknown) => void = () => {};
  const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
  const ui = limitsUi(async (path) => {
    paths.push(path);
    if (path === "/api/status") return pendingStatus;
    assert.equal(path, "/api/limits");
    return { providers: [{ type: "anthropic", provider: "claude", title: "Claude", accounts: [current] }] };
  }, { providers: connected });
  const refresh = ui.refresh();
  assert.deepEqual(paths, ["/api/status", "/api/limits"], "limits starts before status resolves");
  resolveStatus({});
  await refresh;
  await ui.refresh();
  assert.deepEqual(paths, ["/api/status", "/api/limits", "/api/status", "/api/limits"]);
  assert.match(text(ui.card), /Current Claude login.*23%/);
});

test("a failed status read keeps the disconnected handling and existing provider rows", async () => {
  let fail = false;
  const ui = limitsUi(async (path) => {
    if (path === "/api/status") {
      if (fail) throw new Error("disconnected");
      return {};
    }
    return { providers: [{ type: "anthropic", provider: "claude", title: "Claude", accounts: [current] }] };
  }, { providers: connected });
  await ui.refresh();
  const rows = [...ui.card.children];
  fail = true;
  await ui.refresh();
  assert.ok(text(ui.desktop).includes(t("health.disconnected")));
  assert.deepEqual(ui.card.children, rows);
});

test("window gauges show the share and the reset, and a window with no reset says so", () => {
  const ui = limitsUi(async () => ({}));
  const window = ui.limitsUsageWindow(five);
  assert.deepEqual(window, { kind: "five_hour", usedPercent: 23, windowMinutes: 300, resetAt: now + 255 * 60_000 });
  const row = ui.limitsWindowRow(t("limits.fiveHour"), window, now);
  assert.match(text(row), /resets in 4h 15m/);
  const week = ui.limitsWindowRow(t("limits.weekly"), ui.limitsUsageWindow(weekly), now);
  const bar = findAll(week, (node) => node.attrs.role === "progressbar")[0]!;
  assert.equal(bar.attrs["aria-valuenow"], 100);
  assert.match(String(bar.attrs["aria-valuetext"]), /125%/);
  assert.equal(findAll(week, hasClass("limits-fill"))[0]!.style.width, "100%");
  assert.ok(text(week).includes(t("limits.resetsAt", { time: new Date(now + 86400_000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }) })));
  // A reported window that gives no reset time says so, and keeps its share.
  const unreset = ui.limitsWindowRow(t("limits.weekly"), ui.limitsUsageWindow({ kind: "seven_day", used_percent: 5, window_minutes: 10080 }), now);
  assert.match(text(unreset), /5%.*Reset time unknown/);
  assert.equal(findAll(unreset, (node) => node.attrs.role === "progressbar")[0]!.attrs["aria-valuenow"], 5);
  const passedDate = new Date(now - 1).toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const passed = ui.limitsWindowRow(t("limits.fiveHour"), { usedPercent: 0, resetAt: now - 1 }, now);
  assert.match(text(passed), /0%.*Its reset time \(.*\) has passed\./);
  assert.ok(text(passed).includes(t("limits.passed", { date: passedDate })));
  assert.doesNotMatch(text(passed), /resets in/);
  assert.equal(ui.limitsUsageWindow(null), null);
  assert.equal(ui.limitsUsageWindow({ kind: "five_hour", used_percent: Number.NaN }), null, "a window with no share is not drawn");
});

test("an account label stays text and its timestamp is the figures' time", () => {
  const ui = limitsUi(async () => ({}));
  const row = ui.limitsAccountRow({ type: "chatgpt", title: "GPT" }, { ...current, label: "<img src=x onerror=alert(1)>" }, now);
  assert.match(text(row), /<img src=x/);
  assert.equal(findAll(row, (node) => node.tag === "img").length, 0);
  // The figures' time is on the name's tooltip, not a line on every account; a stale account spells it out.
  const fetched = t("limits.fetchedAt", { time: new Date(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }) });
  assert.ok(String(row.children[0]!.children[0]!.attrs.title).endsWith(fetched));
  assert.ok(!text(row).includes(fetched));
  const stale = ui.limitsAccountRow({ type: "chatgpt", title: "GPT", stale: true }, current, now);
  assert.ok(text(stale).includes(fetched));
});

test("an account's state is said once: a paused account has no 'no usage' line, and a pool cooldown sits on its own row", () => {
  const ui = limitsUi(async () => ({}));
  const paused = ui.limitsAccountRow({ type: "chatgpt", title: "GPT" }, { id: "p", label: "Paused", state: "paused", paused: true, account: null, windows: [], at: 0 }, now);
  assert.match(text(paused), /Paused/);
  assert.doesNotMatch(text(paused), /No usage snapshot yet/);
  const unread = ui.limitsAccountRow({ type: "chatgpt", title: "GPT" }, { id: "w", label: "Waiting", state: "ready", account: 1, windows: [], at: 0 }, now);
  assert.match(text(unread), /No usage snapshot yet/);
  const cooling = ui.limitsAccountRow({ type: "anthropic", title: "Claude" }, { ...current, id: "x", label: "Stored" }, now, { id: "x", state: "cooling", cooldownSeconds: 90 });
  assert.ok(text(cooling).includes(t("pool.coolingFor", { duration: t("time.minutes", { m: 2 }) })));
  const rejected = ui.limitsAccountRow({ type: "anthropic", title: "Claude" }, { ...current, id: "y", label: "Bad" }, now, { id: "y", state: "quarantined" });
  assert.ok(text(rejected).includes(t("pool.quarantined")));
});

test("a countdown under an hour is minutes alone, in every language's own minutes unit", () => {
  const ui = limitsUi(async () => ({}));
  const row = ui.limitsWindowRow("5-hour", { usedPercent: 10, resetAt: now + 34 * 60_000 - 1 }, now);
  assert.ok(text(row).includes("resets in 34m"));
  assert.doesNotMatch(text(row), /0h/);
  assert.ok(text(ui.limitsWindowRow("5-hour", { usedPercent: 10, resetAt: now + 61 * 60_000 }, now)).includes("resets in 1h 1m"));
  for (const [lang, dict] of Object.entries(dictionaries)) {
    const minutesOnly = dict["limits.resetsIn"]!.replace(/\{hours\}[^{]*?(?=\{minutes\})/, "");
    assert.ok(!minutesOnly.includes("{hours}") && minutesOnly.includes("{minutes}"), `${lang} drops the hour part cleanly`);
  }
});

test("a countdown of whole hours is hours alone, its zero minutes dropped with their unit in every language", () => {
  const ui = limitsUi(async () => ({}));
  const exact = text(ui.limitsWindowRow("5-hour", { usedPercent: 10, resetAt: now + 2 * 3600_000 - 1 }, now));
  assert.ok(exact.includes("resets in 2h"), exact);
  assert.doesNotMatch(exact, /0m/);
  assert.ok(text(ui.limitsWindowRow("5-hour", { usedPercent: 10, resetAt: now + 121 * 60_000 }, now)).includes("resets in 2h 1m"));
  const expected: Record<string, string> = { ko: "2시간 후 초기화", en: "resets in 2h", zh: "2 小时后重置", ja: "2時間後にリセット", es: "se reinicia en 2 h", pt: "redefine em 2 h" };
  for (const [lang, dict] of Object.entries(dictionaries)) {
    const unit = dict["units.minutes"]!.replace("{n}", "").trim();
    const whole = dict["limits.resetsIn"]!.replace(new RegExp(`\\s*\\{minutes\\}\\s*${unit}`), "");
    assert.ok(!whole.includes("{minutes}") && whole.includes("{hours}"), `${lang} drops the minutes part cleanly`);
    if (expected[lang]) assert.equal(whole.split("{hours}").join("2"), expected[lang], lang);
  }
});

test("a provider's only account keeps its own label as its name; several unnamed accounts stay numbered", () => {
  const ui = limitsUi(async () => ({}));
  const one = (account: Record<string, unknown>) => ui.limitsAccountRow({ type: "minimax", title: "MiniMax", accounts: [account] }, account, now);
  assert.ok(hasClass("unnamed")(one({ account: 0, at: now, windows: [five] })));
  assert.equal(findAll(one({ account: 0, label: "work@example.test", at: now, windows: [five] }), (node) => node.attrs.text === "work@example.test").length, 1);
  const pair = [{ account: 0, at: now, windows: [five] }, { account: 1, at: now, windows: [five] }];
  assert.ok(text(ui.limitsAccountRow({ type: "minimax", title: "MiniMax", accounts: pair }, pair[1], now)).includes("MiniMax 2"));
  const login = { id: "current", account: 0, at: now, windows: [five] };
  assert.ok(text(ui.limitsAccountRow({ type: "anthropic", title: "Claude", accounts: [login] }, login, now)).includes(t("providers.anthropicCurrentLogin")));
});

test("a pool entry drawn as its own account row leaves the provider's pool line", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "anthropic", provider: "claude", title: "Claude", accounts: [current] },
  ] } : {}, {
    providers: connected, claude: { accounts: [{ id: "current", quota: {} }] },
    credentials: { claude: [{ id: "current", label: "Current Claude session", state: "ready" }, { id: "x", label: "Stored", state: "cooling", cooldownSeconds: 90 }] },
  });
  await ui.refresh();
  const header = ui.card.children[0]!.children[0]!;
  assert.doesNotMatch(text(header), new RegExp(`${t("providers.anthropicCurrentLogin")}: `), "the login's state is not repeated above its own row");
  assert.ok(text(header).includes(`Stored: ${t("pool.cooling", { seconds: 90 })}`), "an account with no row keeps its line");
});

test("every dashboard language names the limit windows, freshness and resets", () => {
  const keys = ["active", "stale", "fiveHour", "weekly", "resetUnknown", "resetsIn", "resetsAt", "fetchedAt", "notFetched"];
  for (const [lang, dict] of Object.entries(dictionaries)) {
    for (const key of keys) assert.ok(dict[`limits.${key}`], `${lang}: limits.${key}`);
    assert.match(dict["limits.resetsIn"]!, /\{hours\}/, lang);
    assert.match(dict["limits.resetsIn"]!, /\{minutes\}/, lang);
  }
});

test("ChatGPT figures join by account id, so a pause between the two reads moves no numbers", async () => {
  // The limits were read while "p" was in rotation; the status says it is paused now.
  const accounts = [
    { id: "a", label: "First", state: "ready" },
    { id: "p", label: "Paused now", state: "paused", paused: true },
    { id: "b", label: "Second", state: "ready" },
  ];
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "chatgpt", provider: "gpt", title: "GPT", accounts: [
      { account: 0, id: "a", at: now, windows: [five] },
      { account: 1, id: "p", at: now, windows: [weekly] },
      { account: 2, id: "b", label: "Second", at: now, windows: [{ ...weekly, used_percent: 40 }] },
    ] },
  ] } : {}, { providers: connected, chatgpt: { accounts: { gpt: accounts } } });
  await ui.refresh();
  const rows = findAll(ui.card.children[1]!, hasClass("limits-account"));
  assert.deepEqual(rows.map((row) => row.children[0]!.children[0]!.attrs.text), ["First", "Paused now", "Second"]);
  assert.match(text(rows[0]!), /23%/);
  assert.doesNotMatch(text(rows[1]!), /125%|40%|23%/, "a paused account takes no figures");
  assert.match(text(rows[2]!), /40%/);
  assert.doesNotMatch(text(rows[2]!), /23%|125%/, "the second account keeps its own figures, not the next position's");
});

test("an older limits read that lands after a newer status does not show an account the status removed or paused", async () => {
  // The read was taken while all four accounts were listed. The status read after it has the login paused
  // (the status lists it as paused), "Work" removed, "Spare" in use, and "Held" listed as paused.
  const oldLimits = { providers: [{ type: "anthropic", provider: "claude", title: "Claude", accounts: [
    { ...current, inUse: false },
    { account: 1, id: "work", label: "Work", at: now, windows: [five] },
    { account: 2, id: "spare", label: "Spare", at: now, windows: [weekly] },
    { account: 3, id: "held", label: "Held", at: now, windows: [five] },
  ] }] };
  let statusNow: Record<string, unknown> = { providers: connected, claude: { accounts: [
    { id: "current", quota: {} }, { id: "work", label: "Work", quota: {} }, { id: "spare", label: "Spare", quota: {} }, { id: "held", label: "Held", quota: {} },
  ] } };
  let limitsReply: Promise<unknown> = Promise.resolve(oldLimits);
  const ui = limitsUi(async (path) => path === "/api/status" ? statusNow : limitsReply, {});
  await ui.refresh();
  assert.equal(findAll(ui.card, hasClass("limits-account")).length, 4);

  // The router's real shape: a paused login and a paused account keep their rows with no figures and paused: true.
  statusNow = { providers: connected, claude: { accounts: [
    { id: "current", label: "Current Claude login", quota: {}, paused: true },
    { id: "spare", label: "Spare", quota: {}, inUse: true },
    { id: "held", label: "Held", quota: {}, paused: true },
  ] } };
  const names = () => findAll(ui.card, hasClass("limits-account")).map((row) => row.children[0]!.children[0]!.attrs.text);
  // The status draws at once, before the limits read from the older poll lands.
  let release: (value: unknown) => void = () => {};
  limitsReply = new Promise((resolve) => { release = resolve; });
  await ui.refreshHealth();
  assert.deepEqual(names(), ["Spare"], "the removed, paused and signed-out accounts are gone at once");
  assert.equal(findAll(ui.card, (node) => node.attrs.text === t("limits.active")).length, 1);
  // The older read lands: it still lists them, and must not bring them back.
  release(oldLimits);
  await ui.settleLimits();
  assert.deepEqual(names(), ["Spare"]);
  assert.equal(findAll(ui.card, (node) => node.attrs.text === t("limits.active")).length, 1, "Active follows the status, not the older read");
  assert.doesNotMatch(text(ui.card), /Work|Held|Current Claude login/);
  assert.match(text(ui.card.children[0]!), /125%/, "the account that stayed keeps its own figures");
});

test("a ChatGPT provider saved with limits off keeps its quota text, before the config loads or after", async () => {
  const statusNow = {
    providers: { ...connected, gpt: { type: "chatgpt", reachable: true } },
    chatgpt: { quota: { gpt: { rate_limits: { primary: five } } }, accounts: { gpt: [{ id: "a", label: "First", state: "ready" }] } },
  };
  for (const config of [null, { providers: { gpt: { type: "chatgpt", limits: false } } }]) {
    // The router lists no limits for a provider saved with limits off, and status does not say it has them.
    const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [] } : statusNow, {}, config);
    await ui.refresh();
    assert.equal(findAll(ui.card, hasClass("limits-account")).length, 0, JSON.stringify(config));
    assert.ok(text(ui.card).includes(t("health.quota", { percent: 23, reset: "" })), JSON.stringify(config));
    assert.doesNotMatch(text(ui.card), /No usage snapshot yet/);
  }
});

test("a Claude login saved with limits off keeps its usage lines before the config loads", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [] } : {
    providers: { ...connected, claude: { type: "anthropic", reachable: true, authSource: "observed" } },
    claude: { accounts: [{ id: "current", quota: { rate_limits: { primary: five } } }] },
  }, {}, null);
  await ui.refresh();
  assert.equal(findAll(ui.card, hasClass("limits-account")).length, 0);
  assert.match(text(ui.card.children[0]!), /23%/);
});

test("a Claude account whose refresh was refused says its figures are stale, and only that account's", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "anthropic", provider: "claude", title: "Claude", accounts: [
      { ...current, stale: true },
      { account: 1, label: "Fresh", at: now, windows: [five] },
    ] },
  ] } : {}, { providers: connected });
  await ui.refresh();
  const rows = findAll(ui.card.children[0]!, hasClass("limits-account"));
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]!), /Stale/);
  assert.match(text(rows[0]!), /23%/, "the last reading stays on the gauge");
  assert.doesNotMatch(text(rows[1]!), /Stale/);
});

test("the status draws at once and the gauges follow when the limits read lands, without clearing them meanwhile", async () => {
  const paths: string[] = [];
  const claudeLimits = { providers: [{ type: "anthropic", provider: "claude", title: "Claude", accounts: [current] }] };
  let reply: Promise<unknown> | null = null;
  const ui = limitsUi(async (path) => {
    paths.push(path);
    if (path === "/api/status") return {};
    return reply ?? claudeLimits;
  }, { providers: connected, claude: { accounts: [{ id: "current", quota: { rate_limits: { primary: five } } }] } });
  let release: (value: unknown) => void = () => {};
  reply = new Promise((resolve) => { release = resolve; });
  await ui.refreshHealth();
  assert.equal(findAll(ui.card, hasClass("provider-block")).length, 0, "no gauges until the limits land");
  assert.match(text(ui.card), /23%/, "the status lines are already drawn");
  await ui.refreshHealth();
  assert.equal(paths.filter((path) => path === "/api/limits").length, 1, "a poll does not start a second read behind a slow one");
  release(claudeLimits);
  await ui.settleLimits();
  assert.equal(findAll(ui.card, hasClass("provider-block")).length, 1);
  reply = new Promise(() => {});
  await ui.refreshHealth();
  assert.equal(findAll(ui.card, hasClass("provider-block")).length, 1, "a poll keeps the gauges it already shows");
  assert.match(text(ui.card), /Current Claude login.*23%/);
});

test("a cooling or quarantined Claude account keeps its line beside the gauges", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "anthropic", provider: "claude", title: "Claude", accounts: [current] },
  ] } : {}, {
    providers: connected, claude: { accounts: [{ id: "current", quota: { rate_limits: { primary: five } } }] },
    credentials: { claude: [{ id: "x", label: "Stored", state: "cooling", cooldownSeconds: 90 }, { id: "y", label: "Bad", state: "quarantined" }] },
  });
  await ui.refresh();
  assert.equal(findAll(ui.card, hasClass("provider-block")).length, 1);
  assert.ok(text(ui.card.children[0]!).includes(`Stored: ${t("pool.cooling", { seconds: 90 })}`));
  assert.ok(text(ui.card.children[0]!).includes(`Bad: ${t("pool.quarantined")}`));
});

test("a gauge's pace and exhaust forecast read as the mod's pane reads them", () => {
  const ui = limitsUi(async () => ({}));
  const pace = (percent: number) => t("limits.paceProjected", { percent });
  const node = (row: Element, value: string) => findAll(row, (candidate) => candidate.attrs.text === value)[0];
  const row = (window: Record<string, unknown>) => ui.limitsWindowRow("5 hours", { usedPercent: 40, resetAt: now + 255 * 60_000, ...window }, now);
  // Under 95 the label is muted; 95 to 100 is amber; above 100 says nothing.
  assert.equal(node(row({ projectedPercent: 84 }), pace(84))!.attrs.class, undefined);
  assert.equal(node(row({ projectedPercent: 95 }), pace(95))!.attrs.class, "warn-text");
  assert.equal(node(row({ projectedPercent: 100 }), pace(100))!.attrs.class, "warn-text");
  assert.equal(node(row({ projectedPercent: 101 }), pace(101)), undefined);
  // Nothing without a reset still ahead, or without a projection.
  assert.equal(findAll(row({ projectedPercent: 84, resetAt: now - 1 }), (candidate) => candidate.attrs.text === pace(84)).length, 0);
  assert.equal(findAll(row({ projectedPercent: 84, resetAt: undefined }), (candidate) => candidate.attrs.text === pace(84)).length, 0);
  assert.equal(findAll(row({ projectedPercent: undefined }), (candidate) => candidate.attrs.text === pace(84)).length, 0);
  // A passed reset keeps its last share, so the foot says it is stale.
  assert.equal(node(row({ resetAt: now - 1 }), t("limits.stale"))!.attrs.class, "warn-text");
  // An exhaust forecast replaces the pace with a warning line: amber, red within the hour.
  const exhaustNote = (usedPercent: number, minutes: number) => row({ usedPercent, projectedPercent: 120, exhaustAt: now + minutes * 60_000 });
  const later = exhaustNote(90, 130);
  assert.equal(node(later, pace(120)), undefined, "no pace beside an exhaust forecast");
  assert.equal(node(later, t("limits.exhaust", { time: "2h 10m" }))!.attrs.class, "limits-window-note warn-text");
  assert.equal(node(exhaustNote(50, 30), t("limits.exhaust", { time: "30m" }))!.attrs.class, "limits-window-note bad-text");
  // The exhaust moment has passed: no warning, and the pace may return.
  assert.equal(findAll(row({ projectedPercent: 84, exhaustAt: now - 1 }), (candidate) => candidate.attrs.text === pace(84)).length, 1);
});

test("each gauge's accessible name says which account it measures", () => {
  const ui = limitsUi(async () => ({}));
  const row = ui.limitsAccountRow({ type: "anthropic", title: "Claude" }, { account: 1, label: "Work", at: now, windows: [five, weekly] }, now);
  const names = findAll(row, (candidate) => candidate.attrs.role === "progressbar").map((bar) => bar.attrs["aria-label"]);
  assert.deepEqual(names, [`Work · ${t("limits.fiveHour")}`, `Work · ${t("limits.weekly")}`]);
  assert.deepEqual(names, ["Work · 5-hour", "Work · Weekly"], "the English names are the mod's");
});

test("no countdown reads 0 or less: a passed reset says so, and a cooled-off cooling account shows no countdown", () => {
  const ui = limitsUi(async () => ({}));
  // Just before, at, and just after the reset: the countdown is never "0h 0m", and a passed reset has its wording.
  for (const offset of [-60_000, -1, 0, 1, 59_999]) {
    const row = ui.limitsWindowRow("5 hours", { usedPercent: 40, resetAt: now + offset }, now);
    assert.doesNotMatch(text(row), /resets in 0h 0m/, `offset ${offset}`);
    assert.equal(findAll(row, (node) => node.attrs.text === t("limits.passed", { date: new Date(now + offset).toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) })).length, offset <= 0 ? 1 : 0, `offset ${offset}`);
  }
  // A cooling account whose countdown has run out names no "0s" countdown.
  const row = ui.limitsAccountRow({ type: "chatgpt", title: "GPT" }, { account: 0, id: "a", label: "Cooled", state: "cooling", cooldownSeconds: 0, at: now, windows: [] }, now);
  assert.doesNotMatch(text(row), /available again in/);
  const cooling = ui.limitsAccountRow({ type: "chatgpt", title: "GPT" }, { account: 0, id: "a", label: "Cooling", state: "cooling", cooldownSeconds: 90, at: now, windows: [] }, now);
  assert.match(text(cooling), /available again in/);
});

test("the pace and exhaust wording and the time units are the mod's, verbatim in every language", () => {
  const modSource = fs.readFileSync(path.join(uiDir, "../mod/hooks/i18n.ts"), "utf8");
  const keys = ["limits.paceProjected", "limits.exhaust", "limits.passed", "units.minutes", "units.hours", "units.days", "units.hourMin", "units.dayHour"];
  const blocks: Record<string, string> = { en: "const EN = {", ko: "const KO: Record", zh: "const ZH: Record", ja: "const JA: Record", es: "const ES: Record", pt: "const PT: Record" };
  for (const [lang, marker] of Object.entries(blocks)) {
    const start = modSource.indexOf(marker);
    assert.ok(start > 0, `the mod's i18n has ${marker}`);
    const body = modSource.slice(start, modSource.indexOf("\n}", start));
    for (const key of keys) {
      const match = body.match(new RegExp(`'${key.replaceAll(".", "\\.")}': '([^']*)'`));
      assert.ok(match, `${lang} ${key} in the mod`);
      assert.equal(dictionaries[lang]![key], match[1], `${lang} ${key} matches the mod`);
    }
  }
});

test("every window the router reports gets a gauge, a scoped one named by its label as the mod names it", async () => {
  const fable = { kind: "scoped", label: "Fable", used_percent: 6, window_minutes: 10080, reset_at: (now + 86400_000) / 1000 };
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "anthropic", provider: "claude", title: "Claude", accounts: [{ account: 0, id: "current", at: now, windows: [weekly, fable] }] },
  ] } : {}, { providers: connected, claude: { accounts: [{ id: "current", quota: {} }] } });
  await ui.refresh();
  const row = ui.card.children[0]!;
  const bars = findAll(row, (node) => node.attrs.role === "progressbar").map((bar) => bar.attrs["aria-label"]);
  assert.deepEqual(bars, [`${t("providers.anthropicCurrentLogin")} · ${t("limits.weekly")}`, `${t("providers.anthropicCurrentLogin")} · Fable`]);
  assert.match(text(row), /Fable.*6%/);
  assert.equal(findAll(row, (node) => node.attrs.text === "5-hour").length, 0, "no 5-hour window is invented for a login that reports none");
});

test("a window the router did not report is not drawn, so one reported weekly window is one gauge", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "chatgpt", provider: "gpt", title: "GPT", accounts: [{ account: 0, id: "a", label: "First", at: now, windows: [weekly] }] },
  ] } : {}, { providers: connected, chatgpt: { accounts: { gpt: [{ id: "a", label: "First", state: "ready" }] } } });
  await ui.refresh();
  const row = ui.card.children[1]!;
  assert.equal(findAll(row, hasClass("limits-window")).length, 1);
  assert.doesNotMatch(text(row), /5-hour/);
  assert.doesNotMatch(text(row), /Unknown/);
});

test("a paused account keeps its row with its state and no gauges, even when the read still holds its windows", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "chatgpt", provider: "gpt", title: "GPT", accounts: [{ account: 0, id: "p", at: now, windows: [five, weekly] }] },
  ] } : {}, { providers: connected, chatgpt: { accounts: { gpt: [{ id: "p", label: "Paused now", state: "paused", paused: true }] } } });
  await ui.refresh();
  const row = findAll(ui.card.children[1]!, hasClass("limits-account"))[0]!;
  assert.equal(findAll(row, hasClass("limits-windows")).length, 0);
  assert.equal(findAll(row, (node) => node.attrs.role === "progressbar").length, 0);
  assert.ok(text(row).includes(t("providers.chatgptPaused")));
});

test("the Claude login is named in the dashboard's language, whatever label the router sent", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "anthropic", provider: "claude", title: "Claude", accounts: [{ account: 0, id: "current", label: "Current Claude session", at: now, windows: [weekly] }] },
  ] } : {}, { providers: connected, claude: { accounts: [{ id: "current", label: "Current Claude session", quota: {} }] } });
  await ui.refresh();
  const names = findAll(ui.card, hasClass("limits-account-head")).map((head) => head.children[0]!.attrs.text);
  assert.deepEqual(names, [t("providers.anthropicCurrentLogin")]);
  assert.doesNotMatch(text(ui.card), /Current Claude session/);
});

test("the windows read as a table that folds on a narrow card, never a fixed pair of window columns", () => {
  const css = fs.readFileSync(path.join(uiDir, "style.css"), "utf8");
  const rule = css.match(/\.limits-windows \{([^}]*)\}/);
  assert.ok(rule, "the window grid has its rule");
  // A line per window: name, bar, figure, reset — the columns line up across accounts.
  assert.match(rule[1]!, /grid-template-columns: [\d.]+em minmax\(48px, 1fr\) minmax\(4em, max-content\) minmax\(0, [\d.]+fr\)/);
  assert.doesNotMatch(rule[1]!, /repeat\(2/, "no fixed two-column grid is left in the window grid");
  // On a narrow card (the provider's own width, not the window's) the reset drops under the bar.
  const narrow = css.match(/@container \(max-width: 780px\) \{([\s\S]*?)\n\}/);
  assert.ok(narrow, "the narrow card has its rules");
  assert.match(narrow[1]!, /\.limits-window-foot \{ grid-column: 2 \/ -1; \}/);
  assert.match(css, /\.provider-limits \{[^}]*container-type: inline-size/);
});

test("the 5-hour and weekly window names are the mod's, verbatim in every language", () => {
  const modSource = fs.readFileSync(path.join(uiDir, "../mod/hooks/i18n.ts"), "utf8");
  const blocks: Record<string, string> = { en: "const EN = {", ko: "const KO: Record", zh: "const ZH: Record", ja: "const JA: Record", es: "const ES: Record", pt: "const PT: Record" };
  for (const [lang, marker] of Object.entries(blocks)) {
    const start = modSource.indexOf(marker);
    assert.ok(start > 0, `the mod's i18n has ${marker}`);
    const body = modSource.slice(start, modSource.indexOf("\n}", start));
    for (const [guiKey, modKey] of [["limits.fiveHour", "band.fiveHour"], ["limits.weekly", "band.weekly"]] as const) {
      const match = body.match(new RegExp(`'${modKey.replaceAll(".", "\\.")}': '([^']*)'`));
      assert.ok(match, `${lang} ${modKey} in the mod`);
      assert.equal(dictionaries[lang]![guiKey], match[1], `${lang} ${guiKey} matches the mod's ${modKey}`);
    }
  }
});

test("the pool line names the Claude login and an unnamed Claude account in the dashboard's language", async () => {
  const ui = limitsUi(async () => ({}), {
    providers: connected,
    credentials: { claude: [{ id: "current", label: "Current Claude session", state: "ready", failures: 0 }, { id: "stored", label: "Claude account", state: "ready", failures: 0 }] },
  });
  await ui.refresh();
  assert.ok(text(ui.card.children[0]!).includes(`${t("providers.anthropicCurrentLogin")}: ${t("pool.ready")}`));
  assert.ok(text(ui.card.children[0]!).includes(`${t("providers.claudeAccountDefault")}: ${t("pool.ready")}`));
  assert.doesNotMatch(text(ui.card), /Current Claude session/, "the router's login label is not shown");
});

test("a provider's exhaustion names its reason in the dashboard's language, not the router's word", async () => {
  const ui = limitsUi(async () => ({}), { providers: { ...connected, gpt: { reachable: true, exhaustion: { reason: "billing_exhausted", until: now + 3_600_000 } } } });
  await ui.refresh();
  assert.ok(text(ui.card.children[1]!).includes(t("providerStatus.billingExhausted")));
  assert.doesNotMatch(text(ui.card), /billing_exhausted/);
});

test("the exhaustion reasons are the mod's words: Korean and English verbatim, the other languages keep the mod's English", () => {
  const modSource = fs.readFileSync(path.join(uiDir, "../mod/hooks/workers.ts"), "utf8");
  const reasons = [...modSource.matchAll(/insufficient_balance: '([^']*)', billing_exhausted: '([^']*)', quota_exhausted: '([^']*)'/g)];
  assert.equal(reasons.length, 2, "the mod's reason labels are Korean, then English");
  const [ko, en] = reasons.map((match) => match.slice(1));
  const keys = ["providerStatus.insufficientBalance", "providerStatus.billingExhausted", "providerStatus.quotaExhausted"];
  keys.forEach((key, index) => {
    assert.equal(dictionaries.ko![key], ko![index], `ko ${key}`);
    // The mod words these in Korean and English only; the other languages carry the mod's English, as the mod's pane does.
    for (const lang of ["en", "zh", "ja", "es", "pt"]) assert.equal(dictionaries[lang]![key], en![index], `${lang} ${key}`);
  });
  const fallback = modSource.match(/'(현재 사용 불가)' : '(currently unavailable)'/);
  assert.ok(fallback, "the mod's unavailable wording");
  assert.equal(dictionaries.ko!["providerStatus.unavailable"], fallback[1]);
  assert.equal(dictionaries.en!["providerStatus.unavailable"], fallback[2]);
});

test("every provider the read lists gets its gauges, whatever its type: OpenCode Go's 30-day window and Gemini's accounts", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "opencode-go", provider: "other", title: "Go", accounts: [{ account: 0, at: now, windows: [{ kind: "window", used_percent: 93, window_minutes: 43200, reset_at: (now + 86400_000) / 1000, exhaust_at: (now + 130 * 60_000) / 1000 }] }] },
    { type: "google", provider: "gem", title: "Gemini", accounts: [
      { account: 0, id: "g1", label: "work@example.test", inUse: true, at: now, windows: [
        { kind: "five_hour", used_percent: 12, window_minutes: 300, reset_at: (now + 3_600_000) / 1000 },
        { kind: "scoped", label: "Argon weekly", used_percent: 40, window_minutes: 10080, reset_at: (now + 86400_000) / 1000 },
      ] },
    ] },
  ] } : {}, { providers: { ...connected, gem: { reachable: true } } }, {
    providers: { claude: { type: "anthropic", auth: "claude-code" }, gpt: { type: "chatgpt" }, other: { type: "openai-compatible" }, gem: { type: "google", auth: "antigravity" } },
  });
  await ui.refresh();
  const blocks = findAll(ui.card, hasClass("provider-block"));
  assert.equal(blocks.length, 2, "OpenCode Go and Gemini each have their gauges");
  const go = blocks[0]!;
  assert.equal(findAll(go, (node) => node.attrs.role === "progressbar").length, 1);
  assert.match(text(go), /30d/, "a 43200-minute window is named by its span, as the mod does");
  assert.match(text(go), /93%/);
  assert.ok(text(go).includes(t("limits.exhaust", { time: "2h 10m" })), "an exhaust forecast reads as the mod's pane reads it");
  const gemini = blocks[1]!;
  assert.deepEqual(findAll(gemini, (node) => node.attrs.role === "progressbar").map((bar) => bar.attrs["aria-label"]), ["work@example.test · 5-hour", "work@example.test · Argon weekly"]);
  assert.match(text(gemini), /Active/);
  assert.match(text(gemini), /Argon weekly.*40%/);
});

test("a provider that needs a sign-in shows its text line and no gauges, even while the read still holds its windows", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "google", provider: "gem", title: "Gemini", accounts: [{ account: 0, id: "g1", at: now, windows: [five] }] },
  ] } : {}, { providers: { gem: { reachable: true, needsLogin: true } } }, { providers: { gem: { type: "google", auth: "antigravity" } } });
  await ui.refresh();
  assert.equal(findAll(ui.card, hasClass("provider-block")).length, 0);
  assert.ok(text(ui.card).includes(t("providerStatus.loginNeeded")));
});
