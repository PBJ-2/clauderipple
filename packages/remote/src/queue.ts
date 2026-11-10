// Messages a phone queued for a session, held by the host and sent when the session's turn ends.
//
// Until 2026-10-22 the queue lived in the app: it watched the session go idle and sent the next
// message itself. A phone in a pocket is a suspended app, so a message queued during a 25-minute
// turn was still waiting three minutes after that turn ended, and the Mac never knew of it. Here
// the host owns it: on disk (`queue.json`, attachment bytes under `queue/`), sent one at a time,
// each only after the turn the previous one started has finished.
import fs from "node:fs";
import path from "node:path";
import { readJson, writeFileAtomic } from "./fsutil.ts";
import type { Attachment, QueuedMessage, SessionEvent } from "./protocol.ts";

export const QUEUE_CAP = 20;

export interface QueueAttachment { name: string; mediaType: string; file: string }
/** Why a message waits before it can go, as a machine code (the phone words it). Never a failure. */
export type QueueWait = "desktop_busy" | "desktop_waiting";
const WAITS: readonly string[] = ["desktop_busy", "desktop_waiting"];
export interface QueueItem { id: string; text: string; attachments: QueueAttachment[]; at: number; /** A real failure: the queue holds at this item until the person acts. */ error?: string; /** A pre-send obstacle that clears by itself; the message stays queued. */ wait?: QueueWait; claimedBy?: "mod" }
interface Entry {
  items: QueueItem[];
  /** Attachments taken back to the composer; retained outside the timeline's rebase lifecycle. */
  editing?: { blob: string; file: string }[];
  /** After the phone's Stop: nothing goes on its own until the person sends or resumes. */
  held: boolean;
  /** Distinguishes the person's Stop from an automatic failure, including across restart. */
  heldBy?: "user" | "failure";
  /** The Claude app's session id, when it differs from the phone's; the mod finds its count by it. */
  desktopId?: string;
  /** The last message sent from here: the next waits until the turn it started has ended. */
  awaiting?: { seq: number; at: number };
}

/** With no result or answer after this long, a quiet idle session is taken as done. */
export const AWAIT_GIVE_UP_MS = 90_000;

export class SendQueue {
  private entries = new Map<string, Entry>();
  private file: string;
  private blobs: string;
  private constructor(file: string, blobs: string) { this.file = file; this.blobs = blobs; }

  static open(dir: string): SendQueue {
    const queue = new SendQueue(path.join(dir, "queue.json"), path.join(dir, "queue"));
    const saved = readJson<Record<string, Entry>>(queue.file) ?? {};
    for (const [session, entry] of Object.entries(saved)) {
      if (!entry || !Array.isArray(entry.items)) continue;
      const items = entry.items.filter(item => item && typeof item.id === "string" && typeof item.text === "string" && Array.isArray(item.attachments))
        .map(item => { if (item.wait !== undefined && !WAITS.includes(item.wait)) delete item.wait; return item; });
      if (items.length || entry.awaiting || entry.editing?.length) queue.entries.set(session, { items, held: entry.held === true, ...(entry.heldBy ? { heldBy: entry.heldBy } : {}), ...(typeof entry.desktopId === "string" ? { desktopId: entry.desktopId } : {}), ...(entry.awaiting ? { awaiting: entry.awaiting } : {}), ...(entry.editing?.length ? { editing: entry.editing } : {}) });
    }
    return queue;
  }

  sessions(): string[] { return [...this.entries.keys()].filter(session => this.entries.get(session)!.items.length); }
  items(session: string): readonly QueueItem[] { return this.entries.get(session)?.items ?? []; }
  held(session: string): boolean { return this.entries.get(session)?.held === true; }
  awaiting(session: string): { seq: number; at: number } | undefined { return this.entries.get(session)?.awaiting; }

