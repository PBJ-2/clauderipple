// Persisted logs keep a file as it was judged when the event was written. When the rules for what a
// session may hand to the phone widen (images.ts `claudeSessionTemp`), the events written before still
// hold the refusal. Two things repair that, both without rewriting a log file:
//  - Every such event gets a substitute in a sidecar (eventlog.ts `substitute`): each read that sends
//    events to a phone serves the restated event at the SAME seq, so a phone that pages back, or asks
//    for a fresh tail, finds it fixed in its true place, with its tool results.
//  - An event inside the window a phone may already hold is also restated as a NEW event at the end
//    of the log. The timeline replaces an assistant message by its `msg`, and a tool's result by its
//    `toolUseId`, so a phone that cached the blocked copy takes the new one by seq alone. Outside that
//    window it would not replace anything: a phone that never loaded the original would show it as a
//    new reply at the end, so nothing is appended there.
// The window holds only at repair time: as the conversation grows, a fresh tail can start after the
// original but before its restatement, and the timeline would place the restatement as a new reply. So
// the restatement is served as itself only to a phone resuming after a seq and in live pushes (the
// phones that can hold the original); tail and older pages carry an inert event at its seq
// (eventlog.ts `restate`), and the original there is already the substitute.
import path from "node:path";
import { hasRefusedFile, type EventLog } from "./eventlog.ts";
import { readJson, writeFileAtomic } from "./fsutil.ts";
import { fileImages } from "./images.ts";
import type { EventBody, ImagePart, SessionEvent, SessionFile, ToolCall } from "./protocol.ts";

/** Raise when images.ts changes in a way that can admit a file it refused before: the verdicts kept
 * beside a log (below) were reached under the old rules and are then asked again. */
export const FILE_RULES = 1;
const VERDICTS = "file-repair.json";
/** The newest events the released app keeps of a session (apps/ripple-remote/src/history-cache.ts
 * HISTORY_EVENTS; it keeps at most 64 KB of them as well). */
export const PHONE_CACHE_EVENTS = 120;

/** What the transcript says about the lines asked for. Its events, converted with today's rules, go to
 * `onLine` one wanted line at a time, with the bytes of the files delivered now under the ids those
 * events carry (ids made for `epoch`, see `imageBlobId`); no other image is handed over. False when the
 * transcript is gone. `lines` are line uuids (an event's `src`), `calls` tool-use ids. */
export type Reconvert = (want: { lines: Set<string>; calls: Set<string> }, epoch: string, onLine: (bodies: EventBody[], data: Map<string, string>) => void) => Promise<boolean>;

interface Verdicts { rules: number; seen: Record<string, true> }

const key = (event: SessionEvent): string => `${event.kind === "assistant" ? `a${event.msg}` : event.kind === "tool_result" ? `r${event.toolUseId}` : event.kind}@${event.seq}`;
const delivered = (file: SessionFile): boolean => file.status === "ready";
function body(event: SessionEvent): EventBody {
  const { seq: _seq, at: _at, ...rest } = event;
  return rest as EventBody;
}
/** The file list with each refused entry swapped for the fresh one at the same place and name, when
 * that one is delivered now. Anything else stays as it was: a file still refused stays refused, a
 * file gone from the disk stays gone. */
function swap(old: readonly SessionFile[], fresh: readonly SessionFile[] | undefined, gained: SessionFile[]): SessionFile[] {
  return old.map((file, i) => {
    const next = fresh?.[i];
    if (delivered(file) || !next || !delivered(next) || next.name !== file.name) return file;
    gained.push(next);
    return next;
  });
}
/** What the current conversion adds for `gained` files: their pictures, and a card for any other file. */
function widen(images: readonly ImagePart[] | undefined, files: readonly SessionFile[], gained: readonly SessionFile[], moved: boolean): { images: ImagePart[]; files: SessionFile[] } {
  const out = [...images ?? []];
  const kept = [...files];
  for (const file of gained) {
    if (moved) {
      // A call's refused file stood as a card on the message; the delivered one is a picture there, or a card of its own.
      const at = kept.findIndex(card => card.name === file.name && !delivered(card));
      if (at >= 0) kept.splice(at, 1);
      if (!fileImages([file]).length && !kept.some(card => card.id === file.id)) kept.push(file);
    }
    for (const image of fileImages([file])) if (!out.some(known => known.blob === image.blob)) out.push(image);
  }
  return { images: out, files: kept };
}

/** The event as it reads once the files the transcript line now delivers are in it; null when none are.
 * `gained` collects those files. */
