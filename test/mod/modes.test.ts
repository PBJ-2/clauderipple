// Operating modes (docs/specs/2026-10-12-worker-tiers.md "Operating modes"): stored modes, the
// rungs a mode moves, when it ends by itself, and the eager note.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { DEFAULTS, applySettingsChanges, normalizeModes, normalizeSettings, settingsChanges } from '../../packages/mod/hooks/settings.ts'
import { claudeChoices } from '../../packages/mod/hooks/ladder.ts'
import type { LadderChoice } from '../../packages/mod/types/index.d.ts'
registerHooks({ resolve(specifier, context, next) {
  const source = context.parentURL?.includes('/packages/mod/hooks/')
  return next(source && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { activeModeOf, claudeWindow, eagerNote, modeKey, modeNote, modeOver, quotaWindows, resetProvider, routingSettings } = await import('../../packages/mod/hooks/modes.ts')
const { ladderPick } = await import('../../packages/mod/hooks/workers.ts')

const gpt = (agent: string, model: string, cost?: number): LadderChoice => ({ target: { agent }, model, provider: 'chatgpt', billing: 'subscription', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], ...(cost !== undefined ? { cost } : {}) })
const LIVE: LadderChoice[] = [
  { target: { agent: 'deepseek-flash' }, model: 'deepseek-flash', provider: 'deepseek', billing: 'payg', efforts: ['low', 'high', 'max'], cost: 0.3 },
  { target: { agent: 'glm-flash' }, model: 'glm-flash', provider: 'zai', billing: 'payg', efforts: [], cost: 0.9 },
  gpt('gpt-6-1-sol', 'gpt-6.1-sol'), gpt('gpt-6-astra', 'gpt-6-astra'), gpt('gpt-6-luna', 'gpt-6-luna'),
  ...claudeChoices(['low', 'medium', 'high', 'max']),
]
const USER = DEFAULTS.rules.general.rungs
const opus = { agent: 'general-purpose', model: 'opus' }, sonnet = { agent: 'general-purpose', model: 'sonnet' }, haiku = { agent: 'general-purpose', model: 'haiku' }

test('modes load validated: no mode is built in, bad entries are dropped, the active one must exist', () => {
  assert.deepEqual(DEFAULTS.modes, [])
  assert.equal(normalizeSettings({}).activeMode, undefined)
  // Settings from before modes load as they did, with no modes.
  const old = normalizeSettings({ allow: ['gpt-6-1-sol'], judge: 'jev' })
  assert.deepEqual([old.modes, old.allow, old.judge, Object.hasOwn(old, 'activeMode')], [[], ['gpt-6-1-sol'], 'jev', false])
  const modes = normalizeModes([
    { id: 'burn', name: '  Burn GPT  ', targets: ['chatgpt', 'chatgpt', ' ', 3], action: 'prefer', delegation: 'eager', until: 'reset' },
    { id: 'keep', name: 'Keep Claude', targets: ['anthropic'], action: 'avoid', delegation: 'loud', until: 1_800_000_000_000 },
    { id: 'burn', name: 'duplicate id' },
    { id: 'x', name: '' },
    { name: 'no id' },
    { id: 'odd', name: 'Odd', action: 'sideways', until: -5 },
    'not a mode',
  ])
  assert.deepEqual(modes, [
    { id: 'burn', name: 'Burn GPT', rungs: USER, delegation: 'eager', until: { reset: 'chatgpt' } },
    { id: 'keep', name: 'Keep Claude', rungs: USER, delegation: 'normal', until: 1_800_000_000_000 },
    { id: 'odd', name: 'Odd', rungs: USER, delegation: 'normal', until: 'none' },
  ])
  assert.equal(normalizeModes([{ id: 'long', name: 'x'.repeat(80) }])[0]!.name.length, 40)
  const on = normalizeSettings({ modes, activeMode: 'keep', activeSince: 1_700_000_000_000 })
  assert.deepEqual([on.activeMode, on.activeSince, activeModeOf(on)?.name], ['keep', 1_700_000_000_000, 'Keep Claude'])
  // An active mode that is gone is no active mode, and its start goes with it.
  const gone = normalizeSettings({ modes, activeMode: 'deleted', activeSince: 1_700_000_000_000 })
  assert.deepEqual([gone.activeMode, gone.activeSince, activeModeOf(gone)], [undefined, undefined, undefined])
  // Turning a mode off is a removal another surface's edit does not bring back.
  const off = applySettingsChanges(on, settingsChanges(on, normalizeSettings({ ...on, activeMode: undefined, activeSince: undefined })))
  assert.equal(Object.hasOwn(off, 'activeMode'), false)
  assert.equal(Object.hasOwn(off, 'activeSince'), false)
  assert.deepEqual(off.modes, modes)
})

test('a mode ends at one named provider\'s reset; the old any-provider reset names ChatGPT, then Claude', () => {
  const gptRung = { light: [{ target: { agent: 'gpt-6-luna' }, effort: 'low' }], plan: [{ target: opus, effort: 'high' }] }
  const claudeRung = { light: [{ target: sonnet, effort: 'high' }], plan: [{ target: opus, effort: 'high' }] }
  const modes = normalizeModes([
    { id: 'gpt', name: 'GPT', rungs: gptRung, until: 'reset' },
    { id: 'claude', name: 'Claude', rungs: claudeRung, until: 'reset' },
    { id: 'kept', name: 'Kept', rungs: gptRung, until: { reset: ' anthropic ' } },
    { id: 'blank', name: 'Blank', until: { reset: '  ' } },
    { id: 'odd', name: 'Odd', until: { reset: 3 } },
  ])
  assert.deepEqual(modes.map(m => m.until), [{ reset: 'chatgpt' }, { reset: 'anthropic' }, { reset: 'anthropic' }, 'none', 'none'])
  assert.deepEqual(modes.map(m => resetProvider(m)), ['chatgpt', 'anthropic', 'anthropic', undefined, undefined])
  assert.equal(resetProvider({ until: 1_800_000_000_000 }), undefined)
  // Migrated once: saving and loading again keeps the named provider.
  const s = normalizeSettings({ modes })
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(s))).modes, modes)
  // Another surface's provider change merges like any other edit.
  const next = normalizeSettings({ ...s, modes: s.modes.map(m => m.id === 'gpt' ? { ...m, until: { reset: 'anthropic' } } : m) })
  assert.deepEqual(applySettingsChanges(s, settingsChanges(s, next)).modes[0]!.until, { reset: 'anthropic' })
})

