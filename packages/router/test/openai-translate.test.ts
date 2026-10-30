import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiStreamMapper, toOpenAiRequest, type ChatRequest, type ResponsesRequest } from "../src/providers/openai/translate.ts";
import { toolNameForResponses, toolNameRestoreMap, type AnthropicRequest } from "../src/providers/chatgpt/translate.ts";
import { decodeEnvelope, encodeEnvelope } from "../src/reasoning.ts";
import { promptAdditions } from "../src/identity.ts";
import { SseParser } from "../src/providers/chatgpt/sse.ts";

test("the SSE terminal preserves preceding usage and ignores trailing frames across every chunk boundary", () => {
  const usage = { choices: [], usage: { prompt_tokens: 40, completion_tokens: 5 } };
  const source = `data: ${JSON.stringify(usage)}\r\n\r\ndata: [DONE]\r\n\r\ndata: {"error":{"message":"late"}}\n\n`;
  for (let split = 0; split <= source.length; split++) {
    const parser = new SseParser();
    const events = [...parser.feed(source.slice(0, split)), ...parser.feed(source.slice(split))];
    assert.deepEqual(events, [usage]);
    assert.equal(parser.sawDone, true);
    assert.deepEqual(parser.feed('data: {"error":{"message":"later"}}\n\n'), []);
  }
});

for (const type of ["response.completed", "response.incomplete"]) {
  test(`${type} finishes once with usage and ignores subsequent errors`, () => {
    const mapper = new OpenAiStreamMapper("test");
    const events = mapper.feed({ type, response: { usage: { input_tokens: 4, output_tokens: 2 }, ...(type === "response.incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}) } }, "responses");
    assert.equal(mapper.isFinished, true);
    assert.equal(events.filter((event) => event.event === "message_stop").length, 1);
    assert.deepEqual(mapper.finish(), []);
    assert.deepEqual(mapper.feed({ error: { message: "late", code: "server_is_overloaded" } }, "responses"), []);
    assert.equal(mapper.failure, undefined);
    assert.equal(mapper.stopReason, type === "response.completed" ? "end_turn" : "max_tokens");
    assert.equal(mapper.usage.output_tokens, 2);
  });
}

/** The signature this router puts on a Chat reasoning block, as its own adapter would write it. */
function CHAT_SIG(field: "reasoning_content" | "reasoning", model = "x", provider = ""): string {
  return encodeEnvelope({ w: "chat", p: provider, m: model, f: field });
}
const ZEN = "opencode-zen";

/** A carrier block as a Responses adapter hands it to Claude Code, around the vendor's own item. */
function responsesCarrier(item: Record<string, unknown>, env = { p: "opencode-go", m: "muse-spark-1.3-contributor" }): { type: "thinking"; thinking: string; signature: string } {
  return { type: "thinking", thinking: "", signature: encodeEnvelope({ w: "responses", p: env.p, m: env.m, r: item }) };
}

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
  assert.equal(out.messages[0]?.content, "You are grok (reasoning effort: high), answering through Claude Code, a terminal-based coding agent.\n\nYou are a coding agent.");
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
  assert.equal(out.instructions, "You are grok (reasoning effort: high), answering through Claude Code, a terminal-based coding agent.\n\nYou are a coding agent.");
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
  // messages[0] is the identity line, which is sent even when the caller supplied no system prompt.
  assert.equal(chat.messages[0]?.role, "system");
  assert.equal(chat.messages[1]?.role, "user");
  assert.match(String(chat.messages[1]?.content), /\[Tool result\]/);
  assert.equal(responses.input[0]?.type, "message");
  assert.match(JSON.stringify(responses.input[0]), /\[Tool result\]/);
});

test("tool result images survive on chat and responses wires", () => {
  const screenshot: AnthropicRequest = {
    model: "m",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "shot_1", name: "screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "shot_1", content: [
        { type: "text", text: "Screenshot size: 800x600" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ] }] },
    ],
  };
  const chat = toOpenAiRequest(screenshot, { model: "m", wire: "chat" }) as ChatRequest;
  const responses = toOpenAiRequest(screenshot, { model: "m", wire: "responses" }) as ResponsesRequest;

  assert.equal(chat.messages[2]?.role, "tool");
  assert.equal(chat.messages[2]?.content, "Screenshot size: 800x600");
  assert.deepEqual(chat.messages[3]?.content, [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
  assert.deepEqual(responses.input.map((item) => item.type), ["function_call", "function_call_output", "message"]);
  assert.deepEqual((responses.input[2] as { content: unknown[] }).content, [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }]);
  assert.equal(JSON.stringify({ chat, responses }).includes("[image omitted]"), false);
});

