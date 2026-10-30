// The dashboard asks "can this provider take routed requests" of providers not saved yet, so it keeps a
// copy of the router's rule. This test runs the copy straight from app.js and holds it to targets.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTargetProvider } from "../src/targets.ts";

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");

function dashboardRule(): (provider: unknown) => boolean {
  const source = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  const start = source.indexOf("function isTargetProvider(");
  const end = source.indexOf("function groupedModels(", start);
  assert.ok(start > 0 && end > start, "app.js no longer holds isTargetProvider where this test reads it");
  return new Function(`${source.slice(start, end)}\nreturn isTargetProvider;`)() as (provider: unknown) => boolean;
}

test("the dashboard's target rule is the router's for every provider shape", () => {
  const dashboard = dashboardRule();
  const shapes: [string, unknown][] = [
    ["no provider", undefined],
    ["anthropic, no pool", { type: "anthropic", auth: "claude-code" }],
    ["anthropic, pool off", { type: "anthropic", auth: "claude-code", accountPool: false }],
    ["anthropic, pool on", { type: "anthropic", auth: "claude-code", accountPool: true }],
    ["anthropic, pool on an API key (invalid, adopted at startup)", { type: "anthropic", auth: "api-key", accountPool: true }],
    ["anthropic, pool written as a string", { type: "anthropic", auth: "claude-code", accountPool: "true" }],
    ["anthropic API key", { type: "anthropic", auth: "api-key", apiKey: "k" }],
    ...["chatgpt", "openai-compatible", "anthropic-compatible", "google", "grok"].map((type): [string, unknown] => [type, { type }]),
  ];
  for (const [name, provider] of shapes) {
    assert.equal(dashboard(provider), isTargetProvider(provider as never), name);
  }
});
