import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../../packages/mod/hooks/settings.ts'
import { EFFORT_JUDGE_SYSTEM, isShortFollowUp, looksLikeQuestion, looksLikeRetry, shouldJudge, judgeContext,
  parseEffortVerdict, verdictObject, jevEffortRequest, parseJevEffort,
  jevUsage, jevFailure, parseJevKey, tipped, bounded, capped, finalEffort, isCacheSafeModel } from '../../packages/mod/hooks/judge.ts'
import type { JudgeInput, Pick } from '../../packages/mod/types/index.d.ts'

const pick: Pick = { effort: 'high', why: 'build', by: 'haiku', at: 0 }
const input: JudgeInput = { messages: [], next: 'Build it', current: { model: 'sonnet', effort: 'high' } }

test('follow-up size counts trimmed characters and whitespace words, not semantic keywords', () => {
  for (const s of ['ok', '  계속  ', 'go now', '123456789012', 'a\nb']) assert.equal(isShortFollowUp(s), true, s)
  for (const s of ['', '  ', '1234567890123', 'a b c']) assert.equal(isShortFollowUp(s), false, s)
  assert.equal(looksLikeQuestion('Choose B?'), true)
  assert.equal(looksLikeQuestion('?'+ 'a'.repeat(400)), false)
  assert.equal(looksLikeQuestion('a'.repeat(399) + '?'), true)
})

test('shouldJudge respects auto, human origins, host commands and cache safety', () => {
  const base = { text: 'Implement the plan', origin: 'composer', auto: true }
  assert.equal(shouldJudge(base), true)
  for (const origin of ['composer', 'bridge', 'sdk']) assert.equal(shouldJudge({ ...base, origin }), true)
  for (const origin of ['plugin', 'system', 'peer']) assert.equal(shouldJudge({ ...base, origin }), false)
  assert.equal(shouldJudge({ ...base, auto: false }), false)
  assert.equal(shouldJudge({ ...base, text: ' ' }), false)
  assert.equal(shouldJudge({ ...base, text: '', attachments: [{ type: 'image' }] }), true)
  assert.equal(shouldJudge({ ...base, hostCommand: true }), false)
  assert.equal(shouldJudge({ ...base, modelId: 'claude-fable-5-1' }), false)
  assert.equal(shouldJudge({ ...base, modelId: 'claude-haiku-5-5' }), true)
  assert.equal(shouldJudge({ ...base, text: '/skill', hostCommand: false }), true)
})

test('short answers only skip when they can retain a nonmanual pick without missing scope', () => {
  const base = { text: 'B', origin: 'sdk', auto: true, current: pick, assistantTail: 'Working on it.' }
  assert.equal(shouldJudge(base), false)
  assert.equal(shouldJudge({ ...base, assistantTail: 'A or B?' }), true)
  assert.equal(shouldJudge({ ...base, current: null }), true)
  assert.equal(shouldJudge({ ...base, current: { ...pick, by: 'manual' } }), true)
  assert.equal(shouldJudge({ ...base, attachments: [{ type: 'image' }] }), true)
  assert.equal(shouldJudge({ ...base, text: '/skill' }), true)
})

test('a short "still broken" is judged, so a failed attempt can climb above the effort that failed', () => {
  const base = { origin: 'sdk', auto: true, current: pick, assistantTail: 'Fixed the handler.' }
  for (const text of ['여전히 안 돼', '안되는데', '다시', 'still broken', 'wrong again', "doesn't work"]) {
    assert.equal(looksLikeRetry(text), true, text)
    assert.equal(shouldJudge({ ...base, text }), true, text)
  }
  for (const text of ['ok', '계속', 'B', 'go now']) assert.equal(looksLikeRetry(text), false, text)
  assert.ok(EFFORT_JUDGE_SYSTEM.includes('at least one level above the running effort'))
  assert.ok(EFFORT_JUDGE_SYSTEM.includes('an important plan or strategy'))
})

test('judge context preserves limited latest excerpts and attachment counts', () => {
  const context = judgeContext({ ...input, messages: [
    { role: 'user', text: 'obsolete', toolUses: [] },
    { role: 'user', text: 'u'.repeat(401), toolUses: [] },
    { role: 'assistant', text: 'discard' + 'a'.repeat(2000), toolUses: [] },
    { role: 'assistant', text: ' ', toolUses: [] },
  ], next: 'n'.repeat(2001), contextPercent: 30.6, midTurn: true,
    attachments: [{ type: 'image' }, { type: 'image' }, { type: 'file' }] })
  assert.ok(context.includes(`user: ${'u'.repeat(400)}\nassistant: ${'a'.repeat(2000)}`))
  assert.ok(!context.includes('obsolete') && !context.includes('discard'))
  assert.ok(!context.includes('n'.repeat(2001)))
  assert.ok(context.includes('Context: 31%') && context.includes('image: 2, file: 1') && context.includes('Steering a running turn'))
  assert.ok(judgeContext({ messages: [], next: '' }).includes('unknown / medium'))
  assert.ok(EFFORT_JUDGE_SYSTEM.includes('six words'))
})

