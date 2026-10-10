import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hottest, limitLabel, saveUntil, swamped, coldAlert, hotAlert, swampAlert, bandPriority } from '../../packages/mod/hooks/session.ts'
const now = Date.parse('2026-10-10T00:00:00Z')
const hot = { kind: 'five_hour', percent: 80, resetsAt: '2026-10-10T05:00:00Z' }

test('hottest only considers five_hour/seven_day at or above eighty', () => {
  assert.equal(hottest([]), null)
  assert.equal(hottest([{ kind: 'five_hour', percentUsed: 79.9 }]), null)
  assert.deepEqual(hottest([{ kind: 'five_hour', percentUsed: 80 }]), { kind: 'five_hour', percent: 80 })
  assert.deepEqual(hottest([{ kind: 'spend_limit', percentUsed: 100 }, { kind: 'five_hour', percentUsed: 81 },
    { kind: 'seven_day', percentUsed: 92, resetsAt: hot.resetsAt }]), { kind: 'seven_day', percent: 92, resetsAt: hot.resetsAt })
})

test('limit label rounds usage and shows the reset in the given zone, with the day when it is far', () => {
  assert.equal(limitLabel(hot, now, 0), '5h 80% · resets 05:00')
  // Seoul is 540 minutes ahead of UTC: getTimezoneOffset() answers -540.
  assert.equal(limitLabel(hot, now, -540), '5h 80% · resets 14:00')
  assert.equal(limitLabel({ kind: 'seven_day', percent: 81.6, resetsAt: '2026-10-11T01:00:00Z' }, now, 0), 'weekly 82% · resets Sun 01:00')
  assert.equal(limitLabel({ ...hot, resetsAt: 'invalid' }, now, 0), '5h 80%')
  assert.equal(limitLabel({ kind: 'seven_day', percent: 90 }, now, 0), 'weekly 90%')
  assert.ok(limitLabel({ ...hot, resetsAt: '2026-10-10T20:00:00Z' }, now, 0).includes('Sat'))
})

test('save uses future reset, otherwise bounded five-hour fallback', () => {
  assert.equal(saveUntil(hot, now), now + 5 * 3600000)
  for (const value of [null, { ...hot, resetsAt: 'bad' }, { ...hot, resetsAt: new Date(now).toISOString() }]) assert.equal(saveUntil(value, now), now + 5 * 3600000)
  assert.equal(saveUntil({ ...hot, resetsAt: '2026-10-12T00:00:00Z' }, now), now + 48 * 3600000)
})

test('swamp evaluates threshold inclusively, derives missing percentage, unknown stays hidden', () => {
  assert.equal(swamped({ tokens: 100000, window: 200000, percent: 50 }, 50), 100000)
  assert.equal(swamped({ tokens: 100000, window: 200000 }, 50), 100000)
  assert.equal(swamped({ tokens: 100000, window: 200000, percent: 49.9 }, 50), null)
  assert.equal(swamped(null, 50), null)
  assert.equal(swamped({ window: 200000 }, 50), null)
  assert.equal(swamped({ window: 0, tokens: 1 }, 50), null)
  assert.equal(swamped({ tokens: 100000, window: 200000, percent: 0 }, 50), null)
})

test('cold is large expired cache only; dismissal hides until caller resets it on real response', () => {
  const memo = { ttlMs: 3600000, lastReplyAt: 0, expiresAt: now }
  assert.equal(coldAlert(memo, 150000, now, false), true)
  assert.equal(coldAlert(memo, 149999, now, false), false)
  assert.equal(coldAlert(memo, 150000, now - 1, false), false)
  assert.equal(coldAlert(memo, 150000, now, true), false)
  assert.equal(coldAlert(null, 150000, now, false), false)
})

test('dismissed hot returns at +10 points and swamp at +50000 tokens, inclusively', () => {
  assert.equal(hotAlert(hot, null), true)
  assert.equal(hotAlert(null, null), false)
  assert.equal(hotAlert({ ...hot, percent: 79.9 }, null), false)
  assert.equal(hotAlert({ ...hot, percent: 89.9 }, 80), false)
  assert.equal(hotAlert({ ...hot, percent: 90 }, 80), true)
  assert.equal(swampAlert(null, null), false)
  assert.equal(swampAlert(100000, null), true)
  assert.equal(swampAlert(149999, 100000), false)
  assert.equal(swampAlert(150000, 100000), true)
})

test('band priority is exactly panels, failure, hot, results, cold, swamp, dashboard', () => {
  const all = { judgeDown: true, hot: true, result: true, cold: true, swamp: true }
  for (const panel of ['settings', 'compact', 'handoff', 'setup'] as const) assert.equal(bandPriority({ ...all, panel }), panel)
  assert.equal(bandPriority(all), 'judgeDown')
  assert.equal(bandPriority({ ...all, judgeDown: false }), 'hot')
  assert.equal(bandPriority({ ...all, judgeDown: false, hot: false }), 'result')
  assert.equal(bandPriority({ cold: true, swamp: true }), 'cold')
  assert.equal(bandPriority({ swamp: true }), 'swamp')
  assert.equal(bandPriority({}), 'dashboard')
})
