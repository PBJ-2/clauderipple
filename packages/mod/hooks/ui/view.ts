// What the drawings take: view models register.tsx fills from the mod's state atoms, and the
// callbacks it hands in. Every renderer in ./ is a pure function of (elements, view, actions);
// none of them calls the engine, so they can be drawn and tested anywhere.

import type { AgentRec, Effort, HandoffKind, JudgeKind, Settings, StatusRequest, Tier, TierTarget } from '../../types'
import type { Appearance } from './theme'

export type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'

/** Where and how big: from `e.surface`, `e.props.bodyColumns` / `maxRows`, the clock and settings. */
export type Frame = {
  surface: Surface
  /** Cells across (`bodyColumns`). */
  columns: number
  /** Rows the band may take (`maxRows`); a pane passes its `scroll.bodyRows`. */
  maxRows: number
  /** Epoch ms when drawn; countdowns are computed from it. */
  now: number
  appearance: Appearance
}

/** Desktop and the editor draw SVG; the terminal and mobile draw text. */
export function isRich(frame: Frame): boolean {
  return frame.surface === 'desktop' || frame.surface === 'vscode'
}

// ---- Dashboard -------------------------------------------------------------------------------

/**
 * auto: Auto picked it · deciding: the judge is thinking · paused: Auto cannot run on this model ·
 * off: Auto is off (the level is the app's) · manual: the person picked the level.
 */
export type EffortMode = 'auto' | 'deciding' | 'paused' | 'off' | 'manual'

export type RouteView = {
  /** `target`, or `target (requested)` when the router swapped it. */
  model: string
  provider: string
  ok: boolean
  resent: boolean
  status: string
  effort?: string
  /** Prompt tokens read from cache, in percent. */
  cachePct?: number
  seconds: number
  note?: string
}

export type DashboardView = {
  effort: {
    level: Effort | null
    mode: EffortMode
    /** The judge's reason, a few words. */
    why?: string
    /** When the judge started (deciding): keeps the glow's phase across redraws. */
    since?: number
  }
  /** Display name of the main chat's model ("Opus 5.5"); see modelName. */
  model: string | null
  context: { percent: number; tokens: number; window: number } | null
  /** The last main reply's cache; null when unknown. */
  cache: { expiresAt: number; ttlMs: number } | null
  warm: { on: boolean; pings: number; cost: number; stopped?: string }
  /** The hottest plan window, shown when present. */
  limit: { kind: string; percent: number; resetsAt?: string; save: boolean } | null
  route: RouteView | null
  /** A line from the router side ("router not answering"), shown in place of the route. */
  notice: string | null
  auto: boolean
  /** Compact turns into a lit Handoff when advice says so, or always with handoffButton 'always'. */
  handoff: 'off' | 'advised' | 'always'
  agents: { live: number; total: number }
  logOpen: boolean
  agentsOpen: boolean
  /** The manual effort row is open. */
  effortMenu: boolean
  /** Context percent at which the swamp colour starts (settings.swampAt). */
  swampAt: number
  /** Band parts switched off: 'timer' | 'reason' | 'route' | 'limits'. */
  hide: readonly string[]
  isWorking: boolean
}

export type BandActions = {
  toggleAuto: () => void
  toggleWarm: () => void
  compact: () => void
  handoff: () => void
  toggleLog: () => void
  toggleAgents: () => void
  openSettings: () => void
  /** Opens or closes the manual effort row. */
  toggleEffortMenu: () => void
  /** A manual pick: Auto steps aside for it (spec §1 "Person wins"). */
  pickEffort: (effort: Effort) => void
}

// ---- Alerts and cards ------------------------------------------------------------------------

export type ResultStage = 'handingOff' | 'handoffDone' | 'compacting' | 'compacted' | 'failed'

export type AlertView =
  /** The cache expired on a big chat: the next prompt re-reads it all. */
  | { kind: 'cold'; tokens: number; idleMinutes: number }
  /** Context is heavy. */
  | { kind: 'swamp'; percent: number; tokens: number }
  /** A plan window at or above 80%. */
  | { kind: 'hot'; limitKind: string; percent: number; resetsAt?: string; save: boolean }
  /** The judge failed and Auto fell back. */
  | { kind: 'judgeDown'; judge: JudgeKind; reason: string }
  | { kind: 'result'; stage: ResultStage; handoffKind?: HandoffKind; detail?: string }
  /** Compact with an optional note of what to keep. */
  | { kind: 'compactNote'; draft: string }
  /** Quick or full handoff, and what happens after. */
  | { kind: 'handoffChoice'; handoffKind: HandoffKind; after: Settings['handoffAfter'] }

export type AlertActions = {
  compact: (note?: string) => void
  /** Opens the handoff choice bar. */
  handoff: () => void
  dismiss: () => void
  toggleSave: () => void
  openSettings: () => void
  /** Each change of the compact note's field. */
  noteInput: (text: string) => void
  setHandoffKind: (kind: HandoffKind) => void
  setHandoffAfter: (after: Settings['handoffAfter']) => void
  go: () => void
  /** Copies a handoff's text again (result card, after: copy). */
  copy: () => void
}

// ---- Settings and setup ----------------------------------------------------------------------

export type SettingsTab = 'effort' | 'workers' | 'judge' | 'cache' | 'handoff' | 'look'

/** An agent a tier can map to. `value` is a TierTarget encoded by targetValue. */
export type AgentOption = { value: string; label: string; available: boolean }

export type JevState = {
  /** Where the key comes from; null when there is none. */
  source: 'env' | 'file' | 'pasted' | null
  test: { state: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }
}

