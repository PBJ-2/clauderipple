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

// One subscription reaches its models through three endpoints, split by wire. It used to be three
// presets because a provider carried one url and one wire; now the model carries its own, so one
// preset covers all three. The fallback list is where each model's wire lives — `/models` reports ids
// alone, so a model left on the provider default is routed in the wrong shape on the wrong path.
test("OpenCode Go is one preset whose models carry the wire each one speaks", () => {
  const go = PRESETS.filter((p) => p.id.startsWith("opencode-go"));
  assert.deepEqual(go.map((p) => p.id), ["opencode-go"], "one subscription is one preset, not three");
  const preset = go[0]!;
  assert.equal(preset.kind, "openai-compatible");
  // The provider-level values are the Responses base, so a model with no override gets that wire.
  assert.equal(preset.wire, "responses");
  assert.equal(preset.anthropicBaseUrl, "https://opencode.ai/zen/go/v1", "the OpenAI base carries the /v1");
  assert.equal(preset.authHeader, "authorization-bearer");
  assert.match(preset.modelsUrl ?? "", /\/models$/);
  // The vendor keys its prompt cache on this. Omitting it errors nothing and multiplies the bill,
  // which is exactly how it was left off one of these entries the first time; and it is not optional
  // at all — the vendor answers 400 `MissingSessionID` without it.
  assert.equal(preset.sessionHeader, "x-opencode-session", "the whole preset must carry the session header");
  assert.equal(preset.verified, true, "exercised against the live endpoint");

  const byId = new Map(preset.fallbackModels.map((m) => [m.id, m]));
  const wireOf = (id: string) => byId.get(id)?.wire ?? "responses";
  // All three groups exist in the one list, and each model carries the wire its endpoint speaks.
  assert.equal(wireOf("muse-spark-1.3-contributor"), "responses", "Muse Spark lives on Responses, the preset default");
  assert.equal(wireOf("deepseek-v4.1-flash"), "chat");
  assert.equal(wireOf("minimax-m3"), "anthropic");

  for (const id of ["glm-5.3", "glm-5.3-flash", "kimi-k3", "kimi-k2.7-code", "deepseek-v4.1-flash", "deepseek-v4-pro", "longcat-2.0", "mimo-v2.5-pro"]) {
    // No per-model effort contract is published for the Chat endpoint; the empty ladder disables the
    // preset's Responses ladder rather than sending an effort it never accepted.
    assert.deepEqual(byId.get(id)?.effortLevels, [], `${id} must strip effort`);
  }
  for (const id of ["minimax-m3", "qwen3.8-max", "qwen3.8-flash", "union-alpha"]) {
    const model = byId.get(id)!;
    // One segment shorter than the provider base: an anthropic-compatible base ending in /v1 asks for
    // /v1/v1/messages, which this vendor answers with an HTML 404. And it wants Anthropic's header
    // where the two OpenAI-wire groups on the same key want a bearer.
    assert.equal(model.url, "https://opencode.ai/zen/go", `${id} anthropic base`);
    assert.equal(model.authHeader, "x-api-key", `${id} anthropic auth convention`);
    assert.deepEqual(model.effortLevels, [], `${id} must strip effort`);
  }
  // The Responses models deliberately carry no wire: they inherit the preset's own.
  for (const id of ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor", "grok-4.6", "gpt-5.6-luna"]) {
    assert.equal(byId.get(id)?.wire, undefined, `${id} rides the preset's default wire`);
  }
});

