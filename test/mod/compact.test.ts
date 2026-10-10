import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionMessage } from 'claude-code'
import { COMPACT_SYSTEM, serializeTranscript, compactResult } from '../../packages/mod/hooks/compact.ts'

const message = (text: string, bulk = 0): SessionMessage => ({ role: 'assistant', text, toolUses: bulk ? [
  { tool_use_id: 'read-1', tool: 'Read', input: { file: 'input-' + 'i'.repeat(bulk) }, text: 'result-' + 'r'.repeat(bulk), isError: true },
] : [] })

test('transcript keeps roles, text, tools, errors and standalone results', () => {
  const messages: SessionMessage[] = [message('thinking', 20), { role: 'user', text: 'continue', toolUses: [],
    toolResults: [{ tool_use_id: 'read-2', text: 'standalone', isError: false }] }]
  const text = serializeTranscript(messages)!
  assert.ok(text.includes('assistant:\nthinking') && text.includes('user:\ncontinue'))
  assert.ok(text.includes('tool Read (read-1)') && text.includes('input-'))
  assert.ok(text.includes('result ERROR') && text.includes('result read-2:\nstandalone'))
  assert.ok(COMPACT_SYSTEM.includes('changes of mind') && COMPACT_SYSTEM.includes('pending'))
})

test('last six tool inputs/results get 20k, older input 400 and result 2k', () => {
  const messages = [message('old', 30000), ...Array.from({ length: 6 }, (_, i) => message(`recent-${i}`, 30000))]
  const text = serializeTranscript(messages)!
  const [old, tail] = text.split('\n\n---\n\n')
  assert.ok(old!.includes('i'.repeat(350)) && !old!.includes('i'.repeat(401)))
  assert.ok(old!.includes('r'.repeat(1900)) && !old!.includes('r'.repeat(2001)))
  assert.ok(tail!.includes('i'.repeat(19000)) && !tail!.includes('i'.repeat(20001)))
  assert.ok(tail!.includes('r'.repeat(19000)) && !tail!.includes('r'.repeat(20001)))
})

test('two-pass shrink obeys inclusive budget without dropping message text', () => {
  const messages = [message('keep this request', 30000)]
  const full = serializeTranscript(messages)!
  assert.equal(serializeTranscript(messages, full.length), full)
  const tight = serializeTranscript(messages, 10000)!
  assert.ok(tight.length <= 10000 && tight.length < full.length)
  assert.ok(tight.includes('keep this request'))
  assert.ok(!tight.includes('r'.repeat(4001)))
  assert.equal(serializeTranscript(messages, tight.length), tight)
  assert.equal(serializeTranscript(messages, tight.length - 1), null)
  assert.equal(serializeTranscript([message('x'.repeat(100))], 99), null)
  assert.equal(serializeTranscript([]), null)
})

test('tight pass reduces old results to 300 and represents result records without text', () => {
  const old = message('old', 3000)
  const messages = [old, ...Array.from({ length: 6 }, () => message('tail'))]
  const full = serializeTranscript(messages)!
  const tight = serializeTranscript(messages, full.length - 1)!
  assert.ok(tight.includes('r'.repeat(250)) && !tight.includes('r'.repeat(301)))
  assert.ok(serializeTranscript([{ role: 'assistant', text: '', toolUses: [
    { tool_use_id: 'x', tool: 'Bash', input: {}, result: { ok: true } },
  ] }])!.includes('{"ok":true}'))
})

test('default 2.4M budget falls back rather than truncating essential user text', () => {
  assert.equal(serializeTranscript([message('x'.repeat(2400001))]), null)
})

test('compact replacement is a built user message, not engine handles or an unsupported summary field', () => {
  const result = compactResult('  verified state  ')
  assert.deepEqual(Object.keys(result), ['messages'])
  assert.equal(result.messages.length, 1)
  const replacement = result.messages[0]!
  assert.equal(replacement.role, 'user')
  assert.deepEqual(replacement.toolUses, [])
  assert.equal(replacement.handle, undefined)
  assert.ok(replacement.text.includes('\n\nverified state\n\n') && replacement.text.includes('Resume'))
})
