import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, providerFor, type Config } from "../src/config.ts";
import { decide, declaredBy, qualifiedModel, resolve, rewriteBody } from "../src/routing.ts";
import { syncAgentFiles, withAgentAliases } from "../src/agents.ts";
import { effortLevelsForModel, startAdmin, type ModOptions } from "../src/admin.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";
import { providerModelWindow } from "../src/picker.ts";
import { chatgptModelWindow, noteChatgptModelWindows } from "../src/providers/chatgpt/windows.ts";
import { buildModelScores } from "../src/model-scores.ts";

const id = "gemini-4-argon";
const cfg: Config = {
  ...DEFAULTS, direct: [], routes: {}, aliases: {},
  providers: {
    "google-gemini": { type: "google", auth: "api-key", apiKey: "test", models: [{ id, effortLevels: ["low", "high"], contextWindow: 1_000_000 }] },
    "opencode-go": { type: "openai-compatible", url: "https://example.invalid", models: [{ id, effortLevels: ["medium", "high"], contextWindow: 200_000, wire: "google", url: "https://relay.invalid/google" }] },
    local: { type: "openai-compatible", url: "http://localhost:1", models: [{ id: "qwen3:8b" }, { id: "unknown:gemini-4-argon" }, { id: "local:missing" }] },
    qwen3: { type: "openai-compatible", url: "http://localhost:2", models: [{ id: "different" }] },
    native: { type: "anthropic", auth: "claude-code", models: [{ id: "claude-opus-5-5" }] },
  },
};
const prompt = (text: string) => ({ messages: [{ role: "user", content: text }] });

test("qualified ids select their declaration, preserve date/effort, and send only the upstream id", () => {
  for (const provider of ["google-gemini", "opencode-go"]) {
    for (const suffix of ["", "-20261025"]) {
      const model = id + suffix;
      const result = resolve(`${provider}:${model}@high`, {}, cfg)!;
      assert.deepEqual([result.provider, result.model, result.effort], [provider, model, "high"]);
      assert.deepEqual(declaredBy(`${provider}:${model}@high`, cfg), [provider]);
      assert.equal(rewriteBody({}, result, cfg.effortClamp).model, model);
      assert.equal(providerFor(cfg.providers[provider]!, result.model).type, "google", "dated ids retain the selected model's wire override");
      assert.equal(decide(`${provider}:${model}@high`, {}, cfg, "turn").refusal, null);
    }
  }
  const result = resolve(`opencode-go:${id}`, {}, cfg)!;
  assert.equal(providerFor(cfg.providers[result.provider]!, result.model).type, "google", "caps/wire lookup receives the original id");
  assert.equal(resolve(`opencode-go:${id}`, {}, { ...cfg, direct: [{ prefix: "opencode-", provider: "google-gemini" }] })?.provider, "opencode-go", "qualification is an explicit provider choice");
});

test("ambiguous bare ids refuse with usable qualified names, including markers on Claude", () => {
  assert.equal(resolve(id, {}, cfg), null);
  for (const [model, body] of [[id, {}], ["claude-opus-5-5", prompt(`[[ripple: ${id}]]`)]] as const) {
    const reason = decide(model, body, cfg, "turn").refusal!;
    assert.match(reason, /google-gemini:gemini-4-argon/);
    assert.match(reason, /opencode-go:gemini-4-argon/);
  }
});

test("a Claude request whose marker is a delegation word or an unknown name still passes through", () => {
  for (const marker of ["[[ripple: standard]]", "[[ripple: light]]", "[[ripple: opus@high]]", "[[ripple: hard backend]]", "[[ripple: nowhere-model]]"]) {
    assert.equal(decide("claude-opus-5-5", prompt(`${marker}\ntask`), cfg, "turn").refusal, null, marker);
  }
});

test("a colon is literal unless the named configured provider declares the remaining model", () => {
  for (const model of ["qwen3:8b", "unknown:gemini-4-argon", "local:missing"]) {
    assert.equal(qualifiedModel(model, cfg), null);
    assert.deepEqual([resolve(model, {}, cfg)?.provider, resolve(model, {}, cfg)?.model], ["local", model]);
  }
  assert.equal(resolve(`qwen3:${id}`, {}, cfg), null);
  assert.equal(qualifiedModel(`qwen3:${id}`, cfg), null);
});

test("qualified ingress-only declarations are refused, not passed through as native Claude", () => {
  assert.equal(resolve("native:claude-opus-5-5@high", {}, cfg), null);
  assert.equal(decide("native:claude-opus-5-5@high", {}, cfg, "turn").refusal, 'provider "native" is ingress-only');
  assert.equal(decide("claude-opus-5-5", {}, cfg, "turn").refusal, null);
});

