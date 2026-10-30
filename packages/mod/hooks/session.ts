import type { SessionContextUsage, SessionRateLimit } from 'claude-code'
import type { CacheMemo, Hot, LimitItem } from '../types'

export function hottest(rateLimits: readonly SessionRateLimit[]): Hot | null {
  const eligible = rateLimits.filter(limit => ['five_hour', 'seven_day'].includes(limit.kind) && limit.percentUsed >= 80)
  const limit = eligible.reduce<SessionRateLimit | undefined>((hot, next) => !hot || next.percentUsed > hot.percentUsed ? next : hot, undefined)
  return limit ? { kind: limit.kind, percent: limit.percentUsed, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) } : null
}

const WINDOW_KIND: Record<number, string> = { 300: 'five_hour', 10080: 'seven_day' }
/** A router snapshot older than this is not shown as the plan's figure. */
export const CLAUDE_USAGE_STALE_MS = 15 * 60_000

/**
 * The plan windows of the Claude login this session's requests pass through, from the router's
 * GET /api/status (`claude.accounts[id=current].quota`, packages/router/src/admin.ts
 * claudeAccountUsage): for when the host leaves `rateLimits` empty though the requests carry them
 * (measured 2026-10-14: the router passes the `anthropic-ratelimit-unified-*` headers through).
 * Percent as the router reports it; a stale or unknown snapshot gives nothing.
 */
export function claudeLimitsFrom(status: unknown, now: number): SessionRateLimit[] {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const accounts = object(object(status).claude).accounts
  const current = Array.isArray(accounts) ? accounts.map(object).find(a => a.id === 'current') : undefined
  const quota = object(current?.quota)
  if (typeof quota.at !== 'number' || now - quota.at > CLAUDE_USAGE_STALE_MS) return []
  const limits = object(quota.rate_limits)
  return [limits.primary, limits.secondary].map(object).flatMap(w => {
    const kind = typeof w.window_minutes === 'number' ? WINDOW_KIND[w.window_minutes] : undefined
    if (!kind || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return []
    const reset = typeof w.reset_at === 'number' ? w.reset_at * (w.reset_at < 1e12 ? 1000 : 1) : NaN
    return [{ kind, percentUsed: Math.round(w.used_percent * 10) / 10, ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}) }]
  })
}

/** One per-model weekly window the router reports beside `rate_limits` (see `scopedFromLimits`). */
export type ScopedLimit = { name: string; percent: number; resetsAt?: string }

/**
 * The per-model weekly windows of the Claude login, from the router's GET /api/status
 * (`claude.accounts[id=current].quota.scoped`: `{name, used_percent, window_minutes, reset_at}`,
 * reset in epoch seconds or ms). A stale or unknown snapshot gives nothing, like claudeLimitsFrom.
 */
export function claudeScopedFrom(status: unknown, now: number): ScopedLimit[] {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const accounts = object(object(status).claude).accounts
  const current = Array.isArray(accounts) ? accounts.map(object).find(a => a.id === 'current') : undefined
  const quota = object(current?.quota)
  if (typeof quota.at !== 'number' || now - quota.at > CLAUDE_USAGE_STALE_MS) return []
  const scoped = quota.scoped
  if (!Array.isArray(scoped)) return []
  return scoped.map(object).flatMap(entry => {
    if (typeof entry.name !== 'string' || !entry.name || typeof entry.used_percent !== 'number' || !Number.isFinite(entry.used_percent)) return []
    const reset = typeof entry.reset_at === 'number' ? entry.reset_at * (entry.reset_at < 1e12 ? 1000 : 1) : NaN
    return [{ name: entry.name, percent: Math.round(entry.used_percent * 10) / 10, ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}) }]
  })
}

const KINDS = ['five_hour', 'seven_day', 'scoped', 'window'] as const
type LimitKind = (typeof KINDS)[number]

/** One window of `GET /api/limits` as a limits-row item, or null when it carries nothing to show. */
function limitItemFromWindow(w: unknown, provider: string, type: string | undefined, title: string | undefined, account: number, now: number): LimitItem | null {
  const o = w && typeof w === 'object' && !Array.isArray(w) ? w as Record<string, unknown> : {}
  const kind = o.kind
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null
  const used = o.used_percent
  if (typeof used !== 'number' || !Number.isFinite(used)) return null
  const minutes = typeof o.window_minutes === 'number' && o.window_minutes > 0 ? o.window_minutes : undefined
  const reset = typeof o.reset_at === 'number' && Number.isFinite(o.reset_at) ? o.reset_at * (o.reset_at < 1e12 ? 1000 : 1) : NaN
  // A window whose reset has passed starts again from nothing: it reads 0% until the provider next
  // reports, not gone. Dropped, Claude's five-hour window vanished from the row the minute it reset,
  // and the row read as one of Claude's figures cut off (2026-10-20).
  if (Number.isFinite(reset) && reset <= now) {
    return { provider, ...(type ? { type } : {}), ...(title ? { title } : {}), account, kind: kind as LimitKind, label: typeof o.label === 'string' ? o.label : '', ...(minutes !== undefined ? { windowMinutes: minutes } : {}), percent: 0 }
  }
  return {
    provider,
    ...(type ? { type } : {}),
    ...(title ? { title } : {}),
    account,
    kind: kind as LimitKind,
    label: typeof o.label === 'string' ? o.label : '',
    ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
    percent: Math.round(used * 10) / 10,
    ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}),
  }
}

/**
 * Every provider's windows from the router's `GET /api/limits`: one shape for Claude, each ChatGPT
 * account and each Antigravity account (see `buildLimits` in packages/router/src/admin.ts). The
 * providers keep the router's order (Claude first), and each account's windows keep theirs.
 */
