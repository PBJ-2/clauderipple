import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamMapper, conversationId, conversationKey, estimateTokens, formatSse, normalizeSchema, toResponsesRequest, toolNameForResponses, toolNameRestoreMap, type AnthropicRequest } from "../src/providers/chatgpt/translate.ts";
import { SseParser } from "../src/providers/chatgpt/sse.ts";
import { encodeEnvelope } from "../src/reasoning.ts";

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
  assert.equal(r.prompt_cache_key, conversationId(turn2), "cache key must not change across turns");
  assert.match(r.prompt_cache_key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a UUID, as the CLI names a conversation");
  assert.equal(r.client_metadata.session_id, r.prompt_cache_key);
  assert.equal(r.client_metadata.thread_id, r.prompt_cache_key);
  assert.equal(r.client_metadata["x-codex-window-id"], `${r.prompt_cache_key}:0`);
  assert.match(r.client_metadata.turn_id, /^[0-9a-f-]{36}$/, "a fresh turn id per request");
});

// What the CLI sends beside a conversation: no metadata, one message, a different query each time.
// The shape is the one websearch.test.ts reads off the binary.
const sideRequest = (query: string, system = "You are an assistant for performing a web search tool use"): AnthropicRequest => ({
  model: "deepseek-v4.1-flash",
  system: [{ type: "text", text: system }],
  messages: [{ role: "user", content: `Perform a web search for the query: ${query}` }],
  tools: [{ type: "web_search_20250305", name: "web_search" }],
  max_tokens: 1024,
});

test("side requests of one kind share a key, so the prefix they all send can cache", () => {
  // Before: one key per request, and the shared prefix was never read back — 68 calls, 0 hits.
  assert.equal(
    conversationKey(sideRequest("Node.js 24 LTS release date")),
    conversationKey(sideRequest("TypeScript 6 release date")),
    "two searches are the same class of request, however different the query",
  );
});

test("a different kind of side request is a different key", () => {
  assert.notEqual(
    conversationKey(sideRequest("x", "Summarise this conversation in five words")),
    conversationKey(sideRequest("x")),
    "the system prompt is what names the class; two classes must not share a cache lineage",
  );
});

test("a conversation is still keyed on its opening message, not on its system prompt", () => {
  const a: AnthropicRequest = { ...turn1, messages: [{ role: "user", content: [{ type: "text", text: "read foo.ts" }] }] };
  const b: AnthropicRequest = { ...turn1, messages: [{ role: "user", content: [{ type: "text", text: "a different opening" }] }] };
  assert.notEqual(conversationKey(a), conversationKey(b), "one user's two conversations must not collapse onto one key");
});

