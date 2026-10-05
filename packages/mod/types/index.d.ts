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
  session?: string
  /** Sent by the session this mod runs in. */
  mine?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clauderipple-status': {
      line: StatusLine
      last: StatusRequest | null
      requests: StatusRequest[]
      logOpen: boolean
      onlySession: boolean
      bandHidden: boolean
    }
  }
}
