import type { Billing, Domain, Effort, LadderChoice, LadderOptions, ModelScore, ProviderAvailability, RouterModel, Rule, Rung, Settings, TierTarget, WorkerCandidate, WorkerPick, WorkerVerdict } from '../types'
import { CLAUDE_WORKERS, EFFORTS, candidateKey, isAllowed } from './settings'
import { MARKER, providerModelId } from './worker'
import { t } from './i18n'
import type { Lang } from './i18n'
import { claudeChoices, rungAbove, rungOf, tickedChoices } from './ladder'

/** The one agent the main chat delegates to (docs/specs/2026-10-12-worker-tiers.md). */
// The description line: a chat that had seen other workers' "Sol·high · " titles wrote one here
// too, and the app's running-agent row showed "Sol·high" while Sonnet ran (2026-10-22). The row
// shows the call as written; only the task list gets the mod's corrected title.
//
// Who names the worker's model changed three times in two days (4000c3f, 28ae836, e9876fc). The
// session guessed models from earlier tasks; then the worker judge, reading a few messages, gave a
// render step's "딥시크" to the translation before it and could not see the written rule that
// translation runs on Opus (2026-10-24). Now the session, which sees the whole conversation, names
// the domain and rung; the owner's ladder names the model; a model is named only with its source,
// which the mod checks but never re-reads as language. A wrong call is fixed in the criteria or the
// review, not by moving the decision again.
export const AUTO_DESCRIPTION = 'Delegate tasks here. Put the tier, and a domain word when it applies, on the prompt\'s first line: ' +
  '[[ripple: light]], [[ripple: standard]], [[ripple: hard]] or [[ripple: max]]; light = lookups, mechanical edits, one small fix; ' +
  'standard = carry out a designed change (even across several files), research, summarize, read-only review; ' +
  'hard = subtle debugging, security review, or work where a wrong call is costly; max = planning or architecture where the deliverable is the decision itself. ' +
  'Size, file count or the brief\'s warnings do not by themselves make a task hard. Add ui only when the work needs visual judgment: visual design, a new screen\'s layout, or UX decisions, as in [[ripple: standard ui]]; ' +
  'restoring, porting, wiring or translating existing UI code takes no domain word. Add backend for server, API or database work. ' +
  'With no marker the task runs as general standard. The owner\'s ladder picks the model for the tier. ' +
  'Name a model instead only when the user asked for it for this task, or a written rule (CLAUDE.md, a memory file) assigns it to this step: ' +
  'put [[ripple: <worker agent name or opus/sonnet/haiku>@<effort>]] on the first line and on the second line "Model reason: user \\"<the user\'s exact words>\\"" or "Model reason: rule <file> — <the rule>". ' +
  'A model without a reason, or a quote the user did not say, is refused; never carry a model over from an earlier task. A standing pin the user set ("앞으로 솔로") is applied for you. ' +
  'Write the Agent description as the task alone, with no model or effort in front. If an attempt failed, say so when delegating again. ' +
  'A brief states the scope, what must not be touched, the done criteria and how to verify them. Read the report for whether it did what was asked before using it. ' +
  'Continue a worker with SendMessage only within 5 minutes of its last reply; later start a new one with a summary of what is done and what is left.'

/** The tier markers the session writes on a ripple:auto prompt, as the verdict they stand for (`rungOf` gives the rung). */
export const TIER_MARKERS: Readonly<Record<string, Pick<WorkerVerdict, 'level' | 'kind'>>> = {
  light: { level: 'light', kind: 'do' },
  standard: { level: 'standard', kind: 'do' },
  hard: { level: 'deep', kind: 'do' },
  max: { level: 'deep', kind: 'plan' },
}
/** The tier a marker names, if it is one. */
export function tierOf(marker: { name: string } | null): string | null {
  return marker && Object.hasOwn(TIER_MARKERS, marker.name) ? marker.name : null
}