test("a conversation with no metadata keeps its key from its second turn on", () => {
  // The OpenAI ingress builds no metadata, and its traffic is real multi-turn conversation.
  const { metadata: _drop, ...noMeta } = turn1;
  const opening: AnthropicRequest = { ...noMeta, messages: [{ role: "user", content: [{ type: "text", text: "read foo.ts" }] }] };
  const second: AnthropicRequest = { ...noMeta, messages: turn2.messages };
  const third: AnthropicRequest = { ...noMeta, messages: [...turn2.messages, { role: "user", content: [{ type: "text", text: "now read bar.ts" }] }] };
  assert.equal(conversationKey(second), conversationKey(third), "a metadata-less conversation must not move once it is under way");
  assert.notEqual(conversationKey(opening), conversationKey(second), "its opening turn is indistinguishable from a side request, and is keyed as one");
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

test("the image hint follows the addendum on the session's own turns, never a subagent's", () => {
  const req = { model: "m", messages: [{ role: "user" as const, content: "draw a cat" }] };
  const main = toResponsesRequest(req, { ...opts, identity: false, instructionsAppend: "Be brief.", imageHint: "IMG" });
  assert.equal(main.instructions, "Be brief.\n\nIMG");
  const sub = toResponsesRequest(req, { ...opts, identity: false, instructionsAppend: "Be brief.", imageHint: "IMG", subagent: true });
  assert.equal(sub.instructions, "Be brief.");
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
  const b = p.feed('2}\n\ndata: {"c":\ndata: 3}\r\n\r\ndata: [DONE]\n\ndata: {"ignored":true}\n\n');
  assert.deepEqual(b, [{ b: 2 }, { c: 3 }]);
  assert.equal(p.sawDone, true);
  assert.deepEqual(p.feed('data: {"ignored":true}\n\n'), []);
});

test("tool schemas: patterns the Codex regex engine rejects are dropped, others kept", () => {
  const schema = {
    type: "object",
    properties: {
      field: { type: "string", pattern: '^(?!__.*__$)[^\\p{Cc}"\\\\./[\\]]{1,200}$' }, // lookahead → dropped
      doc_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,200}$" }, // plain → kept
      nested: { type: "array", items: { type: "object", properties: { x: { type: "string", pattern: "(a)\\1" } } } }, // backreference → dropped
      // The Artifact tool's `file_paths` items. OpenCode Go refuses the whole request over this
      // one escape (measured 2026-09-19); it is the same class as the two above.
      file_paths: { type: "array", items: { maxLength: 1024, minLength: 1, type: "string", pattern: "^[^\\0]*$" } },
      digits: { type: "string", pattern: "^\\d+$" }, // \d is not an escape either backend rejects → kept
    },
    required: ["field"],
  };
  const out = normalizeSchema(schema) as { properties: Record<string, Record<string, unknown>>; required: string[] };
  assert.equal(out.properties.field!.pattern, undefined);
  assert.equal(out.properties.doc_id!.pattern, "^[A-Za-z0-9_-]{1,200}$");
  const paths = out.properties.file_paths!.items as Record<string, unknown>;
  assert.equal(paths.pattern, undefined, "the \\0 escape must be dropped");
  assert.equal(paths.maxLength, 1024, "the rest of the schema is kept: only the pattern offends");
  assert.equal(out.properties.digits!.pattern, "^\\d+$");
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

// Anthropic runs these; a translated provider cannot. Declaring one offers a tool that can only
// fail silently. The shape below is Claude Code's real web-search side query (read from the CLI
// binary, 2.1.271): one forced server tool and nothing else.
test("server tools are dropped, and a tool_choice that named one goes with them", () => {
  const r = toResponsesRequest({
    model: "x",
    max_tokens: 10,
    tools: [
      { name: "web_search", type: "web_search_20250305", max_uses: 8 } as never,
      { name: "Read", type: "custom", input_schema: { type: "object", properties: {} } },
      { name: "Edit", input_schema: { type: "object", properties: {} } },
    ],
    tool_choice: { type: "tool", name: "web_search" },
    messages: [{ role: "user", content: "Perform a web search for the query: node 24" }],
  }, opts);
  assert.deepEqual(r.tools?.map((t) => t.name), ["Read", "Edit"], "a tool with no type is a custom tool and stays");
  assert.equal("tool_choice" in r && r.tool_choice !== undefined, false, "forcing a dropped tool would be worse than dropping it");
});

test("a request that is only a server tool declares no tools at all", () => {
  const r = toResponsesRequest({
    model: "x",
    max_tokens: 10,
    tools: [{ name: "web_search", type: "web_search_20250305", max_uses: 8 } as never],
    tool_choice: { type: "tool", name: "web_search" },
    messages: [{ role: "user", content: "Perform a web search for the query: node 24" }],
  }, opts);
  assert.equal(r.tools, undefined, "no tools left means the field is omitted, not sent empty");
  assert.equal(r.tool_choice, undefined);
});

// Claude Code declares the advisor on every subagent and explains it in an `isMeta` user message
// (CLI 2.1.286). The declaration is dropped above; the explanation would stay and send a routed
// worker looking for a tool it does not have.
const advisorTurn: AnthropicRequest = {
  ...turn1,
  tools: [...(turn1.tools ?? []), { type: "advisor_20260301", name: "advisor", model: "claude-fable-5-1" } as never],
  messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>\n# Advisor Tool\n\nYou have access to an `advisor` tool…\n</system-reminder>" }, { type: "text", text: "read foo.ts" }] }],
};

test("a dropped server tool's instructions are withdrawn in one line after the system prompt", () => {
  const r = toResponsesRequest(advisorTurn, opts);
  assert.deepEqual(r.tools?.map((t) => t.name), ["Read"]);
  assert.match(r.instructions, /You are Claude Code\.\n\nNot available in this session: `advisor`\. /, "right after the caller's system text");
  assert.match(r.instructions, /Disregard any instruction to use them/);
  assert.equal(toResponsesRequest(advisorTurn, opts).instructions, r.instructions, "same request, same bytes: the cached prefix must not move");
});

test("no server tool, no note", () => {
  assert.doesNotMatch(toResponsesRequest(turn1, opts).instructions, /Not available in this session/);
});

test("the note names every dropped tool once, in a fixed order", () => {
  const both = (order: "ab" | "ba"): AnthropicRequest => {
    const a = { type: "advisor_20260301", name: "advisor" } as never;
    const w = { type: "web_search_20250305", name: "web_search", max_uses: 8 } as never;
    return { ...turn1, tools: order === "ab" ? [a, w] : [w, a] };
  };
  const r = toResponsesRequest(both("ab"), opts);
  assert.match(r.instructions, /Not available in this session: `advisor`, `web_search`\./);
  assert.equal(toResponsesRequest(both("ba"), opts).instructions, r.instructions, "declaration order does not change the bytes");
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

test("tool result images are delivered as vision input after the function output", () => {
  const r = toResponsesRequest(
    {
      model: "x",
      max_tokens: 10,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "shot_1", name: "screenshot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "shot_1", content: [
          { type: "text", text: "Screenshot size: 800x600" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ] }] },
      ],
    } as never,
    { model: "gpt-6-astra", effort: "max", identity: true },
  );
  assert.deepEqual(r.input.map((item) => item.type), ["function_call", "function_call_output", "message"]);
  assert.equal((r.input[1] as { output: string }).output, "Screenshot size: 800x600");
  assert.deepEqual((r.input[2] as { content: unknown[] }).content, [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }]);
  assert.equal(JSON.stringify(r.input).includes("[image omitted]"), false);
});

