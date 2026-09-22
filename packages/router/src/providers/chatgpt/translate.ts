// Anthropic Messages  ⇄  OpenAI Responses (Codex backend). Pure functions, no I/O.
//
// Prompt-cache rule: the Responses `input` we build must be a byte-stable prefix of the
// next turn's `input`. Claude Code resends the whole history every turn, so the mapping
// has to be deterministic and must not inject anything that varies (timestamps, salts,
// re-signed reasoning). Thinking blocks from earlier assistant turns are dropped for the
// same reason. `prompt_cache_key` is derived from the conversation's first user message — or,
// for a request that is not a conversation at all, from its system prompt (see `conversationKey`).

import crypto from "node:crypto";
import { identityLine } from "../../identity.ts";

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
  /** Who this turn belongs to, in the shape the Codex CLI sends — see `conversationId`. */
  client_metadata: { session_id: string; thread_id: string; turn_id: string; "x-codex-window-id": string };
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
    .map((b) => (b.type === "text" ? (b as { text: string }).text : b.type === "image" ? "[image]" : ""))
    .filter((s) => s.length > 0)
    .join("\n");
}

function toolResultText(content: string | AnthropicBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .filter(Boolean)
    .join("\n");
}

function imageUrl(block: AnthropicBlock): string | null {
  const source = (block as { source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown } }).source;
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64" && typeof source.data === "string") return `data:${typeof source.media_type === "string" ? source.media_type : "image/png"};base64,${source.data}`;
  if (source.type === "url" && typeof source.url === "string") return source.url;
  return null;
}

function toolResultImages(content: string | AnthropicBlock[] | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block.type === "image")
    .map(imageUrl)
    .filter((url): url is string => url !== null);
}

// Claude Code's first system block is Anthropic billing telemetry ("x-anthropic-billing-header: …
// cch=<hash> …") whose hash changes on every turn. Left in, it sits at the top of `instructions`
// and invalidates the prompt cache for everything after it (measured 2026-09-13: cached_tokens
// stuck at the tools prefix while input grew 39k→43k). It means nothing to another provider.
const BILLING_BLOCK = /^x-anthropic-billing-header:/;

export function systemText(system: AnthropicRequest["system"]): string {
  if (typeof system === "string") return system.replace(/^x-anthropic-billing-header:[^\n]*\n*/, "");
  if (!Array.isArray(system)) return "";
  return system
    .map((b) => b.text ?? "")
    .filter((s) => s.length > 0 && !BILLING_BLOCK.test(s))
    .join("\n\n");
}

