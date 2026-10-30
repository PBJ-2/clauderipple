// The GUI decides what the Claude app picker offers. The function runs in a browser as a classic
// script, so the test evaluates it straight from the source text and hands it a stub for the one
// helper it calls. What is fixed here: a model no provider offers any more must not survive, since
// nothing in the interface can uncheck it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Entry = { id: string; name?: string; provider: string; contextWindow?: number };
type Config = {
  providers: Record<string, { type?: string; auth?: string; accountPool?: boolean; models?: { id: string; name?: string }[] }>;
  cli?: { extraModels?: { model: string; name?: string; contextWindow?: number }[] };
  direct?: { prefix: string; provider: string }[];
};

type PickerBlock = {
  applyPickerSelections: (next: Config, selections: Entry[], preserveWindows?: boolean) => Config;
  pickerSelectionsExcept: (config: Config, providerName: string) => Entry[];
};

function loadPickerBlock(): PickerBlock {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui/app.js");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("function allKnownModelIds");
  const end = source.indexOf("function updateSlotSummary");
  assert.ok(start > 0 && end > start, "app.js no longer contains the picker-selection block");
  const make = new Function(
    "groupedModels",
    `${source.slice(start, end)}; return { applyPickerSelections, pickerSelectionsExcept };`,
  ) as (groupedModels: unknown) => PickerBlock;
  // The real helper groups a config's providers; only the model ids matter here.
  return make((config: Config) =>
    Object.entries(config.providers).map(([name, p]) => ({ name, models: p.models ?? [] })),
  );
}

function loadGroupedModels(): (config: Config) => { name: string }[] {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui/app.js");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("function modelsOf");
  const end = source.indexOf("function presetById");
  assert.ok(start > 0 && end > start, "app.js no longer contains the provider-grouping block");
  return new Function(`${source.slice(start, end)}; return groupedModels;`)() as (config: Config) => { name: string }[];
}

test("live provider exhaustion beats a green connection probe and disappears after recovery", () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui/app.js");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("function providerConnection(");
  const end = source.indexOf("function providerState(");
  const status: { providers: Record<string, { reachable: boolean; exhaustion?: { reason: string; until: number } }> } = { providers: { p: { reachable: true, exhaustion: { reason: 'insufficient_balance', until: Date.now() + 60_000 } } } };
  const make = new Function('status', 'stateFor', 'probeIsStale', 't', `${source.slice(start, end)}; return providerConnection;`) as (status: unknown, state: () => unknown, stale: () => boolean, t: (s: string) => string) => (name: string) => { level: string; text: string };
  const connection = make(status, () => ({ ok: true }), () => false, key => key);
  assert.equal(connection('p').level, 'warn');
  assert.match(connection('p').text, /insufficient balance/);
  delete status.providers.p!.exhaustion;
  assert.equal(connection('p').level, 'ok');
});

