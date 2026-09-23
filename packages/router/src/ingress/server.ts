// Local OpenAI-compatible ingress for Codex CLI and other OpenAI clients.
// Binds loopback only. Client Authorization is accepted only as a local-presence check and is
// intentionally never copied to the Anthropic-compatible upstream.

import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Config, AnthropicCompatibleProvider, AnthropicProvider } from "../config.ts";
import { providerFor } from "../config.ts";
import type { Logger } from "../log.ts";
import { resolve } from "../routing.ts";
import { PRESETS } from "../presets.ts";
import { resolveCompatibleCaps, sanitizeForCompatible } from "../compat.ts";
import { SseParser } from "../providers/chatgpt/sse.ts";
import { ingressModels } from "./models.ts";
import { requestId, type RequestLog, type RequestRecord, type RequestUsage } from "../requestlog.ts";
import { credentialHeaderValues, redactErrorText } from "../redact.ts";
import { CLAUDE_CODE_IDENTITY, fromClaudeCodeToolName, nativeAnthropicHeaders, toClaudeCodeToolName } from "../providers/anthropic.ts";
import { ClaudeAccountAuthPool } from "../providers/anthropic-account-pool.ts";
import { ObservedClaudeCodeAuth } from "../providers/anthropic-observed.ts";
import type { ChatGptAdapter } from "../providers/chatgpt/index.ts";
import {
  ResponsesEventMapper,
  chatToAnthropic,
  formatDataSse,
  formatSse,
  responsesEventsToChatChunks,
  responsesToAnthropic,
  responsesToChatCompletion,
  type Json,
} from "./translate.ts";

const MAX_BODY = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "content-length", "authorization"]);

type IngressDeps = {
  config: () => Config;
  log: Logger;
  requests: RequestLog;
  /** Shared process-memory OAuth observation; never persisted or exposed by ingress. */
  observedClaudeCodeAuth?: ObservedClaudeCodeAuth;
  home?: string;
  /** Test seams; production uses the local account projection and api.anthropic.com. */
  claudeAccounts?: ClaudeAccountAuthPool;
  nativeUpstream?: string;
  /**
   * The ChatGPT accounts Codex's own GPT traffic goes out on: the chatgpt provider `name` names,
   * or the first one configured (null name), or — with none configured — Codex's own login alone.
   */
  chatgpt?: (name: string | null) => ChatGptAdapter;
};

/** A model Codex means for OpenAI: in the chatgpt provider's list, or named the way OpenAI names them. */
export function isChatGptModel(model: string, cfg: Config): boolean {
  if (/^(gpt-|codex-|chatgpt-|o\d)/i.test(model)) return true;
  return Object.values(cfg.providers).some((p) => p.type === "chatgpt" && (p.models ?? []).some((m) => m.id === model));
}

/** The conversation a Codex request belongs to, as Codex names it: its session header, else the cache key. */
function codexConversation(req: http.IncomingMessage, body: Json | null): string | undefined {
  const header = req.headers.session_id ?? req.headers["session-id"] ?? req.headers["thread-id"];
  if (typeof header === "string" && header) return header;
  return body && typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined;
}

export type IngressStats = {
  inFlight: number;
  messagesInFlight: number;
  started: number;
  completed: number;
  failed: number;
};

type Outcome = { status: number; bytes: number; usage?: RequestUsage; stopReason?: string; note?: string };

function openAiError(message: string, type = "invalid_request_error", code: string | null = null): Json {
  return { error: { message, type, param: null, code } };
}