test('JSON verdicts tolerate fences/prose, reject invalid effort and bound confidence/reason', () => {
  assert.deepEqual(parseEffortVerdict('preface {junk} ```json\n{"effort":"high","sure":0.65,"why":"fix"}\n```'), { effort: 'high', sure: 0.65, why: 'fix' })
  for (const text of ['', '{}', '{bad}', '{"effort":"HIGH"}', '{"effort":2}']) assert.equal(parseEffortVerdict(text), undefined)
  for (const sure of [-1, 1.01, '0.9', null]) assert.deepEqual(parseEffortVerdict(JSON.stringify({ effort: 'low', sure })), { effort: 'low', why: '' })
  for (const sure of [0, 1]) assert.equal(parseEffortVerdict(JSON.stringify({ effort: 'low', sure }))?.sure, sure)
  assert.equal(parseEffortVerdict(JSON.stringify({ effort: 'max', why: 'w'.repeat(80) }))?.why.length, 60)
  assert.deepEqual(verdictObject('text {"a":{"b":1}} end'), { a: { b: 1 } })
  assert.equal(verdictObject('no JSON'), undefined)
})

test('A verdict whose JSON is broken still yields its complete fields (#53)', () => {
  // Measured from Haiku 2026-10-14: a stray `,"` before the closing brace.
  assert.deepEqual(parseEffortVerdict('{"effort":"medium","sure":0.6,"why":"Structure explanation needs inspection; keep it simple","}'),
    { effort: 'medium', sure: 0.6, why: 'Structure explanation needs inspection; keep it simple' })
  assert.deepEqual(parseEffortVerdict('{"effort":"high","sure":0.8,"why":"cut off'), { effort: 'high', sure: 0.8, why: '' })
  assert.deepEqual(verdictObject('{"effort":"low","why":"a \\"quoted\\" word",'), { effort: 'low', why: 'a "quoted" word' })
  assert.equal(parseEffortVerdict('effort: high'), undefined)
})