test("mode reset needs a known future timestamp; Claude uses its binding window", () => {
  const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function modQuotaKnown('), source.indexOf('async function modLoadResets('));
  const known = new Function(`${code}; return modQuotaKnown;`)() as (accounts: unknown[], binding?: boolean) => boolean;
  const window = (used_percent: number, seconds: number) => ({ used_percent, reset_at: Date.now() / 1000 + seconds });
  assert.equal(known([{ state: 'ready', quota: null }]), false);
  assert.equal(known([{ state: 'paused', quota: { rate_limits: { primary: window(90, 600) } } }]), false);
  const accounts = [{ quota: { rate_limits: { primary: window(90, -10), secondary: window(20, 600) } } }];
  assert.equal(known(accounts), true);
  assert.equal(known(accounts, true), false);
  accounts[0]!.quota.rate_limits.primary = window(90, 600);
  assert.equal(known(accounts, true), true);
});

test("mode editor keeps reset disabled with an adjacent reason, and enabled controls omit disabled", () => {
  const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
  type Node = { tag: string; attrs: Record<string, unknown>; children: Node[]; value: string; addEventListener: () => void; appendChild: (child: Node) => void; setAttribute: (key: string, value: string) => void; querySelector: (selector: string) => Node | undefined };
  const find = (node: Node, key: string): Node | undefined => node.attrs['data-key'] === key ? node : node.children.map(child => find(child, key)).find(Boolean);
  const el = (tag: string, attrs: Record<string, unknown> = {}, children: Node[] = []): Node => ({ tag, attrs, children, value: '', addEventListener() {}, appendChild(child) { this.children.push(child); }, setAttribute(key, value) { this.attrs[key] = value; }, querySelector(selector) { return find(this, /data-key="([^"]+)"/.exec(selector)?.[1] ?? ''); } });
  const segment = source.slice(source.indexOf('function modSegmented('), source.indexOf('/** A pop-up menu.'));
  const section = source.slice(source.indexOf('function modModeSection('), source.indexOf('function modWorkersCard('));
  const build = new Function('el', 'known', 'until', `
    const t = (key, vars) => vars ? key + JSON.stringify(vars) : key, modState = {settings:{}};
    const modResetProviders = known ? ['chatgpt', 'anthropic'] : [], modWorkerRows = () => [];
    const modResetLabel = provider => provider === 'anthropic' ? 'Claude' : 'ChatGPT', modResetDefault = () => modResetProviders[0];
    const modSelect = (key, items, value, label) => el('select', { 'data-key': key, items, value, 'aria-label': label });
    const modUpdateMode = () => {}, modSetActive = () => {}, modRemoveMode = () => {}, modLocalTime = () => '';
    const cell = (label, controls, help) => el('cell', { help }, Array.isArray(controls) ? controls : [controls]);
    const modSection = (title, rows) => el('section', {}, rows);
    ${segment}\n${section}\nreturn modModeSection({id:'test',name:'Test',rungs:{},until:until ?? 'none',delegation:'normal'});
  `) as (make: typeof el, known: boolean, until?: unknown) => Node;
  const disabled = build(el, false);
  const reset = find(disabled, 'mode-until:reset')!;
  assert.equal(Object.hasOwn(reset.attrs, 'disabled'), true);
  assert.equal(reset.attrs['aria-describedby'], 'mode-reset-reason');
  const until = disabled.children.find(row => row.children.some(control => control.children.some(child => child.attrs.role === 'radiogroup' && child.attrs['aria-label'] === 'mod.modeUntil')))!;
  const group = until.children[0]!.children[0]!;
  assert.equal(group.children.at(-1)?.attrs.id, 'mode-reset-reason');
  assert.equal(group.children.at(-1)?.attrs.text, 'mod.modeResetUnknown');
  assert.equal(Object.hasOwn(find(disabled, 'mode-until:time')!.attrs, 'disabled'), false);
  assert.equal(Object.hasOwn(find(build(el, true), 'mode-until:reset')!.attrs, 'disabled'), false);
  assert.equal(find(build(el, true), 'mode-until-reset'), undefined);
  // Reset names its provider: a menu of the known ones, and the line under 종료 시점 names the chosen one.
  const claude = build(el, true, { reset: 'anthropic' });
  const select = find(claude, 'mode-until-reset')!;
  assert.equal(select.attrs.value, 'anthropic');
  assert.deepEqual((select.attrs.items as { value: string; label: string }[]).map(item => [item.value, item.label]), [
    ['chatgpt', 'mod.modeUntilResetOf{"provider":"ChatGPT"}'], ['anthropic', 'mod.modeUntilResetOf{"provider":"Claude"}'],
  ]);
  const help = (node: Node): unknown => node.attrs.help ?? node.children.map(help).find(Boolean);
  assert.equal(help(claude), 'mod.modeResetHelp{"provider":"Claude"}');
  // A saved provider whose reset is not known now stays chosen, marked unavailable.
  const gone = find(build(el, false, { reset: 'chatgpt' }), 'mode-until-reset')!;
  assert.deepEqual((gone.attrs.items as { value: string; label: string }[]).map(item => [item.value, item.label]), [['chatgpt', 'mod.modeUntilResetOf{"provider":"ChatGPT"}mod.unavailable']]);
});

test("domain editors copy, edit and remove only the selected set's rule; new modes deep-copy Base", () => {
  const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
  const block = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));
  type Node = { attrs: Record<string, unknown>; children: Node[]; value: string; checked: boolean; events: Record<string, () => void>; addEventListener: (name: string, fn: () => void) => void; appendChild: (node: Node) => void };
  const el = (_tag: string, attrs: Record<string, unknown> = {}, children: Node[] = []): Node => {
    const node: Node = { attrs, children: children.filter(Boolean), value: String(attrs.value ?? ''), checked: !!attrs.checked, events: {}, addEventListener(name, fn) { this.events[name] = fn; }, appendChild(child) { this.children.push(child); } };
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('on') && typeof value === 'function') node.events[key.slice(2)] = value as () => void;
    return node;
  };
  const cell = (_label: unknown, controls: Node | Node[], help: unknown) => el('cell', { help }, Array.isArray(controls) ? controls : [controls]);
  const build = new Function('el', 'cell', `
    const t = key => key, clone = value => JSON.parse(JSON.stringify(value));
    const MOD_EFFORTS = ['low','medium','high','xhigh','max'];
    ${block('const MOD_CLAUDE_MODELS', '// `base` is the router')}
    const modState = { settings: clone(MOD_DEFAULTS), options: null };
    let modModeTab = '', modSaveTimer = null;
    const modRefresh = () => {}, modStatus = () => {}, setTimeout = () => 1, clearTimeout = () => {};
    const toast = message => { throw new Error(message); };
    ${block('function modCap(', '/** Rebuild a region')}
    ${block('function modSwitch(', 'function modCard(')}
    ${block('function modPatch(', 'async function saveMod(')}
    ${block('function modChoices(', '// ---- The four workers: a meaning')}
    ${block('function modRungs(', '/** Said once after settings')}
    ${block('function modUpdateMode(', 'function modSetActive(')}
    ${block('function modNewMode(', '/** A datetime-local')}
    return { state: modState, rows: modWorkerRows, create: modNewMode };
  `) as (el: unknown, cell: unknown) => { state: { settings: import('../../mod/types/index.d.ts').Settings }; rows: (mode?: import('../../mod/types/index.d.ts').Mode) => Node[]; create: () => Node };
  const ui = build(el, cell);
  const find = (nodes: Node[], key: string): Node | undefined => {
    for (const node of nodes) { if (node.attrs['data-key'] === key) return node; const found = find(node.children, key); if (found) return found; }
    return undefined;
  };
  const click = (nodes: Node[], key: string) => find(nodes, key)!.events.click!();
  const toggle = (nodes: Node[], key: string, checked: boolean) => { const input = find(nodes, key)!; input.checked = checked; input.events.change!(); };
  // The general tab keeps its four rungs.
  const general = ui.rows();
  for (const rung of ['light', 'standard', 'hard', 'plan']) assert.ok(find(general, `worker:base:general:${rung}:0`), rung);
  click(ui.rows(), 'worker-domain:base:ui');
  let rows = ui.rows();
  assert.equal(rows[1]!.attrs.help, 'mod.domainFollowsGeneral');
  assert.equal(find(rows, 'worker:base:ui:light:0'), undefined);
  toggle(rows, 'worker-separate:base:ui', true);
  const original = ui.state.settings.rules.general.rungs;
  const copied = ui.state.settings.domainRules!.ui!.rungs;
  // A domain ladder is the general one folded into two levels: light's list for light and ordinary
  // work, plan's for hard work and plans.
  assert.deepEqual(copied, { light: original.light, standard: original.light, hard: original.plan, plan: original.plan });
  assert.notEqual(copied.light![0]!.target, original.light![0]!.target);
  rows = ui.rows();
  // Two rows only: the light level and the heavy one.
  assert.equal(find(rows, 'worker:base:ui:light:0')!.attrs['aria-label'], 'mod.domainLevel.light 1');
  assert.equal(find(rows, 'worker:base:ui:heavy:0')!.attrs['aria-label'], 'mod.domainLevel.heavy 1');
  assert.equal(find(rows, 'worker:base:ui:standard:0'), undefined);
  const select = find(rows, 'worker:base:ui:light:0')!;
  select.value = 'general-purpose+sonnet|high'; select.events.change!();
  // The light level edits light and standard; the heavy level edits hard and plan.
  for (const rung of ['light', 'standard'] as const) assert.equal(ui.state.settings.domainRules!.ui!.rungs[rung]![0]!.target.model, 'sonnet', rung);
  assert.notEqual(ui.state.settings.domainRules!.ui!.rungs.hard![0]!.target.model, 'sonnet');
  const heavy = find(ui.rows(), 'worker:base:ui:heavy:0')!;
  heavy.value = 'general-purpose+opus|high'; heavy.events.change!();
  for (const rung of ['hard', 'plan'] as const) assert.equal(ui.state.settings.domainRules!.ui!.rungs[rung]![0]!.target.model, 'opus', rung);
  for (const rung of ['light', 'standard'] as const) assert.equal(ui.state.settings.domainRules!.ui!.rungs[rung]![0]!.target.model, 'sonnet', rung);
  assert.equal(original.light![0]!.target.agent, 'deepseek-v4-1-flash');
  // New-mode creation is the actual form handler, not a reconstructed copy operation.
  const form = ui.create();
  find([form], 'mode-new-name')!.value = 'New';
  click([form], 'mode-create');
  const mode = ui.state.settings.modes[0]!;
  assert.deepEqual(mode.domainRules, ui.state.settings.domainRules);
  assert.notEqual(mode.domainRules!.ui!.rungs.light![0]!.target, ui.state.settings.domainRules!.ui!.rungs.light![0]!.target);
  click(ui.rows(mode), `worker-domain:${mode.id}:backend`);
  toggle(ui.rows(mode), `worker-separate:${mode.id}:backend`, true);
  // The mode's own domain ladder is the mode's general rungs, folded the same way.
  assert.deepEqual(ui.state.settings.modes[0]!.domainRules!.backend!.rungs, {
    light: mode.rungs.light, standard: mode.rungs.light, hard: mode.rungs.plan, plan: mode.rungs.plan,
  });
  assert.equal(ui.state.settings.domainRules!.backend, undefined);
  toggle(ui.rows(), 'worker-separate:base:ui', false);
  assert.equal(ui.state.settings.domainRules, undefined);
  assert.ok(ui.state.settings.modes[0]!.domainRules!.ui);
  const current = ui.state.settings.modes[0]!;
  toggle(ui.rows(current), `worker-separate:${mode.id}:backend`, false);
  assert.equal(ui.state.settings.modes[0]!.domainRules!.backend, undefined);
  assert.ok(ui.state.settings.modes[0]!.domainRules!.ui);
});

const { applyPickerSelections: apply, pickerSelectionsExcept: except } = loadPickerBlock();
const groups = loadGroupedModels();

function baseConfig(): Config {
  return {
    providers: { openrouter: { models: [{ id: "z-ai/glm-5.3-flash", name: "GLM" }] }, chatgpt: { models: [{ id: "gpt-5.6-terra", name: "Terra" }] } },
    cli: {
      extraModels: [
        { model: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron" },
        { model: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron" },
        { model: "z-ai/glm-5.3-flash", name: "GLM" },
      ],
    },
    direct: [
      { prefix: "gpt-", provider: "chatgpt" },
      { prefix: "nvidia/nemotron-3.5-lightning:free", provider: "openrouter" },
      { prefix: "z-ai/glm-5.3-flash", provider: "openrouter" },
    ],
  };
}

test("only an opted-in native Claude account pool appears in model mapping", () => {
  const config: Config = {
    providers: {
      ingress: { type: "anthropic", auth: "api-key", models: [{ id: "claude-opus-5" }] },
      pooled: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-sonnet-5" }] },
      other: { type: "anthropic-compatible", models: [{ id: "deepseek-v4-pro" }] },
    },
  };
  assert.deepEqual(groups(config).map((group) => group.name), ["pooled", "other"]);
});

test("a model no provider offers any more leaves the picker, and takes its direct rule with it", () => {
  const next = apply(baseConfig(), [{ id: "z-ai/glm-5.3-flash", name: "GLM", provider: "openrouter" }]);
  assert.deepEqual(next.cli?.extraModels, [{ model: "z-ai/glm-5.3-flash", name: "GLM" }]);
  assert.deepEqual(next.direct, [
    // Not a model id, so not an orphan: the legacy prefix rule is kept on purpose. The rule for the
    // ticked model is gone with it — one provider offers it, so the router resolves it unaided.
    { prefix: "gpt-", provider: "chatgpt" },
  ]);
});

test("ticking a model no longer writes a rule: one provider offering it is already the answer", () => {
  const next = apply(baseConfig(), [
    { id: "gpt-5.6-terra", name: "Terra", provider: "chatgpt" },
    { id: "gpt-5.6-terra", name: "Terra", provider: "chatgpt" },
  ]);
  assert.deepEqual(next.cli?.extraModels, [{ model: "gpt-5.6-terra", name: "Terra" }], "the same model chosen twice is written once");
  assert.equal(next.direct?.some((rule) => rule.prefix === "gpt-5.6-terra"), false);
});

// The one case the router refuses to guess through, so the one case a rule is still the answer.
function ambiguousConfig(): Config {
  return {
    providers: {
      deepseek: { models: [{ id: "deepseek-v4-pro", name: "DeepSeek Pro" }] },
      "opencode-go": { models: [{ id: "deepseek-v4-pro", name: "DeepSeek Pro" }, { id: "kimi-k3", name: "Kimi" }] },
    },
    cli: { extraModels: [] },
    direct: [{ prefix: "deepseek-v4-pro", provider: "deepseek" }],
  };
}

test("an id two providers offer keeps its rule even though nothing ticked it", () => {
  // It is in no picker list, and dropping it because of that would stop it routing entirely.
  const next = apply(ambiguousConfig(), [{ id: "kimi-k3", name: "Kimi", provider: "opencode-go" }]);
  assert.deepEqual(next.direct, [{ prefix: "deepseek-v4-pro", provider: "deepseek" }]);
  assert.equal(next.direct?.some((rule) => rule.prefix === "kimi-k3"), false, "the unambiguous one needs nothing");
});

test("ticking an ambiguous model writes the rule that says which provider was meant", () => {
  const next = apply(ambiguousConfig(), [{ id: "deepseek-v4-pro", name: "DeepSeek Pro", provider: "opencode-go" }]);
  assert.equal(next.direct?.length, 1);
  assert.equal(next.direct?.[0]?.provider, "deepseek", "an existing rule is the operator's answer and is not overwritten by a tick");
});

test("unchecking every model empties the picker list", () => {
  const next = apply(baseConfig(), []);
  assert.deepEqual(next.cli?.extraModels, []);
  assert.deepEqual(next.direct, [{ prefix: "gpt-", provider: "chatgpt" }]);
});

// The list is rebuilt from the checkboxes on every change, so a window that is not carried through
// would be wiped by the next click on an unrelated model.
test("a model's own context window survives the rebuild; a missing or unusable one is left out", () => {
  const next = apply(baseConfig(), [
    { id: "z-ai/glm-5.3-flash", name: "GLM", provider: "openrouter", contextWindow: 400000 },
    { id: "gpt-5.6-terra", name: "Terra", provider: "chatgpt" },
  ]);
  assert.deepEqual(next.cli?.extraModels, [
    { model: "z-ai/glm-5.3-flash", name: "GLM", contextWindow: 400000 },
    { model: "gpt-5.6-terra", name: "Terra" },
  ]);
});

// What one save of an unrelated provider must leave alone. The rebuild is fed the entries of every
// OTHER provider, because no checkbox on that form can speak for them.
function savedConfig(): Config {
  return {
    providers: {
      chatgpt: { models: [{ id: "gpt-5.6-terra", name: "Terra" }] },
      "opencode-go": { models: [{ id: "deepseek-v4.1-flash" }, { id: "muse-spark-1.3-contributor" }] },
      openrouter: { models: [{ id: "z-ai/glm-5.3-flash", name: "GLM" }] },
    },
    cli: {
      extraModels: [
        { model: "gpt-5.6-terra", name: "Terra" },
        { model: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash", contextWindow: 200000 },
        { model: "muse-spark-1.3-contributor", name: "muse-spark-1.3-contributor" },
        { model: "z-ai/glm-5.3-flash", name: "GLM" },
      ],
    },
    // The legacy prefix, and nothing else: rules stopped being written for unambiguous ids.
    direct: [{ prefix: "gpt-", provider: "chatgpt" }],
  };
}

test("saving one provider leaves every other provider's picker entries standing", () => {
  // The regression this replaces asked `direct` who owned each entry. Only the `gpt-` prefix still
  // matched anything, so saving openrouter emptied the picker of deepseek and muse as well.
  const kept = except(savedConfig(), "openrouter");
  assert.deepEqual(kept.map((entry) => [entry.id, entry.provider]), [
    ["gpt-5.6-terra", "chatgpt"],
    ["deepseek-v4.1-flash", "opencode-go"],
    ["muse-spark-1.3-contributor", "opencode-go"],
  ]);
  assert.equal(kept.find((entry) => entry.id === "deepseek-v4.1-flash")?.contextWindow, 200000, "the window travels with the entry");
});

test("the saved provider's own entries are left to its checkboxes", () => {
  const kept = except(savedConfig(), "opencode-go");
  assert.deepEqual(kept.map((entry) => entry.id), ["gpt-5.6-terra", "z-ai/glm-5.3-flash"]);
});

test("a model the save just unticked is already undeclared, and is not carried back in", () => {
  // The caller updates `next.providers` first, so an unticked model no longer appears anywhere.
  const config = savedConfig();
  config.providers["opencode-go"]!.models = [{ id: "muse-spark-1.3-contributor" }];
  assert.equal(except(config, "chatgpt").some((entry) => entry.id === "deepseek-v4.1-flash"), false);
});

test("an id two providers offer is owned by the rule that says which deal was meant", () => {
  const config = savedConfig();
  config.providers.openrouter!.models = [{ id: "z-ai/glm-5.3-flash", name: "GLM" }, { id: "deepseek-v4.1-flash" }];
  config.direct!.push({ prefix: "deepseek-v4.1-flash", provider: "openrouter" });
  assert.equal(except(config, "chatgpt").find((entry) => entry.id === "deepseek-v4.1-flash")?.provider, "openrouter");
});

test("a model listing keeps what is ticked now; only a new provider's first listing ticks everything", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui/app.js"), "utf8");
  const start = source.indexOf("function tickedAfterListing");
  const end = source.indexOf("}", start) + 1;
  assert.ok(start > 0, "app.js no longer contains tickedAfterListing");
  const ticked = new Function(`${source.slice(start, end)}; return tickedAfterListing;`)() as (first: boolean, tickedIds: string[], listedIds: string[]) => Set<string>;
  const listing = ["grok-4.7", "grok-4.7-fast", "grok-4.6", "grok-4.5"];
  assert.deepEqual([...ticked(true, [], listing)], listing, "a new provider starts with every model");
  // The user unticked two models; a re-check — of a new or a saved provider — leaves them unticked.
  assert.deepEqual([...ticked(false, ["grok-4.7", "grok-4.5"], listing)], ["grok-4.7", "grok-4.5"]);
  assert.deepEqual([...ticked(false, [], listing)], [], "all unticked stays all unticked");
  assert.deepEqual([...ticked(false, ["my-custom"], listing)], ["my-custom"], "a custom model the user added stays ticked");
});

const dashboardSource = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
function dashboardBlock(from: string, to: string): string {
  const start = dashboardSource.indexOf(from), end = dashboardSource.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `missing dashboard block: ${from}`);
  return dashboardSource.slice(start, end);
}
const mergeBlock = dashboardBlock('function modChanges(', '/** Take the router');

type Model = { id: string; name?: string; contextWindow?: number };
type SavedProvider = {
  type: string; auth?: string; apiKey?: string; url?: string; models: Model[]; headers?: Record<string, string>;
  caps?: Record<string, unknown>; credentials?: { id: string; headers: Record<string, string> }[];
};
type SavedRoute = { provider: string; model: string; effort?: string; fallbacks?: { provider: string; model: string }[]; contextWindow?: number };
type SavedConfig = {
  providers: Record<string, SavedProvider>; routes: Record<string, SavedRoute>;
  cli: { extraModels: { model: string; name?: string; contextWindow?: number }[] };
  direct: { prefix: string; provider: string }[]; configRevision?: string; autoUpdate?: boolean;
};
function saveFixture(): SavedConfig {
  return {
    providers: { p: { type: 'openai-compatible', url: 'https://example.test/v1', models: [{ id: 'one' }, { id: 'two' }], headers: { authorization: 'Bearer original' } } },
    routes: {}, cli: { extraModels: [{ model: 'one' }, { model: 'two' }] }, direct: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// A small DOM boundary; the actual checklist, provider form and its save/list handlers run below.
type UiEvent = { key: string; isComposing: boolean; preventDefault(): void; stopPropagation(): void };
class SaveNode {
  children: SaveNode[] = [];
  parent: SaveNode | null = null;
  value: string;
  checked: boolean;
  disabled = false;
  textContent = '';
  placeholder: string;
  type: string;
  dataset: Record<string, string> = {};
  listeners = new Map<string, ((event: UiEvent) => unknown)[]>();
  readonly tag: string;
  readonly attrs: Record<string, unknown>;
  constructor(tag: string, attrs: Record<string, unknown> = {}, children: SaveNode[] = []) {
    this.tag = tag; this.attrs = attrs;
    this.value = String(attrs.value ?? ''); this.checked = Boolean(attrs.checked); this.type = String(attrs.type ?? ''); this.placeholder = String(attrs.placeholder ?? '');
    for (const [key, fn] of Object.entries(attrs)) if (key.startsWith('on') && typeof fn === 'function') this.addEventListener(key.slice(2), fn as (event: UiEvent) => unknown);
    this.append(...children);
  }
  addEventListener(name: string, fn: (event: UiEvent) => unknown) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  async emit(name: string) {
    for (const fn of this.listeners.get(name) ?? []) await fn({ key: '', isComposing: false, preventDefault() {}, stopPropagation() {} });
    if (name === 'change' && this.parent) await this.parent.emit(name);
  }
  append(...nodes: SaveNode[]) { for (const node of nodes.filter(Boolean)) { node.parent = this; this.children.push(node); } }
  appendChild(node: SaveNode) { this.append(node); return node; }
  replaceChildren(...nodes: SaveNode[]) { this.children = []; this.append(...nodes); }
  replaceWith(node: SaveNode) {
    assert.ok(this.parent); const index = this.parent.children.indexOf(this);
    this.parent.children[index] = node; node.parent = this.parent;
  }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  get readOnly(): boolean { return this.attrs.readonly !== undefined; }
  get childElementCount(): number { return this.children.length; }
  querySelector(selector: string): SaveNode | undefined {
    return this.find(node => selector.startsWith('.') ? String(node.attrs.class ?? '').split(' ').includes(selector.slice(1)) : node.tag === selector);
  }
  find(predicate: (node: SaveNode) => boolean): SaveNode | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) { const found = child.find(predicate); if (found) return found; }
    return undefined;
  }
}
type ProbeResult = { ok: boolean; models: Model[] };
function providerSaveHarness(initial = saveFixture(), probe: Promise<ProbeResult> = Promise.resolve({ ok: true, models: [] })) {
  const h = { initial: structuredClone(initial), latest: structuredClone(initial), writes: [] as SavedConfig[], probes: [] as SavedProvider[], root: null as SaveNode | null, probe, errors: [] as string[] };
  const make = new Function('h', 'el', `
    let currentConfig = clone(h.initial), selectedProviderName, providerDetailTab, slotsLoaded, providersLoaded, clientsLoaded;
    const t = key => key, hint = text => el('small', {text}), selectOption = (value, text) => el('option', {value, text});
    const CHATGPT_MODELS = [], presetById = () => undefined;
    const claudeModels = [{ id: 'one' }, { id: 'two' }], startGoogleLogin = async () => false;
    ${dashboardBlock('function modelsOf(', 'function presetById(')}
    ${dashboardBlock('function isKeyProvider(', '/** A key\'s header set:')}
    ${dashboardBlock('function effortSelect(', 'function routeFromTarget(')}
    ${dashboardBlock('function allKnownModelIds(', 'function updateSlotSummary(')}
    ${dashboardBlock('function inputRow(', 'function anthropicSourceText(')}
    const effortLevelsFor = () => ['low', 'high'], fallbackEffortLevels = () => [], hasModelEffortData = () => false, modelEffortTag = () => '';
    const pickerModeOn = () => true, probeProvider = (name, draft) => { h.probes.push(clone(draft)); return h.probe; }, api = () => h.probe;
    const setTimeout = () => 0, startChatgptLogin = () => {}, closeModal = () => {};
    const showModal = form => { h.root = form; }, toast = (message, error) => { if (error) h.errors.push(message); };
    ${dashboardBlock('function configSaved(', '// A save sends')}
    const document = { createTextNode: text => el('text', {text}) };
    const latestConfig = async () => clone(h.latest), configRequest = async next => { h.writes.push(clone(next)); };
    const loadProviders = async () => {}, offerPickerOn = async () => {}, startMeasurement = () => {};
    const confirm = () => true, closeProviderDetail = () => {}, renderProviderWorkspace = () => {};
    ${dashboardBlock('/** The two rows a setting shows', '// Claude Code refuses these')}
    ${dashboardBlock('function providerUsages(', 'function providerTabs(')}
    ${dashboardBlock('function anthropicSourceText(', 'function openAnthropicProviderForm(')}
    ${dashboardBlock('function openAnthropicProviderForm(', 'function openProviderForm(')}
    ${dashboardBlock('function openProviderForm(', '// ---- ClaudeRipple mod')}
    return { open: options => openProviderForm(options || {name:'p', provider:h.initial.providers.p}), remove: () => removeProvider('p', h.initial.providers.p), usages: config => providerUsages(config, 'p') };
  `);
  const ui = make(h, (tag: string, attrs?: Record<string, unknown>, children?: SaveNode[]) => new SaveNode(tag, attrs, children)) as {
    open(options?: { name?: string; kind?: string; provider?: SavedProvider }): void;
    remove(): Promise<void>;
    usages(config: unknown): { routes: string[]; fallbacks: { route: string; model: string }[]; direct: number; picker: number; search: boolean; classifier: boolean };
  };
  const button = (text: string) => { const node = h.root?.find(node => node.tag === 'button' && node.attrs.text === text); assert.ok(node, text); return node; };
  return { h, open: ui.open, remove: ui.remove, usages: ui.usages, button, save: () => button('common.save').emit('click') };
}

test('an older provider form leaves the latest auth key and first pooled credential intact unless a key is typed', async () => {
  const fixture = saveFixture();
  fixture.providers.p!.credentials = [{ id: 'first', headers: { authorization: 'Bearer original' } }, { id: 'second', headers: { authorization: 'Bearer second' } }];
  const ui = providerSaveHarness(fixture); ui.open();
  ui.h.latest.providers.p!.headers = { authorization: 'Bearer rotated' };
  ui.h.latest.providers.p!.credentials![0]!.headers = { authorization: 'Bearer rotated' };
  await ui.save();
  assert.deepEqual(ui.h.writes[0]!.providers.p!.headers, { authorization: 'Bearer rotated' });
  assert.deepEqual(ui.h.writes[0]!.providers.p!.credentials, ui.h.latest.providers.p!.credentials);
  ui.h.root!.find(node => node.type === 'password')!.value = 'replacement';
  await ui.save();
  const saved = ui.h.writes[1]!.providers.p!;
  assert.deepEqual(saved.headers, { authorization: 'Bearer replacement' });
  assert.deepEqual(saved.credentials![0]!.headers, saved.headers);
  assert.deepEqual(saved.credentials![1], fixture.providers.p!.credentials![1]);
  assert.deepEqual(ui.h.errors, []);
});

test('saving a compatible provider keeps its latest unedited capability fields', async () => {
  const ui = providerSaveHarness(); ui.open();
  ui.h.latest.providers.p!.caps = { effortLevels: ['low', 'high'], reasoning: 'effort', images: true, custom: { keep: true } };
  await ui.save();
  assert.deepEqual(ui.h.writes[0]!.providers.p!.caps, ui.h.latest.providers.p!.caps);
});

test('capitalized auth headers survive a save and remain available to the connection probe', async () => {
  for (const [header, value, type] of [['Authorization', 'Bearer mixed', 'openai-compatible'], ['X-API-Key', 'mixed', 'anthropic-compatible']]) {
    const fixture = saveFixture(); fixture.providers.p!.type = type!; fixture.providers.p!.headers = { [header!]: value! };
    const ui = providerSaveHarness(fixture); ui.open();
    assert.equal(ui.h.root!.find(node => node.type === 'password')!.placeholder, 'providers.keySaved');
    await ui.button('providers.check').emit('click');
    assert.deepEqual(ui.h.probes[0]!.headers, { [header!]: value! });
    await ui.save();
    assert.deepEqual(ui.h.writes[0]!.providers.p!.headers, { [header!]: value! });
  }
});

test('provider saves preserve a picker-only context window instead of its catalogue default', async () => {
  const fixture = saveFixture(); fixture.cli.extraModels[0]!.contextWindow = 345678;
  fixture.providers.p!.models[0]!.contextWindow = 100000;
  const ui = providerSaveHarness(fixture); ui.open(); await ui.save();
  assert.equal(ui.h.writes[0]!.cli.extraModels.find(entry => entry.model === 'one')!.contextWindow, 345678);
  // The Clients editor can still explicitly clear an override.
  assert.equal(apply(fixture, [{ id: 'one', provider: 'p' }]).cli!.extraModels![0]!.contextWindow, undefined);
});

test('late compatible and ChatGPT model listings respect checkboxes changed while they were in flight', async () => {
  for (const type of ['openai-compatible', 'chatgpt']) {
    const fixture = saveFixture(); fixture.providers.p!.type = type;
    const pending = deferred<ProbeResult>(), ui = providerSaveHarness(fixture, pending.promise); ui.open();
    const checking = type === 'chatgpt' ? Promise.resolve() : ui.button('providers.check').emit('click');
    const checkbox = ui.h.root!.find(node => node.type === 'checkbox' && node.dataset.model === 'one')!;
    checkbox.checked = false; await checkbox.emit('change');
    pending.resolve({ ok: true, models: [{ id: 'one' }, { id: 'two' }, { id: 'new' }] });
    await checking; await new Promise<void>(resolve => setImmediate(resolve));
    await ui.save();
    assert.deepEqual(ui.h.writes[0]!.providers.p!.models.map(model => model.id), ['two'], type);
  }
});

test('saving a Google or Grok provider preserves a picker-only window instead of its catalogue one', async () => {
  for (const type of ['google', 'grok']) {
    const fixture = saveFixture();
    fixture.providers.p = { type, ...(type === 'google' ? { auth: 'api-key' } : {}), models: [{ id: 'one', contextWindow: 100000 }] };
    fixture.cli.extraModels = [{ model: 'one', name: 'one', contextWindow: 345678 }];
    const ui = providerSaveHarness(fixture); ui.open();
    await new Promise<void>(resolve => setImmediate(resolve));
    await ui.save();
    assert.equal(ui.h.writes[0]!.cli.extraModels[0]!.contextWindow, 345678, type);
  }
});

test('late Claude and Google model listings respect checkboxes changed while they were in flight', async () => {
  for (const type of ['anthropic', 'google']) {
    const fixture = saveFixture();
    fixture.providers.p = type === 'anthropic'
      ? { type, auth: 'claude-code', models: [{ id: 'one' }, { id: 'two' }] }
      : { type, auth: 'api-key', apiKey: 'stored', models: [{ id: 'one' }, { id: 'two' }] };
    const pending = deferred<ProbeResult>(), ui = providerSaveHarness(fixture, pending.promise); ui.open();
    await new Promise<void>(resolve => setImmediate(resolve));
    const checkbox = ui.h.root!.find(node => node.type === 'checkbox' && node.dataset.model === 'one')!;
    checkbox.checked = false; await checkbox.emit('change');
    pending.resolve({ ok: true, models: [{ id: 'one' }, { id: 'two' }, { id: 'new' }] });
    await new Promise<void>(resolve => setImmediate(resolve));
    await ui.save();
    assert.deepEqual(ui.h.writes[0]!.providers.p!.models.map(model => model.id), ['two'], type);
  }
});

test('a new Claude provider auto-ticks its first listing only while the user has not edited it', async () => {
  for (const edited of [false, true]) {
    const fixture = saveFixture(); delete fixture.providers.p;
    const pending = deferred<ProbeResult>(), ui = providerSaveHarness(fixture, pending.promise);
    ui.open({ kind: 'anthropic' });
    await new Promise<void>(resolve => setImmediate(resolve));
    if (edited) {
      const checkbox = ui.h.root!.find(node => node.type === 'checkbox' && node.dataset.model === 'one')!;
      checkbox.checked = false; await checkbox.emit('change');
    }
    pending.resolve({ ok: true, models: [{ id: 'one' }, { id: 'two' }, { id: 'new' }] });
    await new Promise<void>(resolve => setImmediate(resolve));
    await ui.button('providers.add').emit('click');
    const saved = Object.values(ui.h.writes[0]!.providers)[0]!;
    assert.deepEqual(saved.models.map(model => model.id), edited ? ['two'] : ['one', 'two', 'new'], edited ? 'the user edit wins' : 'an untouched first listing fills in');
  }
});

test('a new Grok provider has no default model list to edit before its first listing', async () => {
  const fixture = saveFixture(); delete fixture.providers.p;
  const pending = deferred<ProbeResult>(), ui = providerSaveHarness(fixture, pending.promise);
  ui.open({ kind: 'grok' });
  assert.equal(ui.h.root!.find(node => node.type === 'checkbox' && node.dataset.model !== undefined), undefined, 'nothing to untick before the catalogue arrives');
  pending.resolve({ ok: true, models: [{ id: 'grok-4.7' }] });
  await new Promise<void>(resolve => setImmediate(resolve));
  await ui.button('providers.add').emit('click');
  const saved = Object.values(ui.h.writes[0]!.providers)[0]!;
  assert.deepEqual(saved.models.map(model => model.id), ['grok-4.7']);
});

test('removing a provider keeps shared picker models owned by a different provider', async () => {
  const fixture = saveFixture();
  fixture.providers.q = { type: 'openai-compatible', models: [{ id: 'one' }] };
  fixture.direct = [{ prefix: 'one', provider: 'q' }];
  const ui = providerSaveHarness(fixture); await ui.remove();
  assert.deepEqual(ui.h.writes[0]!.cli.extraModels, [{ model: 'one' }]);
  assert.deepEqual(ui.h.writes[0]!.direct, [{ prefix: 'one', provider: 'q' }]);
  assert.equal(ui.h.writes[0]!.providers.p, undefined);
});

// B13: a fallback, the web search or the classifier naming the provider made the saved config
// invalid (an unknown provider), so the removal has to take them with it — and say so first.
test('removing a provider clears the fallbacks, web search and classifier that named it', async () => {
  const fixture = saveFixture() as SavedConfig & { webSearch?: unknown; autoModeClassifier?: unknown };
  fixture.providers.q = { type: 'openai-compatible', models: [{ id: 'one' }] };
  fixture.routes = {
    one: { provider: 'q', model: 'one', fallbacks: [{ provider: 'p', model: 'two' }, { provider: 'q', model: 'one' }] },
    two: { provider: 'q', model: 'one', fallbacks: [{ provider: 'p', model: 'two' }] },
  };
  fixture.webSearch = { provider: 'p', model: 'one' };
  fixture.autoModeClassifier = { provider: 'p', model: 'one' };
  const ui = providerSaveHarness(fixture); await ui.remove();
  const saved = ui.h.writes[0] as unknown as Record<string, unknown>;
  const routes = saved.routes as Record<string, { fallbacks?: unknown }>;
  assert.deepEqual(routes.one!.fallbacks, [{ provider: 'q', model: 'one' }]);
  assert.equal(routes.two!.fallbacks, undefined, 'an empty fallback list is not written back');
  assert.equal(saved.webSearch, undefined);
  assert.equal(saved.autoModeClassifier, undefined);
});

// The classifier names a provider on each of its two stages. Each stage that named the removed
// provider goes back to Claude Code's own choice; the other stays as it was.
test('removing a provider used only by the classifier\'s first stage keeps the rest\'s target', async () => {
  const fixture = saveFixture() as SavedConfig & { autoModeClassifier?: unknown };
  fixture.providers.q = { type: 'openai-compatible', models: [{ id: 'one' }] };
  fixture.autoModeClassifier = { provider: 'q', model: 'one', effort: 'high', stage1: { provider: 'p', model: 'two' } };
  const ui = providerSaveHarness(fixture);
  assert.equal(ui.usages(fixture).classifier, true, 'the first stage counts as a use before the confirm');
  await ui.remove();
  assert.deepEqual((ui.h.writes[0] as unknown as Record<string, unknown>).autoModeClassifier, { provider: 'q', model: 'one', effort: 'high', stage1: 'native' });
});

test('removing the classifier\'s main provider keeps a first stage on another provider', async () => {
  const fixture = saveFixture() as SavedConfig & { autoModeClassifier?: unknown };
  fixture.providers.q = { type: 'openai-compatible', models: [{ id: 'one' }] };
  fixture.autoModeClassifier = { provider: 'p', model: 'one', effort: 'high', stage1: { provider: 'q', model: 'one' } };
  const ui = providerSaveHarness(fixture); await ui.remove();
  assert.deepEqual((ui.h.writes[0] as unknown as Record<string, unknown>).autoModeClassifier, { stage1: { provider: 'q', model: 'one' } });
});

test('what a removal would also clean up is counted before the confirm', () => {
  const fixture = saveFixture();
  fixture.providers.q = { type: 'openai-compatible', models: [{ id: 'one' }] };
  fixture.routes = { one: { provider: 'q', model: 'one', fallbacks: [{ provider: 'p', model: 'two' }] } };
  fixture.direct = [{ prefix: 'two', provider: 'p' }];
  const ui = providerSaveHarness(fixture);
  assert.deepEqual(ui.usages(fixture), { routes: [], fallbacks: [{ route: 'one', model: 'two' }], direct: 1, picker: 1, search: false, classifier: false });
});

async function pickerWindowHarness(
  catalogWindows: Record<string, number>,
  windows: Record<string, number> = catalogWindows,
  savedWindows: Record<string, number> = { 'gpt-6.1-sol': 272000, other: 700000 },
) {
  const config = saveFixture();
  config.providers.p = { type: 'chatgpt', models: [{ id: 'gpt-6.1-sol', contextWindow: 272000 }] };
  config.providers.q = { type: 'openai-compatible', models: [{ id: 'other', contextWindow: 800000 }] };
  config.cli.extraModels = Object.entries(savedWindows).map(([model, contextWindow]) => ({ model, contextWindow }));
  const h = { config, catalogWindows, windows, requests: [] as string[], box: new SaveNode('div'), card: new SaveNode('div'), rows: new SaveNode('div') };
  const ui = new Function('h', 'el', `
    let currentConfig, pickerContextWindows = {catalogWindows:{}}, clientsLoaded, status = {};
    let pickerModelsDrawnFor = { key: null }, modelSlotsDrawnFor = { key: null };
    const pickerWindowDrafts = new Map();
    const document = { activeElement: null };
    const t = key => key;
    const CHATGPT_MODELS = [], CSS = {escape: value => value};
    const MODEL_SLOTS = ['smallFast', 'subagent', 'main'];
    const $ = selector => selector === '#client-picker-models-card' ? h.card : selector === '#client-picker-models' ? h.box : selector === '#client-model-slots' ? h.rows
      : h.box.find(node => node.attrs.class === 'model-window' && node.dataset.model === /data-model="([^"]+)"/.exec(selector)?.[1]);
    const $all = () => h.box.children.flatMap(row => row.children[0].children.filter(node => node.type === 'checkbox' && node.checked));
    const hint = text => el('small', {text}), saveClientPickerModels = () => {};
    const cell = (label, value, sub, extraClass) => el('div', {class: 'cell', label, sub, extraClass}, [value]);
    const allKnownModelIds = config => new Set(groupedModels(config).flatMap(group => group.models.map(model => model.id)));
    ${dashboardBlock('function modelsOf(', 'function presetById(')}
    ${dashboardBlock('function discoveredContextWindow(', 'let currentConfig =')}
    ${dashboardBlock('function providerCannotSearch(', 'async function saveWebSearch(')}
    ${dashboardBlock('function renderClientPickerModels(', '// Claude Code picks these')}
    ${dashboardBlock('function clientPickerSelections(', 'async function saveClientPickerModels(')}
    const loadCatalogs = async () => {}, renderClients = () => renderClientPickerModels(true);
    const api = async url => { h.requests.push(url); return url === '/api/config' ? h.config : {windows:h.windows,catalogWindows:h.catalogWindows}; };
    const toast = message => { throw new Error(message); };
    ${dashboardBlock('async function loadClients(', 'async function loadProviders(')}
    return {load:loadClients, selections:clientPickerSelections, setStatus: value => { status = value; }, render: () => { renderClientPickerModels(true); renderModelSlots(); }};
  `)(h, (tag: string, attrs?: Record<string, unknown>, children?: SaveNode[]) => new SaveNode(tag, attrs, children)) as { load(): Promise<void>; selections(): Entry[]; setStatus(value: unknown): void; render(): void };
  await ui.load();
  const field = (model: string) => h.box.find(node => node.attrs.class === 'model-window' && node.dataset.model === model)!;
  return { h, field, selections: ui.selections, load: ui.load, render: ui.render, setStatus: ui.setStatus };}

test('the catalogue window prefills an editable field; an empty or catalogue-equal value saves no override', async () => {
  const ui = await pickerWindowHarness({ 'gpt-6.1-sol': 475000 });
  assert.deepEqual(ui.h.requests, ['/api/config', '/api/context-windows']);
  const field = ui.field('gpt-6.1-sol');
  assert.equal(field.value, '475000', 'the official figure is the default');
  assert.equal(field.readOnly, false, 'the field exists to be edited');
  assert.equal(field.attrs.title, 'slots.windowCodex');
  const note = ui.h.box.find(node => node.tag === 'small' && node.attrs.class === 'pm-note');
  assert.ok(note, 'visible catalogue note');
  assert.equal(note!.attrs.text, 'slots.windowCodex');
  assert.equal(note!.attrs.style, undefined, 'placed by style.css: the page CSP drops a style attribute');
  field.value = '500000';
  assert.equal(ui.selections().find(entry => entry.id === 'gpt-6.1-sol')?.contextWindow, 500000, 'a typed number is the override');
  field.value = '475000';
  assert.equal(ui.selections().find(entry => entry.id === 'gpt-6.1-sol')?.contextWindow, undefined, 'the catalogue value is no override');
  field.value = '';
  assert.equal(ui.selections().find(entry => entry.id === 'gpt-6.1-sol')?.contextWindow, undefined, 'an empty field goes back to the catalogue');
  const other = ui.field('other');
  assert.equal(other.value, '700000');
  assert.equal(other.readOnly, false, 'another provider stays editable');
  other.value = '900000';
  assert.equal(ui.selections().find(entry => entry.id === 'other')?.contextWindow, 900000);
  other.value = '';
  assert.equal(ui.selections().find(entry => entry.id === 'other')?.contextWindow, 800000, 'another provider falls back to the window it declares');
});

test('a saved override is what the field shows, and typing the catalogue figure walks back to it', async () => {
  const ui = await pickerWindowHarness({ 'gpt-6.1-sol': 475000 }, { 'gpt-6.1-sol': 300000, other: 700000 }, { 'gpt-6.1-sol': 300000, other: 700000 });
  const field = ui.field('gpt-6.1-sol');
  assert.equal(field.value, '300000', 'the override, not the catalogue figure');
  assert.equal(field.readOnly, false);
  assert.equal(field.attrs.title, 'slots.windowHelp', 'the note\'s wording belongs to the catalogue value');
  assert.equal(ui.h.box.find(node => node.attrs.class === 'pm-note'), undefined, 'no note while the catalogue is not in effect');
  field.value = '475000';
  assert.equal(ui.selections().find(entry => entry.id === 'gpt-6.1-sol')?.contextWindow, undefined, 'the catalogue figure is no override');
  field.value = '320000';
  assert.equal(ui.selections().find(entry => entry.id === 'gpt-6.1-sol')?.contextWindow, 320000);
});

test('before a Codex window has been read the picker retains its stored editable fallback', async () => {
  const ui = await pickerWindowHarness({});
  const field = ui.field('gpt-6.1-sol');
  assert.equal(field.value, '272000');
  assert.equal(field.readOnly, false);
  assert.equal(ui.h.box.find(node => node.attrs.text === 'slots.windowCodex'), undefined);
  field.value = '300000';
  assert.equal(ui.selections().find(entry => entry.id === 'gpt-6.1-sol')?.contextWindow, 300000);
});

// The provider's Models tab is the one place a model's window is stated: a model that neither its
// provider nor the live Codex catalogue gives runs on the global fallback, and saying so is what
// stops that fallback being silent (Hive's `/models` lists ids and nothing else).
test('a model with no known window says so on its provider, naming the fallback it runs on', () => {
  const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
  const block = (from: string, to: string): string => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `missing app.js block: ${from}`);
    return source.slice(start, end);
  };
  type NoteNode = { tag: string; attrs: Record<string, unknown>; children: NoteNode[] };
  const el = (tag: string, attrs: Record<string, unknown> = {}, children: NoteNode[] = []): NoteNode =>
    ({ tag, attrs, children: children.filter(Boolean) });
  const cell = (label: string, value: NoteNode | null, sub: NoteNode[] | string | null, extraClass?: string): NoteNode =>
    el('div', { class: `cell ${extraClass ?? ''}`, label, sub: (Array.isArray(sub) ? sub : [sub]).filter(Boolean) }, [value as NoteNode]);
  const section = (title: string, rows: NoteNode[], footer?: string, action?: NoteNode): NoteNode => el('section', { title, footer, action }, rows);
  const panel = new Function('el', 'cell', 'section', 't', 'modelsOf', 'labelOf', 'modelEffortTag', 'openProviderForm', `
    let currentConfig = { cli: { autoCompactWindow: 258400 } }, pickerContextWindows = { windows: {}, catalogWindows: { 'gpt-6.1-sol': 475000 } };
    const formatNumber = value => value.toLocaleString('en-US');
    ${block('function discoveredContextWindow(', 'let currentConfig =')}
    ${block('function providerModelsPanel(', 'async function saveAnthropicRotation(')}
    return providerModelsPanel;
  `)(
    el,
    cell,
    section,
    (key: string, vars?: Record<string, string>) => vars ? `${key}${JSON.stringify(vars)}` : key,
    (provider: { models: unknown[] }) => provider.models,
    (model: { id: string; name?: string }) => model.name ?? model.id,
    () => null,
    () => {},
  ) as (name: string, provider: { models: { id: string; name?: string; contextWindow?: number }[] }) => NoteNode;
  const rendered = panel('hive', { models: [
    { id: 'deepseek-ai/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' },
    { id: 'zai-org/glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 327680 },
    { id: 'gpt-6.1-sol', name: 'Sol' },
  ] });
  const rows = rendered.children[0]!.children;
  const notes = rows.map((row) => (row.attrs.sub as NoteNode[]).filter((node) => node.attrs.class === 'cell-sub warn-text').map((node) => node.attrs.text));
  assert.deepEqual(notes, [
    ['providers.windowUnknown{"fallback":"258,400"}'],
    [], // its own window is known
    [], // the live Codex catalogue states this one
  ]);
  // A config with no global fallback has no number to name, so the note only says it is unknown.
  const bare = new Function('el', 'cell', 'section', 't', 'modelsOf', 'labelOf', 'modelEffortTag', 'openProviderForm', `
    let currentConfig = { cli: {} }, pickerContextWindows = { windows: {}, catalogWindows: {} };
    const formatNumber = value => value.toLocaleString('en-US');
    ${block('function discoveredContextWindow(', 'let currentConfig =')}
    ${block('function providerModelsPanel(', 'async function saveAnthropicRotation(')}
    return providerModelsPanel;
  `)(el, cell, section, (key: string) => key, (provider: { models: unknown[] }) => provider.models, (model: { id: string }) => model.id, () => null, () => {}) as typeof panel;
  const single = bare('hive', { models: [{ id: 'jev-1.13' }] });
  assert.deepEqual((single.children[0]!.children[0]!.attrs.sub as NoteNode[]).map((node) => node.attrs.text), ['jev-1.13', 'providers.windowUnknownNoFallback']);
});

test('a repeated status refresh leaves a window being typed and the slot selects in place', async () => {
  const ui = await pickerWindowHarness({});
  ui.render();
  const typing = ui.field('other');
  typing.value = '999999'; // typed, not yet committed by a change event
  const slot = ui.h.rows.children[0]!.children[0]!;
  ui.render();
  assert.equal(ui.field('other'), typing, 'the window input node is the one being typed in');
  assert.equal(typing.value, '999999');
  assert.equal(ui.selections().find(entry => entry.id === 'other')?.contextWindow, 999999);
  assert.equal(ui.h.rows.children[0]!.children[0], slot, 'the slot select is not rebuilt');
  // A genuinely new catalogue still redraws, so the guard cannot freeze the screen.
  ui.h.config = structuredClone(ui.h.config);
  ui.h.config.cli.extraModels = [{ model: 'gpt-6.1-sol', contextWindow: 272000 }];
  await ui.load();
  assert.equal(ui.h.box.find(node => node.type === 'checkbox' && node.dataset.model === 'other')!.checked, false);
});

test('a changed search capability still redraws the slot rows', async () => {
  const ui = await pickerWindowHarness({});
  ui.render();
  const before = ui.h.rows.children[0]!.children[0]!;
  ui.setStatus({ providers: { q: { webSearch: false } } });
  ui.render();
  const after = ui.h.rows.children[0]!.children[0]!;
  assert.notEqual(after, before, 'new capability data reaches the controls');
  assert.ok(after.children.some(option => option.textContent.includes('slots.noWebSearch')));
});

test('a field being typed survives a real catalogue change instead of taking the saved value', async () => {
  const ui = await pickerWindowHarness({});
  const other = ui.field('other');
  other.value = '900000'; // typed, not yet committed
  await other.emit('input');
  // A real config change elsewhere (a provider saved in another window, say) still redraws the rows.
  ui.h.config.providers.r = { type: 'openai-compatible', models: [{ id: 'third' }] };
  await ui.load();
  assert.equal(ui.field('other').value, '900000', 'the words being typed are not replaced by the saved value');
  assert.equal(ui.selections().find(entry => entry.id === 'other')?.contextWindow, 900000);
});

// The render keys deliberately carry no interface language: the selector reloads the page, which
// re-runs every module and redraws with the new `t`. This pins that path — an in-place language swap
// would leave the guards comparing language-independent keys and stale labels on screen.
test('the interface language selector reloads the page so redrawn labels use the new language', () => {
  const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('(function setupLanguage() {');
  const end = source.indexOf('})();', start) + '})();'.length;
  assert.ok(start > 0 && end > start, 'app.js no longer contains the language selector');
  let reloads = 0;
  const stored: Record<string, string> = {};
  let change: (() => void) | undefined;
  const options: { value: string; textContent: string; selected: boolean }[] = [];
  const select = {
    value: '',
    append(option: { value: string; textContent: string; selected: boolean }) { options.push(option); },
    addEventListener(name: string, listener: () => void) { if (name === 'change') change = listener; },
  };
  new Function('$all', 'document', 'location', 'localStorage', 'LANGUAGES', 'CURRENT_LANG', `
    ${source.slice(start, end)}
  `)(
    () => [select],
    { createElement: () => ({ value: '', textContent: '', selected: false }) },
    { reload: () => { reloads += 1; } },
    { setItem: (key: string, value: string) => { stored[key] = value; } },
    [['en', 'English'], ['ko', '한국어']],
    'en',
  );
  assert.deepEqual(options.map(option => option.value), ['en', 'ko']);
  assert.equal(options[0]!.selected, true);
  select.value = 'ko';
  change!();
  assert.deepEqual(stored, { clauderipple_lang: 'ko' });
  assert.equal(reloads, 1, 'a language change restarts the page instead of redrawing in place');
});

type SlotItem = { id: string; route: { provider: string; model: string } | null; effort: string };
function slotsSaveHarness(config: SavedConfig, rows: SlotItem[], put = async (_next: SavedConfig) => {}) {
  const h = { config, rows, put, writes: [] as SavedConfig[] };
  const ui = new Function('h', `
    const clone = value => JSON.parse(JSON.stringify(value));
    let currentConfig = h.config, slotsLoaded = true;
    const $all = () => h.rows.map(item => ({_get: () => clone(item)}));
    const $ = () => ({classList:{toggle(){}},textContent:''}), t = key => key, updateSlotSummary = () => {};
    const clearTimeout = () => {}, setTimeout = () => 1, effortLevelsFor = () => ['low','high'];
    const api = async () => clone(h.config), toast = () => {};
    const configRequest = async next => { h.writes.push(clone(next)); await h.put(next); h.config = clone(next); };
    ${dashboardBlock('function configSaved(', '// A save sends')}
    ${mergeBlock}
    ${dashboardBlock('let slotsSaveTimer =', '// ---- Providers')}
    slotsBaseline = Object.fromEntries(Object.entries(h.config.routes).map(([id, route]) => [id, {provider:route.provider,model:route.model,...(route.effort ? {effort:route.effort} : {})}]));
    return {saveSlots, scheduleSlotsSave};
  `)(h) as { saveSlots(): Promise<void>; scheduleSlotsSave(): void };
  return { h, ...ui };
}

test('mapping edits preserve fallbacks and context windows on both edited and untouched routes', async () => {
  const fixture = saveFixture();
  fixture.routes = {
    a: { provider: 'p', model: 'one', effort: 'high', fallbacks: [{ provider: 'p', model: 'two' }], contextWindow: 123456 },
    b: { provider: 'p', model: 'two', effort: 'high', contextWindow: 234567, fallbacks: [] },
  };
  const ui = slotsSaveHarness(fixture, [
    { id: 'a', route: { provider: 'p', model: 'one' }, effort: 'low' },
    { id: 'b', route: { provider: 'p', model: 'two' }, effort: 'high' },
  ]);
  await ui.saveSlots();
  assert.deepEqual(ui.h.writes[0]!.routes, { a: { ...fixture.routes.a, effort: 'low' }, b: fixture.routes.b });
});

test('a mapping changed during its previous PUT is saved again without another user action', async () => {
  const pending = deferred<void>();
  let writes = 0;
  const ui = slotsSaveHarness(saveFixture(), [{ id: 'a', route: { provider: 'p', model: 'one' }, effort: 'high' }], async () => { if (++writes === 1) await pending.promise; });
  const saving = ui.saveSlots();
  await new Promise<void>(resolve => setImmediate(resolve));
  ui.h.rows[0]!.route = { provider: 'p', model: 'two' }; ui.scheduleSlotsSave();
  // Even an already scheduled debounce firing while PUT is pending must enqueue, not disappear.
  await ui.saveSlots(); pending.resolve(); await saving;
  assert.equal(ui.h.writes.length, 2);
  assert.equal(ui.h.writes[0]!.routes.a!.model, 'one');
  assert.equal(ui.h.writes[1]!.routes.a!.model, 'two');
});

test('a mode conflict retries only that mode, preserving another window\'s edit, additions and deletions', async () => {
  const base = { modes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'deleted', name: 'Delete' }] };
  const h = { state: { base, settings: { modes: [{ id: 'a', name: 'Local A' }, { id: 'b', name: 'B' }, { id: 'new', name: 'New' }] }, revision: 1 }, writes: [] as { settings: typeof base; revision: number }[] };
  await new Function('h', `
    const clone = value => JSON.parse(JSON.stringify(value));
    const modState = h.state, modNormalize = clone;
    let modSaving = false, modSaveAgain = false, modSaveTimer = null, modWrites = 0;
    const modRefresh = () => {}, modStatus = () => {}, t = key => key, toast = () => {}, clearTimeout = () => {};
    ${dashboardBlock('function modChanges(', 'function modCap(')}
    const api = async (url, options) => {
      const sent = JSON.parse(options.body); h.writes.push(sent);
      if (h.writes.length === 1) { const error = new Error('conflict'); error.status = 409; error.body = { revision:2, settings:{modes:[{id:'b',name:'Remote B'},{id:'deleted',name:'Remote deleted'},{id:'a',name:'A'},{id:'remote',name:'Remote'}]} }; throw error; }
      return {settings:sent.settings,revision:3};
    };
    ${dashboardBlock('async function saveMod(', 'async function loadMod(')}
    return saveMod();
  `)(h);
  assert.equal(h.writes[1]!.revision, 2);
  assert.deepEqual(h.writes[1]!.settings.modes, [{ id: 'b', name: 'Remote B' }, { id: 'a', name: 'Local A' }, { id: 'remote', name: 'Remote' }, { id: 'new', name: 'New' }]);
});

