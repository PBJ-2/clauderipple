import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { DEFAULTS, normalizeSettings } from '../../packages/mod/hooks/settings.ts'
import { billingOf, cheapest, claudeChoices, fillLadder, ladderNeedsFill, nearestEffort, preset, rungOf, tickedChoices } from '../../packages/mod/hooks/ladder.ts'
import type { LadderChoice, WorkerCandidate, WorkerVerdict } from '../../packages/mod/types/index.d.ts'
registerHooks({ resolve(specifier, context, next) {
  const source = context.parentURL?.includes('/packages/mod/hooks/')
  return next(source && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { ladderPick, ladderOptionsFrom, candidateUsable } = await import('../../packages/mod/hooks/workers.ts')

const v = (level: WorkerVerdict['level'], more: Partial<WorkerVerdict> = {}): WorkerVerdict => ({ domain: 'general', level, effort: 'medium', why: '', ...more })

test('levels land on light, standard and hard; planning from standard up lands on plan', () => {
  assert.equal(rungOf(v('light')), 'light')
  assert.equal(rungOf(v('standard')), 'standard')
  assert.equal(rungOf(v('deep')), 'hard')
  // A business strategy judged "standard plan" went to the Medium worker (pick log, 2026-10-12).
  assert.equal(rungOf(v('standard', { kind: 'plan' })), 'plan')
  assert.equal(rungOf(v('deep', { kind: 'plan' })), 'plan')
  // A light plan (rename a section of the spec) is still light work.
  assert.equal(rungOf(v('light', { kind: 'plan' })), 'light')
  assert.equal(rungOf(v('deep', { kind: 'do' })), 'hard')
})

test('an unsure verdict takes the next rung up, never into plan; plan stays plan', () => {
  assert.equal(rungOf(v('light', { sure: 0.49 })), 'standard')
  assert.equal(rungOf(v('standard', { sure: 0.3 })), 'hard')
  assert.equal(rungOf(v('standard', { kind: 'plan', sure: 0.3 })), 'plan')
  assert.equal(rungOf(v('deep', { sure: 0.1 })), 'hard')
  assert.equal(rungOf(v('deep', { kind: 'plan', sure: 0.1 })), 'plan')
  assert.equal(rungOf(v('light', { sure: 0.5 })), 'light')
  assert.equal(rungOf(v('light')), 'light')
})

// The router's workers on 2026-10-11 and Claude's own models.
const candidates: WorkerCandidate[] = [
  { target: { agent: 'deepseek-v4-1-flash' }, model: 'deepseek-v4.1-flash', provider: 'opencode-go' },
  { target: { agent: 'gpt-6-1-sol' }, model: 'gpt-6.1-sol', provider: 'chatgpt' },
  { target: { agent: 'gpt-6-astra' }, model: 'gpt-6-astra', provider: 'chatgpt' },
  { target: { agent: 'general-purpose', model: 'opus' }, model: 'claude-opus-5-5', provider: 'anthropic' },
  { target: { agent: 'general-purpose', model: 'sonnet' }, model: 'claude-sonnet-5-5', provider: 'anthropic' },
]
const pick = (s: typeof DEFAULTS, verdict: WorkerVerdict, chatgpt = true, workers = candidates) => ladderPick(verdict, s.rules.general, s, workers, chatgpt, 'en', s.allow)

test('the default ladder runs each rung at its own effort, whatever effort the judge said', () => {
  assert.deepEqual(pick(DEFAULTS, v('light', { effort: 'low' })), { target: { agent: 'deepseek-v4-1-flash' }, effort: 'max', rung: 'light', position: 1, skipped: [] })
  assert.deepEqual(pick(DEFAULTS, v('standard', { effort: 'high' })), { target: { agent: 'gpt-6-1-sol' }, effort: 'medium', rung: 'standard', position: 1, skipped: [] })
  assert.deepEqual(pick(DEFAULTS, v('deep')), { target: { agent: 'gpt-6-astra' }, effort: 'high', rung: 'hard', position: 1, skipped: [] })
  assert.deepEqual(pick(DEFAULTS, v('deep', { kind: 'do' })), { target: { agent: 'gpt-6-astra' }, effort: 'high', rung: 'hard', position: 1, skipped: [] })
  assert.deepEqual(pick(DEFAULTS, v('deep', { kind: 'plan' })), { target: { agent: 'general-purpose', model: 'opus' }, effort: 'high', rung: 'plan', position: 1, skipped: [] })
  // Every field follows the one ladder: there are no field rules left.
  assert.deepEqual(pick(DEFAULTS, v('standard', { domain: 'design' })).target, { agent: 'gpt-6-1-sol' })
})

test('unavailable: one rung up, else nothing (never the session model); never down', () => {
  const ladder = (rungs: unknown) => normalizeSettings({ ...DEFAULTS, rules: { general: { mode: 'ladder', rungs } } })
  const sol = { agent: 'gpt-6-1-sol' }, astra = { agent: 'gpt-6-astra' }, opus = { agent: 'general-purpose', model: 'opus' }, sonnet = { agent: 'general-purpose', model: 'sonnet' }
  // ChatGPT out of quota: one rung up, at that rung's effort.
  const up = pick(ladder({ standard: { target: sol, effort: 'medium' }, hard: { target: opus, effort: 'high' } }), v('standard'), false)
  assert.deepEqual([up.target, up.effort, up.rung], [opus, 'high', 'hard'])
  assert.match(up.fallbackReason ?? '', /ChatGPT/)
  // Nothing up there either: no target, the reasons kept for the refusal.
  const none = pick(ladder({ standard: { target: sol, effort: 'low' }, hard: { target: astra, effort: 'high' }, plan: { target: opus, effort: 'high' } }), v('standard'), false)
  assert.deepEqual([none.target, none.effort], [undefined, 'low'])
  assert.match(none.fallbackReason ?? '', /ChatGPT/)
  // Only one rung up: Light's trouble never reaches Plan's Opus.
  const one = pick(ladder({ light: { target: { agent: 'gone' }, effort: 'low' }, standard: { target: sol, effort: 'medium' }, plan: { target: opus, effort: 'high' } }), v('light'), false)
  assert.equal(one.target, undefined)
  assert.match(one.fallbackReason ?? '', /gone is not installed/)
  // Never down: Hard out, Light free, still nothing.
  const down = pick(ladder({ light: { target: sonnet, effort: 'low' }, hard: { target: astra, effort: 'high' } }), v('deep'), false)
  assert.equal(down.target, undefined)
  // An empty rung says so and moves up.
  const empty = pick(ladder({ standard: { target: sol, effort: 'medium' } }), v('light'))
  assert.deepEqual([empty.target, empty.rung], [sol, 'standard'])
  assert.match(empty.fallbackReason ?? '', /Low worker has no model set/)
})

test('a runtime-exhausted rung climbs once and retains its provider and reason', () => {
  const options = ladderOptionsFrom({ providers: [
    { name: 'opencode-go', usable: false, reason: 'insufficient_balance', exhaustedUntil: 1_800_000 },
    { name: 'chatgpt', usable: true },
  ] }, 600_000)
  const result = ladderPick(v('light'), DEFAULTS.rules.general, DEFAULTS, candidates, true, 'ko', [], options.providers)
  assert.deepEqual([result.target, result.effort, result.rung, result.position], [{ agent: 'gpt-6-1-sol' }, 'medium', 'standard', 1])
  assert.match(result.fallbackReason!, /deepseek-v4.1-flash: opencode-go: 잔액 부족/)
  assert.deepEqual(result.skipped, [{ rung: 'light', position: 1, model: 'deepseek-v4.1-flash', reason: 'opencode-go: 잔액 부족' }])
  assert.equal(candidateUsable(candidates[0]!, DEFAULTS, true, options.providers), false)
  // The router's account-aware availability wins over the old status helper's single-window view.
  assert.equal(candidateUsable(candidates[1]!, DEFAULTS, false, options.providers), true)
  const recovered = ladderOptionsFrom({ providers: [{ name: 'opencode-go', usable: true }] }, 600_000)
  assert.equal(ladderPick(v('light'), DEFAULTS.rules.general, DEFAULTS, candidates, true, 'ko', [], recovered.providers).rung, 'light')
})

test('worker fallback metadata snapshots only the remaining allowed entries of the selected tier (#89)', async () => {
  const { ladderFallbackModels } = await import('../../packages/mod/hooks/workers.ts')
  const { workerLadderLine, readWorkerLadder } = await import('../../packages/mod/hooks/ladder.ts')
  const s = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    standard: [
      { target: candidates[0]!.target, effort: 'low' },
      { target: { agent: 'missing' }, effort: 'high' },
      { target: candidates[1]!.target, effort: 'medium' },
      { target: candidates[2]!.target, effort: 'high' },
    ], hard: [{ target: opus, effort: 'max' }],
  } } }, allow: ['deepseek-v4-1-flash', 'gpt-6-astra'], allowKnown: ['gpt-6-1-sol'] })
  const fallbacks = ladderFallbackModels(s.rules.general, { rung: 'standard', position: 1, effort: 'low' }, candidates, s)
  assert.deepEqual(fallbacks, ['gpt-6-astra@high'], 'no earlier, missing, unticked or higher-tier entry')
  const route = { pick: 'pick-1', model: 'opencode-go:deepseek-v4.1-flash@low', fallbacks }
  const line = workerLadderLine(route)
  assert.deepEqual(readWorkerLadder(line + '\nTask'), route)
  assert.equal(readWorkerLadder('Quoted later\n' + line), undefined)
  assert.equal(readWorkerLadder('<!-- clauderipple-ladder %broken -->'), undefined)
  assert.deepEqual(ladderFallbackModels(s.rules.general, { rung: 'standard', position: 4, effort: 'high' }, candidates, s), [])
  assert.deepEqual(ladderFallbackModels(s.rules.general, { rung: 'standard', position: 1, effort: 'low' }, candidates, { ...s, providers: { chatgpt: false } }), [])
})

