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
const TRANSIENT_MS = 10_000;
const EXHAUSTED_MS = 30 * 60_000;
/** A `Retry-After` beyond this is treated as "not within this session"; the credential is parked. */
const MAX_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * What an upstream status means for the credential that produced it. `retryAfterMs` comes from a
 * `Retry-After` header or a vendor reset field when there is one; guessing is a last resort.
 */
export function classify(status: number, retryAfterMs?: number): Verdict {
  const bounded = (ms: number): number => Math.max(1_000, Math.min(MAX_COOLDOWN_MS, Math.round(ms)));
  // 401 is the credential being rejected, and that does not heal: park it.
  if (status === 401) return { retryable: true, kind: "auth", cooldownMs: 0, quarantine: true };
  // 403 is not only that. It is also a content policy, a blocked region, a model the account may
  // not use, or an edge refusing what it took for a bot — none of which mean the key is dead.
  // Parking a working credential until someone notices is the worse mistake, so this waits instead.
  if (status === 403) return { retryable: true, kind: "auth", cooldownMs: bounded(retryAfterMs ?? DEFAULT_RATE_LIMIT_MS), quarantine: false };
  if (status === 429) return { retryable: true, kind: "rate-limit", cooldownMs: bounded(retryAfterMs ?? DEFAULT_RATE_LIMIT_MS), quarantine: false };
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
export type Credential = { id: string; headers: Record<string, string>; label?: string; ownerId?: string };

type Health = { cooldownUntil: number; quarantined: boolean; failures: number };

export type CredentialReport = {
  id: string;
  label?: string;
  state: "ready" | "cooling" | "quarantined";
  /** Seconds until this credential is usable again; absent when it is ready or quarantined. */
  cooldownSeconds?: number;
  failures: number;
};

/**
 * Health and stickiness for one router's credentials, keyed `provider/credential`. In memory only:
 * a cooldown that outlived a restart would be a restart that made things worse, and a quarantine is
 * re-earned on the first request anyway.
 */
export class CredentialPool {
  private readonly health = new Map<string, Health>();
  /** conversation → durable owner id (or runtime id when there is no owner), preserving its cache across token refreshes. */
  private readonly sticky = new Map<string, { provider: string; ownerId: string; at: number }>();
  private readonly now: () => number;
  /** How long an idle conversation keeps its claim on a credential. */
  private readonly stickyTtlMs: number;

  constructor(opts: { now?: () => number; stickyTtlMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.stickyTtlMs = opts.stickyTtlMs ?? 60 * 60_000;
  }

  private key(provider: string, id: string): string { return `${provider}/${id}`; }

  private healthOf(provider: string, id: string): Health {
    const key = this.key(provider, id);
    let h = this.health.get(key);
    if (!h) { h = { cooldownUntil: 0, quarantined: false, failures: 0 }; this.health.set(key, h); }
    return h;
  }

  private usable(provider: string, id: string): boolean {
    const h = this.healthOf(provider, id);
    return !h.quarantined && h.cooldownUntil <= this.now();
  }

  /**
   * The credential to use, or null when every one of them is cooling or quarantined. The
   * conversation's existing credential wins while it is healthy; otherwise the first usable one in
   * configured order, which makes the order meaningful rather than incidental.
   */
  pick(provider: string, credentials: readonly Credential[], conversation?: string): Credential | null {
    if (credentials.length === 0) return null;
    this.expireSticky();
    if (conversation) {
      const held = this.sticky.get(conversation);
      if (held && held.provider === provider) {
        const current = credentials.find((c) => (c.ownerId ?? c.id) === held.ownerId);
        if (current && this.usable(provider, current.id)) {
          held.at = this.now();
          return current;
        }
      }
    }
    const next = credentials.find((c) => this.usable(provider, c.id));
    if (!next) return null;
    if (conversation) this.sticky.set(conversation, { provider, ownerId: next.ownerId ?? next.id, at: this.now() });
    return next;
  }

  /**
   * Whether this provider has any credential that could answer right now. Asked before a turn is
   * committed to a provider, so a session whose primary is rate-limited for the next hour goes to
   * its fallback instead of failing once per request until the window resets.
   */
  hasUsable(provider: string, credentials: readonly Credential[]): boolean {
    return credentials.some((c) => this.usable(provider, c.id));
  }

  /** Record a failure. Returns the verdict so the caller can decide whether to try the next one. */
  penalise(provider: string, id: string, status: number, retryAfterMs?: number): Verdict {
    const verdict = classify(status, retryAfterMs);
    if (!verdict.retryable) return verdict;
    const h = this.healthOf(provider, id);
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
   * back into the limit. The cooldown expires on its own soon enough.
   */
  succeed(provider: string, id: string): void {
    const h = this.healthOf(provider, id);
    if (h.cooldownUntil <= this.now()) h.cooldownUntil = 0;
    h.quarantined = false;
    h.failures = 0;
  }

  /** Operator action from the dashboard: give a parked credential another chance now. */
  clear(provider: string, id?: string): void {
    if (id) { this.health.delete(this.key(provider, id)); return; }
    for (const key of [...this.health.keys()]) if (key.startsWith(`${provider}/`)) this.health.delete(key);
  }

  /** For the Health screen: why a credential is not being used, and for how long. */
  report(provider: string, credentials: readonly Credential[]): CredentialReport[] {
    const now = this.now();
    return credentials.map((c) => {
      const h = this.healthOf(provider, c.id);
      const cooling = !h.quarantined && h.cooldownUntil > now;
      return {
        id: c.id,
        ...(c.label ? { label: c.label } : {}),
        state: h.quarantined ? "quarantined" : cooling ? "cooling" : "ready",
        ...(cooling ? { cooldownSeconds: Math.ceil((h.cooldownUntil - now) / 1000) } : {}),
        failures: h.failures,
      };
    });
  }

  private expireSticky(): void {
    const cutoff = this.now() - this.stickyTtlMs;
    for (const [conversation, held] of this.sticky) if (held.at < cutoff) this.sticky.delete(conversation);
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
