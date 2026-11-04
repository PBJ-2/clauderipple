import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hottest, limitLabel, saveUntil, swamped, contextWindow, modelCompactWindow, coldAlert, hotAlert, hotWindowMoved, swampAlert, keptAlert, bandPriority, claudeLimitsFrom, CLAUDE_USAGE_STALE_MS } from '../../packages/mod/hooks/session.ts'
const now = Date.parse('2026-10-10T00:00:00Z')
const hot = { kind: 'five_hour', percent: 80, resetsAt: '2026-10-10T05:00:00Z' }

test('the router stands in for the plan windows of the current login, fresh snapshots only', () => {
  // The shape GET /api/status answered on 2026-10-14.
  const status = (at: number) => ({ claude: { accounts: [
    { id: 'other', quota: { at, rate_limits: { primary: { used_percent: 99, window_minutes: 300, reset_at: 1 } } } },
    { id: 'current', quota: { type: 'claude.usage', at, rate_limits: {
      primary: { used_percent: 7, window_minutes: 300, reset_at: Date.parse('2026-10-10T03:00:00Z') / 1000 },
      secondary: { used_percent: 75, window_minutes: 10080, reset_at: Date.parse('2026-10-13T00:00:00Z') / 1000 } } } },
  ] } })
  assert.deepEqual(claudeLimitsFrom(status(now - 60_000), now), [
    { kind: 'five_hour', percentUsed: 7, resetsAt: '2026-10-10T03:00:00.000Z' },
    { kind: 'seven_day', percentUsed: 75, resetsAt: '2026-10-13T00:00:00.000Z' },
  ])
  assert.deepEqual(claudeLimitsFrom(status(now - CLAUDE_USAGE_STALE_MS - 1), now), [])
  assert.deepEqual(claudeLimitsFrom({ claude: { accounts: [] } }, now), [])
  assert.deepEqual(claudeLimitsFrom({}, now), [])
  assert.deepEqual(claudeLimitsFrom(null, now), [])
})

test('the plan windows follow the in-use account, and the login when no row is marked', () => {
  const at = now - 60_000
  const account = (id: string, used: number, extra: Record<string, unknown> = {}) => ({ id, ...extra, quota: { at, rate_limits: { primary: { used_percent: used, window_minutes: 300 } } } })
  // A stored account serves the pool now: its figure stands in, not the login's 81%.
  assert.deepEqual(claudeLimitsFrom({ claude: { accounts: [account('current', 81), account('stored', 15, { inUse: true })] } }, now), [{ kind: 'five_hour', percentUsed: 15 }])
  // A router that marks no row (older than the flag) keeps reading the login.
  assert.deepEqual(claudeLimitsFrom({ claude: { accounts: [account('current', 81), account('stored', 15)] } }, now), [{ kind: 'five_hour', percentUsed: 81 }])
})

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
  assert.equal(swamped({ tokens: 100000, window: 200000, percent: 50 }, 50), 50)
  assert.equal(swamped({ tokens: 100000, window: 200000 }, 50), 50)
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

test('kept is counted pings while the memo still holds; an expired cache is the cold card', () => {
  const memo = { ttlMs: 3600000, lastReplyAt: now - 60000, expiresAt: now + 3600000 }
  assert.equal(keptAlert({ pings: 1, tokens: 40000 }, memo, now), true)
  assert.equal(keptAlert({ pings: 0, tokens: 40000 }, memo, now), false)
  assert.equal(keptAlert(null, memo, now), false)
  assert.equal(keptAlert({ pings: 2, tokens: 40000 }, null, now), false)
  // The cache the pings held has expired: claiming it would lie, the cold card is the truth.
  assert.equal(keptAlert({ pings: 2, tokens: 40000 }, { ...memo, expiresAt: now }, now), false)
})

test('the context percent is measured against the compaction window when it is smaller than the model window', () => {
  // A 1M model compacting at 400k: the band reads 40k as 10%, not 4%.
  assert.equal(contextWindow(1_000_000, 400_000), 400_000)
  // An override above the model window would compact after an overflow: the model window wins.
  assert.equal(contextWindow(200_000, 400_000), 200_000)
  assert.equal(contextWindow(1_000_000, 1_000_000), 1_000_000)
  assert.equal(contextWindow(1_000_000, null), 1_000_000)
  assert.equal(contextWindow(1_000_000, undefined), 1_000_000)
  assert.equal(contextWindow(1_000_000, 0), 1_000_000)
  // The share the band and the heavy alert read: 80% of the 400k window is 320k, not 800k.
  const at400k = { tokens: 320_000, percent: 320_000 / 400_000 * 100, window: contextWindow(1_000_000, 400_000) }
  assert.equal(swamped(at400k), 80)
  assert.equal(swampAlert(swamped(at400k), null), true)
  assert.equal(swamped({ ...at400k, tokens: 319_999, percent: 319_999 / 400_000 * 100 }), null)
})

