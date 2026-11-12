// The host side of the relay's dead-man switch. While Claude is working on this computer, the host
// renews a `watch` on its own room every WATCH_RENEW_MS with the phone's Expo tokens and language;
// the room answers with a Durable Object alarm, and if the renewals stop (the computer slept, lost
// its network, or the process died) the room pushes "the PC disconnected" to the phone. Two minutes
// without work sends `unwatch`, so an idle computer that sleeps is silent.
//
// The host also owns the two online notices: the recovery push after the room says it fired (its
// outage length is `now - firedAt`), and one push the first time the "Claude login expired" problem
// meets active work in each occurrence while this computer holds it. Both use ExpoNotifier's send
// path and fixed copy from OUTAGE_COPY.
import { readJson, writeFileAtomic } from "./fsutil.ts";
import { WATCH_RENEW_MS, WATCH_SETTLE_MS, WATCH_TICK_MS, WATCH_TOKENS_MAX, WATCH_WAKE_GAP_MS, outageMinutes } from "./protocol.ts";
import type { HostControlMsg } from "./protocol.ts";

export interface WatchDeps {
  /** Whether Claude is working here now (Sessions.workActive). */
  active: () => boolean;
  /** Native devices and their language (ExpoNotifier.targets). */
  targets: () => { token: string; lang: "ko" | "en" }[];
  /** The identity the phone paired with, sent with every push (the host key). */
  host: string;
  /** One control frame on the relay's control socket; false while it is not open (retried). */
  send: (msg: HostControlMsg) => boolean;
  /** The room alerted while we were away: push one notice for `minutes`. */
  recover: (minutes: number) => Promise<void> | void;
  /** Where the last reported `firedAt` is kept, so a host restart cannot send the same notice twice. */
  stateFile?: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  log?: (line: string) => void;
}

export class RelayWatch {
  private deps: WatchDeps;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (id: unknown) => void;
  private timer: unknown = null;
  private stopped = true;
  /** The last `firedAt` already reported (persisted), never reported again. */
  private reportedAt: number | null = null;
  private lastWatchAt: number | null = null;
  /** The room currently holds a watch for us. */
  private watching = false;
  /** The relay has answered at least one control frame this process; before that, clear a stale watch. */
  private primed = false;
  /** The last tick or hello; a gap of WATCH_WAKE_GAP_MS since then means the computer slept. */
  private lastClockAt: number | null = null;
  /** When the computer last came back from sleep; null when it has not slept in this process. */
  private wokeAt: number | null = null;
  /** An outage the room told us about while the computer had not settled: reported once it has. */
  private pendingFiredAt: number | null = null;

