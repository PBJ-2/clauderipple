import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleStreamMapper, toGeminiRequest, SIGNATURE_SENTINEL, type GeminiRequest } from "../src/providers/google/translate.ts";
import { toolNameForResponses, type AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

/** A tiny stand-in for the adapter's bounded signature store. */
function store(entries: Record<string, string> = {}): { get(id: string): string | undefined } {
  return { get: (id) => entries[id] };
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
  tool_choice: { type: "tool", name: "Read" },
  max_tokens: 77,
  temperature: 0.2,
  stop_sequences: ["STOP"],
  output_config: { effort: "high" },
};

test("translation removes billing telemetry, adds identity, and maps tools/choices/config", () => {
  const out = toGeminiRequest(request, { model: "gemini-3-pro-preview", effort: "high" });
  assert.equal(out.systemInstruction?.parts[0]?.text, "You are gemini-3-pro-preview (reasoning effort: high), answering through Claude Code, a terminal-based coding agent.\n\nYou are a coding agent.");
  assert.equal(JSON.stringify(out).includes("x-anthropic-billing-header"), false);
  assert.deepEqual(out.contents.map((c) => c.role), ["user", "model", "user"]);
  const userContent = out.contents[0]!;
  assert.deepEqual(userContent.parts.map((p) => (p.inlineData ? "inlineData" : "text")), ["inlineData", "text"]);
  assert.deepEqual(userContent.parts[0]?.inlineData, { mimeType: "image/png", data: "AAAA" });
  // tool_use → functionCall with the id and a JSON-object args, answered by an adjacent functionResponse.
  assert.deepEqual(out.contents[1]?.parts[0], { functionCall: { name: "Read", args: { file_path: "a.ts" }, id: "call_1" } });
  assert.deepEqual(out.contents[2]?.parts[0], { functionResponse: { name: "Read", response: { result: "export const a = 1;" }, id: "call_1" } });
  assert.deepEqual(out.tools?.[0]?.functionDeclarations[0]?.name, "Read");
  assert.deepEqual(out.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["Read"] } });
  assert.deepEqual(out.generationConfig, { maxOutputTokens: 77, temperature: 0.2, stopSequences: ["STOP"], thinkingConfig: { thinkingLevel: "high" } });
});