test('old modes copy the actual base ladder; single steps become independent ordered lists', () => {
  const base = { light: { target: haiku, effort: 'low' }, standard: [{ target: sonnet, effort: 'high' }, { target: opus, effort: 'max' }] }
  const s = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: base } }, modes: [{ id: 'old', name: 'Old', targets: ['chatgpt'], action: 'avoid' }] })
  assert.deepEqual(s.modes[0]!.rungs, s.rules.general.rungs)
  assert.equal(Object.hasOwn(s.modes[0]!, 'targets'), false)
  assert.equal(Object.hasOwn(s.modes[0]!, 'action'), false)
  s.rules.general.rungs.light![0]!.target.model = 'opus'
  assert.equal(s.modes[0]!.rungs.light![0]!.target.model, 'haiku')
  assert.deepEqual(normalizeSettings(s), s)
})

test('active modes route their own ordered rungs, then one rung up, then nothing; base stays unchanged', () => {
  const rungs = { light: [{ target: { agent: 'gpt-6-luna' }, effort: 'low' }, { target: sonnet, effort: 'high' }], standard: [{ target: opus, effort: 'max' }] }
  const s = normalizeSettings({ modes: [{ id: 'work', name: 'Work', rungs }], activeMode: 'work', activeSince: 5 })
  const routing = routingSettings(s)
  const verdict = { domain: 'general' as const, level: 'light' as const, effort: 'medium' as const, why: '' }
  const pick = (settings = routing, available = true) => ladderPick(verdict, settings.rules.general, settings, LIVE, available, 'en', settings.allow)
  assert.deepEqual([pick().target, pick().effort, pick().position], [{ agent: 'gpt-6-luna' }, 'low', 1])
  assert.deepEqual([pick(routing, false).target, pick(routing, false).position], [sonnet, 2])
  const unticked = { ...routing, allow: ['general-purpose:opus'] }
  assert.deepEqual([pick(unticked, false).target, pick(unticked, false).rung], [opus, 'standard'])
  assert.equal(pick({ ...routing, allow: ['missing'] }, false).target, undefined)
  assert.deepEqual(s.rules.general.rungs, USER)
  assert.equal(routingSettings({ ...s, activeMode: undefined }).rules.general, s.rules.general)
})