test('a retired model stays skipped without a timer and keeps sibling models usable (#94)', async () => {
  const { liveProviders } = await import('../../packages/mod/hooks/workers.ts')
  const providers = { 'opencode-go': { usable: true, models: { 'deepseek-v4.1-flash': { reason: 'model_deprecated' } } } }
  const later = liveProviders(providers, Number.MAX_SAFE_INTEGER)
  const result = ladderPick(v('light'), DEFAULTS.rules.general, DEFAULTS, candidates, true, 'en', [], later)
  assert.equal(result.target?.agent, 'gpt-6-1-sol')
  assert.deepEqual(result.skipped, [{ rung: 'light', position: 1, model: 'deepseek-v4.1-flash', reason: 'opencode-go: model_deprecated' }])
  assert.equal(candidateUsable({ ...candidates[0]!, model: 'another-model' }, DEFAULTS, true, later), true)
})

test('pins become ladders with Plan one effort above Hard; Auto becomes a ladder to fill and field rules are dropped', () => {
  // The owner's stored settings of 2026-10-11 (revision 24).
  const stored = { rules: {
    general: { mode: 'auto', allow: ['chatgpt', 'anthropic', 'deepseek'] },
    design: { mode: 'pin', targets: { light: { agent: 'general-purpose', model: 'sonnet' }, standard: { agent: 'general-purpose', model: 'sonnet' }, deep: { agent: 'general-purpose', model: 'opus' } } },
    frontend: { mode: 'auto', allow: ['anthropic'] }, backend: { mode: 'inherit' },
  }, agentAuto: 'all', autoFloors: { light: 20, standard: 45, deep: 50 } }
  const s = normalizeSettings(stored)
  assert.deepEqual(s.rules, { general: { mode: 'ladder', rungs: {} } })
  assert.deepEqual(s.allow, ['chatgpt', 'anthropic', 'deepseek'])
  // Auto's own fields still load, and are dropped.
  assert.equal(Object.hasOwn(s, 'autoFloors'), false)
  assert.deepEqual(normalizeSettings(s), s)
  // The old default general pin: its models keep the default ladder's efforts.
  const old = normalizeSettings({ rules: { general: { mode: 'pin', targets: { light: { agent: 'deepseek-v4-1-flash' }, standard: { agent: 'gpt-6-1-sol' }, deep: { agent: 'gpt-6-astra' } } } } }).rules.general
  assert.deepEqual(old, { mode: 'ladder', rungs: {
    light: [{ target: { agent: 'deepseek-v4-1-flash' }, effort: 'max' }], standard: [{ target: { agent: 'gpt-6-1-sol' }, effort: 'medium' }],
    hard: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }], plan: [{ target: { agent: 'gpt-6-astra' }, effort: 'xhigh' }],
  } })
  // A pin's calibration moves each rung's effort as it moved the judge's; the ceiling holds Hard, Plan still goes one up.
  const tuned = normalizeSettings({ rules: { general: { mode: 'pin', targets: { light: { agent: 'a' }, deep: { agent: 'b' } }, effortOffset: 1, ceiling: 'high' } } }).rules.general
  assert.deepEqual(tuned, { mode: 'ladder', rungs: { light: [{ target: { agent: 'a' }, effort: 'medium' }], standard: [{ target: { agent: 'b' }, effort: 'high' }], hard: [{ target: { agent: 'b' }, effort: 'high' }], plan: [{ target: { agent: 'b' }, effort: 'xhigh' }] } })
  // A pin with no target at all is the default ladder.
  assert.deepEqual(normalizeSettings({ rules: { general: { mode: 'pin', targets: {} } } }).rules.general, DEFAULTS.rules.general)
})

