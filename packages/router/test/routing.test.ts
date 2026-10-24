import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, type Config } from "../src/config.ts";
import { continuesTranslatedTurn, markerOverride, resolve, rewriteBody, unroutableReason } from "../src/routing.ts";
import { injectBootstrap } from "../src/bootstrap.ts";
import { withAgentAliases } from "../src/agents.ts";

const cfg: Config = {
  ...DEFAULTS,
  providers: { chatgpt: { type: "anthropic-compatible", url: "http://127.0.0.1:8787" } },
  routes: {
    "claude-opus-4-8": { provider: "chatgpt", model: "gpt-6-astra" },
    "claude-opus-4-6": { provider: "chatgpt", model: "gpt-5.6-terra", effort: "high" },
  },
  direct: [{ prefix: "gpt-", provider: "chatgpt" }],
  aliases: { luna: "gpt-5.6-luna", sol: "gpt-5.6-sol" },
  cli: { extraModels: [{ model: "gpt-5.6-terra@high", name: "GPT-5.6 Terra" }], autoCompactWindow: 258400 },
};

const body = (text: string) => ({ messages: [{ role: "user", content: text }] });

test("Auto mode classifier overrides only its own system request and ignores conversation markers", () => {
  const configured: Config = { ...cfg, autoModeClassifier: { provider: "chatgpt", model: "gpt-6-luna", effort: "low" } };
  const system = "You are a security monitor for autonomous AI coding agents.\n\nEvaluate the action.";
  const request = { system: [{ type: "text", text: "x-anthropic-billing-header: test" }, { type: "text", text: system }], ...body("Quoted by a monitored agent: [[ripple: sol]]") };
  assert.equal(resolve("claude-sonnet-5[1m]", request, configured)?.model, "gpt-6-luna");
  assert.equal(resolve("claude-sonnet-5[1m]", request, configured)?.effort, "low");
  assert.equal(resolve("claude-sonnet-5[1m]", request, cfg), null, "no opt-in preserves native inference");
  assert.equal(resolve("claude-sonnet-5", body(system), configured), null, "quoted user text is not a classifier");
  assert.equal(resolve("gpt-6.1-sol", body("hi"), configured)?.model, "gpt-6.1-sol", "main session keeps its model");
  assert.equal(resolve("claude-sonnet-5", { ...request, tools: [{ name: "Bash" }] }, configured), null, "tool-using main turns do not match");
  assert.equal(resolve("claude-sonnet-5", { ...request, system }, configured)?.model, "gpt-6-luna", "string system is supported");
  const original = { ...request, max_tokens: 4096, thinking: { type: "disabled" } };
  const rewritten = structuredClone(original) as Record<string, unknown>;
  rewriteBody(rewritten, resolve("claude-sonnet-5", original, configured)!, configured.effortClamp);
  assert.deepEqual(rewritten.system, original.system, "security rules are preserved");
  assert.deepEqual(rewritten.messages, original.messages, "monitored context is preserved");
  assert.deepEqual(rewritten.thinking, original.thinking);
  assert.equal(rewritten.max_tokens, original.max_tokens);
});