test('modes replace domain ladders as a whole and never inherit Base overrides', () => {
  const s = normalizeSettings({ domainRules: { ui: DEFAULTS.rules.general, backend: DEFAULTS.rules.general }, modes: [
    { id: 'old', name: 'Old' },
    { id: 'own', name: 'Own', domainRules: { backend: { mode: 'ladder', rungs: { light: { target: haiku, effort: 'low' } } }, review: { mode: 'ladder', rungs: { light: { target: sonnet, effort: 'high' } } }, ui: { mode: 'auto' } } },
  ], activeMode: 'old' })
  assert.equal(Object.hasOwn(s.modes[0]!, 'domainRules'), false)
  assert.equal(routingSettings(s).domainRules, undefined)
  const own = routingSettings({ ...s, activeMode: 'own' })
  // The mode's own domain ladder is folded like Base's: its one filled row runs every rung.
  const h = [{ target: haiku, effort: 'low' }]
  const r = [{ target: sonnet, effort: 'high' }]
  assert.deepEqual(own.domainRules, {
    backend: { mode: 'ladder', rungs: { light: h, standard: h, hard: h, plan: h } },
    review: { mode: 'ladder', rungs: { light: r, standard: r, hard: r, plan: r } },
  })
  assert.equal(own.domainRules?.ui, undefined)
  assert.equal(routingSettings({ ...s, activeMode: undefined }).domainRules, s.domainRules)
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(s))), s)
  assert.notEqual(s.domainRules!.ui!.rungs, s.domainRules!.backend!.rungs)
})

test('a mode\'s domain ladders fold into two levels, the general ladder of the mode does not', () => {
  const s = normalizeSettings({ modes: [{
    id: 'own', name: 'Own',
    rungs: {
      light: [{ target: { agent: 'l' }, effort: 'low' }], standard: [{ target: { agent: 's' }, effort: 'medium' }],
      hard: [{ target: { agent: 'h' }, effort: 'high' }], plan: [{ target: { agent: 'p' }, effort: 'high' }],
    },
    domainRules: { ui: { mode: 'ladder', rungs: { standard: { target: { agent: 'u' }, effort: 'low' }, hard: { target: { agent: 'uh' }, effort: 'high' } } } },
  }] })
  const mode = s.modes[0]!
  assert.deepEqual(mode.rungs, {
    light: [{ target: { agent: 'l' }, effort: 'low' }], standard: [{ target: { agent: 's' }, effort: 'medium' }],
    hard: [{ target: { agent: 'h' }, effort: 'high' }], plan: [{ target: { agent: 'p' }, effort: 'high' }],
  })
  assert.deepEqual(mode.domainRules!.ui!.rungs, {
    light: [{ target: { agent: 'u' }, effort: 'low' }], standard: [{ target: { agent: 'u' }, effort: 'low' }],
    hard: [{ target: { agent: 'uh' }, effort: 'high' }], plan: [{ target: { agent: 'uh' }, effort: 'high' }],
  })
})

