// OpenAI-compatible adapter: Anthropic Messages in, vendor Chat Completions or
// Responses SSE out, translated back to Anthropic Messages. It never synthesizes
// cache figures; the request log reflects cached tokens only when the vendor sends them.

import http from "node:http";
import type { OpenAiCompatibleProvider } from "../../config.ts";
import type { Logger } from "../../log.ts";
import type { RequestUsage } from "../../requestlog.ts";
import { credentialHeaderValues, redactErrorText } from "../../redact.ts";
import { SseParser } from "../chatgpt/sse.ts";
import { estimateTokens, formatSse, OpenAiStreamMapper, toOpenAiRequest } from "./translate.ts";
import { serverToolNames, toolNameRestoreMap } from "../chatgpt/translate.ts";
import type { AnthropicRequest } from "../chatgpt/translate.ts";

const PING_MS = 15_000;

export type OpenAiOutcome = { status: number; bytes: number; note?: string; usage?: RequestUsage; stopReason?: string };

function anthropicError(status: number, type: string, message: string): { status: number; body: string } {
  return { status, body: JSON.stringify({ type: "error", error: { type, message } }) };
}

function vendorMessage(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown; detail?: unknown };
    const candidate = json.error?.message ?? json.message ?? json.detail;
    if (typeof candidate === "string") return candidate.slice(0, 500);
  } catch { /* retain the response text */ }
  return text.replace(/\s+/g, " ").trim().slice(0, 500) || "upstream request failed";
}

export function mapHttpError(status: number, text: string): { status: number; body: string } {
  const message = `OpenAI-compatible provider: ${vendorMessage(text)}`;
  if (status === 401 || status === 403) return anthropicError(401, "authentication_error", message);
  if (status === 429) return anthropicError(429, "rate_limit_error", message);
  if (status >= 500) return anthropicError(529, "api_error", message);
  return anthropicError(400, "invalid_request_error", message);
}

function endpoint(base: string, wire: "chat" | "responses"): string {
  return `${base.replace(/\/+$/, "")}/${wire === "chat" ? "chat/completions" : "responses"}`;
}

function write(res: http.ServerResponse, value: string): number {
  if (res.writableEnded || res.destroyed) return 0;
  res.write(value);
  return Buffer.byteLength(value);
}

export class OpenAiCompatibleAdapter {
  readonly name: string;
  private readonly cfg: OpenAiCompatibleProvider;
  private readonly log: Logger;
  private readonly lastInputByKey = new Map<string, number>();

  constructor(name: string, cfg: OpenAiCompatibleProvider, log: Logger) {
    this.name = name;
    this.cfg = cfg;
    this.log = log;
  }

  private rememberInput(key: string, usage: { input_tokens: number; cache_read_input_tokens: number }): void {
    const total = usage.input_tokens + usage.cache_read_input_tokens;
    if (total <= 0) return;
    this.lastInputByKey.set(key, total);
    if (this.lastInputByKey.size > 500) this.lastInputByKey.delete(this.lastInputByKey.keys().next().value!);
  }

