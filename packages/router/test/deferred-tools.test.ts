import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForCompatible, STRICT_COMPAT_CAPS } from "../src/compat.ts";
import { StreamMapper, toResponsesRequest, toolNameForResponses, toolNameRestoreMap, type AnthropicRequest, type AnthropicTool } from "../src/providers/chatgpt/translate.ts";
import { OpenAiStreamMapper, toOpenAiRequest, type ChatRequest, type ResponsesRequest } from "../src/providers/openai/translate.ts";
import { GoogleStreamMapper, toGeminiRequest } from "../src/providers/google/translate.ts";

const longName = "mcp__claude_ai_Korea_Investment_Securities__get_overseas_stock_chart";
const schema = {
  type: "object",
  properties: {
    symbol: { type: "string", pattern: "^[A-Z]+$" },
    path: { type: "string", pattern: "^[^\\0]*$" },
    literal: { const: { pattern: "^(?!literal)$" } },
  },
  required: ["symbol"],
};
const scrubbedSchema = {
  ...schema,
  properties: { ...schema.properties, path: { type: "string" } },
};
const addition = (definition: AnthropicTool) => ({ type: "tool_addition", tool: { type: "tool_definition", definition } });

function mixedRequest(): AnthropicRequest {
  return {
    model: "m",
    system: "Stable system prefix.",
    tools: [{ name: "Read", description: "Explicit wins", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "tool", name: longName },
    messages: [
      { role: "user", content: "quote please" },
      { role: "system", content: [
        { type: "text", text: "Stable hook context." },
        addition({ name: "Read", description: "Must not replace explicit", input_schema: schema }),
        addition({ name: longName, description: "First deferred wins", input_schema: schema, defer_loading: true, eager_input_streaming: true }),
        addition({ name: "a.b", input_schema: {} }),
      ] },
      { role: "developer", content: [
        addition({ name: longName, description: "Must not replace first deferred", input_schema: {} }),
        addition({ name: "a_b", input_schema: {} }),
        addition({ name: "advisor", type: "advisor_20260301" }),
        { type: "tool_removal", tool: { type: "tool_reference", name: longName } },
        { type: "tool_addition", tool: { type: "tool_reference", name: "reference_only" } },
        { type: "tool_addition", tool: { definition: { name: 42 } } },
        { type: "tool_addition", tool: { definition: { name: "" } } },
        { type: "tool_addition", tool: { definition: null } },
      ] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: longName, input: { symbol: "AAPL" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "182.3" }] },
    ],
  };
}

type Translation = {
  tools: { name: string; description: string; parameters: Record<string, unknown> }[];
  choice: unknown;
  system: string;
  history: unknown;
};
const translators: { name: string; translate(req: AnthropicRequest): Translation }[] = [
  {
    name: "ChatGPT Responses",
    translate(req) {
      const out = toResponsesRequest(req, { model: "gpt-test", effort: "high", identity: false });
      return { tools: out.tools ?? [], choice: out.tool_choice, system: out.instructions, history: out.input };
    },
  },
  ...(["chat", "responses"] as const).map((wire) => ({
    name: `OpenAI ${wire}`,
    translate(req: AnthropicRequest): Translation {
      const out = toOpenAiRequest(req, { model: "openai-test", wire, identity: false });
      if (wire === "chat") {
        const chat = out as ChatRequest;
        return {
          tools: (chat.tools ?? []).map((tool) => tool.function),
          choice: chat.tool_choice && typeof chat.tool_choice === "object" ? { type: "function", name: chat.tool_choice.function.name } : chat.tool_choice,
          system: String(chat.messages.find((message) => message.role === "system")?.content ?? ""),
          history: chat.messages.filter((message) => message.role !== "system"),
        };
      }
      const responses = out as ResponsesRequest;
      return { tools: responses.tools ?? [], choice: responses.tool_choice, system: responses.instructions ?? "", history: responses.input };
    },
  })),
  {
    name: "Gemini",
    translate(req) {
      const out = toGeminiRequest(req, { model: "gemini-3-pro", identity: false });
      const config = out.toolConfig?.functionCallingConfig;
      return {
        tools: (out.tools?.[0]?.functionDeclarations ?? []).map(({ parametersJsonSchema, ...tool }) => ({ ...tool, parameters: parametersJsonSchema })),
        choice: config?.allowedFunctionNames ? { type: "function", name: config.allowedFunctionNames[0] } : config,
        system: out.systemInstruction?.parts[0]?.text ?? "",
        history: out.contents,
      };
    },
  },
];

