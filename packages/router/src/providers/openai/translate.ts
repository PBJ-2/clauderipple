// Anthropic Messages ⇄ OpenAI-compatible Chat Completions / Responses. Pure translation
// and streaming mapping. The generated prefix is deterministic so vendors that cache a
// stable prompt prefix can retain their native prompt-cache behavior.

import crypto from "node:crypto";
import { clampEffort } from "../../compat.ts";
import { conversationKey, estimateTokens, normalizeSchema, serverToolNames, systemText, toolNameForResponses, type AnthropicBlock, type AnthropicRequest, type AnthropicTool } from "../chatgpt/translate.ts";
import { identityPrefix, instructionsSuffix } from "../../identity.ts";

export type OpenAiWire = "chat" | "responses";
export type OpenAiCaps = { effortLevels?: string[]; reasoning?: "effort" | "none" };

export type OpenAiTranslateOptions = {
  model: string;
  wire: OpenAiWire;
  effort?: string;
  caps?: OpenAiCaps;
  /** Prefix the system prompt with what the model is. Default true; see identity.ts. */
  identity?: boolean;
  /** Fixed configured text after the system prompt. */
  instructionsAppend?: string;
};

type ChatTextPart = { type: "text"; text: string };
type ChatImagePart = { type: "image_url"; image_url: { url: string } };
type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | (ChatTextPart | ChatImagePart)[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

type ResponseInput =
  | { type: "message"; role: "user" | "assistant"; content: ({ type: "input_text" | "output_text"; text: string } | { type: "input_image"; image_url: string })[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type OpenAiTool = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ResponsesTool = { type: "function"; name: string; description: string; parameters: Record<string, unknown> };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: OpenAiTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  reasoning_effort?: string;
  stream: true;
  stream_options: { include_usage: true };
};

export type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: ResponseInput[];
  tools?: ResponsesTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string };
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  reasoning?: { effort: string };
  stream: true;
};

function textOf(content: string | AnthropicBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function imagesOf(content: string | AnthropicBlock[] | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block.type === "image")
    .map(imageUrl)
    .filter((url): url is string => url !== null);
}

function imageUrl(block: AnthropicBlock): string | null {
  const source = (block as { source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown } }).source;
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64" && typeof source.data === "string") return `data:${typeof source.media_type === "string" ? source.media_type : "image/png"};base64,${source.data}`;
  if (source.type === "url" && typeof source.url === "string") return source.url;
  return null;
}

// Anthropic's server-side tools cannot run here; see the rule in the ChatGPT translator.
function functionTools(tools: AnthropicTool[] | undefined): OpenAiTool[] {
  const dropped = serverToolNames(tools);
  return (tools ?? [])
    .filter((tool) => typeof tool.name === "string" && !dropped.has(tool.name))
    .map((tool) => ({ type: "function" as const, function: { name: toolNameForResponses(tool.name), description: tool.description ?? "", parameters: normalizeSchema(tool.input_schema) } }));
}

/** A choice that named a dropped tool would force the model onto something no longer declared. */
function choiceSurvives(req: AnthropicRequest): boolean {
  const choice = req.tool_choice;
  return choice?.type === "tool" && !!choice.name && !serverToolNames(req.tools).has(choice.name);
}

