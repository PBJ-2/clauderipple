import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResponsesEventMapper,
  claudeSupportsEffort,
  chatToAnthropic,
  responsesEventsToChatChunks,
  responsesToAnthropic,
  responsesToChatCompletion,
  type Json,
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

test("Responses accepts messages without a type and preserves transcript roles and content", () => {
  const body = { input: [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "output_text", text: "reply" }] },
    { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "https://example.test/a.png" }] },
    { type: "unknown_item", role: "user", content: "not a message" },
    { content: "not a message either" },
  ] };
  const out = responsesToAnthropic(body, "claude-sonnet-5");
  assert.deepEqual(out.messages, [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: [
      { type: "text", text: "look" },
      { type: "image", source: { type: "url", url: "https://example.test/a.png" }, cache_control: { type: "ephemeral" } },
    ] },
  ]);
  assert.equal(JSON.stringify(out), JSON.stringify(responsesToAnthropic(body, "claude-sonnet-5")), "cache prefix stays deterministic");
  assert.equal(body.input[0]!.type, undefined, "the caller's input is not rewritten");
});

for (const typed of [false, true]) for (const prefix of [undefined, "identity"]) {
  test(`Responses routes system/developer instructions through the existing policy (${typed ? "typed" : "easy"}, ${prefix ? "borrowed login" : "API key"})`, () => {
    const input = [
      { role: "system", content: "System rule" },
      { role: "developer", content: [{ type: "input_text", text: "Developer rule" }] },
      { role: "user", content: "go" },
    ].map((message) => typed ? { type: "message", ...message } : message);
    const body = { instructions: "Top-level rule", input };
    const before = structuredClone(body);
    const out = responsesToAnthropic(body, "claude-sonnet-5", prefix);
    const instructions = "Top-level rule\n\nSystem rule\n\nDeveloper rule";
    assert.deepEqual(out.system, [{ type: "text", text: prefix ?? instructions, cache_control: { type: "ephemeral" } }]);
    assert.deepEqual(out.messages, [{ role: "user", content: [
      ...(prefix ? [{ type: "text", text: `<operator_instructions>\n${instructions}\n</operator_instructions>`, cache_control: { type: "ephemeral" } }] : []),
      { type: "text", text: "go", cache_control: { type: "ephemeral" } },
    ] }]);
    assert.deepEqual(body, before);
  });
}

for (const prefix of [undefined, "identity"]) {
  test(`Responses input instructions work without top-level instructions (${prefix ? "borrowed login" : "API key"})`, () => {
    const out = responsesToAnthropic({ input: [{ role: "developer", content: "Rule" }] }, "claude-sonnet-5", prefix);
    assert.deepEqual(out.system, [{ type: "text", text: prefix ?? "Rule", cache_control: { type: "ephemeral" } }]);
    assert.deepEqual(out.messages, prefix ? [{ role: "user", content: [{ type: "text", text: "<operator_instructions>\nRule\n</operator_instructions>", cache_control: { type: "ephemeral" } }] }] : []);
  });
}

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

// Issue #104: Codex's remote compaction appends the control item `{"type":"compaction_trigger"}`
// after the whole transcript, so the transcript itself still ends with the assistant's last turn.
// Anthropic rejects that shape ("This model does not support assistant message prefill").
const compactRequest = {
  model: "claude-opus-5",
  instructions: "You are Codex.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "add a test" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "I added it." }] },
    { type: "compaction_trigger" },
  ],
  max_output_tokens: 16,
};

test("Codex compaction trigger becomes the user turn that asks for the summary", () => {
  const out = responsesToAnthropic(compactRequest, "claude-opus-5");
  assert.equal(out.messages.at(-1)?.role, "user");
  assert.deepEqual(out.messages[0]?.content, [{ type: "text", text: "add a test" }]);
  assert.deepEqual(out.messages[1]?.content, [{ type: "text", text: "I added it." }], "the assistant turn is kept as it was");
  const last = out.messages.at(-1)!;
  assert.equal(last.content.length, 1);
  assert.match((last.content[0] as { text: string }).text, /summar/i);
  assert.deepEqual((last.content[0] as { cache_control?: unknown }).cache_control, { type: "ephemeral" });
});

