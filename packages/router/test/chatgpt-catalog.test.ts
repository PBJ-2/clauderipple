import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHATGPT_FALLBACK_MODELS, CODEX_CLIENT_VERSION_FLOOR, codexClientVersion, parseCodexCatalog } from "../src/providers/chatgpt/catalog.ts";

function withCodexHome(fn: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-codex-home-"));
  try {
    fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeCache(home: string, clientVersion: unknown): void {
  fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ client_version: clientVersion }));
}

test("parseCodexCatalog keeps listed models, drops hidden ones and formats names", () => {
  const models = parseCodexCatalog({
    models: [
      {
        slug: "gpt-6-sol",
        display_name: "GPT-6-Sol",
        visibility: "list",
        supported_in_api: true,
        context_window: 272000,
        supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "ultra", description: "Deepest" }],
      },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", context_window: 272000, supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "gpt-reserve", visibility: "hide" },
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", context_window: 272000, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }] },
    ],
  });
  assert.deepEqual(models.map((m) => m.id), ["gpt-6-sol", "gpt-5.5"], "hidden entries must not reach the picker");
  assert.equal(models[0]!.name, "GPT-6 Sol", "a hyphen before a capital reads as a space");
  assert.equal(models[1]!.name, "GPT-5.5", "a numeric suffix is not a joining hyphen");
  assert.deepEqual(models[0]!.effortLevels, ["low", "ultra"]);
  assert.equal(models[0]!.contextWindow, 272000);
  assert.deepEqual(models[1]!.effortLevels, ["low", "medium", "high", "xhigh"]);
});

test("parseCodexCatalog tolerates garbage and missing fields", () => {
  assert.deepEqual(parseCodexCatalog(null), []);
  assert.deepEqual(parseCodexCatalog("not json"), []);
  assert.deepEqual(parseCodexCatalog({}), []);
  assert.deepEqual(parseCodexCatalog({ models: "nope" }), []);
  assert.deepEqual(parseCodexCatalog({ models: [null, 7, "x", { display_name: "no slug", visibility: "list" }, { slug: "no-visibility" }] }), []);
  // A slug alone is enough; the display name falls back to it, and an absent ladder stays absent.
  const bare = parseCodexCatalog({ models: [{ slug: "gpt-6-luna", visibility: "list" }] });
  assert.deepEqual(bare, [{ id: "gpt-6-luna", name: "gpt-6-luna" }]);
  // A non-positive or non-numeric window is not carried.
  const odd = parseCodexCatalog({ models: [{ slug: "m", visibility: "list", context_window: 0 }, { slug: "n", visibility: "list", context_window: "272000" }] });
  assert.equal(odd[0]!.contextWindow, undefined);
  assert.equal(odd[1]!.contextWindow, undefined);
});

test("codexClientVersion floors without a cache file and honours a newer one", () => {
  withCodexHome((home) => {
    assert.equal(codexClientVersion(home), CODEX_CLIENT_VERSION_FLOOR);
    writeCache(home, "0.155.0");
    assert.equal(codexClientVersion(home), CODEX_CLIENT_VERSION_FLOOR, "equal to the floor is the floor");
    writeCache(home, "0.160.2");
    assert.equal(codexClientVersion(home), "0.160.2");
    // A lower cache version must not cost us the models the backend would list.
    writeCache(home, "0.146.0");
    assert.equal(codexClientVersion(home), CODEX_CLIENT_VERSION_FLOOR);
    // A prerelease suffix is not part of the version.
    writeCache(home, "0.155.1-nightly.3");
    assert.equal(codexClientVersion(home), "0.155.1");
    writeCache(home, "nonsense");
    assert.equal(codexClientVersion(home), CODEX_CLIENT_VERSION_FLOOR);
  });
  withCodexHome((home) => {
    fs.writeFileSync(path.join(home, "models_cache.json"), "{ not json");
    assert.equal(codexClientVersion(home), CODEX_CLIENT_VERSION_FLOOR);
  });
});

test("the fallback catalogue carries the measured ladders", () => {
  const byId = new Map(CHATGPT_FALLBACK_MODELS.map((m) => [m.id, m]));
  assert.deepEqual([...byId.keys()], ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
  assert.deepEqual(byId.get("gpt-5.6-terra")!.effortLevels, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(byId.get("gpt-5.6-sol")!.effortLevels, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(byId.get("gpt-6-sol")!.effortLevels, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(byId.get("gpt-6-astra")!.effortLevels, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(byId.get("gpt-5.6-luna")!.effortLevels, ["low", "medium", "high", "xhigh", "max"], "Luna takes no ultra");
  assert.deepEqual(byId.get("gpt-6-luna")!.effortLevels, ["low", "medium", "high", "xhigh", "max"], "Luna takes no ultra");
  assert.equal(byId.get("gpt-5.6-luna")!.contextWindow, 272000);
});
