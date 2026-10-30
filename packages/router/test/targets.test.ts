import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { answersWebSearch, ingressOnly, isTargetProvider, runsServerTools, targetWarnings } from "../src/targets.ts";

function config(providers: Config["providers"]): Config {
  return { ...DEFAULTS, providers };
}

test("isTargetProvider identifies every provider kind and ingressOnly ignores unknown names", () => {
  assert.equal(isTargetProvider(undefined), false);
  assert.equal(isTargetProvider({ type: "anthropic", auth: "claude-code" }), false);
  assert.equal(isTargetProvider({ type: "anthropic", auth: "claude-code", accountPool: true }), true);
  assert.equal(isTargetProvider({ type: "anthropic", auth: "api-key", accountPool: true }), false);

  const others: Provider[] = [
    { type: "anthropic-compatible", url: "https://example.test" },
    { type: "chatgpt" },
    { type: "openai-compatible", url: "https://example.test" },
    { type: "google", auth: "api-key" },
    { type: "grok" },
  ];
  for (const provider of others) assert.equal(isTargetProvider(provider), true, provider.type);

  const cfg = config({
    ingress: { type: "anthropic", auth: "claude-code" },
    pool: { type: "anthropic", auth: "claude-code", accountPool: true },
    invalidPool: { type: "anthropic", auth: "api-key", accountPool: true },
    compatible: { type: "anthropic-compatible", url: "https://example.test" },
  });
  assert.equal(ingressOnly(cfg, "missing"), false);
  assert.equal(ingressOnly(cfg, "ingress"), true);
  assert.equal(ingressOnly(cfg, "pool"), false);
  assert.equal(ingressOnly(cfg, "invalidPool"), true);
  assert.equal(ingressOnly(cfg, "compatible"), false);
});

test("runsServerTools and answersWebSearch preserve provider search capabilities", () => {
  const cfg = config({
    ingress: { type: "anthropic", auth: "claude-code" },
    pool: { type: "anthropic", auth: "claude-code", accountPool: true },
    invalidPool: { type: "anthropic", auth: "api-key", accountPool: true },
    measured: { type: "anthropic-compatible", url: "https://example.test", preset: "deepseek" },
    explicit: { type: "anthropic-compatible", url: "https://example.test", caps: { serverTools: true } },
    compatible: { type: "anthropic-compatible", url: "https://example.test" },
    chatgpt: { type: "chatgpt" },
    openai: { type: "openai-compatible", url: "https://example.test" },
    google: { type: "google", auth: "api-key" },
    grok: { type: "grok" },
  });

  for (const name of ["missing", "ingress", "invalidPool", "compatible", "openai", "google", "grok"]) {
    assert.equal(runsServerTools(cfg, name), false, `${name} does not run server tools`);
    assert.equal(answersWebSearch(cfg, name), false, `${name} does not answer web search`);
  }
  for (const name of ["pool", "measured", "explicit"]) {
    assert.equal(runsServerTools(cfg, name), true, `${name} runs server tools`);
    assert.equal(answersWebSearch(cfg, name), true, `${name} answers web search`);
  }
  assert.equal(runsServerTools(cfg, "chatgpt"), false, "ChatGPT search is hosted rather than an Anthropic server tool");
  assert.equal(answersWebSearch(cfg, "chatgpt"), true);
});

test("targetWarnings reports accepted primary and direct ingress-only rules only", () => {
  const cfg: Config = {
    ...config({
      ingress: { type: "anthropic", auth: "api-key" },
      pool: { type: "anthropic", auth: "claude-code", accountPool: true },
    }),
    routes: {
      slot: { provider: "ingress", model: "claude-sonnet-5" },
      pooled: { provider: "pool", model: "claude-sonnet-5" },
      fallbackOnly: { provider: "pool", model: "claude-opus-5", fallbacks: [{ provider: "ingress", model: "claude-opus-5" }] },
    },
    direct: [
      { prefix: "native-", provider: "ingress" },
      { prefix: "pooled-", provider: "pool" },
    ],
  };

  assert.deepEqual(targetWarnings(cfg), [
    'route "slot" names "ingress", which serves the OpenAI ingress only; requests for it pass through to Anthropic',
    'direct rule "native-" names "ingress", which serves the OpenAI ingress only; requests it matches pass through to Anthropic',
  ]);
});
