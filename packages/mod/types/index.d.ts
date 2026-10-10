// The mod's shared shapes. The design and the reasons are in docs/specs/2026-10-10-ripple-mod.md.

export type StatusLine = string | null

export type StatusRequest = {
  at: string
  source: string
  target: string
  provider: string
  status: number | string
  ok: boolean
  ms: number
  effort?: string
  usage?: { input: number; cached: number; cacheWrite?: number; output: number }
  note?: string
  /** Not ok, but the client sent it again on its own: not a failure. */
  resent?: boolean
  session?: string
  /** Sent by the session this mod runs in. */
  mine?: boolean
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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

/** The kinds of delegated work the worker judge tells apart; settings map each to an agent. */
export type Tier = 'light' | 'standard' | 'deep' | 'design'

/** An agent to spawn: a dispatchable `subagentType`, and a model only for Claude's own agents. */
export type TierTarget = { agent: string; model?: string }

export type Settings = {
  effortAuto: boolean
  judge: JudgeKind
  /** The router model id the `model` judge asks. */
  judgeModel: string
  bias: -2 | -1 | 0 | 1 | 2
  floor: Effort
  ceiling: Effort
  /** off: never; auto: spawns of ripple:auto; all: also general-purpose spawns with no model. */
  agentAuto: 'off' | 'auto' | 'all'
  tiers: Record<Tier, TierTarget>
  /** What runs when a tier's agent is unavailable (its provider out of quota or signed out). */
  fallback: TierTarget
  keepWarm: boolean
  keepWarmHours: 1 | 2 | 4 | 8
  keepWarmMinTokens: number
  compactWith: 'haiku' | 'session'
  handoffSkill: string
  handoffAfter: 'continue' | 'confirm' | 'copy'
  handoffButton: 'advised' | 'always'
  /** Context percent at which the swamp band shows. */
  swampAt: number
  layout: 'dashboard' | 'minimal'
  appearance: 'auto' | 'dark' | 'light'
  /** Band parts switched off: 'timer' | 'reason' | 'route' | 'limits'. */
  hide: string[]
  setupDone: boolean
}

/** A judge's answer for the main chat's next prompt. */
export type Verdict = { effort: Effort; sure?: number; why: string }

/** The effort the main chat runs at now, and who set it. */
export type Pick = Verdict & { by: JudgeKind | 'manual' | 'followup'; at: number }

/** A judge's answer for a delegated task. */
export type WorkerVerdict = { tier: Tier; effort: Effort; sure?: number; why: string }

/** What a spawn of ripple:auto (or a taken-over spawn) was turned into. */
export type WorkerPick = WorkerVerdict & {
  target: TierTarget
  by: JudgeKind | 'marker' | 'default'
  ms: number
  /** Set when the tier's own agent could not run and the fallback did. */
  fallbackReason?: string
}

export type AgentState = 'running' | 'waiting' | 'done' | 'failed'

export type AgentRec = {
  id: string
  description: string
  /** The agent type that ran. */
  type: string
  model?: string
  pick?: WorkerPick
  state: AgentState
  /** The tool it is in now, in a few words. */
  now?: string
  toolSince?: number
  startedAt: number
  endedAt?: number
  /** Weighted tokens (spec §5 stats weights). */
  cost: number
}

/** The main chat's prompt cache as far as its responses show it. */
export type CacheMemo = {
  ttlMs: number
  lastReplyAt: number
  expiresAt: number
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

export type HandoffKind = 'quick' | 'full'
export type HandoffStage = 'writing' | 'clearing' | 'done' | 'copied' | 'failed'
export type SettingsTab = 'effort' | 'workers' | 'judge' | 'cache' | 'handoff' | 'look'
export type SetupStep = 1 | 2 | 3 | 4
export type ResultStage = 'handingOff' | 'handoffDone' | 'compacting' | 'compacted' | 'failed'
export type AgentOption = { value: string; label: string; available: boolean }
export type JevState = {
  source: 'env' | 'file' | 'pasted' | null
  test: { state: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }
}

declare module 'claude-code' {
  interface PluginState {
    ripple: {
      line: StatusLine
      last: StatusRequest | null
      requests: StatusRequest[]
      logOpen: boolean
      onlySession: boolean
      bandHidden: boolean
      settings: Settings | null
      pick: Pick | null
      deciding: boolean
      paused: boolean
      agents: AgentRec[]
      cache: CacheMemo | null
      warm: WarmState
      context: { percent: number; tokens: number; window: number } | null
      hot: Hot | null
      hotHidden: number | null
      saveUntil: number | null
      swampHidden: number | null
      coldHidden: boolean
      judgeDown: string | null
      advice: string | null
      handoff: { stage: HandoffStage; kind: HandoffKind; text?: string } | null
      panel: 'settings' | 'setup' | 'compact' | 'handoff' | null
      busy: boolean
      decidingSince: number | null
      heldPick: Pick | null
      appEffort: Effort | number | null
      modelIs: string | null
      lastRequest: { model: string; appEffort?: string | number; sentEffort?: string | number } | null
      lastSpawn: WorkerPick | null
      lastRealReplyAt: number | null
      stats: Stats
      promptCount: number
      adviceQueue: string | null
      handoffQueued: boolean
      handoffWaiting: boolean
      handoffChoiceKind: HandoffKind
      handoffChoiceAfter: 'continue' | 'confirm' | 'copy'
      result: { stage: ResultStage; detail?: string } | null
      settingsDraft: Settings | null
      settingsTab: SettingsTab
      setupStep: SetupStep
      compactNote: string
      effortMenuOpen: boolean
      agentsOpen: boolean
      agentsShowDone: boolean
      jev: JevState
      agentOptions: AgentOption[]
      routerModels: string[]
      skills: string[]
      judgeDownHidden: string | null
      limit: Hot | null
      demo: 'cold' | 'swamp' | 'hot' | 'down' | null
    }
  }
}
