import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS } from "../src/presets.ts";

test("provider presets have secure documented essentials and unique ids", () => {
  const ids = new Set<string>();
  for (const preset of PRESETS) {
    assert.match(preset.anthropicBaseUrl, /^https:\/\//, `${preset.id} anthropic base URL`);
    assert.match(preset.docsUrl, /^https:\/\//, `${preset.id} docs URL`);
    assert.ok(preset.fallbackModels.length >= 1, `${preset.id} fallback model`);
    assert.ok(!ids.has(preset.id), `duplicate preset ${preset.id}`);
    ids.add(preset.id);
  }
});

test("catalog omits custom and translated provider types", () => {
  const ids = new Set(PRESETS.map((preset) => preset.id));
  assert.equal(ids.has("custom"), false);
  assert.equal(ids.has("chatgpt"), false);
  assert.equal(ids.has("xai"), false);
  assert.equal(ids.has("mistral"), false);
});
