import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, type Config, type ChatGptProvider } from "../src/config.ts";
import { startAdmin } from "../src/admin.ts";
import { injectBootstrap } from "../src/bootstrap.ts";
import { chatPickerModels, injectPickerModels } from "../src/picker.ts";
import { ChatGptAdapter } from "../src/providers/chatgpt/index.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";

type WindowsResponse = { windows: Record<string, number>; catalogWindows: Record<string, number>; resolvedWindows: Record<string, { model: string; provider: string | null; contextWindow: number | null }> };

test("the real catalogue lookup and probe give bootstrap, picker and admin the effective Codex window", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-window-api-"));
  const previous = { CLAUDERIPPLE_HOME: process.env.CLAUDERIPPLE_HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_SETTINGS_PATH: process.env.CLAUDE_SETTINGS_PATH };
  process.env.CLAUDE_SETTINGS_PATH = path.join(home, "settings.json");
  process.env.CLAUDERIPPLE_HOME = home;
  process.env.CODEX_HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(home, "chatgpt-auth.json"), JSON.stringify({ accessToken: "test-only", accountId: "fixture", expiresAt: Date.now() + 3_600_000, source: "own" }));
  const provider: ChatGptProvider = { type: "chatgpt", auth: "own", url: "https://codex.example.test", models: [
    { id: "gpt-6.1-sol", contextWindow: 272000 },
    { id: "gpt-6-astra", contextWindow: 272000 },
    { id: "unknown-capacity" },
    { id: "provider-only", contextWindow: 123000 },
    { id: "prefix-only", contextWindow: 272000 },
    { id: "unlisted", contextWindow: 234000 },
  ] };
  const cfg: Config = {
    ...DEFAULTS, admin: { port: 0 },
    providers: { chatgpt: provider, other: { type: "openai-compatible", url: "https://other.example.test", models: [{ id: "other-model", contextWindow: 800000 }] } },
    direct: [{ prefix: "gpt-", provider: "chatgpt" }, { prefix: "prefix-", provider: "chatgpt" }],
    aliases: { sol: "gpt-6.1-sol", astra: "gpt-6-astra" },
    routes: {
      "claude-opus-4-8": { provider: "chatgpt", model: "gpt-6-astra" },
      "claude-opus-unknown": { provider: "chatgpt", model: "unknown-capacity" },
      "claude-opus-5": { provider: "chatgpt", model: "gpt-6.1-sol" },
      "claude-sonnet-5": { provider: "chatgpt", model: "gpt-6.1-sol", contextWindow: 600000 },
    },
    cli: { autoCompactWindow: 258400, extraModels: [
      { model: "gpt-6.1-sol", name: "Sol", contextWindow: 272000 },
      { model: "gpt-6-astra", name: "Astra", contextWindow: 272000 },
      { model: "unknown-capacity", name: "Unknown" },
      { model: "sol", name: "Alias", contextWindow: 272000 },
      { model: "prefix-only", name: "Prefix", contextWindow: 272000 },
      { model: "other-model", name: "Other", contextWindow: 700000 },
    ] },
  };
  let catalogueHits = 0;
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://registry.npmjs.org/")) return Response.json({ version: "1.0.0" });
    if (url.startsWith("https://codex.example.test/codex/models?")) {
      catalogueHits++;
      return Response.json({ models: [
        ...["gpt-6.1-sol", "provider-only", "prefix-only"].map(slug => ({ slug, visibility: "list", context_window: 500000, effective_context_window_percent: 95 })),
        // Shape and numbers from the local Codex cache, not an assumed Astra capacity.
        { slug: "gpt-6-astra", visibility: "list", context_window: 272000, effective_context_window_percent: 95 },
      ] });
    }
    assert.ok(url.startsWith("http://127.0.0.1:"), `unexpected network request: ${url}`);
    return nativeFetch(input, init);
  });
  const log = new Logger(null, 1e9, 0, false);
  const adapter = new ChatGptAdapter("chatgpt", provider, home, log);
  const admin = await startAdmin({
    config: () => cfg, configFile: path.join(home, "config.json"), log,
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }), health: () => 0, version: "test",
    requests: new RequestLog(path.join(home, "requests.jsonl")),
    claudeModels: async () => ["claude-opus-5", "claude-opus-4-8", "claude-opus-unknown"].map(id => ({ id, name: "Opus", contextWindow: 1000000, line: "opus" })),
    chatgpt: () => ({ auth: {}, quota: {}, models: () => adapter.fetchModels() }),
  });
  t.after(() => admin.close());
  const base = `http://127.0.0.1:${admin.port}`;
  const readWindows = async (): Promise<WindowsResponse> => {
    const response = await fetch(`${base}/api/context-windows`);
    assert.equal(response.status, 200);
    return response.json() as Promise<WindowsResponse>;
  };
  const before = await readWindows();
  assert.equal(before.windows["gpt-6.1-sol"], 272000, "stored value before any catalogue read");
  assert.deepEqual(before.catalogWindows, {});
  assert.deepEqual(before.resolvedWindows["claude-opus-4-8"], { model: "gpt-6-astra", provider: "chatgpt", contextWindow: 272000, compactWindow: 272000 }, "stored target window beats the native alias before a live catalogue read");
  assert.equal(before.resolvedWindows["claude-opus-unknown"]?.contextWindow, null, "unknown routed capacity cannot inherit the native million");
  assert.equal(before.resolvedWindows["unknown-capacity"]?.contextWindow, null, "global compaction is not a known model capacity");

  const listed = await adapter.fetchModels();
  assert.equal(listed?.find(model => model.id === "gpt-6.1-sol")?.contextWindow, 475000);
  const boot = JSON.parse(injectBootstrap(Buffer.from("{}"), cfg, []).toString()) as {
    auto_compact_windows: Record<string, number>; additional_model_options: { model: string; contextWindow: number }[];
  };
  assert.equal(boot.auto_compact_windows["gpt-6.1-sol"], 475000);
  assert.equal(boot.additional_model_options.find(model => model.model === "gpt-6.1-sol")?.contextWindow, 475000);
  assert.equal(boot.auto_compact_windows["claude-opus-5"], 475000);
  assert.equal(boot.auto_compact_windows["claude-sonnet-5"], 600000, "explicit route override wins");
  const picker: { model_selector_config: { id: string; models: { id: string; name: string; context_window?: number }[]; context_window_by_model: Record<string, number> }[] } = {
    model_selector_config: [{ id: "code", models: [{ id: "claude-opus-5", name: "Opus" }], context_window_by_model: {} }],
  };
  injectPickerModels(picker, chatPickerModels(cfg), cfg.cli.autoCompactWindow);
  assert.equal(picker.model_selector_config[0]!.models.find(model => model.id === "gpt-6.1-sol")?.["context_window"], 475000);
  assert.equal(picker.model_selector_config[0]!.context_window_by_model["gpt-6.1-sol"], 475000);

  const probe = await fetch(`${base}/api/providers/probe`, { method: "POST", body: JSON.stringify({ type: "chatgpt", name: "chatgpt" }) });
  const probed = await probe.json() as { modelsSource: string; models: { id: string; contextWindow: number }[] };
  assert.equal(probed.modelsSource, "catalog");
  assert.equal(probed.models.find(model => model.id === "gpt-6.1-sol")?.contextWindow, 475000);
  assert.equal(catalogueHits, 1, "the probe reuses the adapter's parsed cache");

  const after = await readWindows();
  for (const id of ["gpt-6-astra", "astra", "claude-opus-4-8"]) {
    assert.deepEqual(after.resolvedWindows[id], { model: "gpt-6-astra", provider: "chatgpt", contextWindow: 258400, compactWindow: 258400 });
  }
  assert.equal(after.resolvedWindows["claude-sonnet-5"]?.contextWindow, 600000, "resolved metadata keeps an explicit route override");
  for (const id of ["gpt-6.1-sol", "sol", "provider-only", "prefix-only", "claude-opus-5"]) {
    assert.equal(after.windows[id], 475000, id);
    assert.equal(after.catalogWindows[id], 475000, `${id} is catalogue-backed`);
  }
  assert.equal(after.windows["claude-sonnet-5"], 600000);
  assert.equal(after.catalogWindows["claude-sonnet-5"], undefined, "a route override is not catalogue-owned");
  assert.equal(after.windows["unlisted"], 234000, "no window read for this model: retain stored fallback");
  assert.equal(after.windows["other-model"], 700000, "other providers retain picker override precedence");
  assert.equal(after.catalogWindows["other-model"], undefined);
  assert.equal(after.windows["unknown"], undefined);

  cfg.direct = [{ prefix: "gpt-", provider: "other" }];
  const rerouted = await readWindows();
  assert.equal(rerouted.windows["gpt-6.1-sol"], 272000, "window follows actual serving provider, not GPT name");
  assert.equal(rerouted.catalogWindows["gpt-6.1-sol"], undefined);

  // A window the operator saved on the picker entry is the one the router resolves, everywhere, and
  // the catalogue's own figure stays exposed for the editor's default (2026-10-30).
  cfg.direct = [{ prefix: "gpt-", provider: "chatgpt" }, { prefix: "prefix-", provider: "chatgpt" }];
  cfg.cli.extraModels.find(model => model.model === "gpt-6-astra")!.contextWindow = 300000;
  const overridden = await readWindows();
  assert.equal(overridden.windows["gpt-6-astra"], 300000, "a saved picker override beats the catalogue");
  assert.equal(overridden.windows["astra"], 300000, "the alias too");
  assert.equal(overridden.catalogWindows["gpt-6-astra"], 258400, "the catalogue's figure is still exposed");
  assert.deepEqual(overridden.resolvedWindows["claude-opus-4-8"], { model: "gpt-6-astra", provider: "chatgpt", contextWindow: 300000, compactWindow: 300000 });
  assert.equal(overridden.resolvedWindows["claude-sonnet-5"]?.contextWindow, 600000, "an explicit route window still wins");
  const overflow = JSON.parse(injectBootstrap(Buffer.from("{}"), cfg, []).toString()) as { auto_compact_windows: Record<string, number> };
  assert.equal(overflow.auto_compact_windows["gpt-6-astra"], 300000);
  assert.equal(overflow.auto_compact_windows["claude-opus-4-8"], 300000, "a route's target follows the picker entry");
  assert.equal(overflow.auto_compact_windows["claude-opus-5"], 475000, "untouched picker entries keep the catalogue");
  assert.equal(chatPickerModels(cfg).find(model => model.model === "gpt-6-astra")?.contextWindow, 300000);

  // An empty field stores no override: the entry carries no window and the catalogue is back.
  delete cfg.cli.extraModels.find(model => model.model === "gpt-6-astra")!.contextWindow;
  assert.equal((await readWindows()).windows["gpt-6-astra"], 258400, "no override follows the catalogue again");
});
