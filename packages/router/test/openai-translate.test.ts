import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiStreamMapper, toOpenAiRequest, type ChatRequest, type ResponsesRequest } from "../src/providers/openai/translate.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

const request: AnthropicRequest = {
  model: "claude-opus-5",
  system: [{ type: "text", text: "x-anthropic-billing-header: cch=changes-each-turn" }, { type: "text", text: "You are a coding agent." }],
  messages: [
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "read this" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "export const a = 1;" }] },
  ],
  tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
  tool_choice: { type: "tool", name: "Read", disable_parallel_tool_use: true },
  max_tokens: 77,
  temperature: 0.2,
  stop_sequences: ["STOP"],
  output_config: { effort: "ultra" },
};

const options = { model: "grok", effort: "ultra", caps: { reasoning: "effort" as const, effortLevels: ["low", "medium", "high"] } };

test("chat translation preserves images and tools, removes billing telemetry, and clamps effort", () => {
  const out = toOpenAiRequest(request, { ...options, wire: "chat" }) as ChatRequest;
  assert.equal(out.messages[0]?.role, "system");
  assert.equal(out.messages[0]?.content, "You are a coding agent.");
  assert.equal(JSON.stringify(out.messages).includes("x-anthropic-billing-header"), false);
  const user = out.messages[1]!;
  assert.ok(Array.isArray(user.content));
  assert.deepEqual((user.content as { type: string }[]).map((part) => part.type), ["image_url", "text"]);
  assert.equal((user.content as { image_url: { url: string } }[])[0]?.image_url.url, "data:image/png;base64,AAAA");
  assert.deepEqual(out.messages[2]?.tool_calls, [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }]);
  assert.equal(out.messages[3]?.role, "tool");
  assert.equal(out.messages[3]?.tool_call_id, "call_1");
  assert.equal(out.tools?.[0]?.function.name, "Read");
  assert.deepEqual(out.tool_choice, { type: "function", function: { name: "Read" } });
  assert.equal(out.parallel_tool_calls, false);
  assert.equal(out.max_tokens, 77);
  assert.equal(out.temperature, 0.2);
  assert.deepEqual(out.stop, ["STOP"]);
  assert.equal(out.reasoning_effort, "high");
});

test("responses translation uses stateless input, tool outputs, and responses effort", () => {
  const out = toOpenAiRequest(request, { ...options, wire: "responses" }) as ResponsesRequest;
  assert.equal(out.instructions, "You are a coding agent.");
  assert.deepEqual(out.input.map((item) => item.type), ["message", "function_call", "function_call_output"]);
  const first = out.input[0] as { content: { type: string; image_url?: string }[] };
  assert.deepEqual(first.content.map((part) => part.type), ["input_image", "input_text"]);
  assert.equal(first.content[0]?.image_url, "data:image/png;base64,AAAA");
  assert.equal(out.max_output_tokens, 77);
  assert.equal(out.temperature, 0.2);
  assert.deepEqual(out.reasoning, { effort: "high" });
  assert.equal(out.tools?.[0]?.name, "Read");
  assert.deepEqual(out.tool_choice, { type: "function", name: "Read" });
});

test("orphan tool result becomes user text on both wires", () => {
  const orphan: AnthropicRequest = { model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "side output" }] }] };
  const chat = toOpenAiRequest(orphan, { model: "m", wire: "chat" }) as ChatRequest;
  const responses = toOpenAiRequest(orphan, { model: "m", wire: "responses" }) as ResponsesRequest;
  assert.equal(chat.messages[0]?.role, "user");
  assert.match(String(chat.messages[0]?.content), /\[Tool result\]/);
  assert.equal(responses.input[0]?.type, "message");
  assert.match(JSON.stringify(responses.input[0]), /\[Tool result\]/);
});

