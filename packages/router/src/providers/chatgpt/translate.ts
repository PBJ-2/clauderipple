// Anthropic Messages  ⇄  OpenAI Responses (Codex backend). Pure functions, no I/O.
//
// Prompt-cache rule: the Responses `input` we build must be a byte-stable prefix of the
// next turn's `input`. Claude Code resends the whole history every turn, so the mapping
// has to be deterministic and must not inject anything that varies (timestamps, salts,
// re-signed reasoning). Thinking blocks from earlier assistant turns are dropped for the
// same reason. `prompt_cache_key` is derived from the conversation's first user message.

import crypto from "node:crypto";

// ---- Anthropic side -----------------------------------------------------------------

export type AnthropicBlock =
  | { type: "text"; text: string; cache_control?: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string | AnthropicBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking?: string; signature?: string }
  | { type: "redacted_thinking"; data?: string }
  | { type: string; [k: string]: unknown };

export type AnthropicMessage = { role: "user" | "assistant" | string; content: string | AnthropicBlock[] };

export type AnthropicTool = { name: string; description?: string; input_schema?: Record<string, unknown>; [k: string]: unknown };

export type AnthropicRequest = {
  model: string;
  system?: string | { type?: string; text: string; cache_control?: unknown }[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "none" | "tool"; name?: string; disable_parallel_tool_use?: boolean };
  stream?: boolean;
  max_tokens?: number;
  output_config?: { effort?: string };
  metadata?: { user_id?: string };
  [k: string]: unknown;
};

// ---- Responses side -----------------------------------------------------------------

export type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant"; content: ({ type: "input_text" | "output_text"; text: string } | { type: "input_image"; image_url: string })[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export type ResponsesRequest = {
  model: string;
  instructions: string;
  input: ResponsesInputItem[];
  tools?: { type: "function"; name: string; description: string; parameters: Record<string, unknown>; strict: false }[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string };
  parallel_tool_calls?: boolean;
  reasoning: { effort: string; summary: "auto" };
  text: { verbosity: "medium" };
  store: false;
  stream: true;
  prompt_cache_key: string;
};

export type TranslateOptions = {
  model: string;
  effort: string;
  identity: boolean;
  instructionsAppend?: string;
};

function blockText(c: string | AnthropicBlock[] | undefined): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b) => (b.type === "text" ? (b as { text: string }).text : b.type === "image" ? "[image omitted]" : ""))
    .filter((s) => s.length > 0)
    .join("\n");
}

export function systemText(system: AnthropicRequest["system"]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((b) => b.text ?? "").filter((s) => s.length > 0).join("\n\n");
}