  /** Handle a fully-read Messages request. Model/effort have already been resolved by routing. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, path: string, json: AnthropicRequest, model: string, effort: string | undefined): Promise<OpenAiOutcome> {
    if (path.startsWith("/v1/messages/count_tokens")) {
      const body = JSON.stringify({ input_tokens: estimateTokens(json) });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }).end(body);
      return { status: 200, bytes: Buffer.byteLength(body), note: "estimated" };
    }

    const wire = this.cfg.wire ?? "chat";
    const modelEffortLevels = this.cfg.models?.find((entry) => entry.id === model)?.effortLevels;
    const caps = this.cfg.caps && modelEffortLevels === undefined
      ? this.cfg.caps
      : {
          ...(this.cfg.caps ?? {}),
          reasoning: modelEffortLevels && modelEffortLevels.length > 0 ? "effort" as const : "none" as const,
          effortLevels: modelEffortLevels ?? this.cfg.caps?.effortLevels ?? [],
        };
    // Dropping a tool the model was meant to have is worth a line: the alternative to this drop is
    // an empty answer with nothing logged anywhere.
    const serverTools = serverToolNames(json.tools);
    if (serverTools.size > 0) this.log.warn(`openai ${this.name}: dropped server tools for ${model}: ${[...serverTools].join(", ")} (Anthropic runs these; this provider cannot)`);

    const upstreamRequest = toOpenAiRequest(json, {
      model,
      wire,
      ...(effort ? { effort } : {}),
      caps,
      ...(this.cfg.identity === undefined ? {} : { identity: this.cfg.identity }),
      ...(this.cfg.instructionsAppend ? { instructionsAppend: this.cfg.instructionsAppend } : {}),
    });
    const requestBody = JSON.stringify(upstreamRequest);
    const upstreamHeaders = { "content-type": "application/json", accept: "text/event-stream", ...(this.cfg.headers ?? {}) };
    const upstreamSecrets = credentialHeaderValues(Object.entries(upstreamHeaders));
    // Same input floor behavior as the ChatGPT adapter: the CLI snapshots message_start before usage arrives.
    const key = JSON.stringify({ model, wire, system: json.system ?? "", user: json.messages.find((message) => message.role === "user")?.content ?? "" });
    const startInput = Math.max(estimateTokens(json), this.lastInputByKey.get(key) ?? 0);
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    res.on("close", onClose);

    let upstream: Response;
    try {
      upstream = await fetch(endpoint(this.cfg.url, wire), {
        method: "POST",
        headers: upstreamHeaders,
        body: requestBody,
        signal: controller.signal,
      });
    } catch (error) {
      res.off("close", onClose);
      if (controller.signal.aborted) return { status: 0, bytes: 0, note: "client closed" };
      const out = anthropicError(502, "api_error", `OpenAI-compatible provider unreachable: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(out.status, { "content-type": "application/json" }).end(out.body);
      throw error;
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      const safeText = redactErrorText(text, upstreamSecrets);
      const out = mapHttpError(upstream.status, safeText);
      this.log.warn(`openai ${this.name}: upstream ${upstream.status} for ${model}: ${safeText.slice(0, 400)}`);
      res.off("close", onClose);
      res.writeHead(out.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(out.body)) }).end(out.body);
      return { status: out.status, bytes: Buffer.byteLength(out.body), note: `upstream ${upstream.status}` };
    }

    const wantStream = json.stream === true;
    const mapper = new OpenAiStreamMapper(model, startInput, toolNameRestoreMap(json));
    const parser = new SseParser();
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let ping: NodeJS.Timeout | undefined;

    if (wantStream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const event of mapper.start()) bytes += write(res, formatSse(event));
      ping = setInterval(() => {
        if (!res.writableEnded) bytes += write(res, formatSse({ event: "ping", data: { type: "ping" } }));
      }, PING_MS);
    }

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          const output = mapper.feed(event, wire);
          this.rememberInput(key, mapper.usage);
          if (wantStream) for (const anthropic of output) bytes += write(res, formatSse(anthropic));
          if (mapper.isFinished) break;
        }
        if (mapper.isFinished) break;
      }
      if (!mapper.isFinished) {
        const tail = mapper.finish();
        if (wantStream) for (const event of tail) bytes += write(res, formatSse(event));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const tail = mapper.fail(`stream interrupted: ${(error as Error).message}`);
        if (wantStream) for (const event of tail) bytes += write(res, formatSse(event));
      }
    } finally {
      if (ping) clearInterval(ping);
      res.off("close", onClose);
      try { await reader.cancel(); } catch { /* already closed */ }
    }

    if (!wantStream) {
      const body = JSON.stringify(mapper.message());
      bytes = Buffer.byteLength(body);
      res.writeHead(200, { "content-type": "application/json", "content-length": String(bytes) }).end(body);
    } else if (!res.writableEnded) {
      res.end();
    }
    const usage = mapper.usage;
    return {
      status: 200,
      bytes,
      note: `in=${usage.input_tokens} cached=${usage.cache_read_input_tokens} out=${usage.output_tokens} stop=${mapper.stopReason}`,
      usage: { input: usage.input_tokens, cached: usage.cache_read_input_tokens, output: usage.output_tokens },
      stopReason: mapper.stopReason,
    };
  }
}