test("explicit and agent-file marker aliases support qualified ids and effort precedence", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-qualified-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  syncAgentFiles(cfg, dir, undefined, { manifestPath: path.join(dir, "manifest.json") });
  const derived = withAgentAliases(cfg, dir);
  const configured = { ...derived, aliases: { ...derived.aliases, relay: `opencode-go:${id}@medium` } };
  for (const model of ["claude-opus-5-5", `google-gemini:${id}`, "gpt-session"]) {
    const direct = { ...configured, direct: [{ prefix: "gpt-", provider: "local" }] };
    for (const name of ["relay", `${id}-opencode-go`, `opencode-go:${id}`]) {
      const result = resolve(model, prompt(`[[ripple: ${name}@high]] work`), direct)!;
      assert.deepEqual([result.provider, result.model, result.effort], ["opencode-go", id, "high"]);
    }
  }
  assert.equal(resolve("claude-opus-5-5", prompt("[[ripple: relay]]"), configured)?.effort, "medium");
  assert.equal(resolve("claude-opus-5-5", prompt(`[[ripple: ${id}]]`), derived)?.provider, "google-gemini");
});

test("metadata follows the qualified owner rather than the first matching bare id", () => {
  for (const [provider, levels, window] of [["google-gemini", ["low", "high"], 1_000_000], ["opencode-go", ["medium", "high"], 200_000]] as const) {
    const model = `${provider}:${id}-20261025@high`;
    assert.deepEqual(effortLevelsForModel(cfg, model), levels);
    assert.equal(providerModelWindow(cfg, model), window);
  }
  assert.equal(providerModelWindow(cfg, id), undefined, "an ambiguous id has no guessed window");
  assert.equal(effortLevelsForModel(cfg, id), undefined);
  const scored = buildModelScores(cfg, null).models.filter(m => m.model === id);
  assert.deepEqual(scored.map(m => m.provider), ["google-gemini", "opencode-go"]);
  noteChatgptModelWindows([{ id: "shared-gpt", contextWindow: 475_000 }]);
  const chat: Config = { ...cfg, providers: { ...cfg.providers, codex: { type: "chatgpt", models: [{ id: "shared-gpt" }] }, relay: { type: "openai-compatible", url: "http://localhost:1", models: [{ id: "shared-gpt", contextWindow: 100_000 }] } } };
  assert.equal(chatgptModelWindow(chat, "codex:shared-gpt@high"), 475_000);
  assert.equal(chatgptModelWindow(chat, "relay:shared-gpt@high"), undefined);
  assert.equal(providerModelWindow(chat, "relay:shared-gpt@high"), 100_000);
});

test("mod-options and context API retain each worker's real provider and original id", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-qualified-admin-"));
  const previousHome = process.env.CLAUDERIPPLE_HOME;
  const previousSettings = process.env.CLAUDE_SETTINGS_PATH;
  process.env.CLAUDERIPPLE_HOME = home;
  process.env.CLAUDE_SETTINGS_PATH = path.join(home, "settings.json");
  t.after(() => {
    if (previousSettings === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
    else process.env.CLAUDE_SETTINGS_PATH = previousSettings;
    if (previousHome === undefined) delete process.env.CLAUDERIPPLE_HOME;
    else process.env.CLAUDERIPPLE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const agentDir = path.join(home, "agents");
  syncAgentFiles(cfg, agentDir, undefined, { manifestPath: path.join(home, "generated-agents.json") });
  const config = { ...cfg, admin: { port: 0 } };
  const admin = await startAdmin({
    config: () => config, configFile: path.join(home, "config.json"), agentDir,
    log: new Logger(null, 1_000_000, 1, false),
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    health: () => 0, version: "test", requests: new RequestLog(path.join(home, "requests.jsonl")),
    modelScoresFetch: async () => Response.json({}),
    claudeCodeCredentialReaders: { keychain: () => null, credentialsFile: () => null },
  });
  t.after(() => admin.close());
  const options = await (await fetch(`http://127.0.0.1:${admin.port}/api/mod-options`)).json() as ModOptions;
  const twins = options.agents.filter(a => a.model === id);
  assert.deepEqual(twins.map(a => [a.name, a.provider, a.efforts]), [
    [id, "google-gemini", ["low", "high"]], [id + "-opencode-go", "opencode-go", ["medium", "high"]],
  ]);
  assert.deepEqual(options.models.filter(m => m.name === id).map(m => [m.model, m.provider]), [
    [`google-gemini:${id}`, "google-gemini"], [`opencode-go:${id}`, "opencode-go"],
  ]);
  const context = await (await fetch(`http://127.0.0.1:${admin.port}/api/context-windows`)).json() as { windows: Record<string, number>; resolvedWindows: Record<string, { model: string; provider: string | null; contextWindow: number | null }> };
  assert.equal(context.windows[id], undefined, "ambiguous bare ids have no guessed legacy window");
  assert.deepEqual(context.resolvedWindows[`google-gemini:${id}`], { model: id, provider: "google-gemini", contextWindow: 1_000_000, compactWindow: 1_000_000 });
  assert.deepEqual(context.resolvedWindows[`opencode-go:${id}`], { model: id, provider: "opencode-go", contextWindow: 200_000, compactWindow: 200_000 });
});
