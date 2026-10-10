import type { ModelForkResult } from 'claude-code'
import type { CacheMemo, Settings, Usage, WarmState } from '../types'
import { weighted } from './stats'

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
export function afterPing(warm: WarmState, forkResult: ModelForkResult | null, now: number): WarmState {
  if (!forkResult?.isAnswered) return { ...warm, stopped: 'Keep warm stopped: no fork reply' }
  const next: WarmState = { pings: warm.pings + 1, cost: warm.cost + weighted(forkResult.usage), lastPingAt: now }
  if (forkResult.usage.cache_read_input_tokens <= 0) next.stopped = 'Keep warm stopped: cache was not read'
  return next
}

export function restoreFromResume(secondsSinceLastResponse: number | undefined, likelyExpired: boolean | undefined, ttlMs: number, now: number): CacheMemo | null {
  if (secondsSinceLastResponse === undefined || !Number.isFinite(secondsSinceLastResponse) || secondsSinceLastResponse < 0) return null
  const lastReplyAt = now - secondsSinceLastResponse * 1000
  const expiresAt = lastReplyAt + ttlMs
  return { ttlMs, lastReplyAt, expiresAt: likelyExpired || expiresAt <= now ? now - 1 : expiresAt }
}