test("compaction combines text blocks once, preserves Unicode and restores at its input position", () => {
  const mapper = new ResponsesEventMapper("claude-opus-5", undefined, true);
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "요약\n" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "constraints remain" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 4 } },
    { type: "message_stop" },
  ].flatMap((event) => mapper.feed(event));
  assert.deepEqual(events.map((event) => event.type), ["response.created", "response.output_item.added", "response.output_item.done", "response.completed"]);
  assert.equal(mapper.output.length, 1);
  assert.equal(mapper.output[0]!.type, "compaction");
  assert.deepEqual(mapper.finish(), [], "completion cannot emit a second compaction item");
  assert.equal(mapper.usage.output_tokens, 4);
  const restored = responsesToAnthropic({ input: [
    { type: "message", role: "user", content: "before" },
    ...mapper.output,
    { type: "message", role: "user", content: "after" },
  ] }, "claude-opus-5");
  assert.deepEqual(restored.messages.map((message) => message.content[0]), [
    { type: "text", text: "before" },
    { type: "text", text: "Summary of the earlier conversation: 요약\nconstraints remain" },
    { type: "text", text: "after", cache_control: { type: "ephemeral" } },
  ]);
});

test("foreign compaction is dropped with a diagnostic; malformed owned summaries fail visibly", () => {
  let ignored = 0;
  const out = responsesToAnthropic({ input: [
    { type: "compaction", encrypted_content: "opaque-openai-value" },
    { type: "message", role: "user", content: "continue" },
  ] }, "claude-opus-5", undefined, () => ignored++);
  assert.equal(ignored, 1);
  assert.equal(out.messages.length, 1);
  for (const payload of ["not-base64!", Buffer.from("not-json").toString("base64"), Buffer.from('{"summary":42}').toString("base64"), Buffer.from('{"summary":" "}').toString("base64")]) {
    assert.throws(() => responsesToAnthropic({ input: [{ type: "compaction", encrypted_content: `clauderipple:compaction:v1:${payload}` }] }, "claude-opus-5"));
  }
});