export function readMarker(prompt: string): { name: string; level?: string; domain?: string } | null {
  const marker = MARKER.exec(prompt)
  return marker ? { name: marker[1]!.toLowerCase(), ...(marker[2] ? { level: marker[2].toLowerCase() } : {}), ...(marker[3] ? { domain: marker[3].toLowerCase() } : {}) } : null
}

/** The line that says where a named model comes from: the user's words for this task, or a written rule. */
const REASON = /^[ \t]*model reason[ \t]*:[ \t]*(user|rule)\b[ \t]*(.*)$/im
export type ModelReason = { source: 'user' | 'rule'; text: string; quote?: string }
export function modelReason(prompt: string): ModelReason | null {
  const line = REASON.exec(prompt)
  if (!line) return null
  const text = line[2]!.trim()
  const pair = /"([^"]+)"|“([^”]+)”|「([^」]+)」|『([^』]+)』/.exec(text)
  const quote = pair?.slice(1).find(Boolean)?.trim()
  return { source: line[1]!.toLowerCase() as ModelReason['source'], text, ...(quote ? { quote } : {}) }
}
/**
 * A rule reason's minimal form: a concrete file identifier first and a non-empty rule after it
 * ("memory/translation.md — draft translations run on Opus"). It reads the line's shape only —
 * never whether the file exists or what it says. An empty "Model reason: rule" used to pass and
 * named a model with no source at all (2026-10-25).
 */
export function ruleReason(text: string): boolean {
  const trimmed = text.trim()
  const at = trimmed.search(/\s/)
  if (at <= 0) return false
  const file = trimmed.slice(0, at).replace(/[,;]+$/, '')
  // A path segment or an extension: "memory/x.md", "docs/specs/a.md", "C:\rules\x.md".
  if (!/[/\\]|\.[A-Za-z0-9]{1,8}$/.test(file)) return false
  // " — ", " - ", ": " or a plain space; the rule itself must hold something.
  return trimmed.slice(at).replace(/^\s*[—–:,-]\s*/, '').trim().length > 0
}
/** A prompt without its model-reason line, which is for the mod only. */
export function withoutReason(prompt: string): string {
  return prompt.replace(new RegExp(REASON.source + '\\n?', 'gim'), '').replace(/^\s*\n/, '')
}
/** The prompt a routed worker reads: no routing marker, no model-reason line. */
export function withoutRouting(prompt: string): string {
  return withoutReason(prompt.replace(new RegExp(MARKER.source, 'gi'), ''))
}
/**
 * Whether the user said these words: whitespace and case aside, inside one of their own messages.
 * A check of the session's claim, not a reading of what the user meant; a word or two ("솔") could
 * be found anywhere, so a quote is at least three letters.
 */
export function userSaid(quote: string, words: readonly string[]): boolean {
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()
  const wanted = flat(quote)
  return wanted.replace(/ /g, '').length >= 3 && words.some(text => flat(text).includes(wanted))
}

