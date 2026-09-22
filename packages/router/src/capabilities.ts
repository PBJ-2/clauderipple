// Measure what a model's capability actually is, by making it answer.
//
// A vendor's `/models` tells you ids, not capabilities. OpenCode Go reports only `id`, `object`,
// `created` and `owned_by` (measured 2026-09-22), yet one subscription serves several wires on one
// key: `/responses` for Muse Spark, `/chat/completions` for MiMo, `/messages` for MiniMax. The
// route a model is on is only knowable by asking it — `mimo-v2.6-pro` answered 503 on `/responses`
// and 200 on `/chat/completions`, while `muse-spark-1.3-contributor` answered the other way round
// (measured 2026-09-22). A model sent down the wrong wire reads to the user as an unexplained 529.
//
// The same is true of reasoning effort: `mimo-v2.6-pro` accepted `none`/`low`/`medium`/`high` and
// refused `minimal`/`xhigh` with 400 "Invalid request parameters" (measured 2026-09-22). The
// provider's whole ladder handed to every model therefore offers the GUI steps that fail.
//
// This module is pure: every network call goes through `deps.fetch`, so a test can drive it with a
// stub and nothing here reaches the network on its own.

import crypto from "node:crypto";

/** One wire to try for a model, and the base URL that wire is served on. */
export type WireCandidate = { wire: "chat" | "responses" | "anthropic"; url: string; authHeader?: "x-api-key" | "authorization-bearer" };

/** What a measurement found. `wire` is set only when a wire actually answered; on any failure the
 * result carries `error` and no `wire`, so a caller can never mistake a guess for a measurement. */
export type Measured = { id: string; wire?: "chat" | "responses" | "anthropic"; effortLevels?: string[]; error?: string };

export type MeasureDeps = { fetch: (url: string, init: RequestInit) => Promise<Response>; sessionHeader?: string; headers?: Record<string, string> };

/** The endpoint a wire appends to a base. Matches what the router itself sends: `endpoint()` in
 * providers/openai/index.ts, and `messagesUrl()` in admin.ts for the Anthropic wire. */
function endpointFor(wire: WireCandidate["wire"], base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (wire === "chat") return `${trimmed}/chat/completions`;
  if (wire === "responses") return `${trimmed}/responses`;
  return `${trimmed}/v1/messages`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * The provider's own key, re-sent under the header this wire expects.
 *
 * Same rule as `reauthorized` in config.ts: only the auth header is replaced and every other header
 * is kept, because sending both conventions at once would hand the endpoint a credential it did not
 * ask for. Nothing recognisable to move means the headers are left exactly as they were rather than
 * inventing an empty credential, which would read as a missing key instead of a config error.
 */
function authHeaders(candidate: WireCandidate, headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = { ...(headers ?? {}) };
  if (!candidate.authHeader) return out;
  let key: string | undefined;
  for (const [name, value] of Object.entries(out)) {
    const lower = name.toLowerCase();
    if (lower === "x-api-key") { key ??= value; delete out[name]; }
    else if (lower === "authorization") { key ??= value.replace(/^Bearer\s+/i, ""); delete out[name]; }
  }
  if (key === undefined) return { ...(headers ?? {}) };
  if (candidate.authHeader === "x-api-key") out["x-api-key"] = key;
  else out.authorization = `Bearer ${key}`;
  return out;
}

function requestHeaders(candidate: WireCandidate, deps: MeasureDeps): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", ...authHeaders(candidate, deps.headers) };
  // Some vendors gate on the session header: OpenCode Go answers 400 `MissingSessionID` without
  // `x-opencode-session` (measured 2026-09-18), so a measurement that omitted it would report a
  // working provider as broken. A fresh value per request, the same random-per-request shape
  // admin.ts's probeProvider uses.
  if (deps.sessionHeader) headers[deps.sessionHeader] = `measure-${crypto.randomBytes(8).toString("hex")}`;
  return headers;
}

/**
 * The smallest request each wire accepts, shaped exactly as the router sends it.
 *
 * Effort travels the way that wire carries it: `reasoning_effort` for Chat Completions and
 * `reasoning: { effort }` for Responses (providers/openai/translate.ts), and Anthropic Messages
 * carries it as `output_config.effort`, which the anthropic-compatible adapter sanitises
 * (compat.ts, `sanitizeForCompatible`).
 */
function requestBody(wire: WireCandidate["wire"], id: string, effort?: string): string {
  if (wire === "chat") {
    return JSON.stringify({ model: id, max_tokens: 1, stream: false, messages: [{ role: "user", content: "hi" }], ...(effort ? { reasoning_effort: effort } : {}) });
  }
  if (wire === "responses") {
    // Sixteen, not one: Responses refuses anything smaller with a 400 naming `max_output_tokens`
    // (measured 2026-09-22 against OpenCode Go). Asking for one token there made every model on
    // this wire look like it did not serve the wire at all, and every effort level look refused.
    return JSON.stringify({ model: id, max_output_tokens: 16, input: "hi", ...(effort ? { reasoning: { effort } } : {}) });
  }
  return JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: "user", content: "hi" }], ...(effort ? { output_config: { effort } } : {}) });
}

/**
 * Every effort level seen named by any endpoint here, weakest first.
 *
 * A model can take a level its provider's configured ladder never lists: measured 2026-09-22,
 * `deepseek-v4.1-flash` answers 200 to `max`, which is absent from the OpenCode Go ladder, so
 * measuring only what the provider declared could narrow a ladder but never widen one and the level
 * stayed invisible. The candidate set has to be wider than the configuration it is correcting.
 */
const KNOWN_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"];

