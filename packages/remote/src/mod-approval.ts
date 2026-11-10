// Approvals a Claude app session asks the mod to hold, for a session with no Remote Control bridge.
// The mod's classic.PermissionRequest hook registers each ask here; the host decides the hold (the
// person is away from the Mac: the phone answers) or the local dialog (at the Mac, or unknown). One
// ask has one winner: a phone answer, the person's return to the Mac, a stale hook, or a restart.
// Transitions only leave `pending`, and each is made here synchronously, so no two win.

/** A hook that stopped polling for this long has died: the host lets go. */
export const APPROVAL_STALE_MS = 45_000;
/** A held ask whose Mac session reads idle this long has lost its turn (aborted, or the app quit). */
export const APPROVAL_IDLE_MS = 15_000;
/** How long a long-poll answers at most; a router hop allows 5 s, so this stays well under it. */
export const APPROVAL_WAIT_MS = 3_000;
/**
 * A pending ask whose hook has not polled for this long is fenced: no phone answer may settle it any more.
 * The hook stops polling once this long has passed since its last answered poll, and gives the Mac its dialog
 * only this long after the latest poll it sent, plus a margin (APPROVAL_FRESH_MS and APPROVAL_FRESH_MARGIN_MS in
 * packages/mod/hooks/approval.ts). The fence is therefore always reached before the dialog opens, so the phone
 * and the dialog never both win.
 */
export const APPROVAL_FRESH_MS = 8_000;
/** Settled asks stay readable this long (a retried poll after a lost answer still gets it). */
const SETTLED_KEEP_MS = 120_000;

export type ApprovalState = "pending" | "answered" | "local" | "expired";
/** What the hook returns to the engine: the phone's decision, with the always-allow updates it may add. */
export type ApprovalAnswer = { behavior: "allow"; updates?: unknown[] } | { behavior: "deny"; message: string };

export interface Approval {
  askId: string;
  /** The id the phone knows the session by (its record id, or the CLI id for a session with no record). */
  phoneId: string;
  /** The CLI session id the mod reports (`$.session.id()`). */
  desktopId: string;
  tool: string;
  /** The phone's permission record, while the phone holds this ask. */
  recordId: string | null;
  state: ApprovalState;
  createdAt: number;
  /** The hook's latest poll, dated by when the hook sent it and never later than its arrival (see `touch`). */
  polledAt: number;
  /** When the Mac session was first seen idle while this ask was pending (cleared when it is busy again). */
  idleSince?: number;
  settledAt?: number;
  answer?: ApprovalAnswer;
  /** The phone-visible reason a settled ask carries (`local`, `stale`, ...). */
  reason?: string;
}

export class Approvals {
  private asks = new Map<string, Approval>();
  private waiters = new Map<string, Array<() => void>>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** A new ask, pending. Null when the id is already known (a retried start is not a second ask). */
  open(ask: { askId: string; phoneId: string; desktopId: string; tool: string }): Approval | null {
    if (this.asks.has(ask.askId)) return null;
    const at = this.now();
    const approval: Approval = { ...ask, recordId: null, state: "pending", createdAt: at, polledAt: at };
    this.asks.set(ask.askId, approval);
    return { ...approval };
  }

  get(askId: string): Approval | undefined {
    const ask = this.asks.get(askId);
    return ask ? { ...ask } : undefined;
  }

  /** The phone's record of a hold, set once the hold begins. */
  attach(askId: string, recordId: string): void {
    const ask = this.asks.get(askId);
    if (ask?.state === "pending") ask.recordId = recordId;
  }

