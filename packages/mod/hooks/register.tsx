// What did ClaudeRipple do with this session's model requests? The router records each request
// under the Claude Code session that sent it (`X-Claude-Code-Session-Id`). A one-line band above
// the prompt shows where the last one went, with a button to the request log and an × that puts
// the band away (`/ripple-bar` brings it back); `/ripple-log` opens the log too. The log is the
// router's request records, not its text log: one entry per model request with what matters
// (model, provider, effort, tokens, cache, time, result). All of that only reads the router's
// admin API. The one thing the mod changes is a spawn of a ClaudeRipple worker (./worker.ts).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StatusRequest } from '../types'
import { agentModel, fixSpawn } from './worker'
import type { Spawn, WorkerFix } from './worker'

// The router's admin port, as the router itself works it out (packages/router/src/admin.ts
// `adminPort`): `admin.port`, else one above the proxy port; 8792 when the config cannot be read.
async function userHome($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '~'
}

/** Where ClaudeRipple keeps its config (packages/router/src/config.ts `homeDir`). */
async function rippleHome($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDERIPPLE_HOME')) ?? `${await userHome($)}/.clauderipple`
}

/** Claude Code's own folder, where the generated agent files live. */
async function claudeHome($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await userHome($)}/.claude`
}

/**
 * The fix for a spawn of one of ClaudeRipple's workers (./worker.ts), or null. A worker is a name
 * the router lists in generated-agents.json; anything else, Claude's own agents included, is left
 * alone, as is every spawn when either file cannot be read.
 */
async function workerFix($: EngineInterface, spawn: Spawn): Promise<WorkerFix | null> {
  try {
    const listed = JSON.parse(await $.fs.read(`${await rippleHome($)}/generated-agents.json`)) as { agents?: string[] }
    if (!listed.agents?.includes(spawn.subagentType)) return null
    const fileModel = agentModel(await $.fs.read(`${await claudeHome($)}/agents/${spawn.subagentType}.md`))
    return fileModel ? fixSpawn(spawn, fileModel) : null
  } catch {
    return null
  }
}

async function adminUrl($: EngineInterface): Promise<string> {
  try {
    const config = JSON.parse(await $.fs.read(`${await rippleHome($)}/config.json`)) as { admin?: { port?: number }; listen?: { port?: number } }
    const port = config.admin?.port ?? (config.listen?.port ?? 8791) + 1
    return `http://127.0.0.1:${port}`
  } catch {
    return 'http://127.0.0.1:8792'
  }
}
const EVERY_MS = 3000
const LOG_ROWS = 60
const PANE = 'ripple-log'
const BAND_HIDDEN_KEY = 'bandHidden'

const OK = '#16a34a'
const FAIL = '#dc2626'
const WARN = '#d97706'
const ACCENT = '#2563eb'

// A provider is named by whoever added it, so most names are not known here. The presets' default
// names keep their vendor's hue; any other name gets one from PALETTE picked by a hash of the name,
// so it keeps that color from one session to the next. The palette leaves out the status
// red/green/amber, so a provider is never read as a result.
const KNOWN: Record<string, string> = {
  anthropic: '#d97757',
  chatgpt: '#10a37f',
  'google-gemini': '#4285f4',
  deepseek: '#4d6bfe',
  'opencode-go': '#9333ea',
  'opencode-zen': '#9333ea',
}
const PALETTE = ['#0891b2', '#db2777', '#7c3aed', '#0d9488', '#c026d3', '#4f46e5', '#0284c7', '#be185d']

export function providerColor(provider: string): string {
  if (provider === 'refused') return FAIL
  const known = KNOWN[provider]
  if (known) return known
  let hash = 0
  for (const char of provider) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]!
}

// The acceptance bar for translated providers is a 90% cache hit.
function cacheColor(percent: number): string {
  return percent >= 90 ? OK : percent >= 50 ? WARN : FAIL
}

// Set by session.start; lets a press redraw the log at once instead of on the next tick.
let refreshNow: (() => Promise<void>) | undefined

