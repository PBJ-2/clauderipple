import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The Phone page's access choice, run from the dashboard's own source. The DOM is a small stand-in
// (elements, attributes, radio groups, a click that waits for its handler). The host side is mirrored
// from packages/remote/src/local-control.ts `settings()`, so the test checks what the host would save.

const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
function block(from: string, to: string): string {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `missing UI block: ${from}`);
  return source.slice(start, end);
}

const RELAY = "https://ripple-relay.clauderipple.workers.dev";
type Settings = { bind?: string; relay?: string };
type PhoneData = { settings: Settings; defaultRelay: string };
type Listener = (event: { type: string }) => unknown;

class Node {
  readonly tag: string;
  readonly attrs: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  checked = false;
  disabled = false;
  value = "";
  constructor(tag: string) { this.tag = tag; }
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
}

/** The host's `settings()` in packages/remote/src/local-control.ts, for the fields the page sends. */
function hostApply(current: Settings, body: { relay?: string; bind?: string }): Settings {
  const next: Settings = { ...current };
  if (body.relay !== undefined) { if (body.relay === "off") delete next.relay; else next.relay = body.relay; }
  if (body.bind !== undefined) next.bind = body.bind === "local" ? "127.0.0.1" : body.bind;
  return next;
}

function page(initial: Settings) {
  const nodes: Node[] = [];
  const posts: { route: string; body: unknown }[] = [];
  let host: Settings = { ...initial };
  let built: { phoneSettings: (data: PhoneData) => Node; setSnapshot: (data: PhoneData) => void } | null = null;

  // The page's controls are found through the registry below, so the tree the children would make is not kept.
  const el = (tag: string, attrs: Record<string, unknown> | null): Node => {
    const node = new Node(tag);
    nodes.push(node);
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (key === "checked") node.checked = Boolean(value);
      else if (key === "disabled") node.disabled = true; // the page passes disabled: "" on Save
      else if (key === "value") { node.value = String(value); node.attrs.value = String(value); }
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value as Listener);
      else if (value !== undefined && value !== null) node.attrs[key] = String(value);
    }
    return node;
  };
  const $ = (selector: string): Node | null => {
    if (selector === "#phone-save") return nodes.find(node => node.tag === "button" && node.attrs.id === "phone-save") ?? null;
    if (selector === '#phone-content input[name="phone-mode"]:checked') return nodes.find(node => node.tag === "input" && node.attrs.name === "phone-mode" && node.checked) ?? null;
    throw new Error(`unexpected selector ${selector}`);
  };
  const section = (_title: unknown, _rows: unknown[]) => el("section", null);
  const cell = (_label: unknown, _value: unknown) => el("div", null);
  const phonePost = async (route: string, body: unknown) => {
    posts.push({ route, body });
    host = hostApply(host, body as { relay?: string; bind?: string });
    return { restartRequired: false };
  };
  // The page's refreshPhone reads the host again and redraws its saved state; here that is the host mirror.
  const refreshPhone = async () => { built?.setSnapshot({ settings: { ...host }, defaultRelay: RELAY }); };

  const make = new Function("$", "el", "section", "cell", "t", "toast", "hidePhoneQr", "phonePost", "refreshPhone", `
    let phoneBusy = false;
    let phoneSnapshot = null;
    ${block("// The loopback addresses a saved bind may name", "function phoneRestart(")}
    return { phoneSettings, setSnapshot(data) { phoneSnapshot = data; } };
  `) as (...args: unknown[]) => { phoneSettings: (data: PhoneData) => Node; setSnapshot: (data: PhoneData) => void };
  built = make($, el, section, cell, (key: string) => key, () => {}, () => {}, phonePost, refreshPhone);

  const data: PhoneData = { settings: { ...initial }, defaultRelay: RELAY };
  built.setSnapshot(data);
  built.phoneSettings(data);

  const radios = () => nodes.filter(node => node.tag === "input" && node.attrs.name === "phone-mode");
  const saveButton = (): Node => {
    const save = nodes.find(node => node.attrs.id === "phone-save");
    assert.ok(save, "the Save button is drawn");
    return save;
  };
  return {
    /** The radio the reader sees selected, or null when neither choice is. */
    checked: (): string | null => radios().find(radio => radio.checked)?.attrs.value ?? null,
    saveDisabled: () => saveButton().disabled,
    /** A reader's click on a radio: it becomes the one selected, and only a change to another one fires change. */
    pick: (mode: "relay" | "local") => {
      for (const radio of radios()) {
        const was = radio.checked;
        radio.checked = radio.attrs.value === mode;
        if (radio.checked && !was) for (const listener of radio.listeners.get("change") ?? []) listener({ type: "change" });
      }
    },
    /** A reader's click on Save: a disabled button takes no click. */
    clickSave: async () => {
      const save = saveButton();
      if (save.disabled) return;
      await Promise.all((save.listeners.get("click") ?? []).map(listener => listener({ type: "click" })));
    },
    posts: () => posts.map(post => ({ ...post })),
    host: () => ({ ...host }),
  };
}