test("parallel tool results with images keep their tool messages together on chat (#64)", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  const ids = ["a", "b", "c"];
  const request: AnthropicRequest = {
    model: "m",
    messages: [
      { role: "user", content: "look" },
      { role: "assistant", content: ids.map((id) => ({ type: "tool_use", id, name: "Read", input: {} })) },
      { role: "user", content: [...ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: [image] })), { type: "text", text: "and?" }] },
    ],
  };
  const chat = toOpenAiRequest(request, { model: "m", wire: "chat" }) as ChatRequest;

  const turns = chat.messages.filter((m) => m.role !== "system");
  assert.deepEqual(turns.map((m) => m.role), ["user", "assistant", "tool", "tool", "tool", "user"]);
  assert.deepEqual((turns[5]?.content as { type: string }[]).map((part) => part.type), ["image_url", "image_url", "image_url", "text"]);
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

test("identity false leaves the system prompt as the caller wrote it; the addendum still follows", () => {
  const out = toOpenAiRequest(request, { ...options, wire: "chat", identity: false, instructionsAppend: "Answer in Korean." }) as ChatRequest;
  assert.equal(out.messages[0]?.content, "You are a coding agent.\n\nAnswer in Korean.");
});

test("an Auto mode classifier's system text stays exactly as sent", () => {
  const system = "You are a security monitor for autonomous AI coding agents.\n\nJudge this action.";
  const classifier: AnthropicRequest = { model: "claude-haiku-5-5", system, messages: [{ role: "user", content: "check" }] };
  const additions = promptAdditions("auto-mode-classifier", { instructionsAppend: "Answer in Korean." });
  const chat = toOpenAiRequest(classifier, { model: "grok", wire: "chat", ...additions }) as ChatRequest;
  const responses = toOpenAiRequest(classifier, { model: "grok", wire: "responses", ...additions }) as ResponsesRequest;
  assert.equal(chat.messages[0]?.content, system);
  assert.equal(responses.instructions, system);
});

test("a provider that takes no reasoning effort is not told one", () => {
  const out = toOpenAiRequest(request, { model: "kimi", wire: "chat", effort: "high", caps: { reasoning: "none" } }) as ChatRequest;
  assert.equal(out.messages[0]?.content, "You are kimi, answering through Claude Code, a terminal-based coding agent.\n\nYou are a coding agent.");
});

// Anthropic runs server tools; this provider cannot. The shape is Claude Code's real web-search
// side query: one forced server tool and nothing else.
const serverToolRequest: AnthropicRequest = {
  model: "x",
  max_tokens: 10,
  tools: [
    { name: "web_search", type: "web_search_20250305", max_uses: 8 } as never,
    { name: "Read", input_schema: { type: "object", properties: {} } },
  ],
  tool_choice: { type: "tool", name: "web_search" },
  messages: [{ role: "user", content: "Perform a web search for the query: node 24" }],
};

test("server tools are dropped on the chat wire, and the choice that named one with them", () => {
  const out = toOpenAiRequest(serverToolRequest, { ...options, wire: "chat" }) as ChatRequest;
  assert.deepEqual(out.tools?.map((t) => t.function.name), ["Read"]);
  assert.equal(out.tool_choice, undefined);
});

test("server tools are dropped on the responses wire too", () => {
  const out = toOpenAiRequest(serverToolRequest, { ...options, wire: "responses" }) as ResponsesRequest;
  assert.deepEqual(out.tools?.map((t) => t.name), ["Read"]);
  assert.equal(out.tool_choice, undefined);
});

// Claude Code explains the advisor in text on every subagent (CLI 2.1.286); with the declaration
// gone, that text has to be withdrawn too, on both wires.
const advisorRequest: AnthropicRequest = {
  ...request,
  tools: [...(request.tools ?? []), { type: "advisor_20260301", name: "advisor", model: "claude-fable-5-1" } as never],
};

test("a dropped server tool's instructions are withdrawn after the system prompt, on both wires", () => {
  const chat = toOpenAiRequest(advisorRequest, { ...options, wire: "chat" }) as ChatRequest;
  assert.match(String(chat.messages[0]?.content), /You are a coding agent\.\n\nNot available in this session: `advisor`\. /);
  const responses = toOpenAiRequest(advisorRequest, { ...options, wire: "responses" }) as ResponsesRequest;
  assert.match(responses.instructions ?? "", /You are a coding agent\.\n\nNot available in this session: `advisor`\. /);
  assert.doesNotMatch(String((toOpenAiRequest(request, { ...options, wire: "chat" }) as ChatRequest).messages[0]?.content), /Not available in this session/, "no server tool, no note");
});