test("tool_choice modes map to functionCallingConfig", () => {
  const withChoice = (choice: AnthropicRequest["tool_choice"]): GeminiRequest => {
    const { tool_choice: _drop, ...without } = request;
    return toGeminiRequest(choice ? { ...without, tool_choice: choice } : without, { model: "gemini-3-pro" });
  };
  assert.deepEqual(withChoice({ type: "auto" }).toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  assert.deepEqual(withChoice({ type: "any" }).toolConfig, { functionCallingConfig: { mode: "ANY" } });
  assert.deepEqual(withChoice({ type: "none" }).toolConfig, { functionCallingConfig: { mode: "NONE" } });
  // No choice at all sends none — and an empty tool list never sends an ANY that would be a 400.
  assert.equal(withChoice(undefined).toolConfig, undefined);
  assert.equal(toGeminiRequest({ ...request, tools: [] }, { model: "gemini-3-pro" }).toolConfig, undefined);
});

test("effort maps to thinkingLevel for Gemini 3 and thinkingBudget for 2.5", () => {
  const config = (model: string, effort: string) => toGeminiRequest({ ...request, tools: [] }, { model, effort }).generationConfig?.thinkingConfig;
  assert.deepEqual(config("gemini-3-pro-preview", "max"), { thinkingLevel: "high" }, "top of the ladder clamps to the highest wire level");
  assert.deepEqual(config("gemini-3-flash", "none"), { thinkingLevel: "minimal" });
  assert.deepEqual(config("gemini-3-flash", "medium"), { thinkingLevel: "medium" });
  assert.deepEqual(config("gemini-2.5-flash", "low"), { thinkingBudget: 1024 });
  assert.deepEqual(config("gemini-2.5-pro", "none"), { thinkingBudget: 0 });
  // A family we do not recognize gets no thinkingConfig rather than a guessed field.
  assert.equal(config("gemini-1.5-pro", "high"), undefined);
});

test("a capped ladder clamps the effort the model is told and sent", () => {
  const levels = ["low", "medium", "high"];
  const out = toGeminiRequest({ ...request, output_config: { effort: "xhigh" }, tools: [] }, { model: "gemini-3-pro", effort: "xhigh", caps: { effortLevels: levels } });
  // xhigh is not in the ladder, so it clamps to high before being named or mapped.
  assert.match(out.systemInstruction?.parts[0]?.text ?? "", /reasoning effort: high/);
  assert.deepEqual(out.generationConfig?.thinkingConfig, { thinkingLevel: "high" });
});

test("a signed call is replayed with its thoughtSignature; an unsigned Gemini 3 call gets the sentinel", () => {
  const replayed = toGeminiRequest(request, { model: "gemini-3-pro", effort: "high", thoughtSignatures: store({ call_1: "SIG-REAL" }) });
  assert.equal(replayed.contents[1]?.parts[0]?.thoughtSignature, "SIG-REAL");
  assert.equal(JSON.stringify(replayed).includes(SIGNATURE_SENTINEL), false, "a real signature needs no sentinel");

  const missing = toGeminiRequest(request, { model: "gemini-3-pro", effort: "high", thoughtSignatures: store(), signatureSentinel: true });
  assert.equal(missing.contents[1]?.parts[0]?.thoughtSignature, SIGNATURE_SENTINEL);

  // Gemini 2.5 never asks for one, so it is not fabricated there.
  const twoFive = toGeminiRequest(request, { model: "gemini-2.5-flash", effort: "high", thoughtSignatures: store(), signatureSentinel: true });
  assert.equal(twoFive.contents[1]?.parts[0]?.thoughtSignature, undefined);
});

test("parallel calls: only the first carries a signature, and the sentinel never joins a signed turn", () => {
  const parallel: AnthropicRequest = {
    model: "m",
    messages: [
      { role: "user", content: "read both" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "Read", input: { path: "a" } }, { type: "tool_use", id: "call_b", name: "Read", input: { path: "b" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "A" }, { type: "tool_result", tool_use_id: "call_b", content: "B" }] },
    ],
  };
  // Gemini signed call_a only; call_b's missing signature is normal and must stay empty.
  const signed = toGeminiRequest(parallel, { model: "gemini-3-pro", thoughtSignatures: store({ call_a: "SIG-A" }), signatureSentinel: true });
  assert.deepEqual(signed.contents[1]?.parts.map((part) => part.thoughtSignature), ["SIG-A", undefined]);

  // With nothing cached (a restart), the sentinel goes on the first call only.
  const lost = toGeminiRequest(parallel, { model: "gemini-3-pro", thoughtSignatures: store(), signatureSentinel: true });
  assert.deepEqual(lost.contents[1]?.parts.map((part) => part.thoughtSignature), [SIGNATURE_SENTINEL, undefined]);
});

test("an orphan tool result becomes user text, not a functionResponse with no call", () => {
  const orphan: AnthropicRequest = { model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "side output" }] }] };
  const out = toGeminiRequest(orphan, { model: "gemini-3-pro" });
  assert.equal(out.contents[0]?.role, "user");
  assert.match(String(out.contents[0]?.parts[0]?.text), /\[Tool result\]\nside output/);
  assert.equal(out.contents[0]?.parts[0]?.functionResponse, undefined);
});

test("an assistant tool-call head and an assistant tail are nudged onto a user turn", () => {
  const headTail: AnthropicRequest = {
    model: "m",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  };
  const out = toGeminiRequest(headTail, { model: "gemini-3-pro" });
  assert.equal(out.contents[0]?.role, "user", "a functionCall head is preceded by a user nudge");
  assert.equal(out.contents.at(-1)?.role, "user", "a model tail is followed by a user nudge");
});

test("server tools are dropped, and a choice that named one with them", () => {
  const serverTool: AnthropicRequest = {
    model: "x",
    max_tokens: 10,
    tools: [
      { name: "web_search", type: "web_search_20250305", max_uses: 8 } as never,
      { name: "Read", input_schema: { type: "object", properties: {} } },
    ],
    tool_choice: { type: "tool", name: "web_search" },
    messages: [{ role: "user", content: "Perform a web search for the query: node 24" }],
  };
  const out = toGeminiRequest(serverTool, { model: "gemini-3-pro" });
  assert.deepEqual(out.tools?.[0]?.functionDeclarations.map((d) => d.name), ["Read"]);
  assert.equal(out.toolConfig, undefined);
});

test("a dropped server tool's instructions are withdrawn after the system prompt", () => {
  const advisor: AnthropicRequest = {
    ...request,
    tools: [...(request.tools ?? []), { type: "advisor_20260301", name: "advisor", model: "claude-fable-5-1" } as never],
  };
  const text = (r: AnthropicRequest): string => toGeminiRequest(r, { model: "gemini-3-pro" }).systemInstruction?.parts[0]?.text ?? "";
  assert.match(text(advisor), /You are a coding agent\.\n\nNot available in this session: `advisor`\. /);
  assert.doesNotMatch(text(request), /Not available in this session/, "no server tool, no note");
});