test("chat SSE mapper emits text, indexed tool calls and cached-token usage", () => {
  const mapper = new OpenAiStreamMapper("test", 88);
  const records = [
    { id: "chatcmpl_1", choices: [{ delta: { content: "Hello " }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ delta: { content: "world" }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"path"' } }] }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
    { id: "chatcmpl_1", choices: [], usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 }, completion_tokens: 12 } },
  ];
  const events = records.flatMap((record) => mapper.feed(record, "chat"));
  const done = mapper.finish();
  const all = [...events, ...done];
  assert.equal(all[0]?.event, "message_start");
  assert.equal((all[0]?.data.message as { usage: { input_tokens: number } }).usage.input_tokens, 88);
  const starts = all.filter((event) => event.event === "content_block_start").map((event) => (event.data.content_block as { type: string }).type);
  assert.deepEqual(starts, ["text", "tool_use"]);
  assert.equal(all.filter((event) => event.event === "content_block_delta" && (event.data.delta as { type: string }).type === "input_json_delta").map((event) => (event.data.delta as { partial_json: string }).partial_json).join(""), '{"path":"a.ts"}');
  const final = all.find((event) => event.event === "message_delta")!;
  assert.equal((final.data.delta as { stop_reason: string }).stop_reason, "tool_use");
  assert.deepEqual(final.data.usage, { input_tokens: 100, output_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 });
  assert.deepEqual(mapper.message().content, [{ type: "text", text: "Hello world" }, { type: "tool_use", id: "call_1", name: "Read", input: { path: "a.ts" } }]);
});

test("OpenAI-shaped SSE error becomes an Anthropic error event", () => {
  const mapper = new OpenAiStreamMapper("test");
  const events = mapper.feed({ error: { code: "rate_limit_exceeded", message: "slow down" } }, "chat");
  assert.deepEqual(events.map((event) => event.event), ["message_start", "error"]);
  assert.equal(((events[1]?.data.error as { type: string }) ?? {}).type, "rate_limit_error");
});

test("responses SSE mapper associates interleaved tool arguments by item_id", () => {
  const mapper = new OpenAiStreamMapper("test");
  const events = [
    { type: "response.output_item.added", item: { type: "function_call", id: "item_a", call_id: "call_a", name: "Read" } },
    { type: "response.output_item.added", item: { type: "function_call", id: "item_b", call_id: "call_b", name: "Glob" } },
    { type: "response.function_call_arguments.delta", item_id: "item_a", delta: '{"path":' },
    { type: "response.function_call_arguments.delta", item_id: "item_b", delta: '{"pattern":' },
    { type: "response.function_call_arguments.delta", item_id: "item_a", delta: '"a.ts"}' },
    { type: "response.output_item.done", item: { id: "item_a" } },
    { type: "response.function_call_arguments.delta", item_id: "item_b", delta: '"*.ts"}' },
    { type: "response.output_item.done", item: { id: "item_b" } },
  ].flatMap((event) => mapper.feed(event, "responses"));
  const done = mapper.finish();
  const deltas = [...events, ...done]
    .filter((event) => event.event === "content_block_delta")
    .flatMap((event): { index: number; text: string }[] => {
      const delta = event.data.delta as { type: string; partial_json?: string };
      return delta.type === "input_json_delta" ? [{ index: event.data.index as number, text: delta.partial_json ?? "" }] : [];
    });
  const byBlock = new Map<number, string>();
  for (const { index, text } of deltas) byBlock.set(index, (byBlock.get(index) ?? "") + text);
  assert.deepEqual([...byBlock.values()], ['{"path":"a.ts"}', '{"pattern":"*.ts"}']);
  assert.deepEqual(mapper.message().content, [
    { type: "tool_use", id: "call_a", name: "Read", input: { path: "a.ts" } },
    { type: "tool_use", id: "call_b", name: "Glob", input: { pattern: "*.ts" } },
  ]);
});

test("responses SSE mapper emits a max-token response", () => {
  const mapper = new OpenAiStreamMapper("test");
  const events = [
    { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.output_item.done", item: { type: "message", id: "msg_1" } },
    { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 11, input_tokens_details: { cached_tokens: 3 }, output_tokens: 4 } } },
  ].flatMap((event) => mapper.feed(event, "responses"));
  const done = mapper.finish();
  const final = [...events, ...done].find((event) => event.event === "message_delta")!;
  assert.equal((final.data.delta as { stop_reason: string }).stop_reason, "max_tokens");
  assert.deepEqual(final.data.usage, { input_tokens: 8, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 });
});
