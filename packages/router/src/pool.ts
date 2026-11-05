// Credential pools and failover: keeping a session alive when one credential, or one provider,
// stops answering.
//
// Two separate problems that share this module because they share a failure vocabulary:
//
//   1. A provider may hold several credentials (API keys, or subscription accounts). When one is
//      rate-limited or rejected, the next one takes over.
//   2. A route may name fallbacks. When a provider is exhausted altogether, the next provider
//      answers instead.
//
// Three rules the implementation is built around:
//
// **Stickiness is not an optimisation, it is the cache.** A conversation that moves to another
// credential moves to a cold prompt cache, and the acceptance metric for this product is ≥90% cache
// hit (ARCHITECTURE §4). So a healthy credential keeps the conversation it already has, and only a
// failure moves it.
//
// **Not every failure deserves a retry.** A 400 is our request being wrong; sending it to every
// credential and then every provider burns the lot and still fails. Only failures that another
// credential could plausibly answer are worth moving for.
//
// **Failover ends at the first byte.** Once any of the answer has reached the client, the turn is
// committed: replacing it mid-stream produces two half-answers spliced together. The caller
// enforces this; `Outcome.retryable` only ever means "if nothing has been sent yet".

import { matchesAccountPin } from "./routing.ts";

export type FailureKind =
  /** Credentials refused. Does not heal on its own. */
  | "auth"
  /** Rate limited. Heals at a known or guessed time. */
  | "rate-limit"
  /** Out of credit. Heals when someone tops it up, so a long cooldown rather than a quarantine. */
  | "exhausted"
  /** Upstream broke or was unreachable. Usually brief. */
  | "transient";

export type Verdict =
  | { retryable: true; kind: FailureKind; cooldownMs: number; quarantine: boolean }
  | { retryable: false; reason: string };

/** A rate limit with no stated reset. Long enough not to hammer, short enough to recover a session. */
const DEFAULT_RATE_LIMIT_MS = 60_000;
/** How long an idle conversation, or a rememberable answer, keeps its claim on a credential. */
const DEFAULT_STICKY_MS = 60 * 60_000;
const TRANSIENT_MS = 10_000;
const EXHAUSTED_MS = 30 * 60_000;
/** A relay passing on its upstream's failure; whatever status it chose, the credential did nothing. */
export const RELAY_UPSTREAM_FAILED = /upstream (request )?failed/i;
/** A `Retry-After` beyond this is treated as "not within this session"; the credential is parked. */
const MAX_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * What an upstream status means for the credential that produced it. `retryAfterMs` comes from a
 * `Retry-After` header or a vendor reset field when there is one; guessing is a last resort.
 */
