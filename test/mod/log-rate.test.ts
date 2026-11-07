// The log pane's output rate is the dashboard's figure: output tokens over the request's whole
// recorded time, shown only for a finished model answer with a real output count. Follows
// test/mod/modes.test.ts for extensionless imports.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

import type { StatusRequest } from '../../packages/mod/types/index.d.ts'

registerHooks({ resolve(specifier, context, next) {
  const source = context.parentURL?.includes('/packages/mod/hooks/')
  return next(source && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { outputRate, rateText } = await import('../../packages/mod/hooks/ui/view.ts')

const answer: StatusRequest = { at: '2026-11-06T00:00:00.000Z', source: 'm', target: 'm', provider: 'p', status: 200, ok: true, ms: 4_000, kind: 'messages', usage: { input: 10, cached: 0, output: 800 } }

test('a finished answer has its output over its whole time', () => {
  assert.equal(outputRate(answer), 200)
  assert.equal(outputRate({ ...answer, kind: undefined }), 200)
})

test('no rate without a real answer, a real output or enough time', () => {
  for (const record of [
    { ...answer, ok: false, status: 502 },
    { ...answer, resent: true },
    { ...answer, upstreamCalled: false as const },
    { ...answer, purpose: 'web-search' },
    { ...answer, kind: 'image' },
    { ...answer, usage: undefined },
    { ...answer, usage: { input: 10, cached: 0, output: 0 } },
    { ...answer, ms: 120 },
  ]) assert.equal(outputRate(record), undefined, JSON.stringify(record))
})

test('a rate reads one decimal below 100 and whole above', () => {
  assert.equal(rateText(45.26), '45.3')
  assert.equal(rateText(176.4), '176')
})