export function routerLimitItems(body: unknown, now: number): LimitItem[] {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const providers = object(body).providers
  if (!Array.isArray(providers)) return []
  const out: LimitItem[] = []
  for (const p of providers) {
    const entry = object(p)
    const provider = typeof entry.provider === 'string' ? entry.provider : ''
    if (!provider) continue
    const type = typeof entry.type === 'string' ? entry.type : undefined
    const title = typeof entry.title === 'string' ? entry.title : undefined
    const accounts = entry.accounts
    if (!Array.isArray(accounts)) continue
    for (const a of accounts) {
      const account = object(a)
      const index = typeof account.account === 'number' ? account.account : 0
      const windows = account.windows
      if (!Array.isArray(windows)) continue
      for (const w of windows) {
        const item = limitItemFromWindow(w, provider, type, title, index, now)
        if (item) out.push(item)
      }
    }
  }
  return out
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

/** The context share at which the heavy band turns amber, and its alert opens (a fixed 80%). */
export const HEAVY_PERCENT = 80

/**
 * The context percent when it is at or past `HEAVY_PERCENT`, else null. The context atom's percent
 * is already measured against the compaction window (register.tsx `refreshUsage`).
 */
export function swamped(context: SessionContextUsage | null, at: number = HEAVY_PERCENT): number | null {
  if (!context || context.tokens === undefined) return null
  const percent = context.percent ?? (context.window > 0 ? context.tokens / context.window * 100 : undefined)
  return percent !== undefined && percent >= at ? percent : null
}

/**
 * The window the context share is measured against: Claude Code's own compaction point
 * (`autoCompactWindow`) while it is below the model's window, else the model's window.
 */
export function contextWindow(window: number, compactAt: number | null | undefined, resolvedWindow?: number | null): number {
  if (resolvedWindow !== null && resolvedWindow !== undefined && resolvedWindow > 0) return resolvedWindow
  return compactAt !== null && compactAt !== undefined && compactAt > 0 && compactAt < window ? compactAt : window
}

/**
 * Whether the token-count API counts this model's context: only Anthropic's own models. A routed
 * model's count is ClaudeRipple's characters-over-four estimate, item by item (router
 * `count_tokens`), so a "precise" count there is no more precise than the local estimate, and less
 * so once the estimate's total is reconciled to the measured input (2026-10-30).
 */
export function countsPrecisely(model: string): boolean {
  return /^claude-|^(?:opus|sonnet|haiku|fable|mythos)(?:[@[]|$)/.test(model)
}

/** Per-model effective window from the router; null also supports routers predating this field. */
export function modelCompactWindow(body: unknown, model: string): number | null {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const map = object(object(body).resolvedWindows)
  const base = model.split('@')[0]!
  const entry = object(map[model] ?? map[base] ?? map[base.replace(/-\d{8}$/, '')])
  const value = entry.compactWindow
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function coldAlert(memo: CacheMemo | null, contextTokens: number, now: number, hidden: boolean): boolean {
  return !hidden && memo !== null && memo.expiresAt <= now && contextTokens >= 150000
}

/**
 * Keep-warm held the cache while the person was away: at least one ping read cache tokens and the
 * memo says the cache is still warm. Once it has expired the cold card is the truth, never this.
 */
export function keptAlert(kept: { pings: number; tokens: number } | null, memo: CacheMemo | null, now: number): boolean {
  return kept !== null && kept.pings > 0 && memo !== null && memo.expiresAt > now
}

/**
 * Whether a put-off hot card should be forgotten: only when the window itself has moved on — another
 * window became the hottest, or its reset moved forward by more than an hour. A reading that is
 * missing for a while (a routed model's session carries no plan windows) or that comes from the
 * other source with its reset spelled to the second rather than the minute is the same window, and
 * forgetting on either brought the card back on every turn (2026-10-14, weekly at 87%).
 */
export function hotWindowMoved(previous: Hot | null, next: Hot | null): boolean {
  if (!previous || !next) return false
  if (previous.kind !== next.kind) return true
  const before = previous.resetsAt ? Date.parse(previous.resetsAt) : NaN
  const after = next.resetsAt ? Date.parse(next.resetsAt) : NaN
  return Number.isFinite(before) && Number.isFinite(after) && after - before > 3_600_000
}

export function hotAlert(hot: Hot | null, hidden: number | null): boolean {
  return hot !== null && hot.percent >= 80 && (hidden === null || hot.percent >= hidden + 10)
}

/**
 * The heavy-context band shows once per crossing: seen (or put off) at `hidden` percent, it waits
 * until the context grows SWAMP_STEP points more. A hidden value over 100 is a token count kept by
 * an older mod and is ignored.
 */
export const SWAMP_STEP = 15
export function swampAlert(percent: number | null, hidden: number | null): boolean {
  return percent !== null && (hidden === null || hidden > 100 || percent >= hidden + SWAMP_STEP)
}

/** Rendering consumes eligibility, keeping dismissal and idle decisions outside drawing code. */
export function bandPriority(state: {
  panel?: 'settings' | 'compact' | 'clear' | 'setup' | null
  judgeDown?: boolean; hot?: boolean; result?: boolean; cold?: boolean; swamp?: boolean; kept?: boolean
}): 'settings' | 'compact' | 'clear' | 'setup' | 'judgeDown' | 'hot' | 'result' | 'cold' | 'swamp' | 'kept' | 'dashboard' {
  if (state.panel) return state.panel
  for (const band of ['judgeDown', 'hot', 'result', 'cold', 'swamp', 'kept'] as const) if (state[band]) return band
  return 'dashboard'
}
