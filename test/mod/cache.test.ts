import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { DEFAULTS } from '../../packages/mod/hooks/settings.ts'
import type { CacheMemo, WarmState } from '../../packages/mod/types/index.d.ts'
registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes('/packages/mod/hooks/') && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { ttlFromUsage, nextMemo, secondsLeft, shouldPing, afterPing, restoreFromResume } = await import('../../packages/mod/hooks/cache.ts')
const hour = 3600000, five = 300000
const warm: WarmState = { pings: 0, cost: 0 }
const memo: CacheMemo = { ttlMs: hour, lastReplyAt: 0, expiresAt: hour }

test('TTL prefers hour evidence, otherwise five-minute evidence, defaults to hour', () => {
  assert.equal(ttlFromUsage({}), hour)
  assert.equal(ttlFromUsage({ cache_creation: { ephemeral_5m_input_tokens: 10 } }), five)
  assert.equal(ttlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 10 } }), hour)
  assert.equal(ttlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }), hour)
})

test('memo refreshes every response, preserves hour prefix when mostly read, equality is not majority', () => {
  assert.deepEqual(nextMemo(null, {}, 100), { ttlMs: hour, lastReplyAt: 100, expiresAt: hour + 100 })
  const usage = { cache_creation: { ephemeral_5m_input_tokens: 1 }, cache_creation_input_tokens: 1, cache_read_input_tokens: 99 }
  assert.equal(nextMemo(memo, usage, 1000).ttlMs, hour)
  assert.equal(nextMemo(memo, { ...usage, cache_read_input_tokens: 1 }, 1000).ttlMs, five)
  assert.equal(nextMemo(memo, { ...usage, cache_read_input_tokens: 0 }, 1000).ttlMs, five)
  assert.equal(nextMemo({ ...memo, ttlMs: five }, {}, 1000).ttlMs, five)
  assert.equal(nextMemo({ ...memo, ttlMs: five }, { cache_read_input_tokens: 99, input_tokens: 1 }, five + 1).ttlMs, hour)
  assert.equal(nextMemo({ ...memo, ttlMs: five }, { cache_read_input_tokens: 99, input_tokens: 1 }, five).ttlMs, five)
  assert.equal(memo.lastReplyAt, 0)
})

test('seconds left rounds up, clamps at expiry and keeps unknown distinct from cold', () => {
  assert.equal(secondsLeft(null, 0), null)
  assert.equal(secondsLeft(memo, hour - 1001), 2)
  assert.equal(secondsLeft(memo, hour - 1), 1)
  assert.equal(secondsLeft(memo, hour), 0)
  assert.equal(secondsLeft(memo, hour + 1), 0)
})

const ping = { settings: { ...DEFAULTS, keepWarm: true }, memo, warm, now: hour - 240000, idle: true, contextTokens: 30000, lastRealReplyAt: 0 }

test('keep-warm triggers inclusively at lead/minimum boundaries for both TTLs', () => {
  assert.deepEqual(shouldPing(ping), { ping: true })
  assert.deepEqual(shouldPing({ ...ping, now: ping.now - 1 }), { ping: false })
  assert.equal(shouldPing({ ...ping, contextTokens: 29999 }).ping, false)
  const short = { ...ping, memo: { ...memo, ttlMs: five, expiresAt: five }, now: five - 60000 }
  assert.deepEqual(shouldPing(short), { ping: true })
  assert.deepEqual(shouldPing({ ...short, now: short.now - 1 }), { ping: false })
  assert.equal(shouldPing({ ...short, now: five }).ping, false)
})

test('keep-warm refuses disabled, busy, expired, unknown, stopped and time-bounded chats', () => {
  assert.equal(shouldPing({ ...ping, settings: DEFAULTS }).ping, false)
  assert.equal(shouldPing({ ...ping, idle: false }).ping, false)
  assert.equal(shouldPing({ ...ping, memo: null }).ping, false)
  assert.equal(shouldPing({ ...ping, now: hour }).ping, false)
  assert.deepEqual(shouldPing({ ...ping, warm: { ...warm, stopped: 'no cache' } }), { ping: false, reason: 'no cache' })
  assert.equal(shouldPing({ ...ping, lastRealReplyAt: null }).ping, false)
  const bound = { ...ping, now: 2 * hour, memo: { ...memo, expiresAt: 2 * hour + 1 } }
  assert.equal(shouldPing(bound).ping, false)
  assert.equal(shouldPing({ ...bound, now: bound.now - 1 }).ping, true)
})

test('ping updates immutable bookkeeping and counts answered misses while stopping', () => {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 4, cache_read_input_tokens: 100, output_tokens: 2 }
  assert.deepEqual(afterPing(warm, { isAnswered: true, text: 'ok', usage }, 42), { pings: 1, cost: 35, lastPingAt: 42 })
  assert.ok(afterPing(warm, null, 42).stopped)
  assert.ok(afterPing(warm, { isAnswered: false, reason: 'nothing-to-fork' }, 42).stopped)
  const miss = afterPing(warm, { isAnswered: true, text: 'ok', usage: { ...usage, cache_read_input_tokens: 0 } }, 42)
  assert.equal(miss.pings, 1)
  assert.equal(miss.cost, 25)
  assert.ok(miss.stopped)
  assert.deepEqual(warm, { pings: 0, cost: 0 })
})

test('resume reconstructs elapsed response time and obeys host expiry even before TTL', () => {
  assert.deepEqual(restoreFromResume(10, false, hour, 20000), { ttlMs: hour, lastReplyAt: 10000, expiresAt: hour + 10000 })
  assert.deepEqual(restoreFromResume(10, true, hour, 20000), { ttlMs: hour, lastReplyAt: 10000, expiresAt: 19999 })
  assert.equal(restoreFromResume(300, false, five, 400000)?.expiresAt, 399999)
  for (const seconds of [undefined, -1, NaN, Infinity]) assert.equal(restoreFromResume(seconds, false, hour, 0), null)
})