test('config revision conflicts re-read and reapply only this save; legacy routers keep raw PUTs', async () => {
  for (const versioned of [true, false]) {
    const original = saveFixture(); if (versioned) original.configRevision = 'revision-1';
    const fresh = structuredClone(original); fresh.providers.p!.headers = { Authorization: 'Bearer rotated' }; fresh.configRevision = 'revision-2';
    fresh.providers.p!.models[0]!.contextWindow = 456789;
    fresh.cli.extraModels[1]!.contextWindow = 234567;
    fresh.providers.q = { type: 'openai-compatible', models: [{ id: 'remote' }] };
    fresh.cli.extraModels.push({ model: 'remote', name: 'Remote' });
    const h = { original, fresh, reads: 0, writes: [] as SavedConfig[] };
    const saved = await new Function('h', `
      const clone = value => JSON.parse(JSON.stringify(value)); let currentConfig;
      const toast = () => {};
      const fetch = async (url, options) => {
        if (!options || options.method !== 'PUT') { h.reads++; return {ok:true,text:async()=>JSON.stringify(h.reads === 1 ? h.original : h.fresh)}; }
        const next = JSON.parse(options.body); h.writes.push(next);
        if (h.original.configRevision && h.writes.length === 1) return {ok:false,status:409,text:async()=>JSON.stringify({error:'conflict',config:h.fresh})};
        return {ok:true,text:async()=>JSON.stringify(h.original.configRevision ? {configRevision:'revision-3'} : {ok:true})};
      };
      ${mergeBlock}
      ${dashboardBlock('const configSnapshots =', 'function modelsOf(')}
      return (async () => { const next = clone(await latestConfig()); next.autoUpdate = false; next.cli.extraModels[0].name = 'Local one'; next.providers.p.models[0].name = 'Local model'; await configRequest(next); return next; })();
    `)(h) as SavedConfig;
    assert.equal(saved.autoUpdate, false);
    assert.equal(h.writes.length, versioned ? 2 : 1);
    if (versioned) {
      assert.equal(h.reads, 2);
      assert.deepEqual(h.writes[1]!.providers.p!.headers, fresh.providers.p!.headers);
      assert.deepEqual(h.writes[1]!.providers.p!.models[0], { id: 'one', contextWindow: 456789, name: 'Local model' });
      assert.deepEqual(h.writes[1]!.cli.extraModels, [{ model: 'one', name: 'Local one' }, { model: 'two', contextWindow: 234567 }, { model: 'remote', name: 'Remote' }]);
      assert.equal(h.writes[1]!.configRevision, 'revision-2');
      assert.equal(saved.configRevision, 'revision-3');
    } else assert.equal(Object.hasOwn(h.writes[0]!, 'configRevision'), false);
  }
});
