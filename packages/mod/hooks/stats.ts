import type { Effort, JudgeKind, Stats, Tier, Usage } from '../types'

export function emptyStats(): Stats {
  return { prompts: 0, requests: 0, input: 0, write: 0, read: 0, out: 0, byEffort: {},
    judge: { haiku: 0, jev: 0, model: 0, ms: 0, tokens: 0 }, workers: {}, warm: { pings: 0, cost: 0 } }
}

/** Input-equivalent tokens compare real usage, not hypothetical dollars saved. */
export function weighted(usage: Usage): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * 0.1 + (usage.output_tokens ?? 0) * 5
}

export function addRequest(stats: Stats, usage: Usage, effort: Effort): Stats {
  const bucket = stats.byEffort[effort] ?? { prompts: 0, cost: 0 }
  return { ...stats, requests: stats.requests + 1, input: stats.input + (usage.input_tokens ?? 0),
    write: stats.write + (usage.cache_creation_input_tokens ?? 0), read: stats.read + (usage.cache_read_input_tokens ?? 0),
    out: stats.out + (usage.output_tokens ?? 0),
    byEffort: { ...stats.byEffort, [effort]: { ...bucket, cost: bucket.cost + weighted(usage) } } }
}

export function addPrompt(stats: Stats, effort: Effort): Stats {
  const bucket = stats.byEffort[effort] ?? { prompts: 0, cost: 0 }
  return { ...stats, prompts: stats.prompts + 1,
    byEffort: { ...stats.byEffort, [effort]: { ...bucket, prompts: bucket.prompts + 1 } } }
}

export function addJudge(stats: Stats, judge: JudgeKind, ms: number, tokens: number): Stats {
  return { ...stats, judge: { ...stats.judge, [judge]: stats.judge[judge] + 1,
    ms: stats.judge.ms + ms, tokens: stats.judge.tokens + tokens } }
}

export function addWorker(stats: Stats, tier: Tier): Stats {
  return { ...stats, workers: { ...stats.workers, [tier]: (stats.workers[tier] ?? 0) + 1 } }
}

export function addWarm(stats: Stats, usage: Usage): Stats {
  return { ...stats, warm: { pings: stats.warm.pings + 1, cost: stats.warm.cost + weighted(usage) } }
}

export function formatStats(stats: Stats): string {
  const total = weighted({ input_tokens: stats.input, cache_creation_input_tokens: stats.write,
    cache_read_input_tokens: stats.read, output_tokens: stats.out })
  const judges = stats.judge.haiku + stats.judge.jev + stats.judge.model
  const efforts = (['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).filter(level => stats.byEffort[level]).map(level => {
    const bucket = stats.byEffort[level]!
    return `${level} ${bucket.prompts} prompts / ${Math.round(bucket.cost)} weighted`
  })
  return [
    `Auto: ${stats.prompts} prompts, ${stats.requests} requests; ${Math.round(total)} weighted tokens`,
    `Tokens: input ${stats.input}, write ${stats.write}, read ${stats.read}, output ${stats.out}`,
    ...efforts,
    `Judges: haiku ${stats.judge.haiku}, jev ${stats.judge.jev}, model ${stats.judge.model}; ${stats.judge.tokens} tokens, ${stats.judge.ms} ms (${judges ? Math.round(stats.judge.ms / judges) : 0} ms avg)`,
    `Workers: ${(['light', 'standard', 'deep', 'design'] as Tier[]).map(tier => `${tier} ${stats.workers[tier] ?? 0}`).join(', ')}`,
    `Warm: ${stats.warm.pings} pings, ${Math.round(stats.warm.cost)} weighted tokens`,
  ].join('\n')
}
