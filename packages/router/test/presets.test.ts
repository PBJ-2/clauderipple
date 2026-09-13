import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS } from "../src/presets.ts";

test("provider presets have documented essentials and unique ids", () => {
  const ids = new Set<string>();
  for (const preset of PRESETS) {
    assert.match(preset.anthropicBaseUrl, /^https?:\/\//, `${preset.id} base URL`);
    assert.match(preset.docsUrl, /^https:\/\//, `${preset.id} docs URL`);
    // Native catalog entries include conservative fallbacks. OpenAI-compatible entries may safely
    // rely on discovery where the vendor docs do not publish a stable model id.
    if (preset.kind === "anthropic-compatible") assert.ok(preset.fallbackModels.length >= 1, `${preset.id} fallback model`);
    assert.ok(!ids.has(preset.id), `duplicate preset ${preset.id}`);
    ids.add(preset.id);
  }
});

test("catalog distinguishes native and OpenAI-compatible presets", () => {
  const ids = new Set(PRESETS.map((preset) => preset.id));
  assert.equal(ids.has("custom"), false);
  assert.equal(ids.has("chatgpt"), false);
  for (const id of ["xai-grok", "mistral", "groq", "together", "fireworks", "ollama", "lmstudio"]) {
    const preset = PRESETS.find((entry) => entry.id === id);
    assert.equal(preset?.kind, "openai-compatible", id);
    assert.equal(preset?.authHeader, "authorization-bearer", id);
    assert.match(preset?.modelsUrl ?? "", /\/models$/, id);
  }
});