export function classify(status: number, retryAfterMs?: number, body = ""): Verdict {
  const bounded = (ms: number): number => Math.max(1_000, Math.min(MAX_COOLDOWN_MS, Math.round(ms)));
  // #101: this relay 400 names the workspace's opt-in, not the request shape. Another key can
  // answer it. Do not generalise to every relay/server_error 400: malformed requests still stop.
  if (status === 400 && RELAY_UPSTREAM_FAILED.test(body)) {
    let error: { type?: unknown; message?: unknown } | undefined;
    try { error = (JSON.parse(body) as { error?: typeof error } | null)?.error; } catch { /* not the measured JSON refusal */ }
    if (error?.type === "server_error" && typeof error.message === "string" &&
        RELAY_UPSTREAM_FAILED.test(error.message) && /This Go model requires Global regions\b/i.test(error.message)) {
      return { retryable: true, kind: "auth", cooldownMs: bounded(retryAfterMs ?? DEFAULT_RATE_LIMIT_MS), quarantine: false };
    }
  }
  // 401 is the credential being rejected, and that does not heal: park it.
  if (status === 401) return { retryable: true, kind: "auth", cooldownMs: 0, quarantine: true };
  // 403 is not only that. It is also a content policy, a blocked region, a model the account may
  // not use, or an edge refusing what it took for a bot — none of which mean the key is dead.
  // Parking a working credential until someone notices is the worse mistake, so this waits instead.
  if (status === 403) {
    // Except when the vendor says the refusal was not about us. A relay passing on a broken upstream
    // answers 403, and that is not a statement about the credential at all: charging it a minute of
    // cooldown made every turn in that minute come back to the user as an authentication error
    // (2026-09-21, OpenCode Go relaying a 403 for DeepSeek). The credential did nothing, so it is
    // held for no time at all rather than for a shorter time — any cooldown at all would move the
    // conversation to another credential and take the prompt cache with it (§4). `bounded` is
    // bypassed deliberately: its one-second floor is exactly the cache cost this avoids.
    if (RELAY_UPSTREAM_FAILED.test(body)) {
      return { retryable: true, kind: "transient", cooldownMs: 0, quarantine: false };
    }
    return { retryable: true, kind: "auth", cooldownMs: bounded(retryAfterMs ?? DEFAULT_RATE_LIMIT_MS), quarantine: false };
  }
  if (status === 429) return { retryable: true, kind: "rate-limit", cooldownMs: bounded(retryAfterMs ?? DEFAULT_RATE_LIMIT_MS), quarantine: false };
  // The same relay answers 402 for a model whose own endpoint is down ("server_error … Upstream
  // request failed: Endpoint is unavailable", OpenCode Go for minimax-m3.1-flash-free, 2026-10-22).
  // That is no statement about money: read as exhaustion it parked the whole account for half an
  // hour and its other models with it.
  if (status === 402 && RELAY_UPSTREAM_FAILED.test(body)) return { retryable: true, kind: "transient", cooldownMs: 0, quarantine: false };
  if (status === 402) return { retryable: true, kind: "exhausted", cooldownMs: bounded(retryAfterMs ?? EXHAUSTED_MS), quarantine: false };
  // 408 and 425 are the server saying "ask again"; 5xx is the server being broken. Both may work
  // somewhere else. 501 and 505 are the server saying it will never do this, so they are not here.
  if (status === 408 || status === 425 || (status >= 500 && status !== 501 && status !== 505)) {
    return { retryable: true, kind: "transient", cooldownMs: bounded(retryAfterMs ?? TRANSIENT_MS), quarantine: false };
  }
  // 0 is our own connect/DNS failure: nothing reached the provider, so another one may still work.
  if (status === 0) return { retryable: true, kind: "transient", cooldownMs: TRANSIENT_MS, quarantine: false };
  // Everything else is the request itself — a bad body, an unknown model, an oversized payload.
  // Another credential would reject it the same way, so stop.
  return { retryable: false, reason: `status ${status} is not a credential or provider problem` };
}

/**
 * A vendor's own account of when to come back, from `retry-after` (seconds, or an HTTP date) or a
 * vendor reset field. Preferred over a guess, and ignored when it is not a number we can use.
 */
