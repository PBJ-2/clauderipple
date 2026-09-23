import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexOff, codexOn } from "../src/codex.ts";

test("codex on/off owns only marked provider and profile blocks", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-codex-"));
  const config = path.join(home, "config.toml");
  const profile = path.join(home, "clauderipple.config.toml");
  fs.writeFileSync(config, 'model = "gpt-6-astra"\n[plugins]\nenabled = true\n');
  fs.writeFileSync(profile, 'approval_policy = "never"\n');
  const on = codexOn(18793, home);
  assert.equal(on.changed, true);
  assert.ok(on.backup && fs.existsSync(on.backup));
  assert.match(fs.readFileSync(config, "utf8"), /\[model_providers\.clauderipple\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:18793\/v1"[\s\S]*wire_api = "responses"/);
  assert.match(fs.readFileSync(profile, "utf8"), /approval_policy = "never"[\s\S]*model_provider = "clauderipple"/);
  const off = codexOff(home);
  assert.equal(off.changed, true);
  assert.equal(fs.readFileSync(config, "utf8"), 'model = "gpt-6-astra"\n[plugins]\nenabled = true\n');
  assert.equal(fs.readFileSync(profile, "utf8"), 'approval_policy = "never"\n');
});

test("codex on writes a model catalog from Codex's cache and points config at it; off removes both", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-codex-cat-"));
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, 'model = "gpt-5.5"\n\n[plugins]\nenabled = true\n');
  fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-5.5", display_name: "GPT-5.5", model_messages: { instructions_template: "T" }, priority: 3 },
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", priority: 1 },
  ] }));
  const on = codexOn(18793, home, [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic", effortLevels: ["low", "medium", "high"] }]);
  assert.equal(on.changed, true);
  const text = fs.readFileSync(config, "utf8");
  // Root keys, both before the first table: Codex's own OpenAI provider pointed at the ingress (its
  // GPT turns then take the account pool), and our catalog.
  assert.ok(text.startsWith('# >>> ClaudeRipple OpenAI route >>>\nopenai_base_url = "http://127.0.0.1:18793/v1"\n'), text.slice(0, 120));
  assert.ok(text.includes("# >>> ClaudeRipple Codex model catalog >>>\nmodel_catalog_json = "));
  assert.ok(text.indexOf("model_catalog_json") < text.indexOf("[plugins]"));
  assert.ok(text.indexOf("openai_base_url") < text.indexOf("[plugins]"));
  const catalog = JSON.parse(fs.readFileSync(path.join(home, "clauderipple-models.json"), "utf8")) as { models: Record<string, unknown>[] };
  assert.deepEqual(catalog.models.map((m) => m.slug), ["gpt-5.5", "gpt-6-astra", "claude-sonnet-5"]);
  const ours = catalog.models[2]!;
  assert.equal(ours.display_name, "Claude Sonnet 5");
  assert.deepEqual(ours.model_messages, { instructions_template: "T" });
  assert.deepEqual(ours.supported_reasoning_levels, [{ effort: "low", description: "low" }, { effort: "medium", description: "medium" }, { effort: "high", description: "high" }]);
  assert.equal(ours.supports_parallel_tool_calls, true);
  assert.equal(catalog.models[1]!.base_instructions, "");
  codexOff(home);
  assert.equal(fs.readFileSync(config, "utf8"), 'model = "gpt-5.5"\n\n[plugins]\nenabled = true\n');
  assert.equal(fs.existsSync(path.join(home, "clauderipple-models.json")), false);
});

// Codex saves a model picked from our catalog as its own default, outside our markers. Left behind,
// that reference stopped Codex from loading any configuration at all (issue: "Model provider
// `clauderipple` not found" after turning the Codex client off).
test("codex on never overrides a user's own openai_base_url", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-codex-own-base-"));
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, 'openai_base_url = "https://my-gateway.example/v1"\n');
  codexOn(18793, home);
  const text = fs.readFileSync(config, "utf8");
  assert.equal(text.match(/openai_base_url/g)?.length, 1);
  assert.ok(text.includes("my-gateway.example"));
  codexOff(home);
  assert.equal(fs.readFileSync(config, "utf8"), 'openai_base_url = "https://my-gateway.example/v1"\n');
});

test("codex off clears the selection Codex made from our catalog, so Codex still starts", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-codex-dangling-"));
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, 'model_reasoning_effort = "medium"\nmodel = "claude-sonnet-5"\nmodel_provider = "clauderipple"\n\n[plugins]\nenabled = true\n');
  codexOn(18793, home);
  codexOff(home);
  assert.equal(fs.readFileSync(config, "utf8"), 'model_reasoning_effort = "medium"\n\n[plugins]\nenabled = true\n');
});

test("codex off keeps a model the user chose for someone else's provider", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-codex-theirs-"));
  const config = path.join(home, "config.toml");
  const theirs = 'model = "gpt-6-astra"\nmodel_provider = "openai"\n\n[plugins]\nenabled = true\n';
  fs.writeFileSync(config, theirs);
  codexOn(18793, home);
  codexOff(home);
  assert.equal(fs.readFileSync(config, "utf8"), theirs);
});

test("codex on without a Codex cache installs the provider only and keeps a user's own model_catalog_json", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-codex-nocache-"));
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, 'model_catalog_json = "/mine.json"\n');
  codexOn(18793, home, [{ id: "claude-sonnet-5", provider: "anthropic", effortLevels: [] }]);
  const text = fs.readFileSync(config, "utf8");
  assert.equal(text.split("model_catalog_json").length, 2);
  assert.ok(text.includes("[model_providers.clauderipple]"));
});
