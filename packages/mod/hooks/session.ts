import type { SessionContextUsage, SessionRateLimit } from 'claude-code'
import type { CacheMemo, Hot } from '../types'

export function hottest(rateLimits: readonly SessionRateLimit[]): Hot | null {
  const eligible = rateLimits.filter(limit => ['five_hour', 'seven_day'].includes(limit.kind) && limit.percentUsed >= 80)
  const limit = eligible.reduce<SessionRateLimit | undefined>((hot, next) => !hot || next.percentUsed > hot.percentUsed ? next : hot, undefined)
  return limit ? { kind: limit.kind, percent: limit.percentUsed, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) } : null
}

/**
 * The reset is read in the person's own clock: `offsetMinutes` is `Date#getTimezoneOffset` (minutes
 * behind UTC), passed in so tests do not depend on the machine's zone.
 */
export function limitLabel(hot: Hot, now: number, offsetMinutes = new Date(now).getTimezoneOffset()): string {
  const label = `${hot.kind === 'five_hour' ? '5h' : 'weekly'} ${Math.round(hot.percent)}%`
  const reset = hot.resetsAt ? Date.parse(hot.resetsAt) : NaN
  if (!Number.isFinite(reset)) return label
  const date = new Date(reset - offsetMinutes * 60000)
  const time = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()]
  return `${label} · resets ${reset - now < 20 * 3600000 ? time : `${day} ${time}`}`
}

export function saveUntil(hot: Hot | null, now: number): number {
  const reset = hot?.resetsAt ? Date.parse(hot.resetsAt) : NaN
  return Number.isFinite(reset) && reset > now ? reset : now + 5 * 3600000
}

export function swamped(context: SessionContextUsage | null, swampAt: number): number | null {
  if (!context || context.tokens === undefined) return null
  const percent = context.percent ?? (context.window > 0 ? context.tokens / context.window * 100 : undefined)
  return percent !== undefined && percent >= swampAt ? context.tokens : null
}

export function coldAlert(memo: CacheMemo | null, contextTokens: number, now: number, hidden: boolean): boolean {
  return !hidden && memo !== null && memo.expiresAt <= now && contextTokens >= 150000
}

export function hotAlert(hot: Hot | null, hidden: number | null): boolean {
  return hot !== null && hot.percent >= 80 && (hidden === null || hot.percent >= hidden + 10)
}

export function swampAlert(tokens: number | null, hidden: number | null): boolean {
  return tokens !== null && (hidden === null || tokens >= hidden + 50000)
}

/** Rendering consumes eligibility, keeping dismissal and idle decisions outside drawing code. */
export function bandPriority(state: {
  panel?: 'settings' | 'compact' | 'handoff' | 'setup' | null
  judgeDown?: boolean; hot?: boolean; result?: boolean; cold?: boolean; swamp?: boolean
}): 'settings' | 'compact' | 'handoff' | 'setup' | 'judgeDown' | 'hot' | 'result' | 'cold' | 'swamp' | 'dashboard' {
  if (state.panel) return state.panel
  for (const band of ['judgeDown', 'hot', 'result', 'cold', 'swamp'] as const) if (state[band]) return band
  return 'dashboard'
}
