// Anthropic Messages ⇄ OpenAI-compatible Chat Completions / Responses. Pure translation
// and streaming mapping. The generated prefix is deterministic so vendors that cache a
// stable prompt prefix can retain their native prompt-cache behavior.

import crypto from "node:crypto";
import { clampEffort } from "../../compat.ts";
import { conversationKey, documentFile, documentResponsePart, documentText, estimateTokens, normalizeSchema, serverToolNames, systemWithDroppedToolNote, toolNameForResponses, type AnthropicBlock, type AnthropicRequest, type AnthropicTool, type ResponsesContentPart } from "../chatgpt/translate.ts";
import { identityPrefix, instructionsSuffix } from "../../identity.ts";
import { encodeEnvelope, envelopeFor, replayableReasoning, type Envelope, type ReplayedReasoning } from "../../reasoning.ts";

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
  /**
   * Carry the conversation's reasoning back to a reasoning model (see reasoning.ts). Default true:
   * a Chat vendor that requires `reasoning_content` back answers a 400 without it (DeepSeek,
   * measured from its own docs 2026-10-14), and one that ignores it is not harmed by it. A false
   * value is the retry after a vendor refused the request that carried it.
   */
  replay?: boolean;
  /**
   * The provider and model this request is going to. Reasoning is only replayed into the model that
   * made it — a blob sealed by another one is the thing a 400 is reliably about (reasoning.ts).
   */
  env?: { p: string; m: string };
  /** The provider's preset measured that it seals reasoning on request (presets.ts `sealedReasoning`). */
  sealedReasoning?: boolean;
  /** Sent as `prompt_cache_key` where the preset asks for one (presets.ts `promptCacheKey`). */
  promptCacheKey?: string;
  /** Filled in as the input is built: how many reasonings were replayed, and how many were not. */
  carried?: { replayed: number; undecodable: number };
  /** Names the reason a carrier was dropped. Absent in tests, where the counts are enough. */
  log?: (line: string) => void;
  /**
   * Called as each replayed item is placed, with the tool call it arrived immediately after. The
   * response path uses that to know where to address the next turn's reasoning for that turn.
   */
  onArrival?: (item: ReplayedReasoning, afterCallId: string | undefined) => void;
};

type ChatTextPart = { type: "text"; text: string };
type ChatImagePart = { type: "image_url"; image_url: { url: string } };
type ChatFilePart = { type: "file"; file: { filename: string; file_data: string } };
type ChatPart = ChatTextPart | ChatImagePart | ChatFilePart;

function documentChatPart(block: AnthropicBlock): ChatTextPart | ChatFilePart {
  const file = documentFile(block);
  return file
    ? { type: "file", file: { filename: file.filename, file_data: `data:${file.mimeType};base64,${file.data}` } }
    : { type: "text", text: documentText(block) };
}
type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /**
   * The reasoning a vendor sent on an earlier turn, replayed on the assistant message it belongs to.
   * The field name is the vendor's own: `reasoning_content` is what DeepSeek documents and requires
   * back, `reasoning` is what a few relays use (reasoning.ts).
   */
  reasoning_content?: string;
  reasoning?: string;
};

/** Counts a replay outcome, creating the tally the adapter reports from when it is the first. */
function bump(opts: OpenAiTranslateOptions | undefined, kind: "replayed" | "undecodable", by = 1): void {
  if (!opts) return;
  const carried = opts.carried ?? (opts.carried = { replayed: 0, undecodable: 0 });
  carried[kind] += by;
}

