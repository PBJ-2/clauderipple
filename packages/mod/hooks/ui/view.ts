// What the drawings take: view models register.tsx fills from the mod's state atoms, and the
// callbacks it hands in. Every renderer in ./ is a pure function of (elements, view, actions);
// none of them calls the engine, so they can be drawn and tested anywhere.

import type { AgentRec, BgTask, Effort, JudgeKind, JudgeRun, LadderOptions, LimitItem, Pick as EffortPick, Settings, Skin, StatusRequest, TierTarget } from '../../types'
import type { Appearance } from './theme'
import { t } from '../i18n'
import { DISPLAY, displayText } from './display'
import type { Lang } from '../i18n'

export type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'

/** Where and how big: from `e.surface`, `e.props.bodyColumns` / `maxRows`, the clock and settings. */
export type Frame = {
  surface: Surface
  /** Cells across (`bodyColumns`). */
  columns: number
  /** Rows the band may take (`maxRows`); a pane passes its `scroll.bodyRows`. */
  maxRows: number
  /** A pane's first row in view (`scroll.offset`); the engine asks again when the person scrolls. */
  offset?: number
  /** Epoch ms when drawn; countdowns are computed from it. */
  now: number
  appearance: Appearance
  /** The desktop's skin (look.ts); the terminal draws text whatever it is. */
  skin: Skin
  lang: Lang
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
    /** Who gave it. */
    by?: EffortPick['by']
    /** When the judge started (deciding): keeps the glow's phase across redraws. */
    since?: number
  }
  /** Display name of the main chat's model ("Opus 5.5"); see modelName. */
  model: string | null
  context: { percent: number; tokens: number; window: number } | null
  /** The last main reply's cache; null when unknown. */
  cache: { expiresAt: number; ttlMs: number } | null
  /** `here`: this chat differs from Settings, set by the band's flame. */
  warm: { on: boolean; pings: number; cost: number; stopped?: string; here?: boolean }
  /** The hottest plan window, shown when present. */
  limit: { kind: string; percent: number; resetsAt?: string; save: boolean } | null
  /** Every plan window for the second row, Claude's own first. Absent until read. */
  limits?: LimitItem[]
  route: RouteView | null
  /** A line from the router side ("router not answering"), shown in place of the route. */
  notice: string | null
  auto: boolean
  agents: { live: number; total: number }
  /** Times this chat was compacted (manual, automatic or by the band), shown on the Compact icon. */
  compactions: number
  logOpen: boolean
  agentsOpen: boolean
  /** The manual effort row is open. */
  effortMenu: boolean
  /** Band parts switched off: 'timer' | 'reason' | 'route'. */
  hide: readonly string[]
  /** Optional chips switched on: 'context' | 'limits'. */
  extras: readonly string[]
  isWorking: boolean
  /** The active operating mode's name; absent when none is on. */
  mode?: string
  /** Short name of this session's user-pinned delegation model. */
  delegationPin?: string
  /** The person's own sentence that pinned it, already cut short. */
  delegationSaid?: string
}

export type BandActions = {
  toggleAuto: () => void
  toggleWarm: () => void
  compact: () => void
  clear: () => void
  /** Has the session's model write a handoff and opens a new session in this folder with it. */
  handoff: () => void
  toggleLog: () => void
  toggleAgents: () => void
  openSettings: () => void
  /** Opens or closes the manual effort row. */
  toggleEffortMenu: () => void
  /** A manual pick: Auto steps aside for it (spec §1 "Person wins"). */
  pickEffort: (effort: Effort) => void
  /** Hides the band (desktop: its × is drawn inside the band). */
  hide?: () => void
  /** Releases the session-only delegation pin. */
  releaseDelegationPin?: () => void
  /** Opens or closes the Context pane (desktop: the context chip is its press). */
  toggleContext?: () => void
  /** Opens or closes the limits pane (desktop: the limits row is its press). */
  toggleLimits?: () => void
}

// ---- Alerts and cards ------------------------------------------------------------------------

export type ResultStage = 'tidying' | 'handingOff' | 'handoffDone' | 'compacting' | 'compacted' | 'failed'