test("Auto mode classifier sends only the first stage to its stage-1 target", () => {
  // Shapes as CLI 2.1.310 builds them: n is the same thinking allowance on every stage.
  const n = 0;
  const system = "You are a security monitor for autonomous AI coding agents.\n\nEvaluate the action.";
  const classifier = (shape: Record<string, unknown>) => ({ system, ...body("<transcript>…</transcript> Err on the side of blocking."), ...shape });
  const stage1 = classifier({ max_tokens: 64 + n, stop_sequences: ["</block>"] });
  const stage2 = classifier({ max_tokens: 8192 + n });
  const fast = classifier({ max_tokens: 256 + n });
  const severity = classifier({ max_tokens: 64 + n, stop_sequences: ["</severity>"] });
  const configured: Config = {
    ...cfg,
    providers: { ...cfg.providers, cls: { type: "anthropic", auth: "claude-code", accountPool: true } },
    autoModeClassifier: { provider: "chatgpt", model: "gpt-6-luna", effort: "high", stage1: { provider: "cls", model: "claude-sonnet-5-5" } },
  };

  const first = resolve("claude-haiku-5-5", stage1, configured)!;
  assert.deepEqual([first.provider, first.model, first.effort], ["cls", "claude-sonnet-5-5", undefined]);
  assert.match(first.tag, /\(auto-mode classifier, stage 1\)$/);
  for (const [name, request] of [["second stage", stage2], ["fast mode, where yes blocks", fast], ["severity score", severity]] as const) {
    const r = resolve("claude-haiku-5-5", request, configured)!;
    assert.deepEqual([r.provider, r.model, r.effort], ["chatgpt", "gpt-6-luna", "high"], name);
    assert.match(r.tag, /\(auto-mode classifier\)$/, name);
  }
  assert.equal(resolve("claude-haiku-5-5", classifier({ max_tokens: 8192, stop_sequences: ["</block>"] }), configured)!.model, "gpt-6-luna", "a second-stage budget never counts as a first stage");
  assert.equal(resolve("claude-haiku-5-5", classifier({ max_tokens: 64, stop_sequences: ["</block>", "</reason>"] }), configured)!.model, "gpt-6-luna", "only the exact stop list matches");
  assert.equal(resolve("claude-haiku-5-5", { ...stage1, tools: [{ name: "Bash" }] }, configured), null, "a tool-using turn is never a classifier");

  const single: Config = { ...configured, autoModeClassifier: { provider: "chatgpt", model: "gpt-6-luna", effort: "high" } };
  assert.equal(resolve("claude-haiku-5-5", stage1, single)!.model, "gpt-6-luna", "without stage1 both stages keep the main target");
});

test("each side of the Auto mode classifier is the operator's choice, ordinary routing included", () => {
  const system = "You are a security monitor for autonomous AI coding agents.";
  const stage1 = { system, ...body("x"), max_tokens: 64, stop_sequences: ["</block>"] };
  const stage2 = { system, ...body("x"), max_tokens: 8192 };
  const providers = { ...cfg.providers, cls: { type: "anthropic" as const, auth: "claude-code" as const, accountPool: true } };
  const target = (settings: NonNullable<Config["autoModeClassifier"]>, model: string, request: unknown) => {
    const r = resolve(model, request, { ...cfg, providers, autoModeClassifier: settings });
    return r ? `${r.provider}/${r.model}` : "ordinary";
  };

  // One model for both stages: no stage1 needed.
  const haiku = { provider: "cls", model: "claude-haiku-5-5" };
  assert.equal(target(haiku, "claude-sonnet-5", stage1), "cls/claude-haiku-5-5");
  assert.equal(target(haiku, "claude-sonnet-5", stage2), "cls/claude-haiku-5-5");

  // Only the first stage moves; the rest stays as the engine sent it, slot routes and all.
  const firstOnly = { stage1: { provider: "chatgpt", model: "gpt-6-luna" } };
  assert.equal(target(firstOnly, "claude-sonnet-5", stage1), "chatgpt/gpt-6-luna");
  assert.equal(target(firstOnly, "claude-sonnet-5", stage2), "ordinary");
  assert.equal(target(firstOnly, "claude-opus-4-8", stage2), "chatgpt/gpt-6-astra", "an ordinary slot route still applies");

  // Only the rest moves; the first stage is left native.
  const restOnly = { provider: "chatgpt", model: "gpt-6-luna", stage1: "native" as const };
  assert.equal(target(restOnly, "claude-sonnet-5", stage1), "ordinary");
  assert.equal(target(restOnly, "claude-sonnet-5", stage2), "chatgpt/gpt-6-luna");
});

test("unmapped claude model passes through", () => {
  assert.equal(resolve("claude-sonnet-4-6", body("hi"), cfg), null);
  assert.equal(resolve("claude-fable-5-1", body("hi"), cfg), null);
  assert.equal(resolve(undefined, body("hi"), cfg), null);
});

test("picker alias routes with route effort", () => {
  const r = resolve("claude-opus-4-6", body("hi"), cfg)!;
  assert.equal(r.provider, "chatgpt");
  assert.equal(r.model, "gpt-5.6-terra");
  assert.equal(r.effort, "high");
});