// OpenAI function names take the same `^[a-zA-Z0-9_-]{1,64}$` as the Codex backend, and one
// over-long name fails the whole request. Claude Code's MCP names pass 64 routinely (issue #1).
const longMcp = "mcp__claude_ai_Korea_Investment_Securities__get_overseas_stock_chart"; // 68
const mangled = toolNameForResponses(longMcp);

const mcpRequest: AnthropicRequest = {
  ...request,
  tools: [{ name: longMcp, input_schema: { type: "object", properties: {} } }, { name: "Read", input_schema: { type: "object", properties: {} } }],
  tool_choice: { type: "tool", name: longMcp },
  messages: [
    { role: "user", content: [{ type: "text", text: "quote please" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: longMcp, input: { symbol: "AAPL" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "182.3" }] },
  ],
};

test("over-long tool names are mangled on the chat wire, declarations, choice and replayed calls alike", () => {
  const out = toOpenAiRequest(mcpRequest, { ...options, wire: "chat" }) as ChatRequest;
  assert.equal(out.tools?.[0]?.function.name, mangled);
  assert.equal(out.tools?.[1]?.function.name, "Read"); // legal name still byte-identical
  for (const t of out.tools ?? []) assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(t.function.name), t.function.name);
  assert.deepEqual(out.tool_choice, { type: "function", function: { name: mangled } });
  const replay = out.messages.find((m) => m.tool_calls)?.tool_calls?.[0];
  assert.equal(replay?.function.name, mangled);
});

test("over-long tool names are mangled on the responses wire too", () => {
  const out = toOpenAiRequest(mcpRequest, { ...options, wire: "responses" }) as ResponsesRequest;
  assert.equal(out.tools?.[0]?.name, mangled);
  for (const t of out.tools ?? []) assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(t.name), t.name);
  assert.deepEqual(out.tool_choice, { type: "function", name: mangled });
  const call = out.input.find((i) => (i as { type?: string }).type === "function_call") as { name: string };
  assert.equal(call.name, mangled);
});

test("the mangled name the vendor echoes is restored to the one Claude Code knows, on both wires", () => {
  const map = toolNameRestoreMap(mcpRequest);
  assert.equal(map.get(mangled), longMcp);
  assert.equal(map.has("Read"), false);

  const toolName = (mapper: OpenAiStreamMapper): string | undefined => {
    const blocks = mapper.message().content as { type: string; name?: string }[];
    return blocks.find((b) => b.type === "tool_use")?.name;
  };

  const chat = new OpenAiStreamMapper("test", 0, map);
  chat.feed({ id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: mangled, arguments: "{}" } }] }, finish_reason: "tool_calls" }] }, "chat");
  assert.equal(toolName(chat), longMcp);

  const responses = new OpenAiStreamMapper("test", 0, map);
  responses.feed({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: mangled } }, "responses");
  assert.equal(toolName(responses), longMcp);
});

// Measured 2026-09-22 against OpenCode Go: mimo-v2.6-pro answers on the Chat Completions wire and
// streams its thinking as `reasoning_content`, beside `content`. The mapper read only `content`, so
// a 43-second reasoning turn reached Claude Code as 43 seconds of nothing, and a turn that reasoned
// without concluding reached it as an empty message.
test("chat SSE mapper relays reasoning as thinking, before the answer it precedes", () => {
  const mapper = new OpenAiStreamMapper("mimo-v2.6-pro");
  const records = [
    { id: "c1", choices: [{ delta: { reasoning_content: "The user wants " }, finish_reason: null }] },
    { id: "c1", choices: [{ delta: { reasoning_content: "one word." }, finish_reason: null }] },
    { id: "c1", choices: [{ delta: { content: "ready" }, finish_reason: "stop" }] },
  ];
  const events = records.flatMap((record) => mapper.feed(record, "chat"));
  const starts = events.filter((e) => e.event === "content_block_start").map((e) => (e.data.content_block as { type: string }).type);
  assert.deepEqual(starts, ["thinking", "text"], "thinking opens its own block and the answer opens another");
  const thinking = events.filter((e) => (e.data.delta as { type?: string })?.type === "thinking_delta").map((e) => (e.data.delta as { thinking: string }).thinking);
  assert.deepEqual(thinking, ["The user wants ", "one word."]);
  // The thinking block is closed before the answer's block opens, never left hanging.
  const order = events.map((e) => e.event);
  assert.ok(order.indexOf("content_block_stop") < order.lastIndexOf("content_block_start"));
  assert.deepEqual(mapper.message().content, [
    { type: "thinking", thinking: "The user wants one word.", signature: CHAT_SIG("reasoning_content", "mimo-v2.6-pro") },
    { type: "text", text: "ready" },
  ]);
});

