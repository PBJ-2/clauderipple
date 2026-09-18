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

// One subscription reaches its models through three endpoints, split by wire. A preset that only
// covers one of them leaves two thirds of what the user paid for unreachable.
test("OpenCode Go covers all three of its endpoints, on one key", () => {
  const go = PRESETS.filter((p) => p.id.startsWith("opencode-go"));
  assert.equal(go.length, 3, "responses, chat and anthropic");
  assert.deepEqual(
    go.map((p) => `${p.kind}/${p.wire ?? "-"}`).sort(),
    ["anthropic-compatible/-", "openai-compatible/chat", "openai-compatible/responses"],
  );
  for (const p of go) {
    // The two kinds mean different things by "base". An openai-compatible provider has the endpoint
    // name appended, so its base carries the `/v1`; an anthropic-compatible one has the caller's
    // whole `/v1/messages` appended, so the same base would ask for `/v1/v1/messages` — which this
    // vendor answers with an HTML 404. Measured the hard way.
    assert.equal(
      p.anthropicBaseUrl,
      p.kind === "anthropic-compatible" ? "https://opencode.ai/zen/go" : "https://opencode.ai/zen/go/v1",
      p.id,
    );
    // Each endpoint wants the auth header of the API it imitates, and they are not the same one.
    // Measured with a wrong key: the unrecognised header answers "Missing API key", the right one
    // answers "Invalid API key".
    assert.equal(p.authHeader, p.kind === "anthropic-compatible" ? "x-api-key" : "authorization-bearer", p.id);
    assert.match(p.modelsUrl ?? "", /\/models$/, p.id);
    // The vendor keys its prompt cache on this. Omitting it errors nothing and multiplies the bill,
    // which is exactly how it was left off one of these entries the first time.
    assert.equal(p.sessionHeader, "x-opencode-session", `${p.id} must carry the session header`);
    // Nothing here has been measured against the endpoint.
    assert.equal(p.verified, false, p.id);
  }
  assert.ok(
    go.find((p) => p.wire === "responses")?.fallbackModels.some((m) => m.id === "muse-spark-1.3-contributor"),
    "Muse Spark is on the Responses endpoint",
  );
});
