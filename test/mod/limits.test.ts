// The limits row's data: the router's per-model weeklies, the ChatGPT accounts, and how the
// band names and groups them. Follows test/mod/modes.test.ts for extensionless imports.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  const source = context.parentURL?.includes('/packages/mod/hooks/')
  return next(source && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { claudeScopedFrom, CLAUDE_USAGE_STALE_MS, COST_MODELS, costFromSummary, localMidnight, routerLimitItems } = await import('../../packages/mod/hooks/session.ts')
const { t } = await import('../../packages/mod/hooks/i18n.ts')
const { chatgptProviders, gptLimitsFrom } = await import('../../packages/mod/hooks/modes.ts')
const { providerDisplayName, costFigure, costText, exhaustLeft, exhaustSentence, exhaustShort, exhaustShortWidest, limitItemTone, bandLimitGroups, limitAccountLabel, limitGroupAccount, limitGroupName, limitGroupNumbered, limitGroups, limitItemName, limitItemTip, narrowLimitGroups, paceLabel, paceLevel, resetMoment, resetShort, timeLeft } = await import('../../packages/mod/hooks/ui/view.ts')
const { barArt } = await import('../../packages/mod/hooks/ui/art.ts')

const NOW = Date.parse('2026-10-15T00:00:00Z')

const claudeStatus = (at: number, scoped?: unknown) => ({ claude: { accounts: [
  { id: 'other', quota: { at, scoped } },
  { id: 'current', quota: { type: 'claude.usage', at, rate_limits: {}, ...(scoped === undefined ? {} : { scoped }) } },
] } })

test('scoped weeklies come from the current login only, fresh snapshots only', () => {
  const scoped = [
    { name: 'Fable', used_percent: 2, window_minutes: 10080, reset_at: NOW / 1000 },
    { name: 'Opus', used_percent: 41.25, window_minutes: 10080 },
    { name: '', used_percent: 3, window_minutes: 10080 },
    { name: 'Vague', used_percent: 'many', window_minutes: 10080 },
    null,
  ]
  assert.deepEqual(claudeScopedFrom(claudeStatus(NOW - 60_000, scoped), NOW), [
    { name: 'Fable', percent: 2, resetsAt: new Date(NOW).toISOString() },
    { name: 'Opus', percent: 41.3 },
  ])
  assert.deepEqual(claudeScopedFrom(claudeStatus(NOW - CLAUDE_USAGE_STALE_MS - 1, scoped), NOW), [])
  assert.deepEqual(claudeScopedFrom(claudeStatus(NOW - 60_000), NOW), [])
  assert.deepEqual(claudeScopedFrom({}, NOW), [])
  assert.deepEqual(claudeScopedFrom(null, NOW), [])
})

test('scoped weeklies follow the in-use account, not the login', () => {
  const at = NOW - 60_000
  const scoped = [{ name: 'Fable', used_percent: 2, window_minutes: 10080, reset_at: NOW / 1000 }]
  const status = { claude: { accounts: [
    { id: 'current', quota: { at, scoped: [{ name: 'Fable', used_percent: 44, window_minutes: 10080 }] } },
    { id: 'stored', inUse: true, quota: { at, scoped } },
  ] } }
  assert.deepEqual(claudeScopedFrom(status, NOW), [{ name: 'Fable', percent: 2, resetsAt: new Date(NOW).toISOString() }])
})

test('chatgpt provider names come from the status providers', () => {
  const status = { providers: { anthropic: { type: 'anthropic' }, chatgpt: { type: 'chatgpt' }, codex: { type: 'chatgpt' }, zai: { type: 'anthropic-compatible' } } }
  assert.deepEqual(chatgptProviders(status), ['chatgpt', 'codex'])
  assert.deepEqual(chatgptProviders({}), [])
  assert.deepEqual(chatgptProviders(null), [])
})

test('gpt windows skip paused and needs-login accounts, and number the rest', () => {
  // Shape answered 2026-10-15, with a second account added.
  const body = (at: number) => ({ provider: 'chatgpt', accounts: [
    { id: 'legacy', state: 'ready', paused: false, quota: { type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 23, window_minutes: 10080, reset_after_seconds: 537851, reset_at: 1792565062 }, secondary: null }, at } },
    { id: '89ec', state: 'paused', paused: true, quota: null },
    { id: 'codex', state: 'needs-login', quota: { type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 1, window_minutes: 300 } }, at } },
    { id: 'second', state: 'ready', quota: { type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 64.44, window_minutes: 300, reset_at: 1792027211.5 }, secondary: { used_percent: 97, window_minutes: 10080, reset_after_seconds: 3600 } }, at } },
  ] })
  const at = NOW - 60_000
  assert.deepEqual(gptLimitsFrom(body(at), 'chatgpt', NOW), [
    { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 0, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 23, resetsAt: new Date(1792565062 * 1000).toISOString() },
    { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 1, kind: 'five_hour', label: '', windowMinutes: 300, percent: 64.4, resetsAt: new Date(1792027211.5 * 1000).toISOString() },
    { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 1, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 97, resetsAt: new Date(at + 3600 * 1000).toISOString() },
  ])
  // An old snapshot still stands (the router only refreshes it on use); a window whose reset has
  // passed does not. An unknown body leaves nothing.
  // Six hours old: the second account's weekly (reset an hour after that snapshot) has rolled over.
  assert.deepEqual(gptLimitsFrom(body(NOW - 6 * 3_600_000), 'chatgpt', NOW).map(w => w.account + ':' + w.kind), ['0:seven_day', '1:five_hour'])
  assert.deepEqual(gptLimitsFrom(body(at), 'chatgpt', Date.parse('2026-10-15T02:00:00Z')).map(w => w.kind), ['seven_day'])
  assert.deepEqual(gptLimitsFrom({}, 'chatgpt', NOW), [])
  // A window of another length keeps its minutes for a generic name.
  const odd = { provider: 'chatgpt', accounts: [{ id: 'a', state: 'ready', quota: { rate_limits: { primary: { used_percent: 5, window_minutes: 43200 } }, at } }] }
  assert.deepEqual(gptLimitsFrom(odd, 'chatgpt', NOW), [{ provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 0, kind: 'window', label: '', windowMinutes: 43200, percent: 5 }])
})

