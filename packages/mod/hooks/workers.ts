import type { Effort, Settings, Tier, TierTarget, WorkerVerdict } from '../types'
import { MARKER } from './worker'
import { parseEffortVerdict, verdictObject } from './judge'

export const WORKER_JUDGE_SYSTEM = `Choose a worker tier and the cheapest effort that still does this delegated task well. Evaluate actual scope and risk, not prompt length.
light: chores, repetitive or mechanical work, simple lookups.
standard: implementation of an already designed change, research, documentation summaries, reviews.
deep: careful high-stakes reasoning, subtle bugs, architecture, security.
design: UI, visual composition, branding, and the look or voice of copy.
Effort choices are low, medium, high, xhigh, max; reserve the last two for exceptionally hard work. Return only JSON {"tier":"light|standard|deep|design","effort":"low|medium|high|xhigh|max","sure":0.0,"why":"brief reason"}. Confidence is zero to one; explain in the user's language in at most six words.`

export function workerJudgeInput(input: { description: string; prompt: string }): string {
  return `Task: ${input.description}\n\nInstructions:\n${input.prompt.slice(0, 3000)}`
}

export function parseWorkerVerdict(text: string): WorkerVerdict | undefined {
  const verdict = parseEffortVerdict(text)
  if (!verdict) return undefined
  const tier = verdictObject(text)?.tier
  if (!['light', 'standard', 'deep', 'design'].includes(String(tier))) return undefined
  return { ...verdict, tier: tier as Tier }
}

/** An explicit routing note anywhere in a spawn must retain the existing worker fix's semantics. */
export function readMarker(prompt: string): { name: string; level?: string } | null {
  const marker = MARKER.exec(prompt)
  return marker ? { name: marker[1]!.toLowerCase(), ...(marker[2] ? { level: marker[2].toLowerCase() } : {}) } : null
}

export function agentProvider(agentFileText: string): string | undefined {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(agentFileText)?.[1]
  const description = head && /^description:\s*(.*)$/m.exec(head)?.[1]
  return description ? /\bvia\s+([A-Za-z0-9_-]+)\./.exec(description)?.[1]?.toLowerCase() : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Unknown availability is not exhaustion; known accounts must pass every quota window. */
export function chatgptUsable(status: unknown): boolean {
  const accounts = record(record(record(status)?.chatgpt)?.accounts)?.chatgpt
  if (!Array.isArray(accounts)) return true
  return accounts.some(value => {
    const account = record(value)
    if (!account || account.state !== 'ready' || account.paused || account.needsReauth) return false
    const limits = record(record(account.quota)?.rate_limits)
    return ['primary', 'secondary'].every(name => {
      const window = record(limits?.[name])
      return !window || typeof window.used_percent !== 'number' || window.used_percent < 100
    })
  })
}

/** Walk upwards only within coding tiers; visual work never silently becomes a coding task. */
export function resolveTarget(tier: Tier, settings: Settings, available: string[], providerOf: (agent: string) => string | undefined, usable: { chatgpt: boolean }): { target: TierTarget; fallbackReason?: string } {
  const order: Tier[] = tier === 'design' ? ['design'] : (['light', 'standard', 'deep'] as Tier[]).slice(['light', 'standard', 'deep'].indexOf(tier))
  let reason: string | undefined
  for (const candidate of order) {
    const target = settings.tiers[candidate]
    if (available.includes(target.agent) && providerOf(target.agent) === 'chatgpt' && !usable.chatgpt) {
      return { target: { ...settings.fallback }, fallbackReason: 'ChatGPT accounts are unavailable or out of quota' }
    }
    const unavailable = !available.includes(target.agent) ? `${target.agent} is not installed` : undefined
    if (!unavailable) return { target: { ...target }, ...(reason ? { fallbackReason: reason } : {}) }
    reason ??= unavailable
  }
  return { target: { ...settings.fallback }, ...(reason ? { fallbackReason: reason } : {}) }
}

/** A generated file's model identifies router workers; built-ins keep their explicit Claude model. */
export function spawnModel(target: TierTarget, effort: Effort, fileModel?: string): string | undefined {
  return fileModel && target.agent !== 'general-purpose' ? `${fileModel.replace(/@[^@]*$/, '')}@${effort}` : target.model
}

export function takesOver(spawn: { subagentType: string; model?: string; fork: boolean }, settings: Settings): boolean {
  if (spawn.fork || settings.agentAuto === 'off') return false
  return ['ripple:auto', 'auto'].includes(spawn.subagentType) ||
    (settings.agentAuto === 'all' && spawn.subagentType === 'general-purpose' && spawn.model === undefined)
}