function mapToolChoice(req: AnthropicRequest, tools: OpenAiTool[]): ChatRequest["tool_choice"] | undefined {
  if (!tools.length) return undefined;
  const choice = req.tool_choice;
  if (!choice || choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  return choiceSurvives(req) ? { type: "function", function: { name: toolNameForResponses(choice.name!) } } : undefined;
}

function mapResponsesToolChoice(req: AnthropicRequest, tools: ResponsesTool[]): ResponsesRequest["tool_choice"] | undefined {
  if (!tools.length) return undefined;
  const choice = req.tool_choice;
  if (!choice || choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  return choiceSurvives(req) ? { type: "function", name: toolNameForResponses(choice.name!) } : undefined;
}

/** The system text this provider should see: what it is, the caller's prompt, the configured addendum. */
function systemWithIdentity(sys: string, opts: OpenAiTranslateOptions): string {
  // The effort named is the one that survives the capability mapping; a provider that takes no
  // reasoning effort is told none, rather than a level it will never see.
  return [identityPrefix({ model: opts.model, effort: mappedEffort(opts), identity: opts.identity }), sys, instructionsSuffix({ model: opts.model, instructionsAppend: opts.instructionsAppend })]
    .filter(Boolean)
    .join("\n\n");
}

function mappedEffort(opts: OpenAiTranslateOptions): string | undefined {
  if (opts.caps?.reasoning !== "effort" || !opts.effort) return undefined;
  const levels = opts.caps.effortLevels;
  return levels && levels.length > 0 ? clampEffort(opts.effort, levels) : opts.effort;
}

/** Convert every Anthropic message into OpenAI Chat Completion messages without inventing unstable text. */
export function toChatMessages(req: AnthropicRequest, opts?: OpenAiTranslateOptions): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const sys = systemText(req.system);
  const content = opts ? systemWithIdentity(sys, opts) : sys;
  if (content) messages.push({ role: "system", content });
  const knownCalls = new Set<string>();

  for (const message of req.messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    if (typeof message.content === "string") {
      if (message.content) messages.push({ role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    if (role === "assistant") {
      const text: string[] = [];
      const calls: NonNullable<ChatMessage["tool_calls"]> = [];
      for (const block of message.content) {
        if (block.type === "text") text.push(String((block as { text?: unknown }).text ?? ""));
        if (block.type === "tool_use") {
          const call = block as { id: string; name: string; input: unknown };
          knownCalls.add(call.id);
          calls.push({ id: call.id, type: "function", function: { name: toolNameForResponses(call.name), arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}) } });
        }
      }
      if (text.some(Boolean) || calls.length) messages.push({ role: "assistant", content: text.join("\n") || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    let parts: (ChatTextPart | ChatImagePart)[] = [];
    const flush = (): void => {
      if (!parts.length) return;
      const onlyText = parts.every((part) => part.type === "text");
      messages.push({ role: "user", content: onlyText ? parts.map((part) => (part as ChatTextPart).text).join("\n") : parts });
      parts = [];
    };
    for (const block of message.content) {
      if (block.type === "text") {
        const text = String((block as { text?: unknown }).text ?? "");
        if (text) parts.push({ type: "text", text });
      } else if (block.type === "image") {
        const url = imageUrl(block);
        if (url) parts.push({ type: "image_url", image_url: { url } });
      } else if (block.type === "tool_result") {
        flush();
        const result = block as { tool_use_id: string; content?: string | AnthropicBlock[]; is_error?: boolean };
        let output = textOf(result.content);
        const images = imagesOf(result.content);
        if (result.is_error && !output) output = "Tool execution failed";
        if (!output && images.length > 0) output = "Tool returned image content.";
        if (knownCalls.has(result.tool_use_id)) messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: output });
        else parts.push({ type: "text", text: `[Tool result]\n${output}` });
        for (const url of images) parts.push({ type: "image_url", image_url: { url } });
      }
    }
    flush();
  }
  return messages;
}

/** Translate to the stateless OpenAI Responses input grammar. */
export function toResponsesInput(req: AnthropicRequest): ResponseInput[] {
  const input: ResponseInput[] = [];
  const knownCalls = new Set<string>();
  for (const message of req.messages) {
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    if (typeof message.content === "string") {
      if (message.content) input.push({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: message.content }] });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    let parts: ({ type: "input_text" | "output_text"; text: string } | { type: "input_image"; image_url: string })[] = [];
    const flush = (): void => {
      if (parts.length) input.push({ type: "message", role, content: parts });
      parts = [];
    };
    for (const block of message.content) {
      if (block.type === "text") {
        const text = String((block as { text?: unknown }).text ?? "");
        if (text) parts.push({ type: role === "user" ? "input_text" : "output_text", text });
      } else if (block.type === "image" && role === "user") {
        const url = imageUrl(block);
        if (url) parts.push({ type: "input_image", image_url: url });
      } else if (block.type === "tool_use") {
        flush();
        const call = block as { id: string; name: string; input: unknown };
        knownCalls.add(call.id);
        input.push({ type: "function_call", call_id: call.id, name: toolNameForResponses(call.name), arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}) });
      } else if (block.type === "tool_result") {
        flush();
        const result = block as { tool_use_id: string; content?: string | AnthropicBlock[]; is_error?: boolean };
        let output = textOf(result.content);
        const images = imagesOf(result.content);
        if (result.is_error && !output) output = "Tool execution failed";
        if (!output && images.length > 0) output = "Tool returned image content.";
        if (knownCalls.has(result.tool_use_id)) input.push({ type: "function_call_output", call_id: result.tool_use_id, output });
        else parts.push({ type: "input_text", text: `[Tool result]\n${output}` });
        for (const image_url of images) parts.push({ type: "input_image", image_url });
      }
    }
    flush();
  }
  return input;
}