test("@effort suffix on an alias wins over route effort", () => {
  assert.equal(resolve("claude-opus-4-6@low", body("hi"), cfg)!.effort, "low");
});

test("direct prefix keeps model, parses @effort", () => {
  const r = resolve("gpt-5.6-sol@medium", body("hi"), cfg)!;
  assert.equal(r.model, "gpt-5.6-sol");
  assert.equal(r.effort, "medium");
});

test("regression: a Claude marker reaches an undeclared target through its direct prefix", () => {
  const configured: Config = { ...cfg, aliases: { sol: "gpt-6.1-sol" } };
  assert.deepEqual(resolve("claude-sonnet-5-5", body("[[ripple: sol@high]] do it"), configured), {
    provider: "chatgpt", model: "gpt-6.1-sol", effort: "high",
    tag: "claude-sonnet-5-5->gpt-6.1-sol (marker)",
  });
});

test("marker overrides direct models only, ignores system-reminder blocks", () => {
  const r = resolve("gpt-5.6-terra@high", body("[[ripple: luna@xhigh]] do it"), cfg)!;
  assert.equal(r.model, "gpt-5.6-luna");
  assert.equal(r.effort, "xhigh");
  const legacy = resolve("gpt-5.6-terra", body("[[gpt: sol]] do it"), cfg)!;
  assert.equal(legacy.model, "gpt-5.6-sol");
  assert.equal(legacy.effort, undefined);
  const quoted = body("<system-reminder>use [[gpt: luna@max]] syntax</system-reminder> hello");
  assert.equal(resolve("gpt-5.6-terra", quoted, cfg)!.model, "gpt-5.6-terra");
  assert.equal(resolve("claude-opus-4-8", body("[[ripple: luna]]"), cfg)!.model, "gpt-6-astra");
});

