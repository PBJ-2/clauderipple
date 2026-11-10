import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Status (the Health screen's provider list) run from the dashboard's own source: the poll (refreshHealth)
// and the render (renderHealthProviders). The DOM and the API are stand-ins. The router's live provider list
// is the one the test changes between polls, the way a provider added or removed elsewhere would change it.

const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
function block(from: string, to: string): string {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  if (start < 0 || end <= start) throw new Error(`missing UI block: ${from}`);
  return source.slice(start, end);
}

type LiveProvider = { type: string; reachable: boolean; usable: boolean; needsLogin?: boolean };
type SavedProvider = { type: string; label?: string; auth?: string };

class Node {
  readonly tag: string;
  readonly attrs: Record<string, string> = {};
  text = "";
  children: Node[] = [];
  style: Record<string, string> = {};
  tabIndex = -1;
  readonly listeners = new Map<string, unknown[]>();
  constructor(tag: string) { this.tag = tag; }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  addEventListener(name: string, listener: unknown) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
}
function textOf(node: Node): string {
  return node.text + node.children.map(textOf).join("");
}
function findByClass(node: Node, cls: string): Node | undefined {
  if ((node.attrs.class ?? "").split(" ").includes(cls)) return node;
  for (const child of node.children) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return undefined;
}

function harness() {
  const boxes = new Map<string, Node>();
  const live: { providers: Record<string, LiveProvider> } = { providers: {} };
  const saved: { providers: Record<string, SavedProvider> } = { providers: {} };
  const configReads: string[] = [];
  // A config read can be held open, so the test sees the list before the config has arrived.
  let holding = false;
  let openGate: () => void = () => {};

  const el = (tag: string, attrs: Record<string, unknown> | null, children?: unknown[]): Node => {
    const node = new Node(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (key === "text") node.text = String(value);
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null) node.attrs[key] = String(value);
    }
    for (const child of children ?? []) {
      if (child === null || child === undefined) continue;
      node.children.push(child instanceof Node ? child : Object.assign(new Node("#text"), { text: String(child) }));
    }
    return node;
  };
  const $ = (selector: string): Node => {
    const id = selector.replace(/^#/, "");
    let node = boxes.get(id);
    if (!node) { node = new Node("div"); node.attrs.id = id; boxes.set(id, node); }
    return node;
  };
  const api = async (path: string): Promise<unknown> => {
    if (path === "/api/status") return structuredClone({ settings: { pointsAtRouter: true }, stats: {}, providers: live.providers });
    if (path === "/api/config") {
      configReads.push(path);
      if (holding) await new Promise<void>(done => { openGate = done; });
      return structuredClone({ providers: saved.providers });
    }
    throw new Error(`unexpected request ${path}`);
  };
  const make = new Function("$", "el", "api", "t", "hint", "cell", "offline", "APP", `
    let status = null;
    let currentConfig = null;
    let chatgptLoginMessage = "";
    let loadedUiRevision = null;
    let clientsLoaded = false;
    const modState = { settings: null };
    const updateState = { check: null };
    const limitsSnapshot = null;
    const providerTitle = (name, provider) => (provider && provider.label) || name;
    const providerHue = () => "#000";
    const providerDisplayName = (name, provider) => providerTitle(name, provider);
    const providerState = () => el("span", null);
    const providerLimits = () => null;
    const quotaLine = () => null;
    const credentialLine = () => null;
    const limitsAccountRow = () => el("div", null);
    const chevronIcon = () => el("span", null);
    const chatgptLoginButton = () => el("button", null);
    const openProvider = () => {};
    const refreshLimits = () => {};
    const setRouterDown = () => {};
    const renderDiagnostics = () => {};
    const renderClients = () => {};
    const renderModNotice = () => {};
    const modRedraw = () => {};
    const versionRow = () => el("div", null);
    const autoUpdateRow = () => el("div", null);
    const priorityRow = () => el("div", null);
    const badge = (kind, text) => el("span", { text });
    ${block("async function refreshHealth()", "// ---- Diagnostics")}
    ${block("function providerNamesStale()", "let statusModBusy")}
    return {
      refreshHealth, renderHealthProviders, providerNamesStale, refreshProviderConfig,
      readConfig: () => currentConfig,
      pendingConfigRead: () => providerConfigRead,
    };
  `) as (...args: unknown[]) => {
    refreshHealth: () => Promise<void>;
    renderHealthProviders: () => void;
    providerNamesStale: () => boolean;
    refreshProviderConfig: () => Promise<void>;
    readConfig: () => { providers: Record<string, SavedProvider> } | null;
    pendingConfigRead: () => Promise<void> | null;
  };
  const ui = make($, el, api, (key: string) => key, (text: string) => el("p", { class: "hint", text }), (label: unknown, value: unknown, _sub: unknown, extraClass: string) =>
    el("div", { class: extraClass }, [typeof label === "string" ? el("span", { text: label }) : label as Node, ...(Array.isArray(value) ? value : [value]) as Node[]]),
    () => false, null);

  return {
    ui, live, saved, configReads,
    /** One five-second poll: the status arrives, the list redraws, and a stale config is read again. */
    poll: async () => { await ui.refreshHealth(); },
    hold: () => { holding = true; },
    release: () => { holding = false; openGate(); },
    /** The provider names drawn on Status, in order, as the reader sees them. */
    titles: () => {
      const box = $("#health-providers");
      return box.children.map(row => textOf(findByClass(row, "provider-title") ?? new Node("none")));
    },
    settle: async () => { await ui.pendingConfigRead(); },
  };
}

test("Status shows the router's live providers at startup and keeps them after the poll", async () => {
  const h = harness();
  h.saved.providers = { a: { type: "anthropic", label: "Work Claude" } };
  h.live.providers = { a: { type: "anthropic", reachable: true, usable: true } };
  await h.ui.refreshProviderConfig();
  await h.poll();
  assert.deepEqual(h.titles(), ["Work Claude"], "the label the config gives is kept as the name");
  await h.settle();
  assert.equal(h.configReads.length, 1, "the startup read is the only read while the list agrees");
});

test("a provider added elsewhere appears on the next poll, and the config is read again for its name", async () => {
  const h = harness();
  h.saved.providers = { a: { type: "anthropic" } };
  h.live.providers = { a: { type: "anthropic", reachable: true, usable: true } };
  await h.ui.refreshProviderConfig();
  await h.poll();
  assert.deepEqual(h.titles(), ["a"]);

  // Added in another window or the CLI: the router lists it, and the config this page holds does not yet.
  h.saved.providers = { a: { type: "anthropic" }, b: { type: "chatgpt", label: "Team GPT" } };
  h.live.providers = { a: { type: "anthropic", reachable: true, usable: true }, b: { type: "chatgpt", reachable: true, usable: true } };
  h.hold();
  await h.poll();
  assert.deepEqual(h.titles(), ["a", "b"], "the new provider is drawn at once, from the live list");
  h.release();
  await h.settle();
  assert.equal(h.configReads.length, 2, "the names disagree, so the config was read again");
  assert.deepEqual(h.titles(), ["a", "Team GPT"], "the config's label now names it");
});

test("a provider removed elsewhere disappears on the next poll, even while the config still has it", async () => {
  const h = harness();
  h.saved.providers = { a: { type: "anthropic" }, b: { type: "chatgpt" } };
  h.live.providers = { a: { type: "anthropic", reachable: true, usable: true }, b: { type: "chatgpt", reachable: true, usable: true } };
  await h.ui.refreshProviderConfig();
  await h.poll();
  assert.deepEqual(h.titles(), ["a", "b"]);

  // Removed elsewhere. The config this page holds still names a until it is read again; Status must not keep it.
  delete h.live.providers.a;
  delete h.saved.providers.a;
  h.hold();
  await h.poll();
  assert.deepEqual(h.titles(), ["b"], "the removed provider is gone at once, while the config still has it");
  h.release();
  await h.settle();
  assert.equal(h.ui.readConfig()?.providers.a, undefined, "the config read after it names only the providers the router lists");
  assert.deepEqual(h.titles(), ["b"]);
});
