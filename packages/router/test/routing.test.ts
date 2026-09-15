import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, type Config } from "../src/config.ts";
import { markerOverride, resolve, rewriteBody } from "../src/routing.ts";
import { injectBootstrap } from "../src/bootstrap.ts";

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
