import type { Calibration, Domain, DomainRules, Effort, Level, Mode, Rule, Rung, Settings, SettingsChange, Skin, Step, TierTarget } from '../types/index.d.ts'

/**
 * Bump whenever a writer's normalization can lose another format's fields. 2: `domainRules.review`,
 * which a version-1 mod drops on its next save.
 */
export const MOD_SETTINGS_SCHEMA_VERSION = 2

export const DOMAINS: readonly Domain[] = ['general', 'design', 'frontend', 'backend', 'infra', 'data', 'test', 'docs', 'research']
export const LEVELS: readonly Level[] = ['light', 'standard', 'deep']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** The worker ladder, bottom to top (docs/specs/2026-10-11-worker-ladder.md). */
export const RUNGS: readonly Rung[] = ['light', 'standard', 'hard', 'plan']
/** The rung each judged level lands on before kind and confidence move it. */
export const LEVEL_RUNG: Readonly<Record<Level, Rung>> = { light: 'light', standard: 'standard', deep: 'hard' }
/** A rung's effort when nothing else says one: a stored rung without one, a migrated pin. */
export const RUNG_EFFORT: Readonly<Record<Rung, Effort>> = { light: 'low', standard: 'medium', hard: 'high', plan: 'high' }

const claude = (model: string, effort: Effort): Step => ({ target: { agent: 'general-purpose', model }, effort })

export const DEFAULTS: Settings = {
  effortAuto: true, judge: 'haiku', judgeModel: 'deepseek-v4.1-flash', jevSource: 'typesafe',
  bias: 0, floor: 'low', ceiling: 'max', agentAuto: 'auto',
  rules: {
    // The spec's "Claude + GPT" example; a rung whose worker is missing moves up and says so.
    // Only the general rule: the four workers replaced the per-field rules (2026-10-12).
    general: { mode: 'ladder', rungs: {
      light: [{ target: { agent: 'deepseek-v4-1-flash' }, effort: 'max' }], standard: [{ target: { agent: 'gpt-6-1-sol' }, effort: 'medium' }],
      hard: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }], plan: [claude('opus', 'high')],
    } },
  },
  allow: [], allowKnown: [], modes: [], delegation: 'normal',
  providers: {},
  fallback: { agent: 'general-purpose', model: 'sonnet' },
  keepWarm: false, keepWarmHours: 2, keepWarmMinTokens: 30000,
  compactModel: 'claude-haiku-5-5', compactModels: [],
  swampAlert: false, layout: 'dashboard', appearance: 'auto', skin: 'deep', language: 'auto', hide: ['reason'], extras: [], setupDone: false,
}

/** The desktop's skins, in the order the panel offers them. */
export const SKINS: readonly Skin[] = ['deep', 'flat']

/** Band chips that show only when switched on in Look. */
export const EXTRAS: readonly string[] = ['context', 'limits']

/**
 * Claude's own models as workers: the built-in general-purpose agent run on the model, `model` its
 * current id. The key is what the allow-list stores. Mythos is not here: the Agent tool's `model`
 * takes only sonnet, opus, haiku and fable (Claude Code 2.1.295, read 2026-10-14), so a
 * general-purpose worker on it would be refused.
 */
export const CLAUDE_WORKERS: readonly { name: string; model: string; provider: string; target: TierTarget }[] = [
  { name: 'general-purpose:haiku', model: 'claude-haiku-5-5', provider: 'anthropic', target: { agent: 'general-purpose', model: 'haiku' } },
  { name: 'general-purpose:sonnet', model: 'claude-sonnet-5-5', provider: 'anthropic', target: { agent: 'general-purpose', model: 'sonnet' } },
  { name: 'general-purpose:opus', model: 'claude-opus-5-5', provider: 'anthropic', target: { agent: 'general-purpose', model: 'opus' } },
  { name: 'general-purpose:fable', model: 'claude-fable-5-1', provider: 'anthropic', target: { agent: 'general-purpose', model: 'fable' } },
]

/** The allow-list key of a target: the agent's name, or `general-purpose:<model>` for Claude's own. */
export function candidateKey(target: TierTarget): string {
  return target.model ? target.agent + ':' + target.model : target.agent
}