test("a turn that only reasons is no longer empty", () => {
  const mapper = new OpenAiStreamMapper("mimo-v2.6-pro");
  mapper.feed({ id: "c1", choices: [{ delta: { reasoning_content: "thinking out loud" }, finish_reason: "stop" }] }, "chat");
  mapper.finish();
  assert.deepEqual(mapper.message().content, [{ type: "thinking", thinking: "thinking out loud", signature: CHAT_SIG("reasoning_content", "mimo-v2.6-pro") }]);
});

// Vendors on this wire disagree on the field name; both must land in the same place, and the name a
// model was heard on is the one its reasoning is replayed under (reasoning.ts).
test("reasoning under the bare `reasoning` name is relayed too", () => {
  const mapper = new OpenAiStreamMapper("other");
  mapper.feed({ id: "c1", choices: [{ delta: { reasoning: "hmm" }, finish_reason: "stop" }] }, "chat");
  mapper.finish();
  assert.deepEqual(mapper.message().content, [{ type: "thinking", thinking: "hmm", signature: CHAT_SIG("reasoning", "other") }]);
});

// Claude Code checks a model it is switching to by asking it for a single token. Anthropic Messages
// allows that; Responses does not, and answers "`max_output_tokens` The number must be >=" with a
// 400 (measured 2026-09-22 against OpenCode). Every switch to a Responses model failed on it, so
// the floor is raised here rather than handed to the user as a refusal.
test("a Responses request asks for at least sixteen output tokens, whatever the client asked for", () => {
  const one = toOpenAiRequest({ ...request, max_tokens: 1 }, { ...options, wire: "responses" }) as ResponsesRequest;
  assert.equal(one.max_output_tokens, 16);
  const many = toOpenAiRequest({ ...request, max_tokens: 4096 }, { ...options, wire: "responses" }) as ResponsesRequest;
  assert.equal(many.max_output_tokens, 4096, "a cap above the floor is the client's to set");
  // Chat Completions has no such floor, so nothing is raised there.
  const chat = toOpenAiRequest({ ...request, max_tokens: 1 }, { ...options, wire: "chat" }) as ChatRequest;
  assert.equal(chat.max_tokens, 1);
});

// ---- reasoning replay (reasoning.ts) -----------------------------------------------------------

const env = { p: "opencode-go", m: "muse-spark-1.3-contributor" };
type ChatMsg = { role: string; content: unknown; reasoning?: string; reasoning_content?: string; tool_calls?: { id: string }[] };

// The whole point: the reasoning the backend sealed comes back in the position it left, which for a
// tool turn is immediately after the call it describes — the position the CLI replays it in.
test("a Responses carrier is put back in place, beside the call it followed", () => {
  const item = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAsealed" };
  const carried = { replayed: 0, undecodable: 0 };
  const out = toOpenAiRequest(
    {
      model: "m",
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: [{ type: "thinking", thinking: "let me read", signature: "" }, { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
        { role: "assistant", content: [responsesCarrier(item), { type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "y" }] },
      ],
    },
    { model: env.m, wire: "responses", env, carried },
  ) as ResponsesRequest;
  // The envelope is read back byte-for-byte, and only type/id/summary/encrypted_content go out.
  assert.deepEqual(out.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "read it" }] },
    { type: "function_call", call_id: "call_1", name: "Read", arguments: '{"file_path":"a.ts"}' },
    { type: "function_call_output", call_id: "call_1", output: "x" },
    item,
    { type: "function_call", call_id: "call_2", name: "Bash", arguments: '{"command":"ls"}' },
    { type: "function_call_output", call_id: "call_2", output: "y" },
  ]);
  assert.deepEqual(out.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(carried, { replayed: 1, undecodable: 0 });
});

// A request with nothing to carry asks for nothing, and stays byte-identical to what went before:
// `store: false` is what makes the backend seal its reasoning, so `include` is the only new field.
test("a request with no reasoning of ours is unchanged: no include, nothing inserted", () => {
  const plain: AnthropicRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const withEnv = toOpenAiRequest(plain, { model: "muse", wire: "responses", env }) as ResponsesRequest;
  const without = toOpenAiRequest(plain, { model: "muse", wire: "responses" }) as ResponsesRequest;
  assert.equal(withEnv.include, undefined);
  assert.deepEqual(withEnv.input, without.input);
  assert.equal(JSON.stringify(withEnv).includes("reasoning.encrypted_content"), false);
});

