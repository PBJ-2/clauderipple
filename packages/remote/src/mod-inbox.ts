/**
 * What the mod is asked to do. `prompt` (the default, and the only kind before 2026-11) submits
 * `text` as the next turn. `clear` runs the CLI's own /clear in place and reports the new session id
 * (`itemId` is the queued message's id). `abort` stops the session's running turn (`itemId` is random).
 * `command` runs the slash command `command` (its name, no slash) with `text` as its arguments; a mod
 * that predates it would submit the arguments as a prompt, so it is shown only to a mod that said it
 * knows the kind (`listen`'s capabilities, MOD_CAPS).
 */
export type ModKind = "prompt" | "clear" | "abort" | "command";
export interface ModOffer { sessionId: string; itemId: string; text: string; offeredAt: number; kind?: ModKind; command?: string }
/** What a mod may say it can do when it reads its inbox. Anything else is ignored. */
export const MOD_CAPS: readonly string[] = ["command"];
/** `unknown` is the host's own: a command's result window ran out, so nobody knows whether it ran. The mod only reports the other two. */
export type ModOutcome = "submitted" | "failed" | "unknown";
/** A slash command may run for minutes (/compact), so its result is waited for longer than a prompt's submit. */
export const COMMAND_RESULT_MS = 15 * 60_000;
/** The mod polls its inbox every 1.5 s; a session it has not polled for this long has no mod. */
export const MOD_CONNECTED_MS = 6_000;

type OfferState = { offer: ModOffer; claimed: boolean; resolve: (state: "claimed" | "withdrawn" | "expired") => void; timer: ReturnType<typeof setTimeout> };

/** In-memory arbitration; the claim callback must persist before the winner is told. */
export class ModInbox {
  private offers = new Map<string, OfferState>();
  /** Session → when its mod last read this session's inbox (every poll reads it). */
  private heard = new Map<string, number>();
  /** Session → what its mod announced on its last read (an older mod announces nothing). */
  private caps = new Map<string, Set<string>>();
  private persist: (offer: ModOffer) => boolean;
  private finish: (offer: ModOffer, outcome: ModOutcome) => void;
  private resultMs: number;
  private commandResultMs: number;
  private onError: (error: unknown) => void;
  /** Two minutes: a slow submit hook reported failed while it still runs would invite a resend (2026-10-27). */
  constructor(persist: (offer: ModOffer) => boolean, finish: (offer: ModOffer, outcome: ModOutcome) => void, resultMs = 120_000, onError: (error: unknown) => void = console.error, commandResultMs = COMMAND_RESULT_MS) {
    this.persist = persist; this.finish = finish; this.resultMs = resultMs; this.onError = onError; this.commandResultMs = commandResultMs;
  }

  /** Sets the timer that ends a claimed offer nobody reported on: a prompt failed, a command unknown (it may still be running). */
  private giveUp(itemId: string, offer: ModOffer): ReturnType<typeof setTimeout> {
    const command = offer.kind === "command";
    return setTimeout(() => { try { this.result(itemId, command ? "unknown" : "failed"); } catch (error) { this.onError(error); } }, command ? this.commandResultMs : this.resultMs);
  }

  offer(offer: ModOffer, waitMs: number): Promise<"claimed" | "withdrawn" | "expired"> | null {
    if (this.offers.has(offer.itemId)) return null;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.offers.delete(offer.itemId);
        resolve("expired");
      }, waitMs);
      this.offers.set(offer.itemId, { offer, claimed: false, resolve, timer });
    });
  }

  /** Offers a mod can act on: a kind added after the first mods shipped goes only to one that announced it. */
  pending(sessionId: string): ModOffer[] {
    const caps = this.caps.get(sessionId);
    return [...this.offers.values()]
      .filter(state => !state.claimed && state.offer.sessionId === sessionId && (state.offer.kind !== "command" || caps?.has("command") === true))
      .map(state => ({ ...state.offer }));
  }

  /** Whether the mod has claimed this offer and not yet reported its result. */
  claimed(itemId: string): boolean {
    return this.offers.get(itemId)?.claimed === true;
  }

  /** The mod read this session's inbox: it is connected to the Claude app session for now. */
  listen(sessionId: string, now: number, caps: readonly string[] = []): void {
    this.heard.set(sessionId, now);
    this.caps.set(sessionId, new Set(caps.filter(cap => MOD_CAPS.includes(cap))));
    while (this.heard.size > 200) { const oldest = this.heard.keys().next().value!; this.heard.delete(oldest); this.caps.delete(oldest); }
  }

  /** Whether the session's mod has read its inbox within MOD_CONNECTED_MS. */
  connected(sessionId: string, now: number): boolean {
    const at = this.heard.get(sessionId);
    return at !== undefined && now - at <= MOD_CONNECTED_MS;
  }

  /** Whether the session's mod answers now and announced `cap` on its last read. */
  supports(sessionId: string, cap: string, now: number): boolean {
    return this.connected(sessionId, now) && this.caps.get(sessionId)?.has(cap) === true;
  }

  claim(itemId: string): boolean {
    const state = this.offers.get(itemId);
    if (!state || state.claimed) return false;
    state.claimed = true;
    clearTimeout(state.timer);
    try {
      if (!this.persist(state.offer)) {
        state.claimed = false;
        this.offers.delete(itemId);
        state.resolve("withdrawn");
        return false;
      }
    } catch (error) {
      // Persistence may have reached disk before failing: never fall back to a second writer.
      state.timer = this.giveUp(itemId, state.offer);
      state.resolve("claimed");
      throw error;
    }
    state.timer = this.giveUp(itemId, state.offer);
    state.resolve("claimed");
    return true;
  }

  withdraw(itemId: string): boolean {
    const state = this.offers.get(itemId);
    if (!state || state.claimed) return false;
    clearTimeout(state.timer);
    this.offers.delete(itemId);
    state.resolve("withdrawn");
    return true;
  }

  result(itemId: string, outcome: ModOutcome): boolean {
    const state = this.offers.get(itemId);
    if (!state?.claimed) return false;
    this.finish(state.offer, outcome);
    clearTimeout(state.timer);
    this.offers.delete(itemId);
    return true;
  }

  close(): void {
    for (const [id, state] of this.offers) {
      clearTimeout(state.timer);
      if (!state.claimed) state.resolve("withdrawn");
      this.offers.delete(id);
    }
  }
}