test('the row names windows, groups accounts, and tips the reset', () => {
  const items = [
    { provider: 'claude', account: 0, kind: 'five_hour', label: '', percent: 1 },
    { provider: 'claude', account: 0, kind: 'seven_day', label: '', percent: 88, resetsAt: '2026-10-15T04:00:00Z' },
    { provider: 'claude', account: 0, kind: 'scoped', label: 'Fable', percent: 2 },
    { provider: 'chatgpt', account: 0, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 23 },
    { provider: 'chatgpt', account: 1, kind: 'five_hour', label: '', windowMinutes: 300, percent: 64 },
  ] as const
  assert.equal(limitItemName(items[0]!, 'ko'), '5시간')
  assert.equal(limitItemName(items[1]!, 'ko'), '주간')
  assert.equal(limitItemName(items[2]!, 'ko'), 'Fable')
  assert.equal(limitItemName(items[3]!, 'en'), 'Weekly')
  assert.equal(limitItemName({ provider: 'x', account: 0, kind: 'window', label: '', windowMinutes: 43200, percent: 5 }, 'ko'), '30일')
  const groups = limitGroups(items)
  assert.deepEqual(groups.map(g => g.key), ['claude#0', 'chatgpt#0', 'chatgpt#1'])
  assert.equal(limitGroupName(groups[0]!, false), 'Claude')
  assert.equal(limitGroupName(groups[1]!, false), 'GPT')
  assert.equal(limitGroupName(groups[1]!, true), 'GPT 1')
  assert.equal(limitGroupName(groups[2]!, true), 'GPT 2')
  assert.equal(limitItemTip({ ...items[1]!, provider: 'claude', account: 0, kind: 'seven_day', label: '', resetsAt: new Date(NOW + 30 * 60_000).toISOString() }, 'Claude', 'ko', NOW), 'Claude 주간 88% · 30분 뒤 초기화')
  assert.equal(limitItemTip({ ...items[0]!, provider: 'claude', account: 0, kind: 'five_hour', label: '' }, 'Claude', 'en', NOW), 'Claude 5-hour 1%')
})

// 2026-10-29: the limits pane names a reset whole — local date, weekday and time to the minute in
// each language's own clock — and the time left beside it.
test('a reset moment reads exactly, in local time, and the time left to the minute', () => {
  const at = new Date(2026, 9, 30, 15, 35, 59).getTime()
  assert.equal(resetMoment(at, 'ko'), '10월 30일 (금) 오후 3:35')
  assert.equal(resetMoment(at, 'en'), 'Fri, Oct 30, 3:35 PM')
  assert.equal(resetMoment(at, 'zh'), '10月30日（周五）下午3:35')
  assert.equal(resetMoment(at, 'ja'), '10月30日（金）午後3:35')
  assert.equal(resetMoment(at, 'es'), 'vie 30 oct, 15:35')
  assert.equal(resetMoment(at, 'pt'), 'sex, 30 de out, 15:35')
  // Midnight and noon on a twelve-hour clock; the early hours zero-padded on a twenty-four-hour one.
  assert.equal(resetMoment(new Date(2026, 0, 2, 0, 5).getTime(), 'ko'), '1월 2일 (금) 오전 12:05')
  assert.equal(resetMoment(new Date(2026, 0, 2, 12, 0).getTime(), 'en'), 'Fri, Jan 2, 12:00 PM')
  assert.equal(resetMoment(new Date(2026, 0, 2, 7, 9).getTime(), 'es'), 'vie 2 ene, 07:09')
  const m = 60_000
  assert.equal(timeLeft((4 * 60 + 12) * m, 'ko'), '4시간 12분')
  assert.equal(timeLeft(4 * 60 * m, 'ko'), '4시간')
  assert.equal(timeLeft(35 * m, 'ko'), '35분')
  // Counted up to the next whole minute: half a minute left still reads one.
  assert.equal(timeLeft(30_000, 'ko'), '1분')
  assert.equal(timeLeft((4 * 60 + 11) * m + 1, 'en'), '4h 12m')
  assert.equal(timeLeft(((2 * 24 + 5) * 60 + 30) * m, 'ko'), '2일 5시간')
  assert.equal(timeLeft(3 * 1440 * m, 'en'), '3d')
})

// 2026-10-25: the limits pane reads each window's reset short — the time left while close, the
// weekday and clock once far, "resetting" once it has passed.
test('a window\'s reset reads short in the limits pane', () => {
  // Local times, so the weekday and the clock do not depend on the machine's zone.
  const now = new Date(2026, 9, 12, 13, 20).getTime()
  const at = (ms: number) => new Date(now + ms).toISOString()
  assert.equal(resetShort(at(25 * 60_000), now, 'ko'), '25분 뒤')
  assert.equal(resetShort(at(2 * 3_600_000), now, 'ko'), '2시간 뒤')
  assert.equal(resetShort(at(25 * 60_000), now, 'en'), 'in 25m')
  assert.equal(resetShort(at(2 * 3_600_000), now, 'en'), 'in 2h')
  assert.equal(resetShort(at(19 * 3_600_000), now, 'ko'), '19시간 뒤')
  // Past twenty hours the weekday and the clock say more than a long count of hours — the line the
  // router's own status label (`limitLabel` in session.ts) draws at the same place.
  const far = new Date(2026, 9, 15, 9, 0).toISOString()
  assert.equal(resetShort(far, now, 'ko'), '목 09:00')
  assert.equal(resetShort(far, now, 'en'), 'Thu 09:00')
  assert.equal(resetShort(far, now, 'zh'), '周四 09:00')
  assert.equal(resetShort(far, now, 'ja'), '木 09:00')
  // A reset that has passed, no reset at all, and a time that is not one.
  assert.equal(resetShort(at(-60_000), now, 'ko'), '초기화 중')
  assert.equal(resetShort(undefined, now, 'ko'), undefined)
  assert.equal(resetShort('not a time', now, 'ko'), undefined)
})

// A provider with several accounts numbers every one of them, read from the whole set before any
// narrowing; a provider with one goes unnumbered.
test('only a provider with several accounts numbers them', () => {
  const groups = limitGroups([
    { provider: 'claude', account: 0, kind: 'five_hour', label: '', percent: 1 },
    { provider: 'chatgpt', account: 0, kind: 'seven_day', label: '', percent: 2 },
    { provider: 'chatgpt', account: 1, kind: 'seven_day', label: '', percent: 3 },
  ])
  const numbered = limitGroupNumbered(groups)
  assert.deepEqual(groups.map(g => limitGroupName(g, numbered(g))), ['Claude', 'GPT 1', 'GPT 2'])
  assert.equal(limitGroupNumbered(groups.slice(0, 1))(groups[0]!), false)
})

test('the bar rounds to integers, and tones the fill', () => {
  assert.equal(barArt(23.4, 'ink'), barArt(23, 'ink'), 'the same figure draws the same picture')
  assert.notEqual(barArt(23.6, 'ink'), barArt(23.4, 'ink'))
  assert.ok(barArt(50, 'ink').includes('#67e8f9'), 'the well reading keeps the teal-to-violet fill')
  assert.ok(barArt(88, 'amber').includes('#fde68a'))
  assert.ok(barArt(97, 'red').includes('#fecdd3'))
})

