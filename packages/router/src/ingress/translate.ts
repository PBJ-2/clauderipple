// OpenAI Responses / Chat Completions ⇄ Anthropic Messages. Pure functions, no I/O.
//
// The translation deliberately emits deterministic object/property ordering. Prompt caching is
// controlled at the Anthropic side: system, final tool, and final user content carry the
// ephemeral breakpoint requested by the ingress contract.

import crypto from "node:crypto";

export type Json = Record<string, unknown>;

export type AnthropicContent =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContent[]; is_error?: boolean };

export type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicContent[] };
export type AnthropicTool = { name: string; description?: string; input_schema: Record<string, unknown>; cache_control?: { type: "ephemeral" } };
export type AnthropicIngressRequest = {
  model: string;
  system?: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "none" | "tool"; name?: string };
  max_tokens?: number;
  temperature?: number;
  output_config?: { effort: string };
  stream: boolean;
};

export type OpenAiUsage = {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  total_tokens: number;
};

type OutputItem = Json & { type: string; id: string };

const EPHEMERAL = { type: "ephemeral" } as const;

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      const p = object(part);
      if (!p) return [];
      const type = string(p.type);
      if (type === "input_text" || type === "output_text" || type === "text") return [string(p.text) ?? ""];
      if (type === "refusal") return [string(p.refusal) ?? ""];
      return [];
    })
    .join("\n");
}

function imageFromPart(part: Json): AnthropicContent | null {
  const imageUrl = object(part.image_url);
  const value = string(part.image_url) ?? string(imageUrl?.url) ?? string(part.url);
  if (!value) return null;
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (data) return { type: "image", source: { type: "base64", media_type: data[1]!, data: data[2]! } };
  return { type: "image", source: { type: "url", url: value } };
}

function messageContent(value: unknown): AnthropicContent[] {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  if (!Array.isArray(value)) return [];
  const out: AnthropicContent[] = [];
  for (const raw of value) {
    const part = object(raw);
    if (!part) continue;
    const type = string(part.type);
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = string(part.text);
      if (text) out.push({ type: "text", text });
    } else if (type === "input_image" || type === "image_url") {
      const image = imageFromPart(part);
      if (image) out.push(image);
    }
  }
  return out;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { _raw_arguments: value };
  }
}

function normalizeSchema(value: unknown): Record<string, unknown> {
  const source = object(value);
  const out = source ? structuredClone(source) : {};
  if (out.type !== "object") out.type = "object";
  if (!object(out.properties)) out.properties = {};
  return out;
}

function mapTools(value: unknown): AnthropicTool[] {
  if (!Array.isArray(value)) return [];
  const tools: AnthropicTool[] = value.flatMap((raw): AnthropicTool[] => {
    const tool = object(raw);
    if (!tool || string(tool.type) !== "function") return [];
    // Responses uses function fields directly; Chat Completions nests them under `function`.
    const fn = object(tool.function) ?? tool;
    const name = string(fn.name);
    if (!name) return [];
    const description = string(fn.description);
    return [{ name, ...(description ? { description } : {}), input_schema: normalizeSchema(fn.parameters) }];
  });
  if (tools.length) tools[tools.length - 1]!.cache_control = EPHEMERAL;
  return tools;
}

function mapToolChoice(value: unknown): AnthropicIngressRequest["tool_choice"] | undefined {
  if (value === "auto") return { type: "auto" };
  if (value === "required") return { type: "any" };
  if (value === "none") return { type: "none" };
  const choice = object(value);
  if (choice?.type === "function" && typeof choice.name === "string") return { type: "tool", name: choice.name };
  return undefined;
}

function applyMessageCache(messages: AnthropicMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const last = message.content.at(-1);
    if (last?.type === "text") last.cache_control = EPHEMERAL;
    else if (last) (last as Json).cache_control = EPHEMERAL;
    else message.content.push({ type: "text", text: "", cache_control: EPHEMERAL });
    return;
  }
}