export type SettingsView = {
  tab: SettingsTab
  draft: Settings
  /** The draft differs from what is saved. */
  dirty: boolean
  agents: readonly AgentOption[]
  /** Router model ids the `model` judge can ask. */
  routerModels: readonly string[]
  /** Skills a full handoff can run. */
  skills: readonly string[]
  jev: JevState
}

export type SettingsActions = {
  setTab: (tab: SettingsTab) => void
  patch: (change: Partial<Settings>) => void
  setTier: (tier: Tier, target: TierTarget) => void
  setFallback: (target: TierTarget) => void
  /** The Jev key typed into the field (Enter). */
  jevKey: (key: string) => void
  testJev: () => void
  save: () => void
  /** Closes and drops the draft. */
  close: () => void
}

export type SetupStep = 1 | 2 | 3 | 4

export type SetupView = {
  step: SetupStep
  draft: Settings
  agents: readonly AgentOption[]
  routerModels: readonly string[]
  jev: JevState
}

export type SetupActions = {
  patch: (change: Partial<Settings>) => void
  setTier: (tier: Tier, target: TierTarget) => void
  jevKey: (key: string) => void
  testJev: () => void
  back: () => void
  next: () => void
  /** Saves the draft with setupDone and closes. */
  finish: () => void
  /** Closes with the defaults, setupDone. */
  skip: () => void
}

// ---- Panes -----------------------------------------------------------------------------------

export type AgentsView = {
  agents: readonly AgentRec[]
  now: number
  showDone: boolean
}

export type AgentsActions = {
  toggleDone: () => void
}

export type LogView = {
  rows: readonly StatusRequest[]
  mineOnly: boolean
}

export type LogActions = {
  toggleScope: () => void
}

// ---- Helpers register.tsx and the drawings share ----------------------------------------------

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const TIERS: readonly Tier[] = ['light', 'standard', 'deep', 'design']

export function effortIndex(effort: Effort | null | undefined): number {
  return effort ? EFFORTS.indexOf(effort) : -1
}

export function effortName(effort: Effort): string {
  return effort === 'xhigh' ? 'X-High' : effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** "claude-opus-5-5[1m]" → "Opus 5.5"; ids it does not know pass through, trimmed. */
export function modelName(id: string): string {
  const bare = id.replace(/\[.*?\]/g, '').replace(/^claude-/, '')
  const m = /^(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?/.exec(bare)
  if (m) return m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '')
  // A bare alias ("sonnet") reads as its family's name.
  if (/^(opus|sonnet|haiku|fable)\b/.test(bare) && !bare.includes('-')) return bare.charAt(0).toUpperCase() + bare.slice(1)
  return bare
}

/** A TierTarget as one Select value: `agent` or `agent+model`. */
export function targetValue(target: TierTarget): string {
  return target.model ? target.agent + '+' + target.model : target.agent
}

export function targetOf(value: string): TierTarget {
  const plus = value.indexOf('+')
  return plus < 0 ? { agent: value } : { agent: value.slice(0, plus), model: value.slice(plus + 1) }
}

/** A target as a person reads it: the model for Claude's own agents, else the agent. */
export function targetLabel(target: TierTarget): string {
  return target.model ? 'Claude ' + modelName(target.model) : target.agent
}

type Usage = NonNullable<StatusRequest['usage']>

export function promptTokens(usage: Usage): number {
  return usage.input + usage.cached + (usage.cacheWrite ?? 0)
}

export function cachePercent(usage: Usage | undefined): number | undefined {
  if (!usage) return undefined
  const prompt = promptTokens(usage)
  return prompt > 0 ? Math.round((usage.cached / prompt) * 100) : undefined
}

// The requested name's `@effort` is the agent file's default, not what was sent; the sent effort is
// its own field.
export function modelOf(record: StatusRequest): string {
  const at = record.source.lastIndexOf('@')
  const source = at < 0 ? record.source : record.source.slice(0, at)
  return source === record.target ? record.target : record.target + ' (' + source + ')'
}

export function routeOf(record: StatusRequest): RouteView {
  const route: RouteView = {
    model: modelOf(record),
    provider: record.provider,
    ok: record.ok,
    resent: record.resent === true,
    status: String(record.status),
    seconds: record.ms / 1000,
  }
  const cache = cachePercent(record.usage)
  if (record.effort) route.effort = record.effort
  if (cache !== undefined) route.cachePct = cache
  if (record.note) route.note = record.note
  return route
}

/** 1234 → "1.2k", 1_200_000 → "1.2M". */
export function compactNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return Math.round(n / 1000) + 'k'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(Math.round(n))
}

/** A countdown as the band shows it: "58m" above two minutes, "1:45" below, "cold" at zero. */
export function countdown(ms: number): string {
  if (ms <= 0) return 'cold'
  const s = Math.ceil(ms / 1000)
  if (s >= 120) return Math.ceil(s / 60) + 'm'
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

/** A duration the Agents pane shows: "12s", "4m 05s", "1h 02m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's'
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'
}

export function clockTime(at: string | number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

/** "resets 14:20" or "resets in 3h" from an ISO time. */
export function resetsLabel(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return undefined
  const left = at - now
  if (left <= 0) return 'resetting'
  if (left < 3_600_000) return 'resets in ' + Math.max(1, Math.round(left / 60_000)) + 'm'
  if (left < 86_400_000) {
    const d = new Date(at)
    return 'resets ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  return 'resets in ' + Math.round(left / 86_400_000) + 'd'
}

/** "five_hour" → "5-hour", "seven_day" → "Weekly". */
export function limitName(kind: string): string {
  if (kind === 'five_hour') return '5-hour'
  if (kind === 'seven_day') return 'Weekly'
  return kind.replace(/_/g, ' ')
}
