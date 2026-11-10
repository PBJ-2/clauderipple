// A decision the host refuses because the Claude app on the computer answered that approval first.
// The host sends `desktop_approval_local` as the failure's code and its own Korean sentence as the
// message; the request then ends with a `permission_decided` (expired) that carries the same sentence.
// Both phone and web read this one code, so neither shows the refusal as a failure.

export const ANSWERED_ELSEWHERE = "desktop_approval_local";

/** True when a decision failed only because the Claude app already answered that approval. */
export function answeredElsewhere(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === ANSWERED_ELSEWHERE;
}