for (const { name, translate } of translators) {
  test(`${name}: mixed explicit and deferred tools preserve precedence, schemas and names`, () => {
    const req = mixedRequest();
    const before = structuredClone(req);
    const out = translate(req);
    assert.deepEqual(out.tools.map((tool) => tool.name), ["Read", longName, "a.b", "a_b"].map(toolNameForResponses));
    assert.equal(out.tools[0]?.description, "Explicit wins");
    assert.equal(out.tools[1]?.description, "First deferred wins");
    assert.deepEqual(out.tools[1]?.parameters, scrubbedSchema);
    assert.notEqual(out.tools[2]?.name, out.tools[3]?.name, "sanitizing a name must not alias a legal one");
    for (const tool of out.tools) assert.match(tool.name, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/, "also fits Gemini's name limit");
    assert.deepEqual(out.choice, { type: "function", name: toolNameForResponses(longName) });
    assert.match(out.system, /Stable system prefix\.\n\nNot available in this session: `advisor`\./);
    const history = JSON.stringify(out.history);
    assert.ok(history.includes(toolNameForResponses(longName)), "the replayed call uses the declared wire name");
    assert.ok(history.includes("call_1"));
    assert.ok(history.includes("182.3"), "the corresponding result survives");
    assert.ok(history.includes("Stable hook context."));
    assert.doesNotMatch(history, /tool_addition|tool_removal|reference_only/);
    assert.deepEqual(translate(req), out, "translation stays deterministic");
    assert.deepEqual(req, before, "the caller's declarations and schemas are never mutated");

    const next = translate({ ...req, messages: [...req.messages, { role: "system", content: [addition({ name: "later", input_schema: {} })] }] });
    assert.deepEqual(next.tools.slice(0, out.tools.length), out.tools, "new declarations only extend the cached tool prefix");
  });

  test(`${name}: deferred-only declarations and dropped server-tool choices use the same rules`, () => {
    const req: AnthropicRequest = {
      model: "m",
      messages: [{ role: "system", content: [addition({ name: longName, input_schema: schema }), addition({ name: "advisor", type: "advisor_20260301" })] }],
      tool_choice: { type: "tool", name: "advisor" },
    };
    const out = translate(req);
    assert.deepEqual(out.tools.map((tool) => tool.name), [toolNameForResponses(longName)]);
    assert.equal(out.choice, undefined, "a dropped server tool cannot remain forced");
    assert.match(out.system, /Not available in this session: `advisor`\./);
    const onlyServer = translate({ ...req, messages: [{ role: "system", content: [addition({ name: "advisor", type: "advisor_20260301" })] }] });
    assert.deepEqual(onlyServer.tools, []);
    assert.equal(onlyServer.choice, undefined);
  });
}

test("compatibility lifting retains explicit/first-deferred precedence and drops eager streaming without mutation", () => {
  const req = mixedRequest();
  const before = structuredClone(req);
  const result = sanitizeForCompatible(req, STRICT_COMPAT_CAPS);
  const tools = result.json.tools as AnthropicTool[];
  assert.deepEqual(tools.map((tool) => tool.name), ["Read", longName, "a.b", "a_b"]);
  assert.equal(tools[0]?.description, "Explicit wins");
  assert.equal(tools[1]?.description, "First deferred wins");
  assert.deepEqual(tools[1]?.input_schema, scrubbedSchema);
  assert.equal(tools[1]?.eager_input_streaming, undefined);
  assert.equal(tools[1]?.defer_loading, undefined);
  assert.deepEqual(req, before);
});

test("deferred names are restored in streamed and assembled calls on every translated wire", () => {
  const req = mixedRequest();
  const restore = toolNameRestoreMap(req);
  for (const original of [longName, "a.b"]) {
    const wireName = toolNameForResponses(original);
    assert.equal(restore.get(wireName), original);
    const codex = new StreamMapper("gpt-test", 0, restore);
    const codexEvents = codex.feed({ type: "response.output_item.added", item: { type: "function_call", id: "item_1", call_id: "call_2", name: wireName, arguments: '{"symbol":"AAPL"}' } });
    codex.feed({ type: "response.completed" });
    const google = new GoogleStreamMapper("gemini-3-pro", 0, restore);
    const googleEvents = google.feed({ candidates: [{ content: { parts: [{ functionCall: { name: wireName, args: { symbol: "AAPL" } } }] }, finishReason: "STOP" }] });
    google.finish();
    const outputs: { mapper: { message(): Record<string, unknown> }; events: { event: string; data: Record<string, unknown> }[] }[] = [
      { mapper: codex, events: codexEvents }, { mapper: google, events: googleEvents },
    ];
    for (const wire of ["chat", "responses"] as const) {
      const mapper = new OpenAiStreamMapper("openai-test", 0, restore);
      const events = wire === "chat"
        ? mapper.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_2", function: { name: wireName, arguments: '{"symbol":"AAPL"}' } }] }, finish_reason: "tool_calls" }] }, wire)
        : mapper.feed({ type: "response.output_item.added", item: { type: "function_call", id: "item_1", call_id: "call_2", name: wireName, arguments: '{"symbol":"AAPL"}' } }, wire);
      events.push(...mapper.finish());
      outputs.push({ mapper, events });
    }
    for (const { mapper, events } of outputs) {
      const start = events.find((event) => (event.data.content_block as { type?: string })?.type === "tool_use");
      assert.equal((start?.data.content_block as { name: string }).name, original);
      const block = (mapper.message().content as { name: string; input: unknown }[])[0]!;
      assert.equal(block.name, original);
      assert.deepEqual(block.input, { symbol: "AAPL" });
    }
  }
  assert.equal(restore.has("Read"), false);
  assert.equal(restore.has("advisor"), false);
});