  /** What the phone shows: text, attachment count, and why the head stopped, if it did. */
  summary(session: string): { queue?: QueuedMessage[]; queueHeld?: boolean } {
    const entry = this.entries.get(session);
    if (!entry?.items.length) return {};
    return { queue: entry.items.map(item => ({ id: item.id, text: item.text, attachments: item.attachments.length, at: item.at, ...(item.error ? { error: item.error } : {}), ...(item.wait ? { wait: item.wait } : {}) })), ...(entry.held ? { queueHeld: true } : {}) };
  }

  /** Adds to the end; false when this id is already queued (a resend after a lost ack). */
  add(session: string, item: { id: string; text: string; attachments: { name: string; mediaType: string; data: string }[] }, at: number, desktopId?: string): boolean {
    const entry = this.entry(session);
    if (entry.items.some(queued => queued.id === item.id)) return false;
    if (entry.items.length >= QUEUE_CAP) throw new Error(`The queue holds at most ${QUEUE_CAP} messages.`);
    fs.mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    const attachments = item.attachments.map((a, index) => {
      const file = `${Buffer.from(session).toString("base64url")}-${item.id}-${index}`;
      writeFileAtomic(path.join(this.blobs, file), a.data);
      return { name: a.name, mediaType: a.mediaType, file };
    });
    entry.items.push({ id: item.id, text: item.text, attachments, at });
    if (desktopId && desktopId !== session) entry.desktopId = desktopId;
    this.save();
    return true;
  }