  /**
   * A poll is the hook's heartbeat. A hold already fenced when the poll arrives revives nothing, whenever the poll
   * was sent: the hook may have given the Mac its dialog. Otherwise the heartbeat is the poll's send time (`sentAt`,
   * on this same clock), never later than its arrival and never moving back; a poll without one (an older mod) is
   * dated by its arrival. False when the pending hold is fenced, and the caller closes it. True otherwise, and for an
   * ask that is no longer pending.
   */
  touch(askId: string, sentAt?: number): boolean {
    const ask = this.asks.get(askId);
    if (!ask || ask.state !== "pending") return true;
    const at = this.now();
    if (at - ask.polledAt >= APPROVAL_FRESH_MS) return false;
    const sent = sentAt !== undefined && Number.isFinite(sentAt) && sentAt >= 0 ? Math.min(sentAt, at) : at;
    ask.polledAt = Math.max(ask.polledAt, sent);
    return true;
  }

  /** A pending ask whose hook has not polled for the freshness window: the phone may no longer answer it. */
  fenced(askId: string): boolean {
    const ask = this.asks.get(askId);
    return ask?.state === "pending" && this.now() - ask.polledAt >= APPROVAL_FRESH_MS;
  }

  /** The single winner: only a pending ask moves, once. */
  settle(askId: string, state: Exclude<ApprovalState, "pending">, options: { answer?: ApprovalAnswer; reason?: string } = {}): boolean {
    const ask = this.asks.get(askId);
    if (!ask || ask.state !== "pending") return false;
    ask.state = state;
    ask.settledAt = this.now();
    if (options.answer) ask.answer = options.answer;
    if (options.reason !== undefined) ask.reason = options.reason;
    for (const wake of this.waiters.get(askId) ?? []) wake();
    this.waiters.delete(askId);
    return true;
  }

  /** The hook has the result (or chose the dialog): forget the ask now. */
  forget(askId: string): void {
    this.asks.delete(askId);
    for (const wake of this.waiters.get(askId) ?? []) wake();
    this.waiters.delete(askId);
  }

  /** Resolves when the ask leaves `pending`, or after `ms`, whichever comes first. */
  wait(askId: string, ms: number): Promise<void> {
    return new Promise(resolve => {
      const ask = this.asks.get(askId);
      if (!ask || ask.state !== "pending") { resolve(); return; }
      const wake = (): void => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const list = this.waiters.get(askId);
        if (list) { const rest = list.filter(w => w !== wake); if (rest.length) this.waiters.set(askId, rest); else this.waiters.delete(askId); }
        resolve();
      }, ms);
      this.waiters.set(askId, [...(this.waiters.get(askId) ?? []), wake]);
    });
  }

  /** Asks the phone or the Mac still owes an answer to, for one session: the session reads as waiting. */
  active(phoneId: string): Approval[] {
    return [...this.asks.values()].filter(ask => ask.phoneId === phoneId && (ask.state === "pending" || ask.state === "local")).map(ask => ({ ...ask }));
  }

  /**
   * Stops what no longer holds. A pending ask whose hook stopped polling is expired (the caller
   * expires its record; returned here). A local ask is forgotten once its session's Mac turn is not
   * busy any more, and only after a short grace: the registry read can lag the hook's own answer.
   * Settled asks are dropped after SETTLED_KEEP_MS.
   */
  sweep(busy: (desktopId: string) => boolean): Approval[] {
    const at = this.now();
    const stale: Approval[] = [];
    for (const ask of [...this.asks.values()]) {
      if (ask.state === "pending") {
        if (busy(ask.desktopId)) delete ask.idleSince;
        else ask.idleSince ??= at;
        const silent = at - ask.polledAt > APPROVAL_STALE_MS;
        const ended = ask.idleSince !== undefined && at - ask.idleSince > APPROVAL_IDLE_MS;
        if (silent || ended) {
          stale.push({ ...ask });
          this.settle(ask.askId, "expired", { reason: "stale" });
        }
      } else if (ask.state === "local") {
        if (!busy(ask.desktopId) && at - (ask.settledAt ?? at) > APPROVAL_WAIT_MS) this.forget(ask.askId);
      } else if (at - (ask.settledAt ?? at) > SETTLED_KEEP_MS) {
        this.forget(ask.askId);
      }
    }
    return stale;
  }
}

/** The phone-facing reason on a hold the Mac answered first (`permission_decided.reason`). */
export const APPROVAL_LOCAL_REASON = "local";