// A config shaped like a real one: providers that carry their own `models` list (the probe fills it
// from the vendor's /models and the GUI ticks it), one id offered by two of them, and the native
// `anthropic` provider that exists for the OpenAI ingress and lists the Claude models.
const declared: Config = {
  ...DEFAULTS,
  providers: {
    chatgpt: { type: "chatgpt", models: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6-luna" }] },
    "opencode-go": { type: "openai-compatible", url: "http://127.0.0.1:8788", wire: "chat", models: [{ id: "kimi-k3" }, { id: "deepseek-v4-pro" }] },
    deepseek: { type: "anthropic-compatible", url: "http://127.0.0.1:8789", models: [{ id: "deepseek-v4-pro" }] },
    anthropic: { type: "anthropic", auth: "claude-code", models: [{ id: "claude-opus-5" }, { id: "claude-haiku-4-5" }] },
  },
  routes: { "claude-opus-4-8": { provider: "chatgpt", model: "gpt-5.6-terra" } },
  direct: [{ prefix: "gpt-", provider: "chatgpt" }],
  aliases: { luna: "gpt-5.6-luna", k3: "kimi-k3" },
};

test("a model only one provider carries routes there without a rule", () => {
  const r = resolve("kimi-k3", body("hi"), declared)!;
  assert.equal(r.provider, "opencode-go");
  assert.equal(r.model, "kimi-k3", "the model is not rewritten: the provider serves it under its own name");
  assert.equal(resolve("kimi-k3@low", body("hi"), declared)!.effort, "low");
});

test("a model two providers carry still needs the operator to say which", () => {
  assert.equal(resolve("deepseek-v4-pro", body("hi"), declared), null, "guessing would send traffic to a vendor nobody chose");
});

test("the native anthropic provider's models are not a routing target until its account pool is enabled", () => {
  // The §5 failure this protects: a slot pointed at an ingress-only provider made every Claude
  // request fail with 400. Auto-routing is safe only after the explicit account-pool opt-in.
  assert.equal(resolve("claude-opus-5", body("hi"), declared), null);
  assert.equal(resolve("claude-haiku-4-5-20251001", body("hi"), declared), null, "dated form too");
  const pooled: Config = {
    ...declared,
    providers: {
      ...declared.providers,
      anthropic: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-opus-5" }, { id: "claude-haiku-4-5" }] },
    },
  };
  assert.equal(resolve("claude-opus-5", body("hi"), pooled)?.provider, "anthropic");
  assert.equal(resolve("claude-haiku-4-5-20251001", body("hi"), pooled)?.provider, "anthropic");
});

test("rules still win over what a provider declares", () => {
  // chatgpt carries gpt-5.6-terra AND a direct prefix rule covers it; the rule decides.
  assert.equal(resolve("gpt-5.6-terra", body("hi"), declared)!.provider, "chatgpt");
  assert.equal(resolve("claude-opus-4-8", body("hi"), declared)!.model, "gpt-5.6-terra", "a slot alias is still an alias");
  // A prefix rule reaches models no provider declares — that is why rules are not redundant.
  assert.equal(resolve("gpt-7-unreleased", body("hi"), declared)!.provider, "chatgpt");
});

test("an unknown model still passes through to Anthropic", () => {
  assert.equal(resolve("some-model-nobody-has", body("hi"), declared), null);
});

test("a marker on an auto-routed model picks the overridden model's own provider", () => {
  const r = resolve("kimi-k3", body("[[ripple: luna@high]] do it"), declared)!;
  assert.equal(r.model, "gpt-5.6-luna");
  assert.equal(r.provider, "chatgpt", "the override names the model, and the model names the provider");
  assert.equal(r.effort, "high");
});

test("marker only scans the first five user messages", () => {
  const msgs = { messages: Array.from({ length: 7 }, (_, i) => ({ role: "user", content: i === 6 ? "[[ripple: sol]]" : "x" })) };
  assert.equal(markerOverride(msgs, cfg.aliases), null);
});

test("rewriteBody sets model, effort and clamps ultra", () => {
  const j = rewriteBody({ model: "claude-opus-4-8", output_config: { effort: "ultra" } }, resolve("claude-opus-4-8", body("hi"), cfg)!, cfg.effortClamp);
  assert.equal(j.model, "gpt-6-astra");
  assert.deepEqual(j.output_config, { effort: "max" });
  const k = rewriteBody({ model: "x" }, { provider: "chatgpt", model: "m", effort: undefined, tag: "" }, cfg.effortClamp);
  assert.equal("output_config" in k, false);
});

test("bootstrap injection adds CLI models and compaction windows", () => {
  const out = JSON.parse(injectBootstrap(Buffer.from(JSON.stringify({ additional_model_options: [{ model: "a", name: "A" }], auto_compact_windows: { a: 1 } })), cfg, []).toString());
  assert.equal(out.additional_model_options.length, 2);
  assert.equal(out.auto_compact_windows["gpt-5.6-terra@high"], 258400);
  assert.equal(out.auto_compact_windows["claude-opus-4-8"], 258400);
  assert.equal(out.auto_compact_windows.a, 1);
  const raw = Buffer.from("not json");
  assert.equal(injectBootstrap(raw, cfg), raw);
});

test("bootstrap supplies missing descriptions without changing existing options or config", () => {
  const configured: Config = {
    ...cfg,
    cli: {
      extraModels: [
        { model: "gpt-default", name: "Default description", contextWindow: 400_000 },
        { model: "gpt-described", name: "Display name", description: "Explicit description" },
        { model: "gpt-empty", name: "Empty description", description: "" },
      ],
    },
  };
  const before = structuredClone(configured);
  const existing = [{ model: "native", name: "Native", description: "Upstream description", disabled_reason: "Unavailable" }];
  const out = JSON.parse(injectBootstrap(Buffer.from(JSON.stringify({ additional_model_options: existing })), configured, []).toString());
  assert.deepEqual(out.additional_model_options, [
    ...existing,
    { model: "gpt-default", name: "Default description", contextWindow: 400_000, description: "Default description" },
    { model: "gpt-described", name: "Display name", description: "Explicit description" },
    { model: "gpt-empty", name: "Empty description", description: "" },
  ]);
  assert.equal(out.auto_compact_windows["gpt-default"], 400_000);
  assert.deepEqual(configured, before, "bootstrap normalization does not mutate the config");
});

test("each routed model and slot keeps its own compaction window; the global value is only the fallback", () => {
  const perModel: Config = {
    ...cfg,
    routes: {
      "claude-opus-4-8": { provider: "chatgpt", model: "gpt-6-astra", contextWindow: 1_000_000 },
      "claude-opus-4-6": { provider: "chatgpt", model: "gpt-5.6-terra", effort: "high" },
    },
    cli: { extraModels: [{ model: "gpt-5.6-terra@high", name: "GPT-5.6 Terra", contextWindow: 400_000 }, { model: "gpt-6-astra@high", name: "GPT-6 Astra" }], autoCompactWindow: 258400 },
  };
  const out = JSON.parse(injectBootstrap(Buffer.from(JSON.stringify({})), perModel, []).toString());
  assert.equal(out.auto_compact_windows["gpt-5.6-terra@high"], 400_000);
  assert.equal(out.auto_compact_windows["gpt-6-astra@high"], 258400, "no own window → global fallback");
  assert.equal(out.auto_compact_windows["claude-opus-4-8"], 1_000_000, "slot carries its own");
  assert.equal(out.auto_compact_windows["claude-opus-4-6"], 258400);
});

test("a picker model with no window of its own takes its provider's before the global fallback", () => {
  const fromProvider: Config = {
    ...cfg,
    routes: {},
    providers: { ...cfg.providers, go: { type: "openai-compatible", url: "https://example.test/v1", models: [{ id: "minimax-m3.1-flash-free", contextWindow: 1_000_000 }] } },
    cli: { extraModels: [{ model: "minimax-m3.1-flash-free", name: "MiniMax" }, { model: "gpt-6-astra@high", name: "GPT-6 Astra" }], autoCompactWindow: 258400 },
  };
  const out = JSON.parse(injectBootstrap(Buffer.from(JSON.stringify({})), fromProvider, []).toString());
  assert.equal(out.auto_compact_windows["minimax-m3.1-flash-free"], 1_000_000, "the provider declared 1M");
  assert.equal(out.auto_compact_windows["gpt-6-astra@high"], 258400, "nobody declared one → global fallback");
});

test("a per-model window applies even with no global autoCompactWindow", () => {
  const noGlobal: Config = {
    ...cfg,
    routes: { "claude-opus-4-8": { provider: "chatgpt", model: "gpt-6-astra" } },
    cli: { extraModels: [{ model: "gpt-5.6-terra@high", name: "GPT-5.6 Terra", contextWindow: 400_000 }] },
  };
  const out = JSON.parse(injectBootstrap(Buffer.from(JSON.stringify({})), noGlobal, []).toString());
  assert.equal(out.auto_compact_windows["gpt-5.6-terra@high"], 400_000);
  assert.equal("claude-opus-4-8" in out.auto_compact_windows, false, "nothing to say about it → say nothing");
});

test("thread: continue is refused with the CLI's error code, create is stripped", async () => {
  const { threadDecision, stripThreadFields, THREAD_UNSUPPORTED } = await import("../src/routing.ts");
  assert.equal(threadDecision({ thread: { type: "continue", previous_message_id: "msg_1" } }), "refuse");
  assert.equal(threadDecision({ thread: { type: "create" } }), "strip");
  assert.equal(threadDecision({}), "none");
  const j: Record<string, unknown> = { thread: { type: "create" }, diagnostics: { previous_message_id: null }, model: "x" };
  stripThreadFields(j);
  assert.deepEqual(j, { model: "x" });
  assert.equal((THREAD_UNSUPPORTED.error as { details: { error_code: string } }).details.error_code, "thread_unsupported_request");
});

test("bootstrap injects agent-file model ids (with @effort) when their base is routable", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { injectBootstrap } = await import("../src/bootstrap.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-agents-"));
  fs.writeFileSync(path.join(dir, "gpt.md"), "---\nname: gpt\nmodel: gpt-5.6-terra@high\n---\n");
  fs.writeFileSync(path.join(dir, "other.md"), "---\nname: o\nmodel: sonnet\n---\n");
  const cfg = { ...DEFAULTS, providers: {}, routes: {}, aliases: {}, direct: [{ prefix: "gpt-", provider: "chatgpt" }], cli: { extraModels: [{ model: "gpt-5.6-terra", name: "GPT-5.6 Terra" }] } } as unknown as Config;
  const out = JSON.parse(injectBootstrap(Buffer.from("{}"), cfg, [dir]).toString()) as { additional_model_options: { model: string; name: string; description: string }[] };
  assert.deepEqual(out.additional_model_options.map((m) => m.model), ["gpt-5.6-terra", "gpt-5.6-terra@high"]);
  assert.equal(out.additional_model_options[1]!.name, "GPT-5.6 Terra · high");
  assert.deepEqual(out.additional_model_options.map((m) => m.description), ["GPT-5.6 Terra", "GPT-5.6 Terra · high"]);
});

