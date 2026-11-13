import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeFileAtomic, writeFileAtomicAsync } from "./fsutil.ts";
import { FRAME_CAP, INLINE_CAP } from "./protocol.ts";
import { changeCount, toolInput } from "./tool-details.ts";
import { workerLabelFor } from "./worker-labels.ts";
import type { BlobRef, EventBody, SessionEvent, SessionFile, Text } from "./protocol.ts";

export interface EventLogOptions {
  dir: string;
  segmentBytes?: number;
  now?: () => number;
  /** Transcript-line entries kept for dedupe; a test seam, normally `EventLog.LINE_CAP`. */
  lineCap?: number;
}

const LINE_CAP = 64 * 1024;
const PAGE_CAP = FRAME_CAP - 4096;
/** A `src` the host recorded itself (a prompt it sent over Remote Control, by the uuid the app will
 * echo): any transcript line carrying that uuid is that same message, whatever its content (#126). */
const HOST_LINE = -1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Segment { fd: number; bytes: number; number: number }
interface Entry { seq: number; segment: Segment; offset: number; length: number; kind: EventBody["kind"]; msg?: string }

/** Whether an event lists a file that was not delivered, on the message or on one of its tool calls. */
export function hasRefusedFile(event: EventBody): boolean {
  if (event.kind !== "assistant" && event.kind !== "tool_result") return false;
  const refused = (files?: readonly SessionFile[]): boolean => !!files?.some(file => file.status !== "ready");
  return refused(event.files) || (event.kind === "assistant" && event.tools.some(tool => refused(tool.files)));
}

/** The files an event list holds as delivered, on a message, a tool call or a tool result. */
export function deliveredFiles(bodies: readonly EventBody[]): SessionFile[] {
  return bodies.flatMap(next => next.kind === "tool_result" ? next.files ?? [] : next.kind === "assistant" ? [...next.files ?? [], ...next.tools.flatMap(tool => tool.files ?? [])] : []).filter(file => file.status === "ready");
}

