import { test } from "node:test";
import assert from "node:assert/strict";
import { clampEffort, forwardCompatibleHeader, resolveCompatibleCaps, sanitizeForCompatible, STRICT_COMPAT_CAPS } from "../src/compat.ts";

const enabled = { ...STRICT_COMPAT_CAPS, thinking: "enabled" as const, effortLevels: ["low", "medium", "high"] };

test("sanitizeForCompatible removes Anthropic-only request features and expands deferred tools", () => {
  const input = {
    thinking: { type: "adaptive", display: "updates", block_binding: { type: "enabled" } },
    context_management: { edits: [] },
    container: { id: "container" },
    thread: { type: "create" },
    diagnostics: { x: true },
    output_config: { effort: "xhigh", other: "discard" },
    tools: [
      { type: "custom", name: "kept", defer_loading: true, input_schema: {} },
      { type: "computer_20250124", name: "computer" },
      { name: "implicit-custom", defer_loading: true },
    ],
    tool_choice: { type: "tool", name: "computer" },
    system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
  };
  const result = sanitizeForCompatible(input, enabled);
  assert.deepEqual(result.json.thinking, { type: "enabled", budget_tokens: 8192 });
  assert.equal("context_management" in result.json, false);
  assert.equal("container" in result.json, false);
  assert.equal("thread" in result.json, false);
  assert.equal("diagnostics" in result.json, false);
  assert.deepEqual(result.json.output_config, { effort: "high" });
  assert.deepEqual(result.json.tools, [{ type: "custom", name: "kept", input_schema: {} }, { name: "implicit-custom" }]);
  assert.equal("tool_choice" in result.json, false);
  assert.ok(result.changes.includes("thinking adaptive→enabled"));
  assert.ok(result.changes.includes("context_management"));
  assert.ok(result.changes.includes("defer_loading×2"));
  assert.ok(result.changes.includes("server_tools×1"));
  assert.ok(result.changes.includes("tool_choice"));
  assert.ok(result.changes.includes("effort xhigh→high"));
  // Default cacheControl is deliberately permissive.
  assert.deepEqual(result.json.system, input.system);
  assert.deepEqual(result.json.messages, input.messages);
  assert.equal((input.tools[0] as { defer_loading?: boolean }).defer_loading, true, "input remains pure");
});

test("sanitizeForCompatible drops adaptive thinking and effort under strict defaults", () => {
  const result = sanitizeForCompatible({
    thinking: { type: "adaptive", display: "updates", block_binding: {} },
    output_config: { effort: "xhigh" },
  }, STRICT_COMPAT_CAPS);
  assert.deepEqual(result.json, {});
  assert.deepEqual(result.changes, ["thinking", "effort xhigh→removed"]);
});

test("sanitizeForCompatible strips non-adaptive thinking decorations and cache_control only when disabled", () => {
  const result = sanitizeForCompatible({
    thinking: { type: "enabled", budget_tokens: 100, display: "updates", block_binding: {} },
    system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "u", cache_control: { type: "ephemeral" } }] }],
  }, { ...STRICT_COMPAT_CAPS, cacheControl: false });
  assert.deepEqual(result.json.thinking, { type: "enabled", budget_tokens: 100 });
  assert.deepEqual(result.json.system, [{ type: "text", text: "s" }]);
  assert.deepEqual(result.json.messages, [{ role: "user", content: [{ type: "text", text: "u" }] }]);
  assert.ok(result.changes.includes("thinking"));
  assert.ok(result.changes.includes("cache_control×2"));
});

test("effort clamping is table-driven", () => {
  for (const row of [
    { requested: "xhigh", supported: ["low", "medium", "high"], expected: "high" },
    { requested: "max", supported: ["low", "high"], expected: "high" },
    { requested: "medium", supported: ["low", "high", "max"], expected: "low" },
    { requested: "ultra", supported: ["low", "medium", "high", "xhigh", "max"], expected: "max" },
    { requested: "weird", supported: ["medium", "high"], expected: "medium" },
  ]) {
    assert.equal(clampEffort(row.requested, row.supported), row.expected, JSON.stringify(row));
  }
});

test("only an explicit beta capability forwards anthropic-beta", () => {
  assert.equal(forwardCompatibleHeader("anthropic-beta", STRICT_COMPAT_CAPS), false);
  assert.equal(forwardCompatibleHeader("anthropic-version", STRICT_COMPAT_CAPS), true);
  assert.equal(forwardCompatibleHeader("anthropic-beta", { ...STRICT_COMPAT_CAPS, betas: true }), true);
});

test("provider caps override a preset one field at a time", () => {
  assert.deepEqual(resolveCompatibleCaps({ effortLevels: ["low"], thinking: "enabled", betas: true }, { effortLevels: ["high"], cacheControl: false }), {
    effortLevels: ["high"], thinking: "enabled", betas: true, cacheControl: false,
  });
});
