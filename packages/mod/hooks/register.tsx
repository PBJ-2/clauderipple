// Engine wiring lives here: imported logic and drawings never receive the engine interface.
// Timers own background work; hooks only admit/rewrite a request and record its result.
import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, ModelCompleteResult, ModelForkResult, Register, RenderElement, RenderInput, RenderNode, SessionCompactResult, SessionContextBreakdown, SessionContextUsage, SessionRateLimit, ToolCallInput, ToolCallResult, TurnStepInput, TurnUsage } from 'claude-code'
import type { AgentRec, CacheMemory, Effort, JudgeInput, JudgeKind, JudgeRun, LimitItem, ModSettingsSnapshot, Pick, Settings, StatusRequest, TierTarget, Verdict, WorkerCandidate, WorkerPick, WorkerVerdict } from '../types'
import { MOD_SETTINGS_SCHEMA_VERSION, RUNG_EFFORT, applySettingsChanges, normalizeSettings, settingsChanges } from './settings'
import { rungOf, workerLadderLine } from './ladder'
import { debugText, langFrom, t } from './i18n'
import type { Lang } from './i18n'
import { EFFORT_JUDGE_SYSTEM, finalEffort, isCacheSafeModel, jevEffortRequest, jevFailure, jevUsage, judgeContext, parseEffortVerdict, parseJevEffort, parseJevKey, shouldJudge } from './judge'
import { AUTO_DESCRIPTION, NATIVE_AGENTS, TIER_MARKERS, agentProvider, candidateUsable, chatgptUsable, claudeCandidates, ladderOptionsFrom, ladderFallbackModels, ladderPick, liveProviders, markerDomain, modelReason, readMarker, routerModelOptions, resolveClaudeModel, ruleReason, spawnModel, spawnTitle, titleName, takesOver, tierOf, userSaid, withoutReason, withoutRouting, workerRule, zenJev } from './workers'
import { MARKER, agentModel, delegationPin as parseDelegationPin, fixSpawn, humanText, pinInstruction, pinSaid } from './worker'
import { activeModeOf, chatgptProviders, claudeWindow, eagerNote, gptLimitsFrom, modeKey, modeOver, quotaWindows, resetProvider, routingSettings } from './modes'
import type { QuotaWindow } from './modes'
import type { Spawn, WorkerFix } from './worker'
import { afterPing, cacheMemoryKey, CACHE_MEMORY_PREFIX, laterMemo, liveContextTokens, nextMemo, restoreFromResume, savedMemory, shouldPing, staleMemory } from './cache'
import { HEAVY_PERCENT, bandPriority, claudeLimitsFrom, claudeScopedFrom, coldAlert, contextWindow, countsPrecisely, modelCompactWindow, hotAlert, hottest, hotWindowMoved, keptAlert, routerLimitItems, saveUntil as limitSaveUntil, swampAlert, swamped } from './session'
import type { ScopedLimit } from './session'
import { COMPACT_SYSTEM, compactResult, serializeTranscript } from './compact'
import { QUICK_PROMPT, wrapForNewChat } from './handoff'
import { addTask, endTasks, endWithAgent, settleTasks, stopTask, taskEnds, taskStarted } from './tasks'
import { addAgentStep, addJudge, addPrompt, addRequest, addWarm, addWorker, emptyStats, formatStats, sentEffort } from './stats'
import { besideBand, renderBand, renderFooter } from './ui/band'
import { renderAlert } from './ui/alerts'
import { PHONE_QUEUE_ROWS, renderPhoneQueue } from './ui/queue'
import { renderSettings } from './ui/settings'
import { renderSetup } from './ui/setup'
import { renderAgents, renderAgentsFallback, talkOf } from './ui/agents'
import { renderContext, renderContextFallback } from './ui/context'
import type { ContextActions } from './ui/context'
import { renderLimits, renderLimitsFallback } from './ui/limits'
import { toolDetail } from './ui/tools'
import { renderLog } from './ui/log'
import { displayText } from './ui/display'
import { EFFORTS, isRich, modelName, nextMinuteChange, routeOf, targetLabel } from './ui/view'
import type { AgentTalk, AgentsActions, AlertActions, AlertView, BandActions, DashboardView, Frame, LimitsActions, SettingsActions, SettingsView, SetupActions } from './ui/view'

const line = atom({ plugin: 'ripple', key: 'line' } as const, null)
const phoneQueue = atom({ plugin: 'ripple', key: 'phoneQueue' } as const, null)
const last = atom({ plugin: 'ripple', key: 'last' } as const, null)
const requests = atom({ plugin: 'ripple', key: 'requests' } as const, [])
const logOpen = atom({ plugin: 'ripple', key: 'logOpen' } as const, false)
const onlySession = atom({ plugin: 'ripple', key: 'onlySession' } as const, false)
const bandHidden = atom({ plugin: 'ripple', key: 'bandHidden' } as const, false)
const settings = atom({ plugin: 'ripple', key: 'settings' } as const, null)
const settingsSync = atom({ plugin: 'ripple', key: 'settingsSync' } as const, { schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, revision: null, pending: [], migrationChecked: false, migration: null })
const settingsBase = atom({ plugin: 'ripple', key: 'settingsBase' } as const, null)
const lang = atom({ plugin: 'ripple', key: 'lang' } as const, 'en')
const pick = atom({ plugin: 'ripple', key: 'pick' } as const, null)
const deciding = atom({ plugin: 'ripple', key: 'deciding' } as const, false)
const decidingSince = atom({ plugin: 'ripple', key: 'decidingSince' } as const, null)
const paused = atom({ plugin: 'ripple', key: 'paused' } as const, false)
const heldPick = atom({ plugin: 'ripple', key: 'heldPick' } as const, null)
const appEffort = atom({ plugin: 'ripple', key: 'appEffort' } as const, null)
const modelIs = atom({ plugin: 'ripple', key: 'modelIs' } as const, null)
const lastRequest = atom({ plugin: 'ripple', key: 'lastRequest' } as const, null)
const lastSpawn = atom({ plugin: 'ripple', key: 'lastSpawn' } as const, null)
const agents = atom({ plugin: 'ripple', key: 'agents' } as const, [])
/** Commands and watches left running in the background, listed in the Agents pane (tasks.ts). */
const bgTasks = atom({ plugin: 'ripple', key: 'bgTasks' } as const, [])
/** What the band shows of the agents (countAgents): it reads this, never the list above. */
const agentCounts = atom({ plugin: 'ripple', key: 'agentCounts' } as const, { live: 0, total: 0 })
const cache = atom({ plugin: 'ripple', key: 'cache' } as const, null)
const warm = atom({ plugin: 'ripple', key: 'warm' } as const, { pings: 0, cost: 0 })
const warmHere = atom({ plugin: 'ripple', key: 'warmHere' } as const, null)
const lastRealReplyAt = atom({ plugin: 'ripple', key: 'lastRealReplyAt' } as const, null)
const context = atom({ plugin: 'ripple', key: 'context' } as const, null)
/** Claude Code's own compaction point (settings.json `autoCompactWindow`), tokens or null. */
const compactAt = atom({ plugin: 'ripple', key: 'compactAt' } as const, null as number | null)
const hot = atom({ plugin: 'ripple', key: 'hot' } as const, null)
const limit = atom({ plugin: 'ripple', key: 'limit' } as const, null)
const limits = atom({ plugin: 'ripple', key: 'limits' } as const, null)
const hotHidden = atom({ plugin: 'ripple', key: 'hotHidden' } as const, null)
const hotHiddenFor = atom({ plugin: 'ripple', key: 'hotHiddenFor' } as const, null)
const saveUntil = atom({ plugin: 'ripple', key: 'saveUntil' } as const, null)
const swampHidden = atom({ plugin: 'ripple', key: 'swampHidden' } as const, null)
const coldHidden = atom({ plugin: 'ripple', key: 'coldHidden' } as const, false)
const kept = atom({ plugin: 'ripple', key: 'kept' } as const, null)
const judgeDown = atom({ plugin: 'ripple', key: 'judgeDown' } as const, null)
const judgeDownHidden = atom({ plugin: 'ripple', key: 'judgeDownHidden' } as const, null)
const judgeSeen = atom({ plugin: 'ripple', key: 'judgeSeen' } as const, [])
const judgeRuns = atom({ plugin: 'ripple', key: 'judgeRuns' } as const, [])
// The standing judge failure was a dropped connection or a timeout: the card blames the network, not the judge.
const judgeDownNetwork = atom({ plugin: 'ripple', key: 'judgeDownNetwork' } as const, false)
const handoff = atom({ plugin: 'ripple', key: 'handoff' } as const, null)
const handoffQueued = atom({ plugin: 'ripple', key: 'handoffQueued' } as const, false)
const resultCard = atom({ plugin: 'ripple', key: 'result' } as const, null)
const panel = atom({ plugin: 'ripple', key: 'panel' } as const, null)
const busy = atom({ plugin: 'ripple', key: 'busy' } as const, false)
const stats = atom({ plugin: 'ripple', key: 'stats' } as const, emptyStats())
const settingsDraft = atom({ plugin: 'ripple', key: 'settingsDraft' } as const, null)
const setupStep = atom({ plugin: 'ripple', key: 'setupStep' } as const, 1)
const compactNote = atom({ plugin: 'ripple', key: 'compactNote' } as const, '')
/** The compact card's tidy-up switch: on unless the person turned it off, and their last choice is kept. */
const compactTidy = atom({ plugin: 'ripple', key: 'compactTidy' } as const, true)
const effortMenuOpen = atom({ plugin: 'ripple', key: 'effortMenuOpen' } as const, false)
const agentsOpen = atom({ plugin: 'ripple', key: 'agentsOpen' } as const, false)
/** Compactions of the main conversation that finished, for the Compact icon's count; /clear zeroes it. */
const compactions = atom({ plugin: 'ripple', key: 'compactions' } as const, 0)
const agentsShowDone = atom({ plugin: 'ripple', key: 'agentsShowDone' } as const, false)
const agentOpen = atom({ plugin: 'ripple', key: 'agentOpen' } as const, null)
const agentRunsOpen = atom({ plugin: 'ripple', key: 'agentRunsOpen' } as const, [])
const agentsTick = atom({ plugin: 'ripple', key: 'agentsTick' } as const, 0)
const contextFull = atom({ plugin: 'ripple', key: 'contextFull' } as const, null)
const contextShowAll = atom({ plugin: 'ripple', key: 'contextShowAll' } as const, [])
/**
 * The person's last few prompts as submitted. One typed while a turn runs is absorbed into that turn
 * and never becomes a user message in `$.session.messages()`, so "솔한테 돌려" said mid-turn was not
 * heard and the worker went by tier (2026-10-23). A model reason's quote is looked for in these too.
 */
const heardPrompts = atom({ plugin: 'ripple', key: 'heardPrompts' } as const, [] as string[])
const delegationPin = atom({ plugin: 'ripple', key: 'delegationPin' } as const, null)
const jev = atom({ plugin: 'ripple', key: 'jev' } as const, { source: null, test: { state: 'idle' } })
const routerModels = atom({ plugin: 'ripple', key: 'routerModels' } as const, [])
const ladderOptions = atom({ plugin: 'ripple', key: 'ladderOptions' } as const, null)
const modeNoted = atom({ plugin: 'ripple', key: 'modeNoted' } as const, null)
const demo = atom({ plugin: 'ripple', key: 'demo' } as const, null)

/**
 * Whether a state write would change anything. A write redraws each reader, and a redraw that
 * hands the host new pictures reads as a blink (2026-10-10: the band flashed on polls and steps),
 * so the writes on every step and poll are skipped when they would store what is there. The
 * engine's scan wants each atom named at its read and update, hence a test rather than a wrapper.
 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const LOG_PANE = 'ripple-log'
const AGENTS_PANE = 'ripple-agents'
const CONTEXT_PANE = 'ripple-context'
const LIMITS_PANE = 'ripple-limits'
const HAIKU = 'claude-haiku-5-5'
const EXECUTOR = 'Do the assigned task yourself. Inspect the relevant files, implement what was asked, and verify the result. Report the outcome concisely, citing evidence and marking uncertainty. Never delegate to another agent. Do not create unrequested files or commit unless explicitly asked.'
let timersStarted = false
let polling = false
let ticking = false
let forking = false
let forkUsage: TurnUsage | null = null
let countdownTimer: { at: number; cancel: () => void } | null = null
/** The limits pane's next redraw, while it is open (scheduleLimitsRedraw). */
let limitsTimer: { at: number; cancel: () => void } | null = null
let judgeSequence = 0
/** Jev's network blips and timeouts in a row. */
let jevBlips = 0
let generation = 0
/** The press whose handoff fork is running: a result carries it so a /clear cannot be handed another chat's note. */
let handoffRun = 0
/**
 * A finished agent's conversation, read once. The Agents pane is redrawn every second while any
 * agent or task runs, and re-reading a conversation that cannot grow was a full transcript read
 * per tick per open pane (B19). A resumed agent runs again first, which changes the key.
 */
let agentTalkCache: { id: string; key: string; talk: AgentTalk } | null = null
/** Preserve delivery order when transcript reads overlap; reset guards below reject stale work. */
let receiveWork: Promise<void> = Promise.resolve()
let carriedPick = false
/**
 * An agent's end that came before its spawn was recorded, kept until the record lands. A worker
 * whose first request fails ends in milliseconds, while the spawn hook still reads its files; a
 * workflow's 29 such agents stayed "running" in the pane for good (2026-10-24).
 */
