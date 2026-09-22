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
  providers: Record<string, { type?: string; accountPool?: boolean; models?: { id: string; name?: string }[] }>;
  cli?: { extraModels?: { model: string; name?: string; contextWindow?: number }[] };
  direct?: { prefix: string; provider: string }[];
};

type PickerBlock = {
  applyPickerSelections: (next: Config, selections: Entry[]) => Config;
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
      ingress: { type: "anthropic", models: [{ id: "claude-opus-5" }] },
      pooled: { type: "anthropic", accountPool: true, models: [{ id: "claude-sonnet-5" }] },
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