test("Claude Code's fast mode asks the ChatGPT backend for the Codex fast tier", () => {
  assert.equal(toResponsesRequest({ ...turn1, speed: "fast" }, opts).service_tier, "priority");
  assert.equal(toResponsesRequest(turn1, opts).service_tier, undefined);
  assert.equal(toResponsesRequest({ ...turn1, speed: "standard" }, opts).service_tier, undefined);
});

// Claude Code never asks for `speed: "fast"` on a GPT request (its own client gate), so the tier is
// chosen by the provider's switches: one for the session's own turns, one for a subagent's.
test("the provider's Fast switches ask for the Codex fast tier, main and subagent apart", () => {
  assert.equal(toResponsesRequest(turn1, { ...opts, fast: { main: true } }).service_tier, "priority", "a main turn with fast.main on");
  assert.equal(toResponsesRequest(turn1, { ...opts, fast: { subagent: true } }).service_tier, undefined, "a main turn is not a subagent's");
  assert.equal(toResponsesRequest(turn1, { ...opts, fast: { subagent: true }, subagent: true }).service_tier, "priority", "a subagent turn with fast.subagent on");
  assert.equal(toResponsesRequest(turn1, { ...opts, fast: { main: true }, subagent: true }).service_tier, undefined, "fast.main does not reach a subagent's turn");
  assert.equal(toResponsesRequest(turn1, { ...opts, fast: { main: true, subagent: true } }).service_tier, "priority");
  assert.equal(toResponsesRequest(turn1, { ...opts, fast: { main: false, subagent: false } }).service_tier, undefined);
  assert.equal(toResponsesRequest(turn1, { ...opts, fast: {} }).service_tier, undefined);
  assert.equal(toResponsesRequest(turn1, opts).service_tier, undefined, "no switches at all is the default");
});

