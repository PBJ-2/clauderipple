import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_CARRY = 64 * 1024;

export type RequestUsage = {
  input: number;
  cached: number;
  cacheWrite?: number;
  output: number;
};

export type RequestRecord = {
  id: string;
  at: string;
  ms: number;
  status: number | string;
  ok: boolean;
  kind: "messages" | "count_tokens" | "other";
  source: string;
  target: string;
  provider: string;
  effort?: string;
  stopReason?: string;
  usage?: RequestUsage;
  note?: string;
  stream: boolean;
};

type RequestFilter = { provider?: string; kind?: RequestRecord["kind"] };
type SummaryBucket = {
  count: number;
  ok: number;
  failed: number;
  input: number;
  cached: number;
  output: number;
  cacheHitPercent: number;
  avgMs: number;
};

export type RequestSummary = { total: SummaryBucket; providers: Record<string, SummaryBucket> };

function emptyBucket(): SummaryBucket {
  return { count: 0, ok: 0, failed: 0, input: 0, cached: 0, output: 0, cacheHitPercent: 0, avgMs: 0 };
}

function isRecord(value: unknown): value is RequestRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<RequestRecord>;
  return typeof r.id === "string" && typeof r.at === "string" && typeof r.ms === "number" && typeof r.ok === "boolean" &&
    (r.kind === "messages" || r.kind === "count_tokens" || r.kind === "other") && typeof r.source === "string" &&
    typeof r.target === "string" && typeof r.provider === "string" && typeof r.stream === "boolean";
}

/** Bounded request history, persisted as JSONL so a router restart preserves recent entries. */
export class RequestLog {
  private readonly file: string;
  private readonly max: number;
  private readonly maxBytes: number;
  private records: RequestRecord[];

  constructor(file: string, max = 2000, maxBytes = DEFAULT_MAX_BYTES) {
    this.file = file;
    this.max = max;
    this.maxBytes = maxBytes;
    this.records = this.load();
  }

  add(record: RequestRecord): void {
    this.records.push(record);
    if (this.records.length > this.max) this.records.splice(0, this.records.length - this.max);
    const line = JSON.stringify(record) + "\n";
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const bytes = Buffer.byteLength(line);
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (size > 0 && size + bytes > this.maxBytes) {
        const previous = `${this.file}.1`;
        fs.rmSync(previous, { force: true });
        fs.renameSync(this.file, previous);
      }
      fs.appendFileSync(this.file, line, "utf8");
    } catch {
      // Request logging must never alter the proxy response path.
    }
  }

  list(n: number, filter: RequestFilter = {}): RequestRecord[] {
    const limit = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    const out: RequestRecord[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < limit; i--) {
      const record = this.records[i]!;
      if (filter.provider && record.provider !== filter.provider) continue;
      if (filter.kind && record.kind !== filter.kind) continue;
      out.push(record);
    }
    return out;
  }

  /** Summarise records at or after an epoch timestamp in milliseconds. */
  summary(sinceMs: number): RequestSummary {
    const total = emptyBucket();
    const providers: Record<string, SummaryBucket> = {};
    const cacheBases = new Map<SummaryBucket, number>();
    const add = (bucket: SummaryBucket, record: RequestRecord): void => {
      bucket.count++;
      if (record.ok) bucket.ok++;
      else bucket.failed++;
      bucket.avgMs += record.ms;
      if (record.usage) {
        bucket.input += record.usage.input;
        bucket.cached += record.usage.cached;
        bucket.output += record.usage.output;
        cacheBases.set(bucket, (cacheBases.get(bucket) ?? 0) + record.usage.input + record.usage.cached);
      }
    };
    for (const record of this.records) {
      const at = Date.parse(record.at);
      if (!Number.isFinite(at) || at < sinceMs) continue;
      const provider = providers[record.provider] ?? (providers[record.provider] = emptyBucket());
      add(total, record);
      add(provider, record);
    }
    for (const bucket of [total, ...Object.values(providers)]) {
      if (bucket.count > 0) bucket.avgMs = Math.round(bucket.avgMs / bucket.count);
      const base = cacheBases.get(bucket) ?? 0;
      bucket.cacheHitPercent = base > 0 ? Math.round((bucket.cached / base) * 1000) / 10 : 0;
    }
    return { total, providers };
  }

  private load(): RequestRecord[] {
    try {
      if (!fs.existsSync(this.file)) return [];
      const records = fs.readFileSync(this.file, "utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            const parsed: unknown = JSON.parse(line);
            return isRecord(parsed) ? [parsed] : [];
          } catch {
            return [];
          }
        });
      return records.slice(-this.max);
    } catch {
      return [];
    }
  }
}

