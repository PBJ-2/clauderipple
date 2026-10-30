import { createHash, randomUUID } from "node:crypto";
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeFileAtomic } from "./fsutil.ts";
import { FRAME_CAP, INLINE_CAP } from "./protocol.ts";
import { changeCount, toolInput } from "./tool-details.ts";
import type { BlobRef, EventBody, SessionEvent, Text } from "./protocol.ts";

export interface EventLogOptions { dir: string; segmentBytes?: number; now?: () => number }

const LINE_CAP = 64 * 1024;
const PAGE_CAP = FRAME_CAP - 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Segment { fd: number; bytes: number; number: number }
interface Entry { seq: number; segment: Segment; offset: number; length: number; kind: EventBody["kind"]; msg?: string }

function serialized(event: SessionEvent): string { return JSON.stringify(event) + "\n"; }

function fitLine(event: SessionEvent): string {
  let line = serialized(event);
  if (Buffer.byteLength(line) <= LINE_CAP) return line;
  // Only display strings are lossy: text, input, summary, description, title,
  // error, detail, reason and blob previews. Routing/identity fields stay intact.
  const fields = new Set(["text", "input", "summary", "description", "title", "error", "detail", "reason", "preview"]);
  const candidates: { object: Record<string, unknown>; key: string; text: string }[] = [];
  function collect(value: unknown): void {
    if (Array.isArray(value)) { for (const child of value) collect(child); return; }
    if (value === null || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(object)) {
      if (typeof child === "string" && fields.has(key) && child.length > 1) candidates.push({ object, key, text: child });
      else if (typeof child === "object") collect(child);
    }
  }
  collect(event);
  candidates.sort((a, b) => Buffer.byteLength(JSON.stringify(b.text)) - Buffer.byteLength(JSON.stringify(a.text)));
  for (const { object, key, text } of candidates) {
    object[key] = "…";
    line = serialized(event);
    if (Buffer.byteLength(line) > LINE_CAP) continue;
    let low = 0;
    let high = text.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      object[key] = prefix(text, mid) + "…";
      if (Buffer.byteLength(serialized(event)) <= LINE_CAP) low = mid;
      else high = mid - 1;
    }
    object[key] = prefix(text, low) + "…";
    return serialized(event);
  }
  throw new RangeError("Event structure exceeds 64 KiB even after truncating display strings");
}