test('ladder rungs validate: a bad effort is the rung default, a rung without a target is dropped, backups are dropped', () => {
  const s = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    light: { target: { agent: ' w ' }, effort: 'ultra', backup: { agent: 'general-purpose', model: 'haiku' } },
    standard: { target: { agent: 2 }, effort: 'high' }, hard: { target: { agent: 'h' }, effort: 'xhigh', backup: { agent: '' } }, extra: { target: { agent: 'x' } },
  } } } }).rules.general
  assert.deepEqual(s, { mode: 'ladder', rungs: { light: [{ target: { agent: 'w' }, effort: 'low' }], hard: [{ target: { agent: 'h' }, effort: 'xhigh' }] } })
})

test('efforts move to the nearest the model takes, ties up, as the router clamps them', () => {
  assert.equal(nearestEffort('medium', ['low', 'high', 'max']), 'high')
  assert.equal(nearestEffort('xhigh', ['low', 'medium', 'high', 'max']), 'max')
  assert.equal(nearestEffort('max', ['low', 'medium', 'high']), 'high')
  assert.equal(nearestEffort('low', ['none', 'minimal', 'low']), 'low')
  assert.equal(nearestEffort('high', []), 'high')
})

test('billing comes from the provider: subscriptions, pay-per-token APIs and free local or :free models', () => {
  assert.equal(billingOf({ type: 'chatgpt' }), 'subscription')
  assert.equal(billingOf({ type: 'anthropic', auth: 'claude-code' }), 'subscription')
  assert.equal(billingOf({ type: 'anthropic', auth: 'api-key' }), 'payg')
  assert.equal(billingOf({ type: 'google', auth: 'antigravity' }), 'subscription')
  assert.equal(billingOf({ type: 'openai-compatible', preset: 'opencode-go' }), 'subscription')
  assert.equal(billingOf({ type: 'anthropic-compatible', preset: 'deepseek' }), 'payg')
  assert.equal(billingOf({ type: 'openai-compatible', preset: 'ollama' }), 'free')
  assert.equal(billingOf({ type: 'openai-compatible', url: 'http://127.0.0.1:1234/v1' }), 'free')
  assert.equal(billingOf({ type: 'anthropic-compatible', preset: 'openrouter' }, 'qwen/qwen3-coder:free'), 'free')
})

