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
  limitsWindowRow(label: string, window: unknown, weekly: boolean, now: number): Element;
  limitsUsageWindow(account: unknown, kind: string): unknown;
};
function limitsUi(api: (path: string) => Promise<unknown>, status: Record<string, unknown> = {}) {
  const card = el("div"), desktop = el("div");
  const build = new Function("api", "el", "t", "$", "status", `
    const currentConfig = { providers: { claude: { type: "anthropic", auth: "claude-code" }, gpt: { type: "chatgpt" }, other: { type: "openai-compatible" } } };
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
    return { refreshHealth, renderHealthProviders, limitsAccountRow, limitsWindowRow, limitsUsageWindow };
  `) as (...args: unknown[]) => LimitsUi;
  const ui = build(async (path: string) => {
    const response = await api(path);
    return path === "/api/status" ? { settings: {}, ...status, ...(response && typeof response === "object" ? response : {}) } : response;
  }, el, t, (selector: string) => selector === "#health-providers" ? card : selector === "#health-desktop" ? desktop : el("div"), status);
  return { ...ui, card, desktop, refresh: () => ui.refreshHealth() };
}
const now = Date.parse("2026-10-21T12:00:00Z");
const five = { kind: "five_hour", used_percent: 23, window_minutes: 300, reset_at: (now + 255 * 60_000) / 1000 };
const weekly = { kind: "seven_day", used_percent: 125, window_minutes: 10080, reset_at: (now + 86400_000) / 1000 };
const current = { account: 0, inUse: true, at: now, windows: [weekly, five] };
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
    { type: "chatgpt", provider: "gpt", title: "GPT", accounts: [{ account: 2, at: now, windows: [weekly] }, current] },
  ] } : {}, { providers: connected, chatgpt: { accounts: { gpt: accounts } } });
  await ui.refresh();
  const rows = findAll(ui.card.children[1]!, hasClass("limits-account"));
  assert.deepEqual(rows.map((row) => row.children[0]!.children[0]!.attrs.text), ["First", "Paused", "Expired", "waiting@example.test", "Last"]);
  assert.match(text(rows[0]!), /23%/);
  assert.match(text(rows[1]!), /Paused/);
  assert.match(text(rows[2]!), /Sign in again/);
  for (const row of rows.slice(1, 4)) {
    assert.equal(findAll(row, (node) => node.attrs.text === "Unknown").length, 2);
    assert.match(text(row), /No usage snapshot yet/);
    assert.doesNotMatch(text(row), /23%|125%/);
  }
  assert.match(text(rows[4]!), /125%/);
  assert.match(text(rows[4]!), /Stale/);
  assert.match(text(rows[4]!), /available again in/);
});

test("Claude renders only limits entries, preserving their labels, order and active account", async () => {
  const ui = limitsUi(async (path) => path === "/api/limits" ? { providers: [
    { type: "anthropic", provider: "claude", title: "Claude", accounts: [{ account: 2, label: "Preferred", at: now, windows: [five], inUse: true }, { ...current, inUse: false }] },
  ] } : {}, { providers: connected, claude: { accounts: [{ id: "unread", label: "Unread" }] } });
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

test("a failed limit read falls back to the old lines, including after a successful read", async () => {
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
  for (const failed of [true, false, true]) {
    fail = failed;
    await ui.refresh();
    assert.equal(findAll(ui.card, hasClass("provider-block")).length, failed ? 0 : 1);
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
  assert.equal(findAll(row, hasClass("unknown")).length, 4);
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

test("window bars expose true percentages, reset times and unknown windows", () => {
  const ui = limitsUi(async () => ({}));
  const window = ui.limitsUsageWindow({ windows: [weekly, five] }, "five_hour");
  assert.deepEqual(window, { usedPercent: 23, resetAt: now + 255 * 60_000 });
  const row = ui.limitsWindowRow("5 hours", window, false, now);
  assert.match(text(row), /resets in 4h 15m/);
  const week = ui.limitsWindowRow("Weekly", { usedPercent: 125, resetAt: now + 86400_000 }, true, now);
  const bar = findAll(week, (node) => node.attrs.role === "progressbar")[0]!;
  assert.equal(bar.attrs["aria-valuenow"], 100);
  assert.match(String(bar.attrs["aria-valuetext"]), /125%/);
  assert.equal(findAll(week, hasClass("limits-fill"))[0]!.style.width, "100%");
  assert.ok(text(week).includes(t("limits.resetsAt", { time: new Date(now + 86400_000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }) })));
  for (const window of [null, { usedPercent: Number.NaN }]) {
    const missing = ui.limitsWindowRow("Weekly", window, true, now);
    assert.match(text(missing), /Unknown.*Reset time unknown/);
    assert.equal(findAll(missing, hasClass("unknown")).length, 1);
    assert.equal(findAll(missing, hasClass("limits-fill")).length, 0);
    assert.equal(findAll(missing, (node) => node.attrs.role === "progressbar")[0]!.attrs["aria-valuenow"], undefined);
  }
  assert.match(text(ui.limitsWindowRow("5 hours", { usedPercent: 0, resetAt: now - 1 }, false, now)), /0%.*resets in 0h 0m/);
  assert.match(text(ui.limitsWindowRow("Weekly", { usedPercent: 5 }, true, now)), /5%.*Reset time unknown/);
});

test("an account label stays text and its timestamp is the figures' time", () => {
  const ui = limitsUi(async () => ({}));
  const row = ui.limitsAccountRow({ type: "chatgpt", title: "GPT" }, { ...current, label: "<img src=x onerror=alert(1)>" }, now);
  assert.match(text(row), /<img src=x/);
  assert.equal(findAll(row, (node) => node.tag === "img").length, 0);
  assert.ok(text(row).includes(t("limits.fetchedAt", { time: new Date(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }) })));
});

test("every dashboard language names the limit windows, freshness and resets", () => {
  const keys = ["active", "stale", "fiveHour", "weekly", "unknown", "resetUnknown", "resetsIn", "resetsAt", "fetchedAt", "notFetched"];
  for (const [lang, dict] of Object.entries(dictionaries)) {
    for (const key of keys) assert.ok(dict[`limits.${key}`], `${lang}: limits.${key}`);
    assert.match(dict["limits.resetsIn"]!, /\{hours\}/, lang);
    assert.match(dict["limits.resetsIn"]!, /\{minutes\}/, lang);
  }
});
