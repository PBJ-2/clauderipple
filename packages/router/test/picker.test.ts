import { test } from "node:test";
import assert from "node:assert/strict";
import { injectPickerModels, isBootstrapPath } from "../src/picker.ts";

const bootstrap = () => ({
  account: { uuid: "x" },
  bootstrap_push_revision: 7,
  model_selector_config: [
    { id: "chat", models: [{ id: "claude-opus-4-8", name: "Opus 4.8", thinking: { mode_options: [] } }] },
    {
      id: "code",
      models: [
        { id: "claude-opus-4-8", name: "Opus 4.8", description: "Best", section: "main", context_window: 1_000_000, thinking: { effort_options: [{ id: "high" }] }, badge: "new" },
        { id: "claude-opus-3-7", name: "Opus 3.7", section: "legacy", disabled: true },
      ],
      context_window_by_model: { "claude-opus-4-8": 200000 },
    },
  ],
});

test("bootstrap path matcher", () => {
  assert.ok(isBootstrapPath("/edge-api/bootstrap/org-1/app_start?x=1"));
  assert.ok(isBootstrapPath("/edge-api/bootstrap?cache_bust=1"));
  assert.ok(isBootstrapPath("/api/bootstrap/org/current_user_access"));
  assert.equal(isBootstrapPath("/edge-api/bootstrapper"), false);
  assert.equal(isBootstrapPath("/api/organizations/x/mcp/v2/bootstrap"), false);
});

test("injects into CLI-backed surfaces (code/ccd/ccr/cowork) using an enabled Claude entry as template", () => {
  const j = bootstrap();
  const r = injectPickerModels(j, [{ model: "gpt-5.6-terra@high", name: "GPT-5.6 Terra", description: "default GPT worker" }, { model: "gpt-6-astra@high", name: "GPT-6 Astra" }], 258400);
  assert.equal(r.injected, 2);
  assert.deepEqual(r.surfaces.map((s) => s.id), ["chat", "code"]);
  assert.deepEqual(r.surfaces[1]?.entries[0], { id: "claude-opus-4-8", name: "Opus 4.8" });
  assert.ok(r.surfaces[1]?.entries.some((entry) => entry.id === "gpt-5.6-terra@high" && entry.name === "GPT-5.6 Terra"));
  const code = (j.model_selector_config as { id: string; models: Record<string, unknown>[]; context_window_by_model: Record<string, number> }[])[1]!;
  assert.equal(code.models.length, 4);
  const terra = code.models[2]!;
  assert.equal(terra.id, "gpt-5.6-terra@high");
  assert.equal(terra.name, "GPT-5.6 Terra");
  assert.equal(terra.description, "default GPT worker");
  assert.equal(terra.section, "main");
  assert.equal(terra.context_window, 258400, "template Claude window is replaced for model switches");
  assert.equal("badge" in terra, false, "template badge stripped");
  assert.deepEqual(terra.thinking, { effort_options: [{ id: "high" }] }, "effort config inherited from template");
  assert.equal("description" in code.models[3]!, false);
  assert.equal(code.context_window_by_model["gpt-6-astra@high"], 258400);
  const chat = (j.model_selector_config as { models: unknown[] }[])[0]!;
  assert.equal(chat.models.length, 1, "chat surface untouched");
  // idempotent
  assert.equal(injectPickerModels(j, [{ model: "gpt-6-astra@high", name: "GPT-6 Astra" }]).injected, 0);
});

test("each picker entry gets its own context window; the global value is only the fallback", () => {
  const j = bootstrap();
  injectPickerModels(j, [
    { model: "big@high", name: "Big", contextWindow: 1_000_000 },
    { model: "small@high", name: "Small", contextWindow: 400_000 },
    { model: "plain@high", name: "Plain" },
  ], 258400);
  const code = (j.model_selector_config as { models: Record<string, unknown>[]; context_window_by_model: Record<string, number> }[])[1]!;
  assert.equal(code.context_window_by_model["big@high"], 1_000_000);
  assert.equal(code.context_window_by_model["small@high"], 400_000);
  assert.equal(code.context_window_by_model["plain@high"], 258400, "no own window → global fallback");
  const [big, small, plain] = code.models.slice(-3);
  assert.equal(big?.context_window, 1_000_000);
  assert.equal(small?.context_window, 400_000);
  assert.equal(plain?.context_window, 258400);
  assert.equal(code.context_window_by_model["claude-opus-4-8"], 200000, "existing entries untouched");
});

test("a per-entry window applies even with no global value", () => {
  const j = bootstrap();
  injectPickerModels(j, [{ model: "big@high", name: "Big", contextWindow: 1_000_000 }, { model: "plain@high", name: "Plain" }]);
  const code = (j.model_selector_config as { context_window_by_model: Record<string, number> }[])[1]!;
  assert.equal(code.context_window_by_model["big@high"], 1_000_000);
  assert.equal("plain@high" in code.context_window_by_model, false, "nothing to say about it → say nothing");
  const plain = (j.model_selector_config as { models: Record<string, unknown>[] }[])[1]!.models[3]!;
  assert.equal("context_window" in plain, false, "must not inherit the Claude template window");
});

test("no-ops on unexpected shapes", () => {
  assert.equal(injectPickerModels({}, [{ model: "m", name: "M" }]).injected, 0);
  assert.equal(injectPickerModels({ model_selector_config: "nope" }, [{ model: "m", name: "M" }]).injected, 0);
  assert.equal(injectPickerModels({ model_selector_config: [{ id: "code", models: [{ id: "other-model" }] }] }, [{ model: "m", name: "M" }]).injected, 0, "no Claude template → skip");
});