const endedEarly = new Map<string, { state: 'done' | 'failed'; endedAt: number; outcome: Record<string, unknown> }>()
// Serialize settings reads and writes so a slow poll cannot overwrite a queued edit.
let settingsWork: Promise<void> = Promise.resolve()
function settingsTask<T>(work: () => Promise<T>): Promise<T> {
  const result = settingsWork.then(work)
  settingsWork = result.then(() => undefined, () => undefined)
  return result
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
function effortOf(value: unknown): Effort | undefined {
  return typeof value === 'string' && EFFORTS.includes(value as Effort) ? value as Effort : undefined
}
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
async function report($: EngineInterface, where: string, error: unknown, language: Lang = 'en'): Promise<void> {
  // Diagnostics cannot depend on the state read that may have just failed.
  await $.ui.log(displayText(t(language, 'commands.debugLog', { where, reason: reason(error) }), 1800), { to: 'debug' })
}
async function userHome($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '~'
}
async function rippleHome($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDERIPPLE_HOME')) ?? `${await userHome($)}/.clauderipple`
}
// The fs API has no append: serialize read/write pairs so concurrent picks in this mod survive.
let workerLogWork: Promise<void> = Promise.resolve()
/**
 * Lines the pick log keeps. Each delegation writes a pick and an outcome, so 300 lines held only a
 * few days; weighing whether a tier was enough needs weeks (2026-10-15).
 */
const PICK_LOG_LINES = 3000
async function persistWorkerPick($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  const work = workerLogWork.then(async () => {
    try {
      const path = `${await rippleHome($)}/logs/worker-picks.jsonl`
      const old = await $.fs.exists(path) ? await $.fs.read(path) : ''
      const lines = old.split('\n').filter(line => line.trim()).slice(-(PICK_LOG_LINES - 1))
      await $.fs.write(path, [...lines, JSON.stringify(entry)].join('\n') + '\n')
    } catch (error) { await report($, 'worker pick log', error) }
  })
  // A reporting failure must not poison the queue or undo the selected spawn either.
  workerLogWork = work.catch(() => undefined)
  await workerLogWork
}
/**
 * What the phone queued for this chat. The host keeps the queue (packages/remote/src/queue.ts) and
 * sends it when the turn ends; the Claude app never sees it, so the band says it is there. Keyed by
 * the phone's session id, which for a Claude app session is this one, or by `desktopId`.
 */
export function phoneQueueOf(text: string | undefined, session: string): { count: number; first: string } | null {
  if (!text) return null
  for (const [key, value] of Object.entries(object(JSON.parse(text)))) {
    const entry = object(value)
    if (key !== session && entry.desktopId !== session) continue
    const items = Array.isArray(entry.items) ? entry.items.map(object) : []
    return items.length ? { count: items.length, first: typeof items[0]!.text === 'string' ? items[0]!.text : '' } : null
  }
  return null
}
async function refreshPhoneQueue($: EngineInterface, session: string): Promise<void> {
  const path = `${await rippleHome($)}/remote/queue.json`
  const next = await $.fs.exists(path) ? phoneQueueOf(await optionalFile($, path), session) : null
  if (JSON.stringify(next) !== JSON.stringify(await read($, phoneQueue))) await update($, phoneQueue, () => next)
}
async function claudeHome($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await userHome($)}/.claude`
}
async function optionalFile($: EngineInterface, path: string): Promise<string | undefined> {
  try { return await $.fs.read(path) }
  catch (error) { await report($, 'optional file', error); return undefined }
}
async function adminUrl($: EngineInterface): Promise<string> {
  const text = await optionalFile($, `${await rippleHome($)}/config.json`)
  if (!text) return 'http://127.0.0.1:8792'
  const config = object(JSON.parse(text))
  const admin = object(config.admin).port
  const listen = object(config.listen).port
  const port = typeof admin === 'number' ? admin : (typeof listen === 'number' ? listen : 8791) + 1
  return `http://127.0.0.1:${port}`
}
/** Opens a URL with the system's opener (a browser page, or a claude:// link the desktop app takes); throws when it cannot. */
async function openUrl($: EngineInterface, url: string): Promise<void> {
  let argv: string[]
  // cmd reads & as a command separator: escaped, a link's query reaches start whole.
  if (await $.env.get('OS') === 'Windows_NT') argv = ['cmd', '/c', 'start', '', url.replace(/&/g, '^&')]
  else {
    const platform = await $.process.run(['uname', '-s'], { timeoutMs: 2000 })
    if (platform.exitCode !== 0) throw new Error(platform.stderr || 'uname failed')
    argv = [platform.stdout.trim() === 'Darwin' ? 'open' : 'xdg-open', url]
  }
  const result = await $.process.run(argv, { timeoutMs: 2000 })
  if (result.exitCode !== 0) throw new Error(result.stderr || `opener exited ${result.exitCode}`)
}
async function openAllSettings($: EngineInterface): Promise<void> {
  const url = `${await adminUrl($)}/#mod`
  try {
    await openUrl($, url)
  } catch (error) {
    await report($, 'open mod settings', error)
    await $.ui.toast(url)
  }
}
async function currentSettings($: EngineInterface): Promise<Settings> {
  return normalizeSettings(await read($, settings))
}
async function resolveLanguage($: EngineInterface, s: Settings): Promise<Lang> {
  if (s.language !== 'auto') return s.language
  try {
    const value = (await $.settings.read()).language
    const host = langFrom(typeof value === 'string' ? value : undefined)
    if (host) return host
  } catch (error) { await report($, 'language settings', error) }
  // On a Mac the system language comes before LANG: a session the desktop app starts can carry
  // LANG=en_US on a Korean Mac (seen 2026-10-10: Korean headless, English in the Code tab).
  // The engine exposes no platform noun. Avoid running macOS defaults elsewhere.
  if (await $.env.get('OS') !== 'Windows_NT') {
    try {
      const platform = await $.process.run(['uname', '-s'], { timeoutMs: 2000 })
      if (platform.exitCode === 0 && platform.stdout.trim() === 'Darwin') {
        const apple = await $.process.run(['defaults', 'read', '-g', 'AppleLocale'], { timeoutMs: 2000 })
        const mac = apple.exitCode === 0 ? langFrom(apple.stdout) : undefined
        if (mac) return mac
        if (apple.exitCode !== 0) await report($, 'language locale', apple.stderr)
      }
    } catch (error) { await report($, 'language locale', error) }
  }
  return langFrom(await $.env.get('LANG')) ?? langFrom(await $.env.get('LC_ALL')) ?? 'en'
}
async function registerAuto($: EngineInterface, s: Settings): Promise<void> {
  if (s.agentAuto === 'off') return
  await $.agent.register({ name: 'auto', description: AUTO_DESCRIPTION, prompt: EXECUTOR, disallowedTools: ['Agent'] })
}
async function installSettings($: EngineInterface, s: Settings): Promise<void> {
  const previous = await currentSettings($)
  await update($, settings, () => s)
  const resolved = await resolveLanguage($, s)
  await update($, lang, () => resolved)
  // A router poll can land before the session binds, when register rejects; session.start
  // registers again, so a rejection here must not cut the rest of the install short.
  try { await registerAuto($, s) } catch (error) { await report($, 'agent register', error) }
  if (!s.effortAuto) await update($, heldPick, () => null)
  if (s.keepWarm && !previous.keepWarm) await update($, warm, value => ({ ...value, stopped: undefined }))
  // Settings caught up with this chat's own choice: it follows Settings again.
  if (await read($, warmHere) === s.keepWarm) await update($, warmHere, () => null)
  // Setup was finished (here, in another chat, or the settings came back from the router): a setup
  // card still open is stale, and the judge's key is looked up for the source now chosen. Both
  // survive a reload, so after a router outage they asked for setup and a Jev key again although
  // the router held both (2026-10-20).
  if (s.setupDone && await read($, panel) === 'setup') {
    await update($, panel, () => null)
    await update($, settingsDraft, () => null)
    await update($, settingsBase, () => null)
  }
  if (s.judge !== previous.judge || s.jevSource !== previous.jevSource || (s.judge === 'jev' && (await read($, jev)).source === null)) await jevKey($)
}
function settingsSnapshot(text: string): ModSettingsSnapshot {
  const value = object(JSON.parse(text))
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.stored !== 'boolean' || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) throw new Error('invalid router settings snapshot')
  const at = value.compactAt
  return { settings: normalizeSettings(value.settings), revision: Number(value.revision), stored: value.stored, compactAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null }
}
async function routerSettingsDown($: EngineInterface, error: unknown): Promise<void> {
  const notice = t(await read($, lang), 'band.routerDown')
  if (await read($, line) !== notice) await update($, line, () => notice)
  await report($, 'router settings', error)
}
async function acceptSettings($: EngineInterface, snapshot: ModSettingsSnapshot, sent = 0): Promise<void> {
  const sync = await update($, settingsSync, value => ({ ...value, revision: snapshot.revision, pending: value.pending.slice(sent), migration: snapshot.stored ? null : value.migration }))
  const base = snapshot.stored ? snapshot.settings : sync.migration ?? snapshot.settings
  await installSettings($, applySettingsChanges(base, sync.pending))
  await rebaseDraft($)
}
async function putSettings($: EngineInterface, admin: string, base: Settings): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sync = await read($, settingsSync)
    // A migration that lost a CAS race is not a user edit: never retry it as a full save.
    if (!sync.pending.length && !sync.migration) return
    const count = sync.pending.length
    const response = await $.http.fetch(`${admin}/api/mod-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, settings: applySettingsChanges(base, sync.pending), revision: sync.revision }) })
    if (!response.ok && response.status !== 409) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: response.status }))
    const snapshot = settingsSnapshot(response.text)
    await acceptSettings($, snapshot, response.ok ? count : 0)
    if (response.ok) return
    base = snapshot.settings
    if (attempt === 1) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: 409 }))
  }
}
let compactWindows: unknown = null
async function currentCompactAt($: EngineInterface): Promise<number | null> {
  return modelCompactWindow(compactWindows, await $.session.model()) ?? await read($, compactAt)
}
async function syncSettings($: EngineInterface, admin: string): Promise<void> {
  const windows = await $.http.fetch(`${admin}/api/context-windows`)
  if (windows.ok) compactWindows = JSON.parse(windows.text)
  else if (windows.status !== 404) await report($, 'context windows', `HTTP ${windows.status}`)
  const response = await $.http.fetch(`${admin}/api/mod-settings`)
  if (!response.ok) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: response.status }))
  const snapshot = settingsSnapshot(response.text)
  // Claude Code writes `/autocompact` to settings.json itself, so this can change without a
  // settings revision: the band reads it on every poll.
  const at = snapshot.compactAt ?? null
  if (at !== await read($, compactAt)) {
    await update($, compactAt, () => at)
    // The share is counted against this window: a count of the old one is another context's.
    contextRun += 1
    fullMark = null
    await update($, contextFull, () => null)
  }
  let sync = await read($, settingsSync)
  // Session atoms survive reloads. Old pending paths/drafts cannot prove user intent
  // under this format; discard them rather than granting an old overwrite a new version.
  if (sync.schemaVersion !== MOD_SETTINGS_SCHEMA_VERSION) {
    sync = await update($, settingsSync, () => ({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, revision: null, pending: [], migrationChecked: false, migration: null }))
    await update($, settingsBase, () => null)
  }
  if (snapshot.stored && sync.migration) sync = await update($, settingsSync, value => ({ ...value, migration: null }))
  // A router with no settings stored (a fresh or emptied home, or a stray test router that took the
  // live one's launchd label, 2026-10-20) is not a reset: settings this chat holds from a finished
  // setup are kept and written back, instead of taking defaults and asking for setup again.
  if (!snapshot.stored && !sync.migration) {
    const held = await read($, settings)
    if (held !== null && normalizeSettings(held).setupDone) sync = await update($, settingsSync, value => ({ ...value, migrationChecked: true, migration: normalizeSettings(held) }))
  }
  if (!sync.migrationChecked) {
    let migration: Settings | null = null
    if (!snapshot.stored) {
      const legacy = await $.store.get('settings')
      const setupDone = await $.store.get('setupDone')
      if (legacy !== undefined && legacy !== null || setupDone === true) {
        migration = normalizeSettings(legacy)
        if (setupDone === true) migration.setupDone = true
      }
    }
    sync = await update($, settingsSync, value => ({ ...value, migrationChecked: true, migration }))
  }
  if (sync.revision !== snapshot.revision || await read($, settings) === null) await acceptSettings($, snapshot)
  sync = await read($, settingsSync)
  if (sync.pending.length || sync.migration) await putSettings($, admin, snapshot.stored ? snapshot.settings : sync.migration ?? snapshot.settings)
}
async function loadSettings($: EngineInterface): Promise<void> {
  try { await settingsTask(async () => { await syncSettings($, await adminUrl($)) }) }
  catch (error) { await installSettings($, await currentSettings($)); await routerSettingsDown($, error) }
  const hidden = (await $.store.get('bandHidden')) === true
  await update($, bandHidden, () => hidden)
  if (!(await read($, pick))) {
    const carried = object(await $.store.get('pick'))
    const level = effortOf(carried.effort)
    if (level && ['haiku', 'jev', 'model', 'manual', 'followup'].includes(String(carried.by))) {
      carriedPick = true
      await update($, pick, () => ({ effort: level, why: typeof carried.why === 'string' ? carried.why : '', by: carried.by as Pick['by'], at: typeof carried.at === 'number' ? carried.at : 0 }))
    }
  }
}
async function saveSettings($: EngineInterface, s: Settings, baseline?: Settings): Promise<boolean> {
  // Both sides use the same format: normalization alone is never an edit.
  const changes = settingsChanges(normalizeSettings(baseline ?? await currentSettings($)), normalizeSettings(s))
  try {
    await settingsTask(async () => {
      await update($, settingsSync, value => ({ ...value, pending: [...value.pending, ...changes] }))
      await installSettings($, applySettingsChanges(await currentSettings($), changes))
      const admin = await adminUrl($)
      // Always rebase on the router, never PUT the normalized local atom wholesale.
      await syncSettings($, admin)
    })
    return true
  } catch (error) { await routerSettingsDown($, error); return false }
}
async function installPick($: EngineInterface, value: Pick): Promise<void> {
  carriedPick = false
  await update($, pick, () => value)
  await $.store.set('pick', value)
}

// The engine's pane list is authoritative: a reload can close panes without sending ui.close.
async function isLogUp($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === LOG_PANE)
}
async function syncPanes($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes()
  const log = panes.some(p => p.id === LOG_PANE)
  const agent = panes.some(p => p.id === AGENTS_PANE)
  if (log !== await read($, logOpen)) await update($, logOpen, () => log)
  if (agent !== await read($, agentsOpen)) await update($, agentsOpen, () => agent)
}
async function toggleLog($: EngineInterface): Promise<boolean> {
  const language = await read($, lang)
  const open = await isLogUp($)
  if (open) await $.ui.close({ id: LOG_PANE })
  else {
    // The surface may decline to draw the pane; say why rather than doing nothing on a press.
    const opened = await $.ui.open({ id: LOG_PANE, title: t(language, 'commands.logTitle') })
    if (!opened.isPlaced) {
      const why = 'reason' in opened && opened.reason ? String(opened.reason) : 'not placed'
      $.ui.toast(t(language, 'toasts.logNotPlaced', { reason: why }))
      await report($, 'log pane', why)
    }
  }
  await syncPanes($)
  if (!open) await refreshRouter($)
  return !open
}
async function toggleAgents($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  const open = (await $.ui.panes()).some(p => p.id === AGENTS_PANE)
  if (open) await $.ui.close({ id: AGENTS_PANE })
  else await $.ui.open({ id: AGENTS_PANE, title: t(language, 'commands.agentsTitle') })
  await syncPanes($)
}
/**
 * The Context pane, opened as a dialog: it takes the keyboard, Escape closes it and toasts wait
 * while it shows. It is read and left, as the app's own breakdown was.
 */
async function toggleContext($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  if ((await $.ui.panes()).some(p => p.id === CONTEXT_PANE)) await $.ui.close({ id: CONTEXT_PANE })
  else await $.ui.open({ id: CONTEXT_PANE, title: t(language, 'commands.contextTitle'), focus: true, closeOnEscape: true, holdToasts: true, rows: 30 })
}
/** What the precise count was taken in: the same tokens in another chat, model or window are a different share. */
type FullMark = { basis: number | null; window: number | null; model: string; at: number | null; generation: number; context: number; run: number }
let fullMark: FullMark | null = null
/** Bumped whenever this chat's context is replaced or its model/window changes; a count from before is dropped. */
let contextRun = 0
/** Bumped when this chat's context is replaced by a compaction; clear/resume/fork move `generation`. */
let contextEpoch = 0
function countsHere(mark: FullMark, basis: number | null, model: string, at: number | null): boolean {
  return mark.basis === basis && mark.model === model && mark.at === at && mark.generation === generation && mark.context === contextEpoch && mark.run === contextRun
}
/**
 * The limits pane, opened from the band's limits row: every plan window with the share it has used
 * and when it resets, which the row has no room to say. Opened again it closes, as does the pane's
 * own close. The windows are read afresh on the way in, once a minute at most (refreshLimits).
 */
function limitsActions($: EngineInterface): LimitsActions {
  return { close: () => $.ui.close({ id: LIMITS_PANE }) }
}
/**
 * The limits pane says the time left to each reset to the minute, so it is drawn again when the
 * soonest of those minutes turns over (or a reset passes), while it stays open. Nothing else
 * redraws it on time: the windows themselves are read once a minute and only a change is written.
 */
function scheduleLimitsRedraw($: EngineInterface, items: readonly LimitItem[], now: number): void {
  const turns = items.map(item => nextMinuteChange(item.resetsAt ? Date.parse(item.resetsAt) : NaN, now)).filter((at): at is number => at !== null && Number.isFinite(at))
  const at = turns.length ? Math.min(...turns) : null
  if (limitsTimer?.at === at) return
  limitsTimer?.cancel()
  limitsTimer = null
  if (at === null) return
  const timer = $.clock.after(Math.max(1, at - now), () => {
    limitsTimer = null
    void (async () => {
      if ((await $.ui.panes()).some(p => p.id === LIMITS_PANE)) await $.ui.invalidate('ui.render')
    })().catch(error => report($, 'limits redraw', error))
  })
  limitsTimer = { at, cancel: () => timer.cancel() }
}
async function toggleLimits($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  if ((await $.ui.panes()).some(p => p.id === LIMITS_PANE)) await $.ui.close({ id: LIMITS_PANE })
  else {
    await refreshLimits($)
    await $.ui.open({ id: LIMITS_PANE, title: t(language, 'commands.limitsTitle') })
  }
}
/**
 * The token-count API's count of the context (`full`, one request per tool and memory file), kept
 * against the last response's tokens when it was asked for: the next step makes it stale, and the
 * pane (and the band, contextShare) shows the local estimate again. Its tokens alone do not say
 * which model, window or conversation counted them (2026-10-25: a model switch left 20% standing
 * where the new window read 4%), so `fullMark` holds that state beside it. A slow answer is
 * published only in the state it was asked for: a clear, compaction or model/window switch while
 * it runs drops it instead of writing over the newer count (2026-10-25).
 */
async function countContext($: EngineInterface): Promise<void> {
  if ((await read($, contextFull))?.busy) return
  const basis = (await read($, context))?.basis ?? null
  const at = await currentCompactAt($)
  const model = await $.session.model()
  const gen = generation
  const epoch = contextEpoch
  const run = ++contextRun
  await update($, contextFull, () => ({ basis, busy: true }))
  try {
    const usage = await $.session.usage({ breakdown: 'full' })
    const breakdown = usage.context.breakdown
    const window = usage.context.window ?? null
    // The answer must still describe this chat, model and request: a clear, a compaction or a
    // switch while it ran makes it another context's count, and it is dropped.
    const now = await $.session.usage().catch(error => { void report($, 'context check', error); return null })
    const nowModel = await $.session.model()
    const nowAt = await currentCompactAt($)
    const nowBasis = (await read($, context))?.basis ?? null
    // Read the scope again after every await: a clear may have moved it while this ran.
    const live = run === contextRun && gen === generation && epoch === contextEpoch && model === nowModel && at === nowAt && basis === nowBasis && now !== null && now.context.window === window
    if (!live) {
      await update($, contextFull, current => run === contextRun && current?.busy ? null : current)
      return
    }
    fullMark = { basis, window, model, at, generation: gen, context: epoch, run }
    const none = t(await read($, lang), 'context.none')
    const result = breakdown ? { basis, breakdown } : { basis, error: none }
    await update($, contextFull, current => run === contextRun && gen === generation && epoch === contextEpoch ? result : current)
  } catch (error) {
    if (run !== contextRun || gen !== generation || epoch !== contextEpoch) {
      await update($, contextFull, current => run === contextRun && current?.busy ? null : current)
      return
    }
    fullMark = { basis, window: null, model, at, generation: gen, context: epoch, run }
    const failure = { basis, error: reason(error) }
    await update($, contextFull, current => run === contextRun && gen === generation && epoch === contextEpoch ? failure : current)
    await report($, 'context count', error)
  }
}
function contextActions($: EngineInterface): ContextActions {
  return {
    refresh: () => countContext($),
    toggle: section => update($, contextShowAll, list => (list.includes(section) ? list.filter(s => s !== section) : [...list, section])),
    close: () => $.ui.close({ id: CONTEXT_PANE }),
  }
}
async function toggleBar($: EngineInterface): Promise<boolean> {
  const hidden = !await read($, bandHidden)
  await $.store.set('bandHidden', hidden)
  await update($, bandHidden, () => hidden)
  return !hidden
}
async function refreshRouter($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  if (polling) return
  polling = true
  try {
    await syncPanes($)
    const admin = await adminUrl($)
    await settingsTask(() => syncSettings($, admin))
    await endModeIfOver($)
    const session = await $.session.id()
    // Read even with the band hidden: the strip shows over whatever is above the prompt.
    await refreshPhoneQueue($, session)
    const open = await isLogUp($)
    if (!open && await read($, bandHidden)) { await update($, line, () => null); return }
    const own = await $.http.fetch(`${admin}/api/requests?kind=messages&n=${open ? 60 : 20}&session=${encodeURIComponent(session)}`)
    if (!own.ok) throw new Error(t(language, 'commands.routerHttp', { status: own.status }))
    const mine = (object(JSON.parse(own.text)).requests ?? []) as StatusRequest[]
    const newest = mine[0] ?? null
    const notice = newest && newest.session === undefined ? t(language, 'band.routerRestart') : null
    if (notice !== await read($, line)) await update($, line, () => notice)
    // Do not show a route belonging to another chat from a router without session support. The
    // route is this chat's own: subagents share its session id, and a route that moved with each
    // worker request redrew the band every poll, starting 리플이's motion over each time.
    const route = notice ? null : mine.find(r => !r.subagent) ?? await read($, last)
    if (JSON.stringify(route) !== JSON.stringify(await read($, last))) await update($, last, () => route)
    if (!open) return
    let shown = mine
    if (!await read($, onlySession)) {
      const all = await $.http.fetch(`${admin}/api/requests?kind=messages&n=60`)
      if (!all.ok) throw new Error(t(language, 'commands.routerHttp', { status: all.status }))
      shown = (object(JSON.parse(all.text)).requests ?? []) as StatusRequest[]
    }
    const rows = shown.map(record => ({ ...record, mine: record.session === session }))
    if (JSON.stringify(rows) !== JSON.stringify(await read($, requests))) await update($, requests, () => rows)
  } catch (error) {
    if (await read($, line) !== t(language, 'band.routerDown')) await update($, line, () => t(language, 'band.routerDown'))
    await report($, 'router poll', error)
  } finally { polling = false }
}

// Files and availability are sampled at spawn, not cached across quota/account changes.
async function workerFiles($: EngineInterface): Promise<Map<string, string>> {
  const text = await optionalFile($, `${await rippleHome($)}/generated-agents.json`)
  const names = text ? strings(object(JSON.parse(text)).agents) : []
  const files = new Map<string, string>()
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue
    const file = await optionalFile($, `${await claudeHome($)}/agents/${name}.md`)
    if (file && agentModel(file)) files.set(name, file)
  }
  return files
}
/**
 * The provider a started agent runs on, for its card's dot: its worker file's (`via <provider>.`),
 * Anthropic for a Claude id, else the router's catalogue entry for the id.
 */
async function spawnProvider($: EngineInterface, subagentType: string, model: string): Promise<string | undefined> {
  const file = (await workerFiles($)).get(subagentType)
  const fromFile = file ? agentProvider(file) : undefined
  if (fromFile) return fromFile
  const id = model.replace(/@[^@]*$/, '')
  if (/^(?:sonnet|opus|haiku|fable|mythos|claude-)/.test(id)) return 'anthropic'
  return (await read($, routerModels)).find(m => m.value === id)?.provider
}
async function releaseDelegationPin($: EngineInterface): Promise<void> {
  if (!await read($, delegationPin)) return
  await update($, delegationPin, () => null)
  await $.ui.toast(t(await read($, lang), 'toasts.delegationUnpinned'))
}
async function hearDelegationPin($: EngineInterface, text: string): Promise<void> {
  const instruction = pinInstruction(text)
  if (!instruction) return
  if (instruction === 'release') { await releaseDelegationPin($); return }
  const files = await workerFiles($)
  // Generated files cover routed workers even before the first catalogue poll.
  const workers = [...files.values()].flatMap(file => {
    const model = agentModel(file), provider = agentProvider(file)
    return model && provider ? [{ model, provider }] : []
  })
  const sources = workers.concat(claudeCandidates(), (await read($, routerModels)).map(m => ({ model: m.value, provider: m.provider })))
  const pin = parseDelegationPin({ role: 'user', text }, sources, workers)
  if (pin === undefined) return
  if (pin === null) { await releaseDelegationPin($); return }
  const current = await read($, delegationPin)
  // The same model said again keeps the sentence that first pinned it.
  if (current && current.model === pin.model && current.provider === pin.provider) return
  const said = pinSaid(text, pin.model)
  await update($, delegationPin, () => ({ ...pin, ...(said ? { said } : {}) }))
  await $.ui.toast(t(await read($, lang), 'toasts.delegationPinned', { name: titleName(pin.model, await read($, routerModels)) }))
}
async function workerFix($: EngineInterface, spawn: Spawn): Promise<WorkerFix | null> {
  const text = await optionalFile($, `${await rippleHome($)}/generated-agents.json`)
  if (!text || !strings(object(JSON.parse(text)).agents).includes(spawn.subagentType)) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(spawn.subagentType)) return null
  const file = await optionalFile($, `${await claudeHome($)}/agents/${spawn.subagentType}.md`)
  const model = file ? agentModel(file) : undefined
  return model ? fixSpawn(spawn, model) : null
}
async function availability($: EngineInterface): Promise<boolean> {
  try {
    const status = await $.http.fetch(`${await adminUrl($)}/api/status`)
    return status.ok ? chatgptUsable(JSON.parse(status.text)) : true
  } catch (error) { await report($, 'availability unknown', error); return true }
}
async function refreshModels($: EngineInterface): Promise<void> {
  const response = await $.http.fetch(`${await adminUrl($)}/api/config`)
  if (!response.ok) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: response.status }))
  await update($, routerModels, () => routerModelOptions(JSON.parse(response.text)))
}
/** How long the rung choices are kept: ten minutes. */
const KEEP_MS = 600000

/**
 * The quick settings' rung choices, read again each time the panel opens: a model ticked on the
 * dashboard shows in every Select without a restart. A failure keeps what was there.
 */
async function refreshLadder($: EngineInterface): Promise<void> {
  try {
    const response = await $.http.fetch(`${await adminUrl($)}/api/mod-options`)
    if (!response.ok) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: response.status }))
    const fresh = ladderOptionsFrom(JSON.parse(response.text), await $.clock.now() + KEEP_MS, (await currentSettings($)).allow, (await currentSettings($)).allowKnown)
    if (!same(await read($, ladderOptions), fresh)) await update($, ladderOptions, () => fresh)
  } catch (error) { await report($, 'ladder options', error) }
}
/** Turns a mode on (stamping when, for a mode that runs until the quota resets), or off with ''. */
async function setMode($: EngineInterface, id: string): Promise<void> {
  const change: Partial<Settings> = id ? { activeMode: id, activeSince: await $.clock.now() } : { activeMode: undefined, activeSince: undefined }
  await settingsActions($).patch(change)
}
/** Keep observed reset deadlines while a mode is on, even if the next snapshot rolls forward. */
let modeQuotaAt = 0
let modeQuotaKey: string | null = null
let modeQuotaWindows: QuotaWindow[] = []
let endingMode = false
/** The chosen provider's windows: Claude uses the band's binding limit; ChatGPT its account quota API. */
async function modeWindows($: EngineInterface, provider: string): Promise<QuotaWindow[]> {
  if (provider === 'anthropic') return claudeWindow(await read($, limit))
  const response = await $.http.fetch(`${await adminUrl($)}/api/chatgpt-accounts?provider=${encodeURIComponent(provider)}`)
  if (!response.ok) return []
  const body: unknown = JSON.parse(response.text)
  // The router answers for its first ChatGPT provider when the name is not one: not this provider.
  return object(body).provider === provider ? quotaWindows(body) : []
}
/** A mode whose time is up turns itself off and says so (on each poll and prompt). */
async function endModeIfOver($: EngineInterface): Promise<void> {
  if (endingMode) return
  endingMode = true
  try {
    const s = await currentSettings($)
    const mode = activeModeOf(s)
    const key = modeKey(s) + JSON.stringify([mode?.rungs, mode?.until])
    if (modeQuotaKey !== key) { modeQuotaKey = key; modeQuotaAt = 0; modeQuotaWindows = [] }
    if (!mode || mode.until === 'none') return
    const now = await $.clock.now()
    let windows = modeQuotaWindows
    const provider = resetProvider(mode)
    if (provider) {
      // Claude's limit arrives with the session; read it on every check, not once a minute.
      if (provider === 'anthropic') windows = [...windows, ...claudeWindow(await read($, limit))]
      if (!modeOver(mode, s.activeSince, now, windows) && now - modeQuotaAt >= 60_000) {
        const fresh = await modeWindows($, provider)
        modeQuotaAt = now
        // Keep only the earliest observed deadline after activation, plus current snapshots.
        const first = [...windows, ...fresh].filter(w => w.at > (s.activeSince ?? now)).sort((a, b) => a.at - b.at)[0]
        modeQuotaWindows = [...(first ? [first] : []), ...fresh]
        windows = modeQuotaWindows
      }
    }
    if (!modeOver(mode, s.activeSince, now, windows)) return
    await saveSettings($, { ...s, activeMode: undefined, activeSince: undefined }, s)
    await $.ui.toast(t(await read($, lang), 'toasts.modeEnded', { name: mode.name }))
  } catch (error) { await report($, 'mode end', error) }
  finally { endingMode = false }
}
async function jevKey($: EngineInterface, jevSource?: Settings['jevSource']): Promise<string | undefined> {
  const selected = jevSource ?? normalizeSettings(await read($, settingsDraft) ?? await read($, settings)).jevSource
  if (selected === 'zen') {
    const file = await optionalFile($, `${await rippleHome($)}/config.json`)
    const key = file ? zenJev(JSON.parse(file)).authorization : undefined
    await update($, jev, value => ({ ...value, source: key ? 'zen' as const : null }))
    return key
  }
  const env = (await $.env.get('TYPESAFE_API_KEY'))?.trim()
  if (env) {
    if ((await read($, jev)).source !== 'env') await update($, jev, value => ({ ...value, source: 'env' as const }))
    return env
  }
  const file = await optionalFile($, `${await userHome($)}/.config/jev/.env`)
  const key = file ? parseJevKey(file) : undefined
  const source: 'pasted' | 'file' | null = key ? ((await read($, jev)).source === 'pasted' ? 'pasted' : 'file') : null
  if ((await read($, jev)).source !== source) await update($, jev, value => ({ ...value, source }))
  return key
}
/** OpenCode Zen's key from the router's config, when Zen lists a Jev model there; else none. */
async function zenJevKey($: EngineInterface): Promise<string | undefined> {
  const file = await optionalFile($, `${await rippleHome($)}/config.json`)
  if (!file) return undefined
  const config: unknown = JSON.parse(file)
  const models = object(object(object(config).providers)['opencode-zen']).models
  const listed = Array.isArray(models) && models.some(m => { const id = object(m).id; return typeof id === 'string' && id.toLowerCase().includes('jev') })
  return listed ? zenJev(config).authorization : undefined
}
async function saveJevKey($: EngineInterface, input: string): Promise<void> {
  const language = await read($, lang)
  const key = parseJevKey(input) ?? input.trim()
  if (!key || /[\r\n]/.test(key)) throw new Error(t(language, 'toasts.keySingle'))
  const path = `${await userHome($)}/.config/jev/.env`
  const old = await optionalFile($, path) ?? ''
  const entry = `TYPESAFE_API_KEY=${key}`
  const text = /^[ \t]*TYPESAFE_API_KEY[ \t]*=/m.test(old)
    ? old.replace(/^[ \t]*TYPESAFE_API_KEY[ \t]*=[^\r\n]*/gm, () => entry)
    : old + (old && !old.endsWith('\n') ? '\n' : '') + entry + '\n'
  await $.fs.write(path, text)
  const mode = await $.process.run(['chmod', '600', path])
  if (mode.exitCode !== 0) throw new Error(t(language, 'toasts.keyPrivateFailed'))
  await update($, jev, () => ({ source: 'pasted' as const, test: { state: 'idle' as const } }))
  await update($, judgeDown, () => null)
  await $.ui.toast(t(language, 'toasts.keySaved'))
}
/**
 * A judge failure is said once per reason in a session (a toast and the band); the same reason
 * again stays quiet, so a judge that keeps failing does not speak on every message.
 */
async function down($: EngineInterface, message: string, network = false): Promise<void> {
  if ((await read($, judgeSeen)).includes(message)) return
  await update($, judgeSeen, value => [...value, message].slice(-20))
  await update($, judgeDownNetwork, () => network)
  await update($, judgeDown, () => message)
  await $.ui.toast(t(await read($, lang), 'toasts.judgeDown', { reason: message }))
}

type Judged = { verdict: Verdict | undefined; by: JudgeKind; ms: number; error?: string }
function judgeFailure(answer: ModelCompleteResult): string | undefined {
  if (answer.isAnswered) return undefined
  return answer.reason === 'api-error' ? `${answer.reason}: ${answer.error} (${answer.status ?? 'no response'})` : answer.reason
}
async function completeJudge($: EngineInterface, model: string, system: string, prompt: string): Promise<ModelCompleteResult> {
  return $.model.complete({ model, system, prompt, maxTokens: 160, timeoutMs: 6000, effort: 'low' })
}
/** The main session's effort. Delegated workers are no longer judged: the session names their tier (2026-10-24). */
async function judge($: EngineInterface, s: Settings, input: JudgeInput, testing = false): Promise<Judged> {
  const language = await read($, lang)
  const started = await $.clock.now()
  const system = EFFORT_JUDGE_SYSTEM
  const prompt = judgeContext(input)
  let failure: string | undefined
  let by: JudgeKind = s.judge
  let verdict: Verdict | undefined
  let blip = false
  if (s.judge === 'jev') {
    try {
      let source = s.jevSource
      let key = await jevKey($, source)
      // No TypeSafe key, but the router's OpenCode Zen offers Jev: ask Jev there.
      if (!key && source === 'typesafe') {
        key = await zenJevKey($)
        if (key) source = 'zen'
      }
      if (!key) throw new Error(t(language, source === 'zen' ? 'jev.zenMissing' : 'toasts.keyMissing'))
      const body = jevEffortRequest(input)
      let model = 'jev-latest'
      if (source === 'zen') {
        const file = await optionalFile($, `${await rippleHome($)}/config.json`)
        model = file ? zenJev(JSON.parse(file)).model : model
      }
      const response = await Promise.race([
        $.http.fetch(source === 'zen' ? 'https://opencode.ai/zen/v1/systemone' : 'https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { 'content-type': 'application/json', authorization: source === 'zen' ? key : `Bearer ${key}` }, body: JSON.stringify({ ...body, model }) })
          .catch(() => 'network' as const),
        // Jev answers in about 2.1–2.4 s even with a full context (measured 2026-10-22), so 3 s timed
        // out whenever OpenCode slowed down — and the Haiku fallback then cost more than waiting.
        $.clock.sleep(5000).then(() => null),
      ])
      // A dropped connection or a slow answer is often one bad moment, not a broken judge.
      if (!response || response === 'network') {
        blip = true
        throw new Error(jevFailure(response ? 'network' : 'timeout', language))
      }
      if (!response.ok) throw new Error(jevFailure(response.status, language))
      const json: unknown = JSON.parse(response.text)
      // An unsure Jev still answered: its odds settle it here and the bias setting tips it later. Haiku is only for a Jev that failed.
      verdict = parseJevEffort(json, input.current ?? null, language)
      await update($, stats, value => addJudge(value, 'jev', 0, jevUsage(json)))
      if (!verdict) throw new Error(t(language, 'toasts.jevNoVerdict'))
    } catch (error) { failure = reason(error); verdict = undefined }
  }
  if (s.judge === 'model') {
    try {
      const answer = await completeJudge($, s.judgeModel, system, prompt)
      await update($, stats, value => addJudge(value, 'model', 0, answer.usage.input_tokens + answer.usage.output_tokens))
      verdict = answer.isAnswered ? parseEffortVerdict(answer.text) : undefined
      if (!verdict) failure = judgeFailure(answer) ?? t(language, 'toasts.routerNoVerdict')
    } catch (error) { failure = reason(error) }
  }
  if (!verdict) {
    by = 'haiku'
    try {
      let answer = await completeJudge($, HAIKU, system, prompt)
      await update($, stats, value => addJudge(value, 'haiku', 0, answer.usage.input_tokens + answer.usage.output_tokens))
      if (!answer.isAnswered) {
        failure ??= judgeFailure(answer)
        answer = await completeJudge($, 'haiku', system, prompt)
        await update($, stats, value => addJudge(value, 'haiku', 0, answer.usage.input_tokens + answer.usage.output_tokens))
      }
      verdict = answer.isAnswered ? parseEffortVerdict(answer.text) : undefined
      if (!verdict) failure ??= t(language, 'toasts.haikuNoVerdict')
    } catch (error) { failure ??= reason(error) }
  }
  const ms = Math.max(0, await $.clock.now() - started)
  await update($, stats, value => ({ ...value, judge: { ...value.judge, ms: value.judge.ms + ms } }))
  if (!testing) {
    // The log pane lists it: a Jev call never reaches the router, so nothing else would show it.
    const run: JudgeRun = { at: started, for: 'prompt', asked: s.judge, by, ms, ...(verdict?.effort ? { effort: verdict.effort } : {}), ...(verdict?.sure !== undefined ? { sure: verdict.sure } : {}), ...(failure ? { error: failure } : {}) }
    await update($, judgeRuns, value => [...value, run].slice(-40))
    // A network blip or timeout is said only when it happens twice running; Haiku covers the one prompt.
    jevBlips = blip ? jevBlips + 1 : 0
    if (failure && !(blip && jevBlips < 2)) await down($, failure, blip)
    else if (await read($, judgeDown)) await update($, judgeDown, () => null)
  }
  return { verdict, by, ms, ...(failure ? { error: failure } : {}) }
}
async function testJudge($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  await update($, jev, value => ({ ...value, test: { state: 'testing' as const } }))
  try {
    const s = normalizeSettings(await read($, settingsDraft) ?? await read($, settings))
    const judged = await judge($, s, { messages: [], next: 'Rename a local variable in one function and verify the result.' }, true)
    const ok = !!judged.verdict && !judged.error
    await update($, jev, value => ({ ...value, test: { state: ok ? 'ok' as const : 'fail' as const, message: `${judged.ms} ms · ${judged.verdict?.effort ? t(language, 'band.' + judged.verdict.effort).toLowerCase() : t(language, 'toasts.noVerdict')} · ${judged.error ?? judged.by}` } }))
  } catch (error) {
    await update($, jev, value => ({ ...value, test: { state: 'fail' as const, message: reason(error) } }))
  }
}

async function requestPick($: EngineInterface, e: AgentSpawnInput, s: Settings): Promise<{ input: AgentSpawnInput; pick: WorkerPick } | { deny: string }> {
  const language = await read($, lang)
  const files = await workerFiles($)
  try { await refreshModels($) } catch (error) { await report($, 'worker catalogue', error) }
  // Claude's own models are candidates as well: general-purpose on the model, effort by turn.step.
  const pinnedCandidates: WorkerCandidate[] = [...[...files].flatMap(([agent, file]) => { const model = agentModel(file)?.replace(/@[^@]*$/, ''); const provider = agentProvider(file); return model && provider ? [{ target: { agent }, model, provider }] : [] }), ...claudeCandidates()]
  const usable = await availability($)
  // The session names the tier and domain; the owner's ladder names the model (2026-10-24, the
  // worker judge removed: see AUTO_DESCRIPTION). A model is named only with where it comes from.
  const marker = readMarker(e.prompt)
  const tier = tierOf(marker)
  const markerModel = marker && !tier && !['auto', 'ripple'].includes(marker.name) ? marker.name : undefined
  // Calling a worker agent by type, or Claude's own agent on a model (agentAuto "all"), names that
  // model just as a marker does; ignored, a design brief sent to Opus ran on the general ladder.
  const auto = ['ripple:auto', 'auto'].includes(e.subagentType)
  const direct = auto ? undefined : files.has(e.subagentType) ? e.subagentType : e.subagentType === 'general-purpose' && e.model ? e.model.replace(/@[^@]*$/, '').toLowerCase() : undefined
  const asked = markerModel ?? direct
  const reason = modelReason(e.prompt)
  const prompt = withoutRouting(e.prompt)
  const pin = await read($, delegationPin)
  const id = (await $.clock.now()).toString(36) + Math.random().toString(36).slice(2, 8)
  const named = tier ? TIER_MARKERS[tier]! : { level: 'standard' as const, kind: 'do' as const }
  let verdict: WorkerVerdict = { domain: markerDomain(tier ? marker!.domain : undefined), ...named, effort: RUNG_EFFORT[rungOf(named)], why: tier ? t(language, 'toasts.sessionTier', { tier }) : t(language, 'toasts.noTier') }
  let by: WorkerPick['by'] = tier ? 'session' : 'default'
  let target: TierTarget | undefined
  const mode = activeModeOf(s)
  const routing = routingSettings(s)
  if (asked) {
    // The mod checks the session's claim and never re-reads it as language: a reason must be given,
    // the user's words must be ones they said, and the name must be a model this machine can run.
    if (!reason) return { deny: t(language, 'workers.noReason', { name: asked }) }
    if (reason.source === 'user') {
      const words = (await $.session.messages()).flatMap(m => { const text = humanText(m); return text ? [text] : [] }).slice(-10)
      words.push(...await read($, heardPrompts))
      if (!reason.quote || !userSaid(reason.quote, words)) return { deny: t(language, 'workers.notSaid', { name: asked }) }
    } else if (!ruleReason(reason.text)) return { deny: t(language, 'workers.noReason', { name: asked }) }
    const known = [...files].some(([agent, f]) => agent.toLowerCase() === asked.toLowerCase() || agentModel(f)?.replace(/@[^@]*$/, '').toLowerCase() === asked.toLowerCase()) || ['opus', 'sonnet', 'haiku'].includes(asked) || asked.startsWith('claude-')
    if (!known) return { deny: t(language, 'workers.unknownModel', { name: asked }) }
  }
  // The user's words for this task, then their standing pin, then a written rule, then the ladder.
  const source = asked && reason!.source === 'user' ? 'user' : pin ? 'pin' : asked ? 'rule' : null
  const namedModel = source === 'pin' ? pin!.model : source ? asked! : undefined
  if (namedModel) {
    const fromPin = source === 'pin' && pin?.provider
    const name = [...files].find(([agent, file]) => (agent.toLowerCase() === namedModel.toLowerCase() || agentModel(file)?.replace(/@[^@]*$/, '').toLowerCase() === namedModel.toLowerCase()) && (!fromPin || agentProvider(file) === pin!.provider))?.[0]
    target = name ? { agent: name } : { agent: 'general-purpose', model: namedModel }
    by = source === 'rule' ? 'rule' : 'user'
    verdict = { ...verdict, effort: (source !== 'pin' ? effortOf(marker?.level ?? /@([a-z]+)$/.exec(e.model ?? '')?.[1]) : undefined) ?? 'high', why: t(language, source === 'rule' ? 'toasts.rulePick' : 'toasts.yourPick') }
  }
  // Availability is request-time state, not the ten-minute panel catalogue. Refresh before every
  // pick, even when no mode is active.
  await refreshLadder($)
  const now = await $.clock.now()
  const options = await read($, ladderOptions)
  const providers = options && options.until > now ? liveProviders(options.providers ?? {}, now) : {}
  const explicitCandidate = target ? pinnedCandidates.find(c => c.target.agent === target!.agent && c.target.model === target!.model) ?? (target.agent === 'general-purpose' ? { target, model: target.model ?? 'sonnet', provider: (source === 'pin' ? pin?.provider : undefined) ?? (await read($, routerModels)).find(m => m.value.toLowerCase() === target!.model?.toLowerCase())?.provider ?? 'anthropic' } : undefined) : undefined
  if (explicitCandidate && s.providers[explicitCandidate.provider] === false) return { deny: t(language, 'workers.disabled', { provider: explicitCandidate.provider }) }
  // An active mode replaces the ladder, not the user's named model (2026-10-24).
  const { rule, ladder } = workerRule(verdict.domain, routing)
  const explicitUsable = !!explicitCandidate && candidateUsable(explicitCandidate, s, usable, providers)
  const ladderResult = explicitUsable ? null : ladderPick(verdict, ladder, routing, pinnedCandidates, usable, language, routing.allow, providers, routing.allowKnown)
  const resolved = ladderResult ?? { target: target!, effort: verdict.effort }
  // The pick says who chose what ran: a named model that could not run leaves the ladder's choice
  // (its name and source stay in the log beside the reason).
  if (namedModel && ladderResult) by = tier ? 'session' : 'default'
  // A named model that cannot run now says so beside the ladder's own reasons.
  const reasons = [explicitCandidate && !explicitUsable ? t(language, 'workers.namedUnavailable', { name: explicitCandidate.model }) : '', resolved.fallbackReason ?? ''].filter(Boolean)
  const fallbackReason = reasons.length ? reasons.join('; ') : undefined
  const selected = resolved.target
  if (!selected) {
    const said = t(language, 'workers.ladderEmpty', { reason: fallbackReason ?? t(language, 'workers.none') })
    await $.ui.toast(said)
    return { deny: said }
  }
  verdict = { ...verdict, effort: resolved.effort }
  const model = spawnModel(selected, verdict.effort, files.has(selected.agent) ? agentModel(files.get(selected.agent)!) : undefined)
  const fallbacks = ladderResult ? ladderFallbackModels(ladder, ladderResult, pinnedCandidates, routing) : []
  const ladderLine = model && fallbacks.length ? workerLadderLine({ pick: id, model, fallbacks }) : undefined
  const value: WorkerPick = { ...verdict, ...resolved, rule, target: selected, by, ms: 0, id, ...(fallbackReason ? { fallbackReason } : {}) }
  // The decision behind a pick is otherwise only in the agents panel; one debug line per pick keeps
  // it checkable: the tier it was given, the rung it landed on and what ran.
  const entry = { task: e.description.slice(0, 200), domain: value.domain, level: value.level, kind: value.kind ?? 'do', rule: value.rule, rung: value.rung, position: value.position, skipped: value.skipped, target: value.target, model: model ?? null, effort: value.effort, by, ...(ladderLine ? { fallbacks } : {}), ...(mode ? { mode: mode.name } : {}), ...(fallbackReason ? { fallbackReason } : {}) }
  await $.ui.log('ClaudeRipple worker pick: ' + JSON.stringify(entry), { to: 'debug' })
  // The brief itself is never logged (it can hold anything); its length is. To read a pick again,
  // its brief is in the session's own transcript under the same description. A model's reason is
  // kept, short, so a wrong source can be found.
  await persistWorkerPick($, { type: 'pick', id, ...entry, at: new Date(now).toISOString(), ...(tier ? { tier } : {}), ...(namedModel ? { namedModel, source, ...(source !== 'pin' && reason ? { reason: reason.text.slice(0, 200) } : {}) } : {}), promptChars: e.prompt.length })
  if (fallbackReason) await $.ui.toast(t(language, 'toasts.workerFallback', { reason: fallbackReason, name: targetLabel(selected, language) }))
  await update($, lastSpawn, () => value)
  await update($, stats, current => addWorker(current, verdict.level))
  // A choice stays canonical for allow-lists, logs and effort (general-purpose:<model>).
  // Dispatch an auto call's Claude choice through our own definition, which withholds Agent.
  // A hook may change the definition and model, but cannot add disallowedTools to a spawn.
  // Direct general-purpose calls keep their own definition and existing behaviour.
  const executor = auto && (selected.agent === 'general-purpose' || /^(?:opus|sonnet|haiku)(?:@|$)|^claude-/.test(model ?? '')) ? 'ripple:auto' : selected.agent
  return { input: { ...e, subagentType: executor, model, prompt: ladderLine ? `${ladderLine}\n${prompt}` : prompt }, pick: value }
}

async function toggleAuto($: EngineInterface): Promise<void> {
  const s = await currentSettings($)
  await saveSettings($, { ...s, effortAuto: !s.effortAuto })
}
/** The band's flame turns keep-warm on or off for this chat only; Settings is what a new chat starts with. */
async function keepWarmOn($: EngineInterface, s: Settings): Promise<boolean> {
  return await read($, warmHere) ?? s.keepWarm
}
async function toggleWarm($: EngineInterface): Promise<void> {
  const s = await currentSettings($)
  const on = !await keepWarmOn($, s)
  await update($, warmHere, () => on === s.keepWarm ? null : on)
  if (on) await update($, warm, value => ({ ...value, stopped: undefined }))
}
async function toggleSave($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const active = (await read($, saveUntil) ?? 0) > now
  const until = active ? null : limitSaveUntil(await read($, hot), now)
  await update($, saveUntil, () => until)
}
async function manualPick($: EngineInterface, effort: Effort): Promise<void> {
  const language = await read($, lang)
  await saveSettings($, { ...await currentSettings($), effortAuto: false })
  await installPick($, { effort, by: 'manual', why: t(language, 'toasts.yourPick'), at: await $.clock.now() })
  const draft = await $.prompt.read()
  if (!draft.text.trim() || /^\/effort\s+\w+\s*$/.test(draft.text)) {
    await $.prompt.fill({ text: `/effort ${effort}`, mode: 'replace' })
    await $.ui.toast(t(language, 'toasts.effortEnter'))
  }
}
// Only first-run setup has a draft; quick settings read the saved state directly.
async function startPanel($: EngineInterface, which: 'settings' | 'setup'): Promise<void> {
  try { await settingsTask(async () => { await syncSettings($, await adminUrl($)) }) }
  catch (error) { await report($, 'panel settings', error) }
  const s = await currentSettings($)
  await update($, settingsDraft, () => which === 'setup' ? normalizeSettings(s) : null)
  await update($, settingsBase, () => which === 'setup' ? normalizeSettings(s) : null)
  if (which === 'setup') await update($, setupStep, () => 1)
  await update($, panel, () => which)
  await jevKey($)
  if (which === 'settings') await refreshLadder($)
}
/**
 * An open panel's draft follows changes saved elsewhere (another session, the web page): the
 * person's own edits (draft against base) are replayed on the settings now held, and the base
 * moves to them. Without a base (a draft from an older mod) the draft starts over from them.
 */
async function rebaseDraft($: EngineInterface): Promise<void> {
  if (await read($, panel) !== 'setup') return
  const draft = await read($, settingsDraft)
  if (!draft) return
  const fresh = await currentSettings($)
  const base = await read($, settingsBase)
  const next = base ? applySettingsChanges(fresh, settingsChanges(normalizeSettings(base), normalizeSettings(draft))) : normalizeSettings(fresh)
  if (base && JSON.stringify(normalizeSettings(base)) === JSON.stringify(fresh)) return
  await update($, settingsBase, () => normalizeSettings(fresh))
  if (JSON.stringify(next) !== JSON.stringify(normalizeSettings(draft))) await update($, settingsDraft, () => next)
}
async function patchDraft($: EngineInterface, change: Partial<Settings>): Promise<void> {
  const current = normalizeSettings(await read($, settingsDraft) ?? await read($, settings))
  await update($, settingsDraft, () => normalizeSettings({ ...current, ...change }))
  if (change.jevSource) { await update($, jev, value => ({ ...value, test: { state: 'idle' as const } })); await jevKey($, change.jevSource) }
}
async function finishSetup($: EngineInterface, skip = false): Promise<void> {
  // A field whose rule picks as the main choice does is stored as no exception.
  const draft = normalizeSettings(skip ? await read($, settings) : await read($, settingsDraft))
  const saved = await saveSettings($, { ...draft, setupDone: true }, skip ? undefined : normalizeSettings(await read($, settingsBase) ?? await currentSettings($)))
  await update($, panel, () => null)
  await update($, settingsDraft, () => null)
  await update($, settingsBase, () => null)
  await $.ui.toast(t(await read($, lang), saved ? 'toasts.settingsSaved' : 'band.routerDown'))
}
async function fork($: EngineInterface, prompt: string): Promise<ModelForkResult | null> {
  const epoch = generation
  forking = true
  forkUsage = null
  try {
    const answer = await $.model.fork({ prompt })
    // Real forks dispatch turn.step; test stubs and older engines can provide only the result.
    const usage = answer && 'usage' in answer ? answer.usage : forkUsage
    if (usage && epoch === generation) {
      await update($, stats, value => addWarm(value, usage))
      if ((usage.cache_read_input_tokens ?? 0) > 0) {
        const memo = nextMemo(await read($, cache), usage, await $.clock.now())
        await update($, cache, () => memo)
        // A ping refreshes the cache for another ttl: the store's expiry follows it across a restart.
        await saveWarm($, await $.session.model())
      }
    }
    return answer
  } finally { forking = false; forkUsage = null }
}
/**
 * The band's Handoff (2026-10-24): the note is written by a fork of this session (its own model,
 * its cache), started by the tick once the session is idle; nothing is sent to this chat. A press
 * while one is being written does nothing. This chat is never cleared (2026-10-13: a handoff that
 * cleared it lost the owner the chat).
 */
async function queueHandoff($: EngineInterface): Promise<void> {
  if ((await read($, handoff))?.stage === 'writing') return
  await update($, handoff, () => ({ stage: 'writing' as const, run: ++handoffRun }))
  await update($, panel, () => null)
  await update($, handoffQueued, () => true)
  // A tick now rather than at the next 15 s one: the card already says the note is being written.
  $.clock.after(1, async () => { await tick($) })
}
async function copyHandoff($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  const value = await read($, handoff)
  if (!value?.text) return
  const text = wrapForNewChat(value.text)
  try {
    const copied = await $.ui.copy({ text })
    if (!copied.isCopied) throw new Error(copied.reason)
  } catch (error) {
    await $.prompt.fill({ text, mode: 'replace' })
    await $.ui.toast(t(language, 'toasts.clipboardFallback'))
    await report($, 'copy fallback', error)
  }
  await update($, handoff, () => ({ ...value, stage: 'copied' as const }))
}
/** A note longer than this goes to a file the new session reads; the app takes ~14k characters in a link. */
const LINK_TEXT = 12_000
/**
 * Opens a new Code session in this session's folder with the handoff in its prompt box
 * (claude://code/new?folder=…&q=…, the desktop app's own link: it fills the box and waits for
 * Enter, never sends by itself). A long note is saved under ~/.clauderipple/handoffs and the box
 * says to read it. Where no link can be opened, the text is copied instead.
 */
async function moveToNewSession($: EngineInterface): Promise<void> {
  const value = await read($, handoff)
  if (!value?.text) return
  const language = await read($, lang)
  let text = wrapForNewChat(value.text)
  try {
    if (text.length > LINK_TEXT) {
      const path = `${await rippleHome($)}/handoffs/handoff-${await $.clock.now()}.md`
      await $.fs.write(path, text + '\n')
      text = t(language, 'alerts.readHandoffFile', { path })
    }
    const folder = await $.session.cwd()
    const url = 'claude://code/new?' + new URLSearchParams({ ...(folder ? { folder } : {}), q: text, source: 'services' }).toString()
    await openUrl($, url)
    await update($, handoff, () => ({ ...value, stage: 'opened' as const }))
  } catch (error) {
    await report($, 'open new session', error)
    await copyHandoff($)
    await $.ui.toast(t(language, 'toasts.newSessionFallback'))
  }
}
/**
 * Writes a queued handoff when the session is idle. A fork that fails or answers nothing fails the
 * handoff: no prompt goes to this chat in its place (the old fallback turn is not kept, 2026-10-24).
 */
async function driveHandoff($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  const value = await read($, handoff)
  if (value?.stage !== 'writing' || value.text || !await read($, handoffQueued) || await read($, busy)) return
  await update($, handoffQueued, () => false)
  // The chat this press belongs to. A /clear while the fork runs starts another one, and its note
  // must not open a session over it (B11). `run` names the press, because a second press after the
  // clear has a fork of its own and this one's answer is not it.
  const chat = generation
  const run = value.run
  const stale = async (): Promise<boolean> => generation !== chat || (await read($, handoff))?.run !== run
  /** Drop this press's card, unless a later press has already taken the state over. */
  const drop = async (): Promise<void> => {
    if ((await read($, handoff))?.run === run) await update($, handoff, () => null)
  }
  try {
    const answer = await fork($, QUICK_PROMPT)
    if (await stale()) { await drop(); return }
    if (!answer?.isAnswered || !answer.text.trim()) throw new Error(answer && !answer.isAnswered ? answer.reason : 'empty handoff')
    await update($, handoff, () => ({ stage: 'writing' as const, text: answer.text, run }))
    await moveToNewSession($)
  } catch (error) {
    // A failure after the chat changed says nothing about this chat: no toast, no failed card.
    if (await stale()) { await drop(); return }
    await update($, handoff, () => ({ stage: 'failed' as const, run }))
    await $.ui.toast(t(language, 'toasts.handoffFailed'))
    await report($, 'handoff', error)
  }
}
/** The tidy prompt the last Compact press sent and the main-loop turn it became; null once it settles. */
type Tidy = { text: string; note: string; turnId: string | null }
let tidy: Tidy | null = null
async function compactNow($: EngineInterface, note: string): Promise<void> {
  const language = await read($, lang)
  await update($, resultCard, () => ({ stage: 'compacting' }))
  try {
    await $.command.run({ command: 'compact', args: note })
    await update($, resultCard, () => ({ stage: 'compacted' }))
  } catch (error) {
    await update($, resultCard, () => ({ stage: 'failed' as const, detail: t(language, 'alerts.compactFailed') }))
    await $.ui.toast(t(language, 'toasts.compactFailed'))
    await report($, 'compact command', error)
  }
}
/** The tidy-up did not finish: nothing is compacted, and the card says the chat was left as it was. */
async function tidyStopped($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  await update($, resultCard, () => ({ stage: 'failed' as const, detail: t(language, 'alerts.tidyFailed') }))
  await $.ui.toast(t(language, 'toasts.tidyStopped'))
}
/**
 * A Compact press, and the tidy-up it asks for first (2026-10-25): a prompt of this plugin's own, a
 * user turn of its own, so the chat says what it has done, what is left and what it decided, and
 * updates its handoff or memory files while those are still in the transcript. The prompt and the
 * answer stay in the transcript, and the summary is built from them. The turn it becomes is bound at
 * `turn.start` and settled at `turn.complete`: only its own end compacts, and one that is stopped
 * compacts nothing. A prompt still waiting for that turn when Compact is pressed again (the queue
 * let it go, or the engine never started it) is given up and sent once more, so the button cannot be
 * left dead; one already bound to a turn blocks the second press. With the switch off, the
 * compaction goes at once.
 */
async function runCompact($: EngineInterface, note = ''): Promise<void> {
  await update($, panel, () => null)
  // A press while the tidy-up is bound to its turn sends nothing a second time; the card it shows
  // says so. One still waiting for that turn is given up instead, and the prompt goes again below.
  if (tidy) {
    if (tidy.turnId !== null) return
    tidy = null
  }
  const language = await read($, lang)
  if (!await read($, compactTidy)) { await compactNow($, note); return }
  await update($, resultCard, () => ({ stage: 'tidying' }))
  const text = t(language, 'alerts.tidyPrompt')
  const wait: Tidy = { text, note, turnId: null }
  tidy = wait
  try {
    // In the person's words, not under "the ripple plugin sent a message": it is their Compact press.
    const sent = await $.prompt.submit({ text, asUser: true })
    if ('drop' in sent) throw new Error(sent.drop)
  } catch (error) {
    // A press made while this one was in flight has taken the wait over: its outcome is not this one's.
    if (tidy !== wait) return
    tidy = null
    await tidyStopped($)
    await report($, 'compact tidy', error)
  }
}
async function openCompact($: EngineInterface, surface: Frame['surface']): Promise<void> {
  if (surface === 'terminal') { await runCompact($); return }
  await update($, compactNote, () => '')
  await update($, panel, () => 'compact')
}
async function openClear($: EngineInterface): Promise<void> {
  await update($, panel, () => 'clear')
}
/** The router's figure for this login's plan windows; nothing when the router cannot say. */
async function routerClaudeLimits($: EngineInterface): Promise<SessionRateLimit[]> {
  try {
    const status = await $.http.fetch(`${await adminUrl($)}/api/status`)
    return status.ok ? claudeLimitsFrom(JSON.parse(status.text), await $.clock.now()) : []
  } catch (error) { await report($, 'claude limits', error); return [] }
}
/** The router's figures for the Claude login (5-hour, weekly, per-model weeklies), at most one
 * status lookup a minute and only while the limits row can show them; a failure keeps the last
 * good numbers rather than blanking them. */
let routerClaudeAt = 0
let routerClaudeCache: { limits: SessionRateLimit[]; scoped: ScopedLimit[] } = { limits: [], scoped: [] }
async function routerClaude($: EngineInterface): Promise<{ limits: SessionRateLimit[]; scoped: ScopedLimit[] }> {
  const now = await $.clock.now()
  if (!(await currentSettings($)).extras.includes('limits') || now - routerClaudeAt < 60_000) return routerClaudeCache
  routerClaudeAt = now
  try {
    const status = await $.http.fetch(`${await adminUrl($)}/api/status`)
    if (status.ok) {
      const body: unknown = JSON.parse(status.text)
      routerClaudeCache = { limits: claudeLimitsFrom(body, now), scoped: claudeScopedFrom(body, now) }
    }
  } catch (error) { await report($, 'claude limits row', error) }
  return routerClaudeCache
}
/**
 * The limits row as a router that predates `GET /api/limits` still answers it: Claude's plan in the
 * unified shape, from the older `/api/status` and `/api/chatgpt-accounts` routes. Kept so the row
 * shows exactly as before until the router is restarted onto the new endpoint.
 */
async function fallbackLimits($: EngineInterface): Promise<LimitItem[]> {
  const now = await $.clock.now()
  const fromRouter = await routerClaude($)
  const claudeChat = /^claude-/.test(await $.session.model())
  // The 5-hour and the weekly (one each, the hotter reading winning when both sources name it), then
  // the per-model weeklies the router reports. Claude's plan shows whatever this chat runs on.
  const usage = claudeChat ? (await $.session.usage()).rateLimits : []
  const mains = new Map<'five_hour' | 'seven_day', SessionRateLimit>()
  for (const w of [...usage, ...fromRouter.limits]) {
    if (w.kind !== 'five_hour' && w.kind !== 'seven_day') continue
    const prev = mains.get(w.kind)
    if (!prev || w.percentUsed > prev.percentUsed) mains.set(w.kind, w)
  }
  const items: LimitItem[] = (['five_hour', 'seven_day'] as const)
    .flatMap(kind => mains.get(kind) ? [mains.get(kind)!] : [])
    .map(w => ({ provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: w.kind as 'five_hour' | 'seven_day', label: '', percent: w.percentUsed, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) }))
  for (const s of fromRouter.scoped) items.push({ provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'scoped', label: s.name, percent: s.percent, ...(s.resetsAt ? { resetsAt: s.resetsAt } : {}) })
  const admin = await adminUrl($)
  const status = await $.http.fetch(`${admin}/api/status`)
  if (status.ok) for (const provider of chatgptProviders(JSON.parse(status.text))) {
    const response = await $.http.fetch(`${admin}/api/chatgpt-accounts?provider=${encodeURIComponent(provider)}`)
    if (!response.ok) continue
    const body: unknown = JSON.parse(response.text)
    // The router answers for its first ChatGPT provider when the name is not one: not this provider.
    if (object(body).provider !== provider) continue
    items.push(...gptLimitsFrom(body, provider, now))
  }
  return items
}
/**
 * The whole limits row from the router's `GET /api/limits` — every provider whose quota it can read,
 * Claude first — at most one round a minute and only while the row can show it. On a router that
 * predates the endpoint (404) the older per-provider routes answer instead, so the row shows before
 * the router is restarted. A failure keeps the last good row rather than blanking it, and the state
 * is written only when it moved: a redraw that shows nothing new is wasted (each answer is drawn
 * afresh). Only a good read holds off the next minute, and only while there is a row: a failed read
 * stamped the minute too, and a session whose first read failed (the router restarting) showed no
 * limits row for that minute (2026-10-22).
 */
let limitsAt = 0
async function refreshLimits($: EngineInterface): Promise<void> {
  if (!(await currentSettings($)).extras.includes('limits')) return
  const now = await $.clock.now()
  if (now - limitsAt < 60_000 && await read($, limits) !== null) return
  try {
    const admin = await adminUrl($)
    const response = await $.http.fetch(`${admin}/api/limits`)
    let items: LimitItem[] | null = null
    if (response.ok) items = routerLimitItems(JSON.parse(response.text), now)
    else if (response.status === 404) items = await fallbackLimits($)
    if (!items) return
    limitsAt = now
    if (!same(items, await read($, limits))) await update($, limits, () => items)
  } catch (error) { await report($, 'limits', error) }
}
/** The estimate the band's share was last worked out from, and what it was worked out at. */
let shareMemo: { key: string; breakdown: SessionContextBreakdown | null } | null = null
/**
 * The context share the band shows: the Context pane's own figure, /context's count against the
 * window compaction measures by (`rawMaxTokens`). The band divided the last response's tokens by
 * settings.json's `autoCompactWindow`, which the running session had not taken up (2026-10-24:
 * settings said 500k, the session compacted at 400k; the band said 66%, the pane 83%). The
 * pane's precise count stands while it is fresh; else the local estimate, worked out once a
 * response, model or setting. With no breakdown (no session bound), those tokens over that setting.
 */
async function contextShare($: EngineInterface, c: SessionContextUsage): Promise<{ percent: number; tokens: number; window: number; basis: number } | null> {
  if (c.tokens === undefined) return null
  const at = await currentCompactAt($)
  const model = await $.session.model()
  const full = await read($, contextFull)
  // The count stands only where it was taken: same response, model, window and chat. A stale one
  // is discarded here as well, so the pane cannot draw it from the atom after this poll.
  const fresh = full?.breakdown && fullMark && countsHere(fullMark, c.tokens, model, at) && fullMark.window === c.window ? full : null
  if (full?.breakdown && !full.busy && !fresh) {
    fullMark = null
    await update($, contextFull, () => null)
  }
  let b = fresh?.breakdown ?? null
  if (!b) {
    const gen = generation
    const epoch = contextEpoch
    const key = [c.tokens, c.window, at, model, gen, epoch].join('|')
    if (shareMemo?.key !== key) {
      let summary: SessionContextBreakdown | null = null
      try { summary = (await $.session.usage({ breakdown: 'summary' })).context.breakdown ?? null }
      catch (error) { await report($, 'context summary', error) }
      // A clear or compaction while the summary ran outranks it: publish only for the state it was asked in.
      const modelNow = await $.session.model()
      const atNow = await currentCompactAt($)
      if (gen === generation && epoch === contextEpoch && model === modelNow && at === atNow) shareMemo = { key, breakdown: summary }
    }
    b = shareMemo?.key === key ? shareMemo.breakdown : null
  }
  if (b && b.rawMaxTokens > 0) return { tokens: b.totalTokens, percent: b.percentage, window: b.rawMaxTokens, basis: c.tokens }
  const window = contextWindow(c.window, at, modelCompactWindow(compactWindows, model))
  return window > 0 ? { tokens: c.tokens, percent: c.tokens / window * 100, window, basis: c.tokens } : null
}
async function refreshUsage($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const ctx = await contextShare($, usage.context)
  if (JSON.stringify(ctx) !== JSON.stringify(await read($, context))) await update($, context, () => ctx)
  // Below the line again (a compact, a clear), the next crossing shows the heavy-context band once.
  const putOff = await read($, swampHidden)
  if (putOff !== null && (putOff > 100 || !ctx || ctx.percent < HEAVY_PERCENT)) await update($, swampHidden, () => null)
  // The host can leave the plan windows out though the replies carried them; on a Claude chat the
  // router's figure for the same login stands in.
  const own = usage.rateLimits.some(l => ['five_hour', 'seven_day'].includes(l.kind))
  const rateLimits = own || !/^claude-/.test(await $.session.model()) ? usage.rateLimits : [...usage.rateLimits, ...await routerClaudeLimits($)]
  const h = hottest(rateLimits)
  const previous = await read($, hot)
  // A put-off lasts until the window it was put off for moves on (session.ts hotWindowMoved). A
  // put-off from an older mod carries no window: it adopts the current one.
  if (await read($, hotHidden) !== null) {
    const putOffFor = await read($, hotHiddenFor)
    if (!putOffFor) { if (h) await update($, hotHiddenFor, () => h) }
    else if (hotWindowMoved(putOffFor, h)) { await update($, hotHidden, () => null); await update($, hotHiddenFor, () => null) }
  }
  if (JSON.stringify(h) !== JSON.stringify(previous)) await update($, hot, () => h)
  const top = rateLimits.filter(l => ['five_hour', 'seven_day'].includes(l.kind)).sort((a, b) => b.percentUsed - a.percentUsed)[0]
  const l = top ? { kind: top.kind, percent: top.percentUsed, ...(top.resetsAt ? { resetsAt: top.resetsAt } : {}) } : null
  // The limits row itself is read from the router's `/api/limits` (refreshLimits); the host's own
  // windows still bind the first row's limit and the hot alert here, as they always have.
  // Check the previous binding deadline before a rolled-forward snapshot replaces it.
  await endModeIfOver($)
  if (JSON.stringify(l) !== JSON.stringify(await read($, limit))) await update($, limit, () => l)
  await endModeIfOver($)
  const until = await read($, saveUntil)
  if (until !== null && until <= await $.clock.now()) await update($, saveUntil, () => null)
}
/**
 * Redraws when the countdown's shown minute changes and at expiry (the cold alert), at no other
 * time: the desktop draws each answer afresh (see ui/band.tsx), so a redraw that shows nothing new
 * is wasted at best. With the timer not on show, only the expiry. The 15-second tick re-aims it
 * after a reply moved the expiry.
 */
async function scheduleCountdown($: EngineInterface): Promise<void> {
  const memo = await read($, cache)
  const now = await $.clock.now()
  const shown = !(await currentSettings($)).hide.includes('timer') && !await read($, bandHidden)
  const at = !memo || memo.expiresAt <= now ? null : shown ? nextMinuteChange(memo.expiresAt, now) : memo.expiresAt
  if (countdownTimer?.at === at) return
  countdownTimer?.cancel()
  countdownTimer = null
  if (at === null) return
  const timer = $.clock.after(Math.max(1, at - now), () => {
    countdownTimer = null
    void (async () => {
      await $.ui.invalidate('ui.render')
      await scheduleCountdown($)
    })().catch(error => report($, 'countdown', error))
  })
  countdownTimer = { at, cancel: () => timer.cancel() }
}
async function tick($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  if (ticking) return
  ticking = true
  try {
    await refreshUsage($)
    await refreshLimits($)
    await countAgents($)
    await scheduleCountdown($)
    if (await read($, handoff)) await driveHandoff($)
    const s = { ...await currentSettings($) }
    s.keepWarm = await keepWarmOn($, s)
    const decision = shouldPing({ settings: s, memo: await read($, cache), warm: await read($, warm), now: await $.clock.now(), idle: !await read($, busy) && !await read($, deciding) && !forking,
      // A restarted process has no live count until its next reply: the store's figure stands in.
      contextTokens: liveContextTokens((await read($, context))?.tokens, rememberedContext), lastRealReplyAt: await read($, lastRealReplyAt) })
    if (decision.ping) {
      let answer: ModelForkResult | null = null
      try { answer = await fork($, 'Reply with just: ok') }
      catch (error) { await report($, 'warm fork', error) }
      const before = await read($, warm)
      const after = afterPing(before, answer, await $.clock.now(), language)
      await update($, warm, () => after)
      if (after.stopped && !before.stopped) await $.ui.toast(t(language, 'toasts.warmStopped', { reason: after.stopped }))
      // A ping read cache tokens: the cache held while the person was away. One card counts them all
      // (a real reply or the expiry clears it; register.tsx kept), until then each ping adds up.
      const usage = answer && 'usage' in answer ? answer.usage : null
      if ((usage?.cache_read_input_tokens ?? 0) > 0) {
        await update($, kept, prev => ({
          pings: (prev?.pings ?? 0) + 1,
          tokens: usage!.cache_read_input_tokens,
        }))
      }
    } else if (s.keepWarm && !await read($, busy) && decision.reason === 'keep warm time bound reached' && !(await read($, warm)).stopped) {
      await update($, warm, value => ({ ...value, stopped: t(language, 'toasts.warmBoundReason') }))
      await $.ui.toast(t(language, 'toasts.warmBound'))
    }
  } catch (error) { await report($, 'session tick', error) }
  finally { ticking = false }
}
let inboxPolling = false
let inboxRetryAt = 0
/** A claim is never retried or submitted without a 200: a lost reply may already have claimed it. */
async function pollPhoneInbox($: EngineInterface): Promise<void> {
  if (inboxPolling) return
  inboxPolling = true
  try {
    // Only the app's own CLI process types a phone message in (measured 2026-10-27: the app sets
    // claude-desktop; the host's own runs say sdk-ts). Elsewhere this costs one env read a tick.
    if (await $.env.get('CLAUDE_CODE_ENTRYPOINT') !== 'claude-desktop') return
    if (await $.clock.now() < inboxRetryAt) return
    const session = await $.session.id()
    const admin = await adminUrl($)
    const list = await $.http.fetch(`${admin}/api/phone-inbox?session=${encodeURIComponent(session)}`)
    if (list.status !== 200) throw new Error(`inbox HTTP ${list.status}`)
    const offers = object(JSON.parse(list.text)).offers
    if (!Array.isArray(offers)) throw new Error('invalid inbox response')
    for (const raw of offers) {
      const offer = object(raw)
      if (offer.sessionId !== session || typeof offer.itemId !== 'string' || !/^[\w-]{1,100}$/.test(offer.itemId) || typeof offer.text !== 'string') throw new Error('invalid inbox offer')
      if (await $.session.id() !== session) return
      const claimAt = await $.clock.now()
      const claim = await $.http.fetch(`${admin}/api/phone-inbox/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId: offer.itemId }) })
      if (claim.status === 409) continue
      if (claim.status !== 200) throw new Error(`inbox claim HTTP ${claim.status}`)
      let outcome: 'submitted' | 'failed' = 'failed'
      try {
        const now = await $.clock.now()
        // A claim answered this late is not submitted: the host may be close to giving up on it.
        if (now >= claimAt && now - claimAt < 10_000 && await $.session.id() === session) {
          const sent = await $.prompt.submit({ text: offer.text, asUser: true })
          if (!('drop' in sent)) outcome = 'submitted'
        }
      } catch { /* The host shows the failed item for a deliberate resend. */ }
      const result = await $.http.fetch(`${admin}/api/phone-inbox/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId: offer.itemId, outcome }) })
      if (result.status !== 200) throw new Error(`inbox result HTTP ${result.status}`)
    }
    inboxRetryAt = 0
  } catch {
    inboxRetryAt = await $.clock.now() + 15_000
    // Never log a transport or submit error: it may contain the person's message.
    await report($, 'phone inbox', 'request failed')
  } finally { inboxPolling = false }
}
type SettingsHelper = { sessionId: string; permissionMode: string; readAt: number }
let settingsHelper: SettingsHelper | null = null
let jobsPolling = false
let jobsRetryAt = 0

/** The app reports metadata as JSON in an MCP text block, not as a session transcript. */
async function readSettingsHelper($: EngineInterface): Promise<SettingsHelper> {
  const answer = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
  if (answer.isError) throw new Error('session metadata unavailable')
  for (const block of answer.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const value = object(JSON.parse(block.text))
    if (typeof value.sessionId === 'string' && /^[\w-]{1,100}$/.test(value.sessionId) && typeof value.permissionMode === 'string') {
      return { sessionId: value.sessionId, permissionMode: value.permissionMode, readAt: await $.clock.now() }
    }
  }
  throw new Error('invalid session metadata')
}

async function applySettingsJob($: EngineInterface, job: { appSessionId: string; model?: string; effort?: Effort }, helper: string, claimAt: number): Promise<void> {
  for (const setting of ['model', 'effort'] as const) {
    const value = job[setting]
    if (!value) continue
    // A permission change while polling must not open an approval card on the person's screen.
    settingsHelper = await readSettingsHelper($)
    if (settingsHelper.sessionId !== helper || settingsHelper.permissionMode !== 'bypassPermissions') throw new Error('helper permissions changed')
    const now = await $.clock.now()
    if (now < claimAt || now - claimAt >= 25_000) throw new Error('claim expired')
    const answer = await $.mcp.call('ccd_session_mgmt', `set_session_${setting}`, { session_id: job.appSessionId, [setting]: value })
    if (answer.isError) throw new Error(`${setting} change failed`)
  }
}

/** Only a claimed job can change another session; a claimed job is never retried. */
async function pollSettingsJobs($: EngineInterface): Promise<void> {
  if (jobsPolling) return
  jobsPolling = true
  try {
    if (await $.env.get('CLAUDE_CODE_ENTRYPOINT') !== 'claude-desktop') return
    const now = await $.clock.now()
    if (now < jobsRetryAt) return
    if (!settingsHelper || now - settingsHelper.readAt >= 180_000 || now < settingsHelper.readAt) settingsHelper = await readSettingsHelper($)
    // Other modes can ask for approval of another session's change, which a phone user cannot answer.
    if (settingsHelper.permissionMode !== 'bypassPermissions') return
    const helper = settingsHelper.sessionId
    const admin = await adminUrl($)
    const list = await $.http.fetch(`${admin}/api/settings-jobs?exclude=${encodeURIComponent(helper)}`)
    if (list.status !== 200) throw new Error('settings jobs request failed')
    const jobs = object(JSON.parse(list.text)).jobs
    if (!Array.isArray(jobs)) throw new Error('invalid settings jobs response')
    for (const raw of jobs) {
      const job = object(raw)
      const effort = effortOf(job.effort)
      if (typeof job.jobId !== 'string' || !/^[\w-]{1,100}$/.test(job.jobId) || typeof job.appSessionId !== 'string' || !/^[\w-]{1,100}$/.test(job.appSessionId) || job.appSessionId === helper ||
          job.model !== undefined && (typeof job.model !== 'string' || !/^[\w.\-\[\]@:]{1,100}$/.test(job.model)) || job.effort !== undefined && !effort || job.model === undefined && !effort) throw new Error('invalid settings job')
      const claimAt = await $.clock.now()
      const claim = await $.http.fetch(`${admin}/api/settings-jobs/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.jobId, helper }) })
      if (claim.status === 409) continue
      if (claim.status !== 200) throw new Error('settings job claim failed')
      let outcome: 'applied' | 'failed' = 'applied'
      try { await applySettingsJob($, { appSessionId: job.appSessionId, ...(typeof job.model === 'string' ? { model: job.model } : {}), ...(effort ? { effort } : {}) }, helper, claimAt) }
      catch { outcome = 'failed'; settingsHelper = null }
      const result = await $.http.fetch(`${admin}/api/settings-jobs/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.jobId, outcome, ...(outcome === 'failed' ? { detail: 'settings change failed' } : {}) }) })
      if (result.status !== 200 || outcome === 'failed') throw new Error('settings job failed')
    }
    jobsRetryAt = 0
  } catch {
    settingsHelper = null
    jobsRetryAt = await $.clock.now() + 15_000
    // Transport and tool errors can contain private data; log neither those nor the job.
    await report($, 'settings jobs', 'request failed')
  } finally { jobsPolling = false }
}
/*
 * Keep-warm survives a restart of this session's process. The memo and the last real reply live in
 * the atoms, which are this process's memory alone; the app restarted every session's CLI at 12:06
 * on 2026-10-30, and the resumed process got no SessionStart hook before its first prompt, so
 * nothing pinged and the cache died at 12:56 though it was warm. The store keeps the same figures
 * per session id, and `session.start` takes them back.
 */
/** The context the store kept for this chat, until the live count is known again. */
let rememberedContext: number | null = null

/** Mirrors this chat's atoms into the store, dropping other chats' entries that can no longer be used. */
async function saveWarm($: EngineInterface, model: string): Promise<void> {
  const memo = await read($, cache)
  const replyAt = await read($, lastRealReplyAt)
  if (!memo || replyAt === null) return
  try {
    const now = await $.clock.now()
    const key = cacheMemoryKey(await $.session.id())
    const tokens = liveContextTokens((await read($, context))?.tokens, rememberedContext)
    const value: CacheMemory = { memo, lastRealReplyAt: replyAt, contextTokens: tokens, model }
    await $.store.set(key, value)
    for (const other of await $.store.keys()) {
      if (other === key || !other.startsWith(CACHE_MEMORY_PREFIX)) continue
      if (staleMemory(await $.store.get(other), now)) await $.store.delete(other)
    }
  } catch (error) { await report($, 'keep warm store', error) }
}
/** This chat's entry goes with its atoms (a /clear, a model change): nothing of it can be pinged for again. */
async function forgetWarm($: EngineInterface): Promise<void> {
  rememberedContext = null
  try { await $.store.delete(cacheMemoryKey(await $.session.id())) } catch (error) { await report($, 'keep warm store', error) }
}
/**
 * Takes this chat's keep-warm back after a restart: only this model's memo, and only while its cache
 * still holds (a restart, like a ping, never revives an expired cache). Anything else is dropped.
 */
async function restoreWarm($: EngineInterface): Promise<void> {
  if (await read($, cache)) return
  const key = cacheMemoryKey(await $.session.id())
  const value = await $.store.get(key)
  if (value === undefined) return
  const kept = savedMemory(value, await $.session.model(), await $.clock.now())
  if (!kept) { await $.store.delete(key); return }
  rememberedContext = kept.contextTokens
  await update($, cache, () => kept.memo)
  await update($, lastRealReplyAt, () => kept.lastRealReplyAt)
}
function startTimers($: EngineInterface): void {
  if (timersStarted) return
  timersStarted = true
  $.clock.after(1, async () => { await refreshRouter($); await tick($) })
  $.clock.every(1500, async () => { await pollPhoneInbox($) })
  $.clock.every(3000, async () => { await pollSettingsJobs($) })
  $.clock.every(3000, async () => { await refreshRouter($) })
  $.clock.every(15000, async () => { await tick($) })
  $.clock.every(1000, async () => { await agentsClock($) })
}
/**
 * The Agents pane's clocks: each second an agent or a background task runs while the pane is open,
 * one write that only the pane reads, so its elapsed times tick and nothing else redraws.
 */
async function agentsClock($: EngineInterface): Promise<void> {
  try {
    if (!(await read($, agents)).some(a => a.state === 'running') && !(await read($, bgTasks)).some(task => task.state === 'running')) return
    if (!(await $.ui.panes()).some(p => p.id === AGENTS_PANE)) return
    await update($, agentsTick, n => n + 1)
  } catch (error) { await report($, 'agents clock', error) }
}

/**
 * A command or watch the call left in the background starts a task, from the moment the call began
 * (one the person sent there with Ctrl+B ran before); a TaskStop that answered ends one.
 */
async function noteTask($: EngineInterface, e: ToolCallInput, answer: ToolCallResult, started: number): Promise<void> {
  if (answer.deny !== undefined || answer.isError) return
  if (e.tool === 'TaskStop') {
    const id = (answer.result as { task_id?: unknown } | undefined)?.task_id
    if (typeof id === 'string' && (await read($, bgTasks)).some(task => task.id === id && task.state === 'running')) {
      const now = await $.clock.now()
      await update($, bgTasks, list => stopTask(list, id, now))
    }
    return
  }
  const task = taskStarted(e.tool, e, answer.result, e.agentId, started)
  if (task) await update($, bgTasks, list => addTask(list, task))
}

/** The tasks a notification reports as ended, ended: written only when one of ours does. */
async function endBackground($: EngineInterface, text: string): Promise<void> {
  const ends = taskEnds(text)
  if (!ends.length) return
  const now = await $.clock.now()
  const list = await read($, bgTasks)
  const next = endTasks(list, ends, now)
  if (!same(next, list)) await update($, bgTasks, () => next)
}

/**
 * The band's agent counts, written only when one moves. The agent list changes on every step and
 * tool call of every agent, and a band that read it redrew with each, starting its motion over.
 */
async function countAgents($: EngineInterface): Promise<void> {
  const list = await read($, agents)
  const counts = { live: list.filter(a => a.state === 'running').length, total: list.length }
  if (!same(counts, await read($, agentCounts))) await update($, agentCounts, () => counts)
}
/**
 * Finished records the session keeps. A flat cap over the whole list dropped the oldest running
 * worker as soon as 41 ran at once (2026-10-25): its card, the band's live count and every later
 * step's tokens and effort went with it. Running and waiting records are never dropped; only the
 * oldest finished ones are, newest first, and their order among the rest does not move.
 */
const AGENTS_KEPT = 40
function retainAgents(list: AgentRec[]): AgentRec[] {
  // A record saved before the waiting state was retired may still say so until it is read back.
  const ended = list.filter(a => a.state !== 'running' && String(a.state) !== 'waiting')
  const over = ended.length - AGENTS_KEPT
  if (over <= 0) return list
  const drop = new Set(ended.slice().sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt)).slice(0, over).map(a => a.id))
  return list.filter(a => !drop.has(a.id))
}
async function dashboard($: EngineInterface, working: boolean): Promise<DashboardView> {
  const s = await currentSettings($)
  const p = await read($, pick)
  const counts = await read($, agentCounts)
  const record = await read($, last)
  const saving = (await read($, saveUntil) ?? 0) > await $.clock.now()
  const l = await read($, limit)
  const w = await read($, warm)
  const pinned = await read($, delegationPin)
  return {
    effort: { level: p?.effort ?? effortOf(await read($, appEffort)) ?? null,
      mode: await read($, deciding) ? 'deciding' : await read($, paused) ? 'paused' : p?.by === 'manual' ? 'manual' : s.effortAuto ? 'auto' : 'off',
      ...(p?.why ? { why: p.why, by: p.by } : {}), ...(await read($, decidingSince) !== null ? { since: (await read($, decidingSince))! } : {}) },
    model: await read($, modelIs) ? modelName((await read($, modelIs))!) : null,
    context: await read($, context), cache: await read($, cache), warm: { ...w, on: await keepWarmOn($, s), ...(await read($, warmHere) !== null ? { here: true } : {}) },
    limit: l ? { ...l, save: saving } : null, route: record ? routeOf(record) : null, notice: await read($, line),
    limits: await read($, limits) ?? [],
    auto: s.effortAuto,
    agents: counts,
    compactions: await read($, compactions),
    logOpen: await read($, logOpen), agentsOpen: await read($, agentsOpen), effortMenu: await read($, effortMenuOpen),
    hide: s.hide, extras: s.extras, isWorking: working,
    ...(activeModeOf(s) ? { mode: activeModeOf(s)!.name } : {}),
    ...(pinned ? { delegationPin: titleName(pinned.model, await read($, routerModels)), ...(pinned.said ? { delegationSaid: pinned.said } : {}) } : {}),
  }
}
async function settingsView($: EngineInterface): Promise<SettingsView> {
  return { settings: await currentSettings($), jev: await read($, jev), ladder: await read($, ladderOptions) }
}
async function frameOf($: EngineInterface, e: RenderInput): Promise<Frame> {
  const s = await currentSettings($)
  const columns = 'bodyColumns' in e.props ? e.props.bodyColumns : e.viewport?.columns ?? 100
  const maxRows = 'maxRows' in e.props ? e.props.maxRows : 'scroll' in e.props ? e.props.scroll.bodyRows : 1
  const offset = 'scroll' in e.props && !('maxRows' in e.props) ? e.props.scroll.offset : undefined
  return { surface: e.surface, columns, maxRows, ...(offset ? { offset } : {}), now: await $.clock.now(), appearance: s.appearance, skin: s.skin, lang: await read($, lang) }
}
async function alertView($: EngineInterface, now: number): Promise<AlertView | null> {
  const language = await read($, lang)
  const s = await currentSettings($)
  const c = await read($, context)
  const m = await read($, cache)
  const h = await read($, hot)
  const writing = await read($, handoff)
  const result = await read($, resultCard)
  const downReason = await read($, judgeDown)
  const d = await read($, demo)
  const which = bandPriority({ panel: await read($, panel), judgeDown: d === 'down' || (!!downReason && downReason !== await read($, judgeDownHidden)),
    hot: d === 'hot' || hotAlert(h, await read($, hotHidden)), result: !!writing || !!result,
    cold: d === 'cold' || coldAlert(m, c?.tokens ?? 0, now, await read($, coldHidden)),
    kept: d === 'kept' || keptAlert(await read($, kept), m, now),
    swamp: d === 'swamp' || (s.swampAlert && !await read($, busy) && swampAlert(swamped(c), await read($, swampHidden))) })
  if (which === 'compact') return { kind: 'compactNote', draft: await read($, compactNote), tidy: await read($, compactTidy) }
  if (which === 'clear') return { kind: 'clear' }
  if (which === 'judgeDown') return { kind: 'judgeDown', judge: s.judge, reason: d === 'down' ? t(language, 'alerts.demoDown') : downReason!, network: d !== 'down' && await read($, judgeDownNetwork) }
  if (which === 'hot') return { kind: 'hot', limitKind: h?.kind ?? 'five_hour', percent: d === 'hot' ? 86 : h!.percent, resetsAt: h?.resetsAt, save: (await read($, saveUntil) ?? 0) > now }
  if (which === 'result') {
    if (!writing) return { kind: 'result', ...result! }
    const stage = writing.stage === 'writing' ? 'handingOff' : writing.stage === 'failed' ? 'failed' : 'handoffDone'
    const detail = writing.stage === 'copied' ? t(language, 'alerts.copied') : writing.stage === 'opened' ? t(language, 'alerts.openedBody') : undefined
    return { kind: 'result', stage, ...(detail ? { detail } : {}) }
  }
  if (which === 'cold') return { kind: 'cold', tokens: d === 'cold' ? 180000 : c!.tokens, idleMinutes: m ? Math.round((now - m.lastReplyAt) / 60000) : 61 }
  if (which === 'kept') {
    const k = d === 'kept' ? { pings: 2, tokens: 312000 } : (await read($, kept)) ?? { pings: 0, tokens: 0 }
    return { kind: 'kept', pings: k.pings, tokens: k.tokens, minutesLeft: Math.ceil(((d === 'kept' ? now + 47 * 60000 : m!.expiresAt) - now) / 60000) }
  }
  if (which === 'swamp') return { kind: 'swamp', percent: d === 'swamp' ? 65 : c!.percent, tokens: d === 'swamp' ? 160000 : c!.tokens }
  return null
}
/**
 * A prompt sent while the cold, kept, heavy or hot band shows counts as having seen it: it comes
 * back only on its own next occasion (the next expiry, one more ping, 15 more points of context,
 * 10 more of the plan window), never after every message.
 */
async function markSeen($: EngineInterface): Promise<void> {
  const view = await alertView($, await $.clock.now())
  if (view && (view.kind === 'cold' || view.kind === 'kept' || view.kind === 'swamp' || view.kind === 'hot')) await dismiss($, view)
}
async function dismiss($: EngineInterface, view: AlertView): Promise<void> {
  await update($, demo, () => null)
  if (view.kind === 'hot') {
    const current = await read($, hot)
    await update($, hotHidden, () => view.percent)
    await update($, hotHiddenFor, () => current)
  } else if (view.kind === 'cold') await update($, coldHidden, () => true)
  else if (view.kind === 'kept') await update($, kept, () => null)
  else if (view.kind === 'swamp') await update($, swampHidden, () => view.percent)
  else if (view.kind === 'judgeDown') await update($, judgeDownHidden, () => view.reason)
  else if (view.kind === 'result') { await update($, resultCard, () => null); await update($, handoff, () => null) }
  else await update($, panel, () => null)
}
function bandActions($: EngineInterface, surface: Frame['surface']): BandActions {
  return { toggleAuto: () => toggleAuto($), toggleWarm: () => toggleWarm($), compact: () => openCompact($, surface), clear: () => openClear($), handoff: () => queueHandoff($), toggleLog: () => toggleLog($), toggleAgents: () => toggleAgents($), openSettings: () => startPanel($, 'settings'),
    toggleEffortMenu: () => update($, effortMenuOpen, value => !value), pickEffort: effort => manualPick($, effort), releaseDelegationPin: () => releaseDelegationPin($), toggleContext: () => toggleContext($), toggleLimits: () => toggleLimits($) }
}
function settingsActions($: EngineInterface): SettingsActions {
  return { patch: async change => {
      const s = await currentSettings($)
      const saved = await saveSettings($, { ...s, ...change }, s)
      if (change.judge || change.jevSource) await jevKey($)
      if (!saved) await $.ui.toast(t(await read($, lang), 'band.routerDown'))
    },
    jevKey: async key => { try { await saveJevKey($, key) } catch (error) { await $.ui.toast(t(await read($, lang), 'toasts.error', { reason: reason(error) })) } }, testJev: () => testJudge($),
    setMode: id => setMode($, id),
    openAllSettings: () => openAllSettings($), close: async () => { await update($, panel, () => null); await update($, settingsDraft, () => null); await update($, settingsBase, () => null) } }
}
function setupActions($: EngineInterface): SetupActions {
  const a = settingsActions($)
  return { patch: change => patchDraft($, change), jevKey: a.jevKey, testJev: a.testJev, openAllSettings: a.openAllSettings,
    back: () => update($, setupStep, step => Math.max(1, step - 1) as 1 | 2 | 3 | 4), next: () => update($, setupStep, step => Math.min(4, step + 1) as 1 | 2 | 3 | 4), finish: () => finishSetup($), skip: () => finishSetup($, true) }
}
function alertActions($: EngineInterface, view: AlertView): AlertActions {
  return { compact: note => runCompact($, note), clear: async () => { await update($, panel, () => null); await $.command.run({ command: 'clear', args: '' }) }, dismiss: () => dismiss($, view), toggleSave: () => toggleSave($), openSettings: () => startPanel($, 'settings'),
    noteInput: text => update($, compactNote, () => text), toggleTidy: () => update($, compactTidy, value => !value), copy: () => copyHandoff($) }
}
function agentsActions($: EngineInterface): AgentsActions {
  return {
    toggleDone: () => update($, agentsShowDone, value => !value),
    // The app's own agent view first, as the person's pick from its task list opens it (2026-10-24:
    // ours, drawn after it, did not read like it). One the host refuses (a workflow's agent no list
    // names, a host with no main view: the desktop's headless session, always) is read here
    // instead. Opened, a conversation shows its newest: the pane goes to its end, and `end` keeps up
    // with the tree as the agent adds to it until the person scrolls away (UiScrollTarget). A
    // surface that cannot scroll leaves it where it is.
    open: async id => {
      try {
        const viewed = await $.ui.view({ agentId: id })
        if (!viewed.deny) return
        await report($, 'agents view', viewed.deny)
      } catch (error) { await report($, 'agents view', error) }
      await update($, agentRunsOpen, () => [])
      // An explicit open reads the conversation now, even if it was read before: the host may have
      // kept what it says more up to date than this pane's last draw.
      agentTalkCache = null
      await update($, agentOpen, () => id)
      try {
        const moved = await $.ui.scroll({ in: AGENTS_PANE, to: 'end' })
        if (moved.deny) await report($, 'agents scroll', moved.deny)
      } catch (error) { await report($, 'agents scroll', error) }
    },
    // Back on the list, the runs unfolded in that conversation fold again: it opens folded next time.
    back: async () => { await update($, agentRunsOpen, () => []); await update($, agentOpen, () => null) },
    toggleRun: id => update($, agentRunsOpen, ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]),
  }
}
/**
 * An agent's conversation for the Agents pane, read again at each draw: its steps and tool calls
 * redraw the pane while it runs, so what it says shows as it says it. Paths in its tool calls read
 * relative to the session's folder, or under `~`.
 *
 * A finished agent's conversation cannot change, so it is read once: the pane's clock ticks for
 * whichever agent is still running, and the open one being finished changed nothing it shows (B19).
 */
async function agentTalk($: EngineInterface, id: string, record?: AgentRec): Promise<AgentTalk> {
  // An instruction received after the agent ended still changes what its conversation shows.
  const key = record ? `${record.state}:${record.endedAt ?? 0}:${record.tools}:${record.instructions?.length ?? 0}` : 'unknown'
  if (record && record.state !== 'running' && agentTalkCache?.id === id && agentTalkCache.key === key) return agentTalkCache.talk
  try {
    const found = await $.session.messages({ agentId: id })
    if (!Array.isArray(found)) return { deny: found.deny }
    const cwd = await $.session.cwd().catch(() => undefined)
    const instructions = record?.instructions ?? (await read($, agents)).find(a => a.id === id)?.instructions ?? []
    const talk: AgentTalk = { entries: talkOf(found, { ...(cwd ? { cwd } : {}), home: await userHome($) }, instructions) }
    if (record && record.state !== 'running') agentTalkCache = { id, key, talk }
    else if (agentTalkCache?.id === id) agentTalkCache = null
    return talk
  } catch (error) { return { deny: reason(error) } }
}
/** What an agent is doing, in the words its conversation's tool rows use (tools.ts toolDetail): no leading `cd`, paths short. */
async function toolLine($: EngineInterface, e: ToolCallInput): Promise<string> {
  const cwd = await $.session.cwd().catch(() => undefined)
  return `${e.tool} ${toolDetail(e.tool, object(e), { ...(cwd ? { cwd } : {}), home: await userHome($) })}`.trim().slice(0, 70)
}
async function prepareStep($: EngineInterface, e: TurnStepInput): Promise<TurnStepInput> {
  const language = await read($, lang)
  if (e.agentId) {
    const a = (await read($, agents)).find(a => a.id === e.agentId)
    return a?.pick && (a.pick.target.agent === 'general-purpose' || a.type === 'ripple:auto') ? { ...e, effort: a.pick.effort } : e
  }
  const previousModel = await read($, modelIs)
  const oldEffort = await read($, appEffort)
  const changedModel = previousModel !== e.model
  if (changedModel) {
    await update($, modelIs, () => e.model)
    await update($, appEffort, () => e.effort ?? null)
    // A precise count belongs to the model it counted.
    contextRun += 1
    fullMark = null
    await update($, contextFull, () => null)
    if (previousModel !== null) {
      await update($, cache, () => null)
      await update($, lastRealReplyAt, () => null)
      await forgetWarm($)
      if (await read($, kept)) await update($, kept, () => null)
    }
  }
  const safe = isCacheSafeModel(e.model)
  if (await read($, paused) !== !safe) await update($, paused, () => !safe)
  let s = await currentSettings($)
  if ((changedModel || oldEffort === null) && carriedPick) {
    carriedPick = false
    const level = effortOf(e.effort)
    const carried = await read($, pick)
    if (!s.effortAuto && carried?.by === 'manual' && level && carried.effort !== level) {
      await installPick($, { effort: level, by: 'manual', why: t(language, 'toasts.appEffort'), at: await $.clock.now() })
    }
  }
  if (!changedModel && oldEffort !== null && e.effort !== undefined && oldEffort !== e.effort) {
    await update($, appEffort, () => e.effort ?? null)
    await saveSettings($, { ...s, effortAuto: false })
    const level = effortOf(e.effort)
    if (level) await installPick($, { effort: level, by: 'manual', why: t(language, 'toasts.appEffortChanged'), at: await $.clock.now() })
    await $.ui.toast(t(language, 'toasts.autoOff'))
    return e
  }
  if (!changedModel && oldEffort === null && e.effort !== undefined) await update($, appEffort, () => e.effort!)
  s = await currentSettings($)
  const p = await read($, pick)
  if (!await read($, busy)) await update($, busy, () => true)
  if (!safe || !p || (!s.effortAuto && p.by !== 'manual')) return e
  const saving = s.effortAuto && (await read($, saveUntil) ?? 0) > await $.clock.now()
  return { ...e, effort: saving && EFFORTS.indexOf(p.effort) > EFFORTS.indexOf('medium') ? 'medium' : p.effort }
}

async function agentsRenderFailure($: EngineInterface, e: RenderInput, error: unknown, context: { frame?: Frame; records?: readonly AgentRec[]; wasOpen?: boolean } = {}): Promise<RenderElement> {
  // Never re-read the failing state/clock here. This also serves the engine's .catch after it
  // refused an answer, when no successful snapshot is available.
  const frame: Frame = context.frame ?? { surface: e.surface, columns: 'bodyColumns' in e.props ? e.props.bodyColumns : 80, maxRows: 30, now: 0, lang: 'en', appearance: 'auto', skin: 'flat' }
  const failure = reason(error)
  await report($, 'agents render', error, frame.lang)
  return renderAgentsFallback($.ui.resolve(e), frame, context.records ?? [], failure, { ...agentsActions($), close: () => $.ui.close({ id: AGENTS_PANE }) }, context.wasOpen ?? false) as RenderElement
}

/** The Context pane's last resort: its error and its way out; never reads state or the clock. */
async function contextRenderFailure($: EngineInterface, e: RenderInput, error: unknown, frame?: Frame): Promise<RenderElement> {
  const f: Frame = frame ?? { surface: e.surface, columns: 'bodyColumns' in e.props ? e.props.bodyColumns : 80, maxRows: 30, now: 0, lang: 'en', appearance: 'auto', skin: 'flat' }
  await report($, 'context render', error, f.lang)
  return renderContextFallback($.ui.resolve(e), f, reason(error), () => $.ui.close({ id: CONTEXT_PANE })) as RenderElement
}

/** The limits pane's last resort: its error and its way out; never reads state or the clock. */
async function limitsRenderFailure($: EngineInterface, e: RenderInput, error: unknown, frame?: Frame): Promise<RenderElement> {
  const f: Frame = frame ?? { surface: e.surface, columns: 'bodyColumns' in e.props ? e.props.bodyColumns : 80, maxRows: 30, now: 0, lang: 'en', appearance: 'auto', skin: 'flat' }
  await report($, 'limits render', error, f.lang)
  return renderLimitsFallback($.ui.resolve(e), f, reason(error), () => $.ui.close({ id: LIMITS_PANE })) as RenderElement
}

/** State-independent last resort for every non-agent surface; never reads state or the clock. */
async function renderFailure($: EngineInterface, e: RenderInput, error: unknown, language: Lang = 'en', engine?: RenderNode): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const close = e.component === 'Pane' ? () => $.ui.close({ id: LOG_PANE }) : e.component === 'SessionMode' ? () => toggleBar($) : () => update($, panel, () => null)
  await report($, e.component + ' render', error, language)
  return (
    <Box flexDirection="column" rowGap={1} width="100%">
      <Box flexDirection="row" columnGap={1}>
        <Text bold>{t(language, 'band.brand')}</Text>
        <Button key="settings" plain label={t(language, 'band.settings')} onPress={() => openAllSettings($)} />
        <Button key="close" plain role="dismiss" label={t(language, 'settings.close')} onPress={close} />
      </Box>
      <Text wrap="wrap">{displayText(reason(error))}</Text>
      {engine ?? null}
    </Box>
  ) as RenderElement
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    jevBlips = 0
    try {
      // A failure here must not cost the commands: without them there is no /ripple to look with.
      try { await loadSettings($); await $.ui.status(undefined) }
      catch (error) { await report($, 'session.start settings', error) }
      // Session atoms survive hot reloads: an old eight-second classification is still active work.
      if ((await read($, agents)).some(a => String(a.state) === 'waiting')) await update($, agents, list => list.map(a => String(a.state) === 'waiting' ? { ...a, state: 'running' } : a))
      const language = await read($, lang)
      await $.command.register({ name: 'ripple', description: t(language, 'commands.description'), argumentHint: t(language, 'commands.argumentHint'), immediate: true })
      await $.command.register({ name: 'ripple-log', description: t(language, 'commands.logDescription'), immediate: true })
      await $.command.register({ name: 'ripple-bar', description: t(language, 'commands.barDescription'), immediate: true })
      // loadSettings skips the install when an earlier poll already took this revision, and that
      // poll may have run before the session bound: register here, where it is bound.
      await registerAuto($, await currentSettings($))
      // The session's own process may be a restart of a warm chat: take its keep-warm back first,
      // so the first tick already has a memo to ping for.
      try { await restoreWarm($) } catch (error) { await report($, 'session.start keep warm', error) }
      startTimers($)
      // Setup keeps its draft across a reload; quick settings never keep one.
      let open = await read($, panel)
      // A setup card kept from a reload while setup is done (left by a router outage) goes.
      if (open === 'setup' && (await currentSettings($)).setupDone) {
        await update($, panel, () => null)
        await update($, settingsDraft, () => null)
        await update($, settingsBase, () => null)
        open = null
      }
      if (open === 'setup') await rebaseDraft($)
      if ((await currentSettings($)).judge === 'jev' && (await read($, jev)).source === null) await jevKey($)
      if (open === 'settings') { await update($, settingsDraft, () => null); await update($, settingsBase, () => null); await jevKey($) }
      if (!(await currentSettings($)).setupDone && !open) await startPanel($, 'setup')
    } catch (error) { await report($, 'session.start', error) }
    return result
  })
  on('session.end', async ($, e, next) => {
    await update($, delegationPin, () => null)
    await update($, heardPrompts, () => [])
    return next(e)
  })
  on('classic.SessionStart', async ($, e, next) => {
    try {
      if (['clear', 'resume', 'fork'].includes(e.source)) {
        generation++
        judgeSequence++
        // A count that started in the old chat must not land in this one.
        contextRun += 1
        fullMark = null
        await update($, contextFull, () => null)
        await loadSettings($)
        await update($, busy, () => false)
        await update($, appEffort, () => null)
        await update($, heldPick, () => null)
        await update($, deciding, () => false)
        if (e.source === 'clear') {
          await update($, cache, () => null)
          await update($, context, () => null)
          await update($, lastRealReplyAt, () => null)
          await forgetWarm($)
          if (await read($, kept)) await update($, kept, () => null)
          await update($, compactions, () => 0)
        }
        if (e.model) await update($, modelIs, () => e.model!)
        await update($, paused, () => e.model ? !isCacheSafeModel(e.model) : false)
      }
      if (['resume', 'fork'].includes(e.source)) {
        const now = await $.clock.now()
        const current = await read($, cache)
        const offered = restoreFromResume(e.seconds_since_last_response, e.prompt_cache_likely_expired, current?.ttlMs ?? 3600000, now)
        // A memo a ping refreshed can outlive the figure a resume counts from (laterMemo).
        const memo = laterMemo(current, offered, now)
        if (memo !== current) {
          await update($, cache, () => memo)
          await update($, lastRealReplyAt, () => memo?.lastReplyAt ?? null)
        }
        if (memo && memo.expiresAt > now) await saveWarm($, e.model ?? await $.session.model())
        else await forgetWarm($)
      }
      startTimers($)
    } catch (error) { await report($, 'classic.SessionStart', error) }
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    // A task the session no longer holds in flight has ended, though no notice of it reached us (yet).
    // A Stop that carries no list (an older engine) settles nothing.
    try {
      if (e.background_tasks) {
        const inFlight = e.background_tasks.map(task => task.id)
        const list = await read($, bgTasks)
        if (list.some(task => task.state === 'running' && !inFlight.includes(task.id))) {
          const now = await $.clock.now()
          await update($, bgTasks, tasks => settleTasks(tasks, inFlight, now))
        }
      }
    } catch (error) { await report($, 'classic.Stop', error) }
    return next(e)
  })
  on('session.receive', { origin: { kind: 'coordinator' } }, async ($, e, next) => {
    if (!e.agentId) return next(e)
    const epoch = generation
    const work = receiveWork.then(async () => {
      if (epoch !== generation) return
      const found = await $.session.messages({ agentId: e.agentId })
      if (!Array.isArray(found)) throw new Error(found.deny)
      if (epoch !== generation) return
      // This event precedes queueing, not model consumption. SessionMessage has no stable id;
      // the visible row count is an approximate receipt position, never a delivery assertion.
      await update($, agents, list => list.map(a => {
        if (a.id !== e.agentId || epoch !== generation) return a
        const previous = a.instructions ?? []
        return { ...a, instructions: [...previous, { text: e.text, after: found.length, ordinal: (previous.at(-1)?.ordinal ?? 0) + 1 }].slice(-20) }
      }))
    })
    receiveWork = work.then(() => undefined, () => undefined)
    // The message goes on at once: recording it reads the agent's transcript, and a slow or broken
    // read must never hold the instruction back from the agent.
    void work.catch(error => report($, 'agent instruction', error).catch(() => undefined))
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    // A background task's notification says it ended, and how (tasks.ts taskEnds).
    if (e.origin.kind === 'task-notification') {
      try { await endBackground($, e.text) } catch (error) { await report($, 'prompt.submit tasks', error) }
    }
    const sequence = ++judgeSequence
    // The eager mode's note, beside every prompt while eager (modes.ts eagerNote): sent only once it
    // gets buried in a long context.
    let note: string | undefined
    try {
      const s = await currentSettings($)
      const model = await $.session.model()
      if (await read($, paused) !== !isCacheSafeModel(model)) await update($, paused, () => !isCacheSafeModel(model))
      const messages = await $.session.messages()
      const current = await read($, pick)
      const assistant = messages.findLast(m => m.role === 'assistant')?.text.slice(-2000) ?? ''
      let hostCommand = false
      if (e.text.trim().startsWith('/')) {
        const name = e.text.trim().split(/\s+/)[0]!.slice(1)
        const command = (await $.command.list()).find(c => c.name === name)
        hostCommand = !command || command.source === 'builtin' || name.startsWith('ripple')
      }
      const human = ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
      if (human && !hostCommand) {
        const own = !e.isMeta && !e.command ? humanText({ role: 'user', text: e.text }) : null
        if (own) {
          await hearDelegationPin($, own)
          await update($, heardPrompts, list => [...list, own].slice(-2))
        }
        await markSeen($)
        await endModeIfOver($)
        const noted = await read($, modeNoted)
        const eager = eagerNote(await currentSettings($), noted)
        if (eager.noted !== noted) await update($, modeNoted, () => eager.noted)
        note = eager.note
      }
      if (shouldJudge({ text: e.text, origin: e.origin.kind, auto: s.effortAuto, modelId: model, hostCommand, current, attachments: e.attachments, assistantTail: assistant })) {
        const now = await $.clock.now()
        await update($, decidingSince, () => now)
        await update($, deciding, () => true)
        const c = await read($, context)
        const input: JudgeInput = { messages, next: e.text, attachments: e.attachments, current: { model, effort: current?.effort ?? effortOf(await read($, appEffort)) ?? 'medium' }, contextPercent: c?.percent, midTurn: !!e.turnId }
        const judged = await judge($, s, input)
        if (sequence === judgeSequence && (await currentSettings($)).effortAuto && judged.verdict) {
          const final = finalEffort(judged.verdict, s, (await read($, saveUntil) ?? 0) > await $.clock.now(), await read($, lang))
          const value: Pick = { ...judged.verdict, ...final, by: judged.by, at: await $.clock.now() }
          if (e.turnId && current && EFFORTS.indexOf(value.effort) < EFFORTS.indexOf(current.effort)) await update($, heldPick, () => value)
          else { await update($, heldPick, () => null); await installPick($, value) }
          await update($, stats, old => addPrompt(old, value.effort))
        }
      } else if (human && !hostCommand && s.effortAuto && current && isCacheSafeModel(model)) {
        await update($, stats, old => addPrompt(old, current.effort))
      }
      if (!hostCommand && !await read($, busy)) await update($, busy, () => true)
    } catch (error) { await report($, 'prompt.submit', error) }
    finally { if (sequence === judgeSequence && await read($, deciding)) await update($, deciding, () => false) }
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })
  on('turn.step', async function* ($, e, next) {
    const ownFork = forking && !e.agentId
    const epoch = generation
    let request = e
    try {
      if (!ownFork) request = await prepareStep($, e)
      const sent = { model: request.model, appEffort: e.effort, sentEffort: request.effort }
      if (!e.agentId && !ownFork && !same(await read($, lastRequest), sent)) await update($, lastRequest, () => sent)
    } catch (error) { request = e; await report($, 'turn.step prepare', error) }
    const answer = yield* next(request)
    try {
      if (epoch !== generation) return answer
      if (ownFork) { if (answer.usage) forkUsage = answer.usage; return answer }
      if (e.agentId && answer.usage) {
        const effort = sentEffort(request.model, request.effort)
        await update($, agents, list => list.map(a => a.id === e.agentId ? addAgentStep(a, answer.usage!, effort) : a))
      } else if (!e.agentId && answer.usage) {
        const now = await $.clock.now()
        if (answer.usage.model === await $.session.model()) {
          const memo = nextMemo(await read($, cache), answer.usage, now)
          await update($, cache, () => memo)
          if (await read($, coldHidden)) await update($, coldHidden, () => false)
          if (await read($, kept)) await update($, kept, () => null)
          await update($, lastRealReplyAt, () => now)
          await saveWarm($, answer.usage.model)
          if ((await read($, warm)).stopped !== undefined) await update($, warm, value => ({ ...value, stopped: undefined }))
        }
        const p = await read($, pick)
        if (p && (await currentSettings($)).effortAuto && isCacheSafeModel(request.model)) await update($, stats, value => addRequest(value, answer.usage!, effortOf(request.effort) ?? p.effort))
      }
    } catch (error) { await report($, 'turn.step record', error) }
    return answer
  })
  on('turn.start', ($, e, next) => {
    // The Compact press's tidy prompt becomes a turn of its own; its id is how its end is told from
    // every other turn's (a prompt queued before it, or one the person types next).
    if (tidy && tidy.turnId === null && !e.agentId && e.text.includes(tidy.text)) tidy.turnId = e.turnId
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    try {
      if (!e.agentId && tidy?.turnId === e.turnId) {
        const note = tidy.note
        tidy = null
        // The compaction runs from a tick of its own, not inside this turn's hooks.
        if (e.reason === 'answer') void $.clock.after(1, async () => { await compactNow($, note) })
        else await tidyStopped($)
      }
      if (e.agentId) {
        const now = await $.clock.now()
        const before = (await read($, agents)).find(a => a.id === e.agentId)
        const state = e.reason === 'answer' ? 'done' : 'failed'
        const outcome = { type: 'outcome', agent: e.agentId, at: new Date(now).toISOString(), reason: e.reason, aborted: e.isAborted, ms: e.durationMs, answerChars: e.answer.trim().length }
        if (!before) {
          endedEarly.set(e.agentId, { state, endedAt: now, outcome })
          // Forks and other loops no spawn records end here too: only the latest few are kept.
          for (const id of endedEarly.keys()) if (endedEarly.size > 40) endedEarly.delete(id)
        }
        await update($, agents, list => retainAgents(list.map(a => a.id === e.agentId ? { ...a, state, endedAt: now, now: undefined, toolSince: undefined } : a)))
        await countAgents($)
        // Its commands bound to its final response end with it; no notification follows them.
        if ((await read($, bgTasks)).some(task => task.agentId === e.agentId && task.endsWithAgent && task.state === 'running')) await update($, bgTasks, list => endWithAgent(list, e.agentId!, now))
        // A picked worker's outcome, once, joined to its pick by id: whether the session's tier or
        // the named model was enough is read from these lines later (2026-10-24).
        if (before?.pick?.id && before.state === 'running') {
          await persistWorkerPick($, { ...outcome, pick: before.pick.id, model: before.model ?? null, cost: before.cost })
        }
      } else if (!forking) {
        if (await read($, busy)) await update($, busy, () => false)
        const held = await read($, heldPick)
        if (held && (await currentSettings($)).effortAuto) await installPick($, held)
        await update($, heldPick, () => null)
      }
    } catch (error) { await report($, 'turn.complete', error) }
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    // A resumed run's content is pinned by the engine, including its model and title.
    if (e.resume) return next(e)
    let input = e
    let chosen: WorkerPick | undefined
    // Forks, workflows, teammates, Claude Code's own agents and other plugins' agents are the
    // engine's to start. Only a spawn this mod routes or corrects must fail closed when its policy
    // cannot be read: running it exactly as sent is how a model reason and a switched-off provider
    // were bypassed (2026-10-25).
    const workflow = 'workflow' in e && !!e.workflow
    const teammate = 'isTeammate' in e && !!e.isTeammate
    const ours = !e.fork && !workflow && !teammate && !NATIVE_AGENTS.includes(e.subagentType) &&
      (!e.subagentType.includes(':') || ['ripple:auto', 'auto'].includes(e.subagentType))
    let language: Lang = 'en'
    try { language = await read($, lang) } catch { /* the refusal below falls back to English */ }
    try {
      // Only the main chat delegates. A worker that starts its own worker waits on it idle, and a
      // Claude worker's 5-minute cache lapses meanwhile: 324k tokens rewritten in one request after
      // an 8.5-minute wait on 2026-10-11. Forks, workflows and teammates are the engine's, not this.
      if (e.parentAgentId && !e.fork && !workflow && !teammate) return { deny: t(language, 'workers.nested') }
      const s = await currentSettings($)
      // Named workers and project agents are routed too; native helpers stay native (2026-10-24).
      if (!workflow && !teammate && takesOver(e, s)) {
        const routed = await requestPick($, e, s)
        if ('deny' in routed) return routed
        input = routed.input
        chosen = routed.pick
      } else if (workflow && ['ripple:auto', 'auto'].includes(e.subagentType)) {
        // A Workflow's agent() is the engine's to schedule, but a ripple:auto there whose marker
        // names a worker ran under the session's name — the task list said Opus 5.5 for 31 Sol
        // workers (2026-10-23) — and its later turns lost the marker the router routes by. The
        // engine keeps a workflow agent's type and description ("do not apply to a workflow
        // agent") but takes its model: on the worker's model it shows that model and every turn
        // routes by it. A tier marker or none leaves the agent as the script wrote it.
        const marker = readMarker(e.prompt)
        if (marker && !tierOf(marker) && !['auto', 'ripple'].includes(marker.name)) {
          const files = await workerFiles($)
          const name = files.has(marker.name) ? marker.name : [...files].find(([, f]) => agentModel(f)?.replace(/@[^@]*$/, '').toLowerCase() === marker.name)?.[0]
          const fileModel = name ? agentModel(files.get(name)!) : undefined
          if (name && fileModel) {
            const fix = fixSpawn({ subagentType: name, prompt: e.prompt }, fileModel)
            input = { ...e, prompt: fix?.prompt ?? e.prompt, model: fix?.model ?? fileModel }
          }
        }
      } else if (!e.fork && !workflow && !NATIVE_AGENTS.includes(e.subagentType)) {
        const files = await workerFiles($)
        try { await refreshModels($) } catch (error) { await report($, 'explicit worker catalogue', error) }
        const file = files.get(e.subagentType)
        const provider = file ? agentProvider(file) : e.model && !/^(?:sonnet|opus|haiku|fable|mythos|claude-)/.test(e.model) ? (await read($, routerModels)).find(m => m.value === e.model?.replace(/@[^@]*$/, ''))?.provider : 'anthropic'
        if (provider && s.providers[provider] === false) return { deny: t(language, 'workers.disabled', { provider }) }
        const marker = readMarker(e.prompt)
        // Outside takeover a tier marker is dropped, never routed as a model named "hard".
        if (tierOf(marker)) {
          input = { ...e, prompt: e.prompt.replace(MARKER, '').replace(/^\s*\n/, '') }
        } else if (marker) {
          const markerFile = files.get(marker.name) ?? [...files.values()].find(f => agentModel(f)?.replace(/@[^@]*$/, '') === marker.name)
          const markerProvider = markerFile ? agentProvider(markerFile) : (await read($, routerModels)).find(m => m.value === marker.name)?.provider
          if (markerProvider && s.providers[markerProvider] === false) return { deny: t(language, 'workers.disabled', { provider: markerProvider }) }
        }
        const fix = await workerFix($, input)
        if (fix) {
          if (fix.dropped) await $.ui.toast(t(language, 'toasts.ownModel', { name: e.subagentType, model: fix.dropped }))
          input = { ...input, prompt: fix.prompt, model: fix.model }
        }
        // Keep generated workers' own model precedence; only then pin native aliases to our table.
        const selectedModel = input.model ?? (file ? agentModel(file) : undefined)
        const model = resolveClaudeModel(selectedModel)
        if (ours && model && model !== selectedModel) {
          input = { ...input, model }
          // Consume a matching native marker so the router cannot put its alias back on the wire.
          // No `@level` on the concrete id: the router passes a claude-* id through byte for byte, so
          // a suffix would reach Anthropic as part of the model name (and hide a trailing [1m]).
          if (marker && marker.name === selectedModel?.replace(/@[^@]*$/, '').replace(/\[1m\]$/, '')) {
            input = { ...input, model: model.replace(/@[^@]*$/, ''), prompt: input.prompt.replace(MARKER, '').replace(/^\s*\n/, '') }
          }
        }
      }
      // The model-reason line is the mod's alone, on every path a worker starts from.
      if (!e.fork) {
        const bare = withoutReason(input.prompt)
        if (bare !== input.prompt) input = { ...input, prompt: bare }
      }
    } catch (error) {
      input = e
      await report($, 'agent.spawn prepare', error).catch(() => undefined)
      // A managed spawn whose routing or correction could not be prepared is refused, never run
      // as sent. The report above is the diagnostic; this denial is what the caller sees.
      if (ours) return { deny: t(language, 'toasts.error', { reason: reason(error) }) }
    }
    try {
      // The title names what really runs: the model set above, else the worker file's, else the parent's.
      if (!e.fork && !('workflow' in e && e.workflow) && !NATIVE_AGENTS.includes(e.subagentType) && input.description?.trim()) {
        const file = (await workerFiles($)).get(input.subagentType)
        const model = input.model ?? (file ? agentModel(file) : undefined) ?? e.parentModel
        const effort = chosen?.effort ?? /@([a-z]+)$/.exec(model)?.[1]
        input = { ...input, description: spawnTitle(input.description, model, effort, await read($, routerModels)) }
      }
    } catch (error) { await report($, 'agent.spawn title', error) }
    const result = await next(input)
    try {
      if (result.agentId) {
        const provider = await spawnProvider($, input.subagentType, result.model)
        const effort = chosen?.effort ?? /@([a-z]+)$/.exec(result.model)?.[1]
        const now = await $.clock.now()
        const early = endedEarly.get(result.agentId)
        endedEarly.delete(result.agentId)
        const rec: AgentRec = { id: result.agentId, description: input.description, type: input.subagentType, model: result.model, ...(chosen ? { pick: chosen } : {}), ...(provider ? { provider } : {}), ...(effort ? { effort } : {}), state: early?.state ?? 'running', startedAt: Math.min(now, early?.endedAt ?? now), ...(early ? { endedAt: early.endedAt } : {}), cost: 0 }
        await update($, agents, list => retainAgents([...list.filter(a => a.id !== rec.id), rec]))
        await countAgents($)
        if (early && chosen?.id) await persistWorkerPick($, { ...early.outcome, pick: chosen.id, model: result.model ?? null, cost: 0 })
      }
    } catch (error) { await report($, 'agent.spawn record', error) }
    return result
  })
  on('tool.call', async ($, e, next) => {
    let started = 0
    try {
      started = await $.clock.now()
      const line = e.agentId ? await toolLine($, e) : ''
      if (e.agentId) await update($, agents, list => list.map(a => a.id === e.agentId ? { ...a, now: line, toolSince: started, state: 'running', tools: (a.tools ?? 0) + 1 } : a))
    } catch (error) { await report($, 'tool.call start', error) }
    let answer: ToolCallResult | undefined
    try { answer = await next(e); return answer }
    finally {
      try {
        if (e.agentId) await update($, agents, list => list.map(a => a.id === e.agentId && a.toolSince === started ? { ...a, now: undefined, toolSince: undefined } : a))
      } catch (error) { await report($, 'tool.call finish', error) }
      try { if (answer && ['Bash', 'Monitor', 'TaskStop'].includes(e.tool)) await noteTask($, e, answer, started) }
      catch (error) { await report($, 'tool.call task', error) }
    }
  })
  on('session.compact', async ($, e, next) => {
    // A finished compaction of the main conversation adds one to the Compact icon's count; a skipped
    // one, a subagent's own and the ahead-of-time precompute do not.
    const counted = async (result: SessionCompactResult): Promise<SessionCompactResult> => {
      try {
        if (!e.agentId && e.trigger !== 'precompute' && 'messages' in result) {
          await update($, compactions, n => n + 1)
          // The count was of the context this compaction replaced: make it stale for a count already
          // running too, which the epoch and run catch (2026-10-25).
          contextEpoch += 1
          contextRun += 1
          fullMark = null
          await update($, contextFull, () => null)
        }
      } catch (error) { await report($, 'session.compact count', error) }
      return result
    }
    try {
      const language = await read($, lang)
      // The summary drops what was noted; the note itself goes with every prompt while eager
      // (modes.ts eagerNote), so this is bookkeeping only.
      if (!e.agentId && e.trigger !== 'precompute' && await read($, modeNoted) !== null) await update($, modeNoted, () => null)
      if (e.agentId || (await currentSettings($)).compactModel === 'session') return next(e).then(counted)
      if (e.trigger === 'precompute') return { skip: t(language, 'commands.compactSkip') }
      const transcript = serializeTranscript(e.messages.length ? e.messages : await $.session.messages())
      if (!transcript) throw new Error(t(language, 'toasts.transcriptEmpty'))
      // A chosen model may carry its effort (`id@effort`), as a worker's does: the router takes the
      // effort on its own field, so the two are split here.
      const choice = (await currentSettings($)).compactModel
      const at = choice.lastIndexOf('@')
      const effort = at > 0 && EFFORTS.includes(choice.slice(at + 1) as Effort) ? choice.slice(at + 1) as Effort : 'medium'
      const answer = await $.model.complete({ model: at > 0 ? choice.slice(0, at) : choice, system: COMPACT_SYSTEM, prompt: transcript + (e.instructions ? `\n\nKeep especially:\n${e.instructions}` : ''), maxTokens: 16000, timeoutMs: 240000, effort })
      if (!answer.isAnswered || answer.text.trim().length <= 200) throw new Error(t(language, 'toasts.summaryEmpty'))
      await update($, cache, () => null)
      await update($, context, () => null)
      if (await read($, kept)) await update($, kept, () => null)
      await update($, resultCard, () => ({ stage: 'compacted' }))
      return counted(compactResult(answer.text))
    } catch (error) {
      await $.ui.toast(t(await read($, lang), 'toasts.compactFallback'))
      await report($, 'session.compact', error)
    }
    return counted(await next(e))
  })
  on('command.run', { command: 'ripple' }, async ($, e, next) => {
    try {
      const language = await read($, lang)
      const [sub = 'settings'] = e.args.trim().toLowerCase().split(/\s+/)
      if (sub === 'stats') return { text: formatStats(await read($, stats), language) }
      if (sub === 'debug') return { text: debugText(language, { judge: (await currentSettings($)).judge, judgeModel: (await currentSettings($)).judgeModel, pick: await read($, pick), paused: await read($, paused), cache: await read($, cache), warm: await read($, warm), lastSpawn: await read($, lastSpawn), lastRequest: await read($, lastRequest), model: await $.session.model(), limit: await read($, limit), hostRateLimits: (await $.session.usage()).rateLimits }) }
      if (sub === 'settings' || sub === 'setup') await startPanel($, sub)
      else if (sub === 'auto') await toggleAuto($)
      else if (sub === 'warm') await toggleWarm($)
      else if (sub === 'save') await toggleSave($)
      else if (sub === 'log') await toggleLog($)
      else if (sub === 'agents') await toggleAgents($)
      else if (sub === 'context') await toggleContext($)
      else if (sub === 'bar') await toggleBar($)
      else if (['cold', 'swamp', 'hot', 'down', 'kept'].includes(sub)) { await update($, panel, () => null); await update($, demo, () => sub as 'cold' | 'swamp' | 'hot' | 'down' | 'kept') }
      else return { text: t(language, 'commands.help') }
      return { text: t(language, 'commands.done', { command: sub }) }
    } catch (error) { await report($, 'ripple command', error); return next(e) }
  })
  on('command.run', { command: 'ripple-log' }, async ($, e, next) => {
    try {
      const language = await read($, lang)
      return { text: await toggleLog($) ? t(language, 'commands.logOpened') : t(language, 'commands.logClosed') } }
    catch (error) { await report($, 'ripple-log', error); return next(e) }
  })
  on('command.run', { command: 'ripple-bar' }, async ($, e, next) => {
    try {
      const language = await read($, lang)
      if (!await toggleBar($)) return { text: t(language, 'commands.barHidden') }
      // The minimal layout draws no band above the prompt, only the short line under it (#56).
      return { text: t(language, (await currentSettings($)).layout === 'minimal' ? 'commands.barShownMinimal' : 'commands.barShown') } }
    catch (error) { await report($, 'ripple-bar', error); return next(e) }
  })
  on('ui.close', { id: LOG_PANE }, async ($, e, next) => {
    try { await update($, logOpen, () => false) } catch (error) { await report($, 'log close', error) }
    return next(e)
  })
  on('ui.close', { id: AGENTS_PANE }, async ($, e, next) => {
    try {
      await update($, agentsOpen, () => false)
      // Opened again, the pane starts on the list.
      if (await read($, agentOpen) !== null) await update($, agentOpen, () => null)
    } catch (error) { await report($, 'agents close', error) }
    return next(e)
  })
  on('ui.close', { id: CONTEXT_PANE }, async ($, e, next) => {
    // Opened again, the pane starts on the estimate with every section at its largest few.
    try {
      if ((await read($, contextShowAll)).length) await update($, contextShowAll, () => [])
      const full = await read($, contextFull)
      if (full && !full.busy) await update($, contextFull, () => null)
    } catch (error) { await report($, 'context close', error) }
    return next(e)
  })
  // Scrolled back down to the end of an open conversation, the pane follows it again as it grows.
  // Asked after the move and not awaited: the follow is a move of its own.
  on('ui.scroll', { requestId: AGENTS_PANE }, async ($, e, next) => {
    const moved = await next(e)
    try {
      if (e.origin.kind === 'person' && e.offset >= e.contentRows - e.bodyRows && await read($, agentOpen) !== null) void $.ui.scroll({ in: AGENTS_PANE, to: 'end' }).catch(() => undefined)
    } catch (error) { await report($, 'agents scroll', error) }
    return moved
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let language: Lang = 'en'
    try {
      language = await read($, lang)
      startTimers($)
      const el = $.ui.resolve(e)
      // The terminal's survey needs the band's rows, so it gets them. The desktop draws its question
      // box (a turn's next step, a question asked) as a card of its own, and yielding there blanked
      // the band until the next prompt (2026-10-26): the band stays, the host's drawing over it.
      const card = (e.surface === 'desktop' || e.surface === 'vscode') && 'Svg' in el
      if (e.props.hasSurvey && !card) return next(e)
      const which = await read($, panel)
      if (e.props.hasSurvey && which !== null) return next(e)
      const frame = await frameOf($, e)
      const { Box, Button, Text } = el
      // What the hooks after ours drew here (another mod's tree, the desktop's survey) stays, with
      // ours under it: a band drawn in its place blanked their rows (catalogue review, 2026-10-26).
      // The engine alone draws nothing here but a survey, so its bare answer (or none) is left out.
      const drawn = await next(e)
      const theirs = drawn != null && (e.props.hasSurvey || drawn.type !== 'engine') ? drawn : null
      const after = (node: RenderNode): RenderElement => (theirs
        ? <Box flexDirection="column" rowGap={0.5} width="100%" minWidth={0}>{theirs}{node}</Box>
        : node) as RenderElement
      if (which === 'settings') return after(renderSettings(el, frame, await settingsView($), settingsActions($)))
      if (which === 'compact' || which === 'clear') {
        const choice = await alertView($, frame.now)
        if (choice) return after(renderAlert(el, frame, choice, alertActions($, choice)))
      }
      if (which === 'setup') {
        return after(renderSetup(el, frame, { draft: normalizeSettings(await read($, settingsDraft) ?? await read($, settings)), jev: await read($, jev), step: await read($, setupStep) }, setupActions($)))
      }
      // What the phone queued floats over whatever is here, only while something waits (ui/queue.tsx).
      const queued = await read($, phoneQueue)
      // Theirs sits under what the phone queued and over the band.
      const over = (node: RenderNode | null): RenderElement => (queued || theirs
        ? <Box flexDirection="column" rowGap={0.5} width="100%" minWidth={0}>{queued ? renderPhoneQueue(el, frame, queued) : null}{theirs}{node}</Box>
        : node ?? drawn) as RenderElement
      const below = queued ? { ...frame, maxRows: Math.max(1, frame.maxRows - PHONE_QUEUE_ROWS) } : frame
      if (await read($, bandHidden)) return over(null)
      const alert = await alertView($, frame.now)
      if (alert) return over(renderAlert(el, below, alert, alertActions($, alert)))
      const s = await currentSettings($)
      if (s.layout === 'minimal') return over(null)
      const actions = bandActions($, e.surface)
      // The desktop draws the band as one surface with its × inside; the terminal keeps the row
      // of facts and controls with the close control (and its effort button) after it.
      if (card) {
        return over(renderBand(el, below, await dashboard($, e.props.isWorking), { ...actions, hide: () => { void toggleBar($) } }))
      }
      return over(
        <Box flexDirection="row" alignItems={e.surface === 'terminal' || e.surface === 'mobile' ? 'flex-start' : 'center'} columnGap={2}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>{renderBand(el, { ...below, columns: frame.columns - besideBand(frame) }, await dashboard($, e.props.isWorking), actions)}</Box>
          <Box flexDirection="row" columnGap={2} flexShrink={0}>
            {e.surface === 'terminal' || e.surface === 'mobile' ? <Button key="effort" plain hotkey="e" label={t(language, 'band.effort')} onPress={actions.toggleEffortMenu} /> : null}
            <Button key="hide" plain role="dismiss" label="×" onPress={() => toggleBar($)} />
          </Box>
        </Box>
      )
    } catch (error) { return renderFailure($, e, error, language) }
  }).catch(($, e, next) => renderFailure($, e, next.error.message ?? next.error.kind))
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const engine = await next(e)
    try {
      startTimers($)
      if ((await currentSettings($)).layout !== 'minimal' || await read($, bandHidden)) return engine
      return renderFooter($.ui.resolve(e), await frameOf($, e), await dashboard($, await read($, busy)), bandActions($, e.surface), engine) as RenderElement
    } catch (error) { return renderFailure($, e, error, 'en', engine) }
  }).catch(async ($, e, next) => renderFailure($, e, next.error.message ?? next.error.kind, 'en', await next(e)))
  on('ui.render', { component: 'Pane', requestId: LOG_PANE }, async ($, e, next) => {
    try {
      startTimers($)
      return renderLog($.ui.resolve(e), await frameOf($, e), { rows: await read($, requests), mineOnly: await read($, onlySession), judges: await read($, judgeRuns) }, { toggleScope: async () => { await update($, onlySession, value => !value); await refreshRouter($) } }) as RenderElement
    } catch (error) { return renderFailure($, e, error) }
  }).catch(($, e, next) => renderFailure($, e, next.error.message ?? next.error.kind))
  on('ui.render', { component: 'Pane', requestId: AGENTS_PANE }, async ($, e) => {
    let frame: Frame | undefined
    let records: AgentRec[] = []
    let id: string | null = null
    try {
      startTimers($)
      records = await read($, agents)
      frame = await frameOf($, e)
      id = await read($, agentOpen)
      // The desktop replaces a whole answer, including the hovered native button. Do not
      // repaint an open conversation every second just to tick its age: that drops the run
      // line's hover under a still pointer. Steps and tools still refresh its words and age.
      if (id === null || !isRich(frame)) await read($, agentsTick)
      const open = id === null ? undefined : { id, talk: await agentTalk($, id, records.find(record => record.id === id)), runsOpen: await read($, agentRunsOpen) }
      if (open && 'deny' in open.talk) throw new Error(open.talk.deny)
      return renderAgents($.ui.resolve(e), frame, { agents: records, tasks: await read($, bgTasks), now: frame.now, showDone: await read($, agentsShowDone), ...(open ? { open } : {}) }, agentsActions($)) as RenderElement
    } catch (error) { return agentsRenderFailure($, e, error, { ...(frame ? { frame } : {}), records, wasOpen: id !== null }) }
  }).catch(($, e, next) => agentsRenderFailure($, e, next.error.message ?? next.error.kind))
  on('ui.render', { component: 'Pane', requestId: CONTEXT_PANE }, async ($, e) => {
    let frame: Frame | undefined
    try {
      startTimers($)
      frame = await frameOf($, e)
      // Read to be drawn again on each step, as the band's ring is; a precise count holds only
      // until then.
      const live = await read($, context)
      const full = await read($, contextFull)
      // The count's own window is the one it draws; another window clears it in contextShare, and
      // a model or chat change is caught here before that poll (2026-10-25).
      const same = !!fullMark && countsHere(fullMark, live?.basis ?? null, await $.session.model(), await currentCompactAt($))
      const fresh = full?.breakdown && same ? full : null
      // The terminal's grid follows its width (5 wide under 80 columns); the desktop draws its own.
      const breakdown = fresh?.breakdown ?? (await $.session.usage({ breakdown: 'summary', ...(isRich(frame) ? {} : { columns: frame.columns }) })).context.breakdown ?? null
      const cwd = await $.session.cwd().catch(() => undefined)
      const error = full && !full.busy && same ? full.error : undefined
      return renderContext($.ui.resolve(e), frame, {
        breakdown, basis: fresh ? 'full' : 'summary', busy: !!full?.busy, precise: countsPrecisely(await $.session.model()), ...(error ? { error } : {}),
        open: await read($, contextShowAll), place: { ...(cwd ? { cwd } : {}), home: await userHome($) },
      }, contextActions($)) as RenderElement
    } catch (error) { return contextRenderFailure($, e, error, frame) }
  }).catch(($, e, next) => contextRenderFailure($, e, next.error.message ?? next.error.kind))
  on('ui.render', { component: 'Pane', requestId: LIMITS_PANE }, async ($, e) => {
    let frame: Frame | undefined
    try {
      startTimers($)
      frame = await frameOf($, e)
      // The row the band gauges: the same reading, every provider account's windows.
      const items = await read($, limits) ?? []
      const save = await read($, saveUntil)
      scheduleLimitsRedraw($, items, frame.now)
      return renderLimits($.ui.resolve(e), frame, { items, ...(save !== null && save > frame.now ? { saveUntil: save } : {}) }, limitsActions($)) as RenderElement
    } catch (error) { return limitsRenderFailure($, e, error, frame) }
  }).catch(($, e, next) => limitsRenderFailure($, e, next.error.message ?? next.error.kind))
}