function responseItems(value: unknown): AnthropicMessage[] {
  if (typeof value === "string") return value ? [{ role: "user", content: [{ type: "text", text: value }] }] : [];
  if (!Array.isArray(value)) return [];
  const messages: AnthropicMessage[] = [];
  for (const raw of value) {
    const item = object(raw);
    if (!item) continue;
    const type = string(item.type);
    if (type === "reasoning") continue;
    if (type === "function_call") {
      const callId = string(item.call_id) ?? string(item.id) ?? `call_${crypto.randomUUID().replaceAll("-", "")}`;
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: callId, name: string(item.name) ?? "tool", input: parseArguments(item.arguments) }] });
      continue;
    }
    if (type === "function_call_output") {
      const callId = string(item.call_id) ?? "";
      if (callId) messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: contentText(item.output) }] });
      continue;
    }
    if (type !== "message") continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    const content = messageContent(item.content);
    if (content.length) messages.push({ role, content });
  }
  return messages;
}

export function effortFromRequest(value: unknown): string | undefined {
  const reasoning = object(value);
  const effort = reasoning && string(reasoning.effort);
  return effort ?? undefined;
}

/** Convert an OpenAI Responses request to a cache-friendly Anthropic Messages request. */
export function responsesToAnthropic(body: Json, targetModel: string, systemPrefix?: string): AnthropicIngressRequest {
  const instructions = string(body.instructions);
  const systemText = [systemPrefix, instructions].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n\n");
  const system = systemText ? [{ type: "text" as const, text: systemText, cache_control: EPHEMERAL }] : undefined;
  const messages = responseItems(body.input);
  applyMessageCache(messages);
  const tools = mapTools(body.tools);
  const maxTokens = typeof body.max_output_tokens === "number" && Number.isFinite(body.max_output_tokens) ? Math.max(1, Math.floor(body.max_output_tokens)) : undefined;
  const temperature = typeof body.temperature === "number" && Number.isFinite(body.temperature) ? body.temperature : undefined;
  const effort = effortFromRequest(body.reasoning);
  const toolChoice = mapToolChoice(body.tool_choice);
  return {
    model: targetModel,
    ...(system ? { system } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    stream: body.stream === true,
  };
}

function chatMessageToAnthropic(raw: unknown): AnthropicMessage[] {
  const message = object(raw);
  if (!message) return [];
  const role = string(message.role);
  if (role === "system" || role === "developer") {
    const text = contentText(message.content);
    return text ? [{ role: "user", content: [{ type: "text", text: `[${role}]\n${text}` }] }] : [];
  }
  if (role === "tool") {
    const id = string(message.tool_call_id);
    return id ? [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: contentText(message.content) }]}] : [];
  }
  const mappedRole: "user" | "assistant" = role === "assistant" ? "assistant" : "user";
  const content = messageContent(message.content);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const rawCall of calls) {
    const call = object(rawCall);
    const fn = call && object(call.function);
    const id = call && string(call.id);
    const name = fn && string(fn.name);
    if (id && name) content.push({ type: "tool_use", id, name, input: parseArguments(fn.arguments) });
  }
  return content.length ? [{ role: mappedRole, content }] : [];
}

