// Durable message receipts: (session, clientMsgId) → pending → completed, on disk under the
// host home (atomic write + fsync via writeFileAtomic, Paseo `server/message-receipts/index.ts`
// behavior: a resend of a completed id is acknowledged without running again; a resend that
// finds a pending receipt left from before a host restart answers `outcome_unknown` instead of
// running again — the phone shows "전송 결과를 확인할 수 없음 — 다시 보내기 / 무시" for it).
//
// The key covers what Paseo digests as ["send", agentId, messageId]: our key is
// `send:<session>:<clientMsgId>` for turns and `create:<clientMsgId>` for session creation
// (no session exists yet). In-flight keys of this process are tracked in memory so a concurrent
// resend rides the first attempt instead of reading its pending receipt as an orphan.
import { readJson, writeFileAtomic } from "./fsutil.ts";

/** Thrown when a resend finds a pending receipt from before a host restart: the first attempt
 * may or may not have run, so this attempt must not run again. The server answers the phone
 * with error code `outcome_unknown` and this message. */
export class OutcomeUnknownError extends Error {
  constructor() { super("전송 결과를 확인할 수 없음"); }
}

interface Receipt {
  key: string;
  session: string;
  state: "pending" | "completed";
  at: number;
  /** A digest of what the id was accepted with. Absent on receipts written before it was kept. */
  fingerprint?: string;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function validReceipt(value: unknown): value is Receipt {
  const r = value as Receipt;
  return r !== null && typeof r === "object"
    && typeof r.key === "string" && typeof r.session === "string"
    && (r.state === "pending" || r.state === "completed")
    && Number.isFinite(r.at)
    && (r.fingerprint === undefined || typeof r.fingerprint === "string");
}

export class MessageReceipts {
  private file: string;
  private now: () => number;
  private records = new Map<string, Receipt>();
  private flying = new Set<string>();

  private constructor(file: string, now: () => number) {
    this.file = file;
    this.now = now;
  }

  static open(file: string, now: () => number = Date.now): MessageReceipts {
    const saved = readJson<Receipt[]>(file) ?? [];
    if (!Array.isArray(saved)) throw new Error("Invalid message receipts");
    const receipts = new MessageReceipts(file, now);
    for (const record of saved) {
      if (!validReceipt(record) || receipts.records.has(record.key)) throw new Error("Invalid message receipt");
      receipts.records.set(record.key, record);
    }
    // A pending receipt on disk with no live attempt in this process is an orphan of a restart.
    // Completed entries older than retention are dropped on the next write.
    return receipts;
  }

  /** Disk state only: "completed", "pending", or null when this id was never seen. */
  status(key: string): "completed" | "pending" | null {
    return this.records.get(key)?.state ?? null;
  }

  /** True while this process has an attempt for the key in flight (then a pending record is its own). */
  inFlight(key: string): boolean {
    return this.flying.has(key);
  }

  /** The session a completed receipt acknowledged, for resends that must ack without re-running. */
  sessionOf(key: string): string | null {
    const record = this.records.get(key);
    return record?.state === "completed" ? record.session : null;
  }

  /**
   * True when this id was already accepted with different content. A resend of a *different*
   * message under an id the host has seen must not be answered with a silent success: the phone
   * would believe work ran that never did. Receipts from before fingerprints, and requests without
   * one, keep the old idempotent answer.
   */
  conflict(key: string, fingerprint: string | undefined): boolean {
    const record = this.records.get(key);
    if (!record || record.fingerprint === undefined || fingerprint === undefined) return false;
    return record.fingerprint !== fingerprint;
  }

  /** Durably mark the attempt started, before it reaches the SDK. Overwrites nothing completed. */
  begin(key: string, session: string, fingerprint?: string): void {
    const at = this.now();
    const records = new Map(this.records);
    const kept = new Map<string, Receipt>();
    for (const [k, record] of records) {
      // Completed entries older than retention go; so do pending ones left orphaned by a restart
      // (the phone resends under a new id, so the orphan would otherwise sit here forever).
      // A resend of the same orphaned id still answers outcome_unknown: it checks status first
      // and never reaches here.
      if (k !== key && record.at < at - RETENTION_MS) continue;
      kept.set(k, record);
    }
    kept.set(key, { key, session, state: "pending", at, ...(fingerprint === undefined ? {} : { fingerprint }) });
    this.persist(kept);
    this.flying.add(key);
  }

  /** The SDK accepted the input: a resend acks this without running again. */
  complete(key: string, session?: string): void {
    const record = this.records.get(key);
    const at = this.now();
    const records = new Map(this.records);
    const kept = new Map<string, Receipt>();
    for (const [k, r] of records) {
      if (k !== key && r.state === "completed" && r.at < at - RETENTION_MS) continue;
      kept.set(k, r);
    }
    kept.set(key, { key, session: session ?? record?.session ?? "", state: "completed", at, ...(record?.fingerprint === undefined ? {} : { fingerprint: record.fingerprint }) });
    this.persist(kept);
    this.flying.delete(key);
  }

  /**
   * A /clear in place gave a session with no record a new id: the send receipts its messages were
   * accepted under follow it, so a resend under the old id is acknowledged at the new one, not run again.
   * A recordless session's sends are accepted in the call that begins them, so no attempt is in flight here.
   */
  moveSession(from: string, to: string): void {
    const prefix = `send:${from}:`;
    const moving = [...this.records.values()].filter(record => record.key.startsWith(prefix));
    if (moving.length === 0) return;
    const records = new Map(this.records);
    for (const record of moving) {
      records.delete(record.key);
      const key = `send:${to}:${record.key.slice(prefix.length)}`;
      if (!records.has(key)) records.set(key, { ...record, key, session: to });
    }
    this.persist(records);
  }

  /** The attempt was rejected before the SDK saw it: a resend must run fresh, not stay unknown. */
  abandon(key: string): void {
    if (!this.records.has(key)) { this.flying.delete(key); return; }
    const records = new Map(this.records);
    records.delete(key);
    this.persist(records);
    this.flying.delete(key);
  }

  private persist(records: Map<string, Receipt>): void {
    writeFileAtomic(this.file, JSON.stringify([...records.values()]));
    // Memory must not get ahead of durable state when a write fails.
    this.records = records;
  }
}
