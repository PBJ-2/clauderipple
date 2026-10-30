import { test } from "node:test";
import assert from "node:assert/strict";
import { StartInputs } from "../src/providers/start-input.ts";

const measured = (input: number, cached = 0) => ({ input_tokens: input, cache_read_input_tokens: cached });

test("an unmeasured conversation announces the plain estimate", () => {
  assert.equal(new StartInputs().start("a", 648_000), 648_000);
});

// 2026-10-30, GPT-6.1 Sol: 281k measured against a 648k estimate, and the context read 136% while each response streamed.
test("a measured conversation announces the measurement plus the estimated growth, not the estimate", () => {
  const inputs = new StartInputs();
  inputs.start("a", 640_000);
  inputs.note("a", measured(400, 281_000));
  assert.equal(inputs.start("a", 648_000), 281_400 + 8_000);
});

test("usage before the provider's figures arrive is not a measurement", () => {
  const inputs = new StartInputs();
  inputs.start("a", 640_000);
  inputs.note("a", measured(0));
  assert.equal(inputs.start("a", 648_000), 648_000);
});

test("a request smaller than the measured one is a rewritten conversation and takes its own estimate", () => {
  const inputs = new StartInputs();
  inputs.start("a", 640_000);
  inputs.note("a", measured(281_000));
  assert.equal(inputs.start("a", 30_000), 30_000);
});

test("a measurement belongs to its own conversation", () => {
  const inputs = new StartInputs();
  inputs.start("a", 640_000);
  inputs.note("a", measured(281_000));
  inputs.note("b", measured(5_000));
  assert.equal(inputs.start("b", 20_000), 20_000);
});