test("a dated model id matches its undated mapping", () => {
  const dated: Config = { ...cfg, routes: { ...cfg.routes, "claude-haiku-4-5": { provider: "chatgpt", model: "gpt-5.6-terra" } } };
  // The app sends Haiku with a date suffix but the GUI only offers the undated id.
  const r = resolve("claude-haiku-4-5-20251001", body("hi"), dated)!;
  assert.equal(r.model, "gpt-5.6-terra");
  // An exact key still wins, and a bare date-shaped tail is not invented out of nothing.
  assert.equal(resolve("claude-sonnet-4-6-20250101", body("hi"), dated), null);
});

test("a rule naming a native anthropic provider is ignored, not routed", () => {
  const native: Config = {
    ...cfg,
    providers: { ...cfg.providers, native: { type: "anthropic", auth: "claude-code" } },
    routes: { "claude-opus-5": { provider: "native", model: "claude-opus-5" } },
    direct: [{ prefix: "claude-haiku", provider: "native" }],
  };
  assert.equal(resolve("claude-opus-5", body("hi"), native), null);
  assert.equal(resolve("claude-haiku-4-5-20251001", body("hi"), native), null);
});

test("an ignored direct rule does not fall through to a mapping", () => {
  // The direct rule still decides; it is simply unusable, so the request passes through. Falling
  // back to `routes` would send a model the user pointed elsewhere to a translating provider.
  const native: Config = {
    ...cfg,
    providers: { ...cfg.providers, native: { type: "anthropic", auth: "claude-code" } },
    routes: { "claude-haiku-4-5": { provider: "chatgpt", model: "gpt-5.6-terra" } },
    direct: [{ prefix: "claude-haiku-", provider: "native" }],
  };
  assert.equal(resolve("claude-haiku-4-5-20251001", body("hi"), native), null);
});