/** Content-addressed within one epoch: the id the log stores an image's bytes under (`EventLog.image`). */
export function imageBlobId(epoch: string, base64: string): string {
  const hash = createHash("sha256").update(epoch).update("\0").update(base64).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

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
  private lineCap: number;
  private entries: Entry[] = [];
  private segments: Segment[] = [];
  private finalized = new Set<string>();
  private closed = false;
  /** Transcript line uuid → fingerprints of every version of it already converted (#126, 2026-11-05).
   * One uuid can legitimately be emitted twice (a partial line, then the completed one), and a
   * reconnect re-appends both, so remembering only the newest fingerprint made the older copy look
   * new. Rebuilt from the log on open, so the dedupe survives a host restart. Bounded per uuid and
   * overall: the cap counts uuids, and each keeps at most VERSIONS newest fingerprints. 20k uuids is
   * far beyond the largest re-appended block seen (about 1.3k lines), and an evicted uuid only means
   * a later copy of it is emitted as it would have been before this record existed. */
  private lines = new Map<string, number[]>();
  /** Timeline key of an assistant message or tool result → its newest entry, kept only while that
   * entry still lists a file that was not delivered (see `refusedEvents`). Rebuilt on open. */
  private refusedLatest = new Map<string, number>();
  /** Original seq → the event as it reads now (see `substitute`). Loaded from `substitutes.jsonl`. */
  private substitutes = new Map<number, { event: SessionEvent; length: number }>();
  /** Seq of an appended restatement → the original it restates, and the inert event served in its place by
   * tail and older pages (see `restate`). Loaded from `substitutes.jsonl`. */
  private restatements = new Map<number, { of: number; inert: { event: SessionEvent; length: number } }>();
  private static readonly LINE_CAP = 20_000;
  /** Versions of one uuid kept: a partial and its completion, with room to spare. */
  private static readonly LINE_VERSIONS = 8;

  private constructor(opts: EventLogOptions, epoch: string) {
    this.dir = opts.dir;
    this.segmentBytes = opts.segmentBytes ?? 8 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
    this.lineCap = opts.lineCap && opts.lineCap > 0 ? opts.lineCap : EventLog.LINE_CAP;
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
      log.loadSubstitutes();
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
    if (event.kind === "assistant" || event.kind === "tool_result") {
      // The timeline replaces an assistant message, and a tool's result, by these keys: a later event
      // with the same key is the current state, so only a key whose newest event still holds a refused
      // file is a candidate for repair.
      const key = event.kind === "assistant" ? `a${event.msg}` : `r${event.toolUseId}`;
      if (hasRefusedFile(event)) this.refusedLatest.set(key, this.entries.length);
      else this.refusedLatest.delete(key);
    }
    if (event.src) {
      // A missing fingerprint marks the uuid itself as shown (a prompt the host sent), matching any
      // line that carries it.
      this.noteLine(event.src, typeof event.srcHash === "number" ? event.srcHash : HOST_LINE);
    }
    this.entries.push(entry);
  }

  /** Add one version of a transcript line to the in-memory index `lineSeen` reads. Re-set so the
   * most recently emitted line is the last to be evicted, and keep every version already emitted
   * for that uuid so a replay of any of them is recognised (#126). */
  private noteLine(src: string, hash: number): void {
    const versions = this.lines.get(src) ?? [];
    this.lines.delete(src);
    const next = versions.includes(hash) ? versions : [...versions, hash];
    while (next.length > EventLog.LINE_VERSIONS) next.shift();
    this.lines.set(src, next);
    while (this.lines.size > this.lineCap) this.lines.delete(this.lines.keys().next().value!);
  }

  /** Whether this transcript line was already shown in this log: any version of the same uuid with
   * this content, or a uuid the host itself sent. A fingerprint never seen under that uuid is a real
   * rewrite and must still emit (#126). */
  lineSeen(src: string, hash: number): boolean {
    this.assertOpen();
    const versions = this.lines.get(src);
    return versions !== undefined && (versions.includes(hash) || versions.includes(HOST_LINE));
  }

  /** Note a transcript line as already shown without writing an event: only the in-memory index
   * `lineSeen` reads is updated, so a copy re-appended later in this run is skipped. Nothing goes to
   * disk, so after a host restart that line is unknown again and may be emitted once more
   * (2026-11-05). */
  remember(src: string, hash: number): void {
    this.assertOpen();
    this.noteLine(src, hash);
  }

  /** The assistant messages and tool results whose newest event still lists a file the host did not
   * deliver (blocked, missing or too large), in log order. Answered from the index built on open:
   * only these events are read from disk. */
  refusedEvents(): SessionEvent[] {
    this.assertOpen();
    // The original as written, not as served: one that already has a substitute was repaired.
    return [...this.refusedLatest.values()].sort((a, b) => a - b).filter(i => !this.substitutes.has(i + 1)).map(i => this.readRaw(this.entries[i]!));
  }

  private substitutesFile(): string { return join(this.dir, "substitutes.jsonl"); }

  /** Read the sidecar of restated events. An entry that does not match the event at its seq (another
   * epoch's leftovers, a truncated log) is ignored, so a substitute can never change which message a
   * seq is. A torn last line (a crash while writing it) is cut off like a torn log line. */
  private loadSubstitutes(): void {
    let data: Buffer;
    try { data = readFileSync(this.substitutesFile()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const whole = data.lastIndexOf(10) + 1;
    if (whole !== data.length) truncateSync(this.substitutesFile(), whole);
    for (const text of data.toString("utf8", 0, whole).split("\n")) {
      if (!text) continue;
      let event: SessionEvent;
      try { event = JSON.parse(text) as SessionEvent; } catch { continue; }
      const marked = (event as unknown as { restates?: { seq?: unknown; of?: unknown; at?: unknown } } | null)?.restates;
      if (marked) {
        const { seq, of, at } = marked;
        if (typeof seq === "number" && typeof of === "number" && typeof at === "number" && this.restatesOriginal(seq, of)) this.restatements.set(seq, { of, inert: EventLog.inertEvent(seq, at) });
        continue;
      }
      const entry = this.entries[event?.seq - 1];
      if (!entry || entry.kind !== event.kind || (event.kind === "assistant" && entry.msg !== event.msg)) continue;
      this.substitutes.set(event.seq, { event, length: Buffer.byteLength(text) + 1 });
    }
  }

  /**
   * Record that the event at `seq` now reads as `body` (same seq and time). Every read that sends
   * events out (tail, older pages, catch-up) serves this instead of the stored line; the log files
   * themselves are never rewritten. Kept in a sidecar so it survives a restart.
   */
  substitute(seq: number, body: EventBody): void {
    this.assertOpen();
    const entry = this.entries[seq - 1];
    if (!entry) throw new RangeError("No event at that seq");
    if (body.kind !== entry.kind) throw new RangeError("A substitute must be the same kind of event");
    const event: SessionEvent = { ...structuredClone(body), seq, at: this.readRaw(entry).at };
    const line = fitLine(event);
    appendFileSync(this.substitutesFile(), line, { encoding: "utf8", mode: 0o600 });
    this.substitutes.set(seq, { event: JSON.parse(line) as SessionEvent, length: Buffer.byteLength(line) });
  }

  /** Whether the entries at `seq` and `of` can be a restatement and its original: `of` is earlier, and both
   * are the same message (assistant) or the same tool's result. A marker that fails this belongs to
   * some other log, or was written for an append that never happened. */
  private restatesOriginal(seq: number, of: number): boolean {
    const next = this.entries[seq - 1], old = this.entries[of - 1];
    if (!next || !old || of >= seq || next.kind !== old.kind) return false;
    if (next.kind === "assistant") return next.msg === old.msg;
    return next.kind === "tool_result" && (this.readRaw(next) as { toolUseId?: string }).toolUseId === (this.readRaw(old) as { toolUseId?: string }).toolUseId;
  }

  /** What tail and older pages serve for an appended restatement: an event no timeline can place, the
   * result of a call nobody made. A phone that never held the original must not show the restatement
   * as a new reply, and one that does hold the original gets the fixed copy at the original's seq. */
  private static inertEvent(seq: number, at: number): { event: SessionEvent; length: number } {
    const event: SessionEvent = { kind: "tool_result", toolUseId: `repair:${seq}`, ok: true, text: "", seq, at };
    return { event, length: Buffer.byteLength(JSON.stringify(event)) + 1 };
  }

  /**
   * Append `body` as the restatement of the event at `of` (same message or tool result, now fixed), at the
   * original's time. Catch-up and live pushes carry it as itself, so a phone that holds the original
   * replaces it in place; tail and older pages carry an inert event at its seq instead, because a phone
   * that starts from there does not hold the original and would show the restatement as a new reply.
   * The marker is written before the append and checked when read back (`restatesOriginal`), so a
   * restart never serves an unmarked restatement as itself. Returns the appended event.
   */
  restate(body: EventBody, of: number, at: number): SessionEvent {
    this.assertOpen();
    const seq = this.lastSeq + 1;
    if (!this.canRestate(body, of)) throw new RangeError("A restatement must be of the same message or tool result");
    appendFileSync(this.substitutesFile(), JSON.stringify({ restates: { seq, of, at } }) + "\n", { encoding: "utf8", mode: 0o600 });
    const event = this.append(body, at);
    this.restatements.set(seq, { of, inert: EventLog.inertEvent(seq, at) });
    return event;
  }

  private canRestate(body: EventBody, of: number): boolean {
    const old = this.entries[of - 1];
    if (!old || old.kind !== body.kind) return false;
    if (body.kind === "assistant") return old.msg === body.msg;
    return body.kind === "tool_result" && (this.readRaw(old) as { toolUseId?: string }).toolUseId === body.toolUseId;
  }

  /** The seq the newest `maxBytes` of events starts at, as `tail` would serve them (without reading them). */
  tailStart(maxBytes = PAGE_CAP): number {
    this.assertOpen();
    let bytes = 0;
    let first = this.entries.length + 1;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (!this.visible(entry)) continue;
      const length = this.servedLength(entry, true);
      if (first <= this.entries.length && bytes + length > maxBytes) break;
      bytes += length;
      first = entry.seq;
    }
    return first;
  }

  /** `at` stands in for the clock when the event restates an older one (a repair keeps the time of the original). */
  append(body: EventBody, at?: number): SessionEvent {
    this.assertOpen();
    const event: SessionEvent = { ...structuredClone(body), seq: this.lastSeq + 1, at: at ?? this.now() };
    // A pinned worker's id is plumbing; the phone and the web UI show the label instead.
    if (event.kind === "subagent" && event.modelLabel === undefined) {
      const label = workerLabelFor(event.model);
      if (label) event.modelLabel = label;
    }
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

  /** The event as served: its substitute when one was recorded. Every outgoing read goes through here. */
  private read(entry: Entry): SessionEvent {
    return this.substitutes.get(entry.seq)?.event ?? this.readRaw(entry);
  }

  private readRaw(entry: Entry): SessionEvent {
    const buffer = Buffer.allocUnsafe(entry.length);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = readSync(entry.segment.fd, buffer, bytes, buffer.length - bytes, entry.offset + bytes);
      if (n === 0) throw new Error("Event log was truncated while open");
      bytes += n;
    }
    return JSON.parse(buffer.toString("utf8")) as SessionEvent;
  }

  /** How many bytes `entry` counts for in a page. A substitute is counted at its own size (it can be
   * longer than the line it stands for), an inert restatement at the size of the inert event. */
  private servedLength(entry: Entry, inert: boolean): number {
    return (inert ? this.restatements.get(entry.seq)?.inert.length : undefined) ?? this.substitutes.get(entry.seq)?.length ?? entry.length;
  }

  private serve(entry: Entry, inert: boolean): SessionEvent {
    return (inert ? this.restatements.get(entry.seq)?.inert.event : undefined) ?? this.read(entry);
  }

  /** `inert`: an appended restatement is served as an inert event (see `restate`), not as itself. */
  private page(start: number, direction: 1 | -1, maxBytes: number, inert: boolean): { events: SessionEvent[]; remaining: boolean } {
    this.assertOpen();
    if (Number.isNaN(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be nonnegative");
    const events: SessionEvent[] = [];
    let bytes = 0;
    let remaining = false;
    for (let i = start; i >= 0 && i < this.entries.length; i += direction) {
      const entry = this.entries[i]!;
      if (!this.visible(entry)) continue;
      const length = this.servedLength(entry, inert);
      if (events.length && bytes + length > maxBytes) { remaining = true; break; }
      events.push(this.serve(entry, inert));
      bytes += length;
    }
    if (direction === -1) events.reverse();
    return { events, remaining };
  }

  /**
   * The events after `afterSeq`: a phone's catch-up, and what a live push sends. An appended restatement
   * comes as itself, which is how a phone holding the original gets the fix. The host's own readers
   * (queue, task and activity tracking) pass `restated: "inert"`: to them a restatement is not an answer.
   */
  readAfter(afterSeq: number, maxBytes = PAGE_CAP, restated: "real" | "inert" = "real"): { events: SessionEvent[]; more: boolean } {
    const { events, remaining } = this.page(Math.max(0, Math.floor(afterSeq)), 1, maxBytes, restated === "inert");
    return { events, more: remaining };
  }

  /** The newest events, for a phone with no usable copy. Restatements are inert here (see `restate`). */
  tail(maxBytes = PAGE_CAP): { events: SessionEvent[]; hasOlder: boolean } {
    const { events, remaining } = this.page(this.entries.length - 1, -1, maxBytes, true);
    return { events, hasOlder: remaining };
  }

  /** An older page. Restatements are inert here (see `restate`). */
  before(beforeSeq: number, maxBytes = PAGE_CAP): { events: SessionEvent[]; hasOlder: boolean } {
    const start = Math.min(this.entries.length - 1, Math.ceil(beforeSeq) - 2);
    const { events, remaining } = this.page(start, -1, maxBytes, true);
    return { events, hasOlder: remaining };
  }

  /** The last nonempty assistant text of this turn, not a previous turn or a tool result.
   * Walk the in-memory index so even a long chain of tool events needs only relevant disk reads. */
  lastAssistantText(beforeSeq = this.lastSeq + 1): string {
    this.assertOpen();
    for (let i = Math.min(this.entries.length, beforeSeq - 1) - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (entry.kind === "turn" || entry.kind === "user" || entry.kind === "result") return "";
      // A restatement repeats a message already said; it is never the answer of the turn.
      if (entry.kind !== "assistant" || this.restatements.has(entry.seq)) continue;
      const event = this.read(entry);
      if (event.kind !== "assistant") continue;
      const text = typeof event.text === "string" ? event.text : event.text.preview;
      if (text.trim()) return text;
    }
    return "";
  }

  /** Content-addressed within this epoch: a rebase expires every old file/image reference. */
  image(base64: string): string {
    const id = this.imageId(base64);
    this.putImage(id, base64);
    return id;
  }

  /** The id `image` would store these bytes under, without storing them. */
  imageId(base64: string): string {
    this.assertOpen();
    return imageBlobId(this.epoch, base64);
  }

  putImage(id: string, base64: string): void {
    this.assertOpen();
    if (!UUID.test(id)) throw new RangeError("Invalid blob id");
    writeFileAtomic(join(this.dir, "blobs", `${id}.txt`), base64);
  }

  /** `putImage` that does not hold the event loop while a large file is written. */
  async putImageAsync(id: string, base64: string): Promise<void> {
    this.assertOpen();
    if (!UUID.test(id)) throw new RangeError("Invalid blob id");
    await writeFileAtomicAsync(join(this.dir, "blobs", `${id}.txt`), base64);
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