/** The domain a tier marker names, as the verdict domain its ladder reads. No word: general. */
export function markerDomain(word: string | undefined): Domain {
  return word === 'ui' || word === 'frontend' ? 'frontend' : word === 'design' ? 'design' : word === 'backend' || word === 'server' ? 'backend' : 'general'
}
export function agentProvider(agentFileText: string): string | undefined {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(agentFileText)?.[1]
  const description = head && /^description:\s*(.*)$/m.exec(head)?.[1]
  return description ? /\bvia\s+([A-Za-z0-9_-]+)\./.exec(description)?.[1]?.toLowerCase() : undefined
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
const baseModel = (model: string): string => model.replace(/@[^@]*$/, '')

/** Unknown availability is not exhaustion; known accounts must pass every quota window. */
export function chatgptUsable(status: unknown): boolean {
  const accounts = record(record(record(status).chatgpt).accounts).chatgpt
  if (!Array.isArray(accounts)) return true
  return accounts.some(value => {
    const account = record(value)
    if (account.state !== 'ready' || account.paused || account.needsReauth) return false
    const limits = record(record(account.quota).rate_limits)
    return ['primary', 'secondary'].every(name => {
      const window = record(limits[name])
      return typeof window.used_percent !== 'number' || window.used_percent < 100
    })
  })
}
/** Config is the router's catalogue, including native Anthropic declarations. Never retain headers. */
export function routerModelOptions(config: unknown): RouterModel[] {
  const out: RouterModel[] = []
  for (const [provider, value] of Object.entries(record(record(config).providers))) {
    for (const model of list(record(value).models)) {
      const { id, name } = record(model)
      if (typeof id === 'string' && id) out.push({ value: id, label: `${id} · ${provider}`, provider, ...(typeof name === 'string' && name.trim() ? { name } : {}) })
    }
  }
  const counts = new Map<string, number>()
  for (const model of out) counts.set(model.value, (counts.get(model.value) ?? 0) + 1)
  return out.map(model => counts.get(model.value)! > 1 ? { ...model, value: `${model.provider}:${model.value}` } : model)
}
export function zenJev(config: unknown): { authorization?: string; model: string } {
  const provider = record(record(record(config).providers)['opencode-zen'])
  const key = record(provider.headers).authorization
  const model = list(provider.models).map(m => record(m).id).find(id => typeof id === 'string' && id.toLowerCase().includes('jev'))
  return { ...(typeof key === 'string' && key.trim() ? { authorization: key } : {}), model: typeof model === 'string' ? model : 'jev-latest' }
}
/** Validate HTTP score data at the boundary; malformed entries are not selectable measurements. */
export function scoreModels(raw: unknown): ModelScore[] {
  return list(record(raw).models).flatMap(value => {
    const model = record(value)
    if (typeof model.model !== 'string' || typeof model.provider !== 'string') return []
    const variants = list(model.variants).flatMap(v => {
      const variant = record(v)
      if (variant.effort !== null && !EFFORTS.includes(variant.effort as Effort)) return []
      const valid = (n: unknown): n is number | null => n === null || typeof n === 'number' && Number.isFinite(n) && n >= 0
      if (!valid(variant.intelligence) || !valid(variant.costPerTask)) return []
      return [{ effort: variant.effort as Effort | null, intelligence: variant.intelligence, costPerTask: variant.costPerTask }]
    })
    return [{ model: model.model, provider: model.provider, variants }]
  })
}
/**
 * Allow-lists name worker agents, and Claude's own models as `general-purpose:<model>`; provider
 * names from settings saved before 2026-10-10 still match.
 */
export function allowed(candidate: WorkerCandidate, allow: readonly string[], known: readonly string[] = []): boolean {
  return isAllowed(candidateKey(candidate.target), candidate.provider, allow, known)
}
/** Claude's own models as candidates: general-purpose on each. */
export function claudeCandidates(): WorkerCandidate[] {
  return CLAUDE_WORKERS.map(w => ({ target: { ...w.target }, model: w.model, provider: w.provider }))
}
const BILLINGS: readonly Billing[] = ['free', 'payg', 'subscription']
/**
 * The router's rung choices (GET /api/mod-options), validated at the boundary: its workers whose
 * provider can run now, with ladders, billing and cheapest measured cost, then Claude's own
 * models; only the ticked ones (`allow`, empty for every model).
 */
export function ladderOptionsFrom(raw: unknown, until: number, allow: readonly string[] = [], allowKnown: readonly string[] = []): LadderOptions {
  const root = record(raw)
  const efforts = (value: unknown): Effort[] => list(value).filter((e): e is Effort => EFFORTS.includes(e as Effort))
  const usable = new Set(list(root.providers).flatMap(p => { const v = record(p); return typeof v.name === 'string' && v.usable !== false ? [v.name] : [] }))
  const modelsOut = new Map(list(root.providers).flatMap(p => { const v = record(p); return typeof v.name === 'string' ? [[v.name, unavailableModels(v.models)] as const] : [] }))
  const catalogue = list(root.providers).length > 0
  const scores = scoreModels(root.scores)
  const choices: LadderChoice[] = list(root.agents).flatMap(value => {
    const a = record(value)
    if (typeof a.name !== 'string' || !a.name || typeof a.model !== 'string' || typeof a.provider !== 'string') return []
    if (catalogue && !usable.has(a.provider)) return []
    if (modelsOut.get(a.provider)?.[baseModel(a.model)]) return []
    const costs = (scores.find(s => s.model === a.model && s.provider === a.provider)?.variants ?? []).flatMap(v => v.costPerTask === null ? [] : [v.costPerTask])
    const billing = BILLINGS.includes(a.billing as Billing) ? a.billing as Billing : 'payg'
    return [{ target: { agent: a.name }, model: a.model, provider: a.provider, billing, efforts: efforts(a.efforts), ...(costs.length ? { cost: Math.min(...costs) } : {}) }]
  })
  const providers = Object.fromEntries(list(root.providers).flatMap(value => {
    const p = record(value)
    if (typeof p.name !== 'string' || typeof p.usable !== 'boolean') return []
    const models = unavailableModels(p.models)
    return [[p.name, { usable: p.usable, ...(typeof p.reason === 'string' ? { reason: p.reason } : {}), ...(typeof p.exhaustedUntil === 'number' ? { exhaustedUntil: p.exhaustedUntil } : {}), ...(Object.keys(models).length ? { models } : {}) }]]
  }))
  return { until, choices: tickedChoices([...choices, ...claudeChoices(efforts(root.claudeEfforts))], allow, allowKnown), providers }
}
/**
 * A provider's models that are out while it answers others (GET /api/mod-options `models`): a spent
 * Antigravity quota group takes its own models out, not the provider's other ones.
 */
function unavailableModels(value: unknown): NonNullable<ProviderAvailability['models']> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([model, entry]) => {
    const e = record(entry)
    if (!model || entry === null || typeof entry !== 'object') return []
    return [[model, { ...(typeof e.reason === 'string' ? { reason: e.reason } : {}), ...(typeof e.exhaustedUntil === 'number' ? { exhaustedUntil: e.exhaustedUntil } : {}) }]]
  }))
}
/** Drop availability entries whose stated reset has passed: a cached catalogue must not outlive them. */
export function liveProviders(providers: NonNullable<LadderOptions['providers']>, now: number): NonNullable<LadderOptions['providers']> {
  return Object.fromEntries(Object.entries(providers).flatMap(([name, p]) => {
    const models = Object.fromEntries(Object.entries(p.models ?? {}).filter(([, m]) => m.exhaustedUntil === undefined || m.exhaustedUntil > now))
    const expired = p.exhaustedUntil !== undefined && p.exhaustedUntil <= now
    // A provider-wide exhaustion that has reset drops the provider entry, but not a model still out.
    if (expired && !Object.keys(models).length) return []
    const { models: _, ...rest } = p
    const base: ProviderAvailability = expired ? { usable: true } : rest
    return [[name, Object.keys(models).length ? { ...base, models } : base]]
  }))
}
/** A model out while its provider answers others (a spent quota group), by its id without `@effort`. */
function modelOut(candidate: WorkerCandidate, providers: NonNullable<LadderOptions['providers']>): boolean {
  return !!providers[candidate.provider]?.models?.[providerModelId(candidate.model, candidate.provider)]
}
export function candidateUsable(candidate: WorkerCandidate, settings: Settings, chatgpt: boolean, providers: NonNullable<LadderOptions['providers']> = {}): boolean {
  const live = providers[candidate.provider]
  if (modelOut(candidate, providers)) return false
  return settings.providers[candidate.provider] !== false && (live ? live.usable : candidate.provider !== 'chatgpt' || chatgpt)
}
function unavailableReason(provider: string, providers: NonNullable<LadderOptions['providers']>, lang: Lang, model?: string): string {
  const reason = model ? providers[provider]?.models?.[providerModelId(model, provider)]?.reason : providers[provider]?.reason
  if (!reason && provider === 'chatgpt') return t(lang, 'toasts.providerQuota')
  const labels: Record<string, string> = lang === 'ko'
    ? { insufficient_balance: '잔액 부족', billing_exhausted: '결제 한도 소진', quota_exhausted: '사용량 한도 소진' }
    : { insufficient_balance: 'insufficient balance', billing_exhausted: 'billing exhausted', quota_exhausted: 'quota exhausted' }
  return `${provider}: ${reason === 'model_deprecated' ? reason : reason && labels[reason] || (lang === 'ko' ? '현재 사용 불가' : 'currently unavailable')}`
}
function sameTarget(a: TierTarget, b: TierTarget): boolean { return a.agent === b.agent && a.model === b.model }
function candidateOf(target: TierTarget, candidates: readonly WorkerCandidate[]): WorkerCandidate | undefined {
  return candidates.find(c => sameTarget(c.target, target)) ?? (target.agent === 'general-purpose' ? { target, model: target.model ?? 'sonnet', provider: candidates.find(c => c.model === baseModel(target.model ?? 'sonnet'))?.provider ?? 'anthropic' } : undefined)
}
/** Domain overrides belong to the effective worker set; a missing override uses its general ladder. */
export function workerRule(domain: Domain, settings: Settings): { rule: WorkerPick['rule']; ladder: Rule } {
  const key = domain === 'design' || domain === 'frontend' ? 'ui' : domain === 'backend' ? 'backend' : 'general'
  const ladder = key === 'general' ? undefined : settings.domainRules?.[key]
  return ladder ? { rule: key, ladder } : { rule: 'general', ladder: settings.rules.general }
}