const anthropicLadder = ['low', 'medium', 'high', 'max']
const gpt = (agent: string, model: string): LadderChoice => ({ target: { agent }, model, provider: 'chatgpt', billing: 'subscription', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
const LIVE: LadderChoice[] = [
  { target: { agent: 'deepseek-flash' }, model: 'deepseek-flash', provider: 'deepseek', billing: 'payg', efforts: ['low', 'high', 'max'], cost: 0.3 },
  { target: { agent: 'deepseek-v4-1-flash' }, model: 'deepseek-v4.1-flash', provider: 'opencode-go', billing: 'subscription', efforts: ['low', 'high', 'max'], cost: 0.27 },
  gpt('gpt-6-1-sol', 'gpt-6.1-sol'), gpt('gpt-6-astra', 'gpt-6-astra'), gpt('gpt-6-luna', 'gpt-6-luna'), gpt('gpt-6-sol', 'gpt-6-sol'),
  ...claudeChoices(anthropicLadder),
]
const sonnet = { agent: 'general-purpose', model: 'sonnet' }, opus = { agent: 'general-purpose', model: 'opus' }, haiku = { agent: 'general-purpose', model: 'haiku' }

test('the preset rules fill the four rungs from what is connected, as the spec lists them', () => {
  const all = Object.fromEntries((['claude', 'claudeGpt', 'gpt', 'cheap'] as const).map(id => [id, preset(id, LIVE)])) as Record<'claude' | 'claudeGpt' | 'gpt' | 'cheap', ReturnType<typeof preset>>
  assert.deepEqual(all.claude, { rungs: { light: { target: haiku, effort: 'low' }, standard: { target: sonnet, effort: 'medium' }, hard: { target: opus, effort: 'high' }, plan: { target: opus, effort: 'high' } }, substituted: [] })
  // The cheapest pay-per-token model at max (DeepSeek's ladder has max), the newest Sol, Astra, Opus.
  assert.deepEqual(all.claudeGpt, { rungs: { light: { target: { agent: 'deepseek-flash' }, effort: 'max' }, standard: { target: { agent: 'gpt-6-1-sol' }, effort: 'medium' }, hard: { target: { agent: 'gpt-6-astra' }, effort: 'high' }, plan: { target: opus, effort: 'high' } }, substituted: [] })
  assert.deepEqual(all.gpt, { rungs: { light: { target: { agent: 'gpt-6-luna' }, effort: 'low' }, standard: { target: { agent: 'gpt-6-1-sol' }, effort: 'medium' }, hard: { target: { agent: 'gpt-6-astra' }, effort: 'high' }, plan: { target: { agent: 'gpt-6-astra' }, effort: 'xhigh' } }, substituted: [] })
  assert.deepEqual(all.cheap.rungs.light, { target: { agent: 'deepseek-flash' }, effort: 'high' })
  assert.deepEqual(all.cheap.rungs.hard, { target: { agent: 'deepseek-flash' }, effort: 'max' })
  assert.deepEqual(all.cheap.rungs.plan, { target: sonnet, effort: 'high' })
})

test('a preset model that is not connected leaves the rung on its nearest choice, marked', () => {
  const claudeOnly = claudeChoices(anthropicLadder)
  const p = preset('claudeGpt', claudeOnly)
  assert.deepEqual(p.rungs.light, { target: haiku, effort: 'low' })
  assert.deepEqual(p.rungs.standard, { target: sonnet, effort: 'medium' })
  assert.deepEqual(p.rungs.hard, { target: opus, effort: 'high' })
  assert.deepEqual(p.substituted, ['light', 'standard', 'hard'])
  // GPT-first without ChatGPT: Plan's Astra at xhigh becomes Opus at high.
  assert.deepEqual(preset('gpt', claudeOnly).rungs.plan, { target: opus, effort: 'high' })
  // No pay-per-token model: Claude + GPT's light is Luna at low.
  const noPayg = LIVE.filter(c => c.billing !== 'payg')
  assert.deepEqual(preset('claudeGpt', noPayg).rungs.light, { target: { agent: 'gpt-6-luna' }, effort: 'low' })
  assert.deepEqual(preset('claudeGpt', noPayg).substituted, ['light'])
  // Free beats any measured cost; unmeasured pay-per-token models come last.
  const free: LadderChoice = { target: { agent: 'qwen-free' }, model: 'qwen3-coder:free', provider: 'openrouter', billing: 'free', efforts: [] }
  const unmeasured: LadderChoice = { target: { agent: 'mystery' }, model: 'mystery', provider: 'x', billing: 'payg', efforts: [] }
  assert.equal(cheapest([unmeasured, ...LIVE, free])?.target.agent, 'qwen-free')
  assert.equal(cheapest([unmeasured, ...LIVE])?.target.agent, 'deepseek-flash')
})

test('spawn titles name the model that runs, replacing a guessed prefix', async () => {
  const { spawnTitle, titleName } = await import('../../packages/mod/hooks/workers.ts')
  const models = [{ value: 'gpt-6.1-sol', label: 'gpt-6.1-sol · chatgpt', provider: 'chatgpt', name: 'GPT-6.1 Sol' }]
  assert.equal(titleName('gpt-6.1-sol@medium', models), 'Sol')
  assert.equal(titleName('gpt-6-astra@high'), 'Astra')
  assert.equal(titleName('claude-opus-5-5'), 'Opus5.5')
  assert.equal(titleName('opus'), 'Opus')
  assert.equal(titleName('claude-mythos-5-1'), 'Mythos5.1')
  assert.equal(titleName('deepseek-v4.1-flash@max'), 'deepseek-v4.1-flash')
  assert.equal(titleName('deepseek-ai/deepseek-v4.1-flash-1017@high'), 'deepseek-v4.1-flash-1017')
  assert.equal(spawnTitle('Opus5.5·high · Fix routing', 'gpt-6.1-sol@medium', 'medium', models), 'Sol·medium · Fix routing')
  assert.equal(spawnTitle('Fix routing', 'claude-opus-5-5', undefined), 'Opus5.5 · Fix routing')
  // A pinned worker names its model after the pin and its account by the dashboard's name, never the id.
  const { bareTitle, pinnedAccountName } = await import('../../packages/mod/hooks/workers.ts')
  assert.equal(titleName('anthropic#f952fac6:claude-haiku-5-5@high'), 'Haiku5.5')
  const file = '---\nname: claude-haiku-5-5-f952fac6\ndescription: claude-haiku-5-5 via anthropic. Runs on mambo20211 (account f952fac6). Set effort.\nmodel: anthropic#f952fac6:claude-haiku-5-5@high\n---\nBody'
  assert.equal(pinnedAccountName('anthropic#f952fac6:claude-haiku-5-5@high', [file]), 'mambo20211')
  assert.equal(pinnedAccountName('anthropic#deadbeef:claude-haiku-5-5', [file]), undefined)
  assert.equal(pinnedAccountName('claude-haiku-5-5', [file]), undefined)
  const pinnedTitle = spawnTitle('Fix routing', 'anthropic#f952fac6:claude-haiku-5-5@high', 'high', [], 'mambo20211')
  assert.equal(pinnedTitle, 'Haiku5.5·mambo20211·high · Fix routing')
  assert.equal(bareTitle(pinnedTitle), 'Fix routing', 'the next spawn replaces it, not stacks')
  assert.equal(bareTitle('Haiku5.5·Work-account · Fix routing'), 'Fix routing')
  assert.equal(spawnTitle('Fix routing', 'anthropic#f952fac6:claude-haiku-5-5', undefined, [], 'Work account'), 'Haiku5.5·Work-account · Fix routing')
  // An account name's middle dot is closed up too, Korean kept, so a retitle replaces rather than stacks.
  const dotted = spawnTitle('Review parser', 'anthropic#f952fac6:claude-opus-5-5', 'high', [], '업무·개인')
  assert.equal(dotted, 'Opus5.5·업무-개인·high · Review parser')
  assert.equal(spawnTitle(dotted, 'anthropic#f952fac6:claude-opus-5-5', 'high', [], '업무·개인'), dotted)
  // Titles with an account and no effort strip; a parent's own heading is never taken for a prefix.
  assert.equal(bareTitle('Opus5.5·Work-account · Review parser'), 'Review parser')
  assert.equal(bareTitle('Sol·Work-account·high · Review parser'), 'Review parser')
  assert.equal(bareTitle('UI·UX · Review navigation'), 'UI·UX · Review navigation')
  assert.equal(bareTitle('iOS·Android · Fix notifications'), 'iOS·Android · Fix notifications')
  assert.equal(spawnTitle('iOS·Android · Fix notifications', 'claude-opus-5-5', undefined), 'Opus5.5 · iOS·Android · Fix notifications')
})

test('fill gives empty lists one ticked model, preserving existing ordered lists even when unticked', () => {
  const sol = { target: { agent: 'gpt-6-1-sol' }, effort: 'low' as const }
  const lists = (choices: readonly LadderChoice[]) => Object.fromEntries(Object.entries(preset('claudeGpt', choices).rungs).map(([rung, step]) => [rung, [step]]))
  const none = fillLadder({}, [], LIVE)
  assert.deepEqual(none.rungs, lists(LIVE))
  assert.deepEqual(none.filled, ['light', 'standard', 'hard', 'plan'])
  const kept = fillLadder({ standard: [sol] }, [], LIVE)
  assert.deepEqual(kept.rungs.standard, [sol])
  assert.deepEqual(kept.filled, ['light', 'hard', 'plan'])
  const claudeOnly = ['general-purpose:haiku', 'general-purpose:sonnet', 'general-purpose:opus']
  assert.deepEqual(fillLadder({}, claudeOnly, LIVE).rungs, lists(tickedChoices(claudeChoices(anthropicLadder), claudeOnly)))
  const unticked = fillLadder({ light: [sol], hard: [{ target: { agent: 'general-purpose' }, effort: 'high' }] }, claudeOnly, LIVE)
  assert.deepEqual(unticked.rungs.light, [sol])
  assert.deepEqual(unticked.filled, ['standard', 'plan'])
  assert.deepEqual(fillLadder({}, ['not-a-worker'], LIVE).rungs.light, [{ target: { agent: 'general-purpose' }, effort: 'max' }])
  assert.equal(ladderNeedsFill(DEFAULTS.rules.general.rungs), false)
  assert.equal(ladderNeedsFill({ light: [] }), true)
  assert.equal(ladderNeedsFill(DEFAULTS.rules.general.rungs, ['gpt-6-1-sol']), false)
})

test('ordered lists skip missing, disabled, unticked and exhausted entries before moving up', () => {
  const s = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    light: [
      { target: { agent: 'missing' }, effort: 'low' },
      { target: { agent: 'deepseek-v4-1-flash' }, effort: 'max' },
      { target: { agent: 'gpt-6-1-sol' }, effort: 'medium' },
      { target: sonnet, effort: 'high' },
    ], standard: [{ target: opus, effort: 'max' }],
  } } } })
  const providers = { 'opencode-go': { usable: false, reason: 'insufficient_balance' } }
  const result = ladderPick(v('light'), s.rules.general, s, candidates, true, 'en', [], providers)
  assert.deepEqual([result.target, result.position, result.rung], [{ agent: 'gpt-6-1-sol' }, 3, 'light'])
  assert.deepEqual(result.skipped?.map(item => item.position), [1, 2])
  assert.match(result.fallbackReason!, /missing.*deepseek-v4.1-flash.*insufficient balance/)
  const onlyOpus = ladderPick(v('light'), s.rules.general, { ...s, providers: { chatgpt: false } }, candidates, true, 'en', ['general-purpose:opus'], providers)
  assert.deepEqual([onlyOpus.target, onlyOpus.rung], [opus, 'standard'])
  assert.equal(onlyOpus.skipped?.length, 4)
  s.rules.general.rungs.light!.reverse()
  assert.deepEqual(ladderPick(v('light'), s.rules.general, s, candidates, true, 'en').target, sonnet)
})