  constructor(deps: WatchDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    if (deps.stateFile) {
      try {
        const stored = readJson<{ reportedAt?: unknown }>(deps.stateFile);
        if (typeof stored?.reportedAt === "number" && Number.isFinite(stored.reportedAt)) this.reportedAt = stored.reportedAt;
      } catch (error) {
        this.log(`watch: state unreadable; one recovery notice may repeat: ${message(error)}`);
      }
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      try { this.tick(); } finally { this.schedule(); }
    }, WATCH_TICK_MS);
  }

  /** One decision point; the timer calls it every WATCH_TICK_MS and tests call it directly. */
  tick(): void {
    const now = this.now();
    this.clock(now);
    const settled = this.settled(now);
    // The clear goes first and only on an open socket: a computer that settles while offline keeps
    // the notice pending, and the room's next `fired` (on reconnect) delivers it.
    if (settled && this.pendingFiredAt !== null && this.deps.send({ t: "cleared", firedAt: this.pendingFiredAt })) {
      this.report(this.pendingFiredAt, true);
    }
    // `active` already carries the idle tail: Sessions.workActive stays true for WATCH_IDLE_MS after
    // the last observation of a running turn, so its first false means the work has been idle long
    // enough and the watch must go. A computer that has just woken is not trusted with a watch yet:
    // a dark wake renews it and sleeps again a minute later, which the room would report as a new outage.
    if (!this.deps.active() || !settled) {
      // The first control frame of a process also clears a watch a previous process may have left.
      if ((this.watching || !this.primed) && this.sendUnwatch()) this.primed = true;
      return;
    }
    if (!this.primed) {
      if (this.sendWatch(now)) this.primed = true;
      return;
    }
    if (this.lastWatchAt === null || now - this.lastWatchAt >= WATCH_RENEW_MS) this.sendWatch(now);
  }

  /** The relay's hello (`undefined`) or its `fired` frame (`firedAt`): answer on this socket. */
  hello(firedAt?: number): void {
    const now = this.now();
    this.clock(now);
    const settled = this.settled(now);
    if (typeof firedAt === "number" && Number.isFinite(firedAt) && firedAt > 0) {
      // A computer that has just woken may be back for under a minute. The room keeps `firedAt`
      // (and raises no new alert) until `cleared`, so holding both the notice and the clear until
      // the computer stays awake turns a night of dark wakes into one "connected again" push.
      if (firedAt === this.reportedAt || settled) this.report(firedAt);
      else {
        if (this.pendingFiredAt !== firedAt) {
          this.pendingFiredAt = firedAt;
          this.log("watch: the computer has just woken; the recovery notice waits until it stays awake");
        }
        // Nothing to state while the outage stands: the room raises no alert until `cleared`, and
        // it answers every watch or unwatch with `fired` again, so a frame here would echo forever.
        return;
      }
    }
    // A new control socket may face a room that still holds whatever the previous one left — an
    // unwatch whose frame died with the old socket looks sent here. So this hello states the
    // current state outright, never "what we believe the room last heard": active renews the
    // watch, idle (or a computer that has only just woken) takes it away, and clears a stale one
    // from a previous process.
    const sent = this.deps.active() && settled ? this.sendWatch(now) : this.sendUnwatch();
    if (sent) this.primed = true;
  }

  /** Push the recovery notice once per outage, then tell the room it may forget `firedAt`. */
  private report(firedAt: number, cleared = false): void {
    this.pendingFiredAt = null;
    if (firedAt !== this.reportedAt) {
      const minutes = outageMinutes(this.now() - firedAt);
      this.reportedAt = firedAt;
      this.saveReported();
      try { void Promise.resolve(this.deps.recover(minutes)).catch((error) => this.log(`watch: recovery push failed: ${message(error)}`)); }
      catch (error) { this.log(`watch: recovery push failed: ${message(error)}`); }
    }
    // Said even for an already reported outage: the room keeps telling until it hears this.
    if (!cleared) this.deps.send({ t: "cleared", firedAt });
  }

  /** Notice a sleep: timers that ran WATCH_WAKE_GAP_MS late mean the computer was not running. */
  private clock(now: number): void {
    if (this.lastClockAt !== null && now - this.lastClockAt >= WATCH_WAKE_GAP_MS) this.wokeAt = now;
    this.lastClockAt = now;
  }

  /** The computer has not slept in this process, or has stayed awake WATCH_SETTLE_MS since it woke. */
  private settled(now: number): boolean {
    return this.wokeAt === null || now - this.wokeAt >= WATCH_SETTLE_MS;
  }

  private sendWatch(now: number): boolean {
    const tokens = this.deps.targets().slice(0, WATCH_TOKENS_MAX);
    // No native device: nothing the relay could tell, so leave no watch behind. The interval still
    // moves, so an empty list does not make this ask every tick.
    if (!tokens.length) {
      // The first frame of a process still clears a stale watch a previous process may have left.
      if (this.watching || !this.primed) this.sendUnwatch();
      this.lastWatchAt = now;
      return true;
    }
    const ok = this.deps.send({ t: "watch", tokens, host: this.deps.host });
    if (ok) { this.lastWatchAt = now; this.watching = true; }
    return ok;
  }

  private sendUnwatch(): boolean {
    const ok = this.deps.send({ t: "unwatch" });
    if (ok) { this.watching = false; this.lastWatchAt = null; }
    return ok;
  }

  private saveReported(): void {
    if (!this.deps.stateFile) return;
    try { writeFileAtomic(this.deps.stateFile, JSON.stringify({ reportedAt: this.reportedAt }, null, 1)); }
    catch (error) { this.log(`watch: state not saved: ${message(error)}`); }
  }

  private log(line: string): void { this.deps.log?.(line); }
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The "Claude login expired" problem is a host state (HostInfo.desktopProblem). One push goes out
 * the first time "problem and work active" holds in an occurrence; a message that changes without
 * clearing is the same occurrence, and a state that clears and starts again is a new one. A problem
 * that appears while nothing is running notifies when work starts while it persists.
 */
export class DesktopProblemAlert {
  private current: string | null;
  /** This occurrence's notice already went out; a later active check must not repeat it. */
  private notified: boolean;
  private readonly active: () => boolean;
  private readonly send: () => Promise<void> | void;
  private readonly log: (line: string) => void;

  constructor(active: () => boolean, send: () => Promise<void> | void, log: (line: string) => void = () => {}) {
    this.active = active;
    this.send = send;
    this.log = log;
    this.current = null;
    this.notified = false;
  }

  /**
   * Returns true when this call sent the notice. Called on every change of either half of the
   * condition (the problem or the work state), so a problem first seen while nothing was running
   * still notifies when work starts while it persists. A clear ends the occurrence.
   */
  update(problem: string | null): boolean {
    if (!problem) {
      this.current = null;
      this.notified = false;
      return false;
    }
    // A message that changes without clearing is still the same occurrence.
    if (this.current === null) this.notified = false;
    this.current = problem;
    if (this.notified || !this.active()) return false;
    this.notified = true;
    try { void Promise.resolve(this.send()).catch((error) => this.log(`login notice failed: ${message(error)}`)); }
    catch (error) { this.log(`login notice failed: ${message(error)}`); }
    return true;
  }
}