export function retryAfterMs(headers: Record<string, string | string[] | undefined>): number | undefined {
  const pick = (name: string): string | undefined => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const header = pick("retry-after");
  if (header) {
    const seconds = Number(header);
    // Anything numeric is seconds, including a negative one — which is not a wait, and must not
    // fall through to the date branch, where `Date.parse("-5")` succeeds and means something else.
    if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  // The Codex backend states its window this way rather than with retry-after.
  const codex = Number(pick("x-codex-primary-reset-after-seconds"));
  if (Number.isFinite(codex) && codex >= 0) return codex * 1000;
  return undefined;
}

/** A single usable credential. `id` keys runtime health; `ownerId` identifies its durable account. */
export type Credential = { id: string; headers: Record<string, string>; label?: string; ownerId?: string; preferred?: boolean; paused?: boolean };

type Health = { cooldownUntil: number; quarantined: boolean; failures: number };

export type CredentialReport = {
  id: string;
  label?: string;
  state: "ready" | "cooling" | "quarantined";
  /** Seconds until this credential is usable again; absent when it is ready or quarantined. */
  cooldownSeconds?: number;
  failures: number;
  paused: boolean;
  preferred: boolean;
  inUse: boolean;
};

/**
 * Health and stickiness for one router's credentials, keyed `provider/credential`. In memory only:
 * a cooldown that outlived a restart would be a restart that made things worse, and a quarantine is
 * re-earned on the first request anyway.
 *
 * An operator changing which credential is preferred is the one move allowed to break a healthy
 * affinity: the owner asked for that account, so held conversations re-pick it on their next turn.
 * A credential merely recovering from a cooldown is not such a move, and neither is removing the
 * preference.
 */
export class CredentialPool {
  private readonly health = new Map<string, Health>();
  /** (provider, conversation) → durable owner id (or runtime id), preserving each provider's cache. */
  private readonly sticky = new Map<string, { ownerId: string; at: number }>();
  /** The preferred owner id each provider was last seen with, so a change re-picks held conversations. */
  private readonly lastPreferred = new Map<string, string>();
  private readonly now: () => number;
  /** How long an idle conversation keeps its claim on a credential. */
  private readonly stickyTtlMs: number;

  constructor(opts: { now?: () => number; stickyTtlMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.stickyTtlMs = opts.stickyTtlMs ?? DEFAULT_STICKY_MS;
  }

  private key(provider: string, id: string): string { return `${provider}/${id}`; }

  /** A conversation's claim, scoped by provider so one provider's preference change cannot touch another's. */
  private stickyKey(provider: string, conversation: string): string { return `${provider}\u0000${conversation}`; }

  private healthOf(provider: string, id: string): Health {
    const key = this.key(provider, id);
    let h = this.health.get(key);
    if (!h) { h = { cooldownUntil: 0, quarantined: false, failures: 0 }; this.health.set(key, h); }
    return h;
  }

  /**
   * A quota scope's health lives beside the credential's own, under `provider/credential#scope`. A
   * scope is a part of one credential's quota that runs out on its own: Antigravity counts Gemini
   * models and Claude/GPT models separately, and one group at 100% must not rest the other.
   */
  private scopedKey(provider: string, id: string, scope: string): string { return `${this.key(provider, id)}#${scope}`; }

  private scopedHealthOf(provider: string, id: string, scope: string): Health {
    const key = this.scopedKey(provider, id, scope);
    let h = this.health.get(key);
    if (!h) { h = { cooldownUntil: 0, quarantined: false, failures: 0 }; this.health.set(key, h); }
    return h;
  }

  private usable(provider: string, id: string, scope?: string): boolean {
    const h = this.healthOf(provider, id);
    if (h.quarantined || h.cooldownUntil > this.now()) return false;
    if (!scope) return true;
    return (this.health.get(this.scopedKey(provider, id, scope))?.cooldownUntil ?? 0) <= this.now();
  }

  /**
   * The credential to use, or null when every one of them is cooling or quarantined. The
   * conversation's existing credential wins while it is healthy; otherwise the first usable one in
   * configured order, which makes the order meaningful rather than incidental. With a `scope`, a
   * credential whose quota for that scope is resting is skipped too.
   *
   * A change of preferred owner is applied before the held claim is read, so a conversation the
   * operator has moved re-picks the new account right here rather than one turn later.
   */
  pick(provider: string, credentials: readonly Credential[], conversation?: string, scope?: string): Credential | null {
    if (credentials.length === 0) return null;
    this.expireSticky();
    this.observePreference(provider, credentials);
    const stickyKey = conversation ? this.stickyKey(provider, conversation) : "";
    if (conversation) {
      const held = this.sticky.get(stickyKey);
      if (held) {
        const current = credentials.find((c) => (c.ownerId ?? c.id) === held.ownerId);
        if (current && !current.paused && this.usable(provider, current.id, scope)) {
          held.at = this.now();
          return current;
        }
      }
    }
    const usable = (c: Credential): boolean => !c.paused && this.usable(provider, c.id, scope);
    const next = credentials.find((c) => c.preferred && usable(c)) ?? credentials.find(usable);
    if (!next) return null;
    if (conversation) this.sticky.set(stickyKey, { ownerId: next.ownerId ?? next.id, at: this.now() });
    return next;
  }

  /**
   * Note which credential this provider now calls preferred, whether or not it is usable: a cooldown
   * ending is not a preference change. A defined owner that differs from the last one seen — including
   * the first one seen after no preference at all — drops the provider's held conversations, so each
   * re-picks; a preference change deliberately costs those conversations one cold prompt cache.
   * Removing the preference is a change too: the owner is asking for the configured order back, so
   * held conversations re-pick from it. Until 0.12.27 a removal moved nothing, and conversations
   * kept running on the account the owner had just stopped preferring (2026-11-05). Only a list that
   * still holds the last preferred owner, now unmarked, proves a removal: a retry's list leaves out
   * the credential it already tried.
   */
  private observePreference(provider: string, credentials: readonly Credential[]): void {
    const preferred = credentials.find((c) => c.preferred);
    if (!preferred) {
      const seen = this.lastPreferred.get(provider);
      if (seen !== undefined && credentials.some((c) => (c.ownerId ?? c.id) === seen)) {
        this.lastPreferred.delete(provider);
        this.dropSticky(provider);
      }
      return;
    }
    const ownerId = preferred.ownerId ?? preferred.id;
    const seen = this.lastPreferred.get(provider);
    this.lastPreferred.set(provider, ownerId);
    if (seen !== ownerId) this.dropSticky(provider);
  }

  /** Drop this provider's held conversations; another provider's claims must survive it. */
  private dropSticky(provider: string): void {
    const prefix = this.stickyKey(provider, "");
    for (const key of this.sticky.keys()) if (key.startsWith(prefix)) this.sticky.delete(key);
  }

  /**
   * Whether this provider has any credential that could answer right now. Asked before a turn is
   * committed to a provider, so a session whose primary is rate-limited for the next hour goes to
   * its fallback instead of failing once per request until the window resets.
   */
  hasUsable(provider: string, credentials: readonly Credential[], scope?: string): boolean {
    return credentials.some((c) => !c.paused && this.usable(provider, c.id, scope));
  }

  /**
   * Record a failure. Returns the verdict so the caller can decide whether to try the next one.
   *
   * With a `scope`, a rate limit rests only that scope of the credential: the vendor said one quota
   * group is spent, not that the credential is. Every other failure (a refused credential, a 402, a
   * broken upstream) is still about the whole credential and rests all of it.
   */
  penalise(provider: string, id: string, status: number, retryAfterMs?: number, body = "", scope?: string): Verdict {
    const verdict = classify(status, retryAfterMs, body);
    if (!verdict.retryable) return verdict;
    const h = scope && verdict.kind === "rate-limit" ? this.scopedHealthOf(provider, id, scope) : this.healthOf(provider, id);
    h.failures++;
    if (verdict.quarantine) h.quarantined = true;
    else h.cooldownUntil = Math.max(h.cooldownUntil, this.now() + verdict.cooldownMs);
    return verdict;
  }

  /**
   * A credential that answered is not rejected, so a quarantine lifts and the failure count resets.
   *
   * An unexpired cooldown is left alone. Requests overlap, and a 200 arriving after a concurrent
   * 429 does not mean the rate limit went away — clearing it here would send the next turn straight
   * back into the limit. The cooldown expires on its own soon enough. The same holds for the scope
   * the answer was in.
   */
  succeed(provider: string, id: string, scope?: string): void {
    const h = this.healthOf(provider, id);
    if (h.cooldownUntil <= this.now()) h.cooldownUntil = 0;
    h.quarantined = false;
    h.failures = 0;
    const scoped = scope ? this.health.get(this.scopedKey(provider, id, scope)) : undefined;
    if (scoped && scoped.cooldownUntil <= this.now()) this.health.delete(this.scopedKey(provider, id, scope!));
  }

  /** Operator action from the dashboard: give a parked credential, and all its scopes, another chance now. */
  clear(provider: string, id?: string): void {
    if (id) {
      const key = this.key(provider, id);
      for (const k of [...this.health.keys()]) if (k === key || k.startsWith(`${key}#`)) this.health.delete(k);
      return;
    }
    for (const key of [...this.health.keys()]) if (key.startsWith(`${provider}/`)) this.health.delete(key);
  }

  /** Clear every token generation of one durable login, including a paused or expired one, and its scopes. */
  clearOwner(provider: string, ownerId: string): void {
    const prefix = `${this.key(provider, ownerId)}:`;
    for (const key of this.health.keys()) if (key.startsWith(prefix)) this.health.delete(key);
  }

  /** Seconds until each resting scope of one credential is usable again; empty when none rests. */
  scopeCooldowns(provider: string, id: string): Record<string, number> {
    const now = this.now();
    const prefix = `${this.key(provider, id)}#`;
    const out: Record<string, number> = {};
    for (const [key, h] of this.health) {
      if (key.startsWith(prefix) && h.cooldownUntil > now) out[key.slice(prefix.length)] = Math.ceil((h.cooldownUntil - now) / 1000);
    }
    return out;
  }

  /** For the Health screen: why a credential is not being used, and for how long. */
  report(provider: string, credentials: readonly Credential[]): CredentialReport[] {
    const now = this.now();
    const inUse = this.pick(provider, credentials)?.id;
    return credentials.map((c) => {
      const h = this.healthOf(provider, c.id);
      const cooling = !h.quarantined && h.cooldownUntil > now;
      return {
        id: c.id,
        ...(c.label ? { label: c.label } : {}),
        state: h.quarantined ? "quarantined" : cooling ? "cooling" : "ready",
        ...(cooling ? { cooldownSeconds: Math.ceil((h.cooldownUntil - now) / 1000) } : {}),
        failures: h.failures,
        paused: c.paused === true,
        preferred: c.preferred === true,
        inUse: c.id === inUse,
      };
    });
  }

  private expireSticky(): void {
    const cutoff = this.now() - this.stickyTtlMs;
    for (const [conversation, held] of this.sticky) if (held.at < cutoff) this.sticky.delete(conversation);
  }
}

/**
 * The credential a resolved route pins, when it is present and usable. This is the one answer for
 * every provider whose turn picks among stored accounts (Claude OAuth, ChatGPT, Google Antigravity):
 * a pinned account that is absent, paused, cooling or quarantined returns undefined, and the caller
 * takes its ordinary pick, so a pin never fails a turn. A quota `scope` rests only that part of the
 * account, as `hasUsable` does. `tried` is the caller's business: hand it a list without the
 * accounts this turn already spent, and the pin is honoured first and then falls back like the rest.
 */
export function pinnedCredential<T extends Credential>(provider: string, credentials: readonly T[], pin: string | undefined, pool: CredentialPool, scope?: string): T | undefined {
  if (!pin) return undefined;
  const pinned = credentials.find((credential) => matchesAccountPin(credential.ownerId, pin));
  return pinned && pool.hasUsable(provider, [pinned], scope) ? pinned : undefined;
}

/**
 * Which conversation produced a given assistant message id, for server-side thread continuation.
 *
 * A `continue` carries only the new messages (tool results and attachments), so its first user
 * message is not the conversation's and the conversation key computed from the request is a new
 * one every turn. A pool would then start a fresh affinity and pick the preferred account, while
 * the thread lives on the account that produced `previous_message_id` (measured 2026-11-04: every
 * turn spent a 404 `thread_not_found` and a full replay). Remembering the producing conversation's
 * key lets the continue ask the pool for that same key. Process memory only, bounded by the same
 * TTL as an idle conversation and by a size cap; an unknown id keeps the computed key.
 */
export class ThreadAffinity {
  private readonly entries = new Map<string, { key: string; at: number }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_STICKY_MS;
    this.maxEntries = opts.maxEntries ?? 20_000;
  }

  remember(messageId: string, conversation: string): void {
    this.prune();
    // Re-insert so the oldest-eviction order reflects the latest use.
    this.entries.delete(messageId);
    this.entries.set(messageId, { key: conversation, at: this.now() });
    for (const id of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(id);
    }
  }

  lookup(messageId: string): string | undefined {
    const entry = this.entries.get(messageId);
    if (!entry) return undefined;
    if (entry.at < this.now() - this.ttlMs) {
      this.entries.delete(messageId);
      return undefined;
    }
    return entry.key;
  }

  get size(): number { return this.entries.size; }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) if (entry.at < cutoff) this.entries.delete(id);
  }
}

/** One place a turn can be sent: a provider, a model, and the effort to ask for. */
export type Target = { provider: string; model: string; effort?: string; tag: string };

/**
 * The targets to try, in order, with duplicates removed. A fallback naming the same provider and
 * model as one already in the list is a configuration mistake rather than a second chance.
 */
export function targets(primary: Target, fallbacks: readonly Omit<Target, "tag">[] = []): Target[] {
  const out: Target[] = [primary];
  for (const f of fallbacks) {
    if (out.some((t) => t.provider === f.provider && t.model === f.model)) continue;
    out.push({ ...f, tag: `${f.provider}/${f.model}` });
  }
  return out;
}
