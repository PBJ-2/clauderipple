import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamMapper, conversationKey, estimateTokens, formatSse, normalizeSchema, toResponsesRequest, toolNameForResponses, toolNameRestoreMap, type AnthropicRequest } from "../src/providers/chatgpt/translate.ts";
import { SseParser } from "../src/providers/chatgpt/sse.ts";

const opts = { model: "gpt-5.6-terra", effort: "high", identity: true };

const turn1: AnthropicRequest = {
  model: "claude-opus-4-6",
  system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.266" }, { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "read foo.ts" }] }],
  tools: [{ name: "Read", description: "Reads a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } }],
  stream: true,
  metadata: { user_id: "user_abc_session_123" },
};

const turn2: AnthropicRequest = {
  ...turn1,
  messages: [
    ...turn1.messages,
    { role: "assistant", content: [{ type: "thinking", thinking: "let me read", signature: "" }, { type: "text", text: "Reading." }, { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "foo.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "export const a = 1;" }] }] },
  ],
};

test("system → instructions with identity line; tools → function tools; cache key stable", () => {
  const r = toResponsesRequest(turn1, opts);
  assert.ok(r.instructions.startsWith("You are gpt-5.6-terra (reasoning effort: "), r.instructions.slice(0, 80));
  assert.ok(r.instructions.includes("), answering through Claude Code"));
  assert.ok(r.instructions.includes("You are Claude Code."));
  assert.ok(!r.instructions.includes("x-anthropic-billing-header"), "per-turn billing telemetry must not reach the provider (cache)");
  assert.equal(r.tools?.length, 1);
  assert.equal(r.tools?.[0]?.type, "function");
  assert.equal(r.tools?.[0]?.name, "Read");
  assert.equal(r.tool_choice, "auto");
  assert.equal(r.parallel_tool_calls, true);
  assert.equal(r.store, false);
  assert.equal(r.reasoning.effort, "high");
  assert.equal(r.prompt_cache_key, conversationKey(turn2), "cache key must not change across turns");
});

test("turn N input is a strict prefix of turn N+1 input (prompt cache prerequisite)", () => {
  const a = toResponsesRequest(turn1, opts);
  const b = toResponsesRequest(turn2, opts);
  assert.equal(a.instructions, b.instructions);
  assert.deepEqual(b.input.slice(0, a.input.length), a.input);
  assert.deepEqual(
    b.input.slice(a.input.length).map((i) => i.type),
    ["message", "function_call", "function_call_output"],
    "thinking dropped; assistant text, tool_use and tool_result mapped in order",
  );
  const fc = b.input[2] as { call_id: string; name: string; arguments: string };
  assert.equal(fc.call_id, "call_1");
  assert.equal(fc.arguments, JSON.stringify({ file_path: "foo.ts" }));
  const fo = b.input[3] as { call_id: string; output: string };
  assert.equal(fo.output, "export const a = 1;");
});

test("tool_choice and images map; string content works", () => {
  const r = toResponsesRequest(
    {
      model: "m",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "what is this" }] }, { role: "assistant", content: "a png" }],
      tools: [{ name: "T", input_schema: {} }],
      tool_choice: { type: "tool", name: "T", disable_parallel_tool_use: true },
    },
    { ...opts, identity: false, instructionsAppend: "Be brief." },
  );
  assert.equal(r.instructions, "Be brief.");
  assert.deepEqual(r.tool_choice, { type: "function", name: "T" });
  assert.equal(r.parallel_tool_calls, false);
  const m0 = r.input[0] as { content: { type: string }[] };
  assert.deepEqual(m0.content.map((c) => c.type), ["input_image", "input_text"]);
  const m1 = r.input[1] as { role: string; content: { type: string; text: string }[] };
  assert.equal(m1.role, "assistant");
  assert.equal(m1.content[0]?.type, "output_text");
  assert.equal((r.tools?.[0]?.parameters as { type: string }).type, "object");
  assert.ok(estimateTokens(turn1) > 10);
});

test("stream mapper: text + tool call + completed → Anthropic events with usage and stop_reason", () => {
  const m = new StreamMapper("gpt-5.6-terra");
  const evs = [
    { type: "codex.rate_limits", plan_type: "prolite", rate_limits: { primary: { used_percent: 11 } } },
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" }, output_index: 0 },
    { type: "response.reasoning_summary_text.delta", delta: "thinking…", item_id: "rs_1" },
    { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1" } },
    { type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant" }, output_index: 1 },
    { type: "response.output_text.delta", delta: "Hello ", item_id: "msg_1" },
    { type: "response.output_text.delta", delta: "world", item_id: "msg_1" },
    { type: "response.output_item.done", item: { type: "message", id: "msg_1" } },
    { type: "response.output_item.added", item: { type: "function_call", call_id: "call_SNO4", id: "fc_1", name: "Edit", arguments: "", status: "in_progress" }, output_index: 2 },
    { type: "response.function_call_arguments.delta", delta: '{"file', item_id: "fc_1" },
    { type: "response.function_call_arguments.delta", delta: '_path":"a.ts"}', item_id: "fc_1" },
    { type: "response.function_call_arguments.done", arguments: '{"file_path":"a.ts"}', item_id: "fc_1" },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_1" } },
    { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 20 } } },
  ];
  const out = evs.flatMap((e) => m.feed(e as Record<string, unknown>));
  const names = out.map((e) => e.event);
  assert.equal(names[0], "message_start");
  assert.ok(names.includes("content_block_start"));
  assert.equal(names.filter((n) => n === "content_block_stop").length, 3);
  assert.deepEqual(names.slice(-2), ["message_delta", "message_stop"]);
  const starts = out.filter((e) => e.event === "content_block_start").map((e) => (e.data.content_block as { type: string }).type);
  assert.deepEqual(starts, ["thinking", "text", "tool_use"]);
  const toolStart = out.find((e) => e.event === "content_block_start" && (e.data.content_block as { type: string }).type === "tool_use")!;
  assert.equal((toolStart.data.content_block as { id: string }).id, "call_SNO4");
  const jsonDeltas = out.filter((e) => e.event === "content_block_delta" && (e.data.delta as { type: string }).type === "input_json_delta").map((e) => (e.data.delta as { partial_json: string }).partial_json).join("");
  assert.equal(jsonDeltas, '{"file_path":"a.ts"}');
  const md = out.find((e) => e.event === "message_delta")!;
  assert.equal((md.data.delta as { stop_reason: string }).stop_reason, "tool_use");
  assert.deepEqual(md.data.usage, { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 });
  assert.equal(m.rateLimits?.plan_type, "prolite");
  const msg = m.message() as { content: { type: string; input?: unknown; text?: string }[]; stop_reason: string };
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content[2], { type: "tool_use", id: "call_SNO4", name: "Edit", input: { file_path: "a.ts" } });
  assert.equal(msg.content[1]?.text, "Hello world");
  assert.equal(m.feed({ type: "response.completed" }).length, 0, "no events after finish");
});

