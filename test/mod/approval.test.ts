import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APPROVAL_BODY_CAP, APPROVAL_FRESH_MS, askId, decisionOf, heldReply, holdable } from '../../packages/mod/hooks/approval.ts'
import { APPROVAL_FRESH_MS as HOST_APPROVAL_FRESH_MS, APPROVAL_WAIT_MS } from '../../packages/remote/src/mod-approval.ts'

test('only ordinary tools are held: a hook allow never dismisses the question or plan dialogs', () => {
  assert.equal(holdable('Bash'), true)
  assert.equal(holdable('Edit'), true)
  assert.equal(holdable('AskUserQuestion'), false)
  assert.equal(holdable('ExitPlanMode'), false)
})

test('the phone allow is a plain allow, and an always carries exactly the updates the host sent', () => {
  assert.deepEqual(decisionOf({ behavior: 'allow' }), { behavior: 'allow' })
  assert.deepEqual(decisionOf({ behavior: 'allow', updates: [] }), { behavior: 'allow' })
  const updates = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'session' }]
  assert.deepEqual(decisionOf({ behavior: 'allow', updates }), { behavior: 'allow', updatedPermissions: updates })
  assert.deepEqual(decisionOf({ behavior: 'deny', message: 'not this' }), { behavior: 'deny', message: 'not this' })
})

test('the host reply is read strictly: only a plain pending, answered, local or expired state is trusted', () => {
  assert.deepEqual(heldReply(JSON.stringify({ state: 'pending' })), { state: 'pending' })
  assert.deepEqual(heldReply(JSON.stringify({ state: 'local' })), { state: 'local' })
  assert.deepEqual(heldReply(JSON.stringify({ state: 'expired' })), { state: 'expired' })
  assert.deepEqual(heldReply(JSON.stringify({ state: 'answered', answer: { behavior: 'deny', message: 'no' } })), { state: 'answered', answer: { behavior: 'deny', message: 'no' } })
  assert.deepEqual(heldReply(JSON.stringify({ state: 'answered', answer: { behavior: 'allow', updates: [{ type: 'x' }] } })), { state: 'answered', answer: { behavior: 'allow', updates: [{ type: 'x' }] } })
  assert.deepEqual(heldReply(JSON.stringify({ state: 'answered', answer: { behavior: 'allow' } })), { state: 'answered', answer: { behavior: 'allow' } })
  assert.deepEqual(heldReply(JSON.stringify({ state: 'answered', answer: { behavior: 'maybe' } })), { state: 'answered' }, 'an unknown answer is no answer')
  assert.deepEqual(heldReply(JSON.stringify({ state: 'bogus' })), { state: 'unknown' })
  assert.deepEqual(heldReply('<html>not found</html>'), { state: 'unknown' })
  assert.deepEqual(heldReply('[]'), { state: 'unknown' })
})

test('ask ids are the host’s own shape, unique per call, and short', () => {
  const ids = new Set<string>()
  for (let i = 0; i < 50; i++) ids.add(askId(1_700_000_000_000 + i))
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^[\w-]{1,100}$/)
  assert.equal(askId(1, () => 0.5), `1-${(0.5).toString(36).slice(2, 12)}`)
})

test('a hook gives the Mac its dialog one freshness window after its last answered poll, the window the host fences by', () => {
  assert.equal(APPROVAL_FRESH_MS, HOST_APPROVAL_FRESH_MS, 'the hook and the host must agree on the window')
  assert.ok(APPROVAL_FRESH_MS > APPROVAL_WAIT_MS, 'a healthy hook, polling every long-poll, is never fenced')
  assert.ok(APPROVAL_BODY_CAP < 512 * 1024, 'the host reads at most 512 KB, with room for its own framing')
})
