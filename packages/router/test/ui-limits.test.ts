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
  addEventListener() {}
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
  limitsAccountRow(entry: unknown, account: unknown, now: number): Element;
  limitsWindowRow(label: string, window: unknown, now: number, accountName?: string): Element;
  limitsUsageWindow(window: unknown): unknown;
  settleLimits(): Promise<unknown>;
  providerLimits(name: string): { accounts: Record<string, unknown>[] } | null;
  limitsSnapshotPeek(): unknown;
};
const defaultConfig = { providers: { claude: { type: "anthropic", auth: "claude-code" }, gpt: { type: "chatgpt" }, other: { type: "openai-compatible" } } };
// `config` null is the screen before the config has loaded: the status alone names the providers.
function limitsUi(api: (path: string) => Promise<unknown>, status: Record<string, unknown> = {}, config: Record<string, unknown> | null = defaultConfig) {
  const card = el("div"), desktop = el("div");
  const build = new Function("api", "el", "t", "$", "status", "config", `
    let currentConfig = config;
    const stateFor = () => null, chevronIcon = () => null, openProvider = () => {}, chatgptLoginButton = () => el("button", { text: "Sign in" }), chatgptLoginMessage = "", providerLabel = (name) => name;
    const APP = null, clientsLoaded = false, modState = {}, updateState = {}, renderDiagnostics = () => {}, modRedraw = () => {}, versionRow = () => null, autoUpdateRow = () => null, priorityRow = () => null;
    let loadedUiRevision = null;
    ${block("function badge(", "/** A titled group")}
    ${block("let limitsSnapshot = null;", "// ---- Diagnostics:")}
    ${block("function quotaLine(", "/**\n * One line a person can read")}
    ${block("function credentialLine(", "/**\n * One verdict")}
    ${block("function providerConnection(", "let statusModBusy")}
    ${block("function claudeAccountLabel(", '/** "5h 14%')}
    ${block("function chatgptQuotaText(", "async function patchChatgptAccount(")}
    return { refreshHealth, renderHealthProviders, limitsAccountRow, limitsWindowRow, limitsUsageWindow, settleLimits: () => limitsRead ?? Promise.resolve(), providerLimits, limitsSnapshotPeek: () => limitsSnapshot };
  `) as (...args: unknown[]) => LimitsUi;
  const ui = build(async (path: string) => {
    const response = await api(path);
    return path === "/api/status" ? { settings: {}, ...status, ...(response && typeof response === "object" ? response : {}) } : response;
  }, el, t, (selector: string) => selector === "#health-providers" ? card : selector === "#health-desktop" ? desktop : el("div"), status, config);
  // A poll draws the status at once and the gauges when the limits read lands; tests wait for both.
  return { ...ui, card, desktop, refresh: async () => { await ui.refreshHealth(); await ui.settleLimits(); } };
}
// The render path reads the real clock, so the fixtures' resets must be ahead of it.
const now = Date.now();
const five = { kind: "five_hour", used_percent: 23, window_minutes: 300, reset_at: (now + 255 * 60_000) / 1000 };
const weekly = { kind: "seven_day", used_percent: 125, window_minutes: 10080, reset_at: (now + 86400_000) / 1000 };
const current = { id: "current", account: 0, inUse: true, at: now, windows: [weekly, five] };
const connected = { claude: { reachable: true }, gpt: { reachable: true }, other: { reachable: true } };

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
  assert.match(text(ui.card), /GPT 1/);
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
  assert.ok(text(row).includes(t("limits.fetchedAt", { time: new Date(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }) })));
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

test("the window grid wraps by the room the account has, never a fixed pair of columns", () => {
  const css = fs.readFileSync(path.join(uiDir, "style.css"), "utf8");
  const rule = css.match(/\.limits-windows \{([^}]*)\}/);
  assert.ok(rule, "the window grid has its rule");
  assert.match(rule[1]!, /grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 200px\), 1fr\)\)/);
  assert.doesNotMatch(rule[1]!, /repeat\(2/, "no fixed two-column grid is left in the window grid");
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
