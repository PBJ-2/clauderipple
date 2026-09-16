// The one line that tells a routed model what it is, and the fixed addendum after the prompt.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyIdentityToAnthropicBody, identityLine, identityPrefix, instructionsSuffix } from "../src/identity.ts";

test("the line names the model, and the effort only when there is one", () => {
  assert.equal(identityLine("deepseek-flash", "high"), "You are deepseek-flash (reasoning effort: high), answering through Claude Code, a terminal-based coding agent.");
  assert.equal(identityLine("deepseek-flash"), "You are deepseek-flash, answering through Claude Code, a terminal-based coding agent.");
});

test("identity is on unless the provider turned it off", () => {
  assert.ok(identityPrefix({ model: "m" }));
  assert.ok(identityPrefix({ model: "m", identity: true }));
  assert.equal(identityPrefix({ model: "m", identity: false }), null);
});

test("an addendum of blanks is no addendum", () => {
  assert.equal(instructionsSuffix({ model: "m" }), null);
  assert.equal(instructionsSuffix({ model: "m", instructionsAppend: "   " }), null);
  assert.equal(instructionsSuffix({ model: "m", instructionsAppend: " Answer in Korean. " }), "Answer in Korean.");
});

test("a body with no system prompt gets one", () => {
  const json: Record<string, unknown> = { model: "x" };
  applyIdentityToAnthropicBody(json, { model: "m", instructionsAppend: "Be brief." });
  assert.equal(json.system, "You are m, answering through Claude Code, a terminal-based coding agent.\n\nBe brief.");
});

test("a body left entirely alone when nothing is to be added", () => {
  const json: Record<string, unknown> = { model: "x", system: "keep me" };
  applyIdentityToAnthropicBody(json, { model: "m", identity: false });
  assert.equal(json.system, "keep me");
});

test("a system shape we did not build is not rewritten", () => {
  const json: Record<string, unknown> = { model: "x", system: { unexpected: true } };
  applyIdentityToAnthropicBody(json, { model: "m" });
  assert.deepEqual(json.system, { unexpected: true });
});
