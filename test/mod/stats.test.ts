import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyStats, weighted, addRequest, addPrompt, addJudge, addWorker, addWarm, formatStats } from '../../packages/mod/hooks/stats.ts'
const usage = { input_tokens: 100, cache_creation_input_tokens: 80, cache_read_input_tokens: 1000, output_tokens: 20 }

test('emptyStats has fresh nested counters and weighted accepts omitted usage', () => {
  assert.equal(weighted({}), 0)
  assert.equal(weighted(usage), 400)
  const first = emptyStats()
  assert.deepEqual(first, { prompts: 0, requests: 0, input: 0, write: 0, read: 0, out: 0,
    byEffort: {}, judge: { haiku: 0, jev: 0, model: 0, ms: 0, tokens: 0 }, workers: {}, warm: { pings: 0, cost: 0 } })
  first.warm.pings = 4
  assert.equal(emptyStats().warm.pings, 0)
})

test('requests accumulate raw tokens and applied effort costs without counting prompts', () => {
  const original = emptyStats()
  const first = addRequest(original, usage, 'high')
  const second = addRequest(first, {}, 'high')
  const third = addRequest(second, usage, 'low')
  assert.equal(third.requests, 3)
  assert.equal(third.prompts, 0)
  assert.deepEqual([third.input, third.write, third.read, third.out], [200, 160, 2000, 40])
  assert.deepEqual(third.byEffort, { high: { prompts: 0, cost: 400 }, low: { prompts: 0, cost: 400 } })
  assert.equal(original.requests, 0)
  assert.deepEqual(first.byEffort, { high: { prompts: 0, cost: 400 } })
})

test('prompts include judge-free followups without changing request cost', () => {
  const first = addRequest(emptyStats(), usage, 'high')
  const next = addPrompt(addPrompt(first, 'high'), 'medium')
  assert.equal(next.prompts, 2)
  assert.equal(next.requests, 1)
  assert.deepEqual(next.byEffort, { high: { prompts: 1, cost: 400 }, medium: { prompts: 1, cost: 0 } })
  assert.equal(next.judge.haiku, 0)
  assert.equal(first.prompts, 0)
})

test('judge, worker and warm accounting stays separate from main requests', () => {
  const original = emptyStats()
  let next = addJudge(original, 'haiku', 100, 20)
  next = addJudge(next, 'jev', 50, 10)
  next = addJudge(next, 'model', 80, 15)
  next = addWorker(addWorker(addWorker(next, 'light'), 'light'), 'design')
  next = addWarm(next, usage)
  assert.deepEqual(next.judge, { haiku: 1, jev: 1, model: 1, ms: 230, tokens: 45 })
  assert.deepEqual(next.workers, { light: 2, design: 1 })
  assert.deepEqual(next.warm, { pings: 1, cost: 400 })
  assert.equal(next.requests, 0)
  assert.equal(next.input, 0)
  assert.deepEqual(original, emptyStats())
})

test('stats text is compact measured accounting, with safe empty averages and all categories', () => {
  const empty = formatStats(emptyStats())
  assert.ok(empty.includes('0 prompts, 0 requests; 0 weighted tokens'))
  assert.ok(!empty.includes('NaN') && !empty.includes('Infinity'))
  const stats = addWarm(addWorker(addJudge(addPrompt(addRequest(emptyStats(), usage, 'high'), 'high'), 'haiku', 120, 30), 'deep'), usage)
  assert.equal(formatStats(stats), [
    'Auto: 1 prompts, 1 requests; 400 weighted tokens',
    'Tokens: input 100, write 80, read 1000, output 20',
    'high 1 prompts / 400 weighted',
    'Judges: haiku 1, jev 0, model 0; 30 tokens, 120 ms (120 ms avg)',
    'Workers: light 0, standard 0, deep 1, design 0',
    'Warm: 1 pings, 400 weighted tokens',
  ].join('\n'))
})
