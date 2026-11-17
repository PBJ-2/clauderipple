import type { Asked, Effort, JudgeInput, Pick, Settings, Verdict } from '../types'
import { t } from './i18n.ts'
import type { Lang } from './i18n.ts'

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// "xhigh for unusually difficult investigation, max only for the hardest open-ended problems" left
// a medium..max range at medium and high: 10-13..10-17 ran ~9,000 Opus requests with no max and 91
// xhigh, and Jev gave an architecture redesign 2% max (2026-10-19). Above high is now named by
// what hinges on judgment, so important plans and failed attempts can reach it.
export const EFFORT_JUDGE_SYSTEM = `Choose the reasoning effort this work deserves. This is a coding agent able to inspect files, run commands, and edit code, not merely answer a chat question.
Assess work volume, uncertainty, and the cost of mistakes, not message length. A short choice approving a build inherits the size of that build. Closing remarks need little effort. "Think hard" or thorough reasoning requires at least high; an explicit quick answer calls for low.
Low and medium are only for turns that need no judgment: low for chit-chat, thanks, or a direct answer needing no inspection; medium for one fully specified, low-risk step the user spelled out (run this command, rename this). Ordinary coding that asks the agent to decide, explain why, review, verify, debug with a known direction, delegate, or change more than one thing is high.
Go above high when the outcome hinges on judgment rather than labor. xhigh: debugging whose cause is unknown, changes across interacting modules, or planning a feature. max: decisions that shape the product or system (architecture, an important plan or strategy, a design meant to last), work where a wrong call risks security, money, or data loss, and problems that earlier attempts in this conversation failed to solve. Not every plan is max; a small or routine plan is high or xhigh.
When the user says the previous attempt failed, is wrong, or still does not work, choose at least one level above the running effort. Other corrections and steering keep at least the running effort. Consider the current model's strength.
Also report "asked": the reasoning effort the user's latest message explicitly instructs, else "none". Level names: low (낮음), medium (중간), high (높음), xhigh (매우 높음, extra high), max (최대). "auto" means the user hands effort control back to automatic. Only a direct instruction about the effort, reasoning or thinking level counts (for example "set effort to xhigh", "추론 강도 매우 높음으로"). A question about the current level, a complaint about it, a level word in another sense, or "think hard" with no level is "none". If a message complains and then instructs, follow the instruction.
Return only JSON {"effort":"low|medium|high|xhigh|max","asked":"none|low|medium|high|xhigh|max|auto","sure":0.0,"why":"short reason"}. Confidence is between zero and one. The reason uses the user's language and at most six words.`

const ASKED_VALUES: readonly Asked[] = [...EFFORTS, 'auto']

/** "none" and anything unknown mean nothing was asked. */
function askedAnswer(value: unknown): Asked | undefined {
  return ASKED_VALUES.includes(value as Asked) ? value as Asked : undefined
}

const LEVEL_PATTERNS: readonly [Effort, string][] = [
  ['xhigh', '매우\\s*높음|아주\\s*높음|엑스트라\\s*하이|x-?high|extra[\\s-]*high'],
  ['max', '최대|맥스|max(?:imum)?'],
  // Not the tail of "매우 높음" or "extra high", which are xhigh.
  ['high', '(?<!매우\\s*)(?<!아주\\s*)높음|(?<!x-?)(?<!extra[\\s-]*)high'],
  ['medium', '중간|medium'],
  ['low', '낮음|low'],
]
const EFFORT_WORD = '(?:추론|생각|사고)\\s*(?:강도|수준|레벨|량)?|강도|effort|reasoning|thinking'
const ALL_LEVELS = LEVEL_PATTERNS.map(([, source]) => source).join('|')

/** A message may carry an effort request only if it names an effort or a level; a cheap gate before any judge call. */
export function mightAskEffort(text: string): boolean {
  return new RegExp(`${EFFORT_WORD}|${ALL_LEVELS}|자동|\\bauto(?:matic)?\\b`, 'i').test(text)
}