export type AlertView =
  /** The cache expired on a big chat: the next prompt re-reads it all. */
  | { kind: 'cold'; tokens: number; idleMinutes: number }
  /** Keep-warm held the cache while the person was away. */
  | { kind: 'kept'; pings: number; tokens: number; minutesLeft: number }
  /** Context is heavy. */
  | { kind: 'swamp'; percent: number; tokens: number }
  /** A plan window at or above 80%. */
  | { kind: 'hot'; limitKind: string; percent: number; resetsAt?: string; save: boolean }
  /** The judge failed and Auto fell back. */
  | { kind: 'judgeDown'; judge: JudgeKind; reason: string; network?: boolean }
  | { kind: 'result'; stage: ResultStage; detail?: string }
  /** Compact with an optional note of what to keep, and whether the chat tidies up first. */
  | { kind: 'compactNote'; draft: string; tidy: boolean; pick: string; models: { value: string; label: string }[]; cold: boolean }
  /** The band's Clear asks before the conversation is started over. */
  | { kind: 'clear' }

export type AlertActions = {
  compact: (note?: string) => void
  /** Runs the conversation's clear, from the Clear confirm card. */
  clear: () => void
  dismiss: () => void
  toggleSave: () => void
  openSettings: () => void
  /** Each change of the compact note's field. */
  noteInput: (text: string) => void
  /** The compact card's "tidy up first" switch; the last choice is kept. */
  toggleTidy: () => void
  pickCompactModel: (value: string) => void
  /** Copies a written handoff again (its done card). */
  copy: () => void
}

// ---- Settings and setup ----------------------------------------------------------------------

export type JevState = {
  /** Where the key comes from; null when there is none. */
  source: 'env' | 'file' | 'pasted' | 'zen' | null
  test: { state: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }
}

export type SettingsView = {
  settings: Settings
  jev: JevState
  /** What each rung can run (the ticked models); null until the router has answered. */
  ladder?: LadderOptions | null
}

export type SettingsActions = {
  /** Applies and saves each change immediately. */
  patch: (change: Partial<Settings>) => void
  /** Turns a mode on by id, or every mode off with ''. */
  setMode?: (id: string) => void
  /** The Jev key typed into the field (Enter). */
  jevKey: (key: string) => void
  testJev: () => void
  openAllSettings: () => void
  close: () => void
}

export type SetupStep = 1 | 2 | 3 | 4

export type SetupView = {
  step: SetupStep
  draft: Settings
  jev: JevState
}

export type SetupActions = {
  patch: (change: Partial<Settings>) => void
  jevKey: (key: string) => void
  testJev: () => void
  openAllSettings: () => void
  back: () => void
  next: () => void
  /** Saves the draft with setupDone and closes. */
  finish: () => void
  /** Closes with the defaults, setupDone. */
  skip: () => void
}

// ---- Panes -----------------------------------------------------------------------------------

/** One entry of an agent's conversation as the pane draws it (agents.tsx `talkOf`). */
export type AgentEntry =
  /** What it was asked: its first prompt, or a later message sent to it. */
  | { kind: 'prompt'; text: string; receipt?: number }
  /** Its own words. */
  | { kind: 'text'; text: string }
  /** A tool it called: the tool, a short line of its input, how it stands, and an edit's lines added and removed. */
  | { kind: 'tool'; id: string; tool: string; detail: string; state: 'running' | 'ok' | 'error'; added?: number; removed?: number }

/** An agent's conversation as read (`$.session.messages({ agentId })`), or why it could not be. */
export type AgentTalk = { entries: readonly AgentEntry[] } | { deny: string }

export type AgentsView = {
  agents: readonly AgentRec[]
  /** Commands and watches left running in the background, listed with the agents (tasks.ts). */
  tasks?: readonly BgTask[]
  now: number
  /** Every finished agent, not only the latest few. */
  showDone: boolean
  /**
   * The agent whose conversation is open, what of it was read, and what is unfolded: runs of calls
   * by their first call's id, long prompts by `prompt:<n>` (agents.tsx).
   */
  open?: { id: string; talk: AgentTalk; runsOpen?: readonly string[] }
}

export type AgentsActions = {
  toggleDone: () => void
  /** Opens an agent's conversation in the pane. */
  open: (id: string) => void
  /** Back to the list. */
  back: () => void
  /** Folds or unfolds a run of tool calls, named by its first call's id, or a long prompt (`prompt:<n>`). */
  toggleRun: (id: string) => void
}

export type LogView = {
  rows: readonly StatusRequest[]
  mineOnly: boolean
  /** This session's verdicts, listed among its requests. */
  judges?: readonly JudgeRun[]
}

