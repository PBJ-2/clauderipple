// OpenAI Responses / Chat Completions ⇄ Anthropic Messages. Pure functions, no I/O.
//
// The translation deliberately emits deterministic object/property ordering. Prompt caching is
// controlled at the Anthropic side: system, final tool, and final user content carry the
// ephemeral breakpoint requested by the ingress contract.

import crypto from "node:crypto";
import { ToolTranslation } from "./tools.ts";

// Anthropic requires max_tokens; OpenAI clients (Codex included) usually omit it. 16k is safe for every current Claude model.
export const DEFAULT_MAX_TOKENS = 16384;

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

function isTextPart(value: unknown): boolean {
  const type = object(value)?.type;
  return type === "input_text" || type === "output_text" || type === "text" || type === "refusal";
}

function validToolImage(image: AnthropicContent | null): boolean {
  if (image?.type !== "image" || image.source.type !== "base64") return false;
  const { media_type, data } = image.source;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(media_type)) return false;
  // Buffer accepts malformed base64; check its alphabet, padding and canonical round trip.
  if (!data.length || data.length % 4 !== 0 || data.length > Math.ceil(5 * 1024 * 1024 / 3) * 4) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  const decoded = Buffer.from(data, "base64");
  return decoded.length <= 5 * 1024 * 1024 && decoded.toString("base64") === data;
}

function toolResultContent(value: unknown, nativeImages: boolean): string | AnthropicContent[] {
  // Keep the pre-image translator's exact string (including newlines and empty text) for cache reuse.
  if (!Array.isArray(value) || value.every(isTextPart)) return contentText(value);
  return value.flatMap((raw): AnthropicContent[] => {
    const part = object(raw);
    if (!part) return [{ type: "text", text: "[content omitted: unsupported type]" }];
    if (part.type === "input_image" || part.type === "image_url") {
      if (!nativeImages) return [{ type: "text", text: "[image omitted: this model does not take images]" }];
      const image = imageFromPart(part);
      return image && validToolImage(image)
        ? [image]
        : [{ type: "text", text: "[image omitted: unsupported source]" }];
    }
    return [{ type: "text", text: isTextPart(part) ? contentText([part]) : "[content omitted: unsupported type]" }];
  });
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

function customInputFromArguments(value: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    // JSON.parse errors can quote the tool's private input. Keep it out of router diagnostics.
    throw new Error("Custom tool response contains invalid JSON");
  }
  const input = object(decoded)?.input;
  if (typeof input !== "string") throw new Error("Custom tool response must contain a string input");
  return input;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { _raw_arguments: value };
  }
}

/**
 * Codex's remote compaction asks for a summary by appending the control item
 * `{"type":"compaction_trigger"}` after the transcript, which it calls "request controls, not durable
 * response items" (codex-rs protocol/src/models.rs at rust-v0.164.0-alpha.11.1; the transcript is
 * pushed first and the trigger last in core/src/compact_remote_v2_attempt.rs). The wrapped transcript
 * therefore still ends with the assistant's last turn, and Anthropic rejects that shape for models
 * that take no assistant prefill (issue #104: "This model does not support assistant message
 * prefill"). A summary is the answer to a request, so the trigger becomes the user turn that asks
 * for it; every item before it is passed through unchanged.
 */
const COMPACTION_REQUEST = "Summarize this conversation so the work can continue from the summary alone: what the user asked for, what was done and decided, the constraints and preferences that still apply, and what is left to do.";

/**
 * OpenAI clients have no prefill: a transcript that ends with the assistant asks for the next turn,
 * while Anthropic reads it as prefill and some models refuse it outright (issue #104). One short user
 * turn is the same request in the shape Anthropic accepts; nothing in the transcript is rewritten.
 */