test('a spent quota group skips only its own models: the same provider still runs the others', async () => {
  const { liveProviders } = await import('../../packages/mod/hooks/workers.ts')
  // The owner's 2026-10-23 ladder: Standard opens on Antigravity's Opus, then Antigravity's Gemini.
  const opus = { target: { agent: 'claude-opus-5-5-medium' }, model: 'claude-opus-5-5-medium', provider: 'google-gemini' }
  const flash = { target: { agent: 'gemini-3-8-flash' }, model: 'gemini-3.8-flash', provider: 'google-gemini' }
  const workers = [opus, flash, ...candidates]
  const s = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: { standard: [{ target: opus.target, effort: 'medium' }, { target: flash.target, effort: 'high' }] } } } })
  const raw = { agents: [
    { name: 'claude-opus-5-5-medium', model: 'claude-opus-5-5-medium', provider: 'google-gemini', efforts: ['medium'], billing: 'subscription' },
    { name: 'gemini-3-8-flash', model: 'gemini-3.8-flash', provider: 'google-gemini', efforts: ['high'], billing: 'subscription' },
  ], providers: [
    { name: 'google-gemini', usable: true, models: { 'claude-opus-5-5-medium': { reason: 'quota_exhausted', exhaustedUntil: 1_800_000 }, junk: null } },
  ] }
  const options = ladderOptionsFrom(raw, 600_000)
  assert.deepEqual(options.providers?.['google-gemini'], { usable: true, models: { 'claude-opus-5-5-medium': { reason: 'quota_exhausted', exhaustedUntil: 1_800_000 } } })
  assert.deepEqual(options.choices.filter(c => c.provider === 'google-gemini').map(c => c.target.agent), ['gemini-3-8-flash'], 'the spent model is not offered to a fill')
  const result = ladderPick(v('standard'), s.rules.general, s, workers, true, 'ko', [], options.providers)
  assert.deepEqual([result.target, result.effort, result.position], [flash.target, 'high', 2])
  assert.deepEqual(result.skipped, [{ rung: 'standard', position: 1, model: 'claude-opus-5-5-medium', reason: 'google-gemini: 사용량 한도 소진' }])
  assert.equal(candidateUsable(opus, s, true, options.providers), false)
  assert.equal(candidateUsable(flash, s, true, options.providers), true)
  // Past its stated reset the model is back, even from a cached catalogue.
  const later = liveProviders(options.providers!, 1_800_000)
  assert.deepEqual(later['google-gemini'], { usable: true })
  assert.equal(ladderPick(v('standard'), s.rules.general, s, workers, true, 'ko', [], later).target?.agent, 'claude-opus-5-5-medium')
})

