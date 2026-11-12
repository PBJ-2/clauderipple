// Whether the CA is trusted, as the status route reports it, without ever running a check on the
// request path (#159). The check starts a child process (PowerShell on Windows: 0.5 s when healthy,
// minutes when not), and the router answers the proxy and the admin API on one event loop.
//
// A request reads the last answer and, when it is older than `ttlMs`, starts one background check
// (never two). Until the first check lands the answer is `null`: unknown, which the status route
// does not report as a problem, so no false "certificate not trusted" shows while it runs.
// A check that ran out of time says nothing about the certificate, so it keeps the last answer.

export interface PickerTrustOptions {
  /** One check; true/false is an answer, null a check that could not finish. */
  check: () => Promise<boolean | null>;
  ttlMs?: number;
  now?: () => number;
  /** A check that threw. The last answer stays. */
  onError?: (error: unknown) => void;
}

export class PickerTrust {
  private value: boolean | null = null;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private running = false;
  private readonly check: () => Promise<boolean | null>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;

  constructor(options: PickerTrustOptions) {
    this.check = options.check;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  /** The last answer, or null before the first one. Starts a background check when it is due; never waits. */
  get(): boolean | null {
    if (!this.running && this.now() - this.checkedAt >= this.ttlMs) this.refresh();
    return this.value;
  }

  private refresh(): void {
    this.running = true;
    // The next check is due ttlMs after this one started, so a slow one does not stretch the cadence.
    const startedAt = this.now();
    let attempt: Promise<boolean | null>;
    try { attempt = this.check(); }
    catch (error) { attempt = Promise.reject(error); }
    void attempt.then(
      answer => { if (answer !== null) this.value = answer; },
      error => { this.onError(error); },
    ).finally(() => {
      this.checkedAt = startedAt;
      this.running = false;
    });
  }
}