test("stream mapper: upstream error event becomes an Anthropic error event", () => {
  const m = new StreamMapper("gpt-5.6-sol");
  const out = m.feed({ type: "error", error: { code: "server_is_overloaded", message: "Our servers are currently overloaded." }, sequence_number: 2 });
  assert.deepEqual(out.map((e) => e.event), ["message_start", "error"]);
  assert.equal((out[1]!.data.error as { type: string }).type, "overloaded_error");
  assert.ok(formatSse(out[1]!).startsWith("event: error\ndata: "));
});

test("sse parser handles split frames, multi-line data and [DONE]", () => {
  const p = new SseParser();
  const a = p.feed('event: x\ndata: {"a":1}\n\nevent: y\ndata: {"b":');
  assert.deepEqual(a, [{ a: 1 }]);
  const b = p.feed('2}\n\ndata: [DONE]\n\ndata: {"c":\ndata: 3}\r\n\r\n');
  assert.deepEqual(b, [{ b: 2 }, { c: 3 }]);
});

test("tool schemas: patterns the Codex regex engine rejects are dropped, others kept", () => {
  const schema = {
    type: "object",
    properties: {
      field: { type: "string", pattern: '^(?!__.*__$)[^\\p{Cc}"\\\\./[\\]]{1,200}$' }, // lookahead → dropped
      doc_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,200}$" }, // plain → kept
      nested: { type: "array", items: { type: "object", properties: { x: { type: "string", pattern: "(a)\\1" } } } }, // backreference → dropped
    },
    required: ["field"],
  };
  const out = normalizeSchema(schema) as { properties: Record<string, Record<string, unknown>>; required: string[] };
  assert.equal(out.properties.field!.pattern, undefined);
  assert.equal(out.properties.doc_id!.pattern, "^[A-Za-z0-9_-]{1,200}$");
  const x = (out.properties.nested!.items as { properties: { x: Record<string, unknown> } }).properties.x;
  assert.equal(x.pattern, undefined);
  assert.deepEqual(out.required, ["field"]);
  assert.equal(schema.properties.field.pattern.length > 0, true); // input untouched
});

