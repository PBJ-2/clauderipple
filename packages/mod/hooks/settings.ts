import type { Settings, Tier, TierTarget } from '../types'

export const DEFAULTS: Settings = {
  effortAuto: true, judge: 'haiku', judgeModel: 'deepseek-v4.1-flash',
  bias: 0, floor: 'low', ceiling: 'max', agentAuto: 'auto',
  tiers: {
    light: { agent: 'deepseek-v4-1-flash' }, standard: { agent: 'gpt-6-1-sol' },
    deep: { agent: 'gpt-6-astra' }, design: { agent: 'general-purpose', model: 'sonnet' },
  },
  fallback: { agent: 'general-purpose', model: 'sonnet' },
  keepWarm: false, keepWarmHours: 2, keepWarmMinTokens: 30000,
  compactWith: 'haiku', handoffSkill: '', handoffAfter: 'continue', handoffButton: 'advised',
  swampAt: 50, layout: 'dashboard', appearance: 'auto', hide: ['reason'], setupDone: false,
}

function target(raw: unknown, fallback: TierTarget): TierTarget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback }
  const value = raw as Record<string, unknown>
  const agent = typeof value.agent === 'string' && value.agent.trim() ? value.agent.trim() : fallback.agent
  const model = typeof value.model === 'string' && value.model.trim() ? value.model.trim() : fallback.model
  return { agent, ...(model ? { model } : {}) }
}

/** Stored settings can outlive a release; reject invalid fields without discarding valid neighbours. */
export function normalizeSettings(raw: unknown): Settings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const result: Settings = { ...DEFAULTS, tiers: { ...DEFAULTS.tiers }, hide: [...DEFAULTS.hide] }
  for (const key of ['effortAuto', 'keepWarm', 'setupDone'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  const choices = {
    judge: ['haiku', 'jev', 'model'], bias: [-2, -1, 0, 1, 2], floor: ['low', 'medium', 'high', 'xhigh', 'max'],
    ceiling: ['low', 'medium', 'high', 'xhigh', 'max'], agentAuto: ['off', 'auto', 'all'],
    keepWarmHours: [1, 2, 4, 8], compactWith: ['haiku', 'session'], handoffAfter: ['continue', 'confirm', 'copy'],
    handoffButton: ['advised', 'always'], layout: ['dashboard', 'minimal'], appearance: ['auto', 'dark', 'light'],
  } as const
  for (const key of Object.keys(choices) as (keyof typeof choices)[]) {
    if ((choices[key] as readonly unknown[]).includes(value[key])) Object.assign(result, { [key]: value[key] })
  }
  if (typeof value.judgeModel === 'string' && value.judgeModel.trim()) result.judgeModel = value.judgeModel.trim()
  if (typeof value.handoffSkill === 'string') result.handoffSkill = value.handoffSkill.trim().replace(/^\//, '')
  if (typeof value.keepWarmMinTokens === 'number' && Number.isFinite(value.keepWarmMinTokens) && value.keepWarmMinTokens >= 0) result.keepWarmMinTokens = value.keepWarmMinTokens
  if (typeof value.swampAt === 'number' && Number.isFinite(value.swampAt) && value.swampAt >= 0 && value.swampAt <= 100) result.swampAt = value.swampAt
  if (Array.isArray(value.hide)) result.hide = [...new Set(value.hide.filter((part): part is string => typeof part === 'string' && ['timer', 'reason', 'route', 'limits'].includes(part)))]
  const tiers = value.tiers && typeof value.tiers === 'object' ? value.tiers as Record<string, unknown> : {}
  for (const tier of ['light', 'standard', 'deep', 'design'] as Tier[]) result.tiers[tier] = target(tiers[tier], DEFAULTS.tiers[tier])
  result.fallback = target(value.fallback, DEFAULTS.fallback)
  return result
}