function endWithUserTurn(messages: AnthropicMessage[]): void {
  if (messages.at(-1)?.role !== "assistant") return;
  messages.push({ role: "user", content: [{ type: "text", text: "Continue." }] });
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

// Router-owned opaque replay format, NOT encryption or an OpenAI-compatible ciphertext.
const COMPACTION_PREFIX = "clauderipple:compaction:v1:";

export function hasCompactionTrigger(body: Json): boolean {
  return Array.isArray(body.input) && body.input.some((item) => object(item)?.type === "compaction_trigger");
}

function restoreCompaction(value: unknown, onIgnored: () => void): string | null {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) {
    onIgnored();
    return null;
  }
  const encoded = value.slice(COMPACTION_PREFIX.length);
  // Buffer's base64 decoder is permissive; require our canonical encoding before parsing.
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) throw new Error("Invalid ClaudeRipple compaction encoding");
  const payload = object(JSON.parse(decoded.toString("utf8")) as unknown);
  if (typeof payload?.summary !== "string" || !payload.summary.trim()) throw new Error("Invalid ClaudeRipple compaction summary");
  return `Summary of the earlier conversation: ${payload.summary}`;
}

function responseItems(value: unknown, onIgnoredCompaction: () => void, translation: ToolTranslation, nativeImages: boolean): AnthropicMessage[] {
  if (typeof value === "string") return value ? [{ role: "user", content: [{ type: "text", text: value }] }] : [];
  if (!Array.isArray(value)) return [];
  const messages: AnthropicMessage[] = [];
  for (const raw of value) {
    const item = object(raw);
    if (!item) continue;
    const type = string(item.type);
    if (type === "reasoning") continue;
    if (type === "function_call" || type === "custom_tool_call") {
      const callId = string(item.call_id) ?? string(item.id) ?? `call_${crypto.randomUUID().replaceAll("-", "")}`;
      const name = translation.toWire({ name: string(item.name) ?? "tool", kind: type === "custom_tool_call" ? "custom" : "function", ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}) });
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: callId, name, input: type === "custom_tool_call" ? { input: string(item.input) ?? "" } : parseArguments(item.arguments) }] });
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callId = string(item.call_id) ?? "";
      if (callId) messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: toolResultContent(item.output, nativeImages) }] });
      continue;
    }
    if (type === "compaction") {
      const text = restoreCompaction(item.encrypted_content, onIgnoredCompaction);
      if (text !== null) messages.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }
    if (type === "compaction_trigger") {
      messages.push({ role: "user", content: [{ type: "text", text: COMPACTION_REQUEST }] });
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
/**
 * Claude models that accept `output_config.effort` (measured 2026-09-13: Haiku 4.5 answers 400 "does
 * not support the effort parameter"). Mythos 5 and 5.1 list `effort` among their capabilities in
 * Claude Code 2.1.295's model catalogue (read 2026-10-14).
 */
export function claudeSupportsEffort(model: string): boolean {
  return /^claude-(opus|sonnet|fable|mythos)-(4-[6-9]|5)(-|$)/.test(model);
}

/**
 * With a borrowed Claude Code login, Anthropic accepts the request only when the system prompt is
 * Claude Code's own (measured 2026-09-13: any other long system text → 429 "rate_limit_error: Error",
 * even though a tiny request passes). So in that mode `system` carries just the identity line and
 * the client's instructions travel as the first user block, tagged so the model reads them as
 * operator instructions. The block is cache-marked, so the prefix still caches.
 */
function placeInstructions(prefix: string | undefined, instructions: string[], messages: AnthropicMessage[]): { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] | undefined {
  const text = instructions.filter((t) => t.length > 0).join("\n\n");
  if (prefix) {
    if (text) {
      const block = { type: "text" as const, text: `<operator_instructions>\n${text}\n</operator_instructions>`, cache_control: EPHEMERAL };
      const first = messages.find((m) => m.role === "user");
      if (first && Array.isArray(first.content)) first.content.unshift(block);
      else messages.unshift({ role: "user", content: [block] });
    }
    return [{ type: "text", text: prefix, cache_control: EPHEMERAL }];
  }
  return text ? [{ type: "text", text, cache_control: EPHEMERAL }] : undefined;
}

export function responsesToAnthropic(body: Json, targetModel: string, systemPrefix?: string, onIgnoredCompaction: () => void = () => {}, translation = new ToolTranslation(body, !!systemPrefix), nativeImages = false): AnthropicIngressRequest {
  const instructions = string(body.instructions);
  const messages = responseItems(body.input, onIgnoredCompaction, translation, nativeImages);
  endWithUserTurn(messages);
  const system = placeInstructions(systemPrefix, instructions ? [instructions] : [], messages);
  applyMessageCache(messages);
  const tools = translation.tools;
  const maxTokens = typeof body.max_output_tokens === "number" && Number.isFinite(body.max_output_tokens) ? Math.max(1, Math.floor(body.max_output_tokens)) : undefined;
  const temperature = typeof body.temperature === "number" && Number.isFinite(body.temperature) ? body.temperature : undefined;
  const effort = effortFromRequest(body.reasoning);
  const toolChoice = translation.choice;
  return {
    model: targetModel,
    ...(system ? { system } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(effort && claudeSupportsEffort(targetModel) ? { output_config: { effort } } : {}),
    stream: body.stream === true,
  };
}

function chatMessageToAnthropic(raw: unknown, translation: ToolTranslation): AnthropicMessage[] {
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
    if (id && name) content.push({ type: "tool_use", id, name: translation.toWire({ name, kind: "function" }), input: parseArguments(fn.arguments) });
  }
  return content.length ? [{ role: mappedRole, content }] : [];
}

/** Convert OpenAI Chat Completions request to an Anthropic Messages request. */
export function chatToAnthropic(body: Json, targetModel: string, systemPrefix?: string, translation = new ToolTranslation(body, !!systemPrefix)): AnthropicIngressRequest {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const systems: string[] = [];
  const messages: AnthropicMessage[] = [];
  for (const raw of rawMessages) {
    const message = object(raw);
    const role = message && string(message.role);
    if (role === "system" || role === "developer") {
      const text = message ? contentText(message.content) : "";
      if (text) systems.push(text);
      continue;
    }
    messages.push(...chatMessageToAnthropic(raw, translation));
  }
  endWithUserTurn(messages);
  const system = placeInstructions(systemPrefix, systems, messages);
  applyMessageCache(messages);
  const tools = translation.tools;
  const maxTokensValue = body.max_completion_tokens ?? body.max_tokens;
  const maxTokens = typeof maxTokensValue === "number" && Number.isFinite(maxTokensValue) ? Math.max(1, Math.floor(maxTokensValue)) : undefined;
  const temperature = typeof body.temperature === "number" && Number.isFinite(body.temperature) ? body.temperature : undefined;
  const toolChoice = translation.choice;
  return {
    model: targetModel,
    ...(system ? { system } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
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
  private readonly translation: ToolTranslation | undefined;

  private summary = "";
  private readonly compaction: boolean;

  constructor(model: string, translation?: ToolTranslation, compaction = false) {
    this.model = model;
    this.translation = translation;
    this.compaction = compaction;
  }

  response(status: "in_progress" | "completed" = "in_progress"): Json {
    return { id: this.responseId, object: "response", created_at: this.created, status, model: this.model, output: this.output, usage: this.usage };
  }

  private sequenceNumber = 0;

  private number(events: Json[]): Json[] {
    return events.map((event) => structuredClone(event.sequence_number === undefined ? { ...event, sequence_number: this.sequenceNumber++ } : event));
  }

  start(): Json[] {
    if (this.emittedCreated) return [];
    this.emittedCreated = true;
    return this.number([{ type: "response.created", response: this.response() }]);
  }

  feed(event: Json): Json[] {
    return this.number(this.feedEvent(event));
  }

  private feedEvent(event: Json): Json[] {
    const out = this.start();
    const type = string(event.type) ?? "";
    if (this.compaction) {
      if (type === "content_block_start") {
        if (object(event.content_block)?.type === "tool_use") throw new Error("Compaction returned a tool call instead of a summary");
        return out;
      }
      if (type === "content_block_delta") {
        const delta = object(event.delta);
        if (delta?.type === "text_delta") this.summary += string(delta.text) ?? "";
        return out;
      }
      if (type === "content_block_stop") return out;
      if (type === "message_delta") {
        const reason = object(event.delta)?.stop_reason;
        if (reason && reason !== "end_turn") throw new Error(`Compaction did not finish: ${String(reason)}`);
      }
      if (type === "error") throw new Error("Compaction upstream returned an error");
    }
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
        const wireName = string(block.name) ?? "tool";
        const identity = this.translation?.callableFromWire(wireName);
        if (this.translation && !identity) throw new Error("Upstream returned an unknown tool name");
        const custom = identity?.kind === "custom";
        const item: OutputItem = { id: id(custom ? "ctc" : "fc"), type: custom ? "custom_tool_call" : "function_call", call_id: callId, name: identity?.name ?? wireName, ...(identity?.namespace !== undefined ? { namespace: identity.namespace } : {}), ...(custom ? { input: "" } : { arguments: "" }), status: "in_progress" };
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
        // Custom input is JSON-wrapped upstream. Buffer it until it can be decoded without
        // leaking JSON escapes or the wrapper into the Responses string-input protocol.
        if (state.item.type === "function_call") {
          state.item.arguments = state.arguments;
          out.push({ type: "response.function_call_arguments.delta", item_id: state.item.id, output_index: this.output.indexOf(state.item), delta: text });
        }
      }
      return out;
    }
    if (type === "content_block_stop") {
      const index = typeof event.index === "number" ? event.index : -1;
      const state = this.blocks.get(index);
      if (!state) return out;
      if (state.kind === "tool" && state.item.type === "custom_tool_call") {
        const input = customInputFromArguments(state.arguments);
        state.item.input = input;
        out.push({ type: "response.custom_tool_call_input.delta", item_id: state.item.id, output_index: this.output.indexOf(state.item), delta: input });
        out.push({ type: "response.custom_tool_call_input.done", item_id: state.item.id, output_index: this.output.indexOf(state.item), input });
      } else if (state.kind === "tool") out.push({ type: "response.function_call_arguments.done", item_id: state.item.id, output_index: this.output.indexOf(state.item), arguments: state.arguments });
      state.item.status = "completed";
      out.push({ type: "response.output_item.done", output_index: this.output.indexOf(state.item), item: state.item });
      this.blocks.delete(index);
      return out;
    }
    if (type === "message_delta") {
      this.usage = usageFromAnthropic(event.usage);
      return out;
    }
    if (type === "message_stop") return [...out, ...this.finish(true)];
    if (type === "error") {
      const error = object(event.error);
      return [...out, { type: "error", error: { message: string(error?.message) ?? "Anthropic upstream error", type: string(error?.type) ?? "api_error", code: null } }];
    }
    return out;
  }

  finish(upstreamCompleted = false): Json[] {
    return this.number(this.finishEvents(upstreamCompleted));
  }

  private finishEvents(upstreamCompleted: boolean): Json[] {
    if (this.completed) return [];
    if (this.compaction) {
      if (!upstreamCompleted || !this.summary.trim()) throw new Error("Compaction ended without a complete summary");
      const item: OutputItem = {
        id: id("cmp"), type: "compaction",
        encrypted_content: COMPACTION_PREFIX + Buffer.from(JSON.stringify({ summary: this.summary }), "utf8").toString("base64"),
      };
      this.output.push(item);
      this.completed = true;
      return [
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: this.response("completed") },
      ];
    }
    if ([...this.blocks.values()].some((state) => state.item.type === "custom_tool_call")) throw new Error("Custom tool response ended before its input was complete");
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