  /** The bytes of a queued attachment, base64, or null when the file is gone. */
  data(attachment: Pick<QueueAttachment, "file">): string | null {
    try { return fs.readFileSync(path.join(this.blobs, attachment.file), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  /** Delete normally; an edit transfers its files to the composer's retained draft. */
  remove(session: string, id: string, editing?: Attachment[]): QueueItem | null {
    const entry = this.entries.get(session);
    const index = entry?.items.findIndex(item => item.id === id) ?? -1;
    if (!entry || index < 0) return null;
    if (editing) this.releaseEditing(session);
    const [item] = entry.items.splice(index, 1);
    if (editing) {
      entry.editing = item!.attachments.map((a, index) => ({ blob: editing[index]!.blob, file: a.file }));
    } else for (const a of item!.attachments) fs.rmSync(path.join(this.blobs, a.file), { force: true });
    if (!entry.items.length) { entry.held = false; delete entry.heldBy; }
    this.prune(session);
    this.save();
    return item!;
  }

  editingBlob(session: string, blob: string): string | null {
    const attachment = this.entries.get(session)?.editing?.find(a => a.blob === blob);
    return attachment ? this.data(attachment) : null;
  }

  /** The next accepted send uses or abandons the editing draft; taking another draft replaces it. */
  releaseEditing(session: string): void {
    const entry = this.entries.get(session);
    if (!entry?.editing) return;
    for (const a of entry.editing) fs.rmSync(path.join(this.blobs, a.file), { force: true });
    delete entry.editing;
    this.prune(session);
    this.save();
  }

  fail(session: string, id: string, error: string): void {
    const item = this.entries.get(session)?.items.find(queued => queued.id === id);
    if (!item) return;
    item.error = error;
    delete item.wait;
    this.entries.get(session)!.held = true;
    this.entries.get(session)!.heldBy ??= "failure";
    this.save();
  }

  claimMod(session: string, id: string): boolean {
    const item = this.entries.get(session)?.items.find(queued => queued.id === id);
    if (!item || item.claimedBy) return false;
    item.claimedBy = "mod";
    this.save();
    return true;
  }

  failMod(session: string, id: string, reason: string): void {
    const item = this.entries.get(session)?.items.find(queued => queued.id === id);
    if (!item?.claimedBy) return;
    delete item.claimedBy;
    try { this.fail(session, id, reason); }
    catch (error) { item.claimedBy = "mod"; throw error; }
  }

  recoverMod(reason: string): void {
    for (const [session, entry] of this.entries) {
      for (const item of entry.items) if (item.claimedBy === "mod") this.failMod(session, item.id, reason);
    }
  }

  /**
   * A known pre-send obstacle is not a failed write: the message stays queued and says why, with a
   * machine code in `wait` (never in `error`, which a failure alone uses). Returns whether it changed.
   */
  wait(session: string, id: string, code: QueueWait): boolean {
    const item = this.entries.get(session)?.items.find(item => item.id === id);
    if (!item || item.wait === code && item.error === undefined) return false;
    item.wait = code;
    delete item.error;
    this.save();
    return true;
  }

  /** Records written before `wait` existed kept the wait sentence in `error`; move each such item over. */
  moveWaits(text: string, code: QueueWait): void {
    let changed = false;
    for (const entry of this.entries.values()) {
      for (const item of entry.items) {
        if (item.error !== text) continue;
        item.wait = code;
        delete item.error;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Older hosts held these definite pre-send refusals forever. Never release an explicit Stop. */
  retryFailures(error: string, code: QueueWait): void {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (!entry.held || entry.heldBy === "user" || entry.items[0]?.error !== error) continue;
      entry.held = false;
      delete entry.heldBy;
      delete entry.items[0].error;
      entry.items[0].wait = code;
      changed = true;
    }
    if (changed) this.save();
  }

  hold(session: string): boolean {
    const entry = this.entries.get(session);
    if (!entry?.items.length || entry.heldBy === "user") return false;
    entry.held = true;
    entry.heldBy = "user";
    this.save();
    return true;
  }

  resume(session: string): boolean {
    const entry = this.entries.get(session);
    if (!entry?.held) return false;
    entry.held = false;
    delete entry.heldBy;
    for (const item of entry.items) delete item.error;
    this.save();
    return true;
  }

  sent(session: string, seq: number, at: number): void {
    this.entry(session).awaiting = { seq, at };
    this.save();
  }

  /**
   * The Claude app moved a session on (a /clear in place): its queued messages and their held state go
   * to the new id, so nothing waits under the old one, which the list no longer shows. The turn the last
   * send started ran in the old transcript, so nothing waits for it any more (`awaiting` does not move).
   */
  rekey(from: string, to: string): void {
    const moving = this.entries.get(from);
    if (!moving || from === to) return;
    this.entries.delete(from);
    const target = this.entries.get(to);
    const editing = [...(moving.editing ?? []), ...(target?.editing ?? [])];
    const heldBy = moving.heldBy ?? target?.heldBy;
    this.entries.set(to, {
      items: [...moving.items, ...(target?.items ?? [])],
      held: moving.held || target?.held === true,
      ...(heldBy ? { heldBy } : {}),
      ...(editing.length ? { editing } : {}),
    });
    this.prune(to);
    this.save();
  }

  /**
   * Whether the turn the last queued message started has ended, read from the session's events
   * after it: a result; or an answer followed by the session going idle (a Claude app session
   * reports no result, and its state can read idle for a few seconds before the turn starts, so
   * the answer has to come first); or nothing at all for AWAIT_GIVE_UP_MS (the turn never started).
   */
  /** `appIdle`: the Claude app runs this session and its own process reads idle right now. Its turns
   * can start and end between two polls, leaving no state line here to settle on (2026-10-27). */
  settle(session: string, after: readonly SessionEvent[], now: number, appIdle = false): boolean {
    const entry = this.entries.get(session);
    const awaiting = entry?.awaiting;
    if (!entry || !awaiting) return true;
    const answered = after.findIndex(e => e.kind === "assistant");
    const done = after.some(e => e.kind === "result")
      || answered >= 0 && after.slice(answered).some(e => e.kind === "state" && ["idle", "error", "stopped"].includes(e.state))
      || answered >= 0 && appIdle
      || (answered < 0 || appIdle) && now - awaiting.at > AWAIT_GIVE_UP_MS;
    if (!done) return false;
    delete entry.awaiting;
    this.prune(session);
    this.save();
    return true;
  }

  private entry(session: string): Entry {
    let entry = this.entries.get(session);
    if (!entry) { entry = { items: [], held: false }; this.entries.set(session, entry); }
    return entry;
  }

  private prune(session: string): void {
    const entry = this.entries.get(session);
    if (entry && !entry.items.length && !entry.awaiting && !entry.editing?.length) this.entries.delete(session);
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.entries)));
  }
}