function object(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
}
function names(raw: unknown): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim()))] : []
}
function target(raw: unknown, fallback?: TierTarget): TierTarget | undefined {
  const value = object(raw)
  const agent = typeof value.agent === 'string' && value.agent.trim() ? value.agent.trim() : fallback?.agent
  const model = typeof value.model === 'string' && value.model.trim() ? value.model.trim() : fallback?.model
  return agent ? { agent, ...(model ? { model } : {}) } : undefined
}
function calibration(value: Record<string, unknown>): Calibration {
  const out: Calibration = {}
  if ([-2, -1, 0, 1, 2].includes(Number(value.effortOffset)) && typeof value.effortOffset === 'number') out.effortOffset = value.effortOffset as NonNullable<Calibration['effortOffset']>
  for (const field of ['floor', 'ceiling'] as const) if (EFFORTS.includes(value[field] as Effort)) out[field] = value[field] as Effort
  return out
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
function sameTarget(a: TierTarget | undefined, b: TierTarget | undefined): boolean {
  return !!a && !!b && a.agent === b.agent && a.model === b.model
}
/** An effort moved by calibration steps, then held between floor and ceiling (the floor wins). */
function calibrated(effort: Effort, cal: Calibration): Effort {
  const min = EFFORTS.indexOf(cal.floor ?? 'low')
  const max = Math.max(min, EFFORTS.indexOf(cal.ceiling ?? 'max'))
  const shifted = Math.max(0, Math.min(4, EFFORTS.indexOf(effort) + (cal.effortOffset ?? 0)))
  return EFFORTS[Math.max(min, Math.min(max, shifted))]!
}
/** One effort step up, max staying max. */
export function effortUp(effort: Effort): Effort {
  return EFFORTS[Math.min(4, EFFORTS.indexOf(effort) + 1)]!
}
function step(raw: unknown, rung: Rung): Step | undefined {
  const v = object(raw)
  const chosen = target(v.target)
  if (!chosen) return undefined
  // A rung's backup model is dropped on load: the four workers have none (the next one up stands in).
  return { target: chosen, effort: EFFORTS.includes(v.effort as Effort) ? v.effort as Effort : RUNG_EFFORT[rung] }
}
/** The effort a migrated rung starts at: the default ladder's when it runs the same model there. */
function migratedEffort(rung: Rung, chosen: TierTarget): Effort {
  const own = DEFAULTS.rules.general.rungs[rung]?.[0]
  return own && sameTarget(own.target, chosen) ? own.effort : RUNG_EFFORT[rung]
}
/**
 * A pin stored before 2026-10-11 as a ladder: light/standard/deep become Light/Standard/Hard, a
 * missing level takes the nearest one above (as the pin climbed) or else below, each rung's effort
 * is its default calibrated as the pin was, and Plan is Hard's model one effort higher.
 */
export function ladderFromPin(targets: Partial<Record<Level, TierTarget>>, cal: Calibration): Rule {
  const known = LEVELS.filter(level => targets[level])
  if (!known.length) return copy(DEFAULTS.rules.general)
  const rungs: Partial<Record<Rung, Step>> = {}
  LEVELS.forEach((level, at) => {
    const above = LEVELS.slice(at).find(l => targets[l])
    const chosen = targets[above ?? [...LEVELS.slice(0, at)].reverse().find(l => targets[l])!]!
    const rung = LEVEL_RUNG[level]
    rungs[rung] = { target: { ...chosen }, effort: calibrated(migratedEffort(rung, chosen), cal) }
  })
  rungs.plan = { target: { ...rungs.hard!.target }, effort: effortUp(rungs.hard!.effort) }
  return { mode: 'ladder', rungs: ladderRungs(rungs) }
}
/** Single steps from older saves become one-item lists; malformed items are dropped in place. */
function ladderRungs(raw: unknown): Rule['rungs'] {
  const source = object(raw)
  const rungs: Rule['rungs'] = {}
  for (const rung of RUNGS) {
    const items = Array.isArray(source[rung]) ? source[rung] : [source[rung]]
    const parsed = items.flatMap(item => { const value = step(item, rung); return value ? [value] : [] })
    if (parsed.length) rungs[rung] = parsed
  }
  return rungs
}
/**
 * A domain ladder folded into two levels: light work is the light and standard rungs, heavy work
 * hard and plan, by difficulty as the owner sets the two rows (2026-10-24). From 2026-10-22 to
 * 10-24 standard sat in the heavy row, because the worker judge read ordinary design as standard
 * and the owner wanted design on Opus; the judge is gone, and design now names Opus itself with a
 * written rule (memory design-work-opus-only), so a standard UI or backend task no longer runs on
 * the heavy model. Light reads its own rung, else standard's; heavy reads plan, else hard, else
 * standard, else light, so one filled row still runs everything and a ladder stored by the old
 * split reads right. The general ladder keeps its four rungs.
 */
export function twoLevelRungs(rungs: Rule['rungs']): Rule['rungs'] {
  const out: Rule['rungs'] = {}
  const light = rungs.light?.length ? rungs.light : rungs.standard
  const heavy = [rungs.plan, rungs.hard, rungs.standard, rungs.light].find(list => list?.length)
  if (light?.length) { out.light = copy(light); out.standard = copy(light) }
  if (heavy?.length) { out.hard = copy(heavy); out.plan = copy(heavy) }
  return out
}
/**
 * The one rule left, the general ladder (the four workers). A ladder keeps its rungs; a pin from
 * before the ladder becomes one; Auto (experimental, removed 2026-10-12) becomes a ladder with no
 * rungs set, which the router fills from the ticked models (`fillLadder`). Field rules are gone.
 */
function generalRule(raw: unknown): Rule {
  const v = object(raw)
  if (v.mode === 'ladder') return { mode: 'ladder', rungs: ladderRungs(v.rungs) }
  if (v.mode === 'auto') return { mode: 'ladder', rungs: {} }
  if (v.mode === 'pin') {
    const source = object(v.targets)
    const targets: Partial<Record<Level, TierTarget>> = {}
    for (const level of LEVELS) { const parsed = target(source[level]); if (parsed) targets[level] = parsed }
    return ladderFromPin(targets, calibration(v))
  }
  return copy(DEFAULTS.rules.general)
}

/** Only optional domain ladders, never the retired per-field pin/Auto rules. */
function domainRules(raw: unknown): DomainRules | undefined {
  const source = object(raw)
  const out: DomainRules = {}
  for (const key of ['ui', 'backend', 'review'] as const) {
    // A domain ladder has two levels, so its four rungs are folded on the way in.
    if (object(source[key]).mode === 'ladder') out[key] = { mode: 'ladder', rungs: twoLevelRungs(generalRule(source[key]).rungs) }
  }
  return Object.keys(out).length ? out : undefined
}

type Worker = { name: string; provider: string }

/**
 * Auto's allow-list names worker agents. Settings saved before 2026-10-10 named providers there;
 * with the worker list known, a provider name becomes that provider's workers (names it does not
 * know are kept: a worker may be missing only for now).
 */
export function migrateAllow(allow: readonly string[], workers: readonly Worker[]): string[] {
  const agents = new Set(workers.map(w => w.name))
  return [...new Set(allow.flatMap(entry => agents.has(entry) || !workers.some(w => w.provider === entry) ? [entry] : workers.filter(w => w.provider === entry).map(w => w.name)))]
}

/** The workers switched on by an allow-list; empty means every worker. A worker that did not exist when the list was last written (absent from `known`) counts as on. */
export function allowedWorkers(allow: readonly string[], workers: readonly Worker[], known: readonly string[] = []): string[] {
  if (!allow.length) return workers.map(w => w.name)
  const on = new Set(migrateAllow(allow, workers))
  return workers.filter(w => on.has(w.name) || known.length > 0 && !known.includes(w.name)).map(w => w.name)
}

/** Switches one worker; every worker on again is stored as [], and the last one cannot go off. `known` is the allow-list keys the writer knew. */
export function toggleAllow(allow: readonly string[], name: string, workers: readonly Worker[], known: readonly string[] = []): string[] {
  const on = allowedWorkers(allow, workers, known)
  const next = on.includes(name) ? on.filter(n => n !== name) : workers.filter(w => w.name === name || on.includes(w.name)).map(w => w.name)
  if (!next.length) return [...allow]
  return next.length === workers.length ? [] : next
}

/**
 * Whether a stored model is ticked: its key (an agent name, or `general-purpose:<model>`) or, for
 * settings from before 2026-10-10, its provider is listed; an empty list ticks every model. A key
 * absent from a non-empty `known` list (a worker added after the list was last written) ticks on.
 */
export function isAllowed(key: string, provider: string, allow: readonly string[], known: readonly string[] = []): boolean {
  return !allow.length || allow.includes(key) || allow.includes(provider) || known.length > 0 && !known.includes(key)
}

/** The design ladder every save stored until 2026-10-12: Claude, Sonnet then Opus. */
const RETIRED_DESIGN = JSON.stringify([claude('sonnet', 'medium'), claude('sonnet', 'high'), claude('opus', 'high'), claude('opus', 'high')].map(s => [s.target.agent, s.target.model, s.effort]))

/**
 * Whether stored settings still carry what the four workers replaced: Auto (experimental), or a
 * field rule that is not the design ladder every save used to store. The dashboard says so once.
 */
export function hadRetiredRouting(raw: unknown): boolean {
  const rules = object(object(raw).rules)
  if (object(rules.general).mode === 'auto') return true
  return DOMAINS.some(domain => {
    if (domain === 'general') return false
    const stored = object(rules[domain])
    if (stored.mode === undefined || stored.mode === 'inherit') return false
    if (domain !== 'design' || stored.mode !== 'ladder') return true
    const rungs = ladderRungs(stored.rungs)
    return JSON.stringify(RUNGS.map(rung => { const s = rungs[rung]?.[0]; return s ? [s.target.agent, s.target.model, s.effort] : null })) !== RETIRED_DESIGN
  })
}

/** How long a mode's name may be: it shows in the band. */
export const MODE_NAME_MAX = 40
/** How many modes are kept. */
export const MODES_MAX = 20

/** How long a mode's reset provider name may be. */
const PROVIDER_NAME_MAX = 64

/**
 * A mode's end: a time, one provider's next quota reset, or none. Until 2026-10-12 `'reset'` meant
 * any used provider's; it becomes the first that could have offered it, ChatGPT then Claude. Settings
 * do not carry a worker's provider, and ChatGPT is the only worker provider with a known reset, so
 * any worker that is not Claude's own stands for ChatGPT.
 */
function modeUntil(raw: unknown, rungs: Rule['rungs']): Mode['until'] {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : 'none'
  if (raw === 'reset') return { reset: Object.values(rungs).some(steps => steps?.some(step => step.target.agent !== 'general-purpose')) ? 'chatgpt' : 'anthropic' }
  const reset = object(raw).reset
  return typeof reset === 'string' && reset.trim() ? { reset: reset.trim().slice(0, PROVIDER_NAME_MAX) } : 'none'
}

/**
 * Saved worker sets. Old prefer/avoid modes copy the base ladder on load, dropping their policy.
 * Every entry owns its lists: later base edits cannot mutate a saved mode.
 */
export function normalizeModes(raw: unknown, base: Rule['rungs'] = DEFAULTS.rules.general.rungs): Mode[] {
  if (!Array.isArray(raw)) return []
  const out: Mode[] = []
  for (const entry of raw) {
    const v = object(entry)
    const id = typeof v.id === 'string' ? v.id.trim().slice(0, 64) : ''
    const name = typeof v.name === 'string' ? v.name.trim().slice(0, MODE_NAME_MAX) : ''
    if (!id || !name || out.some(m => m.id === id)) continue
    const rungs = ladderRungs(v.rungs === undefined ? base : v.rungs)
    const domains = domainRules(v.domainRules)
    out.push({ id, name, rungs, ...(domains ? { domainRules: domains } : {}), delegation: v.delegation === 'eager' ? 'eager' : 'normal', until: modeUntil(v.until, rungs) })
    if (out.length === MODES_MAX) break
  }
  return out
}

/** The general pin every install had before the ladder: what stored `tiers` filled in. */
const LEGACY_GENERAL: Readonly<Record<Level, TierTarget>> = { light: { agent: 'deepseek-v4-1-flash' }, standard: { agent: 'gpt-6-1-sol' }, deep: { agent: 'gpt-6-astra' } }

/**
 * Persisted settings may be old; migrate tiers and pins once and never alias nested default data.
 * Only the general ladder survives: Auto becomes a ladder with no rungs set (its candidates become
 * the ticked models); field rules and Auto's own fields (preference, autoFloors, autoTieBand) are
 * dropped. With `workers`, provider names in an allow-list become those providers' workers.
 */
export function normalizeSettings(raw: unknown, workers?: readonly Worker[]): Settings {
  const value = object(raw)
  const stored = object(value.rules)
  const rules: Settings['rules'] = { general: generalRule(stored.general) }
  const old = object(value.tiers)
  if (!Object.hasOwn(stored, 'general') && Object.keys(old).length) {
    const targets: Partial<Record<Level, TierTarget>> = copy(LEGACY_GENERAL)
    for (const level of LEVELS) { const parsed = target(old[level]); if (parsed) targets[level] = parsed }
    rules.general = ladderFromPin(targets, {})
  }
  const ticked = names(Array.isArray(value.allow) ? value.allow : object(stored.general).mode === 'auto' ? object(stored.general).allow : [])
  const savedKnown = names(value.allowKnown)
  const result: Settings = { ...DEFAULTS, rules, allow: workers?.length ? migrateAllow(ticked, workers) : ticked, allowKnown: savedKnown, providers: {}, hide: [...DEFAULTS.hide], extras: [...DEFAULTS.extras], fallback: { ...DEFAULTS.fallback } }
  for (const [name, enabled] of Object.entries(object(value.providers))) if (typeof enabled === 'boolean') result.providers[name] = enabled
  for (const key of ['effortAuto', 'keepWarm', 'setupDone', 'swampAlert'] as const) if (typeof value[key] === 'boolean') result[key] = value[key]
  if (Array.isArray(value.extras)) result.extras = [...new Set(value.extras.filter((part): part is string => typeof part === 'string' && EXTRAS.includes(part)))]
  const choices = {
    judge: ['haiku', 'jev', 'model'], jevSource: ['typesafe', 'zen'], bias: [-2, -1, 0, 1, 2], floor: EFFORTS,
    delegation: ['normal', 'eager'],
    ceiling: EFFORTS, agentAuto: ['off', 'auto', 'all'], keepWarmHours: [1, 2, 4, 8],
    layout: ['dashboard', 'minimal'],
    appearance: ['auto', 'dark', 'light'], skin: SKINS, language: ['auto', 'ko', 'en', 'zh', 'ja', 'es', 'pt'],
  } as const
  for (const key of Object.keys(choices) as (keyof typeof choices)[]) if ((choices[key] as readonly unknown[]).includes(value[key])) Object.assign(result, { [key]: value[key] })
  if (typeof value.judgeModel === 'string' && value.judgeModel.trim()) result.judgeModel = value.judgeModel.trim()
  if (typeof value.keepWarmMinTokens === 'number' && Number.isFinite(value.keepWarmMinTokens) && value.keepWarmMinTokens >= 0) result.keepWarmMinTokens = value.keepWarmMinTokens
  // `compactWith: 'haiku' | 'session'` was the whole choice. A stored model id wins; otherwise the
  // old choice (or anything unknown) reads as Haiku, the default it always meant.
  if (typeof value.compactModel === 'string' && value.compactModel.trim()) result.compactModel = value.compactModel.trim()
  else if (value.compactWith === 'session') result.compactModel = 'session'
  result.compactModels = names(value.compactModels).slice(0, 4)
  if (Array.isArray(value.hide)) result.hide = [...new Set(value.hide.filter((part): part is string => typeof part === 'string' && ['timer', 'reason', 'route', 'limits'].includes(part)))]
  result.fallback = target(value.fallback, DEFAULTS.fallback)!
  const domains = domainRules(value.domainRules)
  if (domains) result.domainRules = domains
  result.modes = normalizeModes(value.modes, rules.general.rungs)
  // An active mode must be one of the modes; its start time stays only with it.
  if (typeof value.activeMode === 'string' && result.modes.some(m => m.id === value.activeMode)) {
    result.activeMode = value.activeMode
    if (typeof value.activeSince === 'number' && Number.isFinite(value.activeSince) && value.activeSince > 0) result.activeSince = value.activeSince
  }
  return result
}

/** Preserve unrelated remote edits, including sibling domains and provider switches. */
export function settingsChanges(before: Settings, after: Settings): SettingsChange[] {
  function diff(a: unknown, b: unknown, path: string[]): SettingsChange[] {
    if (JSON.stringify(a) === JSON.stringify(b)) return []
    if (b === undefined) return [{ path, remove: true }]
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const left = object(a), right = object(b)
      // Changing a discriminated rule replaces it, rather than retaining the old mode's fields.
      if (left.mode === right.mode) return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => diff(left[key], right[key], [...path, key]))
    }
    return [{ path, value: b }]
  }
  return diff(before, after, [])
}

export function applySettingsChanges(base: Settings, changes: readonly SettingsChange[]): Settings {
  const result = object(normalizeSettings(base))
  for (const change of changes) {
    let parent = result
    for (const key of change.path.slice(0, -1)) {
      const child = object(parent[key])
      parent[key] = child
      parent = child
    }
    const key = change.path.at(-1)
    if (key === undefined) continue
    if (change.remove) delete parent[key]
    else parent[key] = change.value
  }
  return normalizeSettings(result)
}