test('Jev effort body has only the specified root/state/questions and all effort criteria', () => {
  const body = jevEffortRequest({ ...input, next: 'x'.repeat(5000), contextPercent: 90 })
  assert.deepEqual(Object.keys(body), ['model', 'state', 'questions'])
  assert.equal(body.model, 'jev-latest')
  assert.deepEqual(Object.keys(body.state), ['task', 'current_model', 'current_effort', 'recent_conversation', 'next_message'])
  assert.equal(body.state.current_model, 'sonnet')
  assert.equal(body.state.current_effort, 'high')
  assert.equal(body.state.next_message.length, 4000)
  assert.deepEqual(Object.keys(body.questions), ['effort'])
  assert.deepEqual(Object.keys(body.questions.effort.criteria), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(body.questions.effort.type, 'choice')
  const empty = jevEffortRequest({ messages: [], next: '' })
  assert.equal(empty.state.current_model, null)
  assert.equal(empty.state.current_effort, null)
})

test('Jev parses direct/nested answers and confidence fallback, keeps a plausible current effort only below .5', () => {
  assert.deepEqual(parseJevEffort({ answers: { effort: { choice: 'low', confidence: 0.49 } } }, pick), { effort: 'high', sure: 0.49, why: 'Unsure, kept the running effort' })
  assert.deepEqual(parseJevEffort({ answers: { effort: { choice: 'medium', confidence: 0.4, probabilities: { medium: 0.6, high: 0.3, low: 0.1 } } } }, pick), { effort: 'high', sure: 0.4, why: 'Unsure, kept the running effort' })
  assert.deepEqual(parseJevEffort({ answers: { effort: { choice: 'medium', confidence: 0.4, probabilities: { medium: 0.6, low: 0.3, high: 0.1 } } } }, pick), { effort: 'medium', sure: 0.4, why: '' })
  assert.deepEqual(parseJevEffort({ result: { answers: { effort: { choice: 'low', probabilities: { low: 0.5 } } } } }, pick), { effort: 'low', sure: 0.5, why: '' })
  assert.deepEqual(parseJevEffort({ answers: { effort: { choice: 'low', confidence: 0.1 } } }), { effort: 'low', sure: 0.1, why: '' })
  assert.deepEqual(parseJevEffort({ answers: { effort: { choice: 'max', confidence: 0, probabilities: { max: 1 } } } }), { effort: 'max', sure: 0, why: '' })
  assert.equal(parseJevEffort({ answers: { effort: { choice: 'bad' } } }), undefined)
  assert.equal(parseJevEffort(null), undefined)
  assert.deepEqual(parseJevEffort({ answers: { effort: { choice: 'high', confidence: 2 } } }), { effort: 'high', why: '' })
})

test('Jev usage is top-level and failures give readable status-specific reasons', () => {
  assert.equal(jevUsage({ usage: { input_tokens: 480, output_tokens: 54 } }), 534)
  assert.equal(jevUsage({ result: { usage: { input_tokens: 8 } } }), 0)
  assert.equal(jevUsage({ usage: { input_tokens: -5, output_tokens: 2 } }), 2)
  assert.equal(jevUsage(null), 0)
  assert.equal(jevFailure(401), 'Jev key rejected')
  assert.equal(jevFailure(403), 'Jev key rejected')
  assert.equal(jevFailure(402), 'Jev out of credits')
  assert.equal(jevFailure(429), 'Jev rate limited')
  assert.equal(jevFailure('timeout'), 'Jev timed out')
  assert.equal(jevFailure('network'), 'Jev network unavailable')
  assert.equal(jevFailure(500), 'Jev request failed (500)')
})

test('key parsing accepts whitespace and one matching quote layer but not other names', () => {
  for (const s of ['TYPESAFE_API_KEY=abc', ' X=1\n TYPESAFE_API_KEY = "abc" \r\n', "TYPESAFE_API_KEY='abc'"]) assert.equal(parseJevKey(s), 'abc')
  for (const s of ['', 'TYPESAFE_API_KEY=', 'TYPESAFE_API_KEY=""', 'OTHER_API_KEY=abc', '# TYPESAFE_API_KEY=abc']) assert.equal(parseJevKey(s), undefined)
  assert.equal(parseJevKey('TYPESAFE_API_KEY="\'abc\'"'), "'abc'")
  assert.equal(parseJevKey('TYPESAFE_API_KEY=\nOTHER=secret'), undefined)
  assert.equal(parseJevKey('TYPESAFE_API_KEY=   \r\nOTHER=secret'), undefined)
})

test('bias equality is not a close call and magnitude two still moves only one level', () => {
  assert.equal(tipped('high', 0.65, 1), 'high')
  assert.equal(tipped('high', 0.6499, 1), 'xhigh')
  assert.equal(tipped('high', 0.65, -1), 'high')
  assert.equal(tipped('high', 0.6499, -1), 'medium')
  assert.equal(tipped('high', 0.85, 2), 'high')
  assert.equal(tipped('high', 0.8499, 2), 'xhigh')
  assert.equal(tipped('high', 0.85, -2), 'high')
  assert.equal(tipped('high', 0.8499, -2), 'medium')
  assert.equal(tipped('low', 0.1, -2), 'low')
  assert.equal(tipped('max', 0.1, 2), 'max')
  assert.equal(tipped('high', undefined, 2), 'high')
  assert.equal(tipped('high', NaN, 2), 'high')
  assert.equal(tipped('high', 0.1, 0), 'high')
})

test('floor wins inverted ceiling, save wins floor, and reasons explain final changes', () => {
  assert.equal(bounded('low', 'high', 'medium'), 'high')
  assert.equal(bounded('max', 'low', 'high'), 'high')
  assert.equal(capped('max', true), 'medium')
  assert.equal(capped('low', true), 'low')
  assert.equal(capped('max', false), 'max')
  const verdict = { effort: 'high' as const, sure: 0.1, why: 'complex work' }
  assert.deepEqual(finalEffort(verdict, DEFAULTS, false), { effort: 'high', why: 'complex work' })
  assert.deepEqual(finalEffort(verdict, { ...DEFAULTS, bias: -1 }, false), { effort: 'medium', why: 'your settings' })
  assert.deepEqual(finalEffort(verdict, { ...DEFAULTS, floor: 'max', ceiling: 'low' }, true), { effort: 'medium', why: 'save mode' })
})

test('only the measured models (5.5 Claude families, Fable 5.2) are cache-safe', () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5-20261001', 'haiku-5-5', 'claude-fable-5-2', 'claude-fable-5-2[1m]']) assert.equal(isCacheSafeModel(id), true)
  for (const id of ['claude-fable-5-1', 'claude-fable-5-20', 'claude-mythos-5-1', 'claude-opus-4-6', 'gpt-6-1-sol', 'claude-sonnet-5-50', 'sonnet']) assert.equal(isCacheSafeModel(id), false)
})
