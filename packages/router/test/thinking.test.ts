import { test } from "node:test";
import assert from "node:assert/strict";
import { dropForeignThinking } from "../src/thinking.ts";

// A session switched from a translated model to Claude replays that model's unsigned thinking, and
// Anthropic refused every retry: "each thinking block must contain thinking" (2026-09-28).
test("unsigned thinking from another model is dropped; Anthropic's own is kept", () => {
  const signed = { type: "thinking", thinking: "plan", signature: "EqQBCkgIBxABGAIiQ" };
  const json: Record<string, unknown> = {
    model: "claude-opus-5-5",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "" }, { type: "text", text: "hello" }] },
      { role: "user", content: "next" },
      { role: "assistant", content: [{ type: "thinking", thinking: "summary" }] },
      { role: "user", content: "again" },
      { role: "assistant", content: [signed, { type: "text", text: "done" }] },
    ],
  };
  assert.equal(dropForeignThinking(json), 2);
  assert.deepEqual(json.messages, [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
    { role: "user", content: "next" },
    // The thinking-only turn goes whole; Anthropic joins the two user turns that meet.
    { role: "user", content: "again" },
    { role: "assistant", content: [signed, { type: "text", text: "done" }] },
  ]);
});

test("a conversation with nothing foreign is left untouched", () => {
  const messages = [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "sig" }] }];
  const json: Record<string, unknown> = { messages };
  assert.equal(dropForeignThinking(json), 0);
  assert.equal(json.messages, messages);
});