const longMcp = "mcp__claude_ai_Korea_Investment_Securities__get_overseas_stock_chart"; // 68 chars
const mangled = toolNameForResponses(longMcp);

test("over-long tool names are mangled in declarations and in a replayed call, and restored on the way back", () => {
  const mcp: AnthropicRequest = {
    ...request,
    tools: [{ name: longMcp, input_schema: { type: "object", properties: {} } }, { name: "Read", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "tool", name: longMcp },
    messages: [
      { role: "user", content: [{ type: "text", text: "quote please" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: longMcp, input: { symbol: "AAPL" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "182.3" }] },
    ],
  };
  const out = toGeminiRequest(mcp, { model: "gemini-3-pro" });
  assert.equal(out.tools?.[0]?.functionDeclarations[0]?.name, mangled);
  assert.equal(out.tools?.[0]?.functionDeclarations[1]?.name, "Read");
  assert.deepEqual(out.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [mangled] } });
  assert.equal(out.contents[1]?.parts[0]?.functionCall?.name, mangled);

  // The mapper restores the model's echoed (mangled) name to the one Claude Code knows.
  const restore = new Map([[mangled, longMcp]]);
  const mapper = new GoogleStreamMapper("gemini-3-pro", 0, restore);
  mapper.feed({ candidates: [{ content: { parts: [{ functionCall: { name: mangled, args: { symbol: "AAPL" } } }] }, finishReason: "STOP" }] });
  assert.deepEqual(mapper.message().content, [{ type: "tool_use", id: (mapper.content[0] as { id: string }).id, name: longMcp, input: { symbol: "AAPL" } }]);
});

test("the stream mapper emits text, a one-shot tool call, and mapped usage", () => {
  const signatures: { id: string; name: string; signature: string | undefined }[] = [];
  const mapper = new GoogleStreamMapper("gemini-3-pro", 88, new Map(), (info) => signatures.push(info));
  const events = [
    { candidates: [{ content: { parts: [{ thought: true, text: "let me think" }] } }] },
    { candidates: [{ content: { parts: [{ text: "Reading " }] } }] },
    { candidates: [{ content: { parts: [{ text: "now." }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "Read", args: { path: "a.ts" } }, thoughtSignature: "SIG-X" }] } }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 900, candidatesTokenCount: 12, thoughtsTokenCount: 5 } },
    { candidates: [{ finishReason: "STOP" }] },
  ].flatMap((chunk) => mapper.feed(chunk as never));
  const all = [...events, ...mapper.finish()];
  assert.equal(all[0]?.event, "message_start");
  assert.equal((all[0]?.data.message as { usage: { input_tokens: number } }).usage.input_tokens, 88);
  const starts = all.filter((e) => e.event === "content_block_start").map((e) => (e.data.content_block as { type: string }).type);
  assert.deepEqual(starts, ["thinking", "text", "tool_use"]);
  const final = all.find((e) => e.event === "message_delta")!;
  assert.equal((final.data.delta as { stop_reason: string }).stop_reason, "tool_use");
  assert.deepEqual(final.data.usage, { input_tokens: 100, output_tokens: 17, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 });
  assert.deepEqual(signatures, [{ id: (mapper.content.at(-1) as { id: string }).id, name: "Read", signature: "SIG-X" }]);
  // The whole call is emitted as one input_json_delta.
  const jsonDeltas = all.filter((e) => e.event === "content_block_delta" && (e.data.delta as { type: string }).type === "input_json_delta").map((e) => (e.data.delta as { partial_json: string }).partial_json);
  assert.deepEqual(jsonDeltas, ['{"path":"a.ts"}']);
});

test("a stream that ends with no finishReason is not 'completed'", () => {
  const mapper = new GoogleStreamMapper("gemini-3-pro");
  mapper.feed({ candidates: [{ content: { parts: [{ text: "Hal" }] } }] });
  assert.equal(mapper.completed, false);
});

test("MAX_TOKENS maps to a max_tokens stop reason and an inline error maps to a failure", () => {
  const mapper = new GoogleStreamMapper("gemini-3-pro");
  mapper.feed({ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] });
  const done = mapper.finish();
  assert.equal((done.find((e) => e.event === "message_delta")!.data.delta as { stop_reason: string }).stop_reason, "max_tokens");

  const failed = new GoogleStreamMapper("gemini-3-pro");
  const events = failed.feed({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } } as never);
  assert.equal(((events.at(-1)!.data.error) as { type: string }).type, "rate_limit_error");
});