test('a mode ends at its time, or the first known quota reset after activation', () => {
  const since = Date.parse('2026-10-12T10:00:00Z')
  assert.equal(modeOver({ until: since + 3_600_000 }, since, since + 3_599_999), false)
  assert.equal(modeOver({ until: since + 3_600_000 }, since, since + 3_600_000), true)
  assert.equal(modeOver({ until: 'none' }, since, since + 1e12), false)
  // Reset: unknown windows, or no start, never end it.
  const chatgpt = { until: { reset: 'chatgpt' } }, claude = { until: { reset: 'anthropic' } }
  assert.equal(modeOver(chatgpt, since, since + 1e12, []), false)
  assert.equal(modeOver(chatgpt, undefined, since + 1e12, [{ at: since + 1 }]), false)
  const week = 7 * 86_400_000
  const pending = [{ at: since + 86_400_000, windowMs: week }]
  assert.equal(modeOver(chatgpt, since, since + 3_600_000, pending), false)
  assert.equal(modeOver(chatgpt, since, since + 86_400_000, pending), true)
  // A fresh snapshot after the reset shows the next one; the window it started began after `since`.
  assert.equal(modeOver(chatgpt, since, since + 2 * 86_400_000, [{ at: since + 86_400_000 + week, windowMs: week }]), true)
  // The first known account reset ends it, not the last.
  assert.equal(modeOver(chatgpt, since, since + 86_400_000, [...pending, { at: since + 3 * 86_400_000, windowMs: week }]), true)
  for (const kind of ['five_hour', 'seven_day']) {
    const windows = claudeWindow({ kind, percent: 90, resetsAt: new Date(since + 600_000).toISOString() })
    assert.equal(modeOver(claude, since, since + 599_999, windows), false)
    assert.equal(modeOver(claude, since, since + 600_000, windows), true)
    assert.equal(modeOver(claude, since + 600_000, since + 700_000, windows), false)
  }
  assert.deepEqual(claudeWindow(null), [])
  assert.deepEqual(claudeWindow({ kind: 'five_hour', percent: 80, resetsAt: 'invalid' }), [])
  // The router's account list: the weekly window where there is one, reset_at in seconds or a countdown; paused accounts left out.
  const body = { provider: 'chatgpt', accounts: [
    { state: 'ready', quota: { at: since, rate_limits: { primary: { used_percent: 40, window_minutes: 300, reset_at: (since + 3_600_000) / 1000 }, secondary: { used_percent: 70, window_minutes: 10080, reset_at: (since + 86_400_000) / 1000 } } } },
    { state: 'cooling', quota: { at: since, rate_limits: { primary: { used_percent: 100, window_minutes: 300, reset_after_seconds: 600 }, secondary: null } } },
    { state: 'paused', quota: { at: since, rate_limits: { primary: { used_percent: 1, reset_at: 1 } } } },
    { state: 'ready', quota: null },
  ] }
  assert.deepEqual(quotaWindows(body), [{ at: since + 3_600_000, windowMs: 300 * 60_000 }, { at: since + 86_400_000, windowMs: week }, { at: since + 600_000, windowMs: 300 * 60_000 }])
  assert.deepEqual(quotaWindows({}), [])
})

test('the eager note goes with every prompt while eager, not once per activation or compaction', () => {
  const modes = normalizeModes([{ id: 'burn', name: 'Burn GPT', targets: ['chatgpt'], delegation: 'eager' }, { id: 'calm', name: 'Calm', targets: ['chatgpt'] }])
  const on = { modes, activeMode: 'burn', activeSince: 5 }
  const first = eagerNote(on, null)
  assert.equal(first.note, modeNote('Burn GPT'))
  assert.equal(first.note, 'ClaudeRipple mode Burn GPT: delegate everything except judgment and final review to ripple:auto.')
  assert.equal(first.noted, modeKey(on))
  // The next turn carries it too: one sent only once is buried in a long context.
  assert.equal(eagerNote(on, first.noted).note, first.note)
  assert.equal(eagerNote(on, null).note, first.note)
  // Turned off and on again, still every prompt.
  assert.equal(eagerNote({ ...on, activeSince: 9 }, first.noted).note, first.note)
  // A normal mode, or none, adds nothing and clears what was noted (Base's delegation is normal).
  assert.deepEqual(eagerNote({ modes, activeMode: 'calm', activeSince: 5 }, null), { noted: null })
  assert.deepEqual(eagerNote({ modes, delegation: 'normal' }, 'burn@5'), { noted: null })
})