export type ObservedResponse = { usage?: RequestUsage; stopReason?: string };

/**
 * Observes an Anthropic-compatible response without retaining or modifying its bytes.
 * Call feed() after forwarding each response chunk, then finish() on response end.
 */
export class ResponseUsageTap {
  private readonly isSse: boolean;
  private readonly decoder = new TextDecoder();
  private carry = "";
  private event = "";
  private data: string[] = [];
  private dropUntilNewline = false;
  private jsonUsageStarted = false;
  private jsonUsageDepth = 0;
  private jsonUsageText = "";
  private stopCarry = "";
  private stopReason: string | undefined;
  private usage: RequestUsage | undefined;

  // Compressed responses (Anthropic answers the CLI with gzip/br) are collected side-band up to a cap
  // and inflated once at the end; the forwarded bytes are never touched.
  private readonly encoding: "gzip" | "deflate" | "br" | "zstd" | null = null;
  private encodedChunks: Buffer[] = [];
  private encodedBytes = 0;
  private static readonly MAX_ENCODED = 16 * 1024 * 1024;

  constructor(contentType: string | undefined, contentEncoding: string | undefined) {
    this.isSse = /^text\/event-stream\b/i.test(contentType ?? "");
    const enc = (contentEncoding ?? "").toLowerCase().trim();
    if (enc === "" || enc === "identity") this.encoding = null;
    else if (enc === "gzip" || enc === "x-gzip") this.encoding = "gzip";
    else if (enc === "deflate") this.encoding = "deflate";
    else if (enc === "br") this.encoding = "br";
    else if (enc === "zstd" && typeof (zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function") this.encoding = "zstd";
    else this.dropUntilNewline = true; // unknown encoding: observe nothing
  }

  get enabled(): boolean {
    return !this.dropUntilNewline;
  }

  feed(chunk: Buffer): void {
    if (!this.enabled) return;
    if (this.encoding) {
      if (this.encodedBytes + chunk.length > ResponseUsageTap.MAX_ENCODED) {
        this.dropUntilNewline = true;
        this.encodedChunks = [];
        return;
      }
      this.encodedChunks.push(chunk);
      this.encodedBytes += chunk.length;
      return;
    }
    const text = this.decoder.decode(chunk, { stream: true });
    if (this.isSse) this.feedSse(text);
    else this.feedJson(text);
  }

  finish(): ObservedResponse {
    if (!this.enabled) return {};
    if (this.encoding) {
      let plain: Buffer;
      try {
        const all = Buffer.concat(this.encodedChunks);
        plain =
          this.encoding === "gzip" ? zlib.gunzipSync(all)
          : this.encoding === "deflate" ? zlib.inflateSync(all)
          : this.encoding === "br" ? zlib.brotliDecompressSync(all)
          : (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(all);
      } catch {
        return {};
      }
      this.encodedChunks = [];
      const text = plain.toString("utf8");
      if (this.isSse) this.feedSse(text);
      else this.feedJson(text);
    }
    const tail = this.decoder.decode();
    if (tail) {
      if (this.isSse) this.feedSse(tail);
      else this.feedJson(tail);
    }
    if (this.isSse && this.carry) this.feedSse("\n");
    return { ...(this.usage ? { usage: this.usage } : {}), ...(this.stopReason ? { stopReason: this.stopReason } : {}) };
  }

  private feedSse(text: string): void {
    this.carry += text;
    if (this.carry.length > MAX_CARRY) {
      const newline = this.carry.lastIndexOf("\n");
      if (newline < 0) {
        this.carry = "";
        this.event = "";
        this.data = [];
        return;
      }
      this.carry = this.carry.slice(newline + 1);
      this.event = "";
      this.data = [];
    }
    for (;;) {
      const newline = this.carry.indexOf("\n");
      if (newline < 0) return;
      const raw = this.carry.slice(0, newline);
      this.carry = this.carry.slice(newline + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") {
        this.consumeSseEvent();
        this.event = "";
        this.data = [];
      } else if (line.startsWith("event:")) {
        this.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).trimStart());
      }
    }
  }

  private consumeSseEvent(): void {
    if (!this.data.length) return;
    try {
      const body = JSON.parse(this.data.join("\n")) as Record<string, unknown>;
      if (this.event === "message_start" || body.type === "message_start") {
        const message = body.message as { usage?: unknown } | undefined;
        this.setUsage(message?.usage);
      } else if (this.event === "message_delta" || body.type === "message_delta") {
        this.setUsage(body.usage);
        const delta = body.delta as { stop_reason?: unknown } | undefined;
        if (typeof delta?.stop_reason === "string") this.stopReason = delta.stop_reason;
      }
    } catch {
      // A malformed upstream event is not a proxy error and must not affect delivery.
    }
  }

  private feedJson(text: string): void {
    this.carry += text;
    this.stopCarry = (this.stopCarry + text).slice(-MAX_CARRY);
    const stop = /"stop_reason"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(this.stopCarry);
    if (stop) {
      try { this.stopReason = JSON.parse(`"${stop[1]}"`) as string; } catch { /* ignore */ }
    }
    if (!this.jsonUsageStarted) {
      const match = /"usage"\s*:\s*\{/.exec(this.carry);
      if (!match) {
        if (this.carry.length > MAX_CARRY) this.carry = this.carry.slice(-MAX_CARRY);
        return;
      }
      this.jsonUsageStarted = true;
      const start = (match.index ?? 0) + match[0].lastIndexOf("{");
      this.jsonUsageText = this.carry.slice(start);
      this.carry = "";
      this.jsonUsageDepth = 0;
    } else {
      this.jsonUsageText += this.carry;
      this.carry = "";
    }
    if (this.jsonUsageText.length > MAX_CARRY) {
      this.jsonUsageStarted = false;
      this.jsonUsageText = "";
      return;
    }
    let quoted = false;
    let escaped = false;
    for (let i = 0; i < this.jsonUsageText.length; i++) {
      const char = this.jsonUsageText[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") this.jsonUsageDepth++;
      else if (char === "}" && --this.jsonUsageDepth === 0) {
        try { this.setUsage(JSON.parse(this.jsonUsageText.slice(0, i + 1)) as unknown); } catch { /* ignore */ }
        this.jsonUsageStarted = false;
        this.jsonUsageText = "";
        return;
      }
    }
  }

  private setUsage(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const usage = value as Record<string, unknown>;
    const number = (key: string): number => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? Math.max(0, usage[key] as number) : 0;
    if (!("input_tokens" in usage || "output_tokens" in usage || "cache_read_input_tokens" in usage || "cache_creation_input_tokens" in usage)) return;
    const current = this.usage ?? { input: 0, cached: 0, output: 0 };
    const input = "input_tokens" in usage ? number("input_tokens") : current.input;
    const cached = "cache_read_input_tokens" in usage ? number("cache_read_input_tokens") : current.cached;
    const cacheWrite = "cache_creation_input_tokens" in usage ? number("cache_creation_input_tokens") : current.cacheWrite;
    const output = "output_tokens" in usage ? number("output_tokens") : current.output;
    this.usage = { input, cached, ...(cacheWrite && cacheWrite > 0 ? { cacheWrite } : {}), output };
  }
}

export function requestId(): string {
  return crypto.randomUUID();
}