const line = atom({ plugin: 'clauderipple-status', key: 'line' } as const, null)
const last = atom({ plugin: 'clauderipple-status', key: 'last' } as const, null)
const requests = atom({ plugin: 'clauderipple-status', key: 'requests' } as const, [])
const logOpen = atom({ plugin: 'clauderipple-status', key: 'logOpen' } as const, false)
const onlySession = atom({ plugin: 'clauderipple-status', key: 'onlySession' } as const, false)
const bandHidden = atom({ plugin: 'clauderipple-status', key: 'bandHidden' } as const, false)

type Usage = NonNullable<StatusRequest['usage']>

function promptTokens(usage: Usage): number {
  return usage.input + usage.cached + (usage.cacheWrite ?? 0)
}

function cachePercent(usage: Usage | undefined): number | undefined {
  if (!usage) return undefined
  const prompt = promptTokens(usage)
  return prompt > 0 ? Math.round((usage.cached / prompt) * 100) : undefined
}

function compact(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// The requested name's `@effort` is the agent file's default, not what was sent; the sent effort is
// its own field.
function modelOf(record: StatusRequest): string {
  const source = record.source.replace(/@[^@]*$/, '')
  return source === record.target ? record.target : `${record.target} (${source})`
}

function timeOf(at: string): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// Whether the pane is up is the engine's record, not ours: a reload drops the pane without a
// `ui.close` this module hears, while `$.state` keeps `logOpen` (seen 2026-10-05: the button stuck
// on "Close log" and the pane could not be reopened).
async function isLogUp($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function openLog($: EngineInterface) {
  await update($, logOpen, () => true)
  await $.ui.open({ id: PANE, title: 'ClaudeRipple' })
}

async function closeLog($: EngineInterface) {
  await update($, logOpen, () => false)
  await $.ui.close({ id: PANE })
}

async function toggleLog($: EngineInterface): Promise<boolean> {
  if (await isLogUp($)) {
    await closeLog($)
    return false
  }
  await openLog($)
  return true
}

async function hideBand($: EngineInterface) {
  await update($, bandHidden, () => true)
  await $.store.set(BAND_HIDDEN_KEY, true)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const session = await $.session.id()
    // An earlier version of this mod pinned a status line; this one draws nothing under the prompt.
    $.ui.status(undefined)
    const hidden = (await $.store.get(BAND_HIDDEN_KEY)) === true
    await update($, bandHidden, () => hidden)
    await $.command.register({ name: 'ripple-log', description: 'Open or close the ClaudeRipple request log' })
    await $.command.register({ name: 'ripple-bar', description: 'Show or hide the ClaudeRipple line above the prompt' })
    const ADMIN = await adminUrl($)

    const refresh = async () => {
      const isOpen = await isLogUp($)
      if (isOpen !== (await read($, logOpen))) await update($, logOpen, () => isOpen)
      if (!isOpen && (await read($, bandHidden))) return
      try {
        const own = await $.http.fetch(`${ADMIN}/api/requests?kind=messages&n=${isOpen ? LOG_ROWS : 1}&session=${encodeURIComponent(session)}`)
        const mine = (JSON.parse(own.text) as { requests?: StatusRequest[] }).requests ?? []
        const newest = mine[0] ?? null
        // A router older than the session field answers every session's requests, which would show
        // another conversation's route here: say so rather than show it.
        const notice = newest && newest.session === undefined ? 'ClaudeRipple: restart the router to show routes here' : null
        if (notice !== (await read($, line))) await update($, line, () => notice)
        if (JSON.stringify(newest) !== JSON.stringify(await read($, last))) await update($, last, () => newest)
        if (!isOpen) return
        const shown = (await read($, onlySession))
          ? mine
          : (JSON.parse((await $.http.fetch(`${ADMIN}/api/requests?kind=messages&n=${LOG_ROWS}`)).text) as { requests?: StatusRequest[] }).requests ?? []
        await update($, requests, () => shown.map(record => ({ ...record, mine: record.session === session })))
      } catch {
        await update($, line, () => 'ClaudeRipple: router not answering')
      }
    }
    refreshNow = refresh

    $.clock.after(1, () => void refresh())
    $.clock.every(EVERY_MS, () => void refresh())
    return result
  })

  // A worker runs on its own agent file's model, at the level its marker asks for wherever the
  // marker sits (./worker.ts). A fork inherits the parent's model and is not a worker spawn.
  on('agent.spawn', async ($, e, next) => {
    const fix = e.fork ? null : await workerFix($, e)
    if (!fix) return next(e)
    if (fix.dropped) $.ui.toast(`ClaudeRipple: ${e.subagentType} runs on its own model, not "${fix.dropped}"`)
    return next({ ...e, prompt: fix.prompt, model: fix.model })
  })

  on('command.run', { command: 'ripple-log' }, async $ => ({ text: (await toggleLog($)) ? 'ClaudeRipple log opened.' : 'ClaudeRipple log closed.' }))

  on('command.run', { command: 'ripple-bar' }, async $ => {
    if (await read($, bandHidden)) {
      await update($, bandHidden, () => false)
      await $.store.set(BAND_HIDDEN_KEY, false)
      return { text: 'ClaudeRipple line shown above the prompt.' }
    }
    await hideBand($)
    return { text: 'ClaudeRipple line hidden. /ripple-bar shows it again.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, logOpen, () => false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (await read($, bandHidden)) return next(e)
    const notice = await read($, line)
    const record = await read($, last)
    if (!notice && !record) return next(e)
    const isOpen = await read($, logOpen)
    const { Box, Button, Text } = $.ui.resolve(e)
    const cache = record ? cachePercent(record.usage) : undefined
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {notice || !record ? (
          <Text dimColor>{notice}</Text>
        ) : (
          <Box flexDirection="row" gap={1}>
            <Text color={record.ok ? OK : FAIL}>{record.ok ? '↳' : '✕'}</Text>
            <Text bold>{modelOf(record)}</Text>
            <Text color={providerColor(record.provider)}>{record.provider}</Text>
            {record.effort ? <Text dimColor>{record.effort}</Text> : null}
            {record.ok ? null : <Text color={FAIL}>{String(record.status)}</Text>}
            {record.ok && cache !== undefined ? <Text color={cacheColor(cache)}>cache {cache}%</Text> : null}
            <Text dimColor>{(record.ms / 1000).toFixed(1)}s</Text>
          </Box>
        )}
        <Button key="log" plain label={isOpen ? 'Close log' : 'Log'} onPress={() => toggleLog($)} />
        <Button key="hide" plain role="dismiss" label="×" onPress={() => hideBand($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const mineOnly = await read($, onlySession)
    const rows = await read($, requests)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>{mineOnly ? 'This session' : 'All sessions'}</Text>
          <Button
            key="scope"
            plain
            label={mineOnly ? 'Show all sessions' : 'This session only'}
            onPress={async () => {
              await update($, onlySession, value => !value)
              await refreshNow?.()
            }}
          />
        </Box>
        {!mineOnly && <Text dimColor>● this session  ○ other sessions</Text>}
        {rows.length === 0 && <Text dimColor>No model requests yet.</Text>}
        {rows.map(record => {
          const cache = cachePercent(record.usage)
          return (
            <Box key={`${record.at}-${record.target}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                {mineOnly ? null : <Text color={record.mine ? ACCENT : undefined} dimColor={!record.mine}>{record.mine ? '●' : '○'}</Text>}
                <Text dimColor>{timeOf(record.at)}</Text>
                <Text bold wrap="truncate-end">{modelOf(record)}</Text>
                <Text color={providerColor(record.provider)}>{record.provider}</Text>
                <Text color={record.ok ? OK : FAIL} bold={!record.ok}>{record.ok ? '✓' : `✕ ${record.status}`}</Text>
              </Box>
              <Box flexDirection="row" gap={1}>
                <Text dimColor>{record.effort ?? '-'}</Text>
                {record.usage ? <Text dimColor>in {compact(promptTokens(record.usage))}</Text> : null}
                {cache !== undefined ? <Text color={cacheColor(cache)}>cache {cache}%</Text> : null}
                {record.usage ? <Text dimColor>out {compact(record.usage.output)}</Text> : null}
                <Text dimColor>{(record.ms / 1000).toFixed(1)}s</Text>
              </Box>
              {!record.ok && record.note ? (
                <Text color={FAIL} wrap="wrap">
                  {record.note}
                </Text>
              ) : null}
            </Box>
          )
        })}
      </Box>
    )
  })
}