// The Responses API takes `^[a-zA-Z0-9_-]{1,64}$` and fails the whole request on one bad name.
// Claude Code's MCP names (`mcp__<uuid server>__<tool>`) pass 64 routinely.
const longMcp = "mcp__claude_ai_Korea_Investment_Securities__get_overseas_stock_chart"; // 68

test("tool names: legal ones untouched, over-long ones mangled deterministically within the limit", () => {
  assert.equal(toolNameForResponses("Read"), "Read");
  assert.equal(toolNameForResponses("mcp__short__tool"), "mcp__short__tool");

  const m = toolNameForResponses(longMcp);
  assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(m), m);
  assert.equal(m.length, 64);
  assert.equal(m, toolNameForResponses(longMcp)); // stable → cache prefix does not move
  assert.equal(m, `${longMcp.slice(0, 55)}_105ec833`); // 55 of the original + "_" + 8 hex

  // Illegal characters are sanitised, and the hash keeps two names that sanitise alike apart.
  assert.notEqual(toolNameForResponses("a.b"), toolNameForResponses("a-b"));
  assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(toolNameForResponses("a.b")));
});

test("over-long tool names are mangled on every outbound site and restored on the way back", () => {
  const req: AnthropicRequest = {
    model: "x",
    max_tokens: 10,
    tools: [{ name: longMcp, input_schema: { type: "object", properties: {} } }, { name: "Read", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "tool", name: longMcp },
    messages: [
      { role: "user", content: [{ type: "text", text: "quote please" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: longMcp, input: { symbol: "AAPL" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "182.3" }] },
    ],
  };
  const r = toResponsesRequest(req, opts);
  const mangled = toolNameForResponses(longMcp);

  // declarations, tool_choice and the replayed assistant turn all agree, and nothing exceeds 64
  for (const t of r.tools ?? []) assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(t.name), t.name);
  assert.equal(r.tools?.[0]?.name, mangled);
  assert.equal(r.tools?.[1]?.name, "Read"); // legal name still byte-identical
  assert.deepEqual(r.tool_choice, { type: "function", name: mangled });
  const call = r.input.find((i) => i.type === "function_call") as { name: string };
  assert.equal(call.name, mangled);

  // the model echoes the mangled name; Claude Code only recognises the original
  const map = toolNameRestoreMap(req);
  assert.equal(map.get(mangled), longMcp);
  assert.equal(map.has("Read"), false);
  const mapper = new StreamMapper("gpt-5.6-terra", 0, map);
  mapper.start();
  mapper.feed({ type: "response.output_item.added", item: { type: "function_call", call_id: "call_2", id: "item_1", name: mangled }, output_index: 0 });
  const block = mapper.content.find((c) => c.type === "tool_use") as { name: string };
  assert.equal(block.name, longMcp);
});

test("orphan tool_result (Claude Code side query) becomes user text, matched ones stay function_call_output", () => {
  const r = toResponsesRequest(
    {
      model: "x",
      max_tokens: 10,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_orphan", content: "big file" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_ok", name: "Read", input: { p: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_ok", content: "ok" }] },
      ],
    } as never,
    { model: "gpt-5.6-terra", effort: "high", identity: true },
  );
  const types = r.input.map((i) => i.type);
  assert.deepEqual(types, ["message", "function_call", "function_call_output"]);
  assert.ok(JSON.stringify(r.input[0]).includes("[Tool result]\\nbig file"));
});
