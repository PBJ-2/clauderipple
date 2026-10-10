import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUICK_PROMPT, FULL_PROMPT, wrapForNewChat, ADVICE_SYSTEM, adviceDue, adviceInput, parseAdvice } from '../../packages/mod/hooks/handoff.ts'
import type { SessionMessage } from 'claude-code'

test('handoff prompts distinguish no-tools quick note from verified durable full handoff', () => {
  assert.ok(QUICK_PROMPT.includes('do not run tools') && QUICK_PROMPT.includes('forty lines'))
  assert.ok(QUICK_PROMPT.includes('verified') && QUICK_PROMPT.includes('permissions') && QUICK_PROMPT.includes('secrets'))
  assert.ok(FULL_PROMPT.includes('git status') && FULL_PROMPT.includes('pushed') && FULL_PROMPT.includes('gh'))
  assert.ok(FULL_PROMPT.includes('HANDOFF.md') && FULL_PROMPT.includes('eighty lines'))
})

test('wrapping handles continue, confirm, copy and full skill file recovery', () => {
  const continueText = wrapForNewChat('  state  ', 'continue', 'quick', false)
  assert.ok(continueText.includes('\n\nstate\n\n') && continueText.includes('Continue with'))
  assert.ok(continueText.includes('permission') && continueText.includes('wait'))
  const confirm = wrapForNewChat('state', 'confirm', 'quick', false)
  assert.ok(confirm.includes('two lines') && confirm.includes('without starting work'))
  assert.equal(wrapForNewChat('state', 'copy', 'quick', false), wrapForNewChat('state', 'continue', 'quick', false))
  assert.ok(wrapForNewChat('saved it', 'continue', 'full', true).startsWith('First read the saved handoff files'))
  assert.ok(wrapForNewChat('saved it', 'continue', 'full', true).includes('HANDOFF.md'))
  assert.ok(!wrapForNewChat('state', 'continue', 'full', false).includes('First read'))
  assert.ok(!wrapForNewChat('state', 'continue', 'quick', true).includes('First read'))
})

test('advice starts at thirty percent on every second real prompt only', () => {
  assert.equal(adviceDue(2, 30), true)
  assert.equal(adviceDue(4, 90), true)
  for (const [count, percent] of [[0, 30], [1, 30], [3, 30], [2, 29.99], [-2, 90], [2.5, 90]]) assert.equal(adviceDue(count!, percent!), false)
  assert.ok(ADVICE_SYSTEM.includes('not enough') && ADVICE_SYSTEM.includes('uncertain'))
})

test('advice excerpts follow independent limits and retain user trail order', () => {
  const messages: SessionMessage[] = [
    { role: 'user', text: 'first-' + 'f'.repeat(600), toolUses: [] },
    ...Array.from({ length: 9 }, (_, i): SessionMessage => ({ role: 'user', text: `u${i} ` + 't'.repeat(200), toolUses: [] })),
    { role: 'assistant', text: 'discard-' + 'a'.repeat(700), toolUses: [] },
  ]
  const text = adviceInput({ messages, next: 'n'.repeat(601), contextPercent: 30.6, warm: false })
  assert.ok(text.includes('Context: 31%; user messages: 10; cache: cold'))
  assert.ok(text.includes('first-') && !text.includes('f'.repeat(500)))
  assert.ok(!text.includes('u0 ') && !text.includes('u8 '))
  assert.ok(text.indexOf('u1 ') >= 0 && text.indexOf('u1 ') < text.indexOf('u7 '))
  assert.ok(!text.includes('t'.repeat(161)) && !text.includes('discard-') && !text.includes('n'.repeat(601)))
  assert.ok(adviceInput({ messages: [], next: '', contextPercent: 0, warm: true }).includes('cache: warm'))
})

test('advice parser treats malformed/no/empty output as no advice and caps real reason', () => {
  assert.equal(parseAdvice('```json\n{"handoff":"  new task  "}\n```'), 'new task')
  assert.equal(parseAdvice(JSON.stringify({ handoff: 'x'.repeat(100) }))?.length, 70)
  for (const text of ['', 'bad', '{}', '{bad}', '{"handoff":null}', '{"handoff":false}', '{"handoff":" "}']) assert.equal(parseAdvice(text), null)
})