function sendJson(res: http.ServerResponse, status: number, body: Json): number {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(text)) });
  res.end(text);
  return Buffer.byteLength(text);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveP(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function contentType(headers: Headers): string | undefined {
  const value = headers.get("content-type");
  return value ?? undefined;
}

function httpStatusError(status: number, body: string): { status: number; error: Json } {
  let message = body.replace(/\s+/g, " ").slice(0, 500) || `Anthropic-compatible provider returned HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
    else if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Preserve the compact text fallback.
  }
  const mapped = status === 401 || status === 403 ? 401 : status === 429 ? 429 : status >= 500 ? 502 : 400;
  const type = mapped === 401 ? "authentication_error" : mapped === 429 ? "rate_limit_error" : mapped === 502 ? "api_error" : "invalid_request_error";
  return { status: mapped, error: openAiError(message, type) };
}

function usage(mapper: ResponsesEventMapper): RequestUsage {
  return { input: mapper.usage.input_tokens - mapper.usage.input_tokens_details.cached_tokens, cached: mapper.usage.input_tokens_details.cached_tokens, output: mapper.usage.output_tokens };
}

function anthropicJsonEvents(value: Json): Json[] {
  const out: Json[] = [{ type: "message_start", message: { usage: value.usage ?? {} } }];
  const content = Array.isArray(value.content) ? value.content : [];
  for (let index = 0; index < content.length; index++) {
    const raw = content[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const block = raw as Json;
    out.push({ type: "content_block_start", index, content_block: block });
    if (block.type === "text" && typeof block.text === "string") out.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    if (block.type === "tool_use") out.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    out.push({ type: "content_block_stop", index });
  }
  out.push({ type: "message_delta", delta: { stop_reason: value.stop_reason ?? "end_turn" }, usage: value.usage ?? {} });
  out.push({ type: "message_stop" });
  return out;
}

export function openaiPort(cfg: Config): number {
  return cfg.listen.openaiPort ?? cfg.listen.port + 2;
}

export class OpenAiIngress {
  readonly stats: IngressStats = { inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 };
  private readonly server: http.Server;
  private readonly agents = new Map<string, http.Agent | https.Agent>();
  private readonly sockets = new Set<Socket>();
  private readonly claudeAccounts: ClaudeAccountAuthPool;
  private readonly deps: IngressDeps;
  private draining = false;

  constructor(deps: IngressDeps) {
    this.deps = deps;
    this.claudeAccounts = deps.claudeAccounts ?? new ClaudeAccountAuthPool({
      home: deps.home ?? (process.env.CLAUDERIPPLE_HOME?.trim() || path.join(os.homedir(), ".clauderipple")),
      ...(deps.observedClaudeCodeAuth ? { observed: deps.observedClaudeCodeAuth } : {}),
      log: deps.log,
    });
    this.server = http.createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => void this.handle(req, res));
    this.server.keepAliveTimeout = 65_000;
    // Codex tries a WebSocket for Responses first when its OpenAI provider points here. Answering
    // 426 is what makes it fall back to SSE over HTTP; an unanswered upgrade leaves it hanging.
    this.server.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n"));
  }

  listen(): Promise<number> {
    const cfg = this.deps.config();
    const port = openaiPort(cfg);
    return new Promise((resolveP, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        resolveP(address && typeof address === "object" ? address.port : port);
      });
    });
  }

  /** Stop new connections, reject new model work on keep-alive sockets, then close after model calls drain. */
  async drain(maxMs: number, onProgress?: (n: number) => void): Promise<void> {
    this.draining = true;
    this.server.close();
    const start = Date.now();
    while (this.stats.messagesInFlight > 0 && Date.now() - start < maxMs) {
      onProgress?.(this.stats.messagesInFlight);
      await new Promise((resolveP) => setTimeout(resolveP, 250));
    }
    for (const socket of this.sockets) socket.destroy();
  }

  private agentFor(key: string, protocol: "http:" | "https:"): http.Agent | https.Agent {
    const existing = this.agents.get(key);
    if (existing) return existing;
    const agent = protocol === "https:" ? new https.Agent({ keepAlive: true, maxSockets: 64 }) : new http.Agent({ keepAlive: true, maxSockets: 64 });
    this.agents.set(key, agent);
    return agent;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const method = req.method ?? "GET";
    const isCall = method === "POST" && (path === "/v1/responses" || path === "/v1/responses/compact" || path === "/v1/chat/completions");
    this.stats.started++;
    this.stats.inFlight++;
    if (isCall) this.stats.messagesInFlight++;
    const started = Date.now();
    let record: Omit<RequestRecord, "id" | "at" | "ms" | "status" | "ok" | "usage" | "stopReason" | "note"> = { kind: "messages", source: "-", target: "-", provider: "-", stream: false };
    let completed = false;
    const finish = (status: number, bytes: number, extra: Omit<Outcome, "status" | "bytes"> = {}): void => {
      if (completed) return;
      completed = true;
      this.stats.inFlight--;
      if (isCall) this.stats.messagesInFlight--;
      if (status >= 200 && status < 400) this.stats.completed++;
      else this.stats.failed++;
      const ms = Date.now() - started;
      const tagged = `${method} ${path} -> ${status} ${bytes}B ${(ms / 1000).toFixed(1)}s${extra.note ? ` ${extra.note}` : ""}`;
      this.deps.log.info(`OPENAI ${tagged}`);
      if (isCall) {
        const entry: RequestRecord = { ...record, id: requestId(), at: new Date(started).toISOString(), ms, status, ok: status >= 200 && status < 400 };
        if (extra.usage) entry.usage = extra.usage;
        if (extra.stopReason) entry.stopReason = extra.stopReason;
        if (extra.note) entry.note = extra.note;
        this.deps.requests.add(entry);
      }
    };
    // Codex closes the socket the moment it reads `response.completed`, often before Anthropic's
    // stream has ended on our side; that is a finished request, not an abort.
    let terminal: Outcome | null = null;
    res.once("close", () => {
      if (completed || res.writableEnded) return;
      if (terminal) finish(terminal.status, terminal.bytes, { ...(terminal.usage ? { usage: terminal.usage } : {}), ...(terminal.stopReason ? { stopReason: terminal.stopReason } : {}), note: `${terminal.note ?? ""}; client closed after completion`.replace(/^; /, "") });
      else finish(499, 0, { note: "client closed" });
    });

    try {
      const query = (req.url ?? "").includes("?") ? (req.url ?? "").slice((req.url ?? "").indexOf("?")) : "";
      // Codex signed in to ChatGPT refreshes its model catalogue with `?client_version=`: that is the
      // backend's list, so it comes from the backend, on one of the accounts.
      if (path === "/v1/models" && method === "GET" && /[?&]client_version=/.test(query) && this.deps.chatgpt) {
        req.resume();
        const outcome = await this.deps.chatgpt(null).passthrough(req, res, `/models${query}`, undefined, undefined);
        finish(outcome.status, outcome.bytes, { note: "codex models passthrough" });
        return;
      }
      if (path === "/v1/models" && method === "GET") {
        const data: Json[] = ingressModels(this.deps.config()).map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.provider }));
        const bytes = sendJson(res, 200, { object: "list", data });
        finish(200, bytes);
        return;
      }
      if (!isCall) {
        const bytes = sendJson(res, 404, openAiError("not found", "invalid_request_error"));
        finish(404, bytes);
        return;
      }
      if (this.draining) {
        req.resume();
        const bytes = sendJson(res, 503, openAiError("ClaudeRipple is restarting; retry", "server_error"));
        finish(503, bytes, { note: "refused during drain" });
        return;
      }
      // Loopback-only listener: a client may omit Authorization (the Codex desktop app has no shell
      // env to carry a placeholder key). When present it must at least look like a bearer token.
      const authorization = req.headers.authorization;
      if (authorization !== undefined && (typeof authorization !== "string" || !/^Bearer\s+\S+$/i.test(authorization))) {
        const bytes = sendJson(res, 401, openAiError("Malformed Authorization header; use Bearer <token> or omit it", "authentication_error"));
        finish(401, bytes);
        return;
      }
      let body: Json;
      let raw: Buffer;
      try {
        raw = await readBody(req);
        body = JSON.parse(raw.toString("utf8")) as Json;
      } catch (error) {
        const bytes = sendJson(res, 400, openAiError(`Invalid JSON request: ${(error as Error).message}`));
        finish(400, bytes);
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        const bytes = sendJson(res, 400, openAiError("Request body must be a JSON object"));
        finish(400, bytes);
        return;
      }
      if (path === "/v1/responses" && body.previous_response_id != null) {
        const bytes = sendJson(res, 400, openAiError("previous_response_id unsupported; ClaudeRipple OpenAI ingress is stateless", "invalid_request_error", "previous_response_id_unsupported"));
        finish(400, bytes);
        return;
      }
      const requested = typeof body.model === "string" ? body.model : "";
      const cfg = this.deps.config();
      const explicit = resolve(requested, {}, cfg);
      const explicitProvider = explicit ? cfg.providers[explicit.provider] : undefined;
      // Codex's own GPT traffic (its OpenAI provider pointed here): passed through to the ChatGPT
      // backend on one of the signed-in accounts. A GPT model routed elsewhere on purpose is not.
      const toChatGpt = path.startsWith("/v1/responses") && this.deps.chatgpt
        && (explicitProvider ? explicitProvider.type === "chatgpt" : isChatGptModel(requested, cfg));
      if (toChatGpt) {
        const adapter = this.deps.chatgpt!(explicitProvider ? explicit!.provider : null);
        const renamed = explicit && explicit.model !== requested;
        const payload = renamed ? Buffer.from(JSON.stringify({ ...body, model: explicit.model })) : raw;
        record = { kind: "messages", source: requested, target: explicit?.model ?? requested, provider: adapter.name, stream: body.stream === true };
        const outcome = await adapter.passthrough(req, res, path.slice("/v1".length), payload, codexConversation(req, body));
        finish(outcome.status, outcome.bytes, { ...(outcome.usage ? { usage: outcome.usage } : {}), ...(outcome.note ? { note: outcome.note } : {}) });
        return;
      }
      if (path === "/v1/responses/compact") {
        const bytes = sendJson(res, 400, openAiError("Remote compaction is only available for ChatGPT models", "invalid_request_error", "unsupported_endpoint"));
        finish(400, bytes);
        return;
      }
      // Unmapped models default to the native `anthropic` provider when one is configured, so a
      // Codex user can name any Claude model directly (`-m claude-sonnet-5`) without a mapping.
      const fallback = Object.entries(cfg.providers).find(([, p]) => p.type === "anthropic");
      const route = explicit ?? (fallback && requested ? { provider: fallback[0], model: requested, effort: undefined, tag: `${requested}->${requested}` } : null);
      if (!route) {
        const bytes = sendJson(res, 400, openAiError(`No ClaudeRipple route for model ${requested || "(missing)"}`, "invalid_request_error", "model_not_found"));
        finish(400, bytes);
        return;
      }
      const configured = cfg.providers[route.provider];
      if (!configured) {
        const bytes = sendJson(res, 500, openAiError(`Configured provider ${route.provider} is missing`, "server_error"));
        finish(500, bytes);
        return;
      }
      // A model that speaks Anthropic Messages is servable here even when the rest of its provider
      // is an OpenAI wire, which the refusal below would otherwise turn away on the provider's type
      // alone. One subscription is one provider, so the model decides.
      const provider = providerFor(configured, route.model);
      if (provider.type === "chatgpt" || provider.type === "openai-compatible") {
        const bytes = sendJson(res, 400, openAiError(`${provider.type === "chatgpt" ? "ChatGPT" : "OpenAI-compatible"} provider is not available through OpenAI ingress`, "invalid_request_error", "unsupported_provider"));
        finish(400, bytes, { note: `model ${requested} -> ${provider.type} provider unsupported` });
        return;
      }
      const native = provider.type === "anthropic";
      const prefix = native && provider.auth === "claude-code" ? CLAUDE_CODE_IDENTITY : undefined;
      const anthropic = path === "/v1/responses" ? responsesToAnthropic(body, route.model, prefix) : chatToAnthropic(body, route.model, prefix);
      const wire = native ? anthropic as unknown as Json : sanitizeForCompatible(anthropic as unknown as Json, resolveCompatibleCaps(
        provider.preset ? (() => { const preset = PRESETS.find((entry) => entry.id === provider.preset); return preset ? { effortLevels: preset.effortLevels, thinking: preset.thinking } : undefined; })() : undefined,
        provider.caps,
      )).json;
      if (native && provider.auth === "claude-code" && Array.isArray(wire.tools)) {
        wire.tools = wire.tools.map((raw) => {
          const tool = raw as Json;
          return typeof tool.name === "string" ? { ...tool, name: toClaudeCodeToolName(tool.name) } : tool;
        });
        const choice = wire.tool_choice as Json | undefined;
        if (choice?.type === "tool" && typeof choice.name === "string") wire.tool_choice = { ...choice, name: toClaudeCodeToolName(choice.name) };
      }
      const stream = body.stream === true;
      wire.stream = stream;
      record = { kind: "messages", source: requested, target: route.model, provider: route.provider, ...(route.effort ? { effort: route.effort } : {}), stream };
      const kindNote = `openai-ingress ${path === "/v1/responses" ? "responses" : "chat"}`;
      const outcome = await this.forward(res, provider, wire, route.model, path === "/v1/chat/completions", stream, (done) => { terminal = { ...done, note: kindNote }; });
      finish(outcome.status, outcome.bytes, { ...(outcome.usage ? { usage: outcome.usage } : {}), ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}), note: `${kindNote}${outcome.note ? `; ${outcome.note}` : ""}` });
    } catch (error) {
      if (completed) return; // already recorded (e.g. client closed after the terminal event)
      this.deps.log.warn(`OPENAI ingress error: ${(error as Error).message}`);
      if (!res.headersSent) {
        const bytes = sendJson(res, 502, openAiError(`Anthropic-compatible upstream unreachable: ${(error as Error).message}`, "api_error"));
        finish(502, bytes);
      } else {
        res.destroy();
        finish(502, 0, { note: "response interrupted" });
      }
    }
  }

  private async forward(res: http.ServerResponse, provider: AnthropicCompatibleProvider | AnthropicProvider, wire: Json, model: string, chat: boolean, stream: boolean, onTerminal?: (outcome: Outcome) => void): Promise<Outcome> {
    const native = provider.type === "anthropic";
    const upstream = new URL(native ? (this.deps.nativeUpstream ?? "https://api.anthropic.com") : provider.url);
    const protocol = upstream.protocol === "https:" ? "https:" : "http:";
    const body = Buffer.from(JSON.stringify(wire));
    let authentication: Record<string, string>;
    if (native && provider.auth === "claude-code") {
      // Codex ingress deliberately uses one credential per request and does not fail over. The shared
      // projection preserves source precedence and keeps ClaudeRipple's added accounts as the fallback
      // that the old single OAuth file provided before multi-account storage.
      const credential = (await this.claudeAccounts.credentials())[0];
      if (!credential) return { status: 401, bytes: sendJson(res, 401, openAiError("Claude login unavailable — connect a Claude subscription", "authentication_error")), note: "Claude OAuth unavailable" };
      authentication = credential.headers;
    } else if (native) {
      try {
        authentication = nativeAnthropicHeaders(provider);
      } catch (error) {
        return { status: 401, bytes: sendJson(res, 401, openAiError((error as Error).message, "authentication_error")), note: "Anthropic API key unavailable" };
      }
    } else authentication = provider.headers ?? {};
    const headers: Record<string, string> = { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", "content-length": String(body.length), ...authentication };
    const lib = protocol === "https:" ? https : http;
    const response = await new Promise<http.IncomingMessage>((resolveP, reject) => {
      const request = lib.request({ protocol, hostname: upstream.hostname, port: Number(upstream.port) || (protocol === "https:" ? 443 : 80), method: "POST", path: `${upstream.pathname.replace(/\/+$/, "")}/v1/messages`, headers, agent: this.agentFor(upstream.origin, protocol), ...(protocol === "https:" ? { servername: upstream.hostname } : {}) }, resolveP);
      request.once("error", reject);
      res.once("close", () => request.destroy());
      request.end(body);
    });
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      const text = await new Promise<string>((resolveP) => {
        let output = "";
        response.on("data", (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(0, 1024); });
        response.on("end", () => resolveP(output));
        response.on("error", () => resolveP(output));
      });
      const safeText = redactErrorText(text, credentialHeaderValues(Object.entries(headers)));
      this.deps.log.warn(`OPENAI ingress upstream ${response.statusCode ?? 0} (${model}): ${safeText.slice(0, 400)}`);
      const mapped = httpStatusError(response.statusCode ?? 502, safeText);
      return { status: mapped.status, bytes: sendJson(res, mapped.status, mapped.error), note: `upstream ${response.statusCode ?? 0}` };
    }
    const mapper = new ResponsesEventMapper(model, native && provider.auth === "claude-code" ? fromClaudeCodeToolName : undefined);
    let bytes = 0;
    const writeResponses = (events: Json[]): void => {
      for (const event of events) bytes += Buffer.byteLength(formatSse(event)), res.write(formatSse(event));
    };
    const writeChat = (events: Json[]): void => {
      for (const chunk of responsesEventsToChatChunks(events, mapper)) bytes += Buffer.byteLength(formatDataSse(chunk)), res.write(formatDataSse(chunk));
    };
    const write = chat ? writeChat : writeResponses;
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (!chat) write(mapper.start());
    }
    if (/^text\/event-stream\b/i.test(contentType(new Headers(response.headers as Record<string, string>)) ?? "")) {
      const parser = new SseParser();
      const decoder = new TextDecoder();
      await new Promise<void>((resolveP, reject) => {
        response.on("data", (chunk: Buffer) => {
          for (const event of parser.feed(decoder.decode(chunk, { stream: true }))) {
            const mapped = mapper.feed(event);
            if (stream) write(mapped);
            if (stream && mapped.some((e) => e.type === "response.completed")) {
              if (chat) { bytes += Buffer.byteLength("data: [DONE]\n\n"); res.write("data: [DONE]\n\n"); }
              onTerminal?.({ status: 200, bytes, usage: usage(mapper), stopReason: mapper.output.some((item) => item.type === "function_call") ? "tool_use" : "end_turn" });
            }
          }
        });
        response.on("end", resolveP);
        response.on("error", reject);
      });
    } else {
      const raw = await new Promise<Buffer>((resolveP, reject) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolveP(Buffer.concat(chunks)));
        response.on("error", reject);
      });
      const parsed = JSON.parse(raw.toString("utf8")) as Json;
      const mapped = anthropicJsonEvents(parsed).flatMap((event) => mapper.feed(event));
      if (stream) write(mapped);
    }
    const tail = mapper.finish();
    if (stream) {
      write(tail);
      if (chat && tail.length) {
        bytes += Buffer.byteLength("data: [DONE]\n\n");
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } else {
      const result = chat ? responsesToChatCompletion(mapper) : mapper.response("completed");
      bytes = sendJson(res, 200, result);
    }
    return { status: 200, bytes, usage: usage(mapper), stopReason: mapper.output.some((item) => item.type === "function_call") ? "tool_use" : "end_turn" };
  }
}