export type LogActions = {
  toggleScope: () => void
}

/** The limits pane: every plan window the router answered, grouped by provider account. */
export type LimitsView = {
  items: readonly LimitItem[]
  /** Save mode holds Auto down until then (epoch ms); absent while it is off. */
  saveUntil?: number
}

export type LimitsActions = {
  close: () => void
}

// ---- Helpers register.tsx and the drawings share ----------------------------------------------

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function effortIndex(effort: Effort | null | undefined): number {
  return effort ? EFFORTS.indexOf(effort) : -1
}

export function effortName(effort: Effort, lang: Lang): string {
  return t(lang, 'band.' + effort)
}

/** Route records can contain unknown effort ids; translate only the known display values. */
export function effortLabel(value: string, lang: Lang): string {
  return EFFORTS.includes(value as Effort) ? effortName(value as Effort, lang).toLowerCase() : displayText(value, DISPLAY.name)
}

/** "claude-opus-5-5[1m]" → "Opus 5.5"; ids it does not know pass through, trimmed. */
export function modelName(id: string): string {
  const bare = displayText(id, DISPLAY.name).replace(/\[.*?\]/g, '').replace(/^claude-/, '')
  const m = /^(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?/.exec(bare)
  if (m) return m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '')
  // A bare alias ("sonnet") reads as its family's name.
  if (/^(opus|sonnet|haiku|fable|mythos)\b/.test(bare) && !bare.includes('-')) return bare.charAt(0).toUpperCase() + bare.slice(1)
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

/**
 * A target as a person reads it: the model for Claude's own agents, else the agent; Claude's agent
 * with no model runs on the session's model and says so.
 */
export function targetLabel(target: TierTarget, lang?: Lang): string {
  if (target.model) return 'Claude ' + modelName(target.model)
  return lang && target.agent === 'general-purpose' ? t(lang, 'workers.sessionModel') : displayText(target.agent, DISPLAY.name)
}

type Usage = NonNullable<StatusRequest['usage']>

export function promptTokens(usage: Usage): number {
  return usage.input + usage.cached + (usage.cacheWrite ?? 0)
}

/**
 * The share of a prompt the cache served, in percent.
 *
 * Rounded down: a request always carries some uncached input (or a cache write), so a whole 100%
 * cannot happen, yet rounding turned 99.96% into 100% on the Agents card (2026-10-25). The log
 * pane and the band's route read the same figure.
 */
export function cachePercent(usage: Usage | undefined): number | undefined {
  if (!usage) return undefined
  const prompt = promptTokens(usage)
  return prompt > 0 ? Math.floor((usage.cached / prompt) * 100) : undefined
}

// The requested name's `@effort` is the agent file's default, not what was sent; the sent effort is
// its own field.
export function modelOf(record: StatusRequest): string {
  const at = record.source.lastIndexOf('@')
  const source = at < 0 ? record.source : record.source.slice(0, at)
  // A hosted id's vendor path ("deepseek-ai/") goes, as on the agent cards: the slot is narrow and
  // the provider is named beside it.
  const bare = (id: string) => id.replace(/^.*\//, '')
  // A dated id of the same model (claude-haiku-5-5-20260815 for claude-haiku-5-5) says nothing new.
  return displayText(source.startsWith(record.target) || record.target.startsWith(source) ? bare(record.target) : bare(record.target) + ' (' + bare(source) + ')', DISPLAY.name)
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
export function countdown(ms: number, lang: Lang): string {
  if (ms <= 0) return t(lang, 'band.cold')
  const s = Math.ceil(ms / 1000)
  if (s >= 120) return t(lang, 'units.minutes', { n: Math.ceil(s / 60) })
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

/**
 * The cache countdown as the band and the footer show it: whole minutes rounded up ("42m" … "1m"),
 * "cold" at zero. It changes once a minute, so the band redraws at most once a minute for it.
 */
export function minutesLeft(ms: number, lang: Lang): string {
  if (ms <= 0) return t(lang, 'band.cold')
  return t(lang, 'units.minutes', { n: Math.ceil(ms / 60_000) })
}

/** When minutesLeft next changes for a cache expiring at `expiresAt` (epoch ms); null once cold. */
export function nextMinuteChange(expiresAt: number, now: number): number | null {
  const left = expiresAt - now
  if (left <= 0) return null
  return expiresAt - (Math.ceil(left / 60_000) - 1) * 60_000
}

/** A duration the Agents pane shows: "12s", "4m 05s", "1h 02m". */
export function elapsed(ms: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return t(lang, 'units.seconds', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t(lang, 'units.minSec', { m, s: String(s % 60).padStart(2, '0') })
  return t(lang, 'units.hourMin', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') })
}

/** Seconds with one decimal, as routes and log entries show them: "1.2s". */
export function seconds(value: number, lang: Lang): string {
  return t(lang, 'units.seconds', { n: value.toFixed(1) })
}

export function clockTime(at: string | number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

/** "resets 14:20" or "resets in 3h" from an ISO time. */
export function resetsLabel(resetsAt: string | undefined, now: number, lang: Lang): string | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return undefined
  const left = at - now
  if (left <= 0) return t(lang, 'band.resetting')
  if (left < 3_600_000) return t(lang, 'band.resetsIn', { time: t(lang, 'units.minutes', { n: Math.max(1, Math.round(left / 60_000)) }) })
  if (left < 86_400_000) {
    const d = new Date(at)
    return t(lang, 'band.resetsAt', { time: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') })
  }
  return t(lang, 'band.resetsIn', { time: t(lang, 'units.days', { n: Math.round(left / 86_400_000) }) })
}

/** Short weekday names by `Date#getDay()`, Sunday first. */
const WEEKDAYS = ['units.weekdaySun', 'units.weekdayMon', 'units.weekdayTue', 'units.weekdayWed', 'units.weekdayThu', 'units.weekdayFri', 'units.weekdaySat'] as const

/** A weekday's short name in the person's language: "Thu", "목". */
function weekdayName(day: number, lang: Lang): string {
  return t(lang, WEEKDAYS[((day % 7) + 7) % 7]!)
}

/** A reset this close reads as the time left; further off, as the weekday and the clock. */
const RESET_NEAR_MS = 20 * 3_600_000

/**
 * A moment as the limits pane names it, in local time to the minute with its date and weekday:
 * "10월 30일 (목) 오후 3:35", "Thu, Oct 30, 3:35 PM", "jue 30 oct, 15:35". A language keeps its
 * own clock (`units.clockHours`: 12 with its morning and afternoon words, or 24).
 */
export function resetMoment(at: number, lang: Lang): string {
  const d = new Date(at)
  const hours = d.getHours()
  const mm = String(d.getMinutes()).padStart(2, '0')
  const twelve = t(lang, 'units.clockHours') === '12'
  const time = t(lang, hours < 12 ? 'units.am' : 'units.pm', { time: (twelve ? String(hours % 12 || 12) : String(hours).padStart(2, '0')) + ':' + mm })
  return t(lang, 'limits.date', { month: t(lang, 'units.month' + (d.getMonth() + 1)), day: d.getDate(), weekday: weekdayName(d.getDay(), lang), time })
}

/**
 * The time from now to a reset: to the minute under a day ("4시간 12분", "35분"), to the hour past
 * one ("2일 5시간"). Counted up to the next whole minute, so a reset 30 seconds off still reads
 * "1분" until it passes.
 */
export function timeLeft(ms: number, lang: Lang): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? t(lang, 'units.dayHour', { d: days, h: hours }) : t(lang, 'units.days', { n: days })
  if (hours > 0) return rest > 0 ? t(lang, 'units.hourMin', { h: hours, m: rest }) : t(lang, 'units.hours', { n: hours })
  return t(lang, 'units.minutes', { n: rest })
}

/**
 * A reset as a short detail reads it: "2시간 뒤" while the window is close, else the weekday and
 * the local time ("목 09:00"), "초기화 중" once it has passed. The hover tips keep the whole
 * sentence (`resetsLabel`); the limits pane names the moment whole (`resetMoment`). Twenty hours is
 * where the router's own status label (`limitLabel` in session.ts) stops naming the clock and
 * names the day.
 */
export function resetShort(resetsAt: string | undefined, now: number, lang: Lang): string | undefined {
  if (!resetsAt) return undefined
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return undefined
  const left = at - now
  if (left <= 0) return t(lang, 'band.resetting')
  if (left < RESET_NEAR_MS) {
    const minutes = Math.max(1, Math.round(left / 60_000))
    return t(lang, 'band.resetIn', { time: minutes < 60 ? t(lang, 'units.minutes', { n: minutes }) : t(lang, 'units.hours', { n: Math.round(minutes / 60) }) })
  }
  return t(lang, 'band.resetDay', { day: weekdayName(new Date(at).getDay(), lang), time: clockTime(at).slice(0, 5) })
}

/** "five_hour" → "5-hour", "seven_day" → "Weekly". */
export function limitName(kind: string, lang: Lang): string {
  if (kind === 'five_hour') return t(lang, 'band.fiveHour')
  if (kind === 'seven_day') return t(lang, 'band.weekly')
  return displayText(kind.replace(/_/g, ' '), DISPLAY.name)
}

// ---- Limits row ----------------------------------------------------------------------------------

/** A plan window's short name as the limits row shows it: the window, or the model's own name. */
export function limitItemName(item: Pick<LimitItem, 'kind' | 'label' | 'windowMinutes'>, lang: Lang): string {
  if (item.kind === 'five_hour' || item.kind === 'seven_day') return limitName(item.kind, lang)
  if (item.kind === 'scoped') return displayText(item.label || item.kind, DISPLAY.name)
  const minutes = item.windowMinutes
  if (minutes === 300) return limitName('five_hour', lang)
  if (minutes === 10080) return limitName('seven_day', lang)
  if (typeof minutes === 'number' && minutes > 0) {
    if (minutes % 1440 === 0) return t(lang, 'units.days', { n: minutes / 1440 })
    if (minutes % 60 === 0) return t(lang, 'units.hours', { n: minutes / 60 })
    return t(lang, 'units.minutes', { n: minutes })
  }
  return displayText(item.label || item.kind.replace(/_/g, ' '), DISPLAY.name)
}

/**
 * One limits group as the row heads it: a provider's own, or one of its accounts ("GPT", "GPT 1", …),
 * with the account's label and in-use mark when the router gave them.
 */
export type LimitGroup = { key: string; provider: string; type?: string; title?: string; account: number; accountLabel?: string; inUse?: true; items: LimitItem[] }

/** Whether a group is Claude's own plan. */
const isClaude = (g: Pick<LimitGroup, 'provider' | 'type'>): boolean => g.type === 'anthropic' || g.provider === 'claude'

/**
 * The groups the row draws, one per provider account, Claude's plan first (the row keeps it to the
 * last when narrow) and otherwise the router's answer order. Each window's item is unchanged.
 */
export function limitGroups(items: readonly LimitItem[]): LimitGroup[] {
  const groups: LimitGroup[] = []
  const index = new Map<string, LimitGroup>()
  for (const item of items) {
    const key = item.provider + '#' + item.account
    let group = index.get(key)
    if (!group) {
      group = {
        key,
        provider: item.provider,
        ...(item.type ? { type: item.type } : {}),
        ...(item.title ? { title: item.title } : {}),
        account: item.account,
        ...(item.accountLabel ? { accountLabel: item.accountLabel } : {}),
        ...(item.inUse ? { inUse: true as const } : {}),
        items: [],
      }
      index.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  // Claude's own plan comes first however the router ordered it; a stable sort keeps the rest.
  const rank = (g: LimitGroup) => (isClaude(g) ? 0 : 1)
  return groups.sort((a, b) => rank(a) - rank(b))
}

/**
 * The groups the band's limits row draws: of Claude's accounts only the one the router serves new
 * turns with (the first when none is marked: an older router, or the in-use account's usage not
 * known yet), so the narrow row reads one "Claude" as it always has; the pane lists them all
 * (2026-11-04). Every other provider's accounts pass as they are.
 */
export function bandLimitGroups(groups: readonly LimitGroup[]): LimitGroup[] {
  const kept = new Map<string, LimitGroup>()
  for (const g of groups) {
    if (!isClaude(g)) continue
    const held = kept.get(g.provider)
    if (!held || (g.inUse && !held.inUse)) kept.set(g.provider, g)
  }
  return groups.filter(g => !isClaude(g) || kept.get(g.provider) === g)
}

/**
 * The generic name the router gives an account the owner never named ("Claude account 2", "ChatGPT
 * account"): it says nothing the number does not, so the pane leaves it out.
 */
const PLACEHOLDER_LABEL = /^(?:Claude|ChatGPT|Google) account(?: \d+)?$/i

/** The most of an account's label the pane shows, in UTF-16 units (displayText adds "…"). */
const ACCOUNT_LABEL_MAX = 24

/**
 * An account's label as the pane shows it beside the group's name: an email's local part
 * ("work@example.com" → "work"), anything else as given, cut short; '' for none or a placeholder.
 */
export function limitAccountLabel(label: string | undefined): string {
  const clean = displayText(label ?? '', DISPLAY.name).trim()
  if (!clean || PLACEHOLDER_LABEL.test(clean)) return ''
  const at = clean.indexOf('@')
  return displayText(at > 0 ? clean.slice(0, at) : clean, ACCOUNT_LABEL_MAX)
}

/**
 * What the pane says after a numbered group's name: `tag`, "사용 중" on the account the router serves
 * new turns with, set apart right after the name (a badge on the desktop, in brackets on the
 * terminal) and never cut; then `label`, the account's own name short and dim, which is cut first
 * when room runs out. Both empty for a provider with one account, which reads as it always has.
 */
export function limitGroupAccount(group: Pick<LimitGroup, 'accountLabel' | 'inUse'>, numbered: boolean, lang: Lang): { tag: string; label: string } {
  if (!numbered) return { tag: '', label: '' }
  return { tag: group.inUse ? t(lang, 'limits.inUse') : '', label: limitAccountLabel(group.accountLabel) }
}

/** The head's name when the item carries none: from its kind, else its config name. */
function groupTitle(group: Pick<LimitGroup, 'provider' | 'type' | 'title'>): string {
  if (group.title) return group.title
  if (isClaude(group)) return 'Claude'
  if (group.type === 'chatgpt' || group.provider === 'chatgpt') return 'GPT'
  if (group.type === 'google') return 'Gemini'
  return group.provider
}

/** A group's head: "Claude", "GPT", "Gemini", or its config name; "GPT 1"/"GPT 2" when numbered. */
export function limitGroupName(group: Pick<LimitGroup, 'provider' | 'type' | 'title' | 'account'>, numbered: boolean): string {
  const title = displayText(groupTitle(group), DISPLAY.name)
  return numbered ? title + ' ' + (group.account + 1) : title
}

/**
 * Which groups carry their account's number: a provider with more than one account ("GPT 1",
 * "GPT 2"). Decided on the whole set the router answered, before any narrowing, so the number is
 * the account's own and holds even when only one of them is drawn.
 */
export function limitGroupNumbered(groups: readonly LimitGroup[]): (group: LimitGroup) => boolean {
  const accounts = new Map<string, number>()
  for (const group of groups) accounts.set(group.provider, (accounts.get(group.provider) ?? 0) + 1)
  return group => (accounts.get(group.provider) ?? 1) > 1
}

/**
 * The groups that fit `budget`, narrowing in this order: the scoped windows (Fable, 3P, …) go
 * first, one group's at a time from the last group back, so Claude's own Fable is the last of them
 * to go (all of them going at once hid Fable for Gemini's two 3P windows, 2026-10-15); then a later
 * provider's secondary accounts (the last one first), then a later provider's whole group —
 * Claude's own group (the first) stays to the last, even when it is a stored account (account 1…)
 * the row shows for being in use. Null when even that does not fit (no row).
 * `width` measures a set of groups the way the row draws it.
 */
export function narrowLimitGroups(groups: readonly LimitGroup[], budget: number, width: (gs: readonly LimitGroup[]) => number): LimitGroup[] | null {
  let out = [...groups]
  for (let i = out.length - 1; i >= 0 && width(out) > budget; i--) {
    if (!out[i]!.items.some(item => item.kind === 'scoped')) continue
    out = out.map((g, j) => j === i ? { ...g, items: g.items.filter(item => item.kind !== 'scoped') } : g).filter(g => g.items.length > 0)
  }
  const secondary = (g: LimitGroup, i: number) => i > 0 && g.account > 0
  while (width(out) > budget && out.some(secondary)) {
    const at = out.map(secondary).lastIndexOf(true)
    out = out.filter((_, i) => i !== at)
  }
  while (width(out) > budget && out.length > 1) out = out.slice(0, -1)
  if (!out.length || width(out) > budget) return null
  return out
}

/** A window's hover tip: "Claude 주간 88% · 4시간 뒤 초기화". */
export function limitItemTip(item: LimitItem, group: string, lang: Lang, now: number): string {
  const reset = resetsLabel(item.resetsAt, now, lang)
  return t(lang, 'band.limitsTip', { provider: group, window: limitItemName(item, lang), value: Math.round(item.percent) + '%', reset: reset ? ' · ' + reset : '' })
}