/** A value no vendor defines, sent to make the endpoint name the ones it does. */
const NOT_A_LEVEL = "clauderipple-probe";

/** A refusal of the level itself, as opposed to anything that merely went wrong. OpenCode Go answers
 * 400 for one model and 422 for another (measured 2026-09-22), so both count. */
function refusedLevel(status: number): boolean {
  return status === 400 || status === 422;
}

/**
 * A refusal aimed at the plan rather than the credential.
 *
 * Measured 2026-09-22: OpenCode answers 403 FreeTierError, "OpenCode's free tier can only be used
 * from within OpenCode", for every model whose id ends in `-free`. The key is accepted and the
 * model exists; it simply cannot be reached from here, ever. Reading that as an auth failure sends
 * the operator to re-check a key that is fine and leaves the model looking merely unmeasured.
 */
export function refusedByPlan(detail: string): boolean {
  return /free.?tier|data.?policy|region|entitle|upgrade|subscription/i.test(detail);
}

/**
 * The levels worth trying: what the endpoint says it takes, else everything known.
 *
 * Asked for a level that cannot exist, some endpoints answer with their whole list — "expected one
 * of `none`, `minimal`, … `ultra`, `max`", or "Supported values: [minimal, low, … max]" (measured
 * 2026-09-22). That is a candidate list and nothing more: `muse-spark-1.3-contributor` names `max`
 * among its supported values and then refuses it with a 400, so what a level actually does is still
 * settled by sending it.
 */
async function candidateLevels(id: string, candidate: WireCandidate, ladder: string[], deps: MeasureDeps): Promise<string[]> {
  let listed: string[] = [];
  try {
    const response = await deps.fetch(endpointFor(candidate.wire, candidate.url), { method: "POST", headers: requestHeaders(candidate, deps), body: requestBody(candidate.wire, id, NOT_A_LEVEL) });
    if (!response.ok) listed = parseLevels(await response.text());
  } catch { /* the endpoint said nothing; fall back to everything known */ }
  const wanted = listed.length > 0 ? listed : [...ladder, ...KNOWN_EFFORTS];
  const seen = new Set(wanted);
  // Canonical order first so the GUI reads weakest to strongest, then anything newly named.
  return [...KNOWN_EFFORTS.filter((level) => seen.has(level)), ...wanted.filter((level) => !KNOWN_EFFORTS.includes(level))]
    .filter((level, index, all) => all.indexOf(level) === index);
}

/** The levels an endpoint listed in its complaint, or nothing when it did not list any. */
export function parseLevels(message: string): string[] {
  const listed = /supported values:\s*\[([^\]]+)\]/i.exec(message)?.[1] ?? /expected one of\s+(.+?)(?:\s+at line\b|$)/i.exec(message)?.[1];
  if (!listed) return [];
  return [...listed.matchAll(/[A-Za-z][A-Za-z0-9_-]*/g)].map((match) => match[0].toLowerCase()).filter((level) => level !== NOT_A_LEVEL);
}

/**
 * Which levels this model accepts, one at a time.
 *
 * Only an explicit refusal is a capability answer. A 429, a 5xx or a dropped connection says nothing
 * about the level itself, and dropping a level on one of those would quietly shrink the ladder the
 * GUI offers over a momentary hiccup. Those levels are kept: an unmeasured level is not an absent one.
 */
async function measureLadder(id: string, candidate: WireCandidate, ladder: string[], deps: MeasureDeps): Promise<string[]> {
  const supported: string[] = [];
  const url = endpointFor(candidate.wire, candidate.url);
  for (const level of await candidateLevels(id, candidate, ladder, deps)) {
    let response: Response;
    try {
      response = await deps.fetch(url, { method: "POST", headers: requestHeaders(candidate, deps), body: requestBody(candidate.wire, id, level) });
    } catch {
      supported.push(level); // transient — keep
      continue;
    }
    if (!refusedLevel(response.status)) supported.push(level);
  }
  return supported;
}

/**
 * Establish one model's wire and effort ladder by calling it.
 *
 * Candidates are tried in order and the first 200 wins; the rest are never called, so the common
 * case (the provider's own wire, first) is one request. An auth failure stops everything: the key
 * was refused before the path mattered, so reporting anything but "auth" would send the user to
 * check the wire when the problem is the credential. When no candidate answers, the result carries
 * the last status and body as `error` and no `wire`.
 */
export async function measureModel(id: string, candidates: WireCandidate[], ladder: string[], deps: MeasureDeps): Promise<Measured> {
  if (candidates.length === 0) return { id, error: "no candidate wire to try" };
  let failure = "no candidate wire answered";
  for (const candidate of candidates) {
    let response: Response;
    try {
      response = await deps.fetch(endpointFor(candidate.wire, candidate.url), { method: "POST", headers: requestHeaders(candidate, deps), body: requestBody(candidate.wire, id) });
    } catch (e) {
      failure = `network: ${errorText(e)}`;
      continue;
    }
    if (response.status === 401) return { id, error: "auth" };
    if (response.status === 403) {
      // A plan refusing the model is a fact about the model, and worth reporting as one: no other
      // wire will answer either, so there is nothing left to try.
      const detail = snippet(await response.text());
      return { id, error: refusedByPlan(detail) ? `not-entitled: ${detail}` : "auth" };
    }
    if (response.ok) {
      if (ladder.length === 0) return { id, wire: candidate.wire };
      return { id, wire: candidate.wire, effortLevels: await measureLadder(id, candidate, ladder, deps) };
    }
    failure = `${response.status} ${snippet(await response.text())}`.trim();
  }
  return { id, error: failure };
}
