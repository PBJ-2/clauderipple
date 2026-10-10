import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, normalizeSettings } from '../../packages/mod/hooks/settings.ts'

 test('defaults implement the ripple contract', () => {
  assert.equal(DEFAULTS.effortAuto, true)
  assert.equal(DEFAULTS.judge, 'haiku')
  assert.equal(DEFAULTS.judgeModel, 'deepseek-v4.1-flash')
  assert.deepEqual(DEFAULTS.tiers, {
    light: { agent: 'deepseek-v4-1-flash' }, standard: { agent: 'gpt-6-1-sol' },
    deep: { agent: 'gpt-6-astra' }, design: { agent: 'general-purpose', model: 'sonnet' },
  })
  assert.deepEqual(DEFAULTS.fallback, { agent: 'general-purpose', model: 'sonnet' })
  assert.deepEqual([DEFAULTS.keepWarm, DEFAULTS.keepWarmHours, DEFAULTS.keepWarmMinTokens, DEFAULTS.swampAt], [false, 2, 30000, 50])
  assert.deepEqual(DEFAULTS.hide, ['reason'])
})

test('missing or invalid settings become independent default values', () => {
  for (const value of [undefined, null, false, 'bad', 7, [], {}]) assert.deepEqual(normalizeSettings(value), DEFAULTS)
  const first = normalizeSettings(null)
  first.hide.push('timer')
  first.tiers.light.agent = 'changed'
  first.fallback.agent = 'changed'
  assert.deepEqual(normalizeSettings(null), DEFAULTS)
})

test('normalizeSettings validates fields independently without coercion', () => {
  const result = normalizeSettings({ effortAuto: false, judge: 'jev', judgeModel: ' custom ', bias: 2,
    floor: 'max', ceiling: 'low', agentAuto: 'all', keepWarm: true, keepWarmHours: 8,
    keepWarmMinTokens: 0, swampAt: 100, compactWith: 'session', handoffSkill: ' /handoff ',
    handoffAfter: 'copy', handoffButton: 'always', layout: 'minimal', appearance: 'light', setupDone: true,
    hide: ['route', 'bogus', 'timer', 'route', 4], tiers: { light: { agent: ' custom-worker ' } },
    fallback: { agent: 'custom', model: ' opus ' } })
  assert.deepEqual(result, { ...DEFAULTS, effortAuto: false, judge: 'jev', judgeModel: 'custom', bias: 2,
    floor: 'max', ceiling: 'low', agentAuto: 'all', keepWarm: true, keepWarmHours: 8,
    keepWarmMinTokens: 0, swampAt: 100, compactWith: 'session', handoffSkill: 'handoff',
    handoffAfter: 'copy', handoffButton: 'always', layout: 'minimal', appearance: 'light', setupDone: true,
    hide: ['route', 'timer'], tiers: { ...DEFAULTS.tiers, light: { agent: 'custom-worker' } },
    fallback: { agent: 'custom', model: 'opus' } })
})

test('invalid enum, numeric and nested fields fall back, empty hide stays empty', () => {
  const result = normalizeSettings({ effortAuto: 'false', judge: 'auto', judgeModel: '', bias: '2',
    floor: 'HIGH', ceiling: null, agentAuto: 'yes', keepWarm: 1, keepWarmHours: 3,
    keepWarmMinTokens: -1, swampAt: Infinity, compactWith: 'custom', handoffSkill: null,
    handoffAfter: 'clear', handoffButton: 'off', layout: 'default', appearance: 'purple', setupDone: 1,
    tiers: { light: null, standard: { agent: 42 }, design: { agent: '', model: false } }, fallback: [], hide: null })
  assert.deepEqual(result, DEFAULTS)
  assert.deepEqual(normalizeSettings({ hide: [] }).hide, [])
  for (const n of [-1, 101, NaN, Infinity]) assert.equal(normalizeSettings({ swampAt: n }).swampAt, 50)
  for (const n of [-1, NaN, Infinity]) assert.equal(normalizeSettings({ keepWarmMinTokens: n }).keepWarmMinTokens, 30000)
})
