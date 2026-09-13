import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResponsesEventMapper,
  chatToAnthropic,
  responsesEventsToChatChunks,
  responsesToAnthropic,
} from "../src/ingress/translate.ts";

const request = {
  model: "claude-sonnet-5",
  instructions: "Be concise.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "function_call", call_id: "call_a", name: "Read", arguments: '{"file_path":"a.ts"}' },
    { type: "function_call_output", call_id: "call_a", output: "file contents" },
    { type: "reasoning", summary: [] },
  ],
  tools: [{ type: "function", name: "Read", description: "read", parameters: { type: "object", properties: { file_path: { type: "string" } } } }],
  tool_choice: { type: "function", name: "Read" },
  reasoning: { effort: "high" },
  max_output_tokens: 123,
  temperature: 0.2,
  stream: true,
};

test("Responses request becomes cache-friendly Anthropic Messages request", () => {
  const out = responsesToAnthropic(request, "claude-sonnet-5");
  assert.equal(out.system?.[0]?.text, "Be concise.");
  assert.deepEqual(out.system?.[0]?.cache_control, { type: "ephemeral" });
  assert.equal(out.messages.length, 3, "reasoning item is deliberately dropped");
  assert.equal(out.messages[0]?.content[1]?.type, "image");
  assert.deepEqual(out.messages[1]?.content[0], { type: "tool_use", id: "call_a", name: "Read", input: { file_path: "a.ts" } });
  assert.equal(out.messages[2]?.content[0]?.type, "tool_result");
  assert.deepEqual((out.messages[2]?.content[0] as { cache_control?: unknown }).cache_control, { type: "ephemeral" });
  assert.equal(out.tools?.[0]?.cache_control?.type, "ephemeral");
  assert.deepEqual(out.tool_choice, { type: "tool", name: "Read" });
  assert.deepEqual(out.output_config, { effort: "high" });
  assert.equal(out.max_tokens, 123);
});

test("Chat Completions maps system, tools, images and tool calls", () => {
  const out = chatToAnthropic({
    model: "claude-sonnet-5",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "https://example.test/a.png" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ],
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
  }, "claude-sonnet-5");
  assert.equal(out.system?.[0]?.text, "system");
  assert.equal(out.messages[0]?.content[1]?.type, "image");
  assert.equal(out.messages[1]?.content[0]?.type, "tool_use");
  assert.equal(out.messages[2]?.content[0]?.type, "tool_result");
});

test("Anthropic SSE maps to Responses and Chat stream events with usage", () => {
  const mapper = new ResponsesEventMapper("claude-sonnet-5");
  const source = [
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_x", name: "Read", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"p":"x"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", usage: { input_tokens: 12, cache_read_input_tokens: 90, output_tokens: 7 } },
    { type: "message_stop" },
  ];
  const events = source.flatMap((event) => mapper.feed(event));
  assert.equal(events[0]?.type, "response.created");
  assert.ok(events.some((event) => event.type === "response.output_text.delta" && event.delta === "ok"));
  assert.ok(events.some((event) => event.type === "response.function_call_arguments.done" && event.arguments === '{"p":"x"}'));
  const completed = events.find((event) => event.type === "response.completed")!;
  assert.deepEqual((completed.response as { usage: unknown }).usage, { input_tokens: 102, input_tokens_details: { cached_tokens: 90 }, output_tokens: 7, total_tokens: 109 });
  const chat = responsesEventsToChatChunks(events, mapper);
  assert.ok(chat.some((chunk) => JSON.stringify(chunk).includes('"content":"ok"')));
  assert.ok(chat.some((chunk) => JSON.stringify(chunk).includes('"finish_reason":"tool_calls"')));
});
