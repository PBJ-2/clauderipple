import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Provider names where a person reads them, run from the dashboard's own source: the shared name helper
// (providerDisplayName), Status's provider rows (renderHealthProviders) and the Logs provider menu
// (renderProviderFilter). Two ChatGPT providers keyed "work" and "personal" must never read the same.

// Some block markers below span lines, and a Windows checkout (core.autocrlf) ends lines with CRLF.
const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function block(from: string, to: string): string {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  if (start < 0 || end <= start) throw new Error(`missing UI block: ${from}`);
  return source.slice(start, end);
}

type Entry = { type: string; label?: string; preset?: string; url?: string };
type Live = { type: string; reachable: boolean; usable: boolean };

class Node {
  readonly tag: string;
  readonly attrs: Record<string, string> = {};
  text = "";
  value = "";
  children: Node[] = [];
  style: Record<string, string> = {};
  tabIndex = -1;
  constructor(tag: string) { this.tag = tag; }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  addEventListener(_name: string, _listener: unknown) {}
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
  const el = (tag: string, attrs: Record<string, unknown> | null, children?: unknown[]): Node => {
    const node = new Node(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (key === "text") node.text = String(value);
      else if (key === "value") node.value = String(value);
      else if (key.startsWith("on") && typeof value === "function") continue;
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
  const make = new Function("$", "el", "t", "hint", "cell", `
    let status = null;
    let currentConfig = null;
    let configuredProviders = null;
    let chatgptLoginMessage = "";
    let knownRequestProviders = new Set();
    let requestProvider = "";
    let renderedProviderNames = "";
    const presets = [];
    const presetById = () => undefined;
    const providerHue = () => "#000";
    const providerState = () => el("span", null);
    const providerLimits = () => null;
    const quotaLine = () => null, renderQuotaViewToggle = () => {};
    const credentialLine = () => null;
    const limitsAccountRow = () => el("div", null);
    const chevronIcon = () => el("span", null);
    const chatgptLoginButton = () => el("button", null);
    const openProvider = () => {};
    ${block("const PROVIDER_TYPE_TITLES", "/**\n * The vendor's hue")}
    ${block("/** A provider's entry as the pages read it", "/**\n * A saved provider's name field")}
    ${block("function renderHealthProviders()", "let statusModBusy")}
    ${block("function renderProviderFilter(", "async function loadConfiguredProviders()")}
    return {
      renderHealthProviders, renderProviderFilter, providerDisplayName,
      setState(config, live) { currentConfig = config; status = live; },
    };
  `) as (...args: unknown[]) => {
    renderHealthProviders: () => void;
    renderProviderFilter: (summary: unknown, records: unknown[]) => void;
    providerDisplayName: (name: string, provider?: Entry) => string;
    setState: (config: { providers: Record<string, Entry> } | null, live: { providers: Record<string, Live> } | null) => void;
  };
  const ui = make($, el, (key: string) => key, (text: string) => el("p", { class: "hint", text }),
    (label: unknown, value: unknown, _sub: unknown, extraClass: string) =>
      el("div", { class: extraClass }, [typeof label === "string" ? el("span", { text: label }) : label as Node, ...(Array.isArray(value) ? value : [value]) as Node[]]));
  return {
    ui,
    /** The provider names Status draws, in order, as the reader sees them. */
    statusTitles: () => $("#health-providers").children.map(row => textOf(findByClass(row, "provider-title") ?? new Node("none"))),
    /** The Logs provider menu's options: value and text, without the "All" choice. */
    logsOptions: () => $("#logs-provider").children.filter(option => option.value !== "").map(option => ({ value: option.value, text: option.text })),
  };
}

const chatgpt = (label?: string): Entry => (label ? { type: "chatgpt", label } : { type: "chatgpt" });
const live = (type: string): Live => ({ type, reachable: true, usable: true });

test("two ChatGPT providers keyed work and personal are named with their keys on Status", () => {
  const h = harness();
  h.ui.setState({ providers: { work: chatgpt(), personal: chatgpt() } }, { providers: { work: live("chatgpt"), personal: live("chatgpt") } });
  h.ui.renderHealthProviders();
  assert.deepEqual(h.statusTitles(), ["ChatGPT (work)", "ChatGPT (personal)"]);
});

test("two ChatGPT providers keyed work and personal are named with their keys in the Logs provider menu", () => {
  const h = harness();
  h.ui.setState({ providers: { work: chatgpt(), personal: chatgpt() } }, { providers: { work: live("chatgpt"), personal: live("chatgpt") } });
  h.ui.renderProviderFilter({ providers: {}, models: [] }, []);
  assert.deepEqual(h.logsOptions(), [
    { value: "personal", text: "ChatGPT (personal)" },
    { value: "work", text: "ChatGPT (work)" },
  ]);
});

test("a provider that no other shares its name keeps the plain name, and a label that tells two apart replaces the key", () => {
  const h = harness();
  h.ui.setState({ providers: { work: chatgpt(), personal: chatgpt("Home GPT") } }, { providers: { work: live("chatgpt"), personal: live("chatgpt") } });
  h.ui.renderHealthProviders();
  assert.deepEqual(h.statusTitles(), ["ChatGPT", "Home GPT"]);
  h.ui.setState({ providers: { work: chatgpt() } }, { providers: { work: live("chatgpt") } });
  assert.equal(h.ui.providerDisplayName("work", { type: "chatgpt" }), "ChatGPT");
});

test("a provider the config does not hold yet is named from the live list, and clashes still show its key", () => {
  const h = harness();
  h.ui.setState({ providers: { work: chatgpt() } }, { providers: { work: live("chatgpt"), personal: live("chatgpt") } });
  assert.equal(h.ui.providerDisplayName("personal"), "ChatGPT (personal)");
  assert.equal(h.ui.providerDisplayName("work"), "ChatGPT (work)");
});