// A request with no `metadata.user_id` and one lone user turn is not a conversation: it is one of
// the things the CLI sends beside one — the web-search side request, a title, a summary. Its single
// message differs every time, so seeding on it minted a fresh key per request and the prefix all of
// them share (system prompt, tool definitions) was never cached: measured `cached_tokens: 0` on all
// 68 smallFast calls in a day's log, where the same wire asked twice under one key returns 94%.
// The system prompt is the part of such a request that does not vary, so it is what names the class.
// A real conversation that simply was not given metadata — the OpenAI ingress builds none — keeps
// the old seed from its second turn on; only its opening turn shares the class key, and what that
// turn reads there is the same fixed prefix it would have paid for anyway.
export function conversationKey(req: AnthropicRequest): string {
  const userId = req.metadata?.user_id;
  const first = req.messages.find((m) => m.role === "user");
  // `side` keeps the two seeds in separate spaces: without it a conversation whose opening message
  // happened to equal a system prompt would land on that class's key.
  const seed = !userId && req.messages.length <= 1
    ? `side\n${systemText(req.system).slice(0, 4000)}`
    : `${userId ?? ""}\n${first ? blockText(first.content).slice(0, 4000) : ""}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

/**
 * The conversation key as a UUID, which is what the backend wants a conversation to be called.
 *
 * `prompt_cache_key` alone stopped earning a prompt cache between 2026-09-15 and 2026-09-19: five
 * turns with byte-identical instructions, tools and input prefix, 3–6s apart under one key, all
 * came back `cached_tokens: 0` and `cache_write_tokens: 0` (2026-09-20, GPT-6 Astra; the same
 * adapter read 93% on 2026-09-13). The Codex CLI got 99.8% on the same day. Bisecting its request
 * against ours: a stable per-conversation id in `session-id`/`thread-id`, `x-client-request-id`
 * or body `client_metadata` turns the cache on (any one of them; `x-codex-turn-metadata` alone
 * does not, nor does echoing `x-codex-turn-state` alone). The backend now keys the cache on the
 * conversation's identity, not on the cache key. We send the same set the CLI sends, derived
 * from the same seed the cache key is, so a conversation is one thing everywhere.
 */
export function conversationId(req: AnthropicRequest): string {
  return conversationKey(req).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

// The Codex backend validates every `pattern` in a tool schema with a regex engine that has no
// lookaround or backreferences; one such pattern anywhere fails the whole request with
// "Invalid schema for function 'X': '...' is not a 'regex'" (measured 2026-09-13 with the
// Claude Code Artifact tool). Those patterns are dropped; the client validates inputs itself.
//
// `\0` belongs in the same class and was missed, because the rule was written as the
// backreferences 1-9 rather than as the escapes a strict engine will not take. The Artifact tool
// declares `file_paths` items as `^[^\0]*$` — any string without a NUL — and OpenCode Go refuses
// the whole request over it: `Invalid JSON schema: {…"pattern":"^[^\\0]*$"…} is not valid under
// any of the schemas listed in the 'anyOf' keyword` (measured 2026-09-19 against
// muse-spark-1.3-contributor; the same schema with the pattern removed is accepted, and
// `\d`, `propertyNames`, nested `anyOf`, `const`, `format` and `$schema` all pass, so this escape
// is the whole of it). Two backends now, which is why the rule is the escape class, not a list.
const UNSUPPORTED_REGEX = /\(\?[=!<]|\\[0-9]/;

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

// The Responses API constrains a function name to `^[a-zA-Z0-9_-]{1,64}$`, and one name that
// breaks it fails the whole request, not just that tool. Claude Code names MCP tools
// `mcp__<server>__<tool>`, and a claude.ai connector's server name is a UUID, so the prefix alone
// eats 43 characters: names past 64 are routine, not exotic.
//
// The mangling has to be deterministic, because the same tool list is resent every turn and a name
// that moved would break the cache prefix (see the header rule). Hash of the original, not a
// counter or a salt. Names already inside the constraint are returned untouched, so a session with
// no MCP tools produces byte-identical output to before this existed.
const TOOL_NAME_OK = /^[A-Za-z0-9_-]{1,64}$/;

export function toolNameForResponses(name: string): string {
  if (TOOL_NAME_OK.test(name)) return name;
  // Sanitising alone would let `a.b` and `a-b` collapse onto the same name, so every mangled name
  // carries the hash: 55 + "_" + 8 = 64 exactly.
  const hash = crypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 55)}_${hash}`;
}

// Anthropic's server-side tools (`web_search` and friends) are run by Anthropic, not by the model
// holding them. Declaring one to a translated provider offers a tool that cannot possibly execute:
// the model calls it, nothing answers, and the turn comes back empty with no error anywhere — the
// worst failure shape there is. `compat.ts` has dropped them on the anthropic-compatible path from
// the start; the rule belongs here too, and is the same rule, not a second one.
//
// These do not arrive today. Claude Code runs its web search as a separate side request on a fixed
// small model — measured 2026-09-17: an Opus session and a DeepSeek-routed session both sent it to
// `claude-haiku-4-5`, which passes through to Anthropic and never reaches an adapter. Which model
// that is, is a server-side flag we do not own, so this guards the day it changes.
export function isServerTool(tool: AnthropicTool): boolean {
  const type = (tool as { type?: unknown }).type;
  return type !== undefined && type !== "custom";
}

/** Names of the tools this request declares that no translated provider can run. */
export function serverToolNames(tools: AnthropicTool[] | undefined): Set<string> {
  const names = new Set<string>();
  for (const t of tools ?? []) if (typeof t.name === "string" && isServerTool(t)) names.add(t.name);
  return names;
}

/**
 * Mangled name → original, for the tools declared in this request. The model echoes the name it was
 * given and Claude Code matches `tool_use.name` against its own tool list, so the response path has
 * to undo the mangling. Empty when nothing needed mangling.
 */
export function toolNameRestoreMap(req: AnthropicRequest): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of req.tools ?? []) {
    if (typeof t.name !== "string" || isServerTool(t)) continue;
    const mangled = toolNameForResponses(t.name);
    if (mangled !== t.name) map.set(mangled, t.name);
  }
  return map;
}

export function toResponsesRequest(req: AnthropicRequest, opts: TranslateOptions): ResponsesRequest {
  const parts: string[] = [];
  // Effort is named here because the model cannot see its own reasoning setting and will otherwise guess.
  // Constant per (model, effort): changing effort mid-session costs one cache miss, which is acceptable.
  if (opts.identity) parts.push(identityLine(opts.model, opts.effort));
  const sys = systemText(req.system);
  if (sys) parts.push(sys);
  if (opts.instructionsAppend) parts.push(opts.instructionsAppend);

  const input: ResponsesInputItem[] = [];
  // Claude Code sends side queries whose history starts with a bare tool_result (e.g. summarising a
  // large tool output). Anthropic tolerates the orphan; the Responses API rejects a function_call_output
  // whose call_id has no function_call in the same input ("No tool call found…", measured 2026-09-13).
  // Such results are sent as plain user text instead.
  const knownCalls = new Set<string>();
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
          knownCalls.add(tu.id);
          input.push({ type: "function_call", call_id: tu.id, name: toolNameForResponses(tu.name), arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input ?? {}) });
          break;
        }
        case "tool_result": {
          flush();
          const tr = b as { tool_use_id: string; content?: string | AnthropicBlock[]; is_error?: boolean };
          let out = toolResultText(tr.content);
          const images = toolResultImages(tr.content);
          if (tr.is_error && !out) out = "Tool execution failed";
          if (!out && images.length > 0) out = "Tool returned image content.";
          if (knownCalls.has(tr.tool_use_id)) input.push({ type: "function_call_output", call_id: tr.tool_use_id, output: out });
          else pending.push({ type: "input_text", text: `[Tool result]\n${out}` });
          for (const image_url of images) pending.push({ type: "input_image", image_url });
          break;
        }
        default:
          // thinking / redacted_thinking / unknown: dropped on purpose (see header comment)
          break;
      }
    }
    flush();
  }

  const dropped = serverToolNames(req.tools);
  const tools = (req.tools ?? [])
    .filter((t) => typeof t.name === "string" && !dropped.has(t.name))
    .map((t) => ({ type: "function" as const, name: toolNameForResponses(t.name), description: t.description ?? "", parameters: normalizeSchema(t.input_schema), strict: false as const }));

  let tool_choice: ResponsesRequest["tool_choice"];
  const tc = req.tool_choice;
  if (tools.length > 0) {
    if (!tc || tc.type === "auto") tool_choice = "auto";
    else if (tc.type === "any") tool_choice = "required";
    else if (tc.type === "none") tool_choice = "none";
    // A choice that named a dropped tool would force the model onto something no longer declared.
    else if (tc.type === "tool" && tc.name && !dropped.has(tc.name)) tool_choice = { type: "function", name: toolNameForResponses(tc.name) };
  }

  const out: ResponsesRequest = {
    model: opts.model,
    instructions: parts.join("\n\n"),
    input,
    reasoning: { effort: opts.effort, summary: "auto" },
    text: { verbosity: "medium" },
    store: false,
    stream: true,
    prompt_cache_key: conversationId(req),
    client_metadata: { session_id: conversationId(req), thread_id: conversationId(req), turn_id: crypto.randomUUID(), "x-codex-window-id": `${conversationId(req)}:0` },
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

  /** Input-token figure announced in message_start (the real one only arrives with response.completed). */
  private readonly startInput: number;

  /** Mangled tool name → the name Claude Code knows, from `toolNameRestoreMap`. */
  private readonly toolNames: ReadonlyMap<string, string>;

  constructor(model: string, startInput = 0, toolNames: ReadonlyMap<string, string> = new Map()) {
    this.model = model;
    this.startInput = startInput;
    this.toolNames = toolNames;
    this.messageId = `msg_${crypto.randomBytes(12).toString("hex")}`;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** The error `fail` reported, so a non-streaming caller can answer with it instead of a 200. */
  failure: { type: string; message: string } | undefined;

  start(): AnthropicEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          // Claude Code snapshots `message.usage` per streamed content block, before message_delta
          // (measured 2026-09-13: with zeros here the app showed "1 token" for a 118k-token subagent and
          // the CLI's context accounting saw an empty context). Announce an estimate; the true figures
          // follow in message_delta and the SDK merges them into the final message.
          message: { id: this.messageId, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: this.startInput, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
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
          // The model echoes the mangled name; Claude Code only recognises the original.
          const called = item.name ?? "tool";
          const name = this.toolNames.get(called) ?? called;
          this.content.push({ type: "tool_use", id, name, input: {}, _args: "" });
          out.push(...this.openBlock("tool", { type: "tool_use", id, name, input: {} }, item.id));
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
    this.failure = { type, message };
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
