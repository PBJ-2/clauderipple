// The ChatGPT provider's service tier, decided in one place: Fast (`priority`) as before, and
// Ultrafast (`ultrafast`) only for a scope whose switch is on and a model whose catalogue entry
// advertises the tier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseServiceTier, refusesServiceTier, tierNote } from "../src/providers/chatgpt/tiers.ts";

const on = { main: true, subagent: true };
const both = ["priority", "ultrafast"];

test("Ultrafast needs its scope's switch and a model that advertises it", () => {
  assert.equal(chooseServiceTier({ speedFast: false, subagent: false, ultrafast: { main: true }, modelTiers: both }), "ultrafast");
  assert.equal(chooseServiceTier({ speedFast: false, subagent: true, ultrafast: { subagent: true }, modelTiers: ["ultrafast"] }), "ultrafast");
  assert.equal(chooseServiceTier({ speedFast: false, subagent: true, ultrafast: { main: true }, modelTiers: both }), undefined, "ultrafast.main does not reach a subagent's turn");
  assert.equal(chooseServiceTier({ speedFast: false, subagent: false, ultrafast: { main: true }, modelTiers: ["priority"] }), undefined, "not advertised, and Fast is off");
  assert.equal(chooseServiceTier({ speedFast: false, subagent: false, ultrafast: { main: true }, modelTiers: [] }), undefined);
  assert.equal(chooseServiceTier({ speedFast: false, subagent: false, ultrafast: { main: true } }), undefined, "an unread catalogue is not eligibility");
});

test("Ultrafast outranks Fast and falls back to it", () => {
  assert.equal(chooseServiceTier({ speedFast: false, subagent: false, fast: on, ultrafast: on, modelTiers: both }), "ultrafast");
  assert.equal(chooseServiceTier({ speedFast: false, subagent: false, fast: on, ultrafast: on, modelTiers: ["priority"] }), "priority");
  assert.equal(chooseServiceTier({ speedFast: false, subagent: false, fast: on, ultrafast: on }), "priority");
  assert.equal(chooseServiceTier({ speedFast: true, subagent: false, ultrafast: { main: true }, modelTiers: both }), "ultrafast", "the switch outranks /fast");
  assert.equal(chooseServiceTier({ speedFast: true, subagent: true, ultrafast: { main: true }, modelTiers: both }), "priority", "/fast still asks for Fast where Ultrafast does not apply");
});

test("without an Ultrafast switch the choice is exactly the Fast rule", () => {
  assert.equal(chooseServiceTier({ speedFast: false, subagent: false, fast: { main: true }, modelTiers: both }), "priority");
  assert.equal(chooseServiceTier({ speedFast: false, subagent: false, fast: { subagent: true } }), undefined);
  assert.equal(chooseServiceTier({ speedFast: false, subagent: true, fast: { subagent: true } }), "priority");
  assert.equal(chooseServiceTier({ speedFast: true, subagent: false }), "priority");
  assert.equal(chooseServiceTier({ speedFast: false, subagent: false }), undefined);
});

test("the note names the tier that was asked for", () => {
  assert.equal(tierNote("priority"), " fast");
  assert.equal(tierNote("ultrafast"), " ultrafast");
  assert.equal(tierNote(undefined), "");
  assert.equal(tierNote("flex"), "");
});

test("a refusal is about the tier only when a 4xx names it", () => {
  assert.equal(refusesServiceTier(400, '{"error":{"message":"Unsupported service_tier: ultrafast"}}'), true);
  assert.equal(refusesServiceTier(403, '{"detail":"Ultrafast is not available on your plan"}'), true);
  assert.equal(refusesServiceTier(400, '{"error":{"message":"Invalid reasoning item"}}'), false);
  assert.equal(refusesServiceTier(401, "service_tier"), false);
  assert.equal(refusesServiceTier(429, "ultrafast capacity"), false);
  assert.equal(refusesServiceTier(500, "service_tier"), false);
});