test("empty, interrupted, truncated and tool compactions never produce a successful item", () => {
  assert.throws(() => new ResponsesEventMapper("claude-opus-5", undefined, true).feed({ type: "message_stop" }), /complete summary/);
  const interrupted = new ResponsesEventMapper("claude-opus-5", undefined, true);
  interrupted.feed({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
  assert.throws(() => interrupted.finish(), /complete summary/);
  assert.equal(interrupted.output.length, 0);
  assert.throws(() => new ResponsesEventMapper("claude-opus-5", undefined, true).feed({ type: "message_delta", delta: { stop_reason: "max_tokens" } }), /did not finish/);
  assert.throws(() => new ResponsesEventMapper("claude-opus-5", undefined, true).feed({ type: "content_block_start", content_block: { type: "tool_use" } }), /tool call/);
  assert.throws(() => new ResponsesEventMapper("claude-opus-5", undefined, true).feed({ type: "error" }), /upstream/);
});

test("a transcript that ends with the assistant still ends with a user turn", () => {
  const out = responsesToAnthropic({
    model: "claude-opus-5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ],
  }, "claude-opus-5");
  assert.equal(out.messages.at(-1)?.role, "user");
  assert.deepEqual(out.messages[1]?.content, [{ type: "text", text: "hello" }], "nothing of the transcript is rewritten");
});

test("a transcript that ends with the user is left alone", () => {
  const out = responsesToAnthropic({
    model: "claude-opus-5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
    ],
  }, "claude-opus-5");
  assert.equal(out.messages.length, 3);
  assert.deepEqual(out.messages.at(-1)?.content, [{ type: "text", text: "again", cache_control: { type: "ephemeral" } }]);
});

test("Chat Completions: a transcript that ends with the assistant also ends with a user turn", () => {
  const out = chatToAnthropic({
    model: "claude-opus-5",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
  }, "claude-opus-5");
  assert.equal(out.messages.at(-1)?.role, "user");
  assert.deepEqual(out.messages[1]?.content, [{ type: "text", text: "hello" }]);
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

for (const batched of [false, true]) {
  test(`Chat streaming keeps parallel tool indexes independent of content indexes (${batched ? "batched" : "incremental"})`, () => {
    const mapper = new ResponsesEventMapper("claude-sonnet-5");
    const source: Json[] = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Checking." } },
      { type: "content_block_stop", index: 2 },
      { type: "content_block_start", index: 4, content_block: { type: "tool_use", id: "call_a", name: "Read", input: {} } },
      { type: "content_block_start", index: 7, content_block: { type: "tool_use", id: "call_b", name: "Read", input: {} } },
      { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 7, delta: { type: "input_json_delta", partial_json: '{"path":"b.ts"}' } },
      { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
      { type: "content_block_stop", index: 7 },
      { type: "content_block_stop", index: 4 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    const events: Json[] = [];
    const chunks: Json[] = [];
    for (const event of source) {
      const mapped = mapper.feed(event);
      if (batched) events.push(...mapped);
      else chunks.push(...responsesEventsToChatChunks(mapped, mapper));
    }
    if (batched) chunks.push(...responsesEventsToChatChunks(events, mapper));
    const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
    for (const chunk of chunks) {
      const choice = (chunk.choices as { index: number; delta: { tool_calls?: { index: number; id?: string; type?: string; function: { name?: string; arguments: string } }[] } }[])[0]!;
      assert.equal(choice.index, 0, "one completion choice, independent of tool indexes");
      for (const delta of choice.delta.tool_calls ?? []) {
        if (delta.id) {
          assert.equal(calls.has(delta.index), false, "a tool index must not be reused");
          calls.set(delta.index, { id: delta.id, type: delta.type!, function: { name: delta.function.name!, arguments: "" } });
        }
        const call = calls.get(delta.index);
        assert.ok(call, "arguments belong to an announced tool");
        call.function.arguments += delta.function.arguments;
      }
    }
    assert.deepEqual([...calls.keys()], [0, 1]);
    assert.deepEqual([...calls.values()], [
      { id: "call_a", type: "function", function: { name: "Read", arguments: '{"path":"a.ts"}' } },
      { id: "call_b", type: "function", function: { name: "Read", arguments: '{"path":"b.ts"}' } },
    ]);
    const completion = responsesToChatCompletion(mapper);
    assert.deepEqual((completion.choices as { message: Json }[])[0]!.message.tool_calls, [...calls.values()]);
  });
}

for (const tool of [false, true]) for (const reason of ["max_tokens", "end_turn", "tool_use", "stop_sequence"]) {
  test(`stop reason ${reason} maps consistently to Responses and Chat (${tool ? "tool" : "text"})`, () => {
    const mapper = new ResponsesEventMapper("claude-sonnet-5");
    const events = [
      { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: "call_x", name: "Read", input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: reason === "max_tokens" ? '{"path":' : "{}" } : { type: "text_delta", text: "partial" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: reason } },
      { type: "message_stop" },
    ].flatMap((event) => mapper.feed(event));
    const truncated = reason === "max_tokens";
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, truncated ? "response.incomplete" : "response.completed");
    const response = terminal.response as Json;
    assert.equal(response.status, truncated ? "incomplete" : "completed");
    if (truncated) assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
    else assert.equal(response.incomplete_details, undefined);
    assert.deepEqual(mapper.response("completed"), response, "the server's non-streaming serialization keeps the terminal status");
    const expected = truncated ? "length" : tool ? "tool_calls" : "stop";
    const completion = responsesToChatCompletion(mapper);
    assert.equal((completion.choices as Json[])[0]!.finish_reason, expected);
    const chunks = responsesEventsToChatChunks(events, mapper);
    assert.equal(((chunks.at(-1)!.choices as Json[])[0]!).finish_reason, expected);
    assert.deepEqual(mapper.finish(), [], "EOF after a terminal message emits nothing else");
  });
}

for (const kind of ["empty", "text", "function_call", "error"]) {
  test(`EOF without message_stop never becomes a successful response (${kind})`, () => {
    const mapper = new ResponsesEventMapper("claude-sonnet-5");
    if (kind === "text" || kind === "function_call") {
      mapper.feed({ type: "content_block_start", index: 0, content_block: kind === "text" ? { type: "text", text: "" } : { type: "tool_use", id: "call_x", name: "Read", input: {} } });
      mapper.feed({ type: "content_block_delta", index: 0, delta: kind === "text" ? { type: "text_delta", text: "partial" } : { type: "input_json_delta", partial_json: '{"path":' } });
      mapper.feed({ type: "content_block_stop", index: 0 });
      mapper.feed({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    }
    if (kind === "error") mapper.feed({ type: "error", error: { type: "api_error", message: "upstream failed" } });
    assert.throws(() => mapper.finish(), /ended before message_stop/);
  });
}

test("borrowed login: system is the identity line only, client instructions become the first user block", () => {
  const out = responsesToAnthropic(
    { model: "claude-sonnet-5", instructions: "You are Codex. Long operator text.", input: [{ type: "message", role: "user", content: "hi" }], reasoning: { effort: "high" } },
    "claude-sonnet-5",
    "You are Claude Code, Anthropic's official CLI for Claude.",
  );
  assert.deepEqual(out.system, [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }]);
  const first = out.messages[0]!;
  assert.equal(first.role, "user");
  const blocks = first.content as { type: string; text?: string; cache_control?: unknown }[];
  assert.equal(blocks[0]!.type, "text");
  assert.ok(blocks[0]!.text!.startsWith("<operator_instructions>\nYou are Codex."));
  assert.deepEqual(blocks[0]!.cache_control, { type: "ephemeral" });
  assert.deepEqual(out.output_config, { effort: "high" });
});

test("API key path keeps instructions as the system prompt; effort dropped for models that reject it", () => {
  const out = responsesToAnthropic(
    { model: "claude-haiku-4-5", instructions: "Be terse.", input: [{ type: "message", role: "user", content: "hi" }], reasoning: { effort: "low" } },
    "claude-haiku-4-5-20251001",
  );
  assert.deepEqual(out.system, [{ type: "text", text: "Be terse.", cache_control: { type: "ephemeral" } }]);
  assert.equal(out.output_config, undefined);
  assert.equal((out.messages[0]!.content as unknown[]).length, 1);
  assert.equal(claudeSupportsEffort("claude-opus-4-6"), true);
  assert.equal(claudeSupportsEffort("claude-fable-5-1"), true);
  assert.equal(claudeSupportsEffort("claude-mythos-5-1"), true);
  assert.equal(claudeSupportsEffort("claude-sonnet-4-5-20250929"), false);
});

test("chat completions: system messages folded into the first user block when a prefix is set", () => {
  const out = chatToAnthropic(
    { model: "claude-sonnet-5", messages: [{ role: "system", content: "Rule A" }, { role: "system", content: "Rule B" }, { role: "user", content: "go" }] },
    "claude-sonnet-5",
    "identity",
  );
  assert.deepEqual(out.system, [{ type: "text", text: "identity", cache_control: { type: "ephemeral" } }]);
  const text = (out.messages[0]!.content as { text?: string }[])[0]!.text!;
  assert.ok(text.includes("Rule A\n\nRule B"));
});