test('fallback context windows follow the router model including effort variants and older routers', () => {
  const body = { resolvedWindows: {
    'claude-opus-5-5': { contextWindow: 1_000_000, compactWindow: 600_000 },
    'claude-opus-4-7': { contextWindow: 475_000, compactWindow: 475_000 },
    'gpt@high': { compactWindow: 300_000 },
    gpt: { compactWindow: 475_000 },
  } }
  assert.equal(contextWindow(1_000_000, modelCompactWindow(body, 'claude-opus-5-5')), 600_000)
  assert.equal(contextWindow(1_000_000, modelCompactWindow(body, 'claude-opus-4-7')), 475_000)
  assert.equal(contextWindow(200_000, 600_000, modelCompactWindow(body, 'claude-opus-4-7')), 475_000)
  assert.equal(modelCompactWindow(body, 'gpt@high'), 300_000)
  assert.equal(modelCompactWindow(body, 'gpt@low'), 475_000)
  assert.equal(modelCompactWindow({ resolvedWindows: { gpt: { contextWindow: 475_000 } } }, 'gpt'), null)
  assert.equal(modelCompactWindow(null, 'gpt'), null)
})

test('dismissed hot returns at +10 points and swamp at +15 points of context, inclusively', () => {  assert.equal(hotAlert(hot, null), true)
  assert.equal(hotAlert(null, null), false)
  assert.equal(hotAlert({ ...hot, percent: 79.9 }, null), false)
  assert.equal(hotAlert({ ...hot, percent: 89.9 }, 80), false)
  assert.equal(hotAlert({ ...hot, percent: 90 }, 80), true)
  assert.equal(swampAlert(null, null), false)
  assert.equal(swampAlert(55, null), true)
  assert.equal(swampAlert(69.9, 55), false)
  assert.equal(swampAlert(70, 55), true)
  // A token count kept by an older mod no longer hides the band for good.
  assert.equal(swampAlert(55, 126000), true)
})

test('band priority is exactly panels, failure, hot, results, cold, swamp, kept, dashboard', () => {
  const all = { judgeDown: true, hot: true, result: true, cold: true, swamp: true, kept: true }
  for (const panel of ['settings', 'compact', 'setup'] as const) assert.equal(bandPriority({ ...all, panel }), panel)
  assert.equal(bandPriority(all), 'judgeDown')
  assert.equal(bandPriority({ ...all, judgeDown: false }), 'hot')
  assert.equal(bandPriority({ ...all, judgeDown: false, hot: false }), 'result')
  assert.equal(bandPriority({ cold: true, swamp: true }), 'cold')
  // A cold cache cannot be kept: cold beats kept. Kept, the lowest card, sits under swamp.
  assert.equal(bandPriority({ cold: true, kept: true, swamp: true }), 'cold')
  assert.equal(bandPriority({ kept: true, swamp: true }), 'swamp')
  assert.equal(bandPriority({ swamp: true, kept: false }), 'swamp')
  assert.equal(bandPriority({ kept: true }), 'kept')
  assert.equal(bandPriority({ swamp: true }), 'swamp')
  assert.equal(bandPriority({}), 'dashboard')
})

// A put-off hot card lasts until its window moves on. A missing reading (a routed model's session
// carries no plan windows) or the same reset spelled by the other source is the same window: before,
// either one brought the card back on every turn (2026-10-14, weekly at 87%).
test('hotWindowMoved: only another window or a reset an hour later forgets a put-off', () => {
  const weekly = { kind: 'seven_day', percent: 87, resetsAt: '2026-10-16T06:20:00.000Z' }
  assert.equal(hotWindowMoved(weekly, null), false)
  assert.equal(hotWindowMoved(null, weekly), false)
  assert.equal(hotWindowMoved(weekly, { ...weekly, percent: 88, resetsAt: '2026-10-16T06:20:00Z' }), false)
  assert.equal(hotWindowMoved(weekly, { ...weekly, resetsAt: '2026-10-16T06:20:59.000Z' }), false)
  assert.equal(hotWindowMoved(weekly, { kind: 'seven_day', percent: 81 }), false)
  assert.equal(hotWindowMoved(weekly, { ...weekly, resetsAt: '2026-10-23T06:20:00.000Z' }), true)
  assert.equal(hotWindowMoved(weekly, { kind: 'five_hour', percent: 90, resetsAt: '2026-10-15T01:00:00.000Z' }), true)
})
