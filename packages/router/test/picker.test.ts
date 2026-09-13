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
        { id: "claude-opus-4-8", name: "Opus 4.8", description: "Best", section: "main", thinking: { effort_options: [{ id: "high" }] }, badge: "new" },
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
  const code = (j.model_selector_config as { id: string; models: Record<string, unknown>[]; context_window_by_model: Record<string, number> }[])[1]!;
  assert.equal(code.models.length, 4);
  const terra = code.models[2]!;
  assert.equal(terra.id, "gpt-5.6-terra@high");
  assert.equal(terra.name, "GPT-5.6 Terra");
  assert.equal(terra.description, "default GPT worker");
  assert.equal(terra.section, "main");
  assert.equal("badge" in terra, false, "template badge stripped");
  assert.deepEqual(terra.thinking, { effort_options: [{ id: "high" }] }, "effort config inherited from template");
  assert.equal("description" in code.models[3]!, false);
  assert.equal(code.context_window_by_model["gpt-6-astra@high"], 258400);
  const chat = (j.model_selector_config as { models: unknown[] }[])[0]!;
  assert.equal(chat.models.length, 1, "chat surface untouched");
  // idempotent
  assert.equal(injectPickerModels(j, [{ model: "gpt-6-astra@high", name: "GPT-6 Astra" }]).injected, 0);
});

test("no-ops on unexpected shapes", () => {
  assert.equal(injectPickerModels({}, [{ model: "m", name: "M" }]).injected, 0);
  assert.equal(injectPickerModels({ model_selector_config: "nope" }, [{ model: "m", name: "M" }]).injected, 0);
  assert.equal(injectPickerModels({ model_selector_config: [{ id: "code", models: [{ id: "other-model" }] }] }, [{ model: "m", name: "M" }]).injected, 0, "no Claude template → skip");
});
