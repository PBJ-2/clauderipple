// The "models to use" list stores which workers are ticked. A pinned worker leaves the list while its
// account is paused (or waits for a sign-in) and comes back when it is resumed; a save made while it
// was away must not forget whether it was ticked, or it would come back as a new model, ticked on.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui/app.js"), "utf8");
function block(from: string, to: string): string {
  const at = source.indexOf(from), until = source.indexOf(to, at);
  assert.ok(at > 0 && until > at, `app.js no longer contains ${from}`);
  return source.slice(at, until);
}

type Settings = { allow: string[]; allowKnown: string[] };
type Agent = { name: string; model: string; provider: string };
type Ui = { tick(name: string, on: boolean): void; ticked(name: string): boolean };

/** The tick functions over a settings object they patch in place, offering `agents()` as it is at each call. */
function ticks(settings: Settings, agents: () => Agent[]): Ui {
  const build = new Function("settings", "agentsNow", `
    const modState = { settings, options: { agents: [], providers: [] } };
    const modAgents = () => agentsNow().map((agent) => ({ ...agent, efforts: ["high"], billing: "subscription" }));
    const modProviderInfo = () => undefined;
    const MOD_CLAUDE_MODELS = [], MOD_CLAUDE_IDS = {};
    const modClaudeId = (alias) => MOD_CLAUDE_IDS[alias];
    const t = (key) => key, modCap = (text) => text, el = () => ({});
    const modPatch = (patch) => Object.assign(settings, patch);
    ${block("function modChoices(", "// ---- The four workers: a meaning")}
    const find = (name) => modTickable().find((choice) => choice.value === name);
    return { tick: (name, on) => modTick(find(name), on), ticked: (name) => modTicked({ value: name, provider: "chatgpt" }) };
  `) as (settings: Settings, agents: () => Agent[]) => Ui;
  return build(settings, agents);
}

const worker = (name: string): Agent => ({ name, model: "gpt-x", provider: "chatgpt" });

test("a worker away while its account is paused comes back as it was, ticked or not", () => {
  const settings: Settings = { allow: [], allowKnown: [] };
  let paused = false;
  const ui = ticks(settings, () => [worker("a"), worker("b"), ...(paused ? [] : [worker("a-pin"), worker("b-pin")])]);
  ui.tick("a-pin", false);
  paused = true;
  // Saved while both pinned workers are away: the untick and the tick are both kept.
  ui.tick("b", false);
  assert.deepEqual(settings.allow, ["a", "b-pin"]);
  assert.deepEqual(new Set(settings.allowKnown), new Set(["a", "b", "a-pin", "b-pin"]));
  paused = false;
  assert.equal(ui.ticked("a-pin"), false, "the worker unticked before the pause stays off");
  assert.equal(ui.ticked("b-pin"), true, "the worker ticked before the pause stays on");
  assert.equal(ui.ticked("b"), false);
});

test("every model on again is stored as an empty list only when the ones away were on too", () => {
  const settings: Settings = { allow: [], allowKnown: [] };
  let paused = false;
  const ui = ticks(settings, () => [worker("a"), worker("b"), ...(paused ? [] : [worker("a-pin")])]);
  ui.tick("a-pin", false);
  paused = true;
  ui.tick("b", false);
  ui.tick("b", true);
  // Everything offered is on, but a-pin is away and off: the list cannot say "all".
  assert.deepEqual(settings.allow, ["a", "b"]);
  paused = false;
  assert.equal(ui.ticked("a-pin"), false);
  ui.tick("a-pin", true);
  assert.deepEqual(settings, { allow: [], allowKnown: [] });
});

test("with no list written, a save while a worker is away keeps nothing for it and it stays on", () => {
  const settings: Settings = { allow: [], allowKnown: [] };
  let paused = true;
  const ui = ticks(settings, () => [worker("a"), worker("b"), ...(paused ? [] : [worker("a-pin")])]);
  ui.tick("b", false);
  assert.deepEqual(settings.allow, ["a"]);
  paused = false;
  // Never seen by a written list: a new model, ticked on, as before.
  assert.equal(ui.ticked("a-pin"), true);
});
