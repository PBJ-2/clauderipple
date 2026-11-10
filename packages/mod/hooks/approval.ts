// The mod's side of a permission the phone may hold for a Claude app session with no Remote Control
// (the host decides: packages/remote/src/mod-approval.ts). Pure helpers only; the hook itself lives in
// register.tsx, where the engine is.

/** What the host answers for a held approval: the phone's decision, with the always-allow updates it carries. */
export type HostAnswer = { behavior: 'allow'; updates?: unknown[] } | { behavior: 'deny'; message: string }

/** The host's state for one ask. `pending` keeps the hook waiting; anything else ends the hold. */
export type HeldState = 'pending' | 'answered' | 'local' | 'expired' | 'unknown'
export interface HeldReply { state: HeldState; answer?: HostAnswer }

/** The engine's PermissionRequest answer, as far as this module builds it. */
export type HookDecision = { behavior: 'allow'; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string }

/** AskUserQuestion and ExitPlanMode keep the Mac's own dialog: a hook's allow does not dismiss them. */
export function holdable(tool: string): boolean {
  return tool !== 'AskUserQuestion' && tool !== 'ExitPlanMode'
}

/** The engine's decision for the phone's answer. An "always" carries its updates; a plain allow carries none. */
export function decisionOf(answer: HostAnswer): HookDecision {
  if (answer.behavior === 'deny') return { behavior: 'deny', message: answer.message }
  return answer.updates?.length ? { behavior: 'allow', updatedPermissions: answer.updates } : { behavior: 'allow' }
}

/** The host's reply, read defensively: anything it does not say plainly is no answer, and the Mac's dialog stands. */
export function heldReply(text: string): HeldReply {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { state: 'unknown' } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'unknown' }
  const state = (raw as Record<string, unknown>).state
  if (state !== 'pending' && state !== 'answered' && state !== 'local' && state !== 'expired') return { state: 'unknown' }
  const answer = (raw as Record<string, unknown>).answer
  if (state === 'answered' && answer && typeof answer === 'object' && !Array.isArray(answer)) {
    const a = answer as Record<string, unknown>
    if (a.behavior === 'deny' && typeof a.message === 'string') return { state, answer: { behavior: 'deny', message: a.message } }
    if (a.behavior === 'allow') return { state, answer: Array.isArray(a.updates) ? { behavior: 'allow', updates: a.updates } : { behavior: 'allow' } }
  }
  return { state }
}

/** An id the host accepts (`[\w-]`, at most 100): time and randomness, no dependency on the engine's crypto. */
export function askId(now: number, random: () => number = Math.random): string {
  return `${now.toString(36)}-${random().toString(36).slice(2, 12)}`
}

/**
 * When the host cannot be reached, the hook stops polling once this long has passed since its last answered poll.
 * Every poll carries the time the hook sent it, and the host fences a hold this long after the latest poll it has
 * (APPROVAL_FRESH_MS in packages/remote/src/mod-approval.ts). So the hook gives the Mac its dialog only this long after
 * its last poll was sent (plus APPROVAL_FRESH_MARGIN_MS): by then the host takes no phone answer. A host that is gone
 * still never holds a turn for longer than about twice this.
 */
export const APPROVAL_FRESH_MS = 8_000
/** The dialog waits this much longer than the host's fence, so the fence is passed on a clock that reads it late, never early. */
export const APPROVAL_FRESH_MARGIN_MS = 250
/** A request body larger than this is not sent: the Mac's dialog answers it. */
export const APPROVAL_BODY_CAP = 480 * 1024