// Read off the model card this was wrong twice over: it listed max, which the endpoint refuses,
// and omitted xhigh, which it accepts. Measured one effort at a time against the live endpoint.
test("Muse Spark's effort ladder tops out at xhigh, and does not include max", () => {
  const responses = PRESETS.find((p) => p.id === "opencode-go");
  assert.deepEqual(responses?.effortLevels, ["none", "minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(responses?.effortLevels.includes("max"), false, "max is refused with invalid_request_error");
});

// Measured 2026-09-22: `/zen/v1/models` lists 76 models, `/zen/go/v1/models` 40, and neither is a
// subset of the other. Treating them as one product is what sent a Zen key to a Go model and got
// "This Go model requires Global regions" back, so the two presets must not drift into each other.
test("OpenCode Zen and OpenCode Go are separate presets that cannot be mistaken for each other", () => {
  const zen = PRESETS.find((preset) => preset.id === "opencode-zen");
  const go = PRESETS.find((preset) => preset.id === "opencode-go");
  assert.ok(zen && go, "both presets are in the catalog");
  assert.equal(zen.anthropicBaseUrl, "https://opencode.ai/zen/v1");
  assert.equal(go.anthropicBaseUrl, "https://opencode.ai/zen/go/v1");
  assert.notEqual(zen.modelsUrl, go.modelsUrl, "each reads its own catalogue");
  // Go refuses a request without it (400 MissingSessionID); Zen answered the same either way.
  assert.equal(zen.sessionHeader, undefined, "Zen asks for no session header");
  assert.equal(go.sessionHeader, "x-opencode-session");
  // The catalogues overlap — measured 2026-09-22, gpt-5.6-luna and the Grok rows are on both — so
  // the test asserts only where they genuinely part: Muse Spark and MiMo are absent from Zen, and
  // Go carries no Claude row at all.
  const zenIds = zen.fallbackModels.map((model) => model.id);
  const goIds = go.fallbackModels.map((model) => model.id);
  assert.equal(zenIds.some((id) => id.startsWith("mimo-")), false, "the MiMo rows are Go's");
  assert.equal(goIds.some((id) => id.startsWith("claude-")), false, "the Claude rows are Zen's");
  assert.ok(zenIds.some((id) => id.startsWith("claude-")), "and Zen offers them");
  // Muse Spark is on both, under different ids: Zen sells muse-spark-1.3 and Go the Contributor
  // tier, which is the cheaper one the workspace has to opt into. Neither id is on both.
  assert.ok(zenIds.includes("muse-spark-1.3") && !zenIds.some((id) => id.endsWith("-contributor")));
  assert.ok(goIds.includes("muse-spark-1.3-contributor") && !goIds.includes("muse-spark-1.3"));
});

// An empty ladder means "this provider takes no effort", and a model with an empty ladder is never
// measured — so a preset that cannot state its ladder must not state an empty one.
test("OpenCode Zen offers a ladder for the measurement to narrow rather than none at all", () => {
  const zen = PRESETS.find((preset) => preset.id === "opencode-zen")!;
  assert.ok(zen.effortLevels.length > 0);
  assert.ok(zen.fallbackModels.every((model) => model.effortLevels === undefined), "no model claims a ladder that was never measured");
});

// The connection test posts to Chat Completions and takes the preset's first Chat model, so that
// model has to be one the vendor serves there. OpenCode publishes the endpoint per model
// (https://opencode.ai/docs/ko/zen/, read 2026-09-22); reading Grok or Gemini as Chat, which an
// earlier version of this preset did, made the test post to an endpoint neither is served on.
test("every OpenCode Zen model carries the wire its published endpoint says, Chat first", () => {
  const zen = PRESETS.find((preset) => preset.id === "opencode-zen")!;
  const wireOf = (id: string): string | undefined => zen.fallbackModels.find((model) => model.id === id)?.wire;
  assert.equal(zen.fallbackModels[0]?.wire, "chat", "the connection test takes the first Chat model");
  for (const id of ["deepseek-v4.1-flash", "minimax-m3", "glm-5.3", "kimi-k3"]) assert.equal(wireOf(id), "chat", id);
  for (const id of ["gpt-6-astra", "grok-4.7", "muse-spark-1.3"]) assert.equal(wireOf(id), "responses", id);
  for (const id of ["claude-opus-5", "qwen3.8-flash"]) assert.equal(wireOf(id), "anthropic", id);
  // Gemini is served at /zen/v1/models/<id> and jev at /systemone — shapes this router does not
  // speak, so offering them would only produce a model that cannot answer.
  assert.equal(zen.fallbackModels.some((model) => model.id.startsWith("gemini") || model.id.startsWith("jev")), false);
});