// A foreign block — Anthropic's own thinking, another model's carrier, a corrupt one — must be
// dropped rather than sent, or the request fails for a reason the user cannot act on.
test("reasoning from another model, the other wire, or a corrupt envelope is not replayed", () => {
  const item = { type: "reasoning", encrypted_content: "gAAAAsealed" };
  const anthropics = { type: "redacted_thinking", data: "AnthropicOwnBlock" };
  const otherModel = { type: "thinking", thinking: "", signature: encodeEnvelope({ w: "responses", p: "chatgpt", m: "gpt-6-astra", r: item }) };
  const otherWire = { type: "thinking", thinking: "deepseek thought", signature: encodeEnvelope({ w: "chat", p: "opencode-zen", m: "deepseek-v4.1-flash", f: "reasoning_content" }) };
  const corrupt = { type: "thinking", thinking: "", signature: "clauderipple.v1:@@@@" };
  const carried = { replayed: 0, undecodable: 0 };
  const dropped: string[] = [];
  const out = toOpenAiRequest(
    { model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [anthropics, otherModel, otherWire, corrupt, { type: "tool_use", id: "call_1", name: "Bash", input: {} }] }] },
    { model: env.m, wire: "responses", env, carried, log: (line) => dropped.push(line) },
  ) as ResponsesRequest;
  assert.equal(JSON.stringify(out.input).includes("encrypted_content"), false);
  assert.equal(out.include, undefined);
  assert.deepEqual(carried, { replayed: 0, undecodable: 2 }, "the other model's and the corrupt one are counted; nothing was replayed");
  assert.equal(dropped.length, 2);
  // The other wire's carrier is not ours here either — it is simply not this request's to touch.
  assert.equal(dropped.some((line) => line.includes("opencode-zen")), false);
});

// Chat has no sealed blob: the block's own text is the reasoning, replayed under the name the model
// was heard on. Vendors on this wire disagree on that name (DeepSeek documents `reasoning_content`).
test("chat reasoning goes back as reasoning_content on the assistant message, field name preserved", () => {
  const deepseek: AnthropicRequest = {
    model: "m",
    messages: [
      { role: "user", content: "read it" },
      { role: "assistant", content: [{ type: "thinking", thinking: "I should read a.ts", signature: CHAT_SIG("reasoning_content", "deepseek-v4.1-flash", ZEN) }, { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
    ],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
  };
  const carried = { replayed: 0, undecodable: 0 };
  const out = toOpenAiRequest(deepseek, { model: "deepseek-v4.1-flash", wire: "chat", env: { p: "opencode-zen", m: "deepseek-v4.1-flash" }, carried }) as ChatRequest;
  const assistant = out.messages.find((m) => m.role === "assistant") as unknown as ChatMsg;
  assert.equal(assistant.reasoning_content, "I should read a.ts");
  assert.equal(assistant.tool_calls?.[0]?.id, "call_1");
  assert.deepEqual(carried, { replayed: 1, undecodable: 0 });
  // A model heard on `reasoning` is answered on `reasoning`, not renamed to the other spelling.
  const relayOut = toOpenAiRequest(
    { model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: CHAT_SIG("reasoning", "x", ZEN) }] }] },
    { model: "x", wire: "chat", env: { p: "opencode-zen", m: "x" } },
  ) as ChatRequest;
  const relayed = relayOut.messages[2] as unknown as ChatMsg;
  assert.equal(relayed.reasoning, "hmm");
  assert.equal(relayed.reasoning_content, undefined);
});

// Anthropic's own thinking is not ours to replay: signed by Anthropic, or with no signature at all,
// it is display history, and neither wire may turn it into a vendor field.
test("a foreign thinking block never becomes reasoning_content", () => {
  const withForeign: AnthropicRequest = {
    model: "m",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "anthropic's own", signature: "EqQBCkgIBxABGAIiQ" }, { type: "text", text: "ok" }] },
    ],
  };
  const out = toOpenAiRequest(withForeign, { model: "x", wire: "chat", env: { p: "opencode-zen", m: "x" } }) as ChatRequest;
  const msg = out.messages[2] as unknown as ChatMsg;
  assert.equal(msg.reasoning_content, undefined);
  assert.equal(msg.reasoning, undefined);
  assert.equal(msg.content, "ok");
});

// A turn whose only content was the replayed reasoning is still a turn: it goes out with the
// reasoning alone rather than vanishing from the history.
test("a reasoning-only assistant turn is sent with its reasoning, not dropped", () => {
  const out = toOpenAiRequest(
    {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "just thinking", signature: CHAT_SIG("reasoning_content", "x", ZEN) }] },
        { role: "user", content: "go on" },
      ],
    },
    { model: "x", wire: "chat", env: { p: "opencode-zen", m: "x" } },
  ) as ChatRequest;
  assert.deepEqual(out.messages[2], { role: "assistant", content: null, reasoning_content: "just thinking" });
});