test('a spent model stays skipped when the rung names it with an effort suffix', () => {
  // The re-review's repro: gemini-3.8-flash out, a rung of gemini-3.8-flash@high still picked with nothing skipped.
  const flashHigh = { target: { agent: 'gemini-3-8-flash-high' }, model: 'gemini-3.8-flash@high', provider: 'google-gemini' }
  const astra = candidates.find(c => c.model === 'gpt-6-astra')!
  const s = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: { standard: [{ target: flashHigh.target, effort: 'high' }, { target: astra.target, effort: 'high' }] } } } })
  const providers = { 'google-gemini': { usable: true, models: { 'gemini-3.8-flash': { reason: 'quota_exhausted', exhaustedUntil: 1_800_000 } } } }
  assert.equal(candidateUsable(flashHigh, s, true, providers), false)
  const result = ladderPick(v('standard'), s.rules.general, s, [flashHigh, ...candidates], true, 'ko', [], providers)
  assert.deepEqual([result.target, result.position], [astra.target, 2])
  assert.deepEqual(result.skipped, [{ rung: 'standard', position: 1, model: 'gemini-3.8-flash@high', reason: 'google-gemini: 사용량 한도 소진' }])
  // A general-purpose rung naming the model with its effort is looked up the same way.
  const gp = { target: { agent: 'general-purpose', model: 'gemini-3.8-flash@high' }, model: 'gemini-3.8-flash@high', provider: 'google-gemini' }
  assert.equal(candidateUsable(gp, s, true, providers), false)
})
