// Safe excerpts of upstream errors for logs and client-safe translated errors.
//
// An upstream error may reflect the credential it was given. Keys are opaque vendor strings, so
// callers supply their actual outbound credential values; token-shaped fallbacks cover errors from
// a layer whose credentials are not present in config (for example a refreshed OAuth token).

const REDACTED = "[REDACTED]";

/** Values sent under a credential-bearing outbound header name. */
function credentialHeaderName(name: string): boolean {
  return /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|.*(?:token|secret|password).*)$/i.test(name);
}

export function credentialHeaderValues(headers: Iterable<[string, string]>): string[] {
  const secrets = new Set<string>();
  for (const [rawName, value] of headers) {
    if (!credentialHeaderName(rawName) || !value) continue;
    secrets.add(value);
    // A vendor that echoes the credential echoes the token, not the scheme in front of it.
    const bare = /^(?:Bearer|Basic|Token)\s+(\S+)$/i.exec(value)?.[1];
    if (bare) secrets.add(bare);
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

/** Header names are diagnostic; their sensitive values must never reach a log line. */
export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return [[name, credentialHeaderName(name) ? REDACTED : value] as const];
  }));
}

/** Return a bounded, one-line diagnostic without credentials. */
export function redactErrorText(value: string, secrets: readonly string[] = [], max = 500): string {
  let text = value.replace(/\s+/g, " ").trim();
  // Longest first avoids leaving a suffix exposed when one configured value contains another.
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, REDACTED);
  }
  return text
    // Authorization values in prose or header-shaped JSON.
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, `$1 ${REDACTED}`)
    .replace(/\b(sk-[A-Za-z0-9][A-Za-z0-9._-]{6,})\b/g, REDACTED)
    // OAuth access/refresh tokens are JWTs, regardless of the header/body formatting.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\b/g, REDACTED)
    // Key/value echoes that are not sent as a standard Authorization header.
    .replace(/\b((?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|token|secret|password)\s*[:=]\s*)[^\s,"'};]+/gi, `$1${REDACTED}`)
    .slice(0, max);
}

/**
 * Masks anything shaped like a credential in text that came from another program's output, on top of
 * what redactErrorText already knows: a JSON parse diagnostic can quote a malformed value from
 * Claude Code's settings.json (`"ANTHROPIC_AUTH_TOKEN": "sk-ant-…"`), which no configured secret
 * names. Long unbroken runs of token characters (24 or more of [A-Za-z0-9_.-]), `sk-` keys, `Bearer`
 * values and JWT-shaped strings are replaced. An all-capitals constant (`SEC_ERROR_PKCS11_DEVICE_ERROR`)
 * is an error code, not a credential, and is kept.
 *
 * A V8 JSON.parse diagnostic quotes a short excerpt around the fault
 * (`Unexpected token 'a', ..."AUTH_TOKEN": abcd1234ef"... is not valid JSON`, with or without the
 * leading `...`), and that excerpt can be a fragment of a credential too short for the run rule.
 * The quoted excerpt is dropped whole; the unexpected character itself and the diagnostic's own
 * words, including any `at position N (line L column C)` form, stay.
 *
 * A path or a sentence has breaks well inside 24 characters, so ordinary messages pass unchanged.
 * Not bounded: callers cut afterwards, so a cut never leaves the front of a token showing.
 */
export function redactTokenLike(text: string): string {
  return text
    // Drop the excerpt between `Unexpected token '<c>'` and the diagnostic's own ending.
    .replace(/(Unexpected token '.{0,3}'),[\s\S]*?(\s*(?:at position \d+ \(line \d+ column \d+\))?\s*is not valid JSON)/g, "$1$2")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9._-]{6,}/g, REDACTED)
    .replace(/[A-Za-z0-9_.-]{24,}/g, (run) => (/^[A-Z0-9_]+$/.test(run) ? run : REDACTED));
}