/** Convert OpenAI Chat Completions request to an Anthropic Messages request. */
export function chatToAnthropic(body: Json, targetModel: string, systemPrefix?: string): AnthropicIngressRequest {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const systems: string[] = systemPrefix ? [systemPrefix] : [];
  const messages: AnthropicMessage[] = [];
  for (const raw of rawMessages) {
    const message = object(raw);
    const role = message && string(message.role);
    if (role === "system" || role === "developer") {
      const text = message ? contentText(message.content) : "";
      if (text) systems.push(text);
      continue;
    }
    messages.push(...chatMessageToAnthropic(raw));
  }
  applyMessageCache(messages);
  const system = systems.length ? [{ type: "text" as const, text: systems.join("\n\n"), cache_control: EPHEMERAL }] : undefined;
  const tools = mapTools(body.tools);
  const maxTokensValue = body.max_completion_tokens ?? body.max_tokens;
  const maxTokens = typeof maxTokensValue === "number" && Number.isFinite(maxTokensValue) ? Math.max(1, Math.floor(maxTokensValue)) : undefined;
  const temperature = typeof body.temperature === "number" && Number.isFinite(body.temperature) ? body.temperature : undefined;
  const toolChoice = mapToolChoice(body.tool_choice);
  return {
    model: targetModel,
    ...(system ? { system } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    stream: body.stream === true,
  };
}

function usageFromAnthropic(value: unknown): OpenAiUsage {
  const usage = object(value);
  const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
  const cached = typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
  const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
  return { input_tokens: input + cached, input_tokens_details: { cached_tokens: cached }, output_tokens: output, total_tokens: input + cached + output };
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

/** Stateful Anthropic Messages SSE → OpenAI Responses event mapper. */
export class ResponsesEventMapper {
  readonly responseId = id("resp");
  readonly created = Math.floor(Date.now() / 1000);
  readonly model: string;
  readonly output: OutputItem[] = [];
  usage: OpenAiUsage = { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, total_tokens: 0 };
  private blocks = new Map<number, { kind: "text" | "tool"; item: OutputItem; arguments: string }>();
  private emittedCreated = false;
  private completed = false;
  private outputIndex = 0;
  private readonly toolNameFromWire: (name: string) => string;

  constructor(model: string, toolNameFromWire: (name: string) => string = (name) => name) {
    this.model = model;
    this.toolNameFromWire = toolNameFromWire;
  }

  response(status: "in_progress" | "completed" = "in_progress"): Json {
    return { id: this.responseId, object: "response", created_at: this.created, status, model: this.model, output: this.output, usage: this.usage };
  }

  start(): Json[] {
    if (this.emittedCreated) return [];
    this.emittedCreated = true;
    return [{ type: "response.created", response: this.response() }];
  }

  feed(event: Json): Json[] {
    const out = this.start();
    const type = string(event.type) ?? "";
    if (type === "message_start") {
      const message = object(event.message);
      this.usage = usageFromAnthropic(message?.usage);
      return out;
    }
    if (type === "content_block_start") {
      const index = typeof event.index === "number" ? event.index : -1;
      const block = object(event.content_block);
      if (index < 0 || !block) return out;
      const blockType = string(block.type);
      if (blockType === "text") {
        const item: OutputItem = { id: id("msg"), type: "message", role: "assistant", status: "in_progress", content: [] };
        this.output.push(item);
        this.blocks.set(index, { kind: "text", item, arguments: "" });
        out.push({ type: "response.output_item.added", output_index: this.outputIndex++, item });
      } else if (blockType === "tool_use") {
        const callId = string(block.id) ?? id("call");
        const item: OutputItem = { id: id("fc"), type: "function_call", call_id: callId, name: this.toolNameFromWire(string(block.name) ?? "tool"), arguments: "", status: "in_progress" };
        this.output.push(item);
        this.blocks.set(index, { kind: "tool", item, arguments: "" });
        out.push({ type: "response.output_item.added", output_index: this.outputIndex++, item });
      }
      return out;
    }
    if (type === "content_block_delta") {
      const index = typeof event.index === "number" ? event.index : -1;
      const state = this.blocks.get(index);
      const delta = object(event.delta);
      const deltaType = string(delta?.type);
      if (!state || !delta) return out;
      if (state.kind === "text" && deltaType === "text_delta") {
        const text = string(delta.text) ?? "";
        const content = state.item.content as Json[];
        if (content.length === 0) content.push({ type: "output_text", text: "", annotations: [] });
        const piece = content[0]!;
        piece.text = `${string(piece.text) ?? ""}${text}`;
        out.push({ type: "response.output_text.delta", item_id: state.item.id, output_index: this.output.indexOf(state.item), content_index: 0, delta: text });
      } else if (state.kind === "tool" && deltaType === "input_json_delta") {
        const text = string(delta.partial_json) ?? "";
        state.arguments += text;
        state.item.arguments = state.arguments;
        out.push({ type: "response.function_call_arguments.delta", item_id: state.item.id, output_index: this.output.indexOf(state.item), delta: text });
      }
      return out;
    }
    if (type === "content_block_stop") {
      const index = typeof event.index === "number" ? event.index : -1;
      const state = this.blocks.get(index);
      if (!state) return out;
      if (state.kind === "tool") out.push({ type: "response.function_call_arguments.done", item_id: state.item.id, output_index: this.output.indexOf(state.item), arguments: state.arguments });
      state.item.status = "completed";
      out.push({ type: "response.output_item.done", output_index: this.output.indexOf(state.item), item: state.item });
      this.blocks.delete(index);
      return out;
    }
    if (type === "message_delta") {
      this.usage = usageFromAnthropic(event.usage);
      return out;
    }
    if (type === "message_stop") return [...out, ...this.finish()];
    if (type === "error") {
      const error = object(event.error);
      return [...out, { type: "error", error: { message: string(error?.message) ?? "Anthropic upstream error", type: string(error?.type) ?? "api_error", code: null } }];
    }
    return out;
  }

  finish(): Json[] {
    if (this.completed) return [];
    this.completed = true;
    for (const state of this.blocks.values()) {
      state.item.status = "completed";
    }
    this.blocks.clear();
    return [{ type: "response.completed", response: this.response("completed") }];
  }
}

function firstText(item: OutputItem): string | null {
  const content = item.content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((part) => object(part)?.type === "output_text")
    .map((part) => string(object(part)?.text) ?? "")
    .join("") || null;
}

export function responsesToChatCompletion(mapper: ResponsesEventMapper): Json {
  const toolCalls = mapper.output
    .filter((item) => item.type === "function_call")
    .map((item, index) => ({ id: string(item.call_id) ?? item.id, type: "function", function: { name: string(item.name) ?? "tool", arguments: string(item.arguments) ?? "" }, index }));
  const text = mapper.output.filter((item) => item.type === "message").map(firstText).filter((x): x is string => x !== null).join("");
  return {
    id: `chatcmpl_${mapper.responseId.slice(5)}`,
    object: "chat.completion",
    created: mapper.created,
    model: mapper.model,
    choices: [{ index: 0, message: { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index: _index, ...call }) => call) } : {}) }, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: mapper.usage.input_tokens, prompt_tokens_details: mapper.usage.input_tokens_details, completion_tokens: mapper.usage.output_tokens, total_tokens: mapper.usage.total_tokens },
  };
}