export type Resolution = { target?: TierTarget; effort: Effort; rung?: Rung; position?: number; skipped?: { rung: Rung; position: number; model: string; reason: string }[]; fallbackReason?: string }

/**
 * The ladder: the verdict's rung, else one rung up, never down. Whatever ran instead says why (the
 * fallback toast). With nothing on either rung usable there is no target: the session's own model
 * used to run it, an Opus the owner had put on no rung and was there to save (2026-10-24).
 */
export function ladderPick(verdict: WorkerVerdict, rule: Rule, settings: Settings, candidates: readonly WorkerCandidate[], chatgpt: boolean, lang: Lang, allow: readonly string[] = [], providers: NonNullable<LadderOptions['providers']> = {}, known: readonly string[] = []): Resolution {
  const wanted = rungOf(verdict)
  const skipped: NonNullable<Resolution['skipped']> = []
  const reasons: string[] = []
  for (const rung of [wanted, rungAbove(wanted)]) {
    if (!rung) continue
    const steps = rule.rungs[rung] ?? []
    if (!steps.length) reasons.push(t(lang, 'workers.rungEmpty', { rung: t(lang, 'workers.rung.' + rung) }))
    for (const [index, step] of steps.entries()) {
      const target = step.target
      const candidate = candidateOf(target, candidates)
      const ticked = target.agent === 'general-purpose' && !target.model || candidate && allowed(candidate, allow, known)
      if (candidate && candidateUsable(candidate, settings, chatgpt, providers) && ticked) {
        return { target: { ...target }, effort: step.effort, rung, position: index + 1, skipped, ...(reasons.length ? { fallbackReason: reasons.join('; ') } : {}) }
      }
      const reason = !candidate ? t(lang, 'toasts.workerMissing', { name: target.agent }) : settings.providers[candidate.provider] === false ? t(lang, 'workers.disabled', { provider: candidate.provider }) : !ticked ? t(lang, 'workers.notCandidate', { name: candidate.model }) : providers[candidate.provider]?.usable === false ? unavailableReason(candidate.provider, providers, lang) : modelOut(candidate, providers) ? unavailableReason(candidate.provider, providers, lang, candidate.model) : t(lang, 'toasts.providerQuota')
      const model = candidate?.model ?? target.model ?? target.agent
      skipped.push({ rung, position: index + 1, model, reason })
      reasons.push(`${model}: ${reason}`)
    }
  }
  const effort = rule.rungs[wanted]?.[0]?.effort ?? verdict.effort
  return { effort, rung: wanted, skipped, fallbackReason: reasons.join('; ') || t(lang, 'workers.none') }
}