test("`speed: fast` still asks for the fast tier whichever switch is on", () => {
  assert.equal(toResponsesRequest({ ...turn1, speed: "fast" }, { ...opts, fast: { main: false, subagent: false } }).service_tier, "priority");
  assert.equal(toResponsesRequest({ ...turn1, speed: "fast" }, { ...opts, fast: { main: true }, subagent: true }).service_tier, "priority");
  // The switch is the provider's own choice, so it asks for the tier whatever `speed` says.
  assert.equal(toResponsesRequest({ ...turn1, speed: "standard" }, { ...opts, fast: { main: true } }).service_tier, "priority");
  assert.equal(toResponsesRequest({ ...turn1, speed: "standard" }, { ...opts, fast: { main: false, subagent: false } }).service_tier, undefined);
});

test("the provider's Ultrafast switches ask for the ultrafast tier only on a model that advertises it", () => {
  const tiers = { modelTiers: ["priority", "ultrafast"] };
  assert.equal(toResponsesRequest(turn1, { ...opts, ...tiers, ultrafast: { main: true } }).service_tier, "ultrafast");
  assert.equal(toResponsesRequest(turn1, { ...opts, ...tiers, ultrafast: { subagent: true }, subagent: true }).service_tier, "ultrafast");
  assert.equal(toResponsesRequest(turn1, { ...opts, ultrafast: { main: true } }).service_tier, undefined);
  assert.equal(toResponsesRequest(turn1, { ...opts, modelTiers: ["priority"], fast: { main: true }, ultrafast: { main: true } }).service_tier, "priority");
  assert.equal(toResponsesRequest({ ...turn1, speed: "fast" }, { ...opts, ...tiers, ultrafast: { main: true } }).service_tier, "ultrafast");
});

// ---- reasoning replay (reasoning.ts) -----------------------------------------------------------

const codexEnv = { p: "chatgpt", m: "gpt-5.6-terra" };

