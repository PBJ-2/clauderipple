import type { Effort, JudgeInput, Pick, Settings, Verdict, WorkerVerdict, Tier } from '../types'

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const TIERS: readonly Tier[] = ['light', 'standard', 'deep', 'design']

export const EFFORT_JUDGE_SYSTEM = `Choose the cheapest reasoning effort that can do this work well. This is a coding agent able to inspect files, run commands, and edit code, not merely answer a chat question.
Assess work volume, uncertainty, and the cost of mistakes, not message length. A short choice approving a build inherits the size of that build. Corrections and steering retain at least the running effort; closing remarks need little effort. "Think hard" or thorough reasoning requires at least high; an explicit quick answer calls for low.
Use low for simple direct tasks, medium for ordinary bounded work, high for substantial debugging or multi-step changes, xhigh for unusually difficult investigation, and max only for the hardest open-ended problems. Consider the current model's strength.
Return only JSON {"effort":"low|medium|high|xhigh|max","sure":0.0,"why":"short reason"}. Confidence is between zero and one. The reason uses the user's language and at most six words.`

/** A terse continuation usually carries no new scope; answers to questions are handled separately. */
export function isShortFollowUp(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed.length <= 12 && trimmed.split(/\s+/).length <= 2
}

export function looksLikeQuestion(assistantTail: string): boolean {
  return assistantTail.slice(-400).includes('?')
}

/** The caller resolves slash commands so skills can be judged while host commands stay untouched. */
export function shouldJudge(input: {
  text: string; origin: string; auto: boolean; hostCommand?: boolean; modelId?: string
  attachments?: readonly { type: string }[]; current?: Pick | null; assistantTail?: string
}): boolean {
  if (!input.auto || !['composer', 'bridge', 'sdk'].includes(input.origin) || (!input.text.trim() && !input.attachments?.length) || input.hostCommand) return false
  if (input.modelId !== undefined && !isCacheSafeModel(input.modelId)) return false
  const followup = input.current && input.current.by !== 'manual' && !input.text.trim().startsWith('/') &&
    !input.attachments?.length && isShortFollowUp(input.text) && !looksLikeQuestion(input.assistantTail ?? '')
  return !followup
}

function recent(input: JudgeInput): string {
  const user = input.messages.findLast(message => message.role === 'user' && message.text.trim())
  const assistant = input.messages.findLast(message => message.role === 'assistant' && message.text.trim())
  return [user && `user: ${user.text.slice(0, 400)}`, assistant && `assistant: ${assistant.text.slice(-2000)}`].filter(Boolean).join('\n')
}

function nextText(input: JudgeInput, limit: number): string {
  const counts: Record<string, number> = {}
  for (const attachment of input.attachments ?? []) counts[attachment.type] = (counts[attachment.type] ?? 0) + 1
  const attachments = Object.entries(counts).map(([type, count]) => `${type}: ${count}`).join(', ')
  return [input.next.slice(0, limit), attachments && `Attachments (${attachments}).`,
    input.midTurn && 'Steering a running turn: keep its effort for corrections and additions.'].filter(Boolean).join('\n')
}

/** Keep options in the assistant tail, since a one-letter answer may approve substantial work. */
export function judgeContext(input: JudgeInput): string {
  return [
    `Current: ${input.current?.model ?? 'unknown'} / ${input.current?.effort ?? 'medium'}`,
    recent(input) && `Recent conversation:\n${recent(input)}`,
    input.contextPercent !== undefined && Number.isFinite(input.contextPercent) && `Context: ${Math.round(input.contextPercent)}%`,
    `Next message:\n${nextText(input, 2000)}`,
  ].filter(Boolean).join('\n\n')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function confidence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}

function effort(value: unknown): Effort | undefined {
  return EFFORTS.includes(value as Effort) ? value as Effort : undefined
}

/** JSON is a boundary: prose and fences are harmless, malformed objects are not verdicts. */
export function parseEffortVerdict(text: string): Verdict | undefined {
  const value = verdictObject(text)
  const level = effort(value?.effort)
  if (!level) return undefined
  const sure = confidence(value?.sure)
  return { effort: level, ...(sure !== undefined ? { sure } : {}), why: typeof value?.why === 'string' ? value.why.slice(0, 60) : '' }
}

/** Shared boundary decoder keeps effort and worker fields on the same object. */
export function verdictObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1))
        const parsed = record(value)
        if (parsed) return parsed
      } catch {
        // Try a smaller span: a judge can put braces in its surrounding prose.
      }
    }
  }
  return undefined
}

const effortCriteria = {
  low: 'Small direct work with little uncertainty or planning.',
  medium: 'Ordinary bounded coding with a few inspections or edits.',
  high: 'Substantial multi-step coding or debugging where mistakes matter.',
  xhigh: 'Difficult extended investigation with interacting constraints.',
  max: 'Exceptional open-ended research or the hardest reasoning problems.',
}
const tierCriteria = {
  light: 'Mechanical chores, repeated changes, or simple lookups.',
  standard: 'Implement a designed change, research, summarize documentation, or review.',
  deep: 'Careful high-stakes reasoning, subtle debugging, architecture, or security.',
  design: 'UI, visual presentation, branding, or the look and voice of copy.',
}

