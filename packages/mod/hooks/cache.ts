import type { ModelForkResult } from 'claude-code'
import type { CacheMemo, CacheMemory, Settings, Usage, WarmState } from '../types'
import { weighted } from './stats'
import { t } from './i18n.ts'
import type { Lang } from './i18n.ts'

const HOUR = 3600000
const FIVE_MINUTES = 300000

export function ttlFromUsage(usage: Usage): number {
  if ((usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) return HOUR
  if ((usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) return FIVE_MINUTES
  return HOUR
}

/** A five-minute tail must not shorten a mostly-read hour-long prefix. */
export function nextMemo(prev: CacheMemo | null, usage: Usage, now: number): CacheMemo {
  const total = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
  const mostlyRead = (usage.cache_read_input_tokens ?? 0) > total / 2
  const explicit = (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0 || (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0
  let ttlMs = explicit ? ttlFromUsage(usage) : prev?.ttlMs ?? HOUR
  if (prev?.ttlMs === HOUR && mostlyRead) ttlMs = HOUR
  if (!explicit && prev && now - prev.lastReplyAt > FIVE_MINUTES && mostlyRead) ttlMs = HOUR
  return { ttlMs, lastReplyAt: now, expiresAt: now + ttlMs }
}

export function secondsLeft(memo: CacheMemo | null, now: number): number | null {
  return memo ? Math.max(0, Math.ceil((memo.expiresAt - now) / 1000)) : null
}

/** Never pay to revive an expired cache or extend the last-real-reply bound with our own pings. */
export function shouldPing(input: {
  settings: Settings; memo: CacheMemo | null; warm: WarmState; now: number; idle: boolean
  contextTokens: number; lastRealReplyAt: number | null
}): { ping: true } | { ping: false; reason?: string } {
  const { settings, memo, warm, now } = input
  if (!settings.keepWarm) return { ping: false, reason: 'keep warm is off' }
  if (warm.stopped) return { ping: false, reason: warm.stopped }
  if (!input.idle) return { ping: false, reason: 'chat is busy' }
  if (!memo || memo.expiresAt <= now) return { ping: false, reason: 'cache is not warm' }
  if (input.lastRealReplyAt === null || now >= input.lastRealReplyAt + settings.keepWarmHours * HOUR) return { ping: false, reason: 'keep warm time bound reached' }
  if (input.contextTokens < settings.keepWarmMinTokens) return { ping: false, reason: 'chat is too small' }
  const lead = memo.ttlMs === FIVE_MINUTES ? 60000 : 240000
  return memo.expiresAt - now <= lead ? { ping: true } : { ping: false }
}

/** Failed forks stop once; answered cache misses still count the real tokens they spent. */
export function afterPing(warm: WarmState, forkResult: ModelForkResult | null, now: number, lang: Lang = 'en'): WarmState {
  if (!forkResult?.isAnswered) return { ...warm, stopped: t(lang, 'toasts.warmNoReply') }
  const next: WarmState = { pings: warm.pings + 1, cost: warm.cost + weighted(forkResult.usage), lastPingAt: now }
  if (forkResult.usage.cache_read_input_tokens <= 0) next.stopped = t(lang, 'toasts.warmNoCache')
  return next
}

export function restoreFromResume(secondsSinceLastResponse: number | undefined, likelyExpired: boolean | undefined, ttlMs: number, now: number): CacheMemo | null {
  if (secondsSinceLastResponse === undefined || !Number.isFinite(secondsSinceLastResponse) || secondsSinceLastResponse < 0) return null
  const lastReplyAt = now - secondsSinceLastResponse * 1000
  const expiresAt = lastReplyAt + ttlMs
  return { ttlMs, lastReplyAt, expiresAt: likelyExpired || expiresAt <= now ? now - 1 : expiresAt }
}

/** Every chat's keep-warm in the store sits under this prefix, so the others can be pruned. */
export const CACHE_MEMORY_PREFIX = 'keepWarm.'

/** One chat's key: a restarted process reads back what this chat's own replies left. */
export function cacheMemoryKey(sessionId: string): string {
  return CACHE_MEMORY_PREFIX + sessionId
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The memo a store value holds, or null when it holds none this mod can read (older mod, an edit). */
function memoIn(value: unknown): CacheMemo | null {
  const held = value && typeof value === 'object' ? (value as Record<string, unknown>).memo : undefined
  const memo = held && typeof held === 'object' ? held as Record<string, unknown> : {}
  if (!finite(memo.ttlMs) || !finite(memo.lastReplyAt) || !finite(memo.expiresAt)) return null
  return { ttlMs: memo.ttlMs, lastReplyAt: memo.lastReplyAt, expiresAt: memo.expiresAt }
}

/** What a restarted process takes back: this model's memo, and only while its cache still holds. */
export function savedMemory(value: unknown, model: string, now: number): CacheMemory | null {
  const memo = memoIn(value)
  const held = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (!memo || memo.expiresAt <= now) return null
  if (held.model !== model || !finite(held.lastRealReplyAt)) return null
  return { memo, lastRealReplyAt: held.lastRealReplyAt, contextTokens: finite(held.contextTokens) ? held.contextTokens : 0, model }
}

/** A value the store need not keep: another chat's past its expiry, or not readable as a memo. */
export function staleMemory(value: unknown, now: number): boolean {
  const memo = memoIn(value)
  return !memo || memo.expiresAt <= now
}

/** The context a ping is judged by: the live count when the session has one, else the one the store kept. */
export function liveContextTokens(live: number | undefined, saved: number | null | undefined): number {
  return live !== undefined && live > 0 ? live : saved ?? 0
}

/**
 * A resume figure never shortens a memo that still holds: a ping refreshes the cache for another
 * ttl, so a figure counted from the last real reply can read lower than what the cache really has.
 * No figure at all keeps the old answer (null): a fork's first turn must not inherit its parent's memo.
 */
export function laterMemo(current: CacheMemo | null, offered: CacheMemo | null, now: number): CacheMemo | null {
  if (!offered) return null
  if (!current || offered.expiresAt <= now) return offered
  return offered.expiresAt > current.expiresAt ? offered : current
}