// One round trip at the translate layer: the carrier the response path writes is read back by the
// request path, and comes out as the backend's own item in the position the CLI replayed it from.
test("a carrier written by the mapper is replayed by the request builder, in place", () => {
  const mapper = new StreamMapper("gpt-5.6-terra", 0, new Map(), codexEnv.p);
  const events = mapper.feed({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } })
    .concat(mapper.feed({ type: "response.reasoning_summary_text.delta", delta: "why", item_id: "rs_1" }))
    .concat(mapper.feed({ type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAsealed" } }));
  // The block as the client assembles it from the stream: text from the deltas, signature last.
  const start = events.find((e) => e.event === "content_block_start")!;
  const block = start.data.content_block as { type: "thinking"; thinking: string; signature: string };
  assert.equal(block.type, "thinking");
  block.thinking = events
    .filter((e) => e.event === "content_block_delta" && (e.data.delta as { type: string }).type === "thinking_delta")
    .map((e) => (e.data.delta as { thinking: string }).thinking)
    .join("");
  for (const e of events) {
    if (e.event === "content_block_delta" && (e.data.delta as { type: string }).type === "signature_delta") {
      block.signature = (e.data.delta as { signature: string }).signature;
    }
  }
  assert.equal(block.thinking, "why");

  const carried = { replayed: 0, undecodable: 0 };
  const arrived: (string | undefined)[] = [];
  const out = toResponsesRequest(
    {
      ...turn1,
      messages: [
        turn1.messages[0]!,
        { role: "assistant", content: [block, { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
      ],
    },
    { ...opts, env: codexEnv, carried, onArrival: (_item, afterCallId) => arrived.push(afterCallId) },
  );
  assert.deepEqual(out.input.map((i) => i.type), ["message", "reasoning", "function_call", "function_call_output"]);
  assert.deepEqual(out.input[1], { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAsealed" });
  assert.deepEqual(out.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(carried, { replayed: 1, undecodable: 0 });
  assert.deepEqual(arrived, [undefined], "a lead-in summary belongs before the turn's calls, where the item itself came first");
});

// A conversation with no reasoning of ours maps its input exactly as before, and still asks for the
// sealed item: without `include` a `store: false` backend hands back nothing, so a conversation that
// waited until it already carried reasoning would never start carrying any.
test("no carrier: the old input, and include asked for from the first turn", () => {
  const withEnv = toResponsesRequest(turn2, { ...opts, env: codexEnv });
  const without = toResponsesRequest(turn2, opts);
  assert.deepEqual(withEnv.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(withEnv.input, without.input);
  assert.equal(JSON.stringify(withEnv.input).includes("encrypted_content"), false);
});

// `replay: false` is the retry after the backend refused a sealed blob, and it must be exactly the
// request this adapter sent before any of this existed.
test("replay: false carries nothing and asks for nothing", () => {
  const block = { type: "thinking" as const, thinking: "why", signature: encodeEnvelope({ w: "responses" as const, p: "chatgpt", m: "gpt-5.6-terra", r: { type: "reasoning", encrypted_content: "gAAAAsealed" } }) };
  const out = toResponsesRequest(
    { ...turn1, messages: [turn1.messages[0]!, { role: "assistant", content: [block, { type: "tool_use", id: "call_1", name: "Read", input: {} }] }] },
    { ...opts, env: codexEnv, replay: false },
  );
  assert.equal(out.include, undefined);
  assert.equal(JSON.stringify(out.input).includes("encrypted_content"), false);
});

// gpt-6.1-sol sent four parallel calls with no argument deltas at all (2026-10-23); each reached
// Claude Code as `{}` and failed "required parameter file_path". Whole arguments must still stream.
test("a call whose arguments arrive only whole streams them once, on .done or on the completed item", () => {
  const partial = (events: Record<string, unknown>[]) => {
    const m = new StreamMapper("gpt-6.1-sol");
    const out = events.flatMap((e) => m.feed(e));
    const json = new Map<number, string>();
    for (const e of out) {
      if (e.event !== "content_block_delta") continue;
      const d = e.data as { index: number; delta: { type: string; partial_json?: string } };
      if (d.delta.type === "input_json_delta") json.set(d.index, (json.get(d.index) ?? "") + d.delta.partial_json);
    }
    return [...json.values()];
  };
  const added = (id: string) => ({ type: "response.output_item.added", item: { type: "function_call", call_id: `call_${id}`, id, name: "Read", arguments: "" } });
  // Arguments only on function_call_arguments.done.
  assert.deepEqual(partial([
    added("fc_1"), { type: "response.function_call_arguments.done", arguments: '{"file_path":"/a"}', item_id: "fc_1" }, { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", arguments: '{"file_path":"/a"}' } },
    added("fc_2"), { type: "response.function_call_arguments.done", arguments: '{"file_path":"/b"}', item_id: "fc_2" }, { type: "response.output_item.done", item: { type: "function_call", id: "fc_2", arguments: '{"file_path":"/b"}' } },
  ]), ['{"file_path":"/a"}', '{"file_path":"/b"}']);
  // Arguments only on the completed item.
  assert.deepEqual(partial([added("fc_1"), { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", arguments: '{"command":"ls"}' } }]), ['{"command":"ls"}']);
  // Deltas and a .done that repeats them: sent once, not twice.
  assert.deepEqual(partial([
    added("fc_1"),
    { type: "response.function_call_arguments.delta", delta: '{"file_path"', item_id: "fc_1" },
    { type: "response.function_call_arguments.delta", delta: ':"/a"}', item_id: "fc_1" },
    { type: "response.function_call_arguments.done", arguments: '{"file_path":"/a"}', item_id: "fc_1" },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", arguments: '{"file_path":"/a"}' } },
  ]), ['{"file_path":"/a"}']);
});

test("parallel calls keep deltas and whole-only arguments on their own live block", () => {
  for (const byIndex of [false, true]) {
    const mapper = new StreamMapper("test");
    const address = (id: string, index: number) => byIndex ? { output_index: index } : { item_id: id };
    const events = [
      ...["a", "b", "c"].map((id, output_index) => ({ type: "response.output_item.added", output_index, item: { type: "function_call", id, call_id: `call_${id}`, name: "Read" } })),
      { type: "response.function_call_arguments.delta", ...address("a", 0), delta: '{"path":' },
      { type: "response.function_call_arguments.done", ...address("b", 1), arguments: '{"path":"b"}' },
      { type: "response.output_item.done", ...address("b", 1), item: { type: "function_call", ...(byIndex ? {} : { id: "b" }), arguments: '{"path":"b"}' } },
      { type: "response.function_call_arguments.delta", ...address("a", 0), delta: '"a"}' },
      { type: "response.function_call_arguments.done", ...address("a", 0), arguments: '{"path":"a"}' },
      { type: "response.output_item.done", ...address("a", 0), item: { type: "function_call", ...(byIndex ? {} : { id: "a" }), arguments: '{"path":"a"}' } },
      { type: "response.output_item.done", ...address("c", 2), item: { type: "function_call", ...(byIndex ? {} : { id: "c" }), arguments: '{"path":"c"}' } },
      { type: "response.completed" },
    ].flatMap((event) => mapper.feed(event));
    const blocks = new Map<number, { id: string; json: string; closed: boolean }>();
    for (const event of events) {
      const index = event.data.index as number;
      if (event.event === "content_block_start") {
        assert.equal(blocks.has(index), false);
        blocks.set(index, { id: (event.data.content_block as { id: string }).id, json: "", closed: false });
      } else if (event.event === "content_block_delta") {
        const block = blocks.get(index)!;
        assert.equal(block.closed, false, "arguments cannot arrive after block_stop");
        block.json += (event.data.delta as { partial_json: string }).partial_json;
      } else if (event.event === "content_block_stop") {
        assert.equal(blocks.get(index)!.closed, false);
        blocks.get(index)!.closed = true;
      }
    }
    assert.deepEqual([...blocks.values()].map((block) => [block.id, JSON.parse(block.json), block.closed]), [
      ["call_a", { path: "a" }, true], ["call_b", { path: "b" }, true], ["call_c", { path: "c" }, true],
    ]);
    assert.deepEqual((mapper.message().content as { input: unknown }[]).map((block) => block.input), [{ path: "a" }, { path: "b" }, { path: "c" }]);
  }
});

test("a truncated tool call ends with max_tokens rather than tool_use", () => {
  const mapper = new StreamMapper("test");
  mapper.feed({ type: "response.output_item.added", item: { type: "function_call", id: "a", name: "Read" } });
  mapper.feed({ type: "response.function_call_arguments.delta", item_id: "a", delta: '{"path":' });
  const events = mapper.feed({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } });
  assert.equal((events.find((event) => event.event === "message_delta")!.data.delta as { stop_reason: string }).stop_reason, "max_tokens");
  assert.equal(mapper.message().stop_reason, "max_tokens");
});

test("documents preserve text and content sources, send PDF bytes, and explain unsupported sources", () => {
  const out = toResponsesRequest({ model: "m", messages: [{ role: "user", content: [
    { type: "document", source: { type: "text", data: "text document" } },
    { type: "document", source: { type: "content", content: [{ type: "text", text: "block document" }] } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERG" } },
    { type: "document", source: { type: "url", url: "https://example.com/doc.pdf" } },
  ] }] }, opts);
  assert.deepEqual((out.input[0] as { content: unknown[] }).content.slice(0, 3), [
    { type: "input_text", text: "text document" }, { type: "input_text", text: "block document" },
    { type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,UERG" },
  ]);
  assert.match(((out.input[0] as { content: { text: string }[] }).content[3]!).text, /문서.*전달하지 못했습니다/);
});

test("schema literals under const, enum, default and examples are not scrubbed", () => {
  const data = { pattern: "^(?!literal)$", nested: { pattern: "(a)\\1" } };
  const schema = { type: "object", properties: { value: { pattern: "^(?!schema)$", const: data, enum: [data], default: data, examples: [data] } } };
  const before = structuredClone(schema);
  const out = normalizeSchema(schema) as { properties: { value: Record<string, unknown> } };
  assert.deepEqual(out.properties.value, { const: data, enum: [data], default: data, examples: [data] });
  assert.deepEqual(schema, before);
});
