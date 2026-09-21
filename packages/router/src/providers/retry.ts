// Retrying a translated provider before its turn is committed.
//
// A provider behind a relay fails for reasons that have nothing to do with the request: the relay's
// own upstream breaks, an edge hiccups, a connection is refused. The user then sees an error, asks
// again, and the identical request succeeds — which is the whole evidence that the request was
// never the problem (2026-09-21, OpenCode Go relaying DeepSeek: every failing turn answered 403
// `Upstream request failed`, and every retry by hand worked).
//
// Only a failure another attempt could answer is retried. `classify` already owns that judgement
// for what failed — a 400 is our request being wrong and is refused everywhere, a 403 wrapping a
// relay's broken upstream is not about us at all. Reusing it keeps one vocabulary rather than two.
//
// It is not quite the same question, though, and the difference is the whole of `isWorthRetrying`.
// `classify` answers it for a *pool*: a 401 is retryable because another credential could answer.
// Here there is only the one credential the adapter already holds, so a 401 would be re-sent — nine
// times — to the key that just refused it, and a 429 to the limit that just refused it. Those fail
// identically on every attempt and only delay the error the user eventually sees. What is left is
// `transient`: a connect failure, a 502/503/504, a relay with a broken upstream. Those are the ones
// where the identical request genuinely succeeds a moment later.
//
// **Nothing may have been written to the client.** This is called around the `fetch` alone, before
// any status or byte is sent, so a retry cannot splice two answers together. Once the first byte is
// out the turn is committed and this must not be used.

import { setTimeout as sleep } from "node:timers/promises";

import { classify } from "../pool.ts";

/** Attempts in total — one ask plus nine retries, matching the CLI's own ceiling (2026-09-21). */
export const DEFAULT_ATTEMPTS = 10;

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 2_000;

/**
 * 250ms, 500ms, 1s, then 2s each. A hiccup is absorbed in a blink, which is the observed case; a
 * sustained outage is not hammered, and the ceiling is deliberately low so a dead relay fails to the
 * user in seconds rather than tens of them.
 */
function backoffMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
}

/** Whether asking the same provider the identical request again could plausibly work. */
function isWorthRetrying(status: number, text: string): boolean {
  const verdict = classify(status, undefined, text);
  return verdict.retryable && verdict.kind === "transient";
}

/** Wait between attempts, but stop immediately when the client abandons the turn. */
async function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  await sleep(ms, undefined, signal ? { signal } : undefined);
}

/**
 * Ask until an answer arrives, a status says asking again is pointless, or the attempt ceiling is
 * reached. The last `Response` is returned either way, so the caller still reports the vendor's own
 * refusal when retrying was not going to help.
 *
 * `init.body` must be reusable (a string or buffer). A stream would already have been consumed.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { log: (line: string) => void; attempts?: number },
): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  for (let n = 1; n <= attempts; n++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // An abort is the client going away, not the provider: retrying it would keep working on a
      // turn nobody is waiting for.
      if (init.signal?.aborted) throw e;
      if (n === attempts) throw e;
      opts.log(`attempt ${n}/${attempts} could not connect (${(e as Error).message}); retrying`);
      await wait(backoffMs(n), init.signal);
      continue;
    }
    if (res.ok) return res;
    // A 403's meaning is in its body and a relay reports its own broken upstream there; every other
    // status is judged from the status alone. Cloned rather than read, so the caller still gets the
    // body to show when this attempt turns out to be the last one.
    const text = res.status === 403 ? await res.clone().text().catch(() => "") : "";
    if (!isWorthRetrying(res.status, text) || n === attempts) return res;
    // This response will never reach the caller. Cancel it before opening another request so a relay
    // with a slow or unbounded error body cannot hold one connection per discarded attempt.
    await res.body?.cancel().catch(() => {});
    opts.log(`attempt ${n}/${attempts}: upstream ${res.status} (transient); retrying`);
    await wait(backoffMs(n), init.signal);
  }
  // Unreachable: the loop returns or throws on its last iteration.
  throw new Error("retry loop fell through");
}