type ResponseInput =
  | { type: "message"; role: "user" | "assistant"; content: ResponsesContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | ReplayedReasoning;

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
  /** The conversation, for a vendor that keys its prompt cache on it (presets.ts `promptCacheKey`). */
  prompt_cache_key?: string;
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
  reasoning?: { effort: string; summary?: "auto" };
  /**
   * What asks a stateless Responses deployment to hand its reasoning over sealed, so the
   * conversation can carry it back (reasoning.ts). Sent on every turn to a `sealedReasoning` preset;
   * to anyone else only once the conversation already carries their reasoning.
   */
  include?: "reasoning.encrypted_content"[];
  /** The conversation, for a vendor that keys its prompt cache on it (presets.ts `promptCacheKey`). */
  prompt_cache_key?: string;
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
  const sys = systemWithDroppedToolNote(req);
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
      // The reasoning this turn came back with, rejoined into one string and sent as
      // `reasoning_content` on the same assistant message — the shape DeepSeek's own example builds
      // by appending the whole response message, and the only shape its API documents. The field
      // name is the one the vendor sent it under, carried in the envelope: a model heard on
      // `reasoning` is answered on `reasoning` (reasoning.ts).
      const reasoning: string[] = [];
      let field: "reasoning_content" | "reasoning" = "reasoning_content";
      let carriedHere = 0;
      for (const block of message.content) {
        if (block.type === "text") text.push(String((block as { text?: unknown }).text ?? ""));
        if (block.type === "document") text.push(documentText(block));
        if (block.type === "tool_use") {
          const call = block as { id: string; name: string; input: unknown };
          knownCalls.add(call.id);
          calls.push({ id: call.id, type: "function", function: { name: toolNameForResponses(call.name), arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}) } });
        }
        const envelope = envelopeFor(block, "chat", opts?.env, (reason) => {
          bump(opts, "undecodable");
          if (opts?.replay !== false) opts?.log?.(`dropped a reasoning carrier: ${reason}`);
        });
        if (!envelope || opts?.replay === false) continue;
        const held = (block as { thinking?: unknown }).thinking;
        if (typeof held === "string" && held.length > 0) reasoning.push(held);
        field = envelope.f === "reasoning" ? "reasoning" : "reasoning_content";
        carriedHere++;
      }
      if (carriedHere > 0) bump(opts, "replayed", carriedHere);
      // A turn whose only content was reasoning is still a turn the model had: it goes out with the
      // reasoning alone rather than vanishing, which is what dropping thinking did before.
      if (text.some(Boolean) || calls.length || reasoning.length) {
        messages.push({
          role: "assistant",
          content: text.join("\n") || null,
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(reasoning.length ? (field === "reasoning" ? { reasoning: reasoning.join("\n\n") } : { reasoning_content: reasoning.join("\n\n") }) : {}),
        });
      }
      continue;
    }

    let parts: ChatPart[] = [];
    const flush = (): void => {
      if (!parts.length) return;
      const onlyText = parts.every((part) => part.type === "text");
      messages.push({ role: "user", content: onlyText ? parts.map((part) => (part as ChatTextPart).text).join("\n") : parts });
      parts = [];
    };
    // A tool result's images (and the fallback text of an unknown call) wait until the run of tool
    // results ends: every `tool` message must follow the assistant's tool_calls directly, and a user
    // message between parallel results is refused (DeepSeek: "insufficient tool messages", #64).
    let deferred: ChatPart[] = [];
    const release = (): void => {
      parts.push(...deferred);
      deferred = [];
    };
    for (const block of message.content) {
      if (block.type === "text") {
        release();
        const text = String((block as { text?: unknown }).text ?? "");
        if (text) parts.push({ type: "text", text });
      } else if (block.type === "document") {
        release();
        parts.push(documentChatPart(block));
      } else if (block.type === "image") {
        release();
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
        else deferred.push({ type: "text", text: `[Tool result]\n${output}` });
        for (const url of images) deferred.push({ type: "image_url", image_url: { url } });
        if (Array.isArray(result.content)) for (const doc of result.content) if (doc.type === "document") deferred.push(documentChatPart(doc));
      }
    }
    release();
    flush();
  }
  return messages;
}