/** A question about the level or a "why" is never an instruction; the sentence it sits in is skipped. */
const QUESTION = /[?？]|왜|\bwhy\b|어째서|how come/i
/** "Do not use max effort", "최대로 하지 마": a level named only to rule it out. */
const NEGATION = /\b(?:not|don['’]?t|never|no longer|instead of|rather than)\b|말고|하지\s*마|않|대신/i
/** A level word next to code, config or sorting is that thing's level, not the agent's effort. */
const OTHER_USE = /\b(?:config|file|code|json|ya?ml|toml|settings?)\b|파일|코드|설정\s*값|정렬|\bsort/i
const KOREAN_ORDER = '해|바꿔|바꾸|올려|내려|맞춰|맞추|설정|변경|지정|돌려|써|사용|부탁|고정|진행|하자|할게'

/**
 * Fallback for a judge that failed, timed out or does not report `asked`; whenever the judge answered,
 * its answer decides (choosePick). A level counts only as an instruction about the agent's own effort:
 * a bare `<level>으로 (해줘)` as the whole message, or an effort word with a level in an imperative or
 * target form (`추론 강도 매우 높음으로`, `set effort to high`, `use max effort`). Questions, other
 * uses of a level word (code, config, sorting) and descriptions (`중간으로 갔지`) never count.
 * The last instruction in the message wins.
 */
export function explicitEffortRequest(text: string): Asked | undefined {
  const body = text.trim()
  if (!body || OTHER_USE.test(body)) return undefined
  if (/^x-?high[\s.!]*$/i.test(body)) return 'xhigh'
  for (const [level, source] of LEVEL_PATTERNS) {
    // A bare "최대로" is as likely "as much as possible" as an effort, so only the judge reads it.
    if (level !== 'max' && new RegExp(`^(?:${source})\\s*(?:으로|로)\\s*(?:해\\s*줘|해\\s*주세요|바꿔\\s*줘|해|바꿔)?[\\s.!]*$`, 'i').test(body)) return level
  }
  const hits: { at: number; level: Asked }[] = []
  let base = 0
  for (const sentence of body.split(/(?<=[?？.!。\n])\s*/)) {
    const start = body.indexOf(sentence, base)
    base = start + sentence.length
    if (!sentence || QUESTION.test(sentence) || NEGATION.test(sentence) || !new RegExp(EFFORT_WORD, 'i').test(sentence)) continue
    for (const [level, source] of LEVEL_PATTERNS) {
      const korean = new RegExp(`(?:${source})\\s*(?:으로|로)(?=[\\s.!,~]*$|\\s*(?:${KOREAN_ORDER}))`, 'gi')
      for (const match of sentence.matchAll(korean)) hits.push({ at: start + (match.index ?? 0), level })
      // English counts only as a command that opens the sentence; "the log says effort: max" describes.
      const english = new RegExp(`^\\s*(?:please\\s+)?(?:set|switch|change|put|bump|raise|lower|turn)\\b[^.!?]*?\\b(?:effort|reasoning|thinking)(?:\\s+level)?\\s+(?:to|at)\\s+(?:${source})\\b|^\\s*(?:effort|reasoning|thinking)\\s+(?:${source})\\W*$|^\\s*(?:please\\s+)?use\\s+(?:${source})\\s+(?:effort|reasoning|thinking)\\b`, 'gi')
      for (const match of sentence.matchAll(english)) hits.push({ at: start + (match.index ?? 0), level })
    }
    if (/자동\s*(?:으로|모드)|자동\s*(?:해|돌려|복귀|되돌|설정|맞춰)|\b(?:back to|return to|switch to|set to|go) auto(?:matic)?\b|\b(?:effort|reasoning|thinking)\s*(?:to|=|:)?\s*auto(?:matic)?\b/i.test(sentence)) {
      hits.push({ at: start + sentence.search(/자동|auto/i), level: 'auto' })
    }
  }
  hits.sort((a, b) => a.at - b.at)
  return hits.at(-1)?.level
}

/** A terse continuation usually carries no new scope; answers to questions are handled separately. */
export function isShortFollowUp(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed.length <= 12 && trimmed.split(/\s+/).length <= 2
}

/** "Still broken" is short but asks for more thought, so it is judged rather than inheriting the effort that failed. */
export function looksLikeRetry(text: string): boolean {
  return /안\s*[돼되]|다시|틀렸|아직|여전|그대로|실패|\bstill\b|\bagain\b|\bwrong\b|\bbroken\b|n['’]?t work|\bfail/i.test(text)
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
  const effortWords = mightAskEffort(input.text)
  // A level the user asked for applies to that prompt only: the next prompt is judged again, even a terse "ok",
  // so it never inherits the asked level as a follow-up would.
  const followup = input.current && !input.current.asked && input.current.by !== 'manual' && !input.text.trim().startsWith('/') &&
    !input.attachments?.length && isShortFollowUp(input.text) && !looksLikeRetry(input.text) && !looksLikeQuestion(input.assistantTail ?? '') && !effortWords
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
  const request = askedAnswer(value?.asked)
  return { effort: level, ...(sure !== undefined ? { sure } : {}), why: typeof value?.why === 'string' ? value.why.slice(0, 60) : '', ...(request ? { asked: request } : {}), ...(request || value?.asked === 'none' ? { askedRead: true as const } : {}) }
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
  return looseVerdictObject(text)
}

/**
 * A small judge sometimes breaks its JSON (Haiku answered `…"why":"…","}`, #53). Its complete
 * `"key": value` pairs still carry the verdict, so they are read one by one; the parsers above
 * check every field they use, so nothing here is trusted beyond a JSON scalar.
 */
function looseVerdictObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  const value: Record<string, unknown> = {}
  const pair = /"(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/g
  for (const match of text.slice(start).matchAll(pair)) {
    try { value[match[1]!] ??= JSON.parse(match[2]!) } catch { /* a malformed scalar adds nothing */ }
  }
  return Object.keys(value).length ? value : undefined
}

const effortCriteria = {
  low: 'Chit-chat, thanks, or a direct answer needing no inspection.',
  medium: 'One fully specified, low-risk step the user spelled out.',
  high: 'Ordinary coding: implement, fix, review, or debug with a known direction.',
  xhigh: 'Debugging with an unknown cause, changes across interacting modules, or planning a feature.',
  max: 'Product or architecture decisions, important plans or strategy, security or data-loss risk, or a problem earlier attempts failed to solve.',
}
const askedCriteria = {
  none: 'No explicit instruction about the effort level: ordinary work, a question about the level, a complaint about it, or a level word used in another sense.',
  low: 'The user instructs low effort (낮음).',
  medium: 'The user instructs medium effort (중간).',
  high: 'The user instructs high effort (높음).',
  xhigh: 'The user instructs extra high effort (매우 높음, xhigh).',
  max: 'The user instructs maximum effort (최대, max).',
  auto: 'The user hands effort control back to automatic.',
}
function jevBody(input: JudgeInput, task: string) {
  return {
    model: 'jev-latest' as const,
    state: { task, current_model: input.current?.model ?? null, current_effort: input.current?.effort ?? null,
      recent_conversation: recent(input), next_message: nextText(input, 4000) },
    questions: {
      effort: { type: 'choice' as const, instructions: 'Select the effort needed for this work.', criteria: { ...effortCriteria } },
      asked: { type: 'choice' as const, instructions: 'Select the reasoning effort the next message explicitly instructs, if any.', criteria: { ...askedCriteria } },
    },
  }
}

export function jevEffortRequest(input: JudgeInput) {
  return jevBody(input, EFFORT_JUDGE_SYSTEM)
}

function answers(json: unknown): Record<string, unknown> | undefined {
  const root = record(json)
  return record(root?.answers) ?? record(record(root?.result)?.answers)
}

function answerSure(answer: Record<string, unknown>): number | undefined {
  return confidence(answer.confidence ?? record(answer.probabilities)?.[String(answer.choice)])
}

/** Torn between levels, Jev leaves a session at the effort it runs when that effort is still a plausible answer. */
export function parseJevEffort(json: unknown, current?: { effort: Effort } | null, lang: Lang = 'en'): Verdict | undefined {
  const answer = record(answers(json)?.effort)
  const level = effort(answer?.choice)
  if (!answer || !level) return undefined
  const sure = answerSure(answer)
  const odds = record(answer.probabilities)
  const plausible = current && (!odds || (confidence(odds[current.effort]) ?? 0) >= 0.25)
  const request = jevAsked(json)
  const choice = record(answers(json)?.asked)?.choice
  const extra = { ...(request ? { asked: request } : {}), ...(askedAnswer(choice) || choice === 'none' ? { askedRead: true as const } : {}) }
  if (sure !== undefined && sure < 0.5 && current && current.effort !== level && plausible) return { effort: current.effort, sure, why: t(lang, 'judge.keptUnsure'), ...extra }
  return { effort: level, ...(sure !== undefined ? { sure } : {}), why: '', ...extra }
}

/** An instruction in chat is trusted only when Jev is at least half sure; a coin flip is not an order. */
function jevAsked(json: unknown): Asked | undefined {
  const answer = record(answers(json)?.asked)
  const value = askedAnswer(answer?.choice)
  if (!answer || !value) return undefined
  const sure = answerSure(answer)
  return sure !== undefined && sure < 0.5 ? undefined : value
}

export function jevUsage(json: unknown): number {
  const usage = record(record(json)?.usage)
  return [usage?.input_tokens, usage?.output_tokens].reduce<number>((sum, count) => sum + (typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0), 0)
}

export function jevFailure(status: number | 'timeout' | 'network', lang: Lang = 'en'): string {
  if (status === 401 || status === 403) return t(lang, 'toasts.jevRejected')
  if (status === 402) return t(lang, 'toasts.jevCredits')
  if (status === 429) return t(lang, 'toasts.jevRateLimited')
  if (status === 'timeout') return t(lang, 'toasts.jevTimeout')
  if (status === 'network') return t(lang, 'toasts.jevNetwork')
  return t(lang, 'toasts.jevHttp', { status })
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

/**
 * Save is last, so even a high floor cannot defeat the subscription-saving cap. A level the user
 * asked for in chat skips bias, floor and ceiling (it is the user's word, not a guess) but not save mode.
 */
export function finalEffort(verdict: Verdict, settings: Settings, saving: boolean, lang: Lang = 'en'): { effort: Effort; why: string } {
  if (verdict.asked && verdict.asked !== 'auto') {
    const result = capped(verdict.asked, saving)
    return { effort: result, why: result !== verdict.asked ? t(lang, 'toasts.saveMode') : t(lang, 'toasts.effortAsked') }
  }
  const adjusted = bounded(tipped(verdict.effort, verdict.sure, settings.bias), settings.floor, settings.ceiling)
  const result = capped(adjusted, saving)
  return { effort: result, why: result !== adjusted ? t(lang, 'toasts.saveMode') : adjusted !== verdict.effort ? t(lang, 'toasts.yourSettings') : verdict.why }
}

/**
 * What a judged prompt does to the session's pick, or null to leave the pick as it is.
 *  - the user asked a level: exactly that level for this prompt's turn (pick.asked marks it so the turn's
 *    steps keep it; the next prompt is judged again and its pick carries no `asked`);
 *  - the user asked for auto: the judge's own choice replaces the asked level;
 *  - otherwise: the judge's verdict through bias, floor, ceiling and save mode. A pick that still carries
 *    `asked` from an earlier prompt is dropped here, never held.
 *  - a judge that failed on such a prompt (or on "auto") keeps the current effort, brought inside the
 *    floor, ceiling and save cap, without `asked`.
 * The judge is read first; the deterministic check covers a judge that said "none" or failed.
 */
export function choosePick(input: { verdict?: Verdict; text: string; current?: Pick | null; settings: Settings; saving: boolean; lang?: Lang; by: Pick['by']; at: number }): Pick | null {
  const lang = input.lang ?? 'en'
  // A judge that answered decides, "none" included; the text check only stands in for one that did not.
  const request = input.verdict?.askedRead || input.verdict?.asked ? input.verdict.asked : explicitEffortRequest(input.text)
  if (request && request !== 'auto') {
    const { effort, why } = finalEffort({ effort: request, why: '', asked: request }, input.settings, input.saving, lang)
    return { effort, why, asked: request, by: input.by, at: input.at }
  }
  if (!input.verdict) {
    // The judge failed after an asked level (or an ask for auto): the level ends with its turn, and the
    // chat keeps running at the effort it had, brought back inside the owner's bounds and save cap.
    const current = input.current
    if (current && (current.asked || request === 'auto')) {
      return { effort: capped(bounded(current.effort, input.settings.floor, input.settings.ceiling), input.saving), why: t(lang, 'toasts.effortAutoBack'), by: current.by, at: input.at }
    }
    return null
  }
  const { asked: _dropped, askedRead: _read, ...verdict } = input.verdict
  const final = finalEffort(verdict, input.settings, input.saving, lang)
  return { ...verdict, ...final, why: request === 'auto' && !final.why ? t(lang, 'toasts.effortAutoBack') : final.why, by: input.by, at: input.at }
}

/**
 * Models whose prompt cache survives an effort change. Fable 5.2 was measured on 2026-11-12 with
 * Claude Code 2.1.321 -p: low→max and high→medium on a resumed session wrote 14 and 17 tokens of
 * cache against ~60k read (a plain resume without an effort change rewrites ~22k by itself).
 */
export function isCacheSafeModel(modelId: string): boolean {
  return /(?:(?:opus|sonnet|haiku)-5-5|fable-5-2)(?:$|[^\d])/.test(modelId)
}