function jevBody(input: JudgeInput, task: string) {
  return {
    model: 'jev-latest' as const,
    state: { task, current_model: input.current?.model ?? null, current_effort: input.current?.effort ?? null,
      recent_conversation: recent(input), next_message: nextText(input, 4000) },
    questions: { effort: { type: 'choice' as const, instructions: 'Select the effort needed for this work.', criteria: { ...effortCriteria } } },
  }
}

export function jevEffortRequest(input: JudgeInput) {
  return jevBody(input, EFFORT_JUDGE_SYSTEM)
}

/** Jev chooses a stable tier, never a provider's changing model catalogue. */
export function jevWorkerRequest(input: { description: string; prompt: string }) {
  const body = jevBody({ messages: [], next: `${input.description}\n${input.prompt.slice(0, 3000)}` }, 'Choose a worker tier and reasoning effort for a delegated coding task. Judge its scope and risk; visual and brand work belongs to design.')
  return { ...body, questions: { ...body.questions,
    tier: { type: 'choice' as const, instructions: 'Select the kind of worker this task needs.', criteria: { ...tierCriteria } },
  } }
}

function answers(json: unknown): Record<string, unknown> | undefined {
  const root = record(json)
  return record(root?.answers) ?? record(record(root?.result)?.answers)
}

function answerSure(answer: Record<string, unknown>): number | undefined {
  return confidence(answer.confidence ?? record(answer.probabilities)?.[String(answer.choice)])
}

export function parseJevEffort(json: unknown, current?: { effort: Effort } | null): Verdict | undefined {
  const answer = record(answers(json)?.effort)
  const level = effort(answer?.choice)
  if (!answer || !level) return undefined
  const sure = answerSure(answer)
  if (sure !== undefined && sure < 0.5 && current) return { effort: current.effort, sure, why: 'unsure' }
  return { effort: level, ...(sure !== undefined ? { sure } : {}), why: '' }
}

export function parseJevWorker(json: unknown): WorkerVerdict | undefined {
  const reply = answers(json)
  const tierAnswer = record(reply?.tier)
  const effortAnswer = record(reply?.effort)
  const level = effort(effortAnswer?.choice)
  if (!tierAnswer || !TIERS.includes(tierAnswer.choice as Tier) || !effortAnswer || !level) return undefined
  const scores = [answerSure(tierAnswer), answerSure(effortAnswer)].filter((score): score is number => score !== undefined)
  return { tier: tierAnswer.choice as Tier, effort: level, ...(scores.length ? { sure: Math.min(...scores) } : {}), why: '' }
}

export function jevUsage(json: unknown): number {
  const usage = record(record(json)?.usage)
  return [usage?.input_tokens, usage?.output_tokens].reduce<number>((sum, count) => sum + (typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0), 0)
}

export function jevFailure(status: number | 'timeout' | 'network'): string {
  if (status === 401 || status === 403) return 'Jev key rejected'
  if (status === 402) return 'Jev out of credits'
  if (status === 429) return 'Jev rate limited'
  if (status === 'timeout') return 'Jev timed out'
  if (status === 'network') return 'Jev network unavailable'
  return `Jev request failed (${status})`
}

export function parseJevKey(fileText: string): string | undefined {
  const value = /^[ \t]*TYPESAFE_API_KEY[ \t]*=[ \t]*([^\r\n]*)/m.exec(fileText)?.[1]?.trim()
  if (!value) return undefined
  const unquoted = ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) ? value.slice(1, -1).trim() : value
  return unquoted || undefined
}

export function tipped(level: Effort, sure: number | undefined, bias: Settings['bias']): Effort {
  if (!bias || sure === undefined || !Number.isFinite(sure) || sure < 0 || sure >= (Math.abs(bias) === 2 ? 0.85 : 0.65)) return level
  return EFFORTS[Math.max(0, Math.min(4, EFFORTS.indexOf(level) + Math.sign(bias)))]!
}

export function bounded(level: Effort, floor: Effort, ceiling: Effort): Effort {
  const min = EFFORTS.indexOf(floor)
  const max = Math.max(min, EFFORTS.indexOf(ceiling))
  return EFFORTS[Math.max(min, Math.min(max, EFFORTS.indexOf(level)))]!
}

export function capped(level: Effort, saving: boolean): Effort {
  return saving && EFFORTS.indexOf(level) > 1 ? 'medium' : level
}

/** Save is last, so even a high floor cannot defeat the subscription-saving cap. */
export function finalEffort(verdict: Verdict, settings: Settings, saving: boolean): { effort: Effort; why: string } {
  const adjusted = bounded(tipped(verdict.effort, verdict.sure, settings.bias), settings.floor, settings.ceiling)
  const result = capped(adjusted, saving)
  return { effort: result, why: result !== adjusted ? 'save mode' : adjusted !== verdict.effort ? 'your settings' : verdict.why }
}

export function isCacheSafeModel(modelId: string): boolean {
  return /(?:opus|sonnet|haiku)-5-5(?:$|[^\d])/.test(modelId)
}
