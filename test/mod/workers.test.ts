import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { DEFAULTS } from '../../packages/mod/hooks/settings.ts'

// The engine resolves extensionless TS imports; mirror that only within this Node test process.
registerHooks({ resolve(specifier, context, next) {
  const source = context.parentURL?.includes('/packages/mod/hooks/')
  return next(source && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { WORKER_JUDGE_SYSTEM, workerJudgeInput, parseWorkerVerdict, readMarker, agentProvider,
  chatgptUsable, resolveTarget, spawnModel, takesOver } = await import('../../packages/mod/hooks/workers.ts')

// Shape sampled by GET /api/status on 2026-10-10; account identities deliberately omitted.
const liveShape = { chatgpt: { quota: { chatgpt: { rate_limits: { primary: { used_percent: 89 }, secondary: null } } },
  auth: { chatgpt: 'accounts=2 usable=1 mode=auto' }, signedIn: { chatgpt: true }, accounts: { chatgpt: [
    { id: 'ready-account', planType: 'prolite', state: 'ready', paused: false, needsReauth: false,
      quota: { type: 'codex.rate_limits', plan_type: 'prolite', rate_limits: {
        primary: { used_percent: 89, window_minutes: 10080, reset_after_seconds: 320918, reset_at: 1791948526 }, secondary: null },
      credits: { has_credits: false, unlimited: false, balance: '0' } } },
    { id: 'paused-account', planType: 'plus', state: 'paused', paused: true, needsReauth: false, quota: null },
  ] } } }
const status = (accounts: unknown[]) => ({ chatgpt: { accounts: { chatgpt: accounts } } })
const ready = { state: 'ready', paused: false, needsReauth: false }

test('worker judge describes stable work tiers and only reads 3000 prompt characters', () => {
  const text = workerJudgeInput({ description: 'Review', prompt: 'x'.repeat(3000) + 'discard' })
  assert.ok(text.includes('Review') && text.includes('x'.repeat(3000)) && !text.includes('discard'))
  for (const tier of ['light', 'standard', 'deep', 'design']) assert.ok(WORKER_JUDGE_SYSTEM.includes(tier))
})

test('worker verdict requires both valid fields and bounds confidence/reason', () => {
  assert.deepEqual(parseWorkerVerdict('```json\n{"tier":"deep","effort":"high","sure":0.9,"why":"security"}\n```'), { tier: 'deep', effort: 'high', sure: 0.9, why: 'security' })
  assert.deepEqual(parseWorkerVerdict('{"tier":"light","effort":"low","sure":2}'), { tier: 'light', effort: 'low', why: '' })
  assert.equal(parseWorkerVerdict(JSON.stringify({ tier: 'design', effort: 'max', why: 'x'.repeat(100) }))?.why.length, 60)
  for (const text of ['', '{}', '{"tier":"bad","effort":"high"}', '{"tier":"light","effort":"bad"}', '{"effort":"high"}']) assert.equal(parseWorkerVerdict(text), undefined)
})

test('marker regex matches ripple/gpt anywhere, preserves optional level and lowercases', () => {
  assert.deepEqual(readMarker('context\n[[ ripple : GPT-6.1-SOL @ HIGH ]]\nwork'), { name: 'gpt-6.1-sol', level: 'high' })
  assert.deepEqual(readMarker('[[gpt: astra]]'), { name: 'astra' })
  assert.deepEqual(readMarker('[[ripple: a@max]] [[ripple: b@low]]'), { name: 'a', level: 'max' })
  for (const text of ['', '[[Ripple: astra@high]]', '[[ripple: bad_name@high]]', '[[ripple: x@3]]']) assert.equal(readMarker(text), null)
})

test('provider is read only from a frontmatter description', () => {
  assert.equal(agentProvider('---\nname: sol\ndescription: Execute via chatgpt.\nmodel: gpt-6.1-sol\n---\n'), 'chatgpt')
  assert.equal(agentProvider('---\r\ndescription: "gpt-6.1-sol via CHATGPT."\r\n---\r\n'), 'chatgpt')
  assert.equal(agentProvider('---\ndescription: deepseek via deepseek.\n---\n'), 'deepseek')
  assert.equal(agentProvider('description: x via chatgpt.'), undefined)
  assert.equal(agentProvider('---\nname: x\n---\ndescription: via chatgpt.'), undefined)
})

test('realistic status uses account readiness and quota, not aggregate sign-in', () => {
  assert.equal(chatgptUsable(liveShape), true)
  assert.equal(chatgptUsable(status([])), false)
  assert.equal(chatgptUsable(status([{ ...ready, paused: true }])), false)
  assert.equal(chatgptUsable(status([{ ...ready, needsReauth: true }])), false)
  assert.equal(chatgptUsable(status([{ ...ready, state: 'expired' }])), false)
  assert.equal(chatgptUsable(status([{ ...ready, quota: { rate_limits: { primary: { used_percent: 100 }, secondary: null } } }])), false)
  assert.equal(chatgptUsable(status([{ ...ready, quota: { rate_limits: { primary: { used_percent: 0 }, secondary: { used_percent: 100 } } } }])), false)
  assert.equal(chatgptUsable(status([{ ...ready, quota: { rate_limits: { primary: { used_percent: 99.99 }, secondary: null } } }])), true)
  assert.equal(chatgptUsable(status([{ ...ready, paused: true }, ready])), true)
  for (const missing of [undefined, null, {}, { chatgpt: {} }, { chatgpt: { accounts: {} } }]) assert.equal(chatgptUsable(missing), true)
  assert.equal(chatgptUsable(status([{ ...ready, quota: null }])), true)
})

const provider = (agent: string) => agent.startsWith('gpt-') ? 'chatgpt' : undefined
const all = ['deepseek-v4-1-flash', 'gpt-6-1-sol', 'gpt-6-astra', 'general-purpose']

test('target prefers its tier, climbs available tiers, then uses configured fallback', () => {
  assert.deepEqual(resolveTarget('light', DEFAULTS, all, provider, { chatgpt: true }), { target: DEFAULTS.tiers.light })
  assert.deepEqual(resolveTarget('light', DEFAULTS, all.slice(1), provider, { chatgpt: true }), { target: DEFAULTS.tiers.standard, fallbackReason: 'deepseek-v4-1-flash is not installed' })
  assert.equal(resolveTarget('light', DEFAULTS, ['gpt-6-astra', 'general-purpose'], provider, { chatgpt: true }).target.agent, 'gpt-6-astra')
  const unavailable = resolveTarget('standard', DEFAULTS, all, provider, { chatgpt: false })
  assert.deepEqual(unavailable.target, DEFAULTS.fallback)
  assert.ok(unavailable.fallbackReason?.includes('ChatGPT'))
  const custom = { ...DEFAULTS, fallback: { agent: 'general-purpose', model: 'opus' } }
  assert.deepEqual(resolveTarget('deep', custom, ['general-purpose'], provider, { chatgpt: true }).target, custom.fallback)
  assert.deepEqual(resolveTarget('design', DEFAULTS, all, provider, { chatgpt: false }), { target: DEFAULTS.tiers.design })
  assert.equal(resolveTarget('design', DEFAULTS, [], provider, { chatgpt: true }).target.model, 'sonnet')
  assert.equal(resolveTarget('deep', DEFAULTS, [all[0]!], provider, { chatgpt: true }).target.agent, 'general-purpose')
})

test('quota exhaustion uses fallback even when a non-ChatGPT upper tier exists', () => {
  const custom = { ...DEFAULTS, tiers: { ...DEFAULTS.tiers, deep: { agent: 'deepseek-v4-1-flash' } } }
  const result = resolveTarget('standard', custom, all, provider, { chatgpt: false })
  assert.deepEqual(result.target, custom.fallback)
  assert.match(result.fallbackReason ?? '', /ChatGPT/)
})

test('spawn model uses generated file base and suffix, built-ins keep their explicit model', () => {
  assert.equal(spawnModel(DEFAULTS.tiers.standard, 'max', 'gpt-6.1-sol@medium'), 'gpt-6.1-sol@max')
  assert.equal(spawnModel(DEFAULTS.tiers.light, 'low', 'deepseek-v4.1-flash'), 'deepseek-v4.1-flash@low')
  assert.equal(spawnModel(DEFAULTS.tiers.design, 'high'), 'sonnet')
  assert.equal(spawnModel(DEFAULTS.tiers.design, 'high', 'sonnet'), 'sonnet')
  assert.equal(spawnModel({ agent: 'Explore' }, 'high'), undefined)
})

test('takeover honours auto modes and never forks or intercepts named/modelled built-ins', () => {
  const spawn = { subagentType: 'ripple:auto', fork: false }
  assert.equal(takesOver(spawn, DEFAULTS), true)
  assert.equal(takesOver({ ...spawn, subagentType: 'auto' }, DEFAULTS), true)
  assert.equal(takesOver({ ...spawn, fork: true }, DEFAULTS), false)
  assert.equal(takesOver(spawn, { ...DEFAULTS, agentAuto: 'off' }), false)
  const general = { subagentType: 'general-purpose', fork: false }
  assert.equal(takesOver(general, DEFAULTS), false)
  assert.equal(takesOver(general, { ...DEFAULTS, agentAuto: 'all' }), true)
  assert.equal(takesOver({ ...general, model: 'sonnet' }, { ...DEFAULTS, agentAuto: 'all' }), false)
  assert.equal(takesOver({ ...general, subagentType: 'gpt-6-astra' }, { ...DEFAULTS, agentAuto: 'all' }), false)
})