function restated(old: SessionEvent, fresh: readonly EventBody[], gained: SessionFile[]): EventBody | null {
  if (old.kind === "tool_result") {
    const same = fresh.find(next => next.kind === "tool_result" && next.toolUseId === old.toolUseId);
    const files = swap(old.files ?? [], same?.files, gained);
    if (!gained.length) return null;
    const wider = widen(old.images, files, gained, false);
    return { ...body(old), files, images: wider.images } as EventBody;
  }
  if (old.kind !== "assistant") return null;
  const calls = new Map<string, readonly SessionFile[] | undefined>(fresh.flatMap(next => next.kind === "assistant" ? next.tools.map((tool): [string, readonly SessionFile[] | undefined] => [tool.id, tool.files]) : []));
  const tools = old.tools.map((tool): ToolCall => tool.files?.some(file => !delivered(file)) ? { ...tool, files: swap(tool.files, calls.get(tool.id), gained) } : tool);
  if (!gained.length) return null;
  const wider = widen(old.images, old.files ?? [], gained, true);
  return { ...body(old), tools, images: wider.images, files: wider.files } as EventBody;
}

/** The first seq a restated event is appended for: from there on, a phone may hold the original. */
export function windowStart(log: EventLog): number {
  return Math.max(1, Math.min(log.tailStart(), log.lastSeq - PHONE_CACHE_EVENTS + 1));
}

/**
 * For each message or tool result whose newest event still lists a refused file, restate the event as it
 * reads under today's rules. The files are found again only through what the session itself said: the
 * transcript line the event came from (`src`), or the call's id when the event has no `src`, and every
 * path goes through the same checks as a live conversion, so the rules are not widened here.
 *
 * The transcript is read in the background (`reconvert` runs off the host's loop); nothing is written until it is read,
 * and then only: the bytes of files that are delivered now (no other image is stored), the substitute of
 * each restated event, and, for those inside `windowStart`, the appended restatement at the original time.
 * `ready` is asked just before the writes that change what a phone sees: false (a turn started, the log
 * was replaced) leaves everything as it was and returns null, for another try later.
 *
 * Runs once per event: a verdict is kept beside the log for each event looked at, whether or not it
 * gained a file. Existing log files are never touched. Returns the events appended.
 */
export async function repairRefusedFiles(log: EventLog, dir: string, reconvert: Reconvert, ready: () => boolean = () => true): Promise<{ appended: SessionEvent[]; substituted: number } | null> {
  const file = path.join(dir, VERDICTS);
  let verdicts: Verdicts = { rules: FILE_RULES, seen: {} };
  try {
    const kept = readJson<Verdicts>(file);
    if (kept && kept.rules === FILE_RULES && kept.seen && typeof kept.seen === "object") verdicts = kept;
  } catch { /* an unreadable record only means asking again */ }
  const todo = log.refusedEvents().filter(event => !verdicts.seen[key(event)]);
  const none = { appended: [], substituted: 0 };
  if (!todo.length) return none;
  const want = { lines: new Set<string>(), calls: new Set<string>() };
  for (const event of todo) {
    if (event.kind !== "assistant" && event.kind !== "tool_result") continue;
    if (event.src) want.lines.add(event.src);
    else if (event.kind === "tool_result") want.calls.add(event.toolUseId);
    else for (const tool of event.tools) if (tool.files?.some(file => !delivered(file))) want.calls.add(tool.id);
  }
  // Only the bytes of files that are delivered come back; an inline picture of the same line never does.
  const keep = new Map<string, string>();
  const fresh: EventBody[] = [];
  const found = await reconvert(want, log.epoch, (bodies, data) => {
    fresh.push(...bodies);
    for (const [id, bytes] of data) keep.set(id, bytes);
  });
  if (!found) return none;
  const plans: { event: SessionEvent; next: EventBody | null; gained: SessionFile[] }[] = [];
  for (const event of todo) {
    const gained: SessionFile[] = [];
    plans.push({ event, next: restated(event, fresh, gained), gained });
  }
  // The bytes first, written without holding the loop: a restated event never names a blob that is not there.
  for (const { gained } of plans) {
    for (const file of gained) {
      const data = keep.get(file.id);
      if (data === undefined) throw new Error("A delivered file came without its bytes");
      await log.putImageAsync(file.id, data);
    }
  }
  if (!ready()) return null;
  // From here to the end nothing waits: what a phone is sent changes in one step.
  const from = windowStart(log);
  const appended: SessionEvent[] = [];
  let substituted = 0;
  for (const { event, next } of plans) {
    verdicts.seen[key(event)] = true;
    if (!next) continue;
    log.substitute(event.seq, next);
    substituted++;
    if (event.seq < from) continue;
    // The original time: the restatement is not news, and the timeline shows the message where it was said.
    const added = log.restate(next, event.seq, event.at);
    appended.push(added);
    if (hasRefusedFile(added)) verdicts.seen[key(added)] = true;
  }
  writeFileAtomic(file, JSON.stringify(verdicts));
  return { appended, substituted };
}