/** Only allowed, installed entries after this pick in the same tier. Availability is rechecked by the router. */
export function ladderFallbackModels(rule: Rule, pick: Resolution, candidates: readonly WorkerCandidate[], settings: Settings): string[] {
  if (!pick.rung || !pick.position) return []
  return (rule.rungs[pick.rung] ?? []).slice(pick.position).flatMap(step => {
    const candidate = candidateOf(step.target, candidates)
    if (!candidate || settings.providers[candidate.provider] === false || !allowed(candidate, settings.allow, settings.allowKnown)) return []
    return [`${baseModel(candidate.model)}@${step.effort}`]
  })
}

/** Resolve only native family aliases; explicit versions, custom ids and inheritance stay intact. */
export function resolveClaudeModel(model: string | undefined): string | undefined {
  if (!model) return model
  const alias = baseModel(model).replace(/\[1m\]$/, '')
  const worker = CLAUDE_WORKERS.find(w => w.target.model === alias)
  return worker ? worker.model + model.slice(alias.length) : model
}

export function spawnModel(target: TierTarget, effort: Effort, fileModel?: string): string | undefined {
  return resolveClaudeModel(fileModel && target.agent !== 'general-purpose' ? `${baseModel(fileModel)}@${effort}` : target.model)
}
/** A prefix this mod (or the retired agent-title hook) put on a title: "Sol·high · ". */
const TITLE_PREFIX = /^[^\s·]+(?:·[a-z]+)? · /

