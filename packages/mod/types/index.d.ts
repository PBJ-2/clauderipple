// The mod's shared shapes. The design and the reasons are in docs/specs/2026-10-10-ripple-mod.md.

// Engine contracts must be self-contained; i18n re-exports this language type.
export type Lang = 'ko' | 'en' | 'zh' | 'ja' | 'es' | 'pt'

export type StatusLine = string | null

/** A user's standing delegation choice, held only for this session. */
/** `said` is the sentence that pinned it, cut short, shown beside the pin and never stored. */
export type DelegationPin = { model: string; provider?: string; said?: string }

export type StatusRequest = {
  at: string
  source: string
  target: string
  provider: string
  status: number | string
  ok: boolean
  ms: number
  effort?: string
  /** The service tier the request asked for ('priority' is Fast); the tier served often differs. */
  requestedTier?: string
  usage?: { input: number; cached: number; cacheWrite?: number; output: number }
  note?: string
  /** Not ok, but the client sent it again on its own: not a failure. */
  resent?: boolean
  session?: string
  /** Sent by the session this mod runs in. */
  mine?: boolean
  /** Sent from inside a subagent (the router reads Claude Code's agent-id header). */
  subagent?: true
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The desktop's skins: the deep (dark water, the first look) and flat (the app's own surfaces). */
export type Skin = 'deep' | 'flat'

/** API usage may omit counts; the engine's ModelUsage does not expose cache TTL evidence. */
export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_1h_input_tokens?: number
    ephemeral_5m_input_tokens?: number
  }
}

/** The bounded excerpts shared by the effort judges; attachments carry counts, not contents. */
export type JudgeInput = {
  messages: readonly { role: 'user' | 'assistant'; text: string }[]
  next: string
  attachments?: readonly { type: string }[]
  current?: { model: string; effort: Effort } | null
  contextPercent?: number
  midTurn?: boolean
}

/** Who judges: Haiku on the person's Claude login, TypeSafe's Jev, or a model through the router. */
export type JudgeKind = 'haiku' | 'jev' | 'model'
/**
 * One verdict as the log pane lists it beside the router's requests: a Jev call never reaches the
 * router, so without this nothing showed who judged, how long it took or that it fell back.
 */
export type JudgeRun = {
  at: number
  /** The effort of a prompt, or the worker for a spawn. */
  for: 'prompt' | 'worker'
  /** The judge the settings ask for, and the one that answered (Haiku when it fell back). */
  asked: JudgeKind
  by: JudgeKind
  ms: number
  effort?: Effort
  sure?: number
  /** Why the asked judge gave no verdict. */
  error?: string
}

/** Domain is the kind of work; level is its required capability, independently. */
export type Domain = 'design' | 'frontend' | 'backend' | 'infra' | 'data' | 'test' | 'docs' | 'research' | 'general'
export type Level = 'light' | 'standard' | 'deep'
/** Whether a task decides what to build (plan) or carries out what was decided (do). */
export type Kind = 'plan' | 'do'
/**
 * The worker ladder's rungs (docs/specs/2026-10-11-worker-ladder.md): the judge's level picks
 * light, standard or hard for execution; standard/deep planning selects plan (2026-10-24).
 */
export type Rung = 'light' | 'standard' | 'hard' | 'plan'
/** One rung: what runs there and how hard it thinks. */
export type Step = { target: TierTarget; effort: Effort }
/** Historical stats include design counts from before the two-axis migration. */
export type Tier = Level | 'design'
/** How a pin stored before 2026-10-11 moved its efforts; read only to migrate it (`ladderFromPin`). */
export type Calibration = { effortOffset?: -2 | -1 | 0 | 1 | 2; floor?: Effort; ceiling?: Effort }
/**
 * The four workers' rungs, each model + effort. Loading (`normalizeSettings`) reads pins from
 * before 2026-10-11 and Auto (experimental, removed 2026-10-12) into it, and drops field rules.
 */
