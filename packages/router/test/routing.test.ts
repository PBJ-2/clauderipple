import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, type Config } from "../src/config.ts";
import { markerOverride, resolve, rewriteBody, unroutableReason } from "../src/routing.ts";
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
    "opencode-go-chat": { type: "openai-compatible", url: "http://127.0.0.1:8788", wire: "chat", models: [{ id: "kimi-k3" }, { id: "deepseek-v4-pro" }] },
    deepseek: { type: "anthropic-compatible", url: "http://127.0.0.1:8789", models: [{ id: "deepseek-v4-pro" }] },
    anthropic: { type: "anthropic", auth: "claude-code", models: [{ id: "claude-opus-5" }, { id: "claude-haiku-4-5" }] },
  },
  routes: { "claude-opus-4-8": { provider: "chatgpt", model: "gpt-5.6-terra" } },
  direct: [{ prefix: "gpt-", provider: "chatgpt" }],
  aliases: { luna: "gpt-5.6-luna", k3: "kimi-k3" },
};

test("a model only one provider carries routes there without a rule", () => {
  const r = resolve("kimi-k3", body("hi"), declared)!;
  assert.equal(r.provider, "opencode-go-chat");
  assert.equal(r.model, "kimi-k3", "the model is not rewritten: the provider serves it under its own name");
  assert.equal(resolve("kimi-k3@low", body("hi"), declared)!.effort, "low");
});

test("a model two providers carry still needs the operator to say which", () => {
  assert.equal(resolve("deepseek-v4-pro", body("hi"), declared), null, "guessing would send traffic to a vendor nobody chose");
});

test("the native anthropic provider's models are not a routing target", () => {
  // The §5 failure this protects: a slot pointed at an ingress-only provider made every Claude
  // request fail with 400. Auto-routing would have done it to a whole session without a rule.
  assert.equal(resolve("claude-opus-5", body("hi"), declared), null);
  assert.equal(resolve("claude-haiku-4-5-20251001", body("hi"), declared), null, "dated form too");
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
  const out = JSON.parse(injectBootstrap(Buffer.from("{}"), cfg, [dir]).toString()) as { additional_model_options: { model: string; name: string }[] };
  assert.deepEqual(out.additional_model_options.map((m) => m.model), ["gpt-5.6-terra", "gpt-5.6-terra@high"]);
  assert.equal(out.additional_model_options[1]!.name, "GPT-5.6 Terra · high");
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
  assert.equal(reason, '"deepseek-v4-pro" is declared by two providers (opencode-go-chat, deepseek); add a route or direct rule');
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a marker naming an agent file routes when exactly one provider declares its model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-routing-agents2-"));
  fs.writeFileSync(path.join(dir, "kimi.md"), "---\nname: kimi\nmodel: kimi-k3@low\n---\n");
  const cfg = withAgentAliases(declared, dir);
  const r = resolve("some-unknown-model", body("[[ripple: kimi@high]] do it"), cfg)!;
  assert.equal(r.provider, "opencode-go-chat");
  assert.equal(r.model, "kimi-k3");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unroutableReason: marker alias that resolves to an undeclared model", () => {
  const cfg: Config = { ...declared, aliases: { ...declared.aliases, deepseek: "deepseek-v4-pro" } };
  // Two providers declare it → the ambiguity message, not the "undeclared" one.
  assert.equal(unroutableReason("whatever", body("[[ripple: deepseek@high]]"), cfg),
    '"deepseek-v4-pro" is declared by two providers (opencode-go-chat, deepseek); add a route or direct rule');
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
    '"deepseek-v4-pro" is declared by two providers (opencode-go-chat, deepseek); add a route or direct rule');
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