/**
 * The model a title names: a Claude id or alias as its family and version ("Opus5.5"), a routed id
 * as its configured name's last word ("GPT-6.1 Sol" → "Sol"), else a gpt-* id's last part, else
 * the id.
 */
export function titleName(model: string, models: readonly RouterModel[] = []): string {
  const id = baseModel(model).replace(/\[.*?\]/g, '')
  const claude = /^(?:claude-)?(opus|sonnet|haiku|fable|mythos)(?:-(\d+)(?:-(\d{1,2}))?)?/i.exec(id)
  if (claude) return claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1).toLowerCase() + (claude[2] ? claude[2] + (claude[3] ? '.' + claude[3] : '') : '')
  // A hosted id's vendor path ("deepseek-ai/") is dropped: the title has room for the model only.
  const named = models.find(m => m.value.toLowerCase() === id.toLowerCase())?.name
  if (named) return named.trim().split(/\s+/).pop()!.replace(/^.*\//, '')
  const gpt = /^gpt-[\d.]+-([a-z]+)$/i.exec(id)
  return gpt ? gpt[1]!.charAt(0).toUpperCase() + gpt[1]!.slice(1) : id.replace(/^.*\//, '')
}

/**
 * The background-task title with the model that really runs it in front: "Sol·medium · Fix X".
 * The app names only Claude models, and for a routed one shows the parent's; the mod is the one
 * that knows, since it picks. A prefix already there (the parent's guess) is replaced.
 */
export function spawnTitle(description: string, model: string, effort: string | undefined, models: readonly RouterModel[] = []): string {
  const tag = titleName(model, models) + (effort ? '·' + effort : '')
  return `${tag} · ${bareTitle(description)}`
}

/** A title without the model tag spawnTitle put in front ("Sol·high · Port it" → "Port it"). */
export function bareTitle(description: string): string {
  const bare = description.replace(TITLE_PREFIX, '')
  return bare.trim() ? bare : description
}

/** Claude Code owns these agents and their read-only/tool constraints (2026-10-24). */
export const NATIVE_AGENTS: readonly string[] = ['statusline-setup', 'claude-code-guide', 'Explore', 'Plan']

export function takesOver(spawn: { subagentType: string; model?: string; fork: boolean }, settings: Settings): boolean {
  if (spawn.fork || settings.agentAuto === 'off') return false
  if (['ripple:auto', 'auto'].includes(spawn.subagentType)) return true
  // A project agent's pinned model must not bypass the ladder either (2026-10-24, opus-xhigh).
  return settings.agentAuto === 'all' && !spawn.subagentType.includes(':') && !NATIVE_AGENTS.includes(spawn.subagentType)
}