export type Rungs = Partial<Record<Rung, Step[]>>
export type Rule = { mode: 'ladder'; rungs: Rungs }
/** Optional ladders within one worker set; absent domains follow that set's general ladder. */
export type DomainRules = { ui?: Rule; backend?: Rule }
/** How a provider is paid for: what the Workers card tags each model with, and what presets read. */
export type Billing = 'free' | 'payg' | 'subscription'
/** A model a rung can run, as GET /api/mod-options describes it. */
export type LadderChoice = {
  target: TierTarget
  model: string
  provider: string
  billing: Billing
  /** The model's own effort ladder, in order; empty when unknown. */
  efforts: Effort[]
  /** Its cheapest measured AA cost per task, when measured. */
  cost?: number
}
/** The fill rule's wishes, by name; only `claudeGpt` is used now (the router fills empty rungs with it). */
export type PresetId = 'claude' | 'claudeGpt' | 'gpt' | 'cheap'
/** The fill as computed from the ticked models: the rungs, and the ones it had to fill otherwise. */
export type Preset = { rungs: Record<Rung, Step>; substituted: Rung[] }
/** `models`: models out while the provider answers others (a spent Antigravity quota group). */
export type ProviderAvailability = { usable: boolean; reason?: string; exhaustedUntil?: number; models?: Record<string, { reason?: string; exhaustedUntil?: number }> }
export type LadderOptions = { until: number; choices: LadderChoice[]; providers?: Record<string, ProviderAvailability> }
export type RouterModel = { value: string; label: string; provider: string; name?: string }
export type WorkerCandidate = { target: TierTarget; model: string; provider: string }
/** A model's AA measurements (GET /api/mod-options `scores`): the fill's cost order reads them. */
export type ModelScore = { model: string; provider: string; variants: { effort: Effort | null; intelligence: number | null; costPerTask: number | null }[] }

/** An agent to spawn: a dispatchable `subagentType`, and a model only for Claude's own agents. */
export type TierTarget = { agent: string; model?: string }

/**
 * An operating mode the user made (docs/specs/2026-10-12-worker-tiers.md "Operating modes").
 * Each rung is an ordered worker list, independent of the base ladder, sharing its ticked models.
 * `until` is an epoch-ms time, the named provider's next known quota reset ('chatgpt' or another
 * ChatGPT provider, or 'anthropic' for Claude), or no automatic end.
 */
export type Mode = {
  id: string
  name: string
  rungs: Rungs
  domainRules?: DomainRules
  delegation: 'normal' | 'eager'
  until: 'none' | number | { reset: string }
}

export type Settings = {
  effortAuto: boolean
  judge: JudgeKind
  /** The router model id the `model` judge asks. */
  judgeModel: string
  bias: -2 | -1 | 0 | 1 | 2
  floor: Effort
  ceiling: Effort
  /** off: never; auto: ripple:auto/auto; all: non-plugin workers except host helpers and native Explore/Plan (2026-10-24). */
  agentAuto: 'off' | 'auto' | 'all'
  jevSource: 'typesafe' | 'zen'
  /** Only the general ladder: the four workers replaced the per-field rules (2026-10-12). */
  rules: { general: Rule }
  /** Base's optional domain ladders, separate from retired `rules.<domain>` overrides. */
  domainRules?: DomainRules
  /**
   * The models the user ticked (docs/specs/2026-10-12-worker-tiers.md): worker agent names and
   * `general-purpose:<model>` for Claude's own. Empty means every model. Rungs run, and the fill
   * picks, only among these.
   */
  allow: string[]
  /**
   * The allow-list keys of every worker that existed when `allow` was last written (what
   * `candidateKey` returns). A key absent from this non-empty list counts as ticked on; empty means
   * either every worker is ticked (`allow` empty) or all writers predate the field (#56).
   */
  allowKnown: string[]
  /** The user's operating modes; none is built in. */
  modes: Mode[]
  /** The mode that is on, by id; absent when none is. */
  activeMode?: string
  /**
   * When the active mode was turned on (epoch ms): a mode that runs until the quota resets ends at
   * the first reset after this.
   */
  activeSince?: number
  /**
   * Base's delegation, used while no mode is on: eager has the main chat delegate everything but
   * judgment and final review to ripple:auto. A mode's own delegation replaces it while it is on.
   */
  delegation: 'normal' | 'eager'
  providers: Record<string, boolean>
  /**
   * What ran when a pinned tier's agent was unavailable, before the ladder (2026-10-11). Kept so a
   * stored choice survives; the ladder moves one rung up instead.
   */
  fallback: TierTarget
  keepWarm: boolean
  keepWarmHours: 1 | 2 | 4 | 8
  keepWarmMinTokens: number
  /**
   * The model that writes a compaction summary: 'session' for the engine's own compactor, else a
   * model id (a Claude id or a router id) with an optional `@effort`. Defaults to Haiku.
   */
  compactModel: string
  /** The heavy-context band; off unless switched on. */
  swampAlert: boolean
  layout: 'dashboard' | 'minimal'
  appearance: 'auto' | 'dark' | 'light'
  /** How the desktop draws the band and the cards: the deep or flat (ui/look.ts). */
  skin: Skin
  language: 'auto' | Lang
  /** Band parts switched off: 'timer' | 'reason' | 'route'. */
  hide: string[]
  /** Band chips switched on, off by default: 'context' | 'limits'. */
  extras: string[]
  setupDone: boolean
}