export function toOpenAiRequest(req: AnthropicRequest, opts: OpenAiTranslateOptions): ChatRequest | ResponsesRequest {
  const effort = mappedEffort(opts);
  const tools = functionTools(req.tools);
  const parallel = !(req.tool_choice?.disable_parallel_tool_use ?? false);
  if (opts.wire === "chat") {
    const out: ChatRequest = {
      model: opts.model,
      messages: toChatMessages(req, opts),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length) {
      out.tools = tools;
      out.parallel_tool_calls = parallel;
      const choice = mapToolChoice(req, tools);
      if (choice) out.tool_choice = choice;
    }
    if (typeof req.max_tokens === "number") out.max_tokens = req.max_tokens;
    if (typeof req.temperature === "number") out.temperature = req.temperature;
    if (Array.isArray(req.stop_sequences) && req.stop_sequences.every((value) => typeof value === "string")) out.stop = req.stop_sequences as string[];
    if (effort) out.reasoning_effort = effort;
    return out;
  }

  const responseTools: ResponsesTool[] = tools.map(({ function: fn }) => ({ type: "function", ...fn }));
  const out: ResponsesRequest = {
    model: opts.model,
    input: toResponsesInput(req),
    stream: true,
  };
  const instructions = systemWithIdentity(systemText(req.system), opts);
  if (instructions) out.instructions = instructions;
  if (responseTools.length) {
    out.tools = responseTools;
    out.parallel_tool_calls = parallel;
    const choice = mapResponsesToolChoice(req, responseTools);
    if (choice) out.tool_choice = choice;
  }
  if (typeof req.max_tokens === "number") out.max_output_tokens = req.max_tokens;
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (effort) out.reasoning = { effort };
  return out;
}

export { conversationKey, estimateTokens };

export type AnthropicUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
export type AnthropicEvent = { event: string; data: Record<string, unknown> };
type TextOutputBlock = { type: "text"; text: string };
// A reasoning model on the Chat Completions wire puts its thinking in `reasoning_content`, beside
// `content` rather than inside it. Dropping it cost the turn its whole visible middle: measured
// 2026-09-22, mimo-v2.6-pro at effort=high spent 43s emitting nothing else, so Claude Code showed a
// blank screen for the whole turn, and one turn that reasoned without concluding arrived empty.
type ThinkingOutputBlock = { type: "thinking"; thinking: string };
type ToolOutputBlock = { type: "tool_use"; id: string; name: string; input: unknown; args: string; index: number };
type OutputBlock = TextOutputBlock | ThinkingOutputBlock | ToolOutputBlock;
type OpenBlock = { kind: "text" | "thinking" | "tool"; index: number; toolIndex?: number };
type ResponseItem = {
  id: string;
  kind: "text" | "tool";
  block: OutputBlock;
  done: boolean;
  emitted: boolean;
  closed: boolean;
  emittedText: number;
};