// ---- agent-derived aliases and the refusal reason ------------------------------------

test("a marker naming an agent file resolves through the derived alias", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-routing-agents-"));
  // An agent file named `deepseek`, whose model one provider declares. Before the derivation this
  // exact shape resolved to the literal id "deepseek", which no provider declared → PASS → 404.
  fs.writeFileSync(path.join(dir, "deepseek.md"), "---\nname: deepseek\nmodel: deepseek-v4-pro@medium\n---\n");
  const cfg = withAgentAliases(declared, dir);
  assert.equal(cfg.aliases.deepseek, "deepseek-v4-pro");

  // The marker now resolves to a real id. `deepseek-v4-pro` is offered by two providers in
  // `declared`, so it is still ambiguous — the alias resolves, and the ambiguity is what stops it.
  const reason = unroutableReason("vendor-model", body("[[ripple: deepseek@high]] do it"), cfg);
  assert.equal(reason, '"deepseek-v4-pro" is declared by two providers (opencode-go, deepseek); add a route or direct rule');
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a marker naming an agent file routes when exactly one provider declares its model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-routing-agents2-"));
  fs.writeFileSync(path.join(dir, "kimi.md"), "---\nname: kimi\nmodel: kimi-k3@low\n---\n");
  const cfg = withAgentAliases(declared, dir);
  const r = resolve("some-unknown-model", body("[[ripple: kimi@high]] do it"), cfg)!;
  assert.equal(r.provider, "opencode-go");
  assert.equal(r.model, "kimi-k3");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unroutableReason: marker alias that resolves to an undeclared model", () => {
  const cfg: Config = { ...declared, aliases: { ...declared.aliases, deepseek: "deepseek-v4-pro" } };
  // Two providers declare it → the ambiguity message, not the "undeclared" one.
  assert.equal(unroutableReason("whatever", body("[[ripple: deepseek@high]]"), cfg),
    '"deepseek-v4-pro" is declared by two providers (opencode-go, deepseek); add a route or direct rule');
  // An alias pointing at a model nobody has.
  const ghost: Config = { ...declared, aliases: { ...declared.aliases, ghost: "no-such-model" } };
  assert.equal(unroutableReason("whatever", body("[[ripple: ghost]]"), ghost),
    'marker alias "ghost" resolves to "no-such-model", which no provider declares');
});