test("a direct host (--bind lan --relay off) has neither choice selected, and picking Off saves relay off and bind local", async () => {
  const phone = page({ bind: "lan" });
  assert.equal(phone.checked(), null, "a LAN bind is neither Relay nor Off, so nothing is pre-selected");
  assert.equal(phone.saveDisabled(), true, "nothing to save until a choice is picked");
  phone.pick("local");
  assert.equal(phone.saveDisabled(), false, "Off differs from the direct bind, so Save is enabled");
  await phone.clickSave();
  assert.deepEqual(phone.posts(), [{ route: "settings", body: { relay: "off", bind: "local" } }]);
  assert.deepEqual(phone.host(), { bind: "127.0.0.1" }, "the host now binds this computer only, with no Relay");
  assert.equal(phone.checked(), "local", "after the save Off is the saved choice");
  assert.equal(phone.saveDisabled(), true, "saved, so Save waits for another change");
});

test("a Relay host shows Relay saved, Off enables Save and posts relay off bind local, and Relay again saves the default address", async () => {
  const phone = page({ bind: "127.0.0.1", relay: "https://relay.example" });
  assert.equal(phone.checked(), "relay");
  assert.equal(phone.saveDisabled(), true);
  phone.pick("local");
  assert.equal(phone.saveDisabled(), false);
  await phone.clickSave();
  assert.deepEqual(phone.posts(), [{ route: "settings", body: { relay: "off", bind: "local" } }]);
  assert.equal(phone.checked(), "local");
  phone.pick("relay");
  assert.equal(phone.saveDisabled(), false);
  await phone.clickSave();
  assert.deepEqual(phone.posts().at(-1), { route: "settings", body: { relay: RELAY, bind: "local" } });
  assert.equal(phone.checked(), "relay");
  assert.equal(phone.saveDisabled(), true);
});

test("a host bound to this computer with Relay off shows Off saved; a direct Tailscale host with Relay on pre-selects nothing and Relay binds this computer", async () => {
  const off = page({ bind: "localhost" });
  assert.equal(off.checked(), "local", "a loopback name with no Relay is Off");
  assert.equal(off.saveDisabled(), true);
  const direct = page({ bind: "tailscale", relay: "https://relay.example" });
  assert.equal(direct.checked(), null, "a Relay that binds the Tailscale address is neither choice");
  assert.equal(direct.saveDisabled(), true);
  direct.pick("relay");
  assert.equal(direct.saveDisabled(), false, "picking Relay changes the bind, so Save is enabled");
  await direct.clickSave();
  assert.deepEqual(direct.posts(), [{ route: "settings", body: { relay: "https://relay.example", bind: "local" } }]);
  assert.equal(direct.checked(), "relay");
  assert.equal(direct.saveDisabled(), true);
});