function prefix(text: string, length: number): string {
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

export class EventLog {
  readonly epoch: string;
  private dir: string;
  private segmentBytes: number;
  private now: () => number;
  private entries: Entry[] = [];
  private segments: Segment[] = [];
  private finalized = new Set<string>();
  private closed = false;

  private constructor(opts: EventLogOptions, epoch: string) {
    this.dir = opts.dir;
    this.segmentBytes = opts.segmentBytes ?? 8 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
    this.epoch = epoch;
    if (!Number.isFinite(this.segmentBytes) || this.segmentBytes <= 0) throw new RangeError("segmentBytes must be positive");
  }

  static open(opts: EventLogOptions): EventLog {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    const names = readdirSync(opts.dir).filter(name => /^events-\d{6,}\.jsonl$/.test(name))
      .sort((a, b) => Number(a.slice(7, -6)) - Number(b.slice(7, -6)));
    const metaFile = join(opts.dir, "meta.json");
    let meta = readJson<{ epoch: string }>(metaFile);
    if (meta === null) {
      if (names.length) throw new Error("Event log has segments but no epoch");
      meta = { epoch: randomUUID() };
      writeFileAtomic(metaFile, JSON.stringify(meta));
    }
    if (typeof meta.epoch !== "string" || !UUID.test(meta.epoch)) throw new Error("Invalid event log epoch");
    const log = new EventLog(opts, meta.epoch);
    try {
      for (const [i, name] of names.entries()) log.scan(name, i === names.length - 1);
      if (!log.segments.length) log.newSegment();
      return log;
    } catch (error) {
      log.close();
      throw error;
    }
  }

  get lastSeq(): number { return this.entries.length; }

  private newSegment(): Segment {
    const number = (this.segments.at(-1)?.number ?? 0) + 1;
    const file = join(this.dir, `events-${String(number).padStart(6, "0")}.jsonl`);
    const segment = { fd: openSync(file, "ax+", 0o600), bytes: 0, number };
    this.segments.push(segment);
    return segment;
  }

  private scan(name: string, last: boolean): void {
    const file = join(this.dir, name);
    const data = readFileSync(file);
    const entries: { event: SessionEvent; offset: number; length: number }[] = [];
    let offset = 0;
    while (offset < data.length) {
      const end = data.indexOf(10, offset);
      if (end === -1) {
        if (!last) throw new Error(`Unterminated event in ${name}`);
        break;
      }
      let event: SessionEvent;
      try {
        event = JSON.parse(data.toString("utf8", offset, end)) as SessionEvent;
      } catch (error) {
        if (!last || end !== data.length - 1) throw error;
        break;
      }
      if (event === null || event.seq !== this.lastSeq + entries.length + 1 || typeof event.at !== "number" || typeof event.kind !== "string") {
        throw new Error(`Invalid event at ${name}:${offset}`);
      }
      entries.push({ event, offset, length: end + 1 - offset });
      offset = end + 1;
    }
    // Windows cannot truncate through an append-only handle, so repair before opening that handle.
    if (offset !== data.length) truncateSync(file, offset);
    const segment: Segment = { fd: openSync(file, "a+", 0o600), bytes: offset, number: Number(name.slice(7, -6)) };
    this.segments.push(segment);
    for (const entry of entries) this.index(entry.event, segment, entry.offset, entry.length);
  }

  private index(event: SessionEvent, segment: Segment, offset: number, length: number): void {
    const entry: Entry = { seq: event.seq, segment, offset, length, kind: event.kind };
    if (event.kind === "assistant" || event.kind === "delta") {
      entry.msg = event.msg;
      if (event.kind === "assistant") this.finalized.add(event.msg);
    }
    this.entries.push(entry);
  }

  append(body: EventBody): SessionEvent {
    this.assertOpen();
    const event: SessionEvent = { ...structuredClone(body), seq: this.lastSeq + 1, at: this.now() };
    const blobs: { id: string; text: string }[] = [];
    function externalize(text: Text): Text {
      if (typeof text !== "string" || text.length <= INLINE_CAP) return text;
      const id = randomUUID();
      blobs.push({ id, text });
      const ref: BlobRef = { blob: id, bytes: Buffer.byteLength(text), preview: prefix(text, 400) };
      return ref;
    }
    if (event.kind === "assistant") {
      event.text = externalize(event.text);
      for (const tool of event.tools) {
        if (["Edit", "MultiEdit", "Write"].includes(tool.name) && !tool.changes) tool.changes = changeCount(tool.name, toolInput(tool.input));
        if (tool.input !== undefined) tool.input = externalize(tool.input);
      }
    } else if (event.kind === "tool_result" || event.kind === "thinking" || event.kind === "narration") event.text = externalize(event.text);
    else if (event.kind === "permission") event.input = externalize(event.input);
    const line = fitLine(event);
    for (const { id, text } of blobs) writeFileAtomic(join(this.dir, "blobs", `${id}.txt`), text);
    let segment = this.segments.at(-1)!;
    const length = Buffer.byteLength(line);
    if (segment.bytes > 0 && segment.bytes + length > this.segmentBytes) segment = this.newSegment();
    const offset = segment.bytes;
    try {
      writeFileSync(segment.fd, line, "utf8");
    } catch (error) {
      // Do not allow a partial failed append to poison the next event in this process.
      ftruncateSync(segment.fd, offset);
      throw error;
    }
    segment.bytes += length;
    this.index(event, segment, offset, length);
    return event;
  }

  private assertOpen(): void { if (this.closed) throw new Error("Event log is closed"); }
  private visible(entry: Entry): boolean {
    return entry.kind !== "delta" || entry.msg === undefined || !this.finalized.has(entry.msg);
  }

  private read(entry: Entry): SessionEvent {
    const buffer = Buffer.allocUnsafe(entry.length);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = readSync(entry.segment.fd, buffer, bytes, buffer.length - bytes, entry.offset + bytes);
      if (n === 0) throw new Error("Event log was truncated while open");
      bytes += n;
    }
    return JSON.parse(buffer.toString("utf8")) as SessionEvent;
  }

  private page(start: number, direction: 1 | -1, maxBytes: number): { events: SessionEvent[]; remaining: boolean } {
    this.assertOpen();
    if (Number.isNaN(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be nonnegative");
    const events: SessionEvent[] = [];
    let bytes = 0;
    let remaining = false;
    for (let i = start; i >= 0 && i < this.entries.length; i += direction) {
      const entry = this.entries[i]!;
      if (!this.visible(entry)) continue;
      if (events.length && bytes + entry.length > maxBytes) { remaining = true; break; }
      events.push(this.read(entry));
      bytes += entry.length;
    }
    if (direction === -1) events.reverse();
    return { events, remaining };
  }

  readAfter(afterSeq: number, maxBytes = PAGE_CAP): { events: SessionEvent[]; more: boolean } {
    const { events, remaining } = this.page(Math.max(0, Math.floor(afterSeq)), 1, maxBytes);
    return { events, more: remaining };
  }

  tail(maxBytes = PAGE_CAP): { events: SessionEvent[]; hasOlder: boolean } {
    const { events, remaining } = this.page(this.entries.length - 1, -1, maxBytes);
    return { events, hasOlder: remaining };
  }

  before(beforeSeq: number, maxBytes = PAGE_CAP): { events: SessionEvent[]; hasOlder: boolean } {
    const start = Math.min(this.entries.length - 1, Math.ceil(beforeSeq) - 2);
    const { events, remaining } = this.page(start, -1, maxBytes);
    return { events, hasOlder: remaining };
  }

  /** The last nonempty assistant text of this turn, not a previous turn or a tool result.
   * Walk the in-memory index so even a long chain of tool events needs only relevant disk reads. */
  lastAssistantText(beforeSeq = this.lastSeq + 1): string {
    this.assertOpen();
    for (let i = Math.min(this.entries.length, beforeSeq - 1) - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (entry.kind === "turn" || entry.kind === "user" || entry.kind === "result") return "";
      if (entry.kind !== "assistant") continue;
      const event = this.read(entry);
      if (event.kind !== "assistant") continue;
      const text = typeof event.text === "string" ? event.text : event.text.preview;
      if (text.trim()) return text;
    }
    return "";
  }

  /** Content-addressed within this epoch: a rebase expires every old file/image reference. */
  image(base64: string): string {
    this.assertOpen();
    const hash = createHash("sha256").update(this.epoch).update("\0").update(base64).digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    writeFileAtomic(join(this.dir, "blobs", `${id}.txt`), base64);
    return id;
  }

  blob(id: string): string | null {
    this.assertOpen();
    if (!UUID.test(id)) return null;
    const dirs = [this.dir, ...readdirSync(this.dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^sub-[\w-]{1,80}$/.test(entry.name))
      .map(entry => join(this.dir, entry.name))];
    for (const dir of dirs) {
      try { return readFileSync(join(dir, "blobs", `${id}.txt`), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const segment of this.segments) closeSync(segment.fd);
  }
}