test("unroutableReason: a marker name that is neither alias nor agent", () => {
  assert.equal(unroutableReason("whatever", body("[[ripple: nobody@high]]"), declared),
    'marker alias "nobody" is not an alias and not an agent name');
});

test("unroutableReason: two providers declare the named model", () => {
  assert.equal(unroutableReason("deepseek-v4-pro", body("hi"), declared),
    '"deepseek-v4-pro" is declared by two providers (opencode-go, deepseek); add a route or direct rule');
});

test("unroutableReason: no provider declares it, and an ingress-only provider is named", () => {
  assert.equal(unroutableReason("some-model-nobody-has", body("hi"), declared), 'no provider declares "some-model-nobody-has"');
  // A model only the native anthropic provider lists: the provider is named, not the model.
  const onlyNative: Config = {
    ...DEFAULTS,
    providers: { anthropic: { type: "anthropic", auth: "claude-code", models: [{ id: "claude-haiku-4-5" }] } },
    routes: {}, direct: [], aliases: {},
  };
  assert.equal(unroutableReason("claude-haiku-4-5", body("hi"), onlyNative), null, "a claude-* id is never a refusal");
  const nonClaudeNative: Config = {
    ...DEFAULTS,
    providers: { anthropic: { type: "anthropic", auth: "claude-code", models: [{ id: "vendor-model" }] } },
    routes: {}, direct: [], aliases: {},
  };
  assert.equal(unroutableReason("vendor-model", body("hi"), nonClaudeNative), 'provider "anthropic" is ingress-only');
});

test("unroutableReason is null for a routable model, a rule, and every claude-* id", () => {
  assert.equal(unroutableReason("kimi-k3", body("hi"), declared), null, "routable");
  assert.equal(unroutableReason("gpt-7-unreleased", body("hi"), declared), null, "a direct rule decides");
  assert.equal(unroutableReason("claude-opus-5", body("hi"), declared), null);
  assert.equal(resolve("claude-opus-5", body("hi"), declared), null, "and resolve agrees it is unrouted");
  assert.equal(unroutableReason(undefined, body("hi"), declared), null);
});