test('the whole row comes from /api/limits: every provider, in the router order', () => {
  const future = new Date(NOW + 3_600_000)
  const past = new Date(NOW - 3_600_000)
  const win = (kind: string, used_percent: number, window_minutes: number, reset_at?: number) => ({ kind, used_percent, window_minutes, ...(reset_at !== undefined ? { reset_at } : {}) })
  const body = {
    providers: [
      { provider: 'anthropic', type: 'anthropic', title: 'Claude', accounts: [{ account: 0, at: NOW, windows: [
        win('five_hour', 1, 300),
        win('seven_day', 88, 10080, future.getTime() / 1000),
        { kind: 'scoped', label: 'Fable', used_percent: 2, window_minutes: 10080, reset_at: future.getTime() / 1000 },
      ] }] },
      { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', accounts: [{ account: 0, at: NOW, windows: [win('seven_day', 23, 10080, future.getTime() / 1000)] }] },
      { provider: 'google-gemini', type: 'google', title: 'Gemini', accounts: [{ account: 0, at: NOW, windows: [
        win('five_hour', 0, 300),
        win('seven_day', 2, 10080, future.getTime() / 1000),
        { kind: 'scoped', label: '3P', used_percent: 10, window_minutes: 10080, reset_at: future.getTime() / 1000 },
      ] }] },
      { provider: 'opencode-go', type: 'opencode-go', title: 'Go', accounts: [{ account: 0, at: NOW, windows: [
        win('five_hour', 3, 300, future.getTime() / 1000),
        win('seven_day', 52, 10080, future.getTime() / 1000),
        win('window', 92, 43200, future.getTime() / 1000),
      ] }] },
    ],
  }
  const items = routerLimitItems(body, NOW)
  assert.deepEqual(items.map(i => `${i.title}/${i.kind}${i.label ? ':' + i.label : ''}`), [
    'Claude/five_hour', 'Claude/seven_day', 'Claude/scoped:Fable',
    'GPT/seven_day', 'Gemini/five_hour', 'Gemini/seven_day', 'Gemini/scoped:3P',
    'Go/five_hour', 'Go/seven_day', 'Go/window',
  ])
  assert.equal(items[0]!.type, 'anthropic')
  assert.equal(items[3]!.type, 'chatgpt')
  assert.equal(items[9]!.windowMinutes, 43200)
  assert.equal(items[9]!.percent, 92)
  // A window whose reset has passed starts again at 0% with no reset to show; an unreadable body leaves nothing.
  const stale = { providers: [{ provider: 'x', type: 'chatgpt', title: 'GPT', accounts: [{ account: 0, at: NOW, windows: [win('seven_day', 5, 10080, past.getTime() / 1000)] }] }] }
  const reset = routerLimitItems(stale, NOW)
  assert.deepEqual(reset.map(i => [i.kind, i.percent, i.resetsAt]), [['seven_day', 0, undefined]])
  assert.deepEqual(routerLimitItems({}, NOW), [])
  assert.deepEqual(routerLimitItems(null, NOW), [])
})

test('Argon weekly survives the router limits parser and keeps its own name in the view', () => {
  const resetAt = (NOW + 2 * 3_600_000) / 1000
  const body = { providers: [{ provider: 'ag', type: 'google', title: 'Gemini', accounts: [
    { account: 0, at: NOW, windows: [
      { kind: 'five_hour', used_percent: 13, window_minutes: 300, reset_at: resetAt },
      { kind: 'seven_day', used_percent: 24, window_minutes: 10080, reset_at: resetAt },
      { kind: 'scoped', label: 'Argon weekly', used_percent: 65, window_minutes: 10080, reset_at: resetAt },
    ] },
    { account: 1, at: NOW, windows: [
      { kind: 'scoped', label: 'Argon weekly', used_percent: 35, window_minutes: 10080, reset_at: resetAt },
    ] },
  ] }] }
  const items = routerLimitItems(body, NOW)
  assert.deepEqual(items.map(i => [i.kind, i.label, i.percent]), [
    ['five_hour', '', 13], ['seven_day', '', 24], ['scoped', 'Argon weekly', 65], ['scoped', 'Argon weekly', 35],
  ])
  const argon = items[2]!
  assert.equal(argon.windowMinutes, 10080)
  assert.equal(argon.resetsAt, new Date(resetAt * 1000).toISOString())
  for (const lang of ['en', 'ko'] as const) assert.equal(limitItemName(argon, lang), 'Argon weekly')
  const groups = limitGroups(items)
  const numbered = limitGroupNumbered(groups)
  assert.deepEqual(groups.map(g => limitGroupName(g, numbered(g))), ['Gemini 1', 'Gemini 2'])
  const clock = new Date(resetAt * 1000)
  const time = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`
  assert.equal(limitItemTip(argon, 'Gemini 1', 'en', NOW), `Gemini 1 Argon weekly 65% · resets ${time}`)
})

test('the groups name and order every provider; Claude first, accounts numbered per provider', () => {
  const items = [
    { provider: 'opencode-go', type: 'opencode-go', title: 'Go', account: 0, kind: 'five_hour' as const, label: '', percent: 3 },
    { provider: 'anthropic', type: 'anthropic', title: 'Claude', account: 0, kind: 'five_hour' as const, label: '', percent: 1 },
    { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 0, kind: 'seven_day' as const, label: '', percent: 23 },
    { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 1, kind: 'seven_day' as const, label: '', percent: 41 },
    { provider: 'google-gemini', type: 'google', title: 'Gemini', account: 0, kind: 'seven_day' as const, label: '', percent: 2 },
  ]
  const groups = limitGroups(items)
  assert.deepEqual(groups.map(g => limitGroupName(g, false)), ['Claude', 'Go', 'GPT', 'GPT', 'Gemini'])
  assert.deepEqual(groups.map(g => g.key), ['anthropic#0', 'opencode-go#0', 'chatgpt#0', 'chatgpt#1', 'google-gemini#0'])
  // Numbering is per provider: GPT has two accounts, so both read numbered; the others do not.
  const accounts = new Map<string, number>()
  for (const g of groups) accounts.set(g.provider, (accounts.get(g.provider) ?? 0) + 1)
  assert.deepEqual(groups.map(g => limitGroupName(g, (accounts.get(g.provider) ?? 1) > 1)), ['Claude', 'Go', 'GPT 1', 'GPT 2', 'Gemini'])
})

test('narrowing drops later providers\' scoped windows, then secondary accounts, then whole groups, and Claude\'s Fable last', () => {
  const group = (provider: string, account: number, kinds: string[]) => ({
    key: provider + '#' + account, provider, account,
    items: kinds.map((kind, i) => ({ provider, account, kind, label: kind === 'scoped' ? 'S' : '', percent: i })),
  })
  const base = [group('anthropic', 0, ['five_hour', 'seven_day', 'scoped']), group('chatgpt', 0, ['seven_day']), group('google-gemini', 0, ['five_hour', 'seven_day', 'scoped']), group('opencode-go', 0, ['five_hour', 'seven_day', 'window'])]
  const measure = (gs: readonly { items: unknown[] }[]) => gs.reduce((n, g) => n + g.items.length, 0) + gs.length
  // Everything fits: unchanged.
  assert.deepEqual(narrowLimitGroups(base, 100, measure)?.map(g => g.key), ['anthropic#0', 'chatgpt#0', 'google-gemini#0', 'opencode-go#0'])
  // The trailing group goes; Gemini's scoped window goes first and returns only if it fits (here it does not, see the refill test).
  const narrowed = narrowLimitGroups(base, 11, measure)
  assert.deepEqual(narrowed?.map(g => g.key), ['anthropic#0', 'chatgpt#0', 'google-gemini#0'])
  assert.deepEqual(narrowed?.[0]?.items.map(i => i.kind), ['five_hour', 'seven_day', 'scoped'])
  // Scoped windows go one group at a time from the back: Gemini's before Claude's Fable.
  const one = narrowLimitGroups(base, 13, measure)
  assert.deepEqual(one?.map(g => g.items.some(i => i.kind === 'scoped')), [true, false, false, false])
  // Down to Claude alone, Fable still there; and null when not even Claude's main windows fit.
  assert.deepEqual(narrowLimitGroups(base, 4, measure)?.map(g => g.key), ['anthropic#0'])
  assert.deepEqual(narrowLimitGroups(base, 4, measure)?.[0]?.items.map(i => i.kind), ['five_hour', 'seven_day', 'scoped'])
  assert.equal(narrowLimitGroups(base, 1, measure), null)
  // Claude's group stays to the last even as a stored account (account 1) the row shows for being in use.
  const stored = [group('anthropic', 1, ['five_hour']), group('chatgpt', 0, ['seven_day']), group('chatgpt', 1, ['seven_day'])]
  assert.deepEqual(narrowLimitGroups(stored, 4, measure)?.map(g => g.key), ['anthropic#1', 'chatgpt#0'])
  assert.deepEqual(narrowLimitGroups(stored, 2, measure)?.map(g => g.key), ['anthropic#1'])
  // A provider's only group is never a secondary account, whatever its number: Gemini's account in
  // use (account 1) outlasts MiniMax after it (2026-11-09).
  const band = [group('anthropic', 0, ['seven_day']), group('google-gemini', 1, ['five_hour', 'seven_day']), group('minimax', 0, ['five_hour', 'seven_day'])]
  assert.deepEqual(narrowLimitGroups(band, 6, measure)?.map(g => g.key), ['anthropic#0', 'google-gemini#1'])
})

test('narrowing keeps Claude\'s Fable until every later provider is gone (the owner, 2026-11-10)', () => {
  const group = (provider: string, account: number, kinds: string[]) => ({
    key: provider + '#' + account, provider, account,
    items: kinds.map((kind, i) => ({ provider, account, kind, label: kind === 'scoped' ? 'S' : '', percent: i })),
  })
  const measure = (gs: readonly { items: unknown[] }[]) => gs.reduce((n, g) => n + g.items.length, 0) + gs.length
  // Claude [weekly, Fable], GPT, Gemini [main, 3P], MiniMax: 8 windows in 4 groups, 12 cells.
  const all = [group('anthropic', 0, ['seven_day', 'scoped']), group('chatgpt', 0, ['seven_day']), group('google-gemini', 0, ['five_hour', 'seven_day', 'scoped']), group('minimax', 0, ['five_hour', 'seven_day'])]
  assert.deepEqual(narrowLimitGroups(all, 12, measure)?.map(g => g.items.length), [2, 1, 3, 2])
  // Gemini's 3P goes first.
  const no3p = narrowLimitGroups(all, 11, measure)
  assert.deepEqual(no3p?.map(g => g.key), ['anthropic#0', 'chatgpt#0', 'google-gemini#0', 'minimax#0'])
  assert.deepEqual(no3p?.map(g => g.items.map(i => i.kind)), [['seven_day', 'scoped'], ['seven_day'], ['five_hour', 'seven_day'], ['five_hour', 'seven_day']])
  // Then MiniMax, the last group, then Gemini, then GPT; Claude's Fable outlasts all of them.
  assert.deepEqual(narrowLimitGroups(all, 10, measure)?.map(g => g.key), ['anthropic#0', 'chatgpt#0', 'google-gemini#0'])
  assert.deepEqual(narrowLimitGroups(all, 7, measure)?.map(g => g.key), ['anthropic#0', 'chatgpt#0'])
  assert.deepEqual(narrowLimitGroups(all, 4, measure)?.map(g => g.key), ['anthropic#0'])
  assert.deepEqual(narrowLimitGroups(all, 4, measure)?.[0]?.items.map(i => i.kind), ['seven_day', 'scoped'])
  // A budget that fits only Claude's weekly: Fable goes, weekly stays.
  assert.deepEqual(narrowLimitGroups(all, 2, measure)?.map(g => [g.key, g.items.map(i => i.kind)]), [['anthropic#0', ['seven_day']]])
  // Null when not even Claude's weekly fits.
  assert.equal(narrowLimitGroups(all, 1, measure), null)
})

test('the first group keeps its place as last whether or not it is Claude\'s', () => {
  const group = (provider: string, kinds: string[]) => ({
    key: provider + '#0', provider, account: 0,
    items: kinds.map((kind, i) => ({ provider, account: 0, kind, label: kind === 'scoped' ? 'S' : '', percent: i })),
  })
  const measure = (gs: readonly { items: unknown[] }[]) => gs.reduce((n, g) => n + g.items.length, 0) + gs.length
  // No Claude windows: GPT is index 0, so its scoped window goes only after Gemini's whole group.
  const gpt = [group('chatgpt', ['seven_day', 'scoped']), group('google-gemini', ['seven_day', 'scoped'])]
  assert.deepEqual(narrowLimitGroups(gpt, 5, measure)?.map(g => [g.key, g.items.some(i => i.kind === 'scoped')]), [['chatgpt#0', true], ['google-gemini#0', false]])
  assert.deepEqual(narrowLimitGroups(gpt, 4, measure)?.map(g => [g.key, g.items.some(i => i.kind === 'scoped')]), [['chatgpt#0', true]])
  assert.deepEqual(narrowLimitGroups(gpt, 2, measure)?.map(g => [g.key, g.items.map(i => i.kind)]), [['chatgpt#0', ['seven_day']]])
})

test('Claude\'s Fable is dropped only when Claude\'s own group is all that is left and it does not fit with Fable', () => {
  const group = (provider: string, account: number, kinds: string[]) => ({
    key: provider + '#' + account, provider, account,
    items: kinds.map((kind, i) => ({ provider, account, kind, label: kind === 'scoped' ? 'S' : '', percent: i })),
  })
  const measure = (gs: readonly { items: unknown[] }[]) => gs.reduce((n, g) => n + g.items.length, 0) + gs.length
  // The five providers of the owner's band (2026-11-10), in the router's order.
  const all = [group('anthropic', 0, ['seven_day', 'scoped']), group('chatgpt', 0, ['seven_day']), group('google-gemini', 0, ['five_hour', 'seven_day', 'scoped']), group('opencode-go', 0, ['five_hour', 'seven_day', 'window']), group('minimax', 0, ['five_hour', 'seven_day'])]
  for (let budget = 1; budget <= 30; budget++) {
    const out = narrowLimitGroups(all, budget, measure)
    if (!out || out[0]?.items.some(i => i.kind === 'scoped')) continue
    // Fable is gone: nothing but Claude's group may be left, and Claude with Fable must not fit.
    assert.equal(out.length, 1, 'budget ' + budget)
    assert.ok(measure([all[0]!]) > budget, 'budget ' + budget)
  }
})

test('refill: a dropped scoped window comes back when the row still fits, and stays out when it does not (2026-11-10)', () => {
  const group = (provider: string, account: number, kinds: string[]) => ({
    key: provider + '#' + account, provider, account,
    items: kinds.map((kind, i) => ({ provider, account, kind, label: kind === 'scoped' ? 'S' : '', percent: i })),
  })
  const measure = (gs: readonly { items: unknown[] }[]) => gs.reduce((n, g) => n + g.items.length, 0) + gs.length
  // The owner's five providers: Gemini's scoped 3P window (Argon) is the one that drops first after Claude's.
  const all = [group('anthropic', 0, ['seven_day', 'scoped']), group('chatgpt', 0, ['seven_day']), group('google-gemini', 0, ['five_hour', 'seven_day', 'scoped']), group('opencode-go', 0, ['five_hour', 'seven_day', 'window']), group('minimax', 0, ['five_hour', 'seven_day'])]
  // 13 cells: MiniMax goes, and then Gemini's 3P fits again beside the rest.
  const roomy = narrowLimitGroups(all, 13, measure)
  assert.deepEqual(roomy?.map(g => g.key), ['anthropic#0', 'chatgpt#0', 'google-gemini#0', 'opencode-go#0'])
  assert.deepEqual(roomy?.[2]?.items.map(i => i.kind), ['five_hour', 'seven_day', 'scoped'])
  // 12 cells: the same window needs 13, so it stays out and Gemini keeps its main windows.
  const tight = narrowLimitGroups(all, 12, measure)
  assert.deepEqual(tight?.map(g => g.key), ['anthropic#0', 'chatgpt#0', 'google-gemini#0', 'opencode-go#0'])
  assert.deepEqual(tight?.[2]?.items.map(i => i.kind), ['five_hour', 'seven_day'])
  // 9 cells: Go is gone as a group and Gemini's 3P is back; at 8 it is not.
  assert.deepEqual(narrowLimitGroups(all, 9, measure)?.[2]?.items.map(i => i.kind), ['five_hour', 'seven_day', 'scoped'])
  assert.deepEqual(narrowLimitGroups(all, 8, measure)?.map(g => g.key), ['anthropic#0', 'chatgpt#0', 'google-gemini#0'])
  assert.deepEqual(narrowLimitGroups(all, 8, measure)?.[2]?.items.map(i => i.kind), ['five_hour', 'seven_day'])
  // Whatever the budget, the row fits it; a dropped group never comes back (MiniMax below 15, Go below 12).
  for (let budget = 1; budget <= 30; budget++) {
    const out = narrowLimitGroups(all, budget, measure)
    if (!out) continue
    assert.ok(measure(out) <= budget, 'budget ' + budget)
    if (budget <= 14) assert.ok(!out.some(g => g.key === 'minimax#0'), 'minimax at ' + budget)
    if (budget <= 11) assert.ok(!out.some(g => g.key === 'opencode-go#0'), 'go at ' + budget)
  }
})

/** Several Claude accounts as `GET /api/limits` lists them (2026-11-04), and two GPT accounts. */
const MANY = { providers: [
  { provider: 'anthropic', type: 'anthropic', title: 'Claude', accounts: [
    { account: 0, at: NOW, windows: [{ kind: 'five_hour', used_percent: 81, window_minutes: 300 }] },
    { account: 1, label: 'work@example.com', inUse: true, at: NOW, windows: [{ kind: 'five_hour', used_percent: 15, window_minutes: 300 }, { kind: 'scoped', label: 'Fable', used_percent: 2, window_minutes: 10080 }] },
    { account: 3, label: 'Claude account 3', at: NOW, windows: [{ kind: 'five_hour', used_percent: 40, window_minutes: 300 }] },
  ] },
  { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', accounts: [
    { account: 0, label: 'me@example.com', at: NOW, windows: [{ kind: 'seven_day', used_percent: 23, window_minutes: 10080 }] },
    { account: 1, label: 'team', inUse: true, at: NOW, windows: [{ kind: 'seven_day', used_percent: 64, window_minutes: 10080 }] },
  ] },
] }

test('each account\'s label and in-use mark reach every one of its windows; an older router sends neither', () => {
  const items = routerLimitItems(MANY, NOW)
  assert.deepEqual(items.map(i => [i.title, i.account, i.accountLabel, i.inUse, i.kind, i.label]), [
    ['Claude', 0, undefined, undefined, 'five_hour', ''],
    ['Claude', 1, 'work@example.com', true, 'five_hour', ''],
    ['Claude', 1, 'work@example.com', true, 'scoped', 'Fable'],
    ['Claude', 3, 'Claude account 3', undefined, 'five_hour', ''],
    ['GPT', 0, 'me@example.com', undefined, 'seven_day', ''],
    ['GPT', 1, 'team', true, 'seven_day', ''],
  ])
  // The fields are left out, not set to undefined, where the router gave none (and inUse only when true).
  assert.equal('accountLabel' in items[0]!, false)
  assert.equal('inUse' in items[4]!, false)
  const odd = routerLimitItems({ providers: [{ provider: 'a', type: 'anthropic', accounts: [{ account: 0, label: '', inUse: 'yes', windows: [{ kind: 'five_hour', used_percent: 1 }] }] }] }, NOW)
  assert.deepEqual(odd.map(i => ['accountLabel' in i, 'inUse' in i]), [[false, false]])
})

test('the pane numbers several accounts and says, after the name, which one is in use, then its label', () => {
  const groups = limitGroups(routerLimitItems(MANY, NOW))
  const numbered = limitGroupNumbered(groups)
  const heads = (lang: 'ko' | 'en') => groups.map(g => [limitGroupName(g, numbered(g)), limitGroupAccount(g, numbered(g), lang)])
  // The tag and the label apart: the tag is drawn right after the name and never cut, the label after it.
  assert.deepEqual(heads('ko'), [
    ['Claude 1', { tag: '', label: '' }],
    ['Claude 2', { tag: '사용 중', label: 'work' }],
    // The router's placeholder name says nothing the number does not.
    ['Claude 4', { tag: '', label: '' }],
    ['GPT 1', { tag: '', label: 'me' }],
    ['GPT 2', { tag: '사용 중', label: 'team' }],
  ])
  assert.deepEqual(heads('en')[1]![1], { tag: 'in use', label: 'work' })
  // One account reads as it always has: no number, no tag, no label, whatever the router marks.
  const one = limitGroups(routerLimitItems({ providers: [MANY.providers[0]!].map(p => ({ ...p, accounts: [p.accounts[1]!] })) }, NOW))
  assert.deepEqual(one.map(g => [limitGroupName(g, limitGroupNumbered(one)(g)), limitGroupAccount(g, limitGroupNumbered(one)(g), 'ko')]), [['Claude', { tag: '', label: '' }]])
})

test('an account label reads short: an email\'s local part, a long name cut, a placeholder or nothing left out', () => {
  assert.equal(limitAccountLabel('work@example.com'), 'work')
  assert.equal(limitAccountLabel('Personal'), 'Personal')
  assert.equal(limitAccountLabel('Codex CLI login'), 'Codex CLI login')
  assert.equal(limitAccountLabel('a-very-long-account-name-for-the-team@example.com'), 'a-very-long-account-nam…')
  assert.equal(limitAccountLabel('@handle'), '@handle')
  assert.equal(limitAccountLabel('ChatGPT account'), '')
  assert.equal(limitAccountLabel('Google account 2'), '')
  assert.equal(limitAccountLabel('\x1b[31mred\x1b[0m'), 'red')
  assert.equal(limitAccountLabel(undefined), '')
  assert.equal(limitAccountLabel('  '), '')
})

test('the band keeps one account per provider, the one in use, unnumbered', () => {
  const groups = limitGroups(routerLimitItems(MANY, NOW))
  const band = bandLimitGroups(groups)
  assert.deepEqual(band.map(g => g.key), ['anthropic#1', 'chatgpt#1'])
  const numbered = limitGroupNumbered(band)
  assert.deepEqual(band.map(g => limitGroupName(g, numbered(g))), ['Claude', 'GPT'])
  // None marked (an older router, or the in-use account's usage unknown): the first, the app login.
  const unmarked = limitGroups(routerLimitItems({ providers: [{ ...MANY.providers[0]!, accounts: MANY.providers[0]!.accounts.map(({ inUse: _, ...a }) => a) }] }, NOW))
  assert.deepEqual(bandLimitGroups(unmarked).map(g => g.key), ['anthropic#0'])
  // A single Claude account and the fallback path's 'claude' provider pass unchanged.
  const fallback = limitGroups([{ provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'five_hour', label: '', percent: 3 }])
  assert.deepEqual(bandLimitGroups(fallback), fallback)
})

// 2026-11-09: the router forecasts a window that will reach 100% before it resets (`exhaust_at`).
// It is parsed into the item (epoch ms), colours the window's figure (amber, red within the hour),
// and says in the tip how long is left; a window without a forecast is exactly what it was.
const forecastBody = (windows: unknown[]) => ({ providers: [{ provider: 'anthropic', type: 'anthropic', title: 'Claude', accounts: [{ account: 0, windows }] }] })

test('exhaust_at is read in seconds or ms into exhaustsAt; a stale, late or unreadable one is no forecast', () => {
  const at = NOW / 1000
  const reset = at + 5 * 3600
  const win = (extra: Record<string, unknown>) => ({ kind: 'five_hour', used_percent: 70, window_minutes: 300, reset_at: reset, ...extra })
  const items = routerLimitItems(forecastBody([
    win({ exhaust_at: at + 7800 }),
    win({ exhaust_at: (at + 600) * 1000 }),
    win({ exhaust_at: at - 60 }),
    win({ exhaust_at: reset }),
    win({ exhaust_at: reset + 3600 }),
    win({ exhaust_at: 'soon' }),
    win({}),
    { kind: 'seven_day', used_percent: 40, window_minutes: 10080, exhaust_at: at + 3600 },
  ]), NOW)
  assert.deepEqual(items.map(i => i.exhaustsAt), [NOW + 7_800_000, NOW + 600_000, undefined, undefined, undefined, undefined, undefined, NOW + 3_600_000])
  // A window with no forecast has no key at all: it is the item it was.
  assert.equal('exhaustsAt' in items[2]!, false)
  assert.deepEqual(items[6], { provider: 'anthropic', type: 'anthropic', title: 'Claude', account: 0, kind: 'five_hour', label: '', windowMinutes: 300, percent: 70, resetsAt: new Date(reset * 1000).toISOString() })
  // A window whose reset has passed restarts at 0%: its old forecast goes with it.
  const passed = routerLimitItems(forecastBody([win({ reset_at: at - 60, exhaust_at: at + 600 })]), NOW)
  assert.deepEqual(passed.map(i => [i.percent, i.exhaustsAt]), [[0, undefined]])
})

// 2026-11-10: the router projects a window's share at its reset at its average pace (`projected_percent`).
test('projected_percent is read into projectedPercent; unreadable or passed-reset windows have none', () => {
  const at = NOW / 1000
  const reset = at + 5 * 3600
  const win = (extra: Record<string, unknown>) => ({ kind: 'seven_day', used_percent: 54, window_minutes: 10080, reset_at: reset, ...extra })
  const items = routerLimitItems(forecastBody([
    win({ projected_percent: 82 }),
    win({ projected_percent: 'lots' }),
    win({ projected_percent: Number.NaN }),
    win({ projected_percent: Number.POSITIVE_INFINITY }),
    win({}),
  ]), NOW)
  assert.deepEqual(items.map(i => i.projectedPercent), [82, undefined, undefined, undefined, undefined])
  assert.equal('projectedPercent' in items[1]!, false, 'a non-number is no projection at all')
  // A window whose reset has passed restarts at 0%: its old projection goes with it.
  const passed = routerLimitItems(forecastBody([win({ reset_at: at - 60, projected_percent: 82 })]), NOW)
  assert.deepEqual(passed.map(i => [i.percent, i.projectedPercent]), [[0, undefined]])
  assert.equal('projectedPercent' in passed[0]!, false)
})

test('the pace label: an exhaust forecast wins; under 95 comfortable, 95 to 100 tight, otherwise none', () => {
  const base = { provider: 'claude', account: 0, kind: 'seven_day' as const, label: '', percent: 54, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() }
  const at = (projectedPercent?: number, exhaustMinutes?: number) => ({
    ...base,
    ...(projectedPercent !== undefined ? { projectedPercent } : {}),
    ...(exhaustMinutes !== undefined ? { exhaustsAt: NOW + exhaustMinutes * 60_000 } : {}),
  })
  // The exhaust sentence keeps its own line; the pace label is not said beside it.
  assert.equal(paceLevel(at(190, 130), NOW), null)
  assert.equal(paceLabel(at(190, 130), NOW, 'en'), '')
  assert.equal(exhaustSentence(at(190, 130), NOW, 'en'), 'At this pace it runs out in 2h 10m')
  // Under 95 projected: comfortable.
  assert.equal(paceLevel(at(54), NOW), 'comfortable')
  assert.equal(paceLabel(at(54), NOW, 'en'), 'projected 54%')
  assert.equal(paceLevel(at(94), NOW), 'comfortable')
  assert.equal(paceLabel(at(94.4), NOW, 'en'), 'projected 94%')
  // 95 to 100: tight, the figure rounded.
  assert.equal(paceLevel(at(95), NOW), 'tight')
  assert.equal(paceLabel(at(95.4), NOW, 'en'), 'projected 95%')
  assert.equal(paceLabel(at(99.4), NOW, 'en'), 'projected 99%')
  // Rounded to 100 without an exhaust moment (it lands right at the reset): still tight.
  assert.equal(paceLevel(at(100), NOW), 'tight')
  assert.equal(paceLabel(at(100), NOW, 'en'), 'projected 100%')
  // Past 100 with no exhaust moment (an old reading) says nothing; no projection says nothing.
  assert.equal(paceLevel(at(101), NOW), null)
  assert.equal(paceLabel(at(101), NOW, 'en'), '')
  assert.equal(paceLabel(at(187), NOW, 'en'), '')
  assert.equal(paceLabel(at(), NOW, 'en'), '')
  // A passed exhaust moment is no exhaust forecast, so the pace speaks again.
  assert.equal(paceLabel(at(54, -1), NOW, 'en'), 'projected 54%')
})

test('a pace label goes quiet once its window has reset or when no reset is given, since no time left sits beside it', () => {
  const item = (resetMinutes: number) => ({ provider: 'claude', account: 0, kind: 'five_hour' as const, label: '', percent: 54, projectedPercent: 54, resetsAt: new Date(NOW + resetMinutes * 60_000).toISOString() })
  assert.equal(paceLevel(item(1), NOW), 'comfortable')
  assert.equal(paceLabel(item(1), NOW, 'en'), 'projected 54%')
  assert.equal(paceLevel(item(0), NOW), null)
  assert.equal(paceLabel(item(-1), NOW, 'en'), '')
  const noReset = { provider: 'claude', account: 0, kind: 'five_hour' as const, label: '', percent: 54, projectedPercent: 54 }
  assert.equal(paceLevel(noReset, NOW), null)
  assert.equal(paceLabel(noReset, NOW, 'en'), '')
})

test('the pace label reads in Korean as the owner set it (2026-11-10)', () => {
  const item = (projectedPercent: number) => ({ provider: 'claude', account: 0, kind: 'seven_day' as const, label: '', percent: 56, projectedPercent, resetsAt: new Date(NOW + 2 * 86_400_000 + 9 * 3_600_000).toISOString() })
  assert.equal(paceLabel(item(84), NOW, 'ko'), '예상 사용률 84%')
  assert.equal(paceLabel(item(97), NOW, 'ko'), '예상 사용률 97%')
  // The line the pane draws after the reset: the time left, then the label after " · ".
  assert.equal(t('ko', 'limits.left', { time: timeLeft(2 * 86_400_000 + 9 * 3_600_000, 'ko') }) + ' · ' + paceLabel(item(84), NOW, 'ko'), '2일 9시간 남음 · 예상 사용률 84%')
})

test('a forecast makes the tone at least amber, red within the hour; no forecast keeps the share\'s tone', () => {
  const win = (percent: number, minutes?: number) => ({ percent, ...(minutes !== undefined ? { exhaustsAt: NOW + minutes * 60_000 } : {}) })
  assert.equal(limitItemTone(win(10), NOW), 'ink')
  assert.equal(limitItemTone(win(85), NOW), 'warn')
  assert.equal(limitItemTone(win(97), NOW), 'bad')
  assert.equal(limitItemTone(win(10, 130), NOW), 'warn')
  assert.equal(limitItemTone(win(10, 61), NOW), 'warn')
  assert.equal(limitItemTone(win(10, 60), NOW), 'bad')
  assert.equal(limitItemTone(win(10, 5), NOW), 'bad')
  assert.equal(limitItemTone(win(85, 45), NOW), 'bad')
  assert.equal(limitItemTone(win(97, 300), NOW), 'bad')
  // Its moment past, the forecast is gone.
  assert.equal(limitItemTone(win(10, -1), NOW), 'ink')
  assert.equal(exhaustLeft(win(10, -1), NOW), null)
  assert.equal(exhaustLeft(win(10), NOW), null)
  assert.equal(exhaustLeft(win(10, 2), NOW), 120_000)
})

test('the band shortens the time left to ~45m, ~2h, ~3d in each language', () => {
  const min = 60_000
  assert.equal(exhaustShort(45 * min, 'en'), '~45m')
  assert.equal(exhaustShort(45 * min, 'ko'), '~45분')
  assert.equal(exhaustShort(130 * min, 'en'), '~2h')
  assert.equal(exhaustShort(130 * min, 'ko'), '~2시간')
  assert.equal(exhaustShort(130 * min, 'ja'), '~2時間')
  assert.equal(exhaustShort(130 * min, 'zh'), '~2小时')
  assert.equal(exhaustShort(130 * min, 'es'), '~2 h')
  assert.equal(exhaustShort(130 * min, 'pt'), '~2 h')
  assert.equal(exhaustShort(3 * 86_400_000, 'en'), '~3d')
  assert.equal(exhaustShort(3 * 86_400_000, 'ko'), '~3일')
  // Under a minute still reads one; the hour is rounded to the nearest, and a day and a half stays in hours.
  assert.equal(exhaustShort(20_000, 'en'), '~1m')
  assert.equal(exhaustShort(59 * min + 10_000, 'en'), '~1h')
  assert.equal(exhaustShort(90 * min, 'en'), '~2h')
  assert.equal(exhaustShort(36 * 60 * min, 'en'), '~36h')
  assert.equal(exhaustShort(48 * 60 * min, 'en'), '~2d')
  // The widest forms (for the band's fixed slot) are the three kinds.
  assert.deepEqual(exhaustShortWidest('en'), ['~59m', '~47h', '~7d'])
  assert.deepEqual(exhaustShortWidest('ko'), ['~59분', '~47시간', '~7일'])
})

test('the tip says how long until the window runs out at its pace; without a forecast it is as before', () => {
  const base = { provider: 'claude', account: 0, kind: 'seven_day' as const, label: '', percent: 62, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() }
  const risky = { ...base, exhaustsAt: NOW + (2 * 60 + 10) * 60_000 }
  assert.equal(limitItemTip(base, 'Claude', 'en', NOW), 'Claude Weekly 62% · resets in 3d')
  assert.equal(limitItemTip(risky, 'Claude', 'en', NOW), 'Claude Weekly 62% · resets in 3d · At this pace it runs out in 2h 10m')
  assert.equal(limitItemTip(risky, 'Claude', 'ko', NOW), 'Claude 주간 62% · 3일 뒤 초기화 · 이 속도라면 2시간 10분 후 한도가 소진됩니다')
  assert.equal(exhaustSentence(risky, NOW, 'en'), 'At this pace it runs out in 2h 10m')
  assert.equal(exhaustSentence(base, NOW, 'en'), '')
  assert.equal(exhaustSentence({ exhaustsAt: NOW - 1 }, NOW, 'en'), '')
  assert.equal(exhaustSentence({ exhaustsAt: NOW + 45 * 60_000 }, NOW, 'en'), 'At this pace it runs out in 45m')
})

// The limits pane's cost tile reads GET /api/requests/summary?from=&to=: every bucket carries
// `costUsd`, `unpricedRequests` and `estimatedRequests` (the router worker's contract).
const bucket = (costUsd: number, unpricedRequests = 0, estimatedRequests = 0) => ({ count: 10, ok: 10, failed: 0, input: 1, cached: 0, cacheWrite: 0, output: 1, avgMs: 100, cacheHitPercent: 0, conversationTokens: 2, costUsd, unpricedRequests, estimatedRequests })
const SUMMARY = {
  total: bucket(15.678, 3, 12),
  providers: { anthropic: bucket(12.3, 0, 12), chatgpt: bucket(3.378), 'opencode-go': bucket(0, 3), idle: bucket(0) },
  models: [
    { provider: 'anthropic', model: 'claude-opus-5-5', ...bucket(9.9, 0, 12) },
    { provider: 'anthropic', model: 'claude-sonnet-5-5', ...bucket(2.4) },
    { provider: 'chatgpt', model: 'gpt-5.5', ...bucket(3.378) },
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash', ...bucket(0, 3) },
    { provider: 'anthropic', model: 'claude-haiku-5-5', ...bucket(0.004) },
    { provider: 'anthropic', model: 'claude-fable', ...bucket(1.1) },
    { provider: 'anthropic', model: 'claude-mythos', ...bucket(0.5) },
    { provider: 'anthropic', model: 'unused', ...bucket(0) },
  ],
  earliest: null,
}

test('a cost summary keeps the total, each provider, and the five models that cost most', () => {
  const from = Date.parse('2026-10-15T00:00:00')
  const cost = costFromSummary(SUMMARY, from)!
  assert.equal(cost.from, from)
  assert.deepEqual(cost.total, { costUsd: 15.678, unpricedRequests: 3, estimatedRequests: 12 })
  // Most cost first; a provider with only unpriced requests after the priced; one with nothing is left out.
  assert.deepEqual(cost.providers.map(p => p.name), ['anthropic', 'chatgpt', 'opencode-go'])
  assert.deepEqual(cost.models.map(m => m.name), ['claude-opus-5-5', 'gpt-5.5', 'claude-sonnet-5-5', 'claude-fable', 'claude-mythos'])
  assert.equal(cost.models.length, COST_MODELS)
  // Fewer than five: the tiny and the unpriced-only follow, a model with nothing is left out.
  assert.deepEqual(costFromSummary({ ...SUMMARY, models: SUMMARY.models.slice(3) }, from)!.models.map(m => m.name), ['claude-fable', 'claude-mythos', 'claude-haiku-5-5', 'deepseek-v4.1-flash'])
})

test('a summary with no cost is nothing to show, never a $0', () => {
  const from = Date.parse('2026-10-15T00:00:00')
  // A router that does not price requests yet: buckets without the fields.
  const { costUsd: _c, unpricedRequests: _u, estimatedRequests: _e, ...plain } = bucket(1)
  assert.equal(costFromSummary({ total: plain, providers: {}, models: [] }, from), null)
  assert.equal(costFromSummary({}, from), null)
  assert.equal(costFromSummary(null, from), null)
  assert.equal(costFromSummary({ total: { costUsd: 'free' } }, from), null)
  assert.equal(costFromSummary({ total: { costUsd: -1 } }, from), null)
  // A real zero: priced, and nothing spent.
  assert.deepEqual(costFromSummary({ total: bucket(0), providers: {}, models: [] }, from)!.total, { costUsd: 0, unpricedRequests: 0, estimatedRequests: 0 })
  // A line without a cost is left out; the rest stands.
  assert.deepEqual(costFromSummary({ total: bucket(2), providers: { a: plain, b: bucket(2) }, models: [{ model: 'm', ...plain }, { provider: 'b' }] }, from)!.providers.map(p => p.name), ['b'])
  assert.deepEqual(costFromSummary({ total: bucket(2), providers: {}, models: [{ model: 'm', ...plain }, { provider: 'b' }] }, from)!.models, [])
})

test('an amount reads in dollars; a line nothing of which was priced says "—", an estimate says "≈"', () => {
  assert.equal(costText(15.678), '$15.68')
  assert.equal(costText(1234.5), '$1,234.50')
  assert.equal(costText(0.004), '<$0.01')
  assert.equal(costText(0.005), '$0.01')
  assert.equal(costText(0), '$0.00')
  assert.equal(costText(Number.NaN), '$0.00')
  assert.equal(costFigure(bucket(12.3)), '$12.30')
  assert.equal(costFigure(bucket(12.3, 0, 4)), '≈$12.30')
  // Priced in part: the amount stands, though some requests are not in it.
  assert.equal(costFigure(bucket(12.3, 2)), '$12.30')
  // Nothing priced: not free.
  assert.equal(costFigure(bucket(0, 5)), '—')
  assert.equal(costFigure(bucket(0)), '$0.00')
})

test('the cost is asked from the local midnight, and the week from the midnight six days before', () => {
  const now = new Date(2026, 9, 15, 13, 20, 5).getTime()
  assert.equal(localMidnight(now), new Date(2026, 9, 15).getTime())
  assert.equal(localMidnight(now, 6), new Date(2026, 9, 9).getTime())
  // Across a month's turn.
  assert.equal(localMidnight(new Date(2026, 10, 2, 8).getTime(), 6), new Date(2026, 9, 27).getTime())
  assert.equal(localMidnight(new Date(2026, 9, 15, 0, 0, 0).getTime()), new Date(2026, 9, 15).getTime())
})

test('the cost tile names a provider as the limits pane does, and keeps the id when no name is known', () => {
  const items = [
    { provider: 'anthropic', type: 'anthropic', title: 'Claude', account: 0, kind: 'five_hour' as const, label: '', percent: 1 },
    { provider: 'opencode-go', type: 'opencode-go', title: 'Go', account: 0, kind: 'five_hour' as const, label: '', percent: 1 },
    { provider: 'google-gemini', type: 'google', account: 0, kind: 'five_hour' as const, label: '', percent: 1 },
    { provider: 'minimax', type: 'minimax', title: 'MiniMax', account: 0, kind: 'five_hour' as const, label: '', percent: 1 },
  ]
  assert.deepEqual(['anthropic', 'chatgpt', 'opencode-go', 'google-gemini', 'minimax'].map(p => providerDisplayName(p, items)), ['Claude', 'GPT', 'Go', 'Gemini', 'MiniMax'])
  // No limits read yet: the ids that imply a name give it, any other stays.
  assert.deepEqual(['anthropic', 'chatgpt', 'claude', 'deepseek', 'opencode-go'].map(p => providerDisplayName(p, [])), ['Claude', 'GPT', 'Claude', 'deepseek', 'opencode-go'])
})

test('every language says the forecast and the cost, with the placeholders the code fills', () => {
  for (const lang of ['en', 'ko', 'zh', 'ja', 'es', 'pt'] as const) {
    assert.match(t(lang, 'limits.exhaust', { time: 'T' }), /T/, lang)
    assert.match(t(lang, 'limits.paceProjected', { percent: 'P' }), /P/, lang)
    for (const key of ['cost.title', 'cost.today', 'cost.week', 'cost.providers', 'cost.models', 'cost.note', 'cost.unavailable']) assert.notEqual(t(lang, key), key, lang + ' ' + key)
    assert.match(t(lang, 'cost.unpriced', { count: 7 }), /7/, lang)
    assert.match(t(lang, 'cost.estimated', { count: 7 }), /7/, lang)
    assert.ok(t(lang, 'cost.estimated', { count: 7 }).includes('≈'), lang)
  }
})