/** Maps standard OpenAI Chat Completion and Responses SSE records to Anthropic Messages SSE. */
export class OpenAiStreamMapper {
  private started = false;
  private finished = false;
  private blockIndex = -1;
  private open: OpenBlock | null = null;
  private sawTool = false;
  private finishReason: string | undefined;
  private readonly responseItems: ResponseItem[] = [];
  private readonly responseItemsById = new Map<string, ResponseItem>();
  readonly messageId = `msg_${crypto.randomBytes(12).toString("hex")}`;
  readonly content: OutputBlock[] = [];
  usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";

  readonly model: string;
  private readonly startInput: number;

  /** Mangled tool name → the name Claude Code knows, from `toolNameRestoreMap`. */
  private readonly toolNames: ReadonlyMap<string, string>;

  constructor(model: string, startInput = 0, toolNames: ReadonlyMap<string, string> = new Map()) {
    this.model = model;
    this.startInput = startInput;
    this.toolNames = toolNames;
  }

  get isFinished(): boolean { return this.finished; }

  start(): AnthropicEvent[] {
    if (this.started) return [];
    this.started = true;
    return [{ event: "message_start", data: { type: "message_start", message: { id: this.messageId, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: this.startInput, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } }];
  }

  private closeBlock(): AnthropicEvent[] {
    if (!this.open) return [];
    const index = this.open.index;
    this.open = null;
    return [{ event: "content_block_stop", data: { type: "content_block_stop", index } }];
  }

  private openBlock(kind: "text" | "thinking" | "tool", contentBlock: Record<string, unknown>, toolIndex?: number): AnthropicEvent[] {
    const out = this.closeBlock();
    const index = ++this.blockIndex;
    this.open = { kind, index, ...(toolIndex === undefined ? {} : { toolIndex }) };
    out.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: contentBlock } });
    return out;
  }

  private setUsage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown }; input_tokens_details?: { cached_tokens?: unknown } };
    const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
    const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
    if (input === undefined && output === undefined) return;
    const cachedValue = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens;
    const cached = typeof cachedValue === "number" && Number.isFinite(cachedValue) ? Math.max(0, cachedValue) : 0;
    this.usage = { input_tokens: Math.max(0, (input ?? this.usage.input_tokens + cached) - cached), output_tokens: Math.max(0, output ?? this.usage.output_tokens), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
  }

  /** The vendor echoes the name it was given; Claude Code only recognises the original. */
  private restore(name: string): string {
    return this.toolNames.get(name) ?? name;
  }

  private toolFor(index: number, delta: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }): ToolOutputBlock {
    let tool = this.content.find((block): block is ToolOutputBlock => block.type === "tool_use" && block.index === index);
    if (!tool) {
      const id = typeof delta.id === "string" ? delta.id : `call_${crypto.randomBytes(8).toString("hex")}`;
      const name = typeof delta.function?.name === "string" ? this.restore(delta.function.name) : "tool";
      tool = { type: "tool_use", id, name, input: {}, args: "", index };
      this.content.push(tool);
      this.sawTool = true;
    }
    if (typeof delta.id === "string") tool.id = delta.id;
    if (typeof delta.function?.name === "string") tool.name = this.restore(delta.function.name);
    return tool;
  }

  private feedChat(ev: Record<string, unknown>): AnthropicEvent[] {
    const out = [...this.start()];
    const usage = ev.usage;
    if (usage) this.setUsage(usage);
    const choices = Array.isArray(ev.choices) ? ev.choices as { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[] : [];
    for (const choice of choices) {
      const delta = choice.delta ?? {};
      // Thinking arrives before the answer, so it opens the first block of the turn. `reasoning` is
      // accepted alongside `reasoning_content` because vendors on this wire disagree on the name.
      const reasoning = typeof delta.reasoning_content === "string" && delta.reasoning_content ? delta.reasoning_content
        : typeof delta.reasoning === "string" && delta.reasoning ? delta.reasoning : "";
      if (reasoning) {
        if (!this.open || this.open.kind !== "thinking") {
          this.content.push({ type: "thinking", thinking: "" });
          out.push(...this.openBlock("thinking", { type: "thinking", thinking: "" }));
        }
        const last = this.content[this.content.length - 1];
        if (last?.type === "thinking") last.thinking += reasoning;
        out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open!.index, delta: { type: "thinking_delta", thinking: reasoning } } });
      }
      if (typeof delta.content === "string" && delta.content) {
        if (!this.open || this.open.kind !== "text") {
          this.content.push({ type: "text", text: "" });
          out.push(...this.openBlock("text", { type: "text", text: "" }));
        }
        const last = this.content[this.content.length - 1];
        if (last?.type === "text") last.text += delta.content;
        out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open!.index, delta: { type: "text_delta", text: delta.content } } });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          if (!raw || typeof raw !== "object") continue;
          const call = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
          const index = typeof call.index === "number" ? call.index : 0;
          const tool = this.toolFor(index, call);
          if (!this.open || this.open.kind !== "tool" || this.open.toolIndex !== index) out.push(...this.openBlock("tool", { type: "tool_use", id: tool.id, name: tool.name, input: {} }, index));
          const args = call.function?.arguments;
          if (typeof args === "string" && args) {
            tool.args += args;
            out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open!.index, delta: { type: "input_json_delta", partial_json: args } } });
          }
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    return out;
  }

  private responseItem(id: unknown, kind?: ResponseItem["kind"]): ResponseItem | undefined {
    if (typeof id === "string") return this.responseItemsById.get(id);
    // Standard Responses SSE includes item_id. A few compatible servers omit it for
    // a single in-flight item; support only the unambiguous form, never guess across
    // parallel calls.
    const candidates = this.responseItems.filter((item) => !item.done && (!kind || item.kind === kind));
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private flushResponses(): AnthropicEvent[] {
    const out: AnthropicEvent[] = [];
    for (const item of this.responseItems) {
      if (item.emitted) {
        if (!item.done) break;
        if (!item.closed) {
          out.push(...this.closeBlock());
          item.closed = true;
        }
        continue;
      }
      if (item.kind === "text") {
        const text = item.block as TextOutputBlock;
        out.push(...this.openBlock("text", { type: "text", text: "" }));
        if (text.text) {
          out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open!.index, delta: { type: "text_delta", text: text.text } } });
        }
        item.emittedText = text.text.length;
        item.emitted = true;
        if (!item.done) break;
        out.push(...this.closeBlock());
        item.closed = true;
        continue;
      }
      const tool = item.block as ToolOutputBlock;
      out.push(...this.openBlock("tool", { type: "tool_use", id: tool.id, name: tool.name, input: {} }, tool.index));
      if (tool.args) {
        out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open!.index, delta: { type: "input_json_delta", partial_json: tool.args } } });
      }
      item.emittedText = tool.args.length;
      item.emitted = true;
      if (!item.done) break;
      out.push(...this.closeBlock());
      item.closed = true;
    }
    return out;
  }

  private feedResponses(ev: Record<string, unknown>): AnthropicEvent[] {
    const out = [...this.start()];
    const type = typeof ev.type === "string" ? ev.type : "";
    if (type === "response.output_item.added") {
      const item = ev.item as { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown } | undefined;
      const id = typeof item?.id === "string" ? item.id : undefined;
      if (id && item?.type === "message") {
        const block: TextOutputBlock = { type: "text", text: "" };
        this.content.push(block);
        const responseItem: ResponseItem = { id, kind: "text", block, done: false, emitted: false, closed: false, emittedText: 0 };
        this.responseItems.push(responseItem);
        this.responseItemsById.set(id, responseItem);
      } else if (id && item?.type === "function_call") {
        const index = this.content.filter((block) => block.type === "tool_use").length;
        const tool = this.toolFor(index, { id: item.call_id ?? item.id, function: { name: item.name } });
        const responseItem: ResponseItem = { id, kind: "tool", block: tool, done: false, emitted: false, closed: false, emittedText: 0 };
        this.responseItems.push(responseItem);
        this.responseItemsById.set(id, responseItem);
      }
    } else if (type === "response.output_text.delta") {
      const text = typeof ev.delta === "string" ? ev.delta : "";
      const item = this.responseItem(ev.item_id, "text");
      if (item?.kind === "text" && text) {
        const block = item.block as TextOutputBlock;
        block.text += text;
        if (item.emitted && this.open?.kind === "text") {
          out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open.index, delta: { type: "text_delta", text } } });
          item.emittedText += text.length;
        }
      }
    } else if (type === "response.function_call_arguments.delta") {
      const text = typeof ev.delta === "string" ? ev.delta : "";
      const item = this.responseItem(ev.item_id, "tool");
      if (item?.kind === "tool" && text) {
        const tool = item.block as ToolOutputBlock;
        tool.args += text;
        if (item.emitted && this.open?.kind === "tool" && this.open.toolIndex === tool.index) {
          out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open.index, delta: { type: "input_json_delta", partial_json: text } } });
          item.emittedText += text.length;
        }
      }
    } else if (type === "response.output_item.done") {
      const item = this.responseItem(ev.item_id ?? (ev.item as { id?: unknown } | undefined)?.id);
      if (item) item.done = true;
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = ev.response as { usage?: unknown; incomplete_details?: { reason?: unknown } } | undefined;
      this.setUsage(response?.usage);
      if (response?.incomplete_details?.reason === "max_output_tokens") this.finishReason = "length";
    } else if (type === "response.failed" || type === "error") {
      const error = (type === "error" ? ev.error : (ev.response as { error?: unknown } | undefined)?.error) as { message?: unknown; code?: unknown } | undefined;
      return [...out, ...this.fail(typeof error?.message === "string" ? error.message : "upstream response failed", typeof error?.code === "string" ? error.code : undefined)];
    }
    out.push(...this.flushResponses());
    return out;
  }

  feed(ev: Record<string, unknown>, wire: OpenAiWire): AnthropicEvent[] {
    if (this.finished) return [];
    // Some OpenAI-compatible servers emit an ordinary `{error:{...}}` JSON SSE payload
    // instead of the Responses `error` event shape. Do not finish it as a successful answer.
    if (ev.error && typeof ev.error === "object") {
      const error = ev.error as { message?: unknown; code?: unknown };
      return [...this.start(), ...this.fail(typeof error.message === "string" ? error.message : "upstream error", typeof error.code === "string" ? error.code : undefined)];
    }
    return wire === "chat" ? this.feedChat(ev) : this.feedResponses(ev);
  }

  finish(): AnthropicEvent[] {
    if (this.finished) return [];
    this.finished = true;
    this.stopReason = this.sawTool || this.finishReason === "tool_calls" ? "tool_use" : this.finishReason === "length" || this.finishReason === "max_output_tokens" ? "max_tokens" : "end_turn";
    return [...this.start(), ...this.closeBlock(), { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: this.stopReason, stop_sequence: null }, usage: this.usage } }, { event: "message_stop", data: { type: "message_stop" } }];
  }

  fail(message: string, code?: string): AnthropicEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const type = code === "rate_limit_exceeded" ? "rate_limit_error" : "api_error";
    return [...this.start(), ...this.closeBlock(), { event: "error", data: { type: "error", error: { type, message } } }];
  }

  message(): Record<string, unknown> {
    const content = this.content.map((block) => {
      if (block.type !== "tool_use") return block;
      let input: unknown = {};
      try { input = block.args ? JSON.parse(block.args) : {}; } catch { /* malformed vendor arguments become an empty tool input */ }
      return { type: "tool_use", id: block.id, name: block.name, input };
    });
    return { id: this.messageId, type: "message", role: "assistant", model: this.model, content, stop_reason: this.stopReason, stop_sequence: null, usage: this.usage };
  }
}

export function formatSse(event: AnthropicEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