export function conversationKey(req: AnthropicRequest): string {
  const first = req.messages.find((m) => m.role === "user");
  const seed = `${req.metadata?.user_id ?? ""}\n${first ? blockText(first.content).slice(0, 4000) : ""}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

// The Codex backend validates every `pattern` in a tool schema with a regex engine that has no
// lookaround or backreferences; one such pattern anywhere fails the whole request with
// "Invalid schema for function 'X': '...' is not a 'regex'" (measured 2026-09-13 with the
// Claude Code Artifact tool). Those patterns are dropped; the client validates inputs itself.
const UNSUPPORTED_REGEX = /\(\?[=!<]|\\[1-9]/;

export function unsupportedPattern(p: string): boolean {
  return UNSUPPORTED_REGEX.test(p);
}

function scrubSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(scrubSchema);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "pattern" && typeof v === "string" && unsupportedPattern(v)) continue;
    out[k] = scrubSchema(v);
  }
  return out;
}

export function normalizeSchema(s: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = scrubSchema(s ?? {}) as Record<string, unknown>;
  if (out.type !== "object") out.type = "object";
  if (typeof out.properties !== "object" || out.properties === null) out.properties = {};
  if (out.required !== undefined && !Array.isArray(out.required)) delete out.required;
  return out;
}

export function toResponsesRequest(req: AnthropicRequest, opts: TranslateOptions): ResponsesRequest {
  const parts: string[] = [];
  // Effort is named here because the model cannot see its own reasoning setting and will otherwise guess.
  // Constant per (model, effort): changing effort mid-session costs one cache miss, which is acceptable.
  if (opts.identity) parts.push(`You are ${opts.model} (reasoning effort: ${opts.effort}), answering through Claude Code, a terminal-based coding agent.`);
  const sys = systemText(req.system);
  if (sys) parts.push(sys);
  if (opts.instructionsAppend) parts.push(opts.instructionsAppend);

  const input: ResponsesInputItem[] = [];
  for (const m of req.messages) {
    const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") {
      if (m.content.length > 0) input.push({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: m.content }] });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    let pending: ({ type: "input_text" | "output_text"; text: string } | { type: "input_image"; image_url: string })[] = [];
    const flush = (): void => {
      if (pending.length > 0) input.push({ type: "message", role, content: pending });
      pending = [];
    };
    for (const b of m.content) {
      switch (b.type) {
        case "text": {
          const t = (b as { text: string }).text;
          if (t.length > 0) pending.push({ type: role === "user" ? "input_text" : "output_text", text: t });
          break;
        }
        case "image": {
          const src = (b as { source: { type: string; media_type?: string; data?: string; url?: string } }).source;
          if (role === "user") {
            if (src.type === "base64" && src.data) pending.push({ type: "input_image", image_url: `data:${src.media_type ?? "image/png"};base64,${src.data}` });
            else if (src.type === "url" && src.url) pending.push({ type: "input_image", image_url: src.url });
          }
          break;
        }
        case "tool_use": {
          flush();
          const tu = b as { id: string; name: string; input: unknown };
          input.push({ type: "function_call", call_id: tu.id, name: tu.name, arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input ?? {}) });
          break;
        }
        case "tool_result": {
          flush();
          const tr = b as { tool_use_id: string; content?: string | AnthropicBlock[]; is_error?: boolean };
          let out = blockText(tr.content);
          if (tr.is_error && !out) out = "Tool execution failed";
          input.push({ type: "function_call_output", call_id: tr.tool_use_id, output: out });
          break;
        }
        default:
          // thinking / redacted_thinking / unknown: dropped on purpose (see header comment)
          break;
      }
    }
    flush();
  }

  const tools = (req.tools ?? [])
    .filter((t) => typeof t.name === "string")
    .map((t) => ({ type: "function" as const, name: t.name, description: t.description ?? "", parameters: normalizeSchema(t.input_schema), strict: false as const }));

  let tool_choice: ResponsesRequest["tool_choice"];
  const tc = req.tool_choice;
  if (tools.length > 0) {
    if (!tc || tc.type === "auto") tool_choice = "auto";
    else if (tc.type === "any") tool_choice = "required";
    else if (tc.type === "none") tool_choice = "none";
    else if (tc.type === "tool" && tc.name) tool_choice = { type: "function", name: tc.name };
  }

  const out: ResponsesRequest = {
    model: opts.model,
    instructions: parts.join("\n\n"),
    input,
    reasoning: { effort: opts.effort, summary: "auto" },
    text: { verbosity: "medium" },
    store: false,
    stream: true,
    prompt_cache_key: conversationKey(req),
  };
  if (tools.length > 0) {
    out.tools = tools;
    out.parallel_tool_calls = !(tc?.disable_parallel_tool_use ?? false);
  }
  if (tool_choice) out.tool_choice = tool_choice;
  return out;
}

/** Rough token estimate for /v1/messages/count_tokens when the model is not Anthropic's. */
export function estimateTokens(req: AnthropicRequest): number {
  const text = JSON.stringify({ s: req.system ?? "", m: req.messages, t: req.tools ?? [] });
  return Math.ceil(text.length / 4);
}

// ---- Responses stream → Anthropic stream -------------------------------------------

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export type AnthropicEvent = { event: string; data: Record<string, unknown> };

/** Stateful mapper: feed Responses SSE events, get Anthropic SSE events. */
export class StreamMapper {
  private started = false;
  private blockIndex = -1;
  private open: { kind: "text" | "thinking" | "tool"; itemId?: string } | null = null;
  private sawToolCall = false;
  private finished = false;
  readonly messageId: string;
  readonly model: string;
  usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  /** Latest `codex.rate_limits` payload, if the backend sent one. */
  rateLimits: Record<string, unknown> | null = null;
  /** Accumulated content for non-streaming responses. */
  readonly content: ({ type: "text"; text: string } | { type: "thinking"; thinking: string; signature: string } | { type: "tool_use"; id: string; name: string; input: unknown; _args?: string })[] = [];
  stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";

  constructor(model: string) {
    this.model = model;
    this.messageId = `msg_${crypto.randomBytes(12).toString("hex")}`;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  start(): AnthropicEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: { id: this.messageId, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
    ];
  }

  private closeBlock(): AnthropicEvent[] {
    if (!this.open) return [];
    const evs: AnthropicEvent[] = [];
    if (this.open.kind === "thinking") evs.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.blockIndex, delta: { type: "signature_delta", signature: "" } } });
    evs.push({ event: "content_block_stop", data: { type: "content_block_stop", index: this.blockIndex } });
    this.open = null;
    return evs;
  }

  private openBlock(kind: "text" | "thinking" | "tool", block: Record<string, unknown>, itemId?: string): AnthropicEvent[] {
    const evs = this.closeBlock();
    this.blockIndex++;
    this.open = itemId ? { kind, itemId } : { kind };
    evs.push({ event: "content_block_start", data: { type: "content_block_start", index: this.blockIndex, content_block: block } });
    return evs;
  }

  /** Map one upstream event. Returns Anthropic events to emit (possibly none). */
  feed(ev: Record<string, unknown>): AnthropicEvent[] {
    const type = ev.type as string;
    const out: AnthropicEvent[] = [...this.start()];
    switch (type) {
      case "codex.rate_limits":
        this.rateLimits = ev;
        break;
      case "response.output_item.added": {
        const item = ev.item as { type: string; call_id?: string; name?: string; id?: string };
        if (item.type === "function_call") {
          this.sawToolCall = true;
          const id = item.call_id ?? item.id ?? `call_${crypto.randomBytes(8).toString("hex")}`;
          this.content.push({ type: "tool_use", id, name: item.name ?? "tool", input: {}, _args: "" });
          out.push(...this.openBlock("tool", { type: "tool_use", id, name: item.name ?? "tool", input: {} }, item.id));
        } else if (item.type === "reasoning") {
          this.content.push({ type: "thinking", thinking: "", signature: "" });
          out.push(...this.openBlock("thinking", { type: "thinking", thinking: "" }, item.id));
        } else if (item.type === "message") {
          this.content.push({ type: "text", text: "" });
          out.push(...this.openBlock("text", { type: "text", text: "" }, item.id));
        }
        break;
      }
      case "response.output_text.delta": {
        const delta = String(ev.delta ?? "");
        if (!this.open || this.open.kind !== "text") {
          this.content.push({ type: "text", text: "" });
          out.push(...this.openBlock("text", { type: "text", text: "" }));
        }
        const last = this.content[this.content.length - 1];
        if (last?.type === "text") last.text += delta;
        out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.blockIndex, delta: { type: "text_delta", text: delta } } });
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = String(ev.delta ?? "");
        if (!this.open || this.open.kind !== "thinking") {
          this.content.push({ type: "thinking", thinking: "", signature: "" });
          out.push(...this.openBlock("thinking", { type: "thinking", thinking: "" }));
        }
        const last = this.content[this.content.length - 1];
        if (last?.type === "thinking") last.thinking += delta;
        out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.blockIndex, delta: { type: "thinking_delta", thinking: delta } } });
        break;
      }
      case "response.function_call_arguments.delta": {
        const delta = String(ev.delta ?? "");
        const last = this.content[this.content.length - 1];
        if (last?.type === "tool_use") last._args = (last._args ?? "") + delta;
        if (this.open?.kind === "tool") out.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.blockIndex, delta: { type: "input_json_delta", partial_json: delta } } });
        break;
      }
      case "response.function_call_arguments.done": {
        const last = this.content[this.content.length - 1];
        if (last?.type === "tool_use") {
          const args = typeof ev.arguments === "string" ? ev.arguments : last._args ?? "";
          try {
            last.input = args ? JSON.parse(args) : {};
          } catch {
            last.input = {};
          }
          delete last._args;
        }
        break;
      }
      case "response.output_item.done": {
        out.push(...this.closeBlock());
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const r = ev.response as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }; incomplete_details?: { reason?: string } } | undefined;
        const u = r?.usage;
        if (u) {
          const cached = u.input_tokens_details?.cached_tokens ?? 0;
          this.usage = {
            input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached),
            output_tokens: u.output_tokens ?? 0,
            cache_read_input_tokens: cached,
            cache_creation_input_tokens: 0,
          };
        }
        this.stopReason = this.sawToolCall ? "tool_use" : r?.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "end_turn";
        out.push(...this.finish());
        break;
      }
      case "response.failed": {
        const r = ev.response as { error?: { code?: string; message?: string } } | undefined;
        out.push(...this.fail(r?.error?.message ?? "upstream response failed", r?.error?.code));
        break;
      }
      case "error": {
        const e = ev.error as { code?: string; message?: string; type?: string } | undefined;
        out.push(...this.fail(e?.message ?? "upstream error", e?.code));
        break;
      }
      default:
        break; // response.created / in_progress / content_part.* / reasoning_summary_part.* etc. carry nothing we need
    }
    return out;
  }

  finish(): AnthropicEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const out = [...this.start(), ...this.closeBlock()];
    out.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: this.stopReason, stop_sequence: null }, usage: this.usage } });
    out.push({ event: "message_stop", data: { type: "message_stop" } });
    return out;
  }

  fail(message: string, code?: string): AnthropicEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const type = code === "server_is_overloaded" ? "overloaded_error" : code === "rate_limit_exceeded" || code === "usage_limit_reached" ? "rate_limit_error" : "api_error";
    return [...this.start(), ...this.closeBlock(), { event: "error", data: { type: "error", error: { type, message } } }];
  }

  /** Non-streaming body once finished. */
  message(): Record<string, unknown> {
    const content = this.content.map((b) => {
      if (b.type === "tool_use") {
        const { _args, ...rest } = b;
        if (_args !== undefined) {
          try {
            rest.input = _args ? JSON.parse(_args) : {};
          } catch {
            rest.input = {};
          }
        }
        return rest;
      }
      return b;
    });
    return { id: this.messageId, type: "message", role: "assistant", model: this.model, content, stop_reason: this.stopReason, stop_sequence: null, usage: this.usage };
  }
}

export function formatSse(ev: AnthropicEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}