// `replay: false` is the retry after a vendor refused the carrier, and it must be exactly the request
// this adapter sent before any of this existed.
test("replay: false puts back the request without any reasoning", () => {
  const chat = toOpenAiRequest(
    {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "deepseek thought", signature: CHAT_SIG("reasoning_content", "x", ZEN) }, { type: "text", text: "ok" }] },
      ],
    },
    { model: "x", wire: "chat", env: { p: "opencode-zen", m: "x" }, replay: false },
  ) as ChatRequest;
  // Index 0 is the identity system message this wire always prepends.
  assert.deepEqual(chat.messages[2], { role: "assistant", content: "ok" });
  assert.equal(JSON.stringify(chat).includes("reasoning"), false);
  const responses = toOpenAiRequest(
    { model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [responsesCarrier({ type: "reasoning", encrypted_content: "blob" })] }] },
    { model: "x", wire: "responses", env: { p: "opencode-zen", m: "x" }, replay: false },
  ) as ResponsesRequest;
  assert.equal(responses.include, undefined);
  assert.equal(JSON.stringify(responses.input).includes("encrypted_content"), false);
});

// The response path hands the client a carrier block whose envelope holds exactly the vendor's item,
// so the next turn can put it back untouched. A summary without full reasoning is display text only.
test("a Responses reasoning item is sealed into a carrier block; a summary-only one is not", () => {
  const mapper = new OpenAiStreamMapper("muse-spark-1.3-contributor", 0, new Map(), env);
  mapper.wire = "responses";
  const evs: Record<string, unknown>[] = [
    { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" }, output_index: 0 },
    { type: "response.reasoning_summary_text.delta", delta: "thinking…", item_id: "rs_1" },
    { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAsealed" } },
    { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", id: "fc_1", name: "Bash" }, output_index: 1 },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_1" } },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } },
  ];
  const out = evs.flatMap((e) => mapper.feed(e, "responses"));
  const content = mapper.content as { type: string; thinking?: string; signature?: string }[];
  assert.deepEqual(content.map((b) => b.type), ["thinking", "tool_use"]);
  assert.equal(content[0]?.thinking, "thinking…");
  assert.deepEqual(decodeEnvelope(content[0]?.signature), {
    w: "responses",
    p: "opencode-go",
    m: "muse-spark-1.3-contributor",
    r: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAsealed" },
  });
  assert.equal(mapper.reasoningCount, 1);
  // The signature the client sees is the same one the envelope holds, and it closes the block.
  const sigDelta = out.find((e) => e.event === "content_block_delta" && (e.data.delta as { type: string }).type === "signature_delta");
  assert.equal((sigDelta?.data.delta as { signature: string }).signature, content[0]?.signature);
  // One item is one block, however its summary and its state arrived.
  assert.deepEqual(out.filter((e) => e.event === "content_block_start").map((e) => (e.data.content_block as { type: string }).type), ["thinking", "tool_use"]);
  assert.equal(out.filter((e) => e.event === "content_block_stop").length, 2);

  // An item with no `encrypted_content` is display text only: no signature, and nothing to replay.
  const plain = new OpenAiStreamMapper("muse", 0, new Map(), env);
  plain.wire = "responses";
  plain.feed({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_2" }, output_index: 0 }, "responses");
  plain.feed({ type: "response.reasoning_summary_text.delta", delta: "just a summary", item_id: "rs_2" }, "responses");
  plain.feed({ type: "response.output_item.done", item: { type: "reasoning", id: "rs_2" } }, "responses");
  assert.deepEqual(plain.content, [{ type: "thinking", thinking: "just a summary", signature: "" }]);
  assert.equal(plain.reasoningCount, 0);
});

for (const shape of ["sealed-index", "content", "text-deltas"] as const) {
  test(`Responses ${shape} reasoning survives a text-free parallel tool turn (#109)`, () => {
    const env = { p: "opencode-go", m: "deepseek-v4.1-flash" };
    const mapper = new OpenAiStreamMapper(env.m, 0, new Map(), env);
    const reasoning = shape === "sealed-index"
      ? { type: "reasoning", id: "rs_109", summary: [], encrypted_content: "sealed-109", content: [] }
      : { type: "reasoning", id: "rs_109", summary: [], content: [{ type: "reasoning_text", text: "  inspect both files\n" }] };
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_109", content: [] } },
      ...(shape === "text-deltas" ? [{ type: "response.reasoning_text.delta", output_index: 0, delta: "  inspect both files\n" }] : []),
      { type: "response.output_item.done", output_index: 0, item: shape === "sealed-index"
        ? { type: "reasoning", summary: [], encrypted_content: "sealed-109" }
        : shape === "text-deltas" ? { type: "reasoning", id: "rs_109", summary: [] } : reasoning },
      ...["a", "b"].flatMap((id, index) => [
        { type: "response.output_item.added", output_index: index + 1, item: { type: "function_call", id, call_id: id, name: "Read", arguments: "{}" } },
        { type: "response.output_item.done", item: { id } },
      ]),
      { type: "response.completed" },
    ].flatMap((event) => mapper.feed(event, "responses"));
    assert.equal(mapper.reasoningCount, 1);
    const signature = events.find((event) => (event.data.delta as { type?: string })?.type === "signature_delta")?.data.delta as { signature: string };
    assert.deepEqual(decodeEnvelope(signature.signature), { w: "responses", ...env, r: reasoning });
    const content = mapper.message().content as AnthropicRequest["messages"][number]["content"];
    const carried = { replayed: 0, undecodable: 0 };
    const next = toOpenAiRequest({ model: "m", messages: [
      { role: "assistant", content },
      { role: "user", content: ["a", "b"].map((id) => ({ type: "tool_result", tool_use_id: id, content: "ok" })) },
    ] }, { model: env.m, wire: "responses", env, carried }) as ResponsesRequest;
    assert.deepEqual(next.input.map((item) => item.type), ["reasoning", "function_call", "function_call", "function_call_output", "function_call_output"]);
    assert.deepEqual(next.input[0], reasoning);
    assert.equal(carried.replayed, 1);
  });
}