/** The admin API always returns a complete normalized settings object. */
export type ModSettingsSnapshot = {
  settings: Settings
  revision: number
  stored: boolean
  /**
   * Claude Code's own `autoCompactWindow` from ~/.claude/settings.json, in tokens (what
   * `/autocompact <n>` writes); null when the model's default stands. The one source the dashboard,
   * the band and a session's `/autocompact` share.
   */
  compactAt?: number | null
  /** The stored settings still held field overrides or Auto, which the four workers replaced; true until the next save. */
  legacy?: boolean
}
/** Arrays and rule mode changes are atomic; other edits are rebased by field path. */
export type SettingsChange = { path: string[]; value?: unknown; remove?: boolean }
export type SettingsSync = { schemaVersion?: number; revision: number | null; pending: SettingsChange[]; migrationChecked: boolean; migration: Settings | null }

/** A judge's answer for the main chat's next prompt. */
export type Verdict = { effort: Effort; sure?: number; why: string }

/** The effort the main chat runs at now, and who set it. */
export type Pick = Verdict & { by: JudgeKind | 'manual' | 'followup'; at: number }

/** A judge's answer for a delegated task; a judge that names no kind means do. */
export type WorkerVerdict = {
  domain: Domain; level: Level; kind?: Kind; effort: Effort
  /** Picks made while a worker judge ran (until 2026-10-24) keep its confidence in the level. */
  sure?: number
  /** That judge's confidence in each answer, as kept in older pick-log rows. */
  odds?: { domain?: number; level?: number; kind?: number; effort?: number }
  why: string
}

/** What a spawn of ripple:auto (or a taken-over spawn) was turned into. */
export type WorkerPick = WorkerVerdict & {
  /** The worker set's ladder selected for this task (explicit model choices bypass it). */
  rule: 'ui' | 'backend' | 'general'
  /** The ladder rung that ran it (absent for explicit choices). */
  rung?: Rung
  /** One-based position in the selected rung; skipped entries explain ordered fallback. */
  position?: number
  skipped?: { rung: Rung; position: number; model: string; reason: string }[]
  target: TierTarget
  /**
   * The session's tier marker, the default with none, a model the user asked for or pinned, or one
   * a written rule assigns. Records from before 2026-10-24 can name the worker judge or a marker.
   */
  by: JudgeKind | 'user' | 'rule' | 'session' | 'marker' | 'default'
  ms: number
  /** Set when the tier's own agent could not run and the fallback did. */
  fallbackReason?: string
  /** Joins the pick's lines in the pick log: the pick, the judge's shadow verdict, the outcome. */
  id?: string
}

export type AgentState = 'running' | 'done' | 'failed' | 'killed'

export type AgentRec = {
  id: string
  /** Workflow agents and records from older mods may have no title or type. */
  description?: string
  /** The agent type that ran, when recorded. */
  type?: string
  model?: string
  /** Kept session records can name the judge or the former tier picker directly. */
  pick?: Omit<WorkerPick, 'by'> & { by: WorkerPick['by'] | 'judge' | 'tier' }
  state: AgentState
  /** The tool it is in now, in a few words. */
  now?: string
  toolSince?: number
  startedAt: number
  endedAt?: number
  /** Weighted tokens (spec §5 stats weights). */
  cost: number
  /** The provider it runs on by config name (`anthropic` for Claude's own), for its card's dot. */
  provider?: string
  /**
   * The effort its last step was sent at: the model id's `@effort` where it carries one (the router
   * forces that, packages/router/src/routing.ts), else the request's own effort.
   */
  effort?: string | number
  /** The model that answered its last step, by the id the API reported (TurnUsage `model`). */
  answeredBy?: string
  /**
   * Its last step's token counts as the API reported them, in the shape of StatusRequest's usage:
   * every step re-sends the whole conversation, so only the last prompt says how big it is.
   */
  usage?: { input: number; cached: number; cacheWrite: number; output: number }
  /** Every step's output tokens added up; the token figure adds this to the last step's prompt. */
  outputTotal?: number
  /** Tool calls it started. */
  tools?: number
  /** Coordinator deliveries, newest 20, anchored after the transcript rows visible at receipt. */
  instructions?: { text: string; after: number; ordinal: number }[]
}