// 2026-09-20: a GPT-6 Astra session (prefix rule → chatgpt) delegated to `muse`; the marker changed
// the model but the provider stayed `chatgpt`, which answered 400 "muse … is not supported". And the
// marker it acted on was a quote inside a compaction summary, not a task prompt.
test("a marker's model takes its own provider, even under a prefix rule on the session model", () => {
  const cfg2: Config = {
    ...DEFAULTS,
    providers: {
      chatgpt: { type: "chatgpt", models: [{ id: "gpt-6-astra" }] },
      opencode: { type: "openai-compatible", url: "http://x", models: [{ id: "muse-spark-1.3-contributor" }] },
    },
    routes: {},
    direct: [{ prefix: "gpt-", provider: "chatgpt" }],
    aliases: { muse: "muse-spark-1.3-contributor" },
  };
  const r = resolve("gpt-6-astra", body("[[ripple: muse@high]]\n\nbuild it"), cfg2)!;
  assert.equal(r.provider, "opencode");
  assert.equal(r.model, "muse-spark-1.3-contributor");
  assert.equal(r.effort, "high");
  assert.equal(r.tag, "gpt-6-astra->muse-spark-1.3-contributor (marker)", "the log says a marker decided (issue #13)");
  // A marker naming a gpt-* model still goes to the prefix rule's provider.
  assert.equal(resolve("gpt-6-astra", body("[[ripple: gpt-5.6-sol@low]] x"), cfg2)!.provider, "chatgpt");
  // A marker to a model nobody declares is a refusal, with the reason, not a 400 from ChatGPT.
  assert.equal(resolve("gpt-6-astra", body("[[ripple: ghost@high]] x"), cfg2), null);
  assert.equal(unroutableReason("gpt-6-astra", body("[[ripple: ghost@high]] x"), cfg2),
    'marker alias "ghost" is not an alias and not an agent name');
  // …but without a marker a prefix rule is never second-guessed here.
  assert.equal(unroutableReason("gpt-6-astra", body("x"), cfg2), null);
});

test("a marker counts only at the top of a user message; a quoted one is prose", () => {
  const summary = "This session is being continued from a previous conversation.\n\nSummary: the user ran " +
    "[[ripple: muse@high]] to build the intro page …";
  assert.equal(markerOverride(body(summary), cfg.aliases), null);
  assert.equal(resolve("gpt-6-astra", body(summary), cfg)!.model, "gpt-6-astra");
  assert.equal(markerOverride(body("  \n[[ripple: luna@low]]\n\ntask"), cfg.aliases)?.model, "gpt-5.6-luna", "leading whitespace is fine");
  assert.equal(markerOverride(body("<system-reminder>x</system-reminder>[[ripple: luna]] task"), cfg.aliases)?.model, "gpt-5.6-luna", "a stripped reminder does not push it off the top");
});

// The frame as CLI 2.1.308 sent it to a Workflow agent on 2026-10-22 (relayed request shortened).
test("a Workflow agent's marker is the top of the script's text, under the harness frame", () => {
  const request = "[Workflow harness — user request] The harness relays, verbatim and indented below, the user request that triggered this workflow run. …\n  병렬로 여러개 돌려서 나눠서 시켜";
  const task = "[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. … The computed task text follows:\n  [[ripple: luna@high]]\n  역할: 한국어 교정자.";
  const two = { messages: [{ role: "user", content: request }, { role: "user", content: task }] };
  assert.deepEqual(markerOverride(two, cfg.aliases), { model: "gpt-5.6-luna", effort: "high" });
  const merged = { messages: [{ role: "user", content: [{ type: "text", text: request }, { type: "text", text: task }] }] };
  assert.deepEqual(markerOverride(merged, cfg.aliases), { model: "gpt-5.6-luna", effort: "high" }, "the two turns sent as one message");
  assert.equal(resolve("claude-opus-5-5", two, declared)?.model, "gpt-5.6-luna");
  const quoted = task.replace("[[ripple: luna@high]]\n  역할", "역할: [[ripple: luna@high]]");
  assert.equal(markerOverride(body(quoted), cfg.aliases), null, "inside the script's text, below its top, it is prose");
  assert.equal(markerOverride(body(`Summary: …\n${task}`), cfg.aliases), null, "a frame quoted below the top is not a frame");
});

// A workflow worker's continue carries no marker; when the turn before it was translated, Anthropic
// has no such thread (404 on every turn, 2026-10-23), so it is recognised by the id we minted.
test("a continue of a turn this router minted is recognised; Anthropic's own ids and creates are not", () => {
  assert.equal(continuesTranslatedTurn({ thread: { type: "continue", previous_message_id: "msg_8f46eee3c1a01d63c54f683e" } }), true);
  assert.equal(continuesTranslatedTurn({ thread: { type: "continue", previous_message_id: "msg_011CgJN1qQSD73cvPhge2Cri" } }), false);
  assert.equal(continuesTranslatedTurn({ thread: { type: "create" } }), false);
  assert.equal(continuesTranslatedTurn({}), false);
});