// A vendor whose preset measured that it seals reasoning on request is asked on every turn, the first
// included — waiting until a conversation already carried some would never start one. Anyone else
// keeps the request it had, and the retry after a refusal asks for nothing.
test("sealedReasoning asks for the sealed item and a summary from the first turn", () => {
  const caps = { reasoning: "effort" as const };
  const sealed = toOpenAiRequest(request, { model: "m", wire: "responses", effort: "high", caps, sealedReasoning: true }) as ResponsesRequest;
  assert.deepEqual(sealed.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(sealed.reasoning, { effort: "high", summary: "auto" });
  const plain = toOpenAiRequest(request, { model: "m", wire: "responses", effort: "high", caps }) as ResponsesRequest;
  assert.equal(plain.include, undefined);
  assert.deepEqual(plain.reasoning, { effort: "high" });
  const retry = toOpenAiRequest(request, { model: "m", wire: "responses", effort: "high", caps, sealedReasoning: true, replay: false }) as ResponsesRequest;
  assert.equal(retry.include, undefined);
  assert.deepEqual(retry.reasoning, { effort: "high" });
});

/** Reassemble the client's tool inputs and reject reopened blocks or deltas after block_stop. */
function streamedTools(events: { event: string; data: Record<string, unknown> }[]): { id: string; input: unknown }[] {
  const blocks = new Map<number, { id: string; json: string; closed: boolean }>();
  for (const event of events) {
    const index = event.data.index as number;
    if (event.event === "content_block_start") {
      const block = event.data.content_block as { type: string; id: string };
      if (block.type !== "tool_use") continue;
      assert.equal(blocks.has(index), false);
      blocks.set(index, { id: block.id, json: "", closed: false });
    } else if (event.event === "content_block_delta" && (event.data.delta as { type: string }).type === "input_json_delta") {
      const block = blocks.get(index)!;
      assert.equal(block.closed, false);
      block.json += (event.data.delta as { partial_json: string }).partial_json;
    } else if (event.event === "content_block_stop" && blocks.has(index)) {
      assert.equal(blocks.get(index)!.closed, false);
      blocks.get(index)!.closed = true;
    }
  }
  return [...blocks.values()].map((block) => {
    assert.equal(block.closed, true);
    return { id: block.id, input: JSON.parse(block.json) as unknown };
  });
}

test("Responses whole-only arguments are routed by item_id or output_index and streamed once", () => {
  for (const byIndex of [false, true]) {
    const mapper = new OpenAiStreamMapper("test");
    const address = (id: string, output_index: number) => byIndex ? { output_index } : { item_id: id };
    const events = [
      ...["a", "b", "c"].map((id, output_index) => ({ type: "response.output_item.added", output_index, item: { type: "function_call", id, call_id: `call_${id}`, name: "Read" } })),
      { type: "response.function_call_arguments.done", ...address("b", 1), arguments: '{"path":"b"}' },
      { type: "response.output_item.done", ...address("b", 1), item: { type: "function_call", ...(byIndex ? {} : { id: "b" }) } },
      { type: "response.function_call_arguments.delta", ...address("c", 2), delta: '{"path":"c"}' },
      { type: "response.function_call_arguments.done", ...address("c", 2), arguments: '{"path":"c"}' },
      { type: "response.output_item.done", ...address("c", 2), item: { type: "function_call", ...(byIndex ? {} : { id: "c" }), arguments: '{"path":"c"}' } },
      { type: "response.output_item.done", ...address("a", 0), item: { type: "function_call", ...(byIndex ? {} : { id: "a" }), arguments: '{"path":"a"}' } },
      { type: "response.output_item.added", output_index: 3, item: { type: "function_call", id: "d", call_id: "call_d", name: "Read" } },
      { type: "response.function_call_arguments.done", ...address("d", 3), arguments: '{"path":"d"}' },
      { type: "response.output_item.done", ...address("d", 3), item: { type: "function_call", ...(byIndex ? {} : { id: "d" }), arguments: '{"path":"d"}' } },
      { type: "response.completed" },
    ].flatMap((event) => mapper.feed(event, "responses"));
    const expected = ["a", "b", "c", "d"].map((id) => ({ id: `call_${id}`, input: { path: id } }));
    assert.deepEqual(streamedTools([...events, ...mapper.finish()]), expected);
    assert.deepEqual((mapper.message().content as { id: string; input: unknown }[]).map(({ id, input }) => ({ id, input })), expected);
  }
});

test("Chat interleaved parallel call fragments emit one complete block per index", () => {
  const mapper = new OpenAiStreamMapper("grok");
  const events = [
    { index: 0, id: "a", function: { name: "Read", arguments: '{"path":' } },
    { index: 1, id: "b", function: { name: "Read", arguments: '{"path":' } },
    { index: 0, function: { arguments: '"a"}' } },
    { index: 1, function: { arguments: '"b"}' } },
  ].flatMap((call) => mapper.feed({ choices: [{ delta: { tool_calls: [call] } }] }, "chat"));
  events.push(...mapper.feed({ choices: [{ finish_reason: "tool_calls" }] }, "chat"), ...mapper.finish());
  const expected = [{ id: "a", input: { path: "a" } }, { id: "b", input: { path: "b" } }];
  assert.deepEqual(streamedTools(events), expected);
  assert.deepEqual((mapper.message().content as { id: string; input: unknown }[]).map(({ id, input }) => ({ id, input })), expected);
});

test("token-limited tool calls finish as max_tokens on both OpenAI wires", () => {
  for (const wire of ["chat", "responses"] as const) {
    const mapper = new OpenAiStreamMapper("test");
    const events = [];
    if (wire === "chat") events.push(...mapper.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "Read", arguments: '{"path":' } }] }, finish_reason: "length" }] }, wire));
    else {
      events.push(...mapper.feed({ type: "response.output_item.added", item: { type: "function_call", id: "a", name: "Read" } }, wire));
      events.push(...mapper.feed({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }, wire));
    }
    events.push(...mapper.finish());
    assert.equal((events.find((event) => event.event === "message_delta")!.data.delta as { stop_reason: string }).stop_reason, "max_tokens");
    assert.equal(mapper.message().stop_reason, "max_tokens");
  }
});