/**
 * Work Claude left running in the background, as the Claude app lists it beside the agents: a
 * command (Bash `run_in_background`, or one the person or a timeout sent there) or a watch (Monitor).
 */
export type BgTask = {
  /** The engine's task id: Bash's `backgroundTaskId`, Monitor's `taskId`, what its notification names. */
  id: string
  kind: 'shell' | 'monitor'
  /** What it does in the call's own words (its `description`), else its command. */
  title: string
  /** The command line, or a watch's WebSocket address. */
  command?: string
  /** The agent whose call started it; absent for the main conversation's. */
  agentId?: string
  /** It ends with that agent's final response (Bash `backgroundEndsWithFinalResponse`): no notification follows. */
  endsWithAgent?: true
  state: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  endedAt?: number
  /** Its notification's own line on how it ended ("… completed (exit code 0)"). */
  summary?: string
  /** Ended by a Stop that no longer listed it in flight, before any notification said how. */
  settled?: true
}

/** The main chat's prompt cache as far as its responses show it. */
export type CacheMemo = {
  ttlMs: number
  lastReplyAt: number
  expiresAt: number
}

/**
 * A chat's keep-warm as the plugin store keeps it, per session id: the atoms hold these in one
 * process's memory only, and the app restarts a session's CLI on its own (2026-10-30).
 */
export type CacheMemory = {
  memo: CacheMemo
  /** When the person's own reply last arrived, not a ping's: the keep-warm time bound counts from it. */
  lastRealReplyAt: number
  /** The context that reply was counted over, for a restarted process that has no live count yet. */
  contextTokens: number
  /** The model the memo was made under: another model's cache cannot be pinged for. */
  model: string
}

/** Keep-warm bookkeeping for this chat. */
export type WarmState = {
  pings: number
  /** Weighted tokens the pings cost. */
  cost: number
  /** Set when keep-warm stopped by itself, with why. */
  stopped?: string
  lastPingAt?: number
}

/** The hottest plan window at or above the alert line. */
export type Hot = { kind: string; percent: number; resetsAt?: string }

/**
 * One plan window for the band's second row, the limits row: every window of every provider whose
 * quota the router can read (Claude's plan windows and per-model weeklies, each ChatGPT account's
 * windows, each Antigravity account's Gemini and third-party windows). The row reads them all from
 * `GET /api/limits` (falling back to the older status routes on a router that predates it).
 * `provider` is the provider's config name (the grouping key; 'claude' on the fallback path);
 * `type` is its kind ('anthropic', 'chatgpt', 'google', …), which picks the group head's colour;
 * `title` is the head's name ("Claude", "GPT", "Gemini"); `account` numbers the provider's eligible
 * accounts from 0 (the row reads "GPT" alone, or "GPT 1", "GPT 2", … when a provider has several);
 * `kind` is 'five_hour', 'seven_day', 'scoped' (a per-model/third-party window, its name in `label`)
 * or 'window' (a window of another length, its minutes in `windowMinutes`).
 */
export type LimitItem = {
  provider: string
  /** The provider's kind, for the head's colour. Absent on an older item, the name stands in. */
  type?: string
  /** The head's name; absent, derived from the provider's type or name. */
  title?: string
  account: number
  kind: 'five_hour' | 'seven_day' | 'scoped' | 'window'
  label: string
  windowMinutes?: number
  percent: number
  resetsAt?: string
}

export type Stats = {
  prompts: number
  requests: number
  input: number
  write: number
  read: number
  out: number
  byEffort: Partial<Record<Effort, { prompts: number; cost: number }>>
  judge: { haiku: number; jev: number; model: number; ms: number; tokens: number }
  workers: Partial<Record<Tier, number>>
  warm: { pings: number; cost: number }
}

/** `writing`: the fork is (or will be) writing the note; `opened`: a new session was opened with it; `copied`: no session could be opened, so it was copied. */
export type HandoffStage = 'writing' | 'opened' | 'copied' | 'failed'
export type SetupStep = 1 | 2 | 3 | 4
export type ResultStage = 'tidying' | 'handingOff' | 'handoffDone' | 'compacting' | 'compacted' | 'failed'
export type JevState = {
  source: 'env' | 'file' | 'pasted' | 'zen' | null
  test: { state: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }
}