/** Translate to the stateless OpenAI Responses input grammar. */
export function toResponsesInput(req: AnthropicRequest, opts?: OpenAiTranslateOptions): ResponseInput[] {
  const input: ResponseInput[] = [];
  const knownCalls = new Set<string>();
  let lastCallId: string | undefined;
  // A translation with no options is a translation with nothing to say about reasoning: there is no
  // provider to name in an envelope and no model to check it against, so nothing is carried either
  // way. `opts` is only consulted when it is there.
  const carried = (count: "replayed" | "undecodable"): void => {
    bump(opts, count);
  };
  for (const message of req.messages) {
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    if (typeof message.content === "string") {
      if (message.content) input.push({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: message.content }] });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    let parts: ResponsesContentPart[] = [];
    const flush = (): void => {
      if (parts.length) input.push({ type: "message", role, content: parts });
      parts = [];
    };
    for (const block of message.content) {
      // A reasoning item this conversation came back with, in the position it was replayed from —
      // beside the function calls of that turn, and never for the other wire's carrier (reasoning.ts).
      const envelope = envelopeFor(block, "responses", opts?.env, (reason) => {
        carried("undecodable");
        if (opts?.replay !== false) opts?.log?.(`dropped a reasoning carrier: ${reason}`);
      });
      if (envelope) {
        if (opts?.replay !== false) {
          const item = replayableReasoning(envelope.r);
          if (item) {
            flush();
            input.push(item);
            carried("replayed");
            opts?.onArrival?.(item, lastCallId);
          } else carried("undecodable");
        }
        continue;
      }
      if (block.type === "text") {
        const text = String((block as { text?: unknown }).text ?? "");
        if (text) parts.push({ type: role === "user" ? "input_text" : "output_text", text });
      } else if (block.type === "document") {
        parts.push(documentResponsePart(block, role));
      } else if (block.type === "image" && role === "user") {
        const url = imageUrl(block);
        if (url) parts.push({ type: "input_image", image_url: url });
      } else if (block.type === "tool_use") {
        flush();
        const call = block as { id: string; name: string; input: unknown };
        knownCalls.add(call.id);
        lastCallId = call.id;
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
        if (Array.isArray(result.content)) for (const doc of result.content) if (doc.type === "document") parts.push(documentResponsePart(doc, "user"));
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
    if (opts.promptCacheKey) out.prompt_cache_key = opts.promptCacheKey;
    return out;
  }

  const responseTools: ResponsesTool[] = tools.map(({ function: fn }) => ({ type: "function", ...fn }));
  const input = toResponsesInput(req, opts);
  const out: ResponsesRequest = {
    model: opts.model,
    input,
    stream: true,
  };
  // A vendor marked `sealedReasoning` is asked for its reasoning on every turn, the way OpenCode's own
  // client asks: asking only once a conversation already carried some would never start one on a
  // vendor that seals nothing unasked. Anyone else is asked only when the conversation is already
  // carrying its reasoning, so a request for a vendor never measured stays as it was.
  if (opts.replay !== false && (opts.sealedReasoning || input.some((item) => item.type === "reasoning"))) out.include = ["reasoning.encrypted_content"];
  const instructions = systemWithIdentity(systemWithDroppedToolNote(req), opts);
  if (instructions) out.instructions = instructions;
  if (responseTools.length) {
    out.tools = responseTools;
    out.parallel_tool_calls = parallel;
    const choice = mapResponsesToolChoice(req, responseTools);
    if (choice) out.tool_choice = choice;
  }
  // Responses will not accept a cap below sixteen, and answers a smaller one with a 400 naming the
  // parameter. Anthropic Messages has no such floor, so a client that asks for a single token is
  // asking something legal that this wire cannot express: Claude Code checks a model by requesting
  // one token, and every switch to a Responses model failed on it (measured 2026-09-22). Raise the
  // floor rather than pass the refusal on — a cap is a limit, and a larger one still obeys it.
  if (typeof req.max_tokens === "number") out.max_output_tokens = Math.max(16, req.max_tokens);
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (effort) out.reasoning = opts.sealedReasoning && opts.replay !== false ? { effort, summary: "auto" } : { effort };
  if (opts.promptCacheKey) out.prompt_cache_key = opts.promptCacheKey;
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
type ThinkingOutputBlock = { type: "thinking"; thinking: string; signature?: string };
type ToolOutputBlock = { type: "tool_use"; id: string; name: string; input: unknown; args: string; index: number };
type OutputBlock = TextOutputBlock | ThinkingOutputBlock | ToolOutputBlock;
type OpenBlock = { kind: "text" | "thinking" | "tool"; index: number; toolIndex?: number };
type ResponseItem = {
  id: string;
  kind: "text" | "tool" | "reasoning";
  block: OutputBlock;
  done: boolean;
  emitted: boolean;
  closed: boolean;
  emittedText: number;
};
/** A Responses reasoning item, as it arrives and as it is sealed for the client (reasoning.ts). */
type ReasoningItem = { encrypted?: string; summary: unknown; content?: unknown; text: string; fullText: string };

/** Maps standard OpenAI Chat Completion and Responses SSE records to Anthropic Messages SSE. */
export class OpenAiStreamMapper {
  private started = false;
  private finished = false;
  private blockIndex = -1;
  /** `block` is the content entry this block writes into; `signature` seals a Responses item. */
  private open: (OpenBlock & { signature?: string; block?: OutputBlock }) | null = null;
  private sawTool = false;
  private finishReason: string | undefined;
  private readonly responseItems: ResponseItem[] = [];
  private readonly responseItemsById = new Map<string, ResponseItem>();
  private readonly responseItemsByOutput = new Map<number, ResponseItem>();
  /** Reasoning items of a Responses stream, by item id, until the item that carries one is done. */
  private readonly reasoningItems = new Map<string, ReasoningItem>();
  /** The item id of the most recent function_call, which is what a following reasoning describes. */
  private lastCallId: string | undefined;
  /** The field a Chat vendor's reasoning arrived under; the same one it is replayed under. */
  private chatReasoningField: "reasoning_content" | "reasoning" = "reasoning_content";
  readonly messageId = `msg_${crypto.randomBytes(12).toString("hex")}`;
  servedTier: string | undefined;
  readonly content: OutputBlock[] = [];
  usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
  /** How many reasoning items this response handed over whole. The `reasoning=` figure in the log. */
  reasoningCount = 0;

  readonly model: string;
  private readonly startInput: number;

  /** Mangled tool name → the name Claude Code knows, from `toolNameRestoreMap`. */
  private readonly toolNames: ReadonlyMap<string, string>;

  /** What goes in each envelope: the provider and model this stream is going to (reasoning.ts). */
  private readonly env: { p: string; m: string };

  /**
   * The wire this stream is on. It is fixed for the mapper's life — the adapter knows it before the
   * first event. Decides what a closing block does: on Chat the block itself is the carrier.
   */
  wire: OpenAiWire = "chat";

  /** Applied to every error message before it is stored or sent. */
  redactError: (message: string) => string = (message) => message;

  constructor(model: string, startInput = 0, toolNames: ReadonlyMap<string, string> = new Map(), env: { p: string; m: string } = { p: "", m: "" }) {
    this.model = model;
    this.startInput = startInput;
    this.toolNames = toolNames;
    this.env = { p: env.p, m: env.m || model };
  }

  get isFinished(): boolean { return this.finished; }

  /**
   * Whether the vendor said the answer was over: `response.completed`/`response.incomplete` on
   * Responses, a `finish_reason` on Chat. A stream that closes without either was cut off, and
   * finishing it as `end_turn` hands the client an empty or half answer it accepts as final — the
   * worker that "stalls and dies" (muse, 84 of 1,815 turns, 2026-09-18..22).
   */
  get completed(): boolean { return this.sawCompletion; }
  private sawCompletion = false;

  /** The error `fail` reported, so a non-streaming caller can answer with it instead of a 200. */
  failure: { type: string; message: string; code?: string } | undefined;

  start(): AnthropicEvent[] {
    if (this.started) return [];
    this.started = true;
    return [{ event: "message_start", data: { type: "message_start", message: { id: this.messageId, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: this.startInput, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } }];
  }

  /**
   * Close the block that is open, writing any envelope it carries as a `signature_delta` first — last
   * in the block, after all of its text, the order Anthropic's own thinking blocks use.
   *
   * A Chat reasoning block is sealed here, because only now is its text whole; a Responses one was
   * sealed by its item (see `sealReasoningItem`) before this is reached, so it never gets here
   * unsigned.
   */
  private closeBlock(): AnthropicEvent[] {
    if (!this.open) return [];
    const { index, kind, block } = this.open;
    let signature = this.open.signature;
    if (signature === undefined && kind === "thinking" && this.wire === "chat") {
      signature = this.signatureForChat(block);
    }
    this.open = null;
    const out: AnthropicEvent[] = [];
    if (signature !== undefined) out.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "signature_delta", signature } } });
    out.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    return out;
  }

  /**
   * `block` is the caller's entry in `this.content` for this block, when it has one. It is held here
   * rather than found as the last entry, because a Chat caller pushes the entry it is about to open
   * *before* calling this — which would close the block against the wrong entry.
   */
  private openBlock(kind: "text" | "thinking" | "tool", contentBlock: Record<string, unknown>, toolIndex?: number, block?: OutputBlock): AnthropicEvent[] {
    const out = this.closeBlock();
    const index = ++this.blockIndex;
    if (block !== undefined) this.content.push(block);
    this.open = { kind, index, ...(toolIndex === undefined ? {} : { toolIndex }), ...(block === undefined ? {} : { block }) };
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
    if (typeof ev.service_tier === "string") this.servedTier = ev.service_tier;
    const usage = ev.usage;
    if (usage) this.setUsage(usage);
    const choices = Array.isArray(ev.choices) ? ev.choices as { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[] : [];
    for (const choice of choices) {
      const delta = choice.delta ?? {};
      // Thinking arrives before the answer, so it opens the first block of the turn. `reasoning` is
      // accepted alongside `reasoning_content` because vendors on this wire disagree on the name;
      // the name it arrived under is remembered, because the same name is what the reasoning has to
      // be replayed under on the next turn (reasoning.ts).
      const field = typeof delta.reasoning_content === "string" && delta.reasoning_content ? "reasoning_content"
        : typeof delta.reasoning === "string" && delta.reasoning ? "reasoning" : null;
      const reasoning = field === "reasoning_content" ? delta.reasoning_content as string : field === "reasoning" ? delta.reasoning as string : "";
      if (field) this.chatReasoningField = field;
      if (reasoning) {
        if (!this.open || this.open.kind !== "thinking") {
          // A Chat model's reasoning has no sealed blob to resume from, so the carrier is the block
          // itself: the block's text is the reasoning to replay, and its signature is the envelope
          // naming the field to replay it under (reasoning.ts). It is sealed when the block closes,
          // so the envelope is built once the whole string has arrived (see `signatureForChat`).
          out.push(...this.openBlock("thinking", { type: "thinking", thinking: "" }, undefined, { type: "thinking", thinking: "" }));
        }
        const block = this.open?.block as ThinkingOutputBlock | undefined;
        if (block) block.thinking += reasoning;
        out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open!.index, delta: { type: "thinking_delta", thinking: reasoning } } });
      }
      if (typeof delta.content === "string" && delta.content) {
        if (!this.open || this.open.kind !== "text") {
          out.push(...this.openBlock("text", { type: "text", text: "" }, undefined, { type: "text", text: "" }));
        }
        const block = this.open?.block as TextOutputBlock | undefined;
        if (block) block.text += delta.content;
        out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open!.index, delta: { type: "text_delta", text: delta.content } } });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          if (!raw || typeof raw !== "object") continue;
          const call = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
          const index = typeof call.index === "number" ? call.index : 0;
          const tool = this.toolFor(index, call);
          // Chat has no per-call completion event. Hold arguments by index until the turn ends,
          // then emit each call once instead of reopening A/B/A/B as broken JSON blocks.
          const args = call.function?.arguments;
          if (typeof args === "string" && args) tool.args += args;
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        this.finishReason = choice.finish_reason;
        this.sawCompletion = true;
      }
    }
    return out;
  }

  /**
   * Seal a closing thinking block of our own: a Chat block into the envelope that names the field to
   * replay its text under (see `feedChat`).
   */
  private signatureForChat(block: OutputBlock | undefined): string | undefined {
    if (this.wire !== "chat" || block?.type !== "thinking" || block.thinking.length === 0) return undefined;
    const signature = encodeEnvelope({ w: "chat", p: this.env.p, m: this.env.m, f: this.chatReasoningField });
    block.signature = signature;
    this.reasoningCount++;
    return signature;
  }

  /**
   * Put the finished Responses reasoning item into the envelope its block carries: the wire, this
   * provider and model, and the item's sealed blob or full reasoning text, untouched (reasoning.ts).
   * A summary alone is display text, not the original reasoning, and stays unsigned.
   */
  private sealReasoningItem(item: ResponseItem): void {
    const held = this.reasoningItems.get(item.id);
    const block = item.block as ThinkingOutputBlock;
    const reasoning = replayableReasoning({
      type: "reasoning", id: item.id, encrypted_content: held?.encrypted, summary: held?.summary,
      content: Array.isArray(held?.content) && held.content.length > 0 ? held.content
        : held?.fullText ? [{ type: "reasoning_text", text: held.fullText }] : held?.content,
    });
    block.thinking = held?.text.trim() || block.thinking.trim() || reasoning?.content?.map((part) => part.text).join("") || (typeof held?.summary === "string" ? held.summary.trim() : "");
    if (!reasoning) {
      block.signature = "";
      return;
    }
    block.signature = encodeEnvelope({ w: "responses", p: this.env.p, m: this.env.m, r: { ...reasoning } });
    this.reasoningCount++;
  }

  private responseItem(id: unknown, kind?: ResponseItem["kind"]): ResponseItem | undefined {
    if (typeof id === "string") return this.responseItemsById.get(id);
    if (typeof id === "number") return this.responseItemsByOutput.get(id);
    // Standard Responses SSE includes item_id. A few compatible servers omit it for
    // a single in-flight item; support only the unambiguous form, never guess across
    // parallel calls.
    const candidates = this.responseItems.filter((item) => !item.done && (!kind || item.kind === kind));
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private completeResponseArguments(item: ResponseItem | undefined, value: unknown): AnthropicEvent[] {
    if (item?.kind !== "tool" || typeof value !== "string") return [];
    const tool = item.block as ToolOutputBlock;
    tool.args = value;
    if (!item.emitted || item.closed || this.open?.toolIndex !== tool.index) return [];
    const text = value.slice(item.emittedText);
    item.emittedText = value.length;
    return text ? [{ event: "content_block_delta", data: { type: "content_block_delta", index: this.open.index, delta: { type: "input_json_delta", partial_json: text } } }] : [];
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
      if (item.kind === "reasoning") {
        // Emitted only once the item is done, because the block is handed over whole: the sealed
        // reasoning is what goes in the envelope, and it may only arrive with the completed item.
        // `sealReasoningItem` has already put the envelope on the block by then.
        if (!item.done) break;
        const reasoning = item.block as ThinkingOutputBlock;
        out.push(...this.openBlock("thinking", { type: "thinking", thinking: "" }));
        if (reasoning.signature !== undefined) this.open = { ...this.open!, signature: reasoning.signature };
        if (reasoning.thinking) out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open!.index, delta: { type: "thinking_delta", thinking: reasoning.thinking } } });
        item.emitted = true;
        item.emittedText = reasoning.thinking.length;
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
      const item = ev.item as { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown; encrypted_content?: unknown; summary?: unknown; content?: unknown } | undefined;
      const id = typeof item?.id === "string" ? item.id : typeof ev.output_index === "number" ? `output_${ev.output_index}` : undefined;
      if (id && item?.type === "message") {
        const block: TextOutputBlock = { type: "text", text: "" };
        this.content.push(block);
        const responseItem: ResponseItem = { id, kind: "text", block, done: false, emitted: false, closed: false, emittedText: 0 };
        this.responseItems.push(responseItem);
        this.responseItemsById.set(id, responseItem);
      } else if (id && item?.type === "function_call") {
        this.lastCallId = item.call_id === undefined || item.call_id === null ? id : String(item.call_id);
        const index = this.content.filter((block) => block.type === "tool_use").length;
        const tool = this.toolFor(index, { id: item.call_id ?? item.id, function: { name: item.name } });
        if (typeof item.arguments === "string") tool.args = item.arguments;
        const responseItem: ResponseItem = { id, kind: "tool", block: tool, done: false, emitted: false, closed: false, emittedText: 0 };
        this.responseItems.push(responseItem);
        this.responseItemsById.set(id, responseItem);
      } else if (id && item?.type === "reasoning") {
        // The item's sealed reasoning and summary, held until the item is done: the block handed over
        // carries both, and a half-assembled one must not reach the client (reasoning.ts).
        const reasoning: ReasoningItem = {
          ...(typeof item.encrypted_content === "string" && item.encrypted_content ? { encrypted: item.encrypted_content } : {}),
          summary: item.summary,
          content: item.content,
          text: "",
          fullText: "",
        };
        this.reasoningItems.set(id, reasoning);
        const block: ThinkingOutputBlock = { type: "thinking", thinking: "" };
        this.content.push(block);
        const responseItem: ResponseItem = { id, kind: "reasoning", block, done: false, emitted: false, closed: false, emittedText: 0 };
        this.responseItems.push(responseItem);
        this.responseItemsById.set(id, responseItem);
      }
      const added = id ? this.responseItemsById.get(id) : undefined;
      if (added && typeof ev.output_index === "number") this.responseItemsByOutput.set(ev.output_index, added);
    } else if (type === "response.output_text.delta") {
      const text = typeof ev.delta === "string" ? ev.delta : "";
      const item = this.responseItem(ev.item_id ?? ev.output_index, "text");
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
      const item = this.responseItem(ev.item_id ?? ev.output_index, "tool");
      if (item?.kind === "tool" && text) {
        const tool = item.block as ToolOutputBlock;
        tool.args += text;
        if (item.emitted && this.open?.kind === "tool" && this.open.toolIndex === tool.index) {
          out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open.index, delta: { type: "input_json_delta", partial_json: text } } });
          item.emittedText += text.length;
        }
      }
    } else if (type === "response.function_call_arguments.done") {
      out.push(...this.completeResponseArguments(this.responseItem(ev.item_id ?? ev.output_index, "tool"), ev.arguments));
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      // The summary, shown as the thinking block's text. When there is none — which is the usual
      // shape — nothing arrives and the block stays empty, exactly as the item was measured.
      const text = typeof ev.delta === "string" ? ev.delta : "";
      const item = this.responseItem(ev.item_id ?? ev.output_index, "reasoning");
      if (item?.kind === "reasoning" && text) {
        const block = item.block as ThinkingOutputBlock;
        block.thinking += text;
        const held = this.reasoningItems.get(item.id);
        if (held) {
          held.text += text;
          if (type === "response.reasoning_text.delta") held.fullText += text;
        }
        if (item.emitted && this.open?.kind === "thinking") {
          out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open.index, delta: { type: "thinking_delta", thinking: text } } });
          item.emittedText += text.length;
        }
      }
    } else if (type === "response.output_item.done") {
      const done = ev.item as { id?: unknown; type?: unknown; arguments?: unknown; encrypted_content?: unknown; summary?: unknown; content?: unknown } | undefined;
      const item = this.responseItem(ev.item_id ?? done?.id ?? ev.output_index);
      out.push(...this.completeResponseArguments(item, done?.arguments));
      if (item?.kind === "reasoning" && done) {
        // Use the resolved item: compatible servers can address completion by output_index alone.
        const held = this.reasoningItems.get(item.id);
        if (held) {
          if (typeof done.encrypted_content === "string" && done.encrypted_content) held.encrypted = done.encrypted_content;
          if (done.summary !== undefined) held.summary = done.summary;
          if (done.content !== undefined) held.content = done.content;
        }
      }
      if (item) {
        item.done = true;
        if (item.kind === "reasoning") this.sealReasoningItem(item);
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = ev.response as { service_tier?: unknown; usage?: unknown; incomplete_details?: { reason?: unknown } } | undefined;
      if (typeof response?.service_tier === "string") this.servedTier = response.service_tier;
      this.setUsage(response?.usage);
      if (response?.incomplete_details?.reason === "max_output_tokens") this.finishReason = "length";
      this.sawCompletion = true;
    } else if (type === "response.failed" || type === "error") {
      const error = (type === "error" ? ev.error : (ev.response as { error?: unknown } | undefined)?.error) as { message?: unknown; code?: unknown } | undefined;
      return [...out, ...this.fail(typeof error?.message === "string" ? error.message : "upstream response failed", typeof error?.code === "string" ? error.code : undefined)];
    }
    out.push(...this.flushResponses());
    if (this.sawCompletion) out.push(...this.finish());
    return out;
  }

  feed(ev: Record<string, unknown>, wire: OpenAiWire): AnthropicEvent[] {
    if (this.finished) return [];
    this.wire = wire;
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
    this.stopReason = this.finishReason === "length" || this.finishReason === "max_output_tokens" ? "max_tokens" : this.sawTool || this.finishReason === "tool_calls" ? "tool_use" : "end_turn";
    const out = [...this.start(), ...this.closeBlock()];
    if (this.wire === "chat") {
      for (const tool of this.content) {
        if (tool.type !== "tool_use") continue;
        out.push(...this.openBlock("tool", { type: "tool_use", id: tool.id, name: tool.name, input: {} }, tool.index));
        if (tool.args) out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.open!.index, delta: { type: "input_json_delta", partial_json: tool.args } } });
        out.push(...this.closeBlock());
      }
    }
    out.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: this.stopReason, stop_sequence: null }, usage: this.usage } }, { event: "message_stop", data: { type: "message_stop" } });
    return out;
  }

  fail(rawMessage: string, code?: string): AnthropicEvent[] {
    if (this.finished) return [];
    this.finished = true;
    // A vendor's error text can echo the credential it was sent; the client, the non-streamed body
    // and the request log all take `failure.message`, so it is cleaned once, here.
    const message = this.redactError(rawMessage);
    // `overloaded_error` is the one mid-stream error Claude Code retries on its own (CLI 2.1.278
    // matches `"type":"overloaded_error"` in the message); `api_error` ends the turn for good.
    const type = code === "rate_limit_exceeded" ? "rate_limit_error" : code === "server_is_overloaded" ? "overloaded_error" : "api_error";
    this.failure = { type, message, ...(code ? { code } : {}) };
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