test("documents reach both OpenAI wires as text, native PDF files or an unsupported-source note", () => {
  const req: AnthropicRequest = { model: "m", messages: [{ role: "user", content: [
    { type: "document", source: { type: "text", data: "text document" } },
    { type: "document", source: { type: "content", content: [{ type: "text", text: "block document" }] } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERG" } },
    { type: "document", source: { type: "url", url: "https://example.com/doc.pdf" } },
  ] }] };
  const chat = toOpenAiRequest(req, { model: "m", wire: "chat", identity: false }) as ChatRequest;
  assert.ok(Array.isArray(chat.messages[0]!.content));
  const parts = chat.messages[0]!.content;
  assert.deepEqual(parts.slice(0, 3), [
    { type: "text", text: "text document" }, { type: "text", text: "block document" },
    { type: "file", file: { filename: "document.pdf", file_data: "data:application/pdf;base64,UERG" } },
  ]);
  assert.match((parts[3] as { text: string }).text, /문서.*전달하지 못했습니다/);
  const responses = toOpenAiRequest(req, { model: "m", wire: "responses" }) as ResponsesRequest;
  const content = (responses.input[0] as { content: { text?: string }[] }).content;
  assert.deepEqual(content.slice(0, 3), [
    { type: "input_text", text: "text document" }, { type: "input_text", text: "block document" },
    { type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,UERG" },
  ]);
  assert.match(content[3]!.text!, /문서.*전달하지 못했습니다/);
});

test("a preset that keys its prompt cache on the conversation gets it on both wires, and nobody else does", () => {
  const request: AnthropicRequest = { model: "m", max_tokens: 64, messages: [{ role: "user", content: "hi" }] };
  for (const wire of ["chat", "responses"] as const) {
    assert.equal((toOpenAiRequest(request, { model: "m", wire, promptCacheKey: "abc" }) as ChatRequest | ResponsesRequest).prompt_cache_key, "abc", wire);
    assert.equal("prompt_cache_key" in toOpenAiRequest(request, { model: "m", wire }), false, `${wire}: a vendor that does not know the field may refuse it`);
  }
});