declare module 'claude-code' {
  interface PluginState {
    ripple: {
      line: StatusLine
      /** What the phone queued for this chat, from the host's queue.json; null when nothing. */
      phoneQueue: { count: number; first: string } | null
      last: StatusRequest | null
      requests: StatusRequest[]
      logOpen: boolean
      onlySession: boolean
      bandHidden: boolean
      settings: Settings | null
      settingsSync: SettingsSync
      settingsBase: Settings | null
      lang: Lang
      pick: Pick | null
      deciding: boolean
      paused: boolean
      agents: AgentRec[]
      /** Commands and watches left running in the background, and the latest that ended (tasks.ts). */
      bgTasks: BgTask[]
      /** Running and all agents, for the band: written only when a count moves. */
      agentCounts: { live: number; total: number }
      cache: CacheMemo | null
      warm: WarmState
      /** Keep-warm for this chat alone, set by the band's flame; null follows Settings. */
      warmHere: boolean | null
      /**
       * The context share the band and the Context pane both show (register.tsx `contextShare`);
       * `basis`, the last response's input tokens, is what a precise count is kept against.
       */
      context: { percent: number; tokens: number; window: number; basis?: number } | null
      /** Claude Code's own compaction point (settings.json `autoCompactWindow`), tokens or null. */
      compactAt: number | null
      hot: Hot | null
      hotHidden: number | null
      /** The window the hot card was put off for: the put-off lasts until that window moves on. */
      hotHiddenFor: Hot | null
      saveUntil: number | null
      swampHidden: number | null
      coldHidden: boolean
      kept: { pings: number; tokens: number } | null
      judgeDown: string | null
      /** `run` names the press whose fork is writing, so a result cannot land on a later chat (register.tsx driveHandoff). */
      handoff: { stage: HandoffStage; text?: string; run?: number } | null
      /** The band's Handoff was pressed and its fork has not started: the tick starts it when the session is idle. */
      handoffQueued: boolean
      panel: 'settings' | 'setup' | 'compact' | 'clear' | null
      busy: boolean
      decidingSince: number | null
      heldPick: Pick | null
      appEffort: Effort | number | null
      modelIs: string | null
      lastRequest: { model: string; appEffort?: string | number; sentEffort?: string | number } | null
      lastSpawn: WorkerPick | null
      lastRealReplyAt: number | null
      stats: Stats
      result: { stage: ResultStage; detail?: string } | null
      settingsDraft: Settings | null
      setupStep: SetupStep
      compactNote: string
      /** The compact card's "tidy up first" switch, on unless the person turned it off (register.tsx). */
      compactTidy: boolean
      effortMenuOpen: boolean
      agentsOpen: boolean
      /** Finished compactions of the main conversation (the Compact icon's count). */
      compactions: number
      agentsShowDone: boolean
      /** The agent whose conversation the Agents pane shows; null shows the list. */
      agentOpen: string | null
      /** The open conversation's tool runs shown call by call, by their first call's id. */
      agentRunsOpen: string[]
      /** Counts the Agents pane's seconds while an agent runs: a write redraws its clocks. */
      agentsTick: number
      /**
       * The Context pane's precise count (the token-count API's), kept against the context's tokens
       * when it was asked for (`basis`); `busy` while it runs, `error` when it failed.
       */
      contextFull: { basis: number | null; breakdown?: SessionContextBreakdown; busy?: boolean; error?: string } | null
      /** The Context pane's sections shown whole. */
      contextShowAll: ('memory' | 'mcp' | 'skills' | 'agents')[]
      /** The person's last two prompts as submitted, mid-turn ones included for the judge (2026-10-24). */
      heardPrompts: string[]
      delegationPin: DelegationPin | null
      jev: JevState
      routerModels: RouterModel[]
      /** The router's rung choices and presets (GET /api/mod-options), for the quick settings. */
      ladderOptions: LadderOptions | null
      /** The active mode the eager note was last sent for (`modes.ts modeKey`); cleared on compaction. */
      modeNoted: string | null
      judgeDownHidden: string | null
      /** Judge failure reasons already said this session. */
      judgeSeen: string[]
      judgeRuns: JudgeRun[]
      judgeDownNetwork: boolean
      limit: Hot | null
      /** Every provider's plan windows for the limits row, from `GET /api/limits`. Null until read. */
      limits: LimitItem[] | null
      demo: 'cold' | 'swamp' | 'hot' | 'down' | 'kept' | null
    }
  }
}