/** Convert Responses mapper events to OpenAI Chat Completions streaming chunks. */
export function responsesEventsToChatChunks(events: Json[], mapper: ResponsesEventMapper): Json[] {
  const chunks: Json[] = [];
  const chatId = `chatcmpl_${mapper.responseId.slice(5)}`;
  for (const event of events) {
    const type = string(event.type);
    const base = { id: chatId, object: "chat.completion.chunk", created: mapper.created, model: mapper.model };
    if (type === "response.created") chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    else if (type === "response.output_text.delta") chunks.push({ ...base, choices: [{ index: 0, delta: { content: string(event.delta) ?? "" }, finish_reason: null }] });
    else if (type === "response.output_item.added") {
      const item = object(event.item);
      if (item?.type === "function_call") chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: string(item.call_id) ?? string(item.id), type: "function", function: { name: string(item.name) ?? "tool", arguments: "" } }] }, finish_reason: null }] });
    } else if (type === "response.function_call_arguments.delta") chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: string(event.delta) ?? "" } }] }, finish_reason: null }] });
    else if (type === "response.completed") {
      const hasTools = mapper.output.some((item) => item.type === "function_call");
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: hasTools ? "tool_calls" : "stop" }], usage: { prompt_tokens: mapper.usage.input_tokens, prompt_tokens_details: mapper.usage.input_tokens_details, completion_tokens: mapper.usage.output_tokens, total_tokens: mapper.usage.total_tokens } });
    }
  }
  return chunks;
}

export function formatSse(event: Json): string {
  return `event: ${string(event.type) ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatDataSse(event: Json): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
