// Integration through the actual mods engine. Only external host boundaries are stubbed.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, ModelCompleteRequest, ModelUsage, On, SessionMessage, ToolCallInput, TurnStepInput } from 'claude-code'
import { MOD_SETTINGS_SCHEMA_VERSION, DEFAULTS, normalizeModes, normalizeSettings } from '../hooks/settings'
import { QUICK_PROMPT } from '../hooks/handoff'
import { t } from '../hooks/i18n'
import type { Lang } from '../hooks/i18n'
import type { AgentRec, BgTask, ModSettingsSnapshot, Settings } from '../types'

const NOW = 1000000
const USAGE: ModelUsage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 }
const FILES: Record<string, string> = {
  'deepseek-v4-1-flash': '---\nname: deepseek-v4-1-flash\ndescription: Executor via deepseek.\nmodel: deepseek-v4.1-flash@medium\n---\nExecute.',
  'gpt-6-1-sol': '---\nname: gpt-6-1-sol\ndescription: Executor via chatgpt.\nmodel: gpt-6.1-sol@medium\n---\nExecute.',
  'gpt-6-astra': '---\nname: gpt-6-astra\ndescription: Executor via chatgpt.\nmodel: gpt-6-astra@high\n---\nExecute.',
}
const AA = { models: [
  { model: 'gpt-6.1-sol', provider: 'chatgpt', variants: [{ effort: 'high', intelligence: 50.24, costPerTask: 0.3191 }] },
  { model: 'gpt-6-astra', provider: 'chatgpt', variants: [{ effort: 'medium', intelligence: 49.6, costPerTask: 1.541 }] },
  { model: 'claude-sonnet-5-5', provider: 'anthropic', variants: [{ effort: 'high', intelligence: 46.8, costPerTask: 0.884 }] },
  { model: 'deepseek-v4.1-flash', provider: 'deepseek', variants: [{ effort: 'max', intelligence: 39.46, costPerTask: 0.2652 }] },
] }
// GET /api/mod-options as a router of 2026-10-11 answers it: workers with ladders and billing.
const MOD_OPTIONS = {
  agents: [
    { name: 'deepseek-v4-1-flash', model: 'deepseek-v4.1-flash', provider: 'deepseek', efforts: ['low', 'high', 'max'], billing: 'payg' },
    { name: 'gpt-6-1-sol', model: 'gpt-6.1-sol', provider: 'chatgpt', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], billing: 'subscription' },
    { name: 'gpt-6-astra', model: 'gpt-6-astra', provider: 'chatgpt', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], billing: 'subscription' },
  ],
  providers: [{ name: 'deepseek', type: 'anthropic-compatible', usable: true, billing: 'payg' }, { name: 'chatgpt', type: 'chatgpt', usable: true, billing: 'subscription' }],
  claudeEfforts: ['low', 'medium', 'high', 'max'],
  scores: AA,
}
const CONFIG = { admin: { port: 9992 }, providers: { deepseek: { models: [{ id: 'deepseek-v4.1-flash' }] }, chatgpt: { models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }] }, anthropic: { models: [{ id: 'claude-sonnet-5-5' }] } } }
const SPAWN: AgentSpawnInput = { tool_use_id: 'tool1', subagentType: 'ripple:auto', prompt: 'Rename one local variable and verify it.', description: 'Rename variable', parentModel: 'claude-opus-5-5', provider: { plugin: 'engine', tier: 'core' }, background: false, fork: false }
const MESSAGES: SessionMessage[] = [{ role: 'user', text: 'Implement the specified change and verify it.', toolUses: [] }, { role: 'assistant', text: 'The implementation is ready.', toolUses: [] }]
// The user naming the workers a test spawns by name (worker.ts userNamed).
const NAMED: SessionMessage[] = [{ role: 'user', text: 'Use Sol, Astra or DeepSeek for this.', toolUses: [] }]

function boundaries(on: On, patch: Partial<Settings> = {}, options: { config?: unknown; paths?: string[]; key?: string; envFile?: string | (() => string); language?: unknown; env?: Record<string, string>; platform?: string; browserFailure?: 'exit' | 'throw'; appleLocale?: string; appleFail?: boolean; limits?: { kind: string; percentUsed: number; resetsAt?: string }[]; agentMessages?: (agentId: string) => SessionMessage[]; messages?: SessionMessage[]; window?: number; tokens?: number; compactAt?: number | null; engineWindow?: number; context?: { model: string; window: number; tokens: number; raw?: number }; deferUsage?: (kind: 'full' | 'summary' | 'none') => Promise<void> | undefined; phoneSubmit?: (text: string) => 'submitted' | 'drop' | 'throw' } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  const storeWrites: string[] = []
  const storeReads: string[] = []
  let router: ModSettingsSnapshot = { settings: normalizeSettings({ setupDone: true, ...patch }), revision: 1, stored: true, ...(options.compactAt !== undefined ? { compactAt: options.compactAt } : {}) }
  let offline = false
  let conflict: Settings | null = null
  let alwaysConflict = false
  const settingsRequests: { method: string; settings?: unknown; revision?: unknown; schemaVersion?: unknown }[] = []
  on('http.fetch', { url: /\/api\/mod-settings$/ }, ($, e) => {
    if (offline) throw new Error('router unavailable')
    const method = e.init?.method ?? 'GET'
    if (method === 'GET') {
      settingsRequests.push({ method })
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(router) } }
    }
    const input = JSON.parse(e.init?.body ?? '{}')
    settingsRequests.push({ method, settings: input.settings, revision: input.revision, schemaVersion: input.schemaVersion })
    if (conflict) { router = { settings: conflict, revision: router.revision + 1, stored: true }; conflict = null }
    if (alwaysConflict) router = { ...router, revision: router.revision + 1 }
    const stale = input.revision !== router.revision
    if (!stale) router = { settings: normalizeSettings(input.settings), revision: router.revision + 1, stored: true }
    return { value: { ok: !stale, status: stale ? 409 : 200, headers: {}, text: JSON.stringify(router) } }
  })
  const toasts: string[] = []
  const logs: string[] = []
  const submitted: string[] = []
  const filled: string[] = []
  const panes = new Set<string>()
  let model = 'claude-opus-5-5'
  let percent = 20
  on('store.get', ($, e) => { storeReads.push(e.key); return { value: saved.get(e.key) } })
  on('store.set', ($, e) => { storeWrites.push(e.key); saved.set(e.key, e.value); return { value: undefined } })
  mock.env(on, { HOME: '/home/test', LANG: 'en_US.UTF-8', ...(options.key ? { TYPESAFE_API_KEY: options.key } : {}), ...options.env })
  let hostLanguage = options.language
  const processes: { argv: readonly string[]; timeoutMs?: number }[] = []
  on('settings.read', () => ({ value: { language: hostLanguage } }))
  let resolvedLanguage: unknown
  on('state.set', { plugin: 'ripple', key: 'lang' }, async ($, e, next) => {
    const result = await next(e)
    if ('value' in result && result.value?.isSet) resolvedLanguage = e.value
    return result
  })
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', ($, e) => {
    processes.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    if (['open', 'xdg-open', 'cmd'].includes(e.argv[0] ?? '') && options.browserFailure) {
      if (options.browserFailure === 'throw') throw new Error('browser unavailable')
      return { value: { exitCode: 1, stdout: '', stderr: 'browser unavailable', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'uname') return { value: { exitCode: 0, stdout: options.platform ?? 'Linux', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'defaults' && options.appleFail) return { value: { exitCode: 1, stdout: '', stderr: 'locale timed out', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: options.appleLocale ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const files = new Map<string, string>()
  let logFailure: 'read' | 'write' | null = null
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.write', ($, e) => {
    if (e.path.endsWith('/worker-picks.jsonl') && logFailure === 'write') return { deny: 'worker log write denied' }
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    options.paths?.push(e.path)
    if (e.path.endsWith('/worker-picks.jsonl') && logFailure === 'read') return { deny: 'worker log read denied' }
    if (files.has(e.path)) return { value: files.get(e.path)! }
    if (e.path.endsWith('generated-agents.json')) return { value: JSON.stringify({ agents: [...Object.keys(FILES), 'claude-sonnet-5-5'] }) }
    if (e.path.endsWith('/claude-sonnet-5-5.md')) return { value: '---\nname: claude-sonnet-5-5\ndescription: Execute via anthropic.\nmodel: claude-sonnet-5-5@high\n---\nExecute.' }
    if (e.path.endsWith('config.json')) return { value: JSON.stringify(options.config ?? CONFIG) }
    if (e.path.endsWith('/.config/jev/.env')) return { value: typeof options.envFile === 'function' ? options.envFile() : options.envFile ?? '' }
    const name = e.path.split('/').pop()?.replace(/\.md$/, '') ?? ''
    return { value: FILES[name] ?? '' }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.SessionStart', () => ({}))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const registered: { name: string; prompt: string; disallowedTools?: readonly string[]; description: string }[] = []
  on('agent.register', ($, e) => { registered.push(e); return { value: { agent: 'ripple:' + e.name } } })
  on('command.list', () => ({ value: [{ name: 'clear', description: 'Clear', source: 'builtin' }, { name: 'compact', description: 'Compact', source: 'builtin' }, { name: 'model', description: 'Model', source: 'builtin' }] }))
  on('session.id', () => ({ value: 'session-test' }))
  on('session.model', () => ({ value: model }))
  on('session.messages', ($, e) => ({ value: e.agentId && options.agentMessages ? options.agentMessages(e.agentId) : options.messages ?? MESSAGES }))
  // `engineWindow`: the window the session's own breakdown measures against, as /context gives it.
  // `context`: the same, movable by a test, so a model or window switch leaves the tokens alone.
  const breakdown = (tokens: number, raw: number, modelId = model) => ({ categories: [], totalTokens: tokens, maxTokens: raw, rawMaxTokens: raw, autocompactSource: 'clientdata' as const, percentage: Math.round(tokens / raw * 100), gridRows: [], model: modelId, memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null })
  on('session.usage', async ($, e) => {
    const c = options.context
    const tokens = c?.tokens ?? options.tokens ?? 40000
    const window = c?.window ?? options.window ?? 200000
    const raw = c?.raw ?? c?.window ?? options.engineWindow
    const reply = { value: { startedAt: NOW, context: { percent: c ? Math.round(tokens / window * 100) : percent, tokens, window, ...(e.breakdown && raw ? { breakdown: breakdown(tokens, raw, c?.model) } : {}) }, rateLimits: options.limits ?? [] } }
    const wait = options.deferUsage?.(e.breakdown ?? 'none')
    if (wait) await wait
    return reply
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', ($, e) => { panes.add(e.id); return { value: { isPlaced: true } } })
  on('ui.close', ($, e) => { panes.delete(e.id); return { value: undefined } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['host drawing'] }))
  // What the model reads beside each prompt, as the hooks attached it.
  const contexts: (readonly string[])[] = []
  on('prompt.submit', ($, e) => {
    submitted.push(e.text); contexts.push(e.context ?? [])
    const action = options.phoneSubmit?.(e.text)
    if (action === 'throw') throw new Error('private prompt text must not be logged')
    return action === 'drop' ? { drop: 'not accepted' } : { text: e.text }
  })
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true } })
  return { files, failWorkerLog: (value: 'read' | 'write' | null) => { logFailure = value }, registered, clock, saved, storeWrites, storeReads, settingsRequests, router: () => router, remote: (value: ModSettingsSnapshot) => { router = value }, offline: (value: boolean) => { offline = value }, conflict: (value: Settings) => { conflict = value }, alwaysConflict: (value: boolean) => { alwaysConflict = value }, toasts, logs, panes, submitted, contexts, filled, processes, language: () => resolvedLanguage, setLanguage: (value: unknown) => { hostLanguage = value }, setModel: (id: string) => { model = id }, setPercent: (value: number) => { percent = value } }
}
function http(on: On, exhausted = false, config: unknown = CONFIG, zen?: (input: { url: string; init?: { body?: string; headers?: Readonly<Record<string, string>> } }) => void) {
  const urls: string[] = []
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    urls.push(e.url)
    if (e.url === 'https://opencode.ai/zen/v1/systemone' && zen) {
      zen(e)
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: 'jev-1.13', answers: { effort: { choice: 'high', confidence: 0.95 } }, usage: { input_tokens: 50, output_tokens: 10 } }) } }
    }
    const body = e.url.includes('/api/phone-inbox?') ? { offers: [] } : e.url.endsWith('/api/status') ? { chatgpt: { accounts: { chatgpt: [{ state: 'ready', quota: { rate_limits: { primary: { used_percent: exhausted ? 100 : 20 } } } }] } } } : e.url.endsWith('/api/config') ? config : e.url.endsWith('/api/mod-options') ? { ...MOD_OPTIONS, providers: MOD_OPTIONS.providers.map(p => p.name === 'chatgpt' ? { ...p, usable: !exhausted } : p) } : { requests: [] }
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(body) } }
  })
  return urls
}
function judgeStub(on: On, text = '{"domain":"general","level":"light","effort":"low","sure":0.9,"why":"small rename"}') {
  const calls: ModelCompleteRequest[] = []
  on('model.complete', ($, e) => { calls.push(e); return { value: { isAnswered: true, text, usage: USAGE } } })
  return calls
}
function spawnStub(on: On) {
  const sent: AgentSpawnInput[] = []
  on('agent.spawn', ($, e) => { sent.push(e); return { model: e.model ?? 'sonnet', agentId: 'worker-1' } })
  return sent
}
/** The records and counts the mod last wrote into its session atoms. */
function agentWrites(on: On) {
  let records: AgentRec[] = []
  let counts: { live: number; total: number } | null = null
  on('state.set', { plugin: 'ripple', key: 'agents' }, async ($, e, next) => {
    const result = await next(e)
    records = e.value as AgentRec[]
    return result
  })
  on('state.set', { plugin: 'ripple', key: 'agentCounts' }, async ($, e, next) => {
    const result = await next(e)
    counts = e.value as { live: number; total: number }
    return result
  })
  return { records: () => records, counts: () => counts }
}
/** A spawn that names each worker in turn: `<name>1`, `<name>2`, … */
function numberedSpawn(on: On, name: string): void {
  let n = 0
  on('agent.spawn', ($, e) => { n += 1; return { model: e.model ?? 'sonnet', agentId: name + n } })
}
/** A session whose model and window a test can move while its tokens stay put, as a model switch leaves them. */
function movableContext() {
  return { model: 'claude-opus-5-5', window: 160_000, tokens: 32_000 }
}
/** The Context pane, as the band opens it, for a precise count's label. */
function contextPane($: Engine) {
  return $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-context', surface: 'terminal', props: { title: 'Context', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
}
function stepStub(on: On, usage: ModelUsage | null = USAGE) {
  const sent: TurnStepInput[] = []
  on('turn.step', async function* ($, e) {
    sent.push(e)
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usage ? { ...usage, model: e.model } : null }
  })
  return sent
}
async function command($: Engine, args: string) {
  return $.command.run({ command: 'ripple', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 } })
}
async function start($: Engine) { await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true }) }
async function step($: Engine, model = 'claude-opus-5-5', effort: TurnStepInput['effort'] = 'medium', agentId?: string) {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, messageCount: 2, model, effort, ...(agentId ? { agentId } : {}) })
  let result = await stream.next()
  while (result.done !== true) result = await stream.next()
  return result.value
}
async function submit($: Engine, text = 'Implement the bounded change and verify the tests.', turnId?: string) {
  return $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, ...(turnId ? { turnId } : {}) })
}
async function complete($: Engine, agentId?: string, answer = 'Finished.') {
  await $.turn.complete({ turnId: 'turn-1', answer, reason: 'answer', durationMs: 1000, isAborted: false, ...(agentId ? { agentId } : {}) })
}
async function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal', hasSurvey = false) {
  return $.ui.mount({ plugin: 'ripple', component: 'AbovePrompt', requestId: 'band', surface,
    viewport: { columns: 140, rows: 40 }, props: { hasSurvey, isWorking: false, bodyColumns: 130, maxRows: 20, scroll: { offset: 0, bodyRows: 20 }, view: {} } })
}

test('router settings override legacy store and revision changes redraw even with the band hidden', async ($, on) => {
  const b = boundaries(on, { language: 'pt' })
  b.saved.set('settings', normalizeSettings({ language: 'ko' }))
  http(on)
  await start($)
  expectLanguage(b, 'pt')
  expect(b.storeReads).not.toContain('settings')
  await command($, 'bar')
  b.remote({ settings: normalizeSettings({ setupDone: true, language: 'ja', effortAuto: false }), revision: 2, stored: true })
  await b.clock.advance(3000)
  expectLanguage(b, 'ja')
  await command($, 'bar')
  const ui = await band($)
  expect((await ui.find({ key: 'auto' }))?.props.label).toContain('○')
  b.remote({ settings: normalizeSettings({ setupDone: true, language: 'ko' }), revision: 2, stored: true })
  await b.clock.advance(3000)
  expectLanguage(b, 'ja') // An unchanged revision does not replace the atom.
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  await ui.unmount()
})

test('an unrelated user change uses the fresh router ladder and saved modes, not a local whole snapshot', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  const steps = [{ target: { agent: 'gpt-6-astra' }, effort: 'high' as const }, { target: { agent: 'gpt-6-1-sol' }, effort: 'medium' as const }]
  const fresh = normalizeSettings({ setupDone: true, rules: { general: { mode: 'ladder', rungs: { hard: steps } } }, modes: [{ id: 'saved', name: 'Saved', rungs: { plan: steps }, until: 'none' }], activeMode: 'saved' })
  b.remote({ settings: fresh, revision: 2, stored: true })
  await ui.press({ key: 'bias-1' }) // No poll has installed the newer router snapshot yet.
  expect(b.router().settings.rules).toEqual(fresh.rules)
  expect(b.router().settings.modes).toEqual(fresh.modes)
  expect(b.router().settings.activeMode).toBe('saved')
  const writes = b.settingsRequests.filter(r => r.method === 'PUT')
  expect(writes.length).toBe(1)
  expect(writes[0]?.revision).toBe(2)
  expect(writes[0]?.schemaVersion).toBe(MOD_SETTINGS_SCHEMA_VERSION)
  await ui.unmount()
})

test('reload discards old-format pending overwrites and migration even at the same stored revision', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const original = b.router().settings
  let oldState = true
  let installed: unknown
  on('state.get', { plugin: 'ripple', key: 'settingsSync' }, ($, e, next) => oldState ? { value: { value: { revision: 1, pending: [{ path: ['rules'], value: {} }, { path: ['modes'], value: [] }], migrationChecked: true, migration: normalizeSettings(null) }, version: 0 } } : next(e))
  on('state.set', { plugin: 'ripple', key: 'settingsSync' }, async ($, e, next) => {
    const result = await next(e)
    oldState = false
    installed = e.value
    return result
  })
  await start($)
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  expect(b.router().settings).toEqual(original)
  expect(installed).toMatchObject({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, pending: [], migration: null })
})

test('saving the already-selected setting sends no normalization-only PUT', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'bias-0' })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  expect(b.router().revision).toBe(1)
  await ui.unmount()
})

test('empty router uses defaults without writing when there is no legacy store', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  http(on)
  await start($)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'Welcome to ClaudeRipple' })).toBeDefined()
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  await ui.unmount()
})

// 2026-10-20: a stray test router took the live router's launchd label for five minutes and answered
// with nothing stored; every chat took its defaults, opened setup and asked for the Jev key again,
// and kept asking after the real router came back.
test('a router that lost its settings gets this chat\'s back instead of opening setup', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings({ setupDone: true, language: 'pt', keepWarm: true }), revision: 7, stored: true })
  http(on)
  await start($)
  expectLanguage(b, 'pt')
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  await b.clock.advance(3000)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'Welcome to ClaudeRipple' })).toBeUndefined()
  expectLanguage(b, 'pt')
  expect(b.router()).toMatchObject({ stored: true, settings: { setupDone: true, language: 'pt', keepWarm: true } })
  await ui.unmount()
})

test('a setup card left open closes once the router says setup is done', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  http(on)
  await start($)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'Welcome to ClaudeRipple' })).toBeDefined()
  b.remote({ settings: normalizeSettings({ setupDone: true }), revision: 3, stored: true })
  await b.clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: 'Welcome to ClaudeRipple' })).toBeUndefined()
  await ui.unmount()
})

test('legacy settings and setup completion migrate once; unrelated store keys survive', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  b.saved.set('settings', { language: 'pt', keepWarm: true, tiers: { light: { agent: 'old-worker' } } })
  b.saved.set('setupDone', true)
  b.saved.set('bandLayout', { density: 'compact' })
  http(on)
  await start($)
  expect(b.router().settings).toMatchObject({ language: 'pt', keepWarm: true, setupDone: true, rules: { general: { mode: 'ladder', rungs: { light: [{ target: { agent: 'old-worker' } }] } } } })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(1)
  expect(b.settingsRequests.find(r => r.method === 'PUT')?.revision).toBe(0)
  b.saved.set('settings', { language: 'ko' })
  await b.clock.advance(3000)
  await $.classic.SessionStart({ source: 'clear' })
  expectLanguage(b, 'pt')
  expect(b.storeReads.filter(key => key === 'settings').length).toBe(1)
  expect(b.storeWrites).not.toContain('settings')
  expect(b.saved.get('bandLayout')).toEqual({ density: 'compact' })
})

test('a quick change retries a stale revision once and preserves remote sibling fields', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  b.conflict(normalizeSettings({ setupDone: true, ceiling: 'high', language: 'pt', allow: ['remote'] }))
  await ui.press({ key: 'bias-1' })
  const writes = b.settingsRequests.filter(r => r.method === 'PUT')
  expect(writes.map(r => r.revision)).toEqual([1, 2])
  expect(b.router().settings).toMatchObject({ bias: 1, ceiling: 'high', language: 'pt', allow: ['remote'] })
  expectLanguage(b, 'pt')
  expect(b.storeWrites).not.toContain('settings')
  await ui.unmount()
})

test('two conflicts stop the save retry and retain the edit for the next poll', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  b.alwaysConflict(true)
  await ui.press({ key: 'bias-1' })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(2)
  expect(b.router().settings.bias).toBe(0)
  // Opening the panel syncs first, which tries the kept edit again (two more conflicts).
  await command($, 'settings')
  expect((await ui.find({ key: 'bias-1' }))?.props.label).toBe('● +1')
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(4)
  b.alwaysConflict(false)
  await b.clock.advance(3000)
  expect(b.router().settings.bias).toBe(1)
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(5)
  await ui.unmount()
})

test('migration loses a first-write race without overwriting existing server settings', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  b.saved.set('settings', { language: 'pt' })
  b.conflict(normalizeSettings({ setupDone: true, language: 'ja', keepWarm: true }))
  http(on)
  await start($)
  expectLanguage(b, 'ja')
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(1)
  expect(b.router().settings).toMatchObject({ language: 'ja', keepWarm: true })
  await b.clock.advance(3000)
  expect(b.storeReads.filter(key => key === 'settings').length).toBe(1)
})

test('offline startup recovers and migrates legacy settings only after reaching an empty router', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  b.saved.set('settings', { language: 'pt', setupDone: true })
  b.offline(true)
  http(on)
  await start($)
  expect(b.storeReads).not.toContain('settings')
  b.offline(false)
  await b.clock.advance(3000)
  expectLanguage(b, 'pt')
  expect(b.router().stored).toBe(true)
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(1)
})

test('an open quick panel follows newer settings and saves only the next change', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  b.remote({ settings: normalizeSettings({ setupDone: true, bias: -1, ceiling: 'high', keepWarmHours: 8 }), revision: 2, stored: true })
  await b.clock.advance(3000)
  expect((await ui.find({ key: 'bias--1' }))?.props.label).toBe('● −1')
  await ui.press({ key: 'bias-1' })
  expect(b.router().settings).toMatchObject({ bias: 1, ceiling: 'high', keepWarmHours: 8 })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').map(r => r.revision)).toEqual([2])
  await ui.unmount()
})

test('offline quick changes stay local, show router notice and retry on next poll', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  b.offline(true)
  await ui.press({ key: 'bias-1' })
  expect(b.router().settings.bias).toBe(0)
  await command($, 'settings')
  expect((await ui.find({ key: 'bias-1' }))?.props.label).toBe('● +1')
  expect(b.toasts.some(text => text.includes('router not answering'))).toBe(true)
  expect(b.toasts).not.toContain('Settings saved')
  expect(b.storeWrites).not.toContain('settings')
  b.remote({ settings: normalizeSettings({ setupDone: true, ceiling: 'high' }), revision: 2, stored: true })
  b.offline(false)
  await b.clock.advance(3000)
  expect(b.router().settings).toMatchObject({ bias: 1, ceiling: 'high' })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').map(r => r.revision)).toEqual([2])
  await ui.unmount()
})

test('a router that stops answering is said in the band, not hidden behind the last route', async ($, on) => {
  const b = boundaries(on)
  const route = { at: '2026-10-25T00:00:00.000Z', source: 'deepseek-v4.1-flash', target: 'deepseek-v4.1-flash', provider: 'deepseek', status: 200, ok: true, ms: 1000, session: 'session-test' }
  let down = false
  const lines: unknown[] = []
  on('state.set', { plugin: 'ripple', key: 'line' }, async ($, e, next) => { const result = await next(e); lines.push(e.value); return result })
  // A URL handler must come before http()'s catch-all: that one answers this path itself.
  on('http.fetch', { url: /\/api\/requests/ }, () => down
    ? { value: { ok: false, status: 503, headers: {}, text: '' } }
    : { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ requests: [route] }) } })
  http(on)
  await start($)
  await b.clock.advance(3000)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /deepseek-v4\.1-flash/ })).toBeDefined()
  // The route is the last record; the notice is the router's state now, and one must not stand for the other.
  down = true
  await b.clock.advance(3000)
  expect(lines, 'routerDown line').toContain('ClaudeRipple: router not answering')
  expect(await ui.find({ type: 'Text', text: /router not answering/ }), 'terminal notice').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /deepseek-v4\.1-flash/ }), 'terminal stale route').toBeUndefined()
  await ui.unmount()
  const desktop = await band($, 'desktop')
  expect(await desktop.find({ type: 'Text', text: /router not answering/ }), 'desktop notice').toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /deepseek-v4\.1-flash/ }), 'desktop stale route').toBeUndefined()
  await desktop.unmount()
})

function expectLanguage(boundary: ReturnType<typeof boundaries>, language: Lang): void {
  expect(boundary.language()).toBe(language)
}

test('explicit mod language wins over host settings and locale', async ($, on) => {
  const b = boundaries(on, { language: 'pt' }, { language: 'Korean', env: { LANG: 'ja_JP', LC_ALL: 'es_ES' } })
  http(on)
  await start($)
  expectLanguage(b, 'pt')
  expect(b.processes).toEqual([])
})

test('auto prefers Claude Code language over LANG and LC_ALL', async ($, on) => {
  const b = boundaries(on, {}, { language: '한국어', env: { LANG: 'ja_JP', LC_ALL: 'es_ES' } })
  http(on)
  await start($)
  expectLanguage(b, 'ko')
  expect(b.processes).toEqual([])
})

test('off macOS, auto checks LANG then LC_ALL when the host setting is unsupported', async ($, on) => {
  const b = boundaries(on, {}, { language: 12, env: { LANG: 'zh-Hans', LC_ALL: 'pt_BR' } })
  http(on)
  await start($)
  expectLanguage(b, 'zh')
  expect(b.processes).toEqual([{ argv: ['uname', '-s'], timeoutMs: 2000 }])
})

// The desktop app can start a session with LANG=en_US on a Mac set to Korean (2026-10-10).
test('on macOS the system language wins over LANG', async ($, on) => {
  const b = boundaries(on, {}, { env: { LANG: 'en_US.UTF-8' }, platform: 'Darwin', appleLocale: 'ko_KR\n' })
  http(on)
  await start($)
  expectLanguage(b, 'ko')
})

test('auto accepts LC_ALL after an unsupported LANG', async ($, on) => {
  const b = boundaries(on, {}, { env: { LANG: 'C.UTF-8', LC_ALL: 'es_ES' } })
  http(on)
  await start($)
  expectLanguage(b, 'es')
  expect(b.processes).toEqual([{ argv: ['uname', '-s'], timeoutMs: 2000 }])
})

test('auto reads AppleLocale only on macOS with a two-second timeout', async ($, on) => {
  const b = boundaries(on, {}, { env: { LANG: 'C', LC_ALL: '' }, platform: 'Darwin', appleLocale: 'ja_JP\n' })
  http(on)
  await start($)
  expectLanguage(b, 'ja')
  expect(b.processes).toEqual([{ argv: ['uname', '-s'], timeoutMs: 2000 }, { argv: ['defaults', 'read', '-g', 'AppleLocale'], timeoutMs: 2000 }])
})

test('auto defaults to English off macOS', async ($, on) => {
  const b = boundaries(on, {}, { env: { LANG: 'C', LC_ALL: '' } })
  http(on)
  await start($)
  expectLanguage(b, 'en')
  expect(b.processes.length).toBe(1)
})

test('a failed macOS locale lookup logs the failure and falls back without preventing startup', async ($, on) => {
  const b = boundaries(on, {}, { env: { LANG: 'C', LC_ALL: '' }, platform: 'Darwin', appleFail: true })
  http(on)
  await start($)
  expectLanguage(b, 'en')
  expect(b.logs.some(log => log.includes('locale timed out'))).toBe(true)
  expect((await command($, 'stats')).text).toContain('Auto:')
})

test('dashboard language changes re-resolve auto from current host settings', async ($, on) => {
  const b = boundaries(on, { language: 'pt' }, { language: 'Korean' })
  http(on)
  await start($)
  b.remote({ settings: normalizeSettings({ setupDone: true, language: 'auto' }), revision: 2, stored: true })
  await b.clock.advance(3000)
  expectLanguage(b, 'ko')
  b.setLanguage('Japanese')
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'bias-1' })
  expectLanguage(b, 'ja')
  expect(b.router().settings.language).toBe('auto')
  await ui.unmount()
})

test('ripple:auto with no tier marker runs general standard on the owner\'s ladder, unjudged, and the pick is logged', async ($, on) => {
  const b = boundaries(on)
  const urls = http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const result = await $.agent.spawn(SPAWN)
  expect(result.agentId).toBe('worker-1')
  // The owner's ladder runs general standard on Sol at medium; nothing judged the task.
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@medium' })
  expect(judges.length).toBe(0)
  // Provider health is still read at request time; no judge is asked, by any route.
  expect(urls).toContain('http://127.0.0.1:9992/api/status')
  expect(urls.some(url => url.includes('typesafe') || url.includes('opencode'))).toBe(false)
  // The only debug line is the pick itself: no error was reported on the way.
  expect(b.logs.length).toBe(1)
  expect(b.logs[0]!.startsWith('ClaudeRipple worker pick: ')).toBe(true)
  expect(JSON.parse(b.logs[0]!.slice('ClaudeRipple worker pick: '.length))).toEqual({
    task: 'Rename variable', domain: 'general', level: 'standard', kind: 'do', rule: 'general', rung: 'standard', position: 1, skipped: [],
    target: { agent: 'gpt-6-1-sol' }, model: 'gpt-6.1-sol@medium', effort: 'medium', by: 'default',
  })
  const persisted = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!
  expect(persisted.endsWith('\n')).toBe(true)
  expect(persisted.trim().split('\n').length).toBe(1)
  const row = JSON.parse(persisted)
  expect(typeof row.id).toBe('string')
  expect(row).toEqual({
    ...JSON.parse(b.logs[0]!.slice('ClaudeRipple worker pick: '.length)),
    type: 'pick', id: row.id, at: new Date(NOW).toISOString(), promptChars: SPAWN.prompt.length,
  })
  // The worker judge is gone: its keys no longer reach a pick row.
  for (const key of ['verdict', 'judge', 'ms', 'error', 'sure', 'tier']) expect(row).not.toHaveProperty(key)
  const stats = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(stats.text).toContain('standard 1')
})

test('worker pick persistence keeps the last 3,000 lines and concurrent reasoned picks, never the prompt', async ($, on) => {
  const b = boundaries(on, {}, { env: { CLAUDERIPPLE_HOME: '/custom/ripple' }, messages: NAMED })
  http(on)
  const judges = judgeStub(on)
  spawnStub(on)
  const path = '/custom/ripple/logs/worker-picks.jsonl'
  b.files.set(path, Array.from({ length: 3005 }, (_, n) => JSON.stringify({ old: n })).join('\n') + '\n')
  await start($)
  const prompt = '[[ripple: gpt-6-1-sol@xhigh]]\nModel reason: user "Use Sol, Astra"\nPRIVATE_TASK_PROMPT'
  await Promise.all(['first', 'second'].map(label => $.agent.spawn({ ...SPAWN, description: label + 'x'.repeat(220), prompt })))
  const text = b.files.get(path)!
  const rows = text.trim().split('\n').map(line => JSON.parse(line))
  expect(rows.length).toBe(3000)
  expect(rows[0]).toEqual({ old: 7 })
  expect(rows.slice(-2).map(row => row.task).sort()).toEqual(['first' + 'x'.repeat(195), 'second' + 'x'.repeat(194)])
  for (const row of rows.slice(-2)) {
    expect(row).toMatchObject({ by: 'user', namedModel: 'gpt-6-1-sol', source: 'user', model: 'gpt-6.1-sol@xhigh', effort: 'xhigh' })
    expect(row).not.toHaveProperty('rung')
  }
  expect(text).not.toContain('PRIVATE_TASK_PROMPT')
  expect(b.logs.join('\n')).not.toContain('PRIVATE_TASK_PROMPT')
  expect(judges.length).toBe(0)
})

for (const failure of ['read', 'write'] as const) test(`worker log ${failure} failure reports without changing the spawn and later recovers`, async ($, on) => {
  const b = boundaries(on)
  http(on)
  const sent = spawnStub(on)
  const path = '/home/test/.clauderipple/logs/worker-picks.jsonl'
  const previous = JSON.stringify({ previous: true }) + '\n'
  b.files.set(path, previous)
  b.failWorkerLog(failure)
  await start($)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('worker-1')
  expect(sent.length).toBe(1)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@medium' })
  expect(b.logs.some(log => log.includes('worker pick log') && log.includes(`worker log ${failure} denied`))).toBe(true)
  expect(b.files.get(path)).toBe(previous)
  b.failWorkerLog(null)
  await $.agent.spawn(SPAWN)
  expect(b.files.get(path)!.trim().split('\n').length).toBe(2)
})

// A model is named only with its source, and the mod checks each claim before it runs anything.
for (const [label, prompt, said] of [
  ['no Model reason line', '[[ripple: gpt-6-1-sol@high]]\nReview this.', 'No reason was given for the model gpt-6-1-sol'],
  ['a quote the user never said', '[[ripple: gpt-6-1-sol@high]]\nModel reason: user "Use Astra now"\nReview this.', "not in the user's recent messages"],
  ['a name this machine cannot run', '[[ripple: nope-model@high]]\nModel reason: rule CLAUDE.md — always\nReview this.', 'cannot run on this computer'],
] as const) test(`a model marker is refused with ${label}`, async ($, on) => {
  const b = boundaries(on)
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const result = await $.agent.spawn({ ...SPAWN, prompt })
  expect(result.deny).toContain(said)
  expect(sent.length).toBe(0)
  expect(judges.length).toBe(0)
  expect(b.logs).toEqual([])
  expect(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')).toBeUndefined()
})

// The session names the tier on the prompt's first line; the owner's ladder names the model.
for (const prefix of ['ripple:', '']) for (const [tier, level, kind, rung, agent, model, effort] of [
  ['light', 'light', 'do', 'light', 'deepseek-v4-1-flash', 'deepseek-v4.1-flash@max', 'max'],
  ['standard', 'standard', 'do', 'standard', 'gpt-6-1-sol', 'gpt-6.1-sol@medium', 'medium'],
  ['hard', 'deep', 'do', 'hard', 'gpt-6-astra', 'gpt-6-astra@high', 'high'],
  ['max', 'deep', 'plan', 'plan', 'general-purpose', 'claude-opus-5-5', 'high'],
] as const) test(`${prefix}auto: a [[ripple: ${tier}]] marker runs the ${rung} rung by the session's word`, async ($, on) => {
  const b = boundaries(on)
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  const steps = stepStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: prefix + 'auto', prompt: `[[ripple: ${tier}]]\n${SPAWN.prompt}` })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: agent === 'general-purpose' ? 'ripple:auto' : agent, model, prompt: SPAWN.prompt })
  expect(JSON.parse(b.logs.find(log => log.startsWith('ClaudeRipple worker pick: '))!.slice('ClaudeRipple worker pick: '.length))).toMatchObject({ level, kind, rung, by: 'session', effort })
  expect(JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)).toMatchObject({ tier, by: 'session' })
  // Named workers carry effort in their model suffix; Claude's own agent gets it on turn.step.
  if (agent === 'general-purpose') {
    await step($, 'claude-opus-5-5', 'low', 'worker-1')
    expect(steps[0]?.effort).toBe(effort)
  }
})

// A model marker with the user's own words: the mod checks the quote and never reads it as language.
test('a model marker with a quoted user reason runs that model at its @effort, by user, and its outcome joins the pick', async ($, on) => {
  const b = boundaries(on, {}, { messages: [{ role: 'user', text: 'Use Sol, Astra or DeepSeek for this task.', toolUses: [] }] })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-1-sol@xhigh]]\nModel reason: user "use sol, astra"\nReview the change.' })
  await b.clock.settle()
  // The worker reads neither the marker nor the reason line.
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@xhigh', prompt: 'Review the change.' })
  expect(judges.length).toBe(0)
  const rows = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
  const pick = rows.find(row => row.type === 'pick')
  expect(pick).toMatchObject({ by: 'user', namedModel: 'gpt-6-1-sol', source: 'user', reason: '"use sol, astra"', domain: 'general', level: 'standard', model: 'gpt-6.1-sol@xhigh', effort: 'xhigh' })
  expect(pick.rung).toBeUndefined()
  // The worker's end joins the same pick.
  await complete($, 'worker-1', 'Reviewed and fixed.')
  const after = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
  expect(after.find(row => row.type === 'outcome')).toMatchObject({ pick: pick.id, agent: 'worker-1', reason: 'answer', aborted: false, ms: 1000, answerChars: 19 })
  // Once: a second completion of the same agent writes no second outcome.
  await complete($, 'worker-1')
  expect(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').filter(line => line.includes('"outcome"')).length).toBe(1)
})

test('a worker that ends before its spawn is recorded is listed as ended, not running', async ($, on) => {
  const b = boundaries(on)
  http(on)
  judgeStub(on)
  let written: AgentRec[] = []
  on('state.set', { plugin: 'ripple', key: 'agents' }, async ($, e, next) => {
    const result = await next(e)
    written = e.value as AgentRec[]
    return result
  })
  // Its first request fails at once: the end arrives while the spawn hook is still at work.
  const engine = $
  on('agent.spawn', async () => {
    await engine.turn.complete({ turnId: 'turn-1', answer: '', reason: 'error', durationMs: 72, isAborted: false, agentId: 'worker-1' })
    return { model: 'gpt-6.1-sol@high', agentId: 'worker-1' }
  })
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: standard]]\nVerify one claim.' })
  await b.clock.settle()
  expect(written.find(a => a.id === 'worker-1')).toMatchObject({ state: 'failed', endedAt: NOW })
  const rows = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
  expect(rows.find(row => row.type === 'outcome')).toMatchObject({ pick: rows.find(row => row.type === 'pick').id, agent: 'worker-1', reason: 'error', ms: 72 })
})

// 2026-10-25: a flat slice(-40) over every record dropped the oldest running worker the moment 41
// ran at once: its card, the band's live count and every later step's tokens and effort vanished.
test('workers all stay listed past forty, counted, and still take their steps during long tools', async ($, on) => {
  const b = boundaries(on)
  http(on)
  judgeStub(on)
  stepStub(on)
  on('tool.call', async () => { await b.clock.sleep(30000); return { result: 'ok' } })
  numberedSpawn(on, 'run-')
  const seen = agentWrites(on)
  await start($)
  for (let i = 1; i <= 41; i++) await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', description: 'Worker ' + i })
  expect(seen.records().map(a => a.id)).toEqual(Array.from({ length: 41 }, (_, i) => 'run-' + (i + 1)))
  expect(seen.records().every(a => a.state === 'running')).toBe(true)
  expect(seen.counts()).toEqual({ live: 41, total: 41 })
  // The oldest keeps its card and its numbers: a step is still added to it.
  await step($, 'claude-opus-5-5', 'high', 'run-1')
  expect(seen.records().find(a => a.id === 'run-1')).toMatchObject({ effort: 'high' })
  expect(seen.records().find(a => a.id === 'run-1')?.usage).toEqual({ input: 100, cached: 40000, cacheWrite: 0, output: 10 })
  // A worker executing a long tool stays running: it must not be the one dropped past forty.
  const input: ToolCallInput = { tool: 'Bash', command: 'npm test', agentId: 'run-2', tool_use_id: 'tool-wait' }
  const waiting = $.tool.call(input)
  await b.clock.settle()
  await b.clock.advance(15000)
  expect(seen.records().find(a => a.id === 'run-2')?.state).toBe('running')
  // A forty-second worker joins them; long-running tools still count as live.
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', description: 'Worker 42' })
  expect(seen.records()).toHaveLength(42)
  expect(seen.records().some(a => a.id === 'run-2' && a.state === 'running')).toBe(true)
  expect(seen.counts()).toEqual({ live: 42, total: 42 })
  await b.clock.advance(15000)
  await waiting
  // The band and the pane both count them from that list.
  const bandUi = await band($)
  expect(String((await bandUi.find({ key: 'agents' }))?.props.label)).toContain('42')
  await bandUi.unmount()
  const pane = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface: 'terminal', props: { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  expect(await pane.find({ type: 'Text', text: /42 running/ })).toBeDefined()
})

test('only finished workers are capped, at the newest forty; running ones and the order stay', async ($, on) => {
  const b = boundaries(on)
  http(on)
  judgeStub(on)
  numberedSpawn(on, 'task-')
  const seen = agentWrites(on)
  await start($)
  for (let i = 1; i <= 45; i++) await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', description: 'Task ' + i })
  for (let i = 1; i <= 45; i++) { await b.clock.advance(1000); await complete($, 'task-' + i) }
  expect(seen.records().map(a => a.id)).toEqual(Array.from({ length: 40 }, (_, i) => 'task-' + (i + 6)))
  expect(seen.records().every(a => a.state === 'done')).toBe(true)
  // Two workers run beside them: the finished cap never touches a running record.
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', description: 'Live one' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', description: 'Live two' })
  expect(seen.records().map(a => a.id)).toEqual([...Array.from({ length: 40 }, (_, i) => 'task-' + (i + 6)), 'task-46', 'task-47'])
  // One ending adds to the finished side and drops the oldest finished record, not a live one.
  await b.clock.advance(1000)
  await complete($, 'task-46')
  expect(seen.records()).toHaveLength(41)
  expect(seen.records().filter(a => a.state === 'done').map(a => a.id)).toEqual(Array.from({ length: 40 }, (_, i) => 'task-' + (i + 7)))
  expect(seen.records().some(a => a.id === 'task-47' && a.state === 'running')).toBe(true)
  expect(seen.counts()).toEqual({ live: 1, total: 41 })
})

test('a worker spawned again under the same id is one record, updated in place', async ($, on) => {
  boundaries(on)
  http(on)
  judgeStub(on)
  let n = 0
  on('agent.spawn', ($, e) => { n += 1; return { model: e.model ?? 'sonnet', agentId: n === 2 ? 'worker-2' : 'worker-1' } })
  const seen = agentWrites(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', description: 'First run' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', description: 'Second worker' })
  await complete($, 'worker-1')
  expect(seen.records().find(a => a.id === 'worker-1')?.state).toBe('done')
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', description: 'Runs again' })
  expect(seen.records().map(a => a.id)).toEqual(['worker-2', 'worker-1'])
  expect(seen.records().find(a => a.id === 'worker-1')).toMatchObject({ description: 'Runs again', state: 'running' })
  expect(seen.records().find(a => a.id === 'worker-1')?.endedAt).toBeUndefined()
})

test('a background command and a watch are listed from their calls and ended by notice, stop and Stop', async ($, on) => {
  const b = boundaries(on)
  http(on)
  let written: BgTask[] = []
  on('state.set', { plugin: 'ripple', key: 'bgTasks' }, async ($, e, next) => {
    const result = await next(e)
    written = e.value as BgTask[]
    return result
  })
  // The tools' own results as core answers them (claude-code-tools BuiltinToolResults).
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: e.command.includes('dev') ? 'b-dev' : 'b-test' } }
    if (e.tool === 'Monitor') return { result: { taskId: 'm-log', timeoutMs: 300000 } }
    if (e.tool === 'TaskStop') return { result: { message: 'stopped', task_id: e.task_id!, task_type: 'local_bash' } }
    return { result: {} }
  })
  on('classic.Stop', () => ({}))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true })
  await $.tool.call({ tool: 'Monitor', command: 'tail -f app.log', description: 'Watch the app log', timeout_ms: 300000 })
  expect(written.map(task => [task.id, task.kind, task.title, task.state])).toEqual([
    ['b-dev', 'shell', 'Start the dev server', 'running'], ['b-test', 'shell', 'npm test', 'running'], ['m-log', 'monitor', 'Watch the app log', 'running'],
  ])
  // A watch's event carries no status and ends nothing; the command's notice says it failed, and how.
  await $.prompt.submit({ text: '<task-notification>\n<task-id>m-log</task-id>\n<event>ready</event>\n</task-notification>', origin: { kind: 'task-notification' }, wait: false })
  await $.prompt.submit({ text: '<task-notification>\n<task-id>b-test</task-id>\n<status>failed</status>\n<summary>Background command "npm test" failed with exit code 1</summary>\n</task-notification>', origin: { kind: 'task-notification' }, wait: false })
  expect(written.find(task => task.id === 'm-log')?.state).toBe('running')
  expect(written.find(task => task.id === 'b-test')).toMatchObject({ state: 'failed', endedAt: NOW, summary: 'Background command "npm test" failed with exit code 1' })
  await $.tool.call({ tool: 'TaskStop', task_id: 'b-dev' })
  expect(written.find(task => task.id === 'b-dev')?.state).toBe('stopped')
  // The watch ended unannounced: a Stop that no longer holds it in flight settles it.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  expect(written.find(task => task.id === 'm-log')).toMatchObject({ state: 'done', settled: true })
  await b.clock.settle()
})

// The tier marker's optional domain word names the ladder; words outside the four keep general.
const DOMAIN_RULES = {
  ui: { mode: 'ladder' as const, rungs: { light: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' as const }], hard: [{ target: { agent: 'gpt-6-1-sol' }, effort: 'high' as const }] } },
  backend: { mode: 'ladder' as const, rungs: { light: [{ target: { agent: 'deepseek-v4-1-flash' }, effort: 'high' as const }], plan: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' as const }] } },
}
for (const [word, domain, rule, agent, model] of [
  [null, 'general', 'general', 'deepseek-v4-1-flash', 'deepseek-v4.1-flash@max'],
  ['ui', 'frontend', 'ui', 'gpt-6-astra', 'gpt-6-astra@high'],
  ['frontend', 'frontend', 'ui', 'gpt-6-astra', 'gpt-6-astra@high'],
  ['design', 'design', 'ui', 'gpt-6-astra', 'gpt-6-astra@high'],
  ['backend', 'backend', 'backend', 'deepseek-v4-1-flash', 'deepseek-v4.1-flash@high'],
  ['server', 'backend', 'backend', 'deepseek-v4-1-flash', 'deepseek-v4.1-flash@high'],
  ['docs', 'general', 'general', 'deepseek-v4-1-flash', 'deepseek-v4.1-flash@max'],
] as const) test(`a [[ripple: light${word ? ' ' + word : ''}]] marker runs the ${rule} ladder's light rung`, async ($, on) => {
  const b = boundaries(on, { domainRules: DOMAIN_RULES })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: light${word ? ' ' + word : ''}]]\n${SPAWN.prompt}` })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: agent, model, prompt: SPAWN.prompt })
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)
  expect(row).toMatchObject({ rule, domain, level: 'light', rung: 'light', tier: 'light', by: 'session' })
  expect(row.raised).toBeUndefined()
})

test('a quoted reason ignores case and spacing, and a quote under three letters is refused', async ($, on) => {
  const b = boundaries(on, {}, { messages: [{ role: 'user', text: 'Please Use   SOL for the review, and use Astra too.', toolUses: [] }] })
  http(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-1-sol@high]]\nModel reason: user "use sol for"\nReview.' })
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@high' })
  // "so" is inside the user's words but too short to stand for a model choice.
  const short = await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-astra@high]]\nModel reason: user "so"\nReview.' })
  expect(short.deny).toContain("not in the user's recent messages")
  expect(sent.length).toBe(1)
  expect(b.logs.filter(log => log.startsWith('ClaudeRipple worker pick: ')).length).toBe(1)
})

test('a mode without domain rules uses its general ladder, and a reasoned model still runs over it', async ($, on) => {
  const b = boundaries(on, { domainRules: { ui: DEFAULTS.rules.general }, modes: [{ id: 'plain', name: 'Plain', rungs: DEFAULTS.rules.general.rungs, delegation: 'normal', until: 'none' }], activeMode: 'plain' }, { messages: NAMED })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: light ui]]\nWork.' })
  await b.clock.settle()
  const rows = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
  // The mode brings no domain rules of its own: the ui word cannot borrow Base's.
  expect(rows.find(row => row.type === 'pick')).toMatchObject({ domain: 'frontend', rule: 'general', mode: 'Plain', tier: 'light', by: 'session' })
  expect(sent[0]).toMatchObject({ subagentType: 'deepseek-v4-1-flash', model: 'deepseek-v4.1-flash@max', prompt: 'Work.' })
  // Back on Base, a model a written rule assigns runs over the ladder, not instead of a refusal.
  b.remote({ settings: normalizeSettings({ setupDone: true, domainRules: { ui: DEFAULTS.rules.general } }), revision: 2, stored: true })
  await b.clock.advance(3000)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-astra@max]]\nModel reason: rule rules/workers.md — UI copy runs on Astra\nWork.' })
  expect(judges.length).toBe(0)
  expect(sent[1]).toMatchObject({ subagentType: 'gpt-6-astra', model: 'gpt-6-astra@max' })
  const after = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
  expect(after.at(-1)).toMatchObject({ by: 'rule', source: 'rule', namedModel: 'gpt-6-astra' })
})

test('the limits row shows Claude\'s plan on a chat that runs on another provider', async ($, on) => {
  const b = boundaries(on, { extras: ['limits'] })
  b.setModel('muse-spark-1.3-contributor')
  // The unified `/api/limits` body: Claude's plan regardless of the chat's routed provider.
  const limits = { providers: [{ provider: 'claude', type: 'anthropic', title: 'Claude', accounts: [{ account: 0, at: NOW, windows: [
    { kind: 'five_hour', used_percent: 1, window_minutes: 300, reset_at: (NOW + 3_600_000) / 1000 },
    { kind: 'seven_day', used_percent: 88, window_minutes: 10080, reset_at: (NOW + 7_200_000) / 1000 },
    { kind: 'scoped', label: 'Fable', used_percent: 2, window_minutes: 10080 },
  ] }] }] }
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(e.url.endsWith('/api/limits') ? limits : { requests: [] }) } }
  })
  await start($)
  await b.clock.advance(15000)
  const ui = await band($, 'desktop')
  for (const text of [/^Claude$/, /^88%$/, /^Fable$/]) expect(await ui.find({ type: 'Text', text }), String(text)).toBeDefined()
  await ui.unmount()
})

test('a failed first limits read is tried again at the next tick, not a minute later', async ($, on) => {
  const b = boundaries(on, { extras: ['limits'] })
  const limits = { providers: [{ provider: 'claude', type: 'anthropic', title: 'Claude', accounts: [{ account: 0, at: NOW, windows: [
    { kind: 'seven_day', used_percent: 88, window_minutes: 10080, reset_at: (NOW + 7_200_000) / 1000 },
  ] }] }] }
  let reads = 0
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    if (e.url.endsWith('/api/limits') && ++reads === 1) return { value: { ok: false, status: 503, headers: {}, text: '' } }
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(e.url.endsWith('/api/limits') ? limits : { requests: [] }) } }
  })
  await start($)
  await b.clock.advance(15000)
  expect(reads).toBeGreaterThan(1)
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^88%$/ })).toBeDefined()
  await ui.unmount()
})

// 2026-10-25: the owner moved the reset times off the band into a pane the limits row opens. The
// row is a button (pressed again it closes), and the pane says each window's share and reset.
test('the limits row opens the limits pane, which says when each window resets', async ($, on) => {
  const b = boundaries(on, { extras: ['limits'] })
  const limits = { providers: [{ provider: 'claude', type: 'anthropic', title: 'Claude', accounts: [{ account: 0, at: NOW, windows: [
    { kind: 'five_hour', used_percent: 28, window_minutes: 300, reset_at: (NOW + 2 * 3_600_000) / 1000 },
    { kind: 'seven_day', used_percent: 8, window_minutes: 10080, reset_at: (NOW + 7 * 86_400_000) / 1000 },
  ] }] }] }
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(e.url.endsWith('/api/limits') ? limits : { requests: [] }) } }
  })
  await start($)
  await b.clock.advance(15000)
  const ui = await band($, 'desktop')
  await ui.press({ key: 'limits-open' })
  expect(b.panes.has('ripple-limits')).toBe(true)
  const pane = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-limits', surface: 'terminal', props: { title: 'Limits', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  expect(await pane.find({ type: 'Text', text: 'Claude' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^(28%|8%)$/ })).toBeDefined()
  // Each reset reads as its local date and time to the minute, and the time left beside it (2026-10-29).
  const said = (await pane.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  expect(/2h left|2시간 남음/.test(said), 'the near reset').toBe(true)
  expect(/7d left|7일 남음/.test(said), 'the far reset').toBe(true)
  expect(/Resets \w{3}, \w{3} \d{1,2}, \d{1,2}:\d\d [AP]M|\d{1,2}월 \d{1,2}일 \([월화수목금토일]\) 오[전후] \d{1,2}:\d\d 초기화/.test(said), 'the moment').toBe(true)
  await pane.unmount()
  await ui.press({ key: 'limits-open' })
  expect(b.panes.has('ripple-limits')).toBe(false)
  await ui.unmount()
})

for (const subagentType of ['Explore', 'Plan', 'statusline-setup', 'claude-code-guide']) test(`${subagentType} stays native in all mode, including its prompt and model`, async ($, on) => {
  boundaries(on, { agentAuto: 'all' })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const prompt = '[[ripple: hard]]\nFind the router entry point.'
  await $.agent.spawn({ ...SPAWN, subagentType, model: 'opus', prompt })
  expect(judges.length).toBe(0)
  expect(sent[0]).toEqual({ ...SPAWN, subagentType, prompt, model: 'opus' })
})

test('a tier marker uses the default general ladder when general is inherit', async ($, on) => {
  boundaries(on, { rules: normalizeSettings({ rules: { general: { mode: 'inherit' } } }).rules })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: standard]]\n${SPAWN.prompt}` })
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@medium' })
  expect(judges.length).toBe(0)
})

test('a tier marker uses the configured general ladder, then one rung up on a missing worker', async ($, on) => {
  const rules = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    light: { target: { agent: 'missing-worker' }, effort: 'low' },
    standard: { target: { agent: 'gpt-6-astra' }, effort: 'xhigh' },
  } } } }).rules
  const b = boundaries(on, { rules })
  http(on)
  judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: light]]\n${SPAWN.prompt}` })
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-astra', model: 'gpt-6-astra@xhigh' })
  expect(b.toasts.some(text => text.includes('missing-worker'))).toBe(true)
  expect(JSON.parse(b.logs[0]!.slice('ClaudeRipple worker pick: '.length))).toMatchObject({ level: 'light', rung: 'standard', by: 'session' })
  const persisted = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)
  expect(persisted).toMatchObject({ level: 'light', rung: 'standard', model: 'gpt-6-astra@xhigh', effort: 'xhigh', by: 'session', tier: 'light' })
  expect(persisted.skipped.length).toBeGreaterThan(0)
  expect(persisted.fallbackReason).toContain('missing-worker')
})

test('exhaustion leaves nothing: a spawn is refused after one rung up, and plan never moves down', async ($, on) => {
  const rules = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    standard: { target: { agent: 'gpt-6-1-sol' }, effort: 'medium' },
    hard: { target: { agent: 'gpt-6-astra' }, effort: 'high' },
    plan: { target: { agent: 'missing-max' }, effort: 'xhigh' },
  } } } }).rules
  const b = boundaries(on, { rules })
  http(on, true)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const standard = await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: standard]]\n${SPAWN.prompt}` })
  expect(standard.deny).toContain('No worker on this tier can run now')
  expect(standard.deny).toContain('ChatGPT')
  // Plan has nothing above it: a missing worker there is never saved by a lower rung.
  const plan = await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: max]]\n${SPAWN.prompt}` })
  expect(plan.deny).toContain('No worker on this tier can run now')
  expect(plan.deny).toContain('missing-max')
  expect(b.toasts.some(text => text.includes('ChatGPT'))).toBe(true)
  expect(b.toasts.some(text => text.includes('missing-max'))).toBe(true)
  expect(sent.length).toBe(0)
  expect(judges.length).toBe(0)
})

for (const agentAuto of ['off', 'auto', 'all'] as const) test('only ripple:auto is registered, and takeover respects agentAuto ' + agentAuto, async ($, on) => {
  const { registered } = boundaries(on, { agentAuto })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  expect([...new Set(registered.map(e => e.name))]).toEqual(agentAuto === 'off' ? [] : ['auto'])
  for (const entry of registered) {
    expect(entry.description).toContain('[[ripple: light]]')
    expect(entry.description).toContain('Model reason:')
    expect(entry.disallowedTools).toEqual(['Agent'])
  }
  await $.agent.spawn(SPAWN)
  expect(sent[0]?.subagentType).toBe(agentAuto === 'off' ? 'ripple:auto' : 'gpt-6-1-sol')
  // A tier agent from a session started before 2026-10-12 is no longer taken over.
  await $.agent.spawn({ ...SPAWN, subagentType: 'ripple:max' })
  expect(sent[1]?.subagentType).toBe('ripple:max')
  await $.agent.spawn({ ...SPAWN, fork: true })
  expect(sent[2]?.subagentType).toBe('ripple:auto')
  expect(judges.length).toBe(0)
})

test('a rung\'s stored backup is dropped on load: ChatGPT exhaustion moves up, then nothing runs', async ($, on) => {
  const rules = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    standard: { target: { agent: 'gpt-6-1-sol' }, effort: 'high', backup: { agent: 'general-purpose', model: 'opus' } },
    hard: { target: { agent: 'gpt-6-astra' }, effort: 'xhigh' },
  } } } }).rules
  const b = boundaries(on, { rules })
  http(on, true)
  judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const result = await $.agent.spawn(SPAWN)
  // Both ChatGPT rungs are spent and the stored backup on General was dropped on load.
  expect(result.deny).toContain('No worker on this tier can run now')
  expect(sent.length).toBe(0)
  expect(b.toasts.some(t => t.includes('ChatGPT'))).toBe(true)
})

test('without a backup, ChatGPT exhaustion moves one rung up, then refuses the spawn', async ($, on) => {
  const b = boundaries(on)
  http(on, true)
  judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const result = await $.agent.spawn(SPAWN)
  // Standard is Sol and Hard is Astra, both ChatGPT: nothing is left to run.
  expect(result.deny).toContain('No worker on this tier can run now')
  expect(sent.length).toBe(0)
  expect(b.toasts.some(t => t.includes('ChatGPT'))).toBe(true)
})

test('each spawn refreshes provider health before picking and toasts the exhaustion reason', async ($, on) => {
  const rules = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    standard: [{ target: { agent: 'deepseek-v4-1-flash' }, effort: 'max' }],
    hard: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }],
  } } } }).rules
  const b = boundaries(on, { language: 'ko', rules })
  let exhausted = false
  let reads = 0
  on('http.fetch', { url: /\/api\/mod-options$/ }, () => {
    reads++
    const providers = MOD_OPTIONS.providers.map(p => p.name === 'deepseek' ? { ...p, usable: !exhausted, ...(exhausted ? { reason: 'insufficient_balance', exhaustedUntil: NOW + 1_800_000 } : {}) } : p)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ ...MOD_OPTIONS, providers }) } }
  })
  http(on)
  judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  expect(sent[0]?.subagentType).toBe('deepseek-v4-1-flash')
  const before = reads
  exhausted = true
  await $.agent.spawn(SPAWN)
  expect(reads).toBeGreaterThan(before)
  expect(sent[1]?.subagentType).toBe('gpt-6-astra')
  expect(b.toasts.some(text => text.includes('deepseek: 잔액 부족'))).toBe(true)
  exhausted = false
  await $.agent.spawn(SPAWN)
  expect(sent[2]?.subagentType).toBe('deepseek-v4-1-flash')
})

test('auto mode preserves the legacy generated-worker fix outside takeover', async ($, on) => {
  const b = boundaries(on, { agentAuto: 'auto' }, { messages: NAMED })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'deepseek-v4-1-flash', model: 'sonnet', prompt: 'Context\n[[ripple: deepseek-v4-1-flash@max]]\nDo the work.' })
  expect(judges.length).toBe(0)
  expect(sent[0]?.model).toBe('deepseek-v4.1-flash@max')
  expect(sent[0]?.prompt).not.toContain('[[ripple:')
  expect(b.toasts.some(t => t.includes('own model') && t.includes('sonnet'))).toBe(true)
})

test('a session pin survives later prompts, authorizes only its model, and releases without persistence', async ($, on) => {
  const b = boundaries(on, { effortAuto: false })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await submit($, '이거 솔 시켜')
  let ui = await band($)
  expect(await ui.find({ key: 'delegation-pin' })).toBeUndefined()
  await ui.unmount()
  await submit($, '앞으로 솔로 해')
  await submit($, '다음 작업 구현해')
  await submit($, '테스트도 확인해')
  ui = await band($)
  expect(await ui.find({ type: 'Text', text: /Pinned: .*sol/i })).toBeDefined()
  // The band keeps the person's own sentence that pinned it, beside the pin.
  expect(await ui.find({ type: 'Text', text: /“앞으로 솔로 해” pinned it/ })).toBeDefined()
  await $.agent.spawn({ ...SPAWN, prompt: 'Review.' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'gpt-6-1-sol', prompt: 'Review again.' })
  expect(sent.slice(0, 2).map(spawn => spawn.subagentType)).toEqual(['gpt-6-1-sol', 'gpt-6-1-sol'])
  expect(judges.length).toBe(0)
  // A pin outranks a written rule: the session cannot move the person's standing choice.
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-astra]]\nModel reason: rule rules/workers.md — Astra for reviews\nOther model.' })
  expect(sent[2]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@high' })
  // The person's own words for this task outrank their pin.
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-astra@high]]\nModel reason: user "테스트도 확인해"\nCheck the tests.' })
  expect(sent[3]).toMatchObject({ subagentType: 'gpt-6-astra', model: 'gpt-6-astra@high' })
  // A model named with no reason at all is still refused, pin or not.
  const unreasoned = await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-astra]]\nOther model.' })
  expect(unreasoned.deny).toContain('No reason was given for the model gpt-6-astra')
  const picks = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
  expect(picks[0]).toMatchObject({ by: 'user', namedModel: 'gpt-6.1-sol', source: 'pin' })
  expect(picks[0]).not.toHaveProperty('reason')
  expect(picks[0]).not.toHaveProperty('judge')
  expect(judges.length).toBe(0)
  await ui.press({ key: 'release-pin' })
  expect(await ui.find({ key: 'delegation-pin' })).toBeUndefined()
  await submit($, '다음 작업')
  expect(await ui.find({ key: 'delegation-pin' })).toBeUndefined()
  await submit($, '이제부터 딥시크로 고정')
  expect(await ui.find({ type: 'Text', text: /Pinned: deepseek-v4[.-]1-flash/ })).toBeDefined()
  await submit($, '고정 풀어')
  expect(await ui.find({ key: 'delegation-pin' })).toBeUndefined()
  expect(b.toasts.filter(text => text === 'Delegation unpinned.').length).toBe(2)
  expect(b.storeWrites).not.toContain('delegationPin')
  expect(b.settingsRequests.filter(request => request.method === 'PUT').length).toBe(0)
  await ui.unmount()
})

test('meta and notice prompts cannot pin, and session end clears a real pin', async ($, on) => {
  boundaries(on, { effortAuto: false })
  http(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)
  const unshown: { text: string; isMeta?: true }[] = [
    { text: '앞으로 솔로 해', isMeta: true },
    { text: '<task-notification>앞으로 솔로 해</task-notification>' },
    { text: '<system-reminder>앞으로 솔로 해</system-reminder>구현해' },
  ]
  for (const input of unshown) await $.prompt.submit({ ...input, origin: { kind: 'composer' }, wait: false })
  const ui = await band($)
  expect(await ui.find({ key: 'delegation-pin' })).toBeUndefined()
  await submit($, '앞으로 솔로 해')
  expect(await ui.find({ key: 'delegation-pin' })).toBeDefined()
  await $.session.end({ reason: 'clear', sessionId: 'session-test', resume: { id: 'session-test' } })
  expect(await ui.find({ key: 'delegation-pin' })).toBeUndefined()
  await ui.unmount()
})

test('the worker reads neither the routing marker nor the Model reason line, wherever they sit', async ($, on) => {
  const b = boundaries(on, {}, { messages: NAMED })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-1-sol@xhigh]]\nModel reason: rule rules/workers.md — Sol reviews\nReview this. [[ripple: hard]]' })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@xhigh', prompt: 'Review this. ' })
  expect(JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim()).by).toBe('rule')
})

// A model marker names a worker file, a model id, or one of Claude's own aliases.
for (const [model, target] of [
  ['gpt-6-1-sol', { subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@xhigh' }],
  ['opus', { subagentType: 'ripple:auto', model: 'claude-opus-5-5' }],
  ['sonnet', { subagentType: 'ripple:auto', model: 'claude-sonnet-5-5' }],
  ['haiku', { subagentType: 'ripple:auto', model: 'claude-haiku-5-5' }],
  ['claude-opus-5-5', { subagentType: 'ripple:auto', model: 'claude-opus-5-5' }],
  ['claude-sonnet-5-5', { subagentType: 'ripple:auto', model: 'claude-sonnet-5-5@xhigh' }],
] as const) test(`a user-reasoned [[ripple: ${model}@xhigh]] runs that model at xhigh, by user`, async ($, on) => {
  const b = boundaries(on, {}, { messages: [{ role: 'user', text: '솔한테 시켜', toolUses: [] }] })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  const steps = stepStub(on)
  let records: AgentRec[] = []
  on('state.set', { plugin: 'ripple', key: 'agents' }, async ($, e, next) => { records = e.value as AgentRec[]; return next(e) })
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: ${model}@xhigh]]\nModel reason: user "솔한테 시켜"\nReview this.` })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject(target)
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim())
  expect(row).toMatchObject({ by: 'user', namedModel: model, source: 'user', effort: 'xhigh' })
  expect(row).not.toHaveProperty('judge')
  // Claude's own agent gets its effort on turn.step; a routed worker's is in the model suffix.
  if (target.subagentType === 'ripple:auto') {
    // Resolve the exact definition selected by the outgoing spawn, not just the requested model.
    const definition = b.registered.find(spec => 'ripple:' + spec.name === sent[0]?.subagentType)
    expect(definition).toBeDefined()
    expect(definition?.disallowedTools).toContain('Agent')
    await step($, 'claude-opus-5-5', 'low', 'worker-1')
    expect(steps[0]?.effort).toBe('xhigh')
    const rec = records.find(a => a.id === 'worker-1')
    expect(rec?.type).toBe('ripple:auto')
    expect(rec?.provider).toBe('anthropic')
    expect(rec?.effort).toBe('xhigh')
  }
})

test('a user reason is checked against the last ten human messages and the last two prompts', async ($, on) => {
  const older = 'an older line'
  const tenth = 'the tenth line says Sol'
  boundaries(on, { effortAuto: false }, { messages: [
    { role: 'user' as const, text: older, toolUses: [] },
    ...Array.from({ length: 10 }, (_, n) => ({ role: 'user' as const, text: n === 0 ? tenth : `line ${n}`, toolUses: [] })),
  ] })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  // Eleven human messages: the oldest is outside the ten the check reads.
  const tooOld = await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: gpt-6-1-sol@high]]\nModel reason: user "${older}"\nReview.` })
  expect(tooOld.deny).toContain("not in the user's recent messages")
  await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: gpt-6-1-sol@high]]\nModel reason: user "${tenth}"\nReview.` })
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol' })
  // A prompt sent this turn is heard too, even before it reaches the session's messages.
  await submit($, 'Use Astra for this review', 'turn-1')
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-astra@high]]\nModel reason: user "use astra for this"\nReview.' })
  expect(sent[1]).toMatchObject({ subagentType: 'gpt-6-astra' })
  expect(judges.length).toBe(0)
  expect(sent.length).toBe(2)
})

for (const [label, spawn, expected] of [
  ['a worker agent called directly', { subagentType: 'gpt-6-1-sol', prompt: '[[ripple: hard]]\nFix the race.' }, { subagentType: 'gpt-6-1-sol' }],
  ['general-purpose given a model', { subagentType: 'general-purpose', model: 'sonnet', prompt: '[[ripple: hard]]\nFix the race.' }, { subagentType: 'general-purpose', model: 'claude-sonnet-5-5' }],
] as const) test(`${label} runs as the main chat picked it`, async ($, on) => {
  boundaries(on, { agentAuto: 'auto' })
  http(on)
  judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, ...spawn })
  expect(sent[0]).toMatchObject(expected)
  expect(sent[0]?.subagentType).not.toBe('gpt-6-astra')
})

test("a Workflow's ripple:auto whose marker names a worker runs on that worker's model; a tier marker or none is left alone", async ($, on) => {
  // 2026-10-23: 31 Workflow workers sent as ripple:auto with [[ripple: gpt-6-1-sol@medium]] ran on Sol
  // through the router but showed as Opus 5.5, and their later turns lost the marker.
  boundaries(on, {}, { messages: MESSAGES })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  // A workflow agent's spawn carries the run it belongs to (AgentSpawnInput.workflow).
  const WORKFLOW: AgentSpawnInput = { ...SPAWN, workflow: { runId: 'workflow-test', agentIndex: 0 } }
  await $.agent.spawn({ ...WORKFLOW, prompt: "[[ripple: gpt-6-1-sol@medium]]\nWrite the review." })
  // The engine keeps a workflow agent's type and description; its model is what can change.
  expect(sent[0]).toMatchObject({ subagentType: "ripple:auto", prompt: "Write the review.", model: "gpt-6.1-sol@medium", description: "Rename variable" })
  await $.agent.spawn({ ...WORKFLOW, prompt: "[[ripple: hard]]\nWrite the review." })
  expect(sent[1]?.model).toBeUndefined()
  await $.agent.spawn({ ...WORKFLOW, prompt: "Write the review." })
  expect(sent[2]?.model).toBeUndefined()
  expect(judges.length).toBe(0)
})

test('a model the session proposed in chat is never a reason: a worker called by type needs its own', async ($, on) => {
  const b = boundaries(on, { agentAuto: 'all' }, { messages: [
    { role: 'user', text: '이 문구들 다듬어 줘', toolUses: [] },
    { role: 'assistant', text: '솔에게 교정안을 받겠습니다. 진행할까요?', toolUses: [] },
    { role: 'user', text: 'ㄱㄱ', toolUses: [] },
  ] })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  // The assistant's suggestion and a two-letter go-ahead authorize nothing.
  const named = await $.agent.spawn({ ...SPAWN, subagentType: 'gpt-6-1-sol', prompt: 'Model reason: user "ㄱㄱ"\nPropose fixes.' })
  expect(named.deny).toContain("not in the user's recent messages")
  // The ladder still runs the task when no model is named.
  await $.agent.spawn({ ...SPAWN, prompt: 'Propose fixes.' })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@medium', prompt: 'Propose fixes.' })
  expect(b.logs.filter(text => text.startsWith('ClaudeRipple worker pick: ')).length).toBe(1)
})

test('the default tier uses the standard rung, and a missing worker moves one rung up', async ($, on) => {
  const rules = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    standard: { target: { agent: 'missing-worker' }, effort: 'medium' }, hard: { target: { agent: 'general-purpose', model: 'sonnet' }, effort: 'high' },
  } } } }).rules
  boundaries(on, { rules })
  http(on, true)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  expect(sent[0]).toMatchObject({ subagentType: 'ripple:auto', model: 'claude-sonnet-5-5' })
  expect(judges.length).toBe(0)
  const debug = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'debug' })
  expect(debug.text).toContain('"effort": "high"')
  expect(debug.text).toContain('"rung": "hard"')
  expect(debug.text).toContain('"by": "default"')
})

test('a written rule assigns the model like a user ask, needing no quote', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-astra@high]]\nModel reason: rule memory/translation.md — 번역 초안은 아스트라\nReview the draft.' })
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-astra', model: 'gpt-6-astra@high', prompt: 'Review the draft.' })
  expect(judges.length).toBe(0)
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)
  expect(row).toMatchObject({ by: 'rule', source: 'rule', namedModel: 'gpt-6-astra', reason: 'memory/translation.md — 번역 초안은 아스트라' })
  expect(row).not.toHaveProperty('judge')
})

test('an empty or shapeless rule reason is refused; a file and a rule run', async ($, on) => {
  boundaries(on)
  http(on)
  const sent = spawnStub(on)
  await start($)
  for (const rule of ['', 'CLAUDE.md', 'rules/workers.md —', 'translate first']) {
    const refused = await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: gpt-6-astra@high]]\nModel reason: rule ${rule}\nReview.` })
    expect(refused.deny).toContain('No reason was given for the model gpt-6-astra')
  }
  expect(sent.length).toBe(0)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-astra@high]]\nModel reason: rule CLAUDE.md — always use Astra\nReview.' })
  expect(sent.length).toBe(1)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-astra', model: 'gpt-6-astra@high', prompt: 'Review.' })
})

test('a managed spawn is refused when its worker policy cannot be read; an engine spawn still runs once', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const sent = spawnStub(on)
  b.files.set('/home/test/.clauderipple/generated-agents.json', '{ not json')
  await start($)
  const managed = await $.agent.spawn(SPAWN)
  expect(managed.deny).toContain('ClaudeRipple:')
  expect(sent.length).toBe(0)
  expect(b.logs.some(log => log.includes('agent.spawn prepare'))).toBe(true)
  // A native agent is the engine's: the same broken catalogue does not stop it, and its own
  // post-execution record failing must not run it a second time.
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' })
  expect(sent.length).toBe(1)
  expect(sent[0]?.subagentType).toBe('Explore')
})

test('the logged reason keeps only its first 200 characters', async ($, on) => {
  const b = boundaries(on)
  http(on)
  spawnStub(on)
  await start($)
  const rule = 'rules/workers.md — ' + 'x'.repeat(300)
  await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: opus@max]]\nModel reason: rule ${rule}\nInvestigate.` })
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)
  expect(row.reason).toBe(rule.slice(0, 200))
  expect(row.reason).toHaveLength(200)
})

test('a named model that cannot run now falls to the ladder and says why', async ($, on) => {
  const b = boundaries(on, { language: 'ko' }, { messages: NAMED })
  let deepseek = true
  on('http.fetch', { url: /\/api\/mod-options$/ }, () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ ...MOD_OPTIONS, providers: MOD_OPTIONS.providers.map(p => p.name === 'deepseek' ? { ...p, usable: deepseek, ...(!deepseek ? { reason: 'insufficient_balance', exhaustedUntil: NOW + 1_800_000 } : {}) } : p) }) } }))
  http(on)
  deepseek = false
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: deepseek-v4-1-flash@max]]\nModel reason: user "Use Sol, Astra"\nReview.' })
  // The named worker is spent: the ladder's standard rung runs, and the toast names the spent model.
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@medium' })
  expect(b.toasts.some(text => text.includes('deepseek-v4.1-flash') && text.includes('지금 실행할 수 없습니다'))).toBe(true)
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)
  // The ladder chose what ran; the model asked for and its source stay beside the reason.
  expect(row).toMatchObject({ by: 'default', namedModel: 'deepseek-v4-1-flash', source: 'user' })
  expect(row.fallbackReason).toContain('지금 실행할 수 없습니다')
})

test('a Model reason line never reaches a worker the mod does not route', async ($, on) => {
  boundaries(on, { agentAuto: 'auto' })
  http(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'gpt-6-1-sol', prompt: '[[ripple: gpt-6-1-sol@high]]\nModel reason: rule memory/x.md — review is Sol\nReview.' })
  expect(sent[0]?.prompt).not.toContain('Model reason')
  expect(sent[0]?.prompt).toContain('Review.')
})

test('Zen Jev uses the exact config authorization and first Jev model with CLAUDERIPPLE_HOME', async ($, on) => {
  const paths: string[] = []
  const config = { ...CONFIG, providers: { ...CONFIG.providers, 'opencode-zen': { headers: { authorization: 'Bearer zen-config-key' }, models: [{ id: 'other' }, { id: 'jev-1.13' }, { id: 'jev-latest' }] } } }
  boundaries(on, { judge: 'jev', jevSource: 'zen' }, { env: { CLAUDERIPPLE_HOME: '/custom/ripple' }, config, paths })
  const sent: { url: string; body?: string; headers?: Readonly<Record<string, string>> }[] = []
  http(on, false, config, e => sent.push({ url: e.url, body: e.init?.body, headers: e.init?.headers }))
  const haiku = judgeStub(on)
  await start($)
  await submit($)
  expect(sent.length).toBe(1)
  expect(sent[0]?.headers?.authorization).toBe('Bearer zen-config-key')
  expect(JSON.parse(sent[0]!.body!)).toMatchObject({ model: 'jev-1.13', questions: { effort: { type: 'choice' } } })
  expect(haiku.length).toBe(0)
  expect(paths).toContain('/custom/ripple/config.json')
  await command($, 'settings')
  const ui = await band($)
  expect(await ui.find({ key: 'jev-key' })).toBeUndefined()
  expect(await ui.find({ key: 'jev-test' })).toBeUndefined()
  expect(await ui.find({ key: 'jev-source-zen' })).toBeUndefined()
  await ui.unmount()
})

test('Zen without a key explains the missing key and falls back to Haiku', async ($, on) => {
  const b = boundaries(on, { judge: 'jev', jevSource: 'zen' })
  const urls = http(on)
  const haiku = judgeStub(on, '{"effort":"medium","why":"fallback"}')
  await start($)
  await submit($)
  expect(haiku.length).toBe(1)
  expect(urls.some(url => url.includes('opencode.ai'))).toBe(false)
  expect(b.toasts.some(text => text.includes('No OpenCode Zen authorization key'))).toBe(true)
})

test('provider off refuses a user-named target; no enabled provider refuses the ladder', async ($, on) => {
  const b = boundaries(on, { agentAuto: 'all', providers: { chatgpt: false, deepseek: false, anthropic: false } }, { messages: NAMED })
  http(on)
  const sent = spawnStub(on)
  await start($)
  // The named model's provider is switched off: refused, even with a sound reason.
  const explicit = await $.agent.spawn({ ...SPAWN, subagentType: 'gpt-6-1-sol', prompt: 'Model reason: user "Use Sol, Astra"\nDo it.' })
  expect(explicit.deny).toContain('switched off')
  const automatic = await $.agent.spawn(SPAWN)
  expect(automatic.deny).toContain('No worker on this tier can run now')
  expect(b.toasts.some(text => text.includes('No worker on this tier can run now'))).toBe(true)
  expect(sent.length).toBe(0)
})

test('a project agent called by type in all mode takes the ladder and needs no reason', async ($, on) => {
  boundaries(on, { agentAuto: 'all' })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'opus-xhigh', model: 'opus', prompt: '[[ripple: hard]]\nInvestigate.' })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-astra', model: 'gpt-6-astra@high', prompt: 'Investigate.' })
})

test('general-purpose without a model in all mode takes the ladder and needs no reason', async ($, on) => {
  boundaries(on, { agentAuto: 'all' })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', prompt: '[[ripple: hard]]\nInvestigate.' })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-astra', model: 'gpt-6-astra@high', prompt: 'Investigate.' })
})

test('general-purpose on a model in all mode names that model: refused unreasoned, run at its @effort with one', async ($, on) => {
  const b = boundaries(on, { agentAuto: 'all' }, { messages: [{ role: 'user', text: 'Use Opus for this review', toolUses: [] }] })
  http(on)
  const sent = spawnStub(on)
  await start($)
  const unreasoned = await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', model: 'opus@xhigh', prompt: '[[ripple: hard]]\nInvestigate.' })
  expect(unreasoned.deny).toContain('No reason was given for the model opus')
  await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', model: 'opus@xhigh', prompt: '[[ripple: hard]]\nModel reason: user "Use Opus for this"\nInvestigate.' })
  expect(sent[0]).toMatchObject({ subagentType: 'general-purpose', model: 'claude-opus-5-5', prompt: 'Investigate.' })
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)
  expect(row).toMatchObject({ by: 'user', namedModel: 'opus', source: 'user', effort: 'xhigh' })
  // A Claude id is a model this machine runs, so a reasoned one passes the name check too; a model
  // with no @effort anywhere runs at high.
  await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', model: 'claude-opus-5-5', prompt: 'Model reason: user "Use Opus for this"\nInvestigate again.' })
  expect(sent[1]).toMatchObject({ subagentType: 'general-purpose', model: 'claude-opus-5-5' })
  const rows = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
  expect(rows.at(-1)).toMatchObject({ namedModel: 'claude-opus-5-5', effort: 'high', by: 'user' })
})

test('a plugin agent stays the engine\'s in all mode: no ladder, no reason needed', async ($, on) => {
  boundaries(on, { agentAuto: 'all' })
  http(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'my-plugin:reviewer', model: 'opus', prompt: 'Do it.' })
  expect(sent[0]).toMatchObject({ subagentType: 'my-plugin:reviewer', model: 'opus', prompt: 'Do it.' })
})

test('a subagent may not start a worker; the main chat still delegates', async ($, on) => {
  boundaries(on)
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const nested = await $.agent.spawn({ ...SPAWN, parentAgentId: 'agent-7' })
  expect(nested.deny).toContain('may not start another subagent')
  const named = await $.agent.spawn({ ...SPAWN, subagentType: 'gpt-6-1-sol', parentAgentId: 'agent-7' })
  expect(named.deny).toContain('may not start another subagent')
  expect(judges.length).toBe(0)
  expect(sent.length).toBe(0)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('worker-1')
})

test('prompt judge rewrites every Opus 5.5 main step, not subagent effort', async ($, on) => {
  boundaries(on)
  http(on)
  const calls = judgeStub(on, '{"effort":"high","sure":0.9,"why":"multi step"}')
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($)
  await step($)
  await step($, 'claude-opus-5-5', 'low', 'untracked')
  expect(calls.length).toBe(1)
  expect(sent.map(s => s.effort)).toEqual(['high', 'high', 'low'])
  const stats = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(stats.text).toContain('Auto: 1 prompts, 2 requests')
})

test('Fable pauses without paying a judge or rewriting effort', async ($, on) => {
  const b = boundaries(on)
  b.setModel('claude-fable-5-1')
  http(on)
  const calls = judgeStub(on)
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($, 'claude-fable-5-1', 'max')
  expect(calls.length).toBe(0)
  expect(sent[0]?.effort).toBe('max')
  const debug = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'debug' })
  expect(debug.text).toContain('"paused": true')
})

test('a later person app-effort change turns Auto off and wins', async ($, on) => {
  const b = boundaries(on)
  http(on)
  judgeStub(on, '{"effort":"high","why":"scope"}')
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($, 'claude-opus-5-5', 'medium')
  await step($, 'claude-opus-5-5', 'low')
  expect(sent.map(s => s.effort)).toEqual(['high', 'low'])
  expect(b.router().settings).toMatchObject({ effortAuto: false })
  expect(b.toasts.some(t => t.includes('turned Auto off'))).toBe(true)
})

test('lower mid-turn pick waits until turn.complete', async ($, on) => {
  boundaries(on)
  http(on)
  let judges = 0
  on('model.complete', () => ({ value: { isAnswered: true, text: JSON.stringify({ effort: ++judges === 1 ? 'high' : 'low', why: 'scope' }), usage: USAGE } }))
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($)
  await submit($, 'This is a simpler separate task now.', 'turn-1')
  await step($)
  await complete($)
  await step($)
  expect(sent.map(s => s.effort)).toEqual(['high', 'high', 'low'])
})

test('short followups retain the pick; host slash commands are not judged', async ($, on) => {
  boundaries(on)
  http(on)
  const judges = judgeStub(on, '{"effort":"high","why":"scope"}')
  stepStub(on)
  await start($)
  await submit($)
  await submit($, 'go')
  await submit($, '/clear')
  expect(judges.length).toBe(1)
  const result = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(result.text).toContain('Auto: 2 prompts')
})

test('keep-warm forks near expiry, refreshes the memo and stops once on a null fork', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  judgeStub(on)
  stepStub(on)
  let forks = 0
  // null is a measured legacy failure; current declarations exclude it, so this boundary stub
  // deliberately returns it through an unchecked value (not a cast in production code).
  on('model.fork', () => ({ value: ++forks === 1 ? { isAnswered: true, text: 'ok', usage: USAGE } : JSON.parse('null') }))
  await start($)
  await step($)
  await complete($)
  await b.clock.advance(3375000)
  expect(forks).toBe(1)
  const first = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'debug' })
  expect(first.text).toContain('"pings": 1')
  await b.clock.advance(3375000)
  expect(forks).toBe(2)
  await b.clock.advance(120000)
  expect(forks).toBe(2)
  expect(b.toasts.filter(t => t.includes('Keep warm stopped')).length).toBe(1)
  const stats = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(stats.text).toContain('Warm: 1 pings')
})

test('a cache-reading ping keeps the card, a real reply and /clear drop it, and the demo draws it', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  judgeStub(on)
  stepStub(on)
  on('model.fork', () => ({ value: { isAnswered: true, text: 'ok', usage: USAGE } }))
  await start($)
  await step($)
  await complete($)
  await b.clock.advance(3375000)
  // The ping read 40000 cache tokens: the card tells it, with the memo's minutes left.
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /held 40k tokens in cache/ })).toBeDefined()
  await ui.unmount()
  // A prompt counts as having seen the card; the next is a real reply, which clears the count.
  await submit($)
  await step($)
  await complete($)
  const after = await band($)
  expect(await after.find({ type: 'Text', text: /held 40k tokens in cache/ })).toBeUndefined()
  await after.unmount()
  await b.clock.advance(3375000)
  await b.clock.settle()
  const again = await band($)
  expect(await again.find({ type: 'Text', text: /held 40k tokens in cache/ })).toBeDefined()
  await again.unmount()
  await $.classic.SessionStart({ source: 'clear' })
  const cleared = await band($)
  expect(await cleared.find({ type: 'Text', text: /held 40k tokens in cache/ })).toBeUndefined()
  await cleared.unmount()
  // The demo shows the card with sample values, whatever the state.
  await command($, 'kept')
  const demo = await band($)
  expect(await demo.find({ type: 'Text', text: /held 312k tokens in cache/ })).toBeDefined()
})

test('fork turn.step is not effort-steered, busy or main-request cost', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  judgeStub(on, '{"effort":"high","why":"scope"}')
  const sent = stepStub(on)
  let forks = 0
  on('model.fork', async () => {
    forks++
    await step($, 'claude-opus-5-5', 'medium')
    return { value: { isAnswered: true, text: 'ok', usage: USAGE } }
  })
  await start($)
  await submit($)
  await step($)
  await complete($)
  await b.clock.advance(3375000)
  expect(forks).toBe(1)
  expect(sent.map(s => s.effort)).toEqual(['high', 'medium'])
  const stats = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(stats.text).toContain('Auto: 1 prompts, 1 requests')
  expect(stats.text).toContain('Warm: 1 pings')
})

test('the flame turns keep-warm off for this chat only; Settings stay as they are', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  judgeStub(on, '{"effort":"high","why":"scope"}')
  stepStub(on)
  let forks = 0
  on('model.fork', async () => { forks++; return { value: { isAnswered: true, text: 'ok', usage: USAGE } } })
  await start($)
  await submit($)
  await step($)
  await complete($)
  await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'warm' })
  await b.clock.advance(3375000)
  expect(forks).toBe(0)
  expect(b.router().settings.keepWarm).toBe(true)
})

test('Haiku compaction returns replacement messages and forwards the keep note', async ($, on) => {
  boundaries(on)
  http(on)
  const calls = judgeStub(on, 'Verified continuation summary. '.repeat(20))
  let engine = 0
  on('session.compact', () => { engine++; return { messages: MESSAGES } })
  await start($)
  const out = await $.session.compact({ trigger: 'manual', messages: MESSAGES, instructions: 'Keep file paths.' })
  expect(calls[0]).toMatchObject({ model: 'claude-haiku-5-5', maxTokens: 16000, timeoutMs: 240000, effort: 'medium' })
  expect(calls[0]?.prompt).toContain('Keep file paths.')
  expect(out.messages?.[0]?.text.includes('Continuation record')).toBe(true)
  expect(engine).toBe(0)
})

test('the compaction model is the chosen one, with an @effort split off for the router', async ($, on) => {
  boundaries(on, { compactModel: 'gpt-6.1-sol@high' })
  http(on)
  const calls = judgeStub(on, 'Verified continuation summary. '.repeat(20))
  on('session.compact', () => ({ messages: MESSAGES }))
  await start($)
  const out = await $.session.compact({ trigger: 'manual', messages: MESSAGES })
  expect(calls[0]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
  expect(out.messages?.[0]?.text.includes('Continuation record')).toBe(true)
})

// 2026-10-25: the band's Compact asks the chat to tidy up first, as a prompt of its own, and only
// the turn that prompt became compacts — never another prompt's end.
const TIDY = t('en', 'alerts.tidyPrompt')

function compacts(on: On) {
  const args: string[] = []
  on('command.run', { command: 'compact' }, ($, e) => { args.push(e.args); return { text: 'Compacted.' } })
  return args
}

/** The band's Compact pressed on the desktop, its note sent with Enter, and the band left mounted. */
async function pressCompact($: Engine, note: string) {
  const ui = await band($, 'desktop')
  await ui.press({ key: 'compact' })
  await ui.input({ key: 'note', text: note })
  return ui
}

test('a Compact press tidies up first, and only its own turn\'s answer compacts', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const notes = compacts(on)
  await start($)
  const ui = await pressCompact($, 'Keep the router decision.')
  expect(b.submitted).toEqual([TIDY])
  expect(notes).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Tidying up…' })).toBeDefined()
  // A prompt queued before it ends first: nothing is compacted and the card still says tidying.
  await $.turn.start({ text: 'the prompt queued before it', turnId: 'turn-2' })
  await $.turn.complete({ turnId: 'turn-2', answer: 'done', reason: 'answer', durationMs: 10, isAborted: false })
  await b.clock.advance(10)
  expect(notes).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Tidying up…' })).toBeDefined()
  // The tidy prompt's own turn, answered, compacts with the note the card carried.
  await $.turn.start({ text: TIDY, turnId: 'turn-3' })
  await $.turn.complete({ turnId: 'turn-3', answer: 'Everything is written down.', reason: 'answer', durationMs: 10, isAborted: false })
  await b.clock.advance(10)
  expect(notes).toEqual(['Keep the router decision.'])
  expect(await ui.find({ type: 'Text', text: 'Compacted' })).toBeDefined()
  await ui.unmount()
})

test('a tidy turn that is stopped compacts nothing and says the chat was left alone', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const notes = compacts(on)
  await start($)
  const ui = await pressCompact($, 'Keep the router decision.')
  await $.turn.start({ text: TIDY, turnId: 'turn-2' })
  await $.turn.complete({ turnId: 'turn-2', answer: '', reason: 'aborted', durationMs: 10, isAborted: true })
  await b.clock.advance(10)
  expect(notes).toEqual([])
  expect(b.toasts.some(text => text.includes('the tidy-up did not finish'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /did not finish, so the chat was not compacted/ })).toBeDefined()
  await ui.unmount()
})

test('the tidy switch is on by default, kept, and off compacts at once', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const notes = compacts(on)
  await start($)
  const ui = await band($, 'desktop')
  await ui.press({ key: 'compact' })
  expect(JSON.stringify(await ui.drawn())).toContain('Tidy up first: On')
  await ui.press({ key: 'tidy' })
  expect(JSON.stringify(await ui.drawn())).toContain('Tidy up first: Off')
  await ui.input({ key: 'note', text: 'Keep the router decision.' })
  expect(b.submitted).toEqual([])
  expect(notes).toEqual(['Keep the router decision.'])
  // The last choice is the next card's too.
  await ui.press({ key: 'dismiss' })
  await ui.press({ key: 'compact' })
  expect(JSON.stringify(await ui.drawn())).toContain('Tidy up first: Off')
  await ui.unmount()
})

test('a Compact pressed again while the tidy turn runs sends one prompt', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const notes = compacts(on)
  await start($)
  const ui = await pressCompact($, 'Keep the router decision.')
  await $.turn.start({ text: TIDY, turnId: 'turn-2' })
  // The card let go, the band is back: a second press waits on the tidy turn already running.
  await ui.press({ key: 'dismiss' })
  await ui.press({ key: 'compact' })
  await ui.input({ key: 'note', text: 'Keep the router decision.' })
  expect(b.submitted).toEqual([TIDY])
  await $.turn.complete({ turnId: 'turn-2', answer: 'Done.', reason: 'answer', durationMs: 10, isAborted: false })
  await b.clock.advance(10)
  expect(notes).toEqual(['Keep the router decision.'])
  await ui.unmount()
})

// 2026-10-25: a tidy prompt that never became a turn (the person dropped it from the queue, the
// engine let it go) used to leave the wait standing, and the Compact button dead until the mod
// reloaded. Pressing again now gives that wait up and sends the prompt again.
test('a Compact pressed again before the tidy prompt becomes a turn sends it again', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const notes = compacts(on)
  await start($)
  const ui = await pressCompact($, 'Keep the router decision.')
  expect(b.submitted).toEqual([TIDY])
  await ui.press({ key: 'dismiss' })
  await ui.press({ key: 'compact' })
  await ui.input({ key: 'note', text: 'Keep the router decision.' })
  expect(b.submitted).toEqual([TIDY, TIDY])
  // The prompt sent again is the one that becomes a turn, and its answer compacts once.
  await $.turn.start({ text: TIDY, turnId: 'turn-2' })
  await $.turn.complete({ turnId: 'turn-2', answer: 'Done.', reason: 'answer', durationMs: 10, isAborted: false })
  await b.clock.advance(10)
  expect(notes).toEqual(['Keep the router decision.'])
  await ui.unmount()
})

test('the band measures context against the compaction window, not the whole model window', async ($, on) => {
  // 40k of a 1M model is 4%; with Claude Code compacting at 400k it is 10%, and that is the share.
  const b = boundaries(on, { extras: ['context'] }, { window: 1_000_000, tokens: 40_000, compactAt: 400_000 })
  http(on)
  await start($)
  await b.clock.advance(15_000)
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: '10%' })).toBeDefined()
  await ui.unmount()
})

test('the band shows the session\'s own compaction window, as the Context pane does, over settings.json', async ($, on) => {
  // settings.json says 500k but the running session compacts at 400k: 200k is 50%, not 40%.
  const b = boundaries(on, { extras: ['context'] }, { window: 1_000_000, tokens: 200_000, compactAt: 500_000, engineWindow: 400_000 })
  http(on)
  await start($)
  await b.clock.advance(15_000)
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: '50%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '40%' })).toBeUndefined()
  await ui.unmount()
})

test('a precise context count does not outlive a model or window switch', async ($, on) => {
  const ctx = movableContext()
  const b = boundaries(on, { extras: ['context'] }, { context: ctx })
  http(on)
  stepStub(on)
  await start($)
  await step($, ctx.model)
  await b.clock.advance(15_000)
  const pane = await contextPane($)
  await pane.press({ key: 'context-refresh' })
  expect(await pane.find({ type: 'Text', text: /Counted by the token-count API/ })).toBeDefined()
  await pane.unmount()
  // The same tokens now sit in an 800k window: 4%, not the old count's 20%.
  ctx.model = 'claude-opus-6-0'
  ctx.window = 800_000
  b.setModel(ctx.model)
  await step($, ctx.model)
  await b.clock.advance(15_000)
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: '4%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '20%' })).toBeUndefined()
  await ui.unmount()
})

test('a precise context count does not outlive a cleared chat', async ($, on) => {
  const ctx = movableContext()
  const b = boundaries(on, { extras: ['context'] }, { context: ctx })
  http(on)
  await start($)
  await b.clock.advance(15_000)
  let pane = await contextPane($)
  await pane.press({ key: 'context-refresh' })
  expect(await pane.find({ type: 'Text', text: /Counted by the token-count API/ })).toBeDefined()
  await pane.unmount()
  // /clear keeps the same tokens and window here, so only the session it counted can say it is old.
  await $.classic.SessionStart({ source: 'clear' })
  await b.clock.advance(15_000)
  pane = await contextPane($)
  expect(await pane.find({ type: 'Text', text: /Local estimate/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Counted by the token-count API/ })).toBeUndefined()
})

test('a precise context count does not outlive a compaction', async ($, on) => {
  const ctx = movableContext()
  const b = boundaries(on, { compactModel: 'session', extras: ['context'] }, { context: ctx })
  http(on)
  on('session.compact', () => ({ messages: MESSAGES }))
  await start($)
  await b.clock.advance(15_000)
  let pane = await contextPane($)
  await pane.press({ key: 'context-refresh' })
  expect(await pane.find({ type: 'Text', text: /Counted by the token-count API/ })).toBeDefined()
  await pane.unmount()
  await $.session.compact({ trigger: 'manual', messages: MESSAGES })
  await b.clock.advance(15_000)
  pane = await contextPane($)
  expect(await pane.find({ type: 'Text', text: /Local estimate/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Counted by the token-count API/ })).toBeUndefined()
})

test('a precise count that answers after a clear, a resume, a model switch or a compaction is discarded', async ($, on) => {
  const ctx = movableContext()
  let hold = false
  let release: (() => void) | null = null
  let rejectFull: ((error: Error) => void) | null = null
  const b = boundaries(on, { compactModel: 'session', extras: ['context'] }, { context: ctx, deferUsage: kind => {
    if (!hold || kind !== 'full') return undefined
    return new Promise<void>((resolve, reject) => { release = resolve; rejectFull = reject })
  } })
  http(on)
  on('session.compact', () => ({ messages: MESSAGES }))
  stepStub(on)
  await start($)
  await step($, ctx.model)
  await b.clock.advance(15_000)
  const pane = await contextPane($)
  const trip = async (change: () => Promise<unknown>, outcome: 'ok' | 'error' = 'ok') => {
    hold = true
    const pressed = pane.press({ key: 'context-refresh' })
    await b.clock.settle()
    expect(release, 'full count started').not.toBeNull()
    hold = false
    await change()
    if (outcome === 'error') rejectFull!(new Error('token count unavailable'))
    else release!()
    release = null
    rejectFull = null
    await pressed
    await b.clock.settle()
    expect(await pane.find({ type: 'Text', text: /Counted by the token-count API/ }), 'old count').toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /Precise count failed/ }), 'old error').toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /Counting/ }), 'stale busy').toBeUndefined()
  }
  await trip(() => $.classic.SessionStart({ source: 'clear' }))
  await trip(() => $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 120, prompt_cache_likely_expired: false, model: 'claude-opus-5-5' }))
  await trip(async () => { ctx.model = 'claude-opus-6-0'; b.setModel(ctx.model); await step($, ctx.model) })
  // A compaction while the count runs, whose answer then fails: neither the count nor its error lands.
  await trip(() => $.session.compact({ trigger: 'manual', messages: MESSAGES }), 'error')
})

test('a summary that answers after a clear is not published', async ($, on) => {
  const ctx = { model: 'claude-opus-5-5', window: 200_000, tokens: 32_000, raw: 160_000 }
  let hold = false
  let release: (() => void) | null = null
  const b = boundaries(on, { extras: ['context'] }, { context: ctx, deferUsage: kind => {
    if (!hold || kind !== 'summary') return undefined
    return new Promise<void>(resolve => { release = resolve })
  } })
  http(on)
  const writes: ({ percent: number } | null)[] = []
  on('state.set', { plugin: 'ripple', key: 'context' }, async ($, e, next) => { const result = await next(e); writes.push(e.value as { percent: number } | null); return result })
  await start($)
  await b.clock.advance(15_000)
  expect(writes.at(-1)?.percent).toBe(20)
  // A different token count asks for a fresh summary: 25% of its 160k window, where the 200k estimate is 20%.
  ctx.tokens = 40_000
  hold = true
  await b.clock.advance(15_000)
  expect(release, 'summary started').not.toBeNull()
  await $.classic.SessionStart({ source: 'clear' })
  hold = false
  release!()
  await b.clock.settle()
  expect(writes.at(-1)?.percent).toBe(20)
})

test('failed Haiku compaction falls back; precompute skips; subagent stays with engine', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const calls = judgeStub(on, 'too short')
  let engine = 0
  on('session.compact', () => { engine++; return { messages: MESSAGES } })
  await start($)
  await $.session.compact({ trigger: 'manual', messages: MESSAGES })
  const skipped = await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'worker' })
  expect(engine).toBe(2)
  expect(calls.length).toBe(1)
  expect('skip' in skipped).toBe(true)
  expect(b.toasts.some(t => t.includes('session compactor'))).toBe(true)
})

test('the Compact icon counts the main chat\'s finished compactions; /clear zeroes it', async ($, on) => {
  boundaries(on, { compactModel: 'session' })
  http(on)
  on('session.compact', () => ({ messages: MESSAGES }))
  await start($)
  const alt = async (ui: Awaited<ReturnType<typeof band>>) => {
    const box = await ui.find({ key: 'pic-compact' })
    return (box?.children[0] as { props?: { alt?: unknown } } | undefined)?.props?.alt
  }
  let ui = await band($, 'desktop')
  expect(await alt(ui)).toBe('Compact')
  await ui.unmount()
  await $.session.compact({ trigger: 'manual', messages: MESSAGES })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  // Neither a subagent's own compaction nor the ahead-of-time precompute is the chat's.
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'worker' })
  await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
  ui = await band($, 'desktop')
  expect(await alt(ui)).toBe('Compact 2')
  await ui.unmount()
  await $.classic.SessionStart({ source: 'clear' })
  ui = await band($, 'desktop')
  expect(await alt(ui)).toBe('Compact')
  await ui.unmount()
})

// ---- Operating modes (docs/specs/2026-10-12-worker-tiers.md "Operating modes") -----------------

const BURN = normalizeModes([{ id: 'burn', name: 'Burn GPT', rungs: { ...DEFAULTS.rules.general.rungs, light: [{ target: { agent: 'gpt-6-1-sol' }, effort: 'low' }] }, delegation: 'eager' }])

test('an eager mode notes every prompt, whether or not it follows a compaction; its tiers route spawns and each pick names it', async ($, on) => {
  const b = boundaries(on, { modes: BURN, activeMode: 'burn', activeSince: NOW, compactModel: 'session' })
  http(on)
  judgeStub(on)
  const sent = spawnStub(on)
  on('session.compact', () => ({ messages: MESSAGES }))
  await start($)
  await submit($)
  await submit($)
  // A slash command is not the user's prompt: no note.
  await submit($, '/model')
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  // A subagent's compaction is not the main chat's.
  await submit($)
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'worker' })
  await submit($)
  const note = 'ClaudeRipple mode Burn GPT: delegate everything except judgment and final review to ripple:auto.'
  expect(b.contexts).toEqual([[note], [note], [], [note], [note]])
  // The mode's light rung runs Sol at low, not the base ladder's DeepSeek.
  await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: light]]\n${SPAWN.prompt}` })
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@low' })
  const pick = b.logs.find(text => text.startsWith('ClaudeRipple worker pick: '))!
  expect(JSON.parse(pick.slice('ClaudeRipple worker pick: '.length))).toMatchObject({ level: 'light', rung: 'light', mode: 'Burn GPT' })
  expect(JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)).toMatchObject({ tier: 'light', by: 'session' })
  // The band names the mode.
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: 'Burn GPT' })).toBeDefined()
})

test('with no mode on, nothing is attached and picks name none', async ($, on) => {
  const b = boundaries(on, { modes: BURN })
  http(on)
  judgeStub(on)
  spawnStub(on)
  await start($)
  await submit($)
  await $.agent.spawn(SPAWN)
  expect(b.contexts).toEqual([[]])
  expect(JSON.parse(b.logs.find(text => text.startsWith('ClaudeRipple worker pick: '))!.slice('ClaudeRipple worker pick: '.length)).mode).toBeUndefined()
})

test('a mode ends at its time and says so once; quick settings turn one on and off', async ($, on) => {
  const modes = normalizeModes([{ id: 'hour', name: 'One minute', targets: ['chatgpt'], until: NOW + 60_000 }, ...BURN])
  const b = boundaries(on, { modes, activeMode: 'hour', activeSince: NOW })
  http(on)
  await start($)
  await b.clock.advance(30_000)
  expect(b.router().settings.activeMode).toBe('hour')
  await b.clock.advance(40_000)
  expect(b.router().settings.activeMode).toBeUndefined()
  expect(b.router().settings.modes).toEqual(modes)
  expect(b.toasts.filter(text => text === 'The One minute mode has ended.').length).toBe(1)
  await b.clock.advance(9000)
  expect(b.toasts.filter(text => text === 'The One minute mode has ended.').length).toBe(1)
  // The quick settings' one mode control (the desktop's Mode tile, a drawn segment each): none,
  // then each mode.
  await command($, 'settings')
  const ui = await band($, 'desktop')
  const drawn = String((await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt).find(alt => String(alt).includes('Burn GPT')))
  for (const label of ['Base', 'One minute', 'Burn GPT']) expect(drawn, label).toContain(label)
  await ui.press({ key: 'mode-burn' })
  expect([b.router().settings.activeMode, b.router().settings.activeSince]).toEqual(['burn', NOW + 79_000])
  await ui.press({ key: 'mode-' })
  expect(Object.hasOwn(b.router().settings, 'activeMode')).toBe(false)
})

test('a mode ends at the first ChatGPT reset after activation', async ($, on) => {
  const modes = normalizeModes([{ id: 'burn', name: 'Burn GPT', rungs: { light: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }] }, until: { reset: 'chatgpt' } }])
  const b = boundaries(on, { modes, activeMode: 'burn', activeSince: NOW })
  const asked: string[] = []
  on('http.fetch', { url: /\/api\/chatgpt-accounts/ }, ($, e) => {
    asked.push(e.url)
    const accounts = [{ state: 'ready', quota: { at: NOW, rate_limits: { primary: { used_percent: 10, window_minutes: 300, reset_at: (NOW + 30_000) / 1000 }, secondary: { used_percent: 60, window_minutes: 10080, reset_at: (NOW + 150_000) / 1000 } } } }]
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ provider: 'chatgpt', accounts }) } }
  })
  http(on)
  await start($)
  await b.clock.advance(20_000)
  expect(b.router().settings.activeMode).toBe('burn')
  await b.clock.advance(20_000)
  expect(b.router().settings.activeMode).toBeUndefined()
  expect(b.toasts).toContain('The Burn GPT mode has ended.')
  // The quota is read at most once a minute, for the provider the target model belongs to.
  expect(asked.length).toBeLessThanOrEqual(4)
  expect(asked.every(url => url.endsWith('/api/chatgpt-accounts?provider=chatgpt'))).toBe(true)
})

for (const binding of ['five_hour', 'seven_day']) test('reset mode follows the band binding Claude limit: ' + binding, async ($, on) => {
  // A ChatGPT worker in the lists does not make ChatGPT's earlier reset end a Claude-reset mode.
  const rungs = { light: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }, { target: { agent: 'general-purpose', model: 'opus' }, effort: 'high' }] }
  const modes = normalizeModes([{ id: 'claude', name: 'Claude work', rungs, until: { reset: 'anthropic' } }])
  const limits = ['five_hour', 'seven_day'].map(kind => ({ kind, percentUsed: kind === binding ? 90 : 20, resetsAt: new Date(NOW + (kind === binding ? 30_000 : 10_000)).toISOString() }))
  const b = boundaries(on, { modes, activeMode: 'claude', activeSince: NOW }, { limits })
  const asked: string[] = []
  on('http.fetch', { url: /\/api\/chatgpt-accounts/ }, ($, e) => {
    asked.push(e.url)
    const accounts = [{ state: 'ready', quota: { at: NOW, rate_limits: { primary: { used_percent: 10, window_minutes: 300, reset_at: (NOW + 5_000) / 1000 } } } }]
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ provider: 'chatgpt', accounts }) } }
  })
  http(on)
  await start($)
  await b.clock.advance(20_000)
  expect(b.router().settings.activeMode).toBe('claude')
  await b.clock.advance(20_000)
  expect(b.router().settings.activeMode).toBeUndefined()
  expect(b.toasts.filter(text => text === 'The Claude work mode has ended.').length).toBe(1)
  expect(asked).toEqual([])
})

test('/ripple stats returns plain measured text', async ($, on) => {
  boundaries(on)
  const out = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(out.text).toContain('Auto: 0 prompts, 0 requests; 0 weighted tokens')
  expect(out.text).toContain('Workers: light 0, standard 0, deep 0, design 0')
})

for (const surface of ['terminal', 'desktop'] as const) test('quick controls save immediately on ' + surface + ' and Close keeps the changes', async ($, on) => {
  const b = boundaries(on)
  const urls = http(on)
  await start($)
  const ui = await band($, surface)
  expect(await ui.find({ type: 'Text', text: 'ClaudeRipple' })).toBeUndefined()
  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Text', text: 'Quick settings' })).toBeDefined()
  expect(await ui.find({ key: 'save' })).toBeUndefined()
  const puts = () => b.settingsRequests.filter(r => r.method === 'PUT').length
  let count = puts()
  await ui.press({ key: 'bias-2' })
  expect(b.router().settings.bias).toBe(2)
  expect(puts()).toBe(++count)
  await ui.press({ key: 'set-auto' })
  expect(b.router().settings.effortAuto).toBe(false)
  expect(puts()).toBe(++count)
  expect(await ui.find({ key: 'bias-2' })).toBeUndefined()
  await ui.press({ key: 'set-auto' })
  expect(b.router().settings.effortAuto).toBe(true)
  expect(puts()).toBe(++count)
  for (const judge of ['jev', 'model', 'haiku'] as const) {
    await ui.press({ key: 'judge-' + judge })
    expect(b.router().settings.judge).toBe(judge)
    expect(puts()).toBe(++count)
  }
  await ui.press({ key: 'set-warm' })
  expect(b.router().settings.keepWarm).toBe(true)
  expect(puts()).toBe(++count)
  await ui.press({ key: 'close' })
  expect(puts()).toBe(count)
  expect(b.router().settings).toMatchObject({ bias: 2, effortAuto: true, judge: 'haiku', keepWarm: true })
  // Opening the panel reads the rung choices once, so a model ticked on the dashboard is offered.
  expect(urls.filter(url => url.endsWith('/api/mod-options')).length).toBe(1)
  await ui.press({ key: 'hide' })
  expect(b.saved.get('bandHidden')).toBe(true)
  await $.command.run({ command: 'ripple-bar', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: '' })
  expect(b.saved.get('bandHidden')).toBe(false)
  await ui.unmount()
})

test('ripple-bar says where the line is when the layout is minimal', async ($, on) => {
  const b = boundaries(on, { layout: 'minimal' })
  http(on)
  await start($)
  const run = () => $.command.run({ command: 'ripple-bar', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: '' })
  expect((await run()).text).toContain('hidden')
  expect(b.saved.get('bandHidden')).toBe(true)
  expect((await run()).text).toContain('Minimal')
})

for (const surface of ['terminal', 'desktop'] as const) test('quick settings select a saved mode, never edit rungs, on ' + surface, async ($, on) => {
  const b = boundaries(on, { modes: BURN })
  http(on)
  await start($)
  const ui = await band($, surface)
  await ui.press({ key: 'settings' })
  // The terminal's Select; the desktop's Mode tile, a drawn segment per mode.
  if (surface === 'desktop') {
    const modes = String((await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt).find(alt => String(alt).includes('Burn GPT')))
    for (const label of ['Base', 'Burn GPT']) expect(modes, label).toContain(label)
    for (const value of ['', 'burn']) expect(await ui.find({ type: 'Button', key: 'mode-' + value }), value).toBeDefined()
  } else {
    const control = await ui.find({ key: 'mode' })
    expect(control?.type).toBe('Select')
    expect((control?.props.options as { label: string }[]).map(o => o.label)).toEqual(['Base', 'Burn GPT'])
  }
  for (const rung of ['light', 'standard', 'hard', 'plan']) expect(await ui.find({ key: 'rung-' + rung })).toBeUndefined()
  const pick = (value: string) => surface === 'desktop' ? ui.press({ key: 'mode-' + value }) : ui.select({ key: 'mode', value })
  await pick('burn')
  expect(b.router().settings.activeMode).toBe('burn')
  expect(b.router().settings.rules).toEqual(DEFAULTS.rules)
  await pick('')
  expect(b.router().settings.activeMode).toBeUndefined()
  await ui.unmount()
})

test('quick settings show Base even before any mode is saved', async ($, on) => {
  boundaries(on)
  http(on)
  await start($)
  const ui = await band($)
  await ui.press({ key: 'settings' })
  const mode = await ui.find({ key: 'mode' })
  expect((mode?.props.options as { label: string }[]).map(o => o.label)).toEqual(['Base'])
  await ui.unmount()
})

for (const platform of ['Darwin', 'Windows_NT', 'Linux'] as const) test('all settings opens the mod dashboard on ' + platform, async ($, on) => {
  const b = boundaries(on, { language: 'en' }, { platform, env: platform === 'Windows_NT' ? { OS: 'Windows_NT' } : {} })
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'all-settings' })
  const url = 'http://127.0.0.1:9992/#mod'
  const argv = platform === 'Darwin' ? ['open', url] : platform === 'Windows_NT' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
  expect(b.processes.map(p => p.argv)).toEqual(platform === 'Windows_NT' ? [argv] : [['uname', '-s'], argv])
  expect(b.toasts).toEqual([])
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  await ui.unmount()
})

for (const failure of ['exit', 'throw'] as const) test('a browser ' + failure + ' failure toasts the dashboard URL', async ($, on) => {
  const b = boundaries(on, { language: 'en' }, { platform: 'Darwin', browserFailure: failure })
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'all-settings' })
  expect(b.toasts).toContain('http://127.0.0.1:9992/#mod')
  expect(b.logs.some(log => log.includes('open mod settings'))).toBe(true)
  await ui.unmount()
})

test('host survey wins; minimal layout renders through SessionMode', async ($, on) => {
  boundaries(on, { layout: 'minimal' })
  http(on)
  await start($)
  const survey = await band($, 'terminal', true)
  expect(await survey.find({ type: 'Text', text: 'host drawing' })).toBeDefined()
  await survey.unmount()
  const above = await band($)
  expect(await above.find({ key: 'auto' })).toBeUndefined()
  const footer = await $.ui.mount({ plugin: 'ripple', component: 'SessionMode', requestId: 'footer', surface: 'terminal', props: { modes: ['plan'] }, viewport: { columns: 140, rows: 40 } })
  expect(await footer.find({ key: 'auto' })).toBeDefined()
  expect(await footer.find({ type: 'Text', text: 'host drawing' })).toBeDefined()
})

test('a desktop survey draws over the band instead of blanking it', async ($, on) => {
  boundaries(on)
  http(on)
  await start($)
  const plain = await band($, 'desktop')
  expect(await plain.find({ key: 'compact' }), 'band without a survey').toBeDefined()
  await plain.unmount()
  const survey = await band($, 'desktop', true)
  expect(await survey.find({ type: 'Text', text: 'host drawing' }), 'host survey').toBeDefined()
  expect(await survey.find({ key: 'compact' }), 'band under the survey').toBeDefined()
  await survey.unmount()
})

test('the dashboard keeps what another mod drew above the prompt, on the terminal and the desktop', async ($, on) => {
  boundaries(on)
  http(on)
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: 'host drawing' }), `${surface}: the other mod's drawing`).toBeDefined()
    expect(await ui.find({ key: surface === 'terminal' ? 'auto' : 'compact' }), `${surface}: the band beside it`).toBeDefined()
    await ui.unmount()
  }
  await command($, 'settings')
  const settings = await band($)
  expect(await settings.find({ type: 'Text', text: 'host drawing' }), 'settings card').toBeDefined()
  await settings.unmount()
})

test('log queries by session and reopening follows engine panes, not stale atoms', async ($, on) => {
  const b = boundaries(on)
  const urls = http(on)
  await start($)
  await $.command.run({ command: 'ripple-log', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: '' })
  expect(urls.some(url => url.includes('session=session-test'))).toBe(true)
  expect(b.panes.has('ripple-log')).toBe(true)
  b.panes.clear() // Host reload closed the pane without ui.close.
  await $.command.run({ command: 'ripple-log', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: '' })
  expect(b.panes.has('ripple-log')).toBe(true)
})

test('clear reloads router settings and resume restores cache age', async ($, on) => {
  const b = boundaries(on, { effortAuto: false })
  http(on)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 120, prompt_cache_likely_expired: false, model: 'claude-opus-5-5' })
  const out = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'debug' })
  expect(out.text).toContain('"lastReplyAt": 880000')
  await $.classic.SessionStart({ source: 'clear' })
  const ui = await band($)
  expect((await ui.find({ key: 'auto' }))?.props.label).toContain('○')
  expect(b.logs).toEqual([])
})

test('Save caps a high judge pick until the reported limit resets', async ($, on) => {
  const b = boundaries(on, {}, { limits: [{ kind: 'five_hour', percentUsed: 86, resetsAt: new Date(NOW + 60000).toISOString() }] })
  http(on)
  judgeStub(on, '{"effort":"max","sure":0.9,"why":"hard"}')
  const sent = stepStub(on)
  await start($)
  await b.clock.advance(1)
  await command($, 'save')
  await submit($)
  await step($)
  await complete($)
  await b.clock.advance(60000)
  await submit($)
  await step($)
  expect(sent.map(s => s.effort)).toEqual(['medium', 'max'])
})

test('an unsure Jev still decides: no Haiku call, no alert, key only to TypeSafe', async ($, on) => {
  const b = boundaries(on, { judge: 'jev' }, { key: 'test-secret' })
  const judges = judgeStub(on, '{"effort":"high","why":"fallback"}')
  const sent = stepStub(on)
  const destinations: string[] = []
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    if (e.init?.headers?.authorization) destinations.push(e.url)
    if (e.url === 'https://api.typesafe.ai/v1/systemone') {
      expect(e.init?.headers?.authorization).toBe('Bearer test-secret')
      const body = JSON.parse(e.init?.body ?? '{}')
      expect(body.questions.effort.type).toBe('choice')
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: { effort: { choice: 'low', confidence: 0.2 } } }) } }
    }
    return { value: { ok: true, status: 200, headers: {}, text: '{"requests":[]}' } }
  })
  await start($)
  await submit($)
  await step($)
  expect(judges.length).toBe(0)
  // Torn at 0.2 with no odds given, the session keeps the effort it runs at.
  expect(sent[0]?.effort).toBe('medium')
  expect(destinations).toEqual(['https://api.typesafe.ai/v1/systemone'])
  // An unsure answer is not a judge failure: no toast, no alert card.
  expect(b.toasts).toEqual([])
  expect(await (await band($)).find({ type: 'Text', text: /not answering/ })).toBeUndefined()
})

test('Jev times out at five seconds without blocking the person prompt, and says so only the second time running', async ($, on) => {
  const b = boundaries(on, { judge: 'jev' }, { key: 'test-secret' })
  const judges = judgeStub(on, '{"effort":"medium","why":"fallback"}')
  on('http.fetch', async ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    if (e.url.includes('typesafe.ai')) await b.clock.sleep(6000)
    return { value: { ok: true, status: 200, headers: {}, text: '{"requests":[]}' } }
  })
  await start($)
  const pending = submit($)
  await b.clock.settle()
  // The judge's own timeout rose from three seconds to five on 2026-10-22 (register.tsx judge);
  // advancing the old three would leave the race pending and hang the prompt.
  await b.clock.advance(5000)
  const out = await pending
  expect(out.text).toContain('Implement')
  expect(judges.length).toBe(1)
  // One slow answer is a bad moment: Haiku covered it and nothing is said.
  expect(b.toasts.some(t => t.includes('timed out'))).toBe(false)
  const again = submit($, 'Refactor the parser across three files and verify.')
  await b.clock.settle()
  await b.clock.advance(5000)
  await again
  expect(b.toasts.some(t => t.includes('timed out'))).toBe(true)
})

test('a dropped Jev connection says it in plain words, and only the second time running', async ($, on) => {
  const b = boundaries(on, { judge: 'jev' }, { key: 'test-secret' })
  const judges = judgeStub(on, '{"effort":"medium","why":"fallback"}')
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    if (e.url.includes('typesafe.ai')) throw new Error('ripple: $.http.fetch(https://api.typesafe.ai/v1/systemone) failed: ECONNRESET: The socket connection was closed unexpectedly.')
    return { value: { ok: true, status: 200, headers: {}, text: '{"requests":[]}' } }
  })
  await start($)
  await submit($)
  expect(judges.length).toBe(1)
  expect(b.toasts).toEqual([])
  await submit($, 'Refactor the parser across three files and verify.')
  expect(b.toasts.some(t => t.includes('network unavailable'))).toBe(true)
  expect(b.toasts.some(t => t.includes('ECONNRESET'))).toBe(false)
  // The card blames the connection, not the judge.
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /connection is unsteady/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /not answering/ })).toBeUndefined()
})

test('router judge falls back and Haiku retries its alias when unanswered', async ($, on) => {
  boundaries(on, { judge: 'model', judgeModel: 'test-router-model' })
  http(on)
  const models: string[] = []
  on('model.complete', ($, e) => {
    models.push(e.model)
    return { value: e.model === 'haiku' ? { isAnswered: true, text: '{"effort":"low","why":"simple"}', usage: USAGE } : { isAnswered: false, reason: 'empty-reply', usage: USAGE } }
  })
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($)
  expect(models).toEqual(['test-router-model', 'claude-haiku-5-5', 'haiku'])
  expect(sent[0]?.effort).toBe('low')
})

test('Jev key input preserves other env lines and chmods the file 600', async ($, on) => {
  let readingForSave = false
  const b = boundaries(on, { judge: 'jev' }, { envFile: () => readingForSave ? 'OTHER=keep\nTYPESAFE_API_KEY=old\nTAIL=yes\n' : '' })
  http(on)
  const path = '/home/test/.config/jev/.env'
  await start($)
  await command($, 'settings')
  const ui = await band($)
  readingForSave = true
  await ui.input({ key: 'jev-key', text: 'new-$&-$$-key' })
  expect(await ui.find({ key: 'jev-key' })).toBeUndefined()
  expect(await ui.find({ key: 'jev-test' })).toBeUndefined()
  expect(b.files.get(path)).toBe('OTHER=keep\nTYPESAFE_API_KEY=new-$&-$$-key\nTAIL=yes\n')
  expect(b.processes.at(-1)?.argv).toEqual(['chmod', '600', path])
})

test('Jev Test displays latency and a missing-key result', async ($, on) => {
  boundaries(on, { judge: 'jev' })
  http(on)
  judgeStub(on, '{"effort":"low","why":"fallback"}')
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'jev-test' })
  expect(await ui.find({ type: 'Text', text: /0 ms · low · Jev key missing/ })).toBeDefined()
  await ui.unmount()
})

test('reload restores the retired waiting classification to running without losing its tool', async ($, on) => {
  boundaries(on)
  http(on)
  let legacy = true
  let records: AgentRec[] = []
  on('state.get', { plugin: 'ripple', key: 'agents' }, ($, e, next) => legacy ? { value: { value: [{ id: 'old', state: 'waiting', startedAt: NOW - 30_000, cost: 0, now: 'Bash npm test', toolSince: NOW - 30_000 }], version: 0 } } : next(e))
  on('state.set', { plugin: 'ripple', key: 'agents' }, async ($, e, next) => { legacy = false; records = e.value as AgentRec[]; return next(e) })
  await start($)
  expect(records[0]).toMatchObject({ id: 'old', state: 'running', now: 'Bash npm test', toolSince: NOW - 30_000 })
})

test('known agents stay running through a long tool and finish with cost', async ($, on) => {
  const b = boundaries(on)
  http(on)
  judgeStub(on)
  spawnStub(on)
  stepStub(on)
  on('tool.call', async () => { await b.clock.sleep(30000); return { result: 'ok' } })
  await start($)
  await $.agent.spawn(SPAWN)
  await step($, 'deepseek-v4.1-flash@low', 'low', 'worker-1')
  const input: ToolCallInput = { tool: 'Bash', command: 'npm test', agentId: 'worker-1', tool_use_id: 'tool-long' }
  const tool = $.tool.call(input)
  await b.clock.settle()
  await b.clock.advance(15000)
  const ui = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface: 'terminal', props: { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Bash npm test · 15s/ })).toBeDefined()
  const desktop = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface: 'desktop', props: { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  const age = await desktop.find({ type: 'Text', text: '15s' })
  expect(age?.props.color).toBe('#f2f0eb')
  await desktop.unmount()
  await b.clock.advance(15000)
  await tool
  await complete($, 'worker-1')
  expect(await ui.find({ type: 'Text', text: 'Rename variable' })).toBeDefined()
  // The Claude app's count: one step's prompt (100 + 40000 cached) plus its output (10), not the weighted cost.
  // The cached share is rounded down, so 40000/40100 reads 99%, never a whole 100.
  expect(await ui.find({ type: 'Text', text: 'tokens 40k · cache 99% · tools 1' })).toBeDefined()
})

test('an agent keeps the API\'s token counts, its tools and the effort it was sent at; its card opens its conversation and goes back', async ($, on) => {
  const reads: string[] = []
  const b = boundaries(on, {}, { agentMessages: id => {
    reads.push(id)
    return [{ role: 'user', text: 'Rename one local variable and verify it.', toolUses: [] }, { role: 'assistant', text: 'Renamed it.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' }, text: 'ok' }] }]
  } })
  http(on)
  judgeStub(on)
  spawnStub(on)
  stepStub(on, { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 700 })
  on('tool.call', () => ({ result: 'ok' }))
  let written: AgentRec[] = []
  on('state.set', { plugin: 'ripple', key: 'agents' }, async ($, e, next) => {
    const result = await next(e)
    written = e.value as AgentRec[]
    return result
  })
  await start($)
  // The light rung runs DeepSeek, whose routed id carries @low whatever the request's effort says.
  await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: light]]\n${SPAWN.prompt}` })
  await step($, 'deepseek-v4.1-flash@low', 'high', 'worker-1')
  await step($, 'deepseek-v4.1-flash@low', 'high', 'worker-1')
  const input: ToolCallInput = { tool: 'Bash', command: 'npm test', agentId: 'worker-1', tool_use_id: 'tool-a' }
  await $.tool.call(input)
  const rec = written.find(a => a.id === 'worker-1')
  // The last step's counts, not a sum of both steps' prompts; the output totals every step.
  expect(rec?.usage).toEqual({ input: 300, cached: 9000, cacheWrite: 700, output: 50 })
  expect(rec?.outputTotal).toBe(100)
  expect(rec?.tools).toBe(1)
  expect(rec?.effort).toBe('low')
  expect(rec?.answeredBy).toBe('deepseek-v4.1-flash@low')
  expect(rec?.provider).toBe('deepseek')
  const ui = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface: 'terminal', props: { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /tokens 10k · cache 90% · tools 1/ })).toBeDefined()
  expect(reads).toEqual([])
  await ui.press({ key: 'open-worker-1' })
  expect(reads).toContain('worker-1')
  // The app's own agent view is asked first; the test engine draws no main view, so the refusal
  // goes to the debug log and the conversation is read here. Opened, the pane is asked to go to
  // the conversation's end, its newest words; the test engine scrolls nothing either.
  expect(b.logs.filter(log => log.includes('agents view'))).toEqual(['ClaudeRipple agents view: no implementation for ui.view'])
  expect(b.logs.filter(log => log.includes('agents scroll'))).toEqual(['ClaudeRipple agents scroll: no implementation for ui.scroll'])
  expect(await ui.find({ type: 'Text', text: 'Renamed it.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'npm test' })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: 'Renamed it.' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'open-worker-1' })).toBeDefined()
})

test('an agent\'s card takes the app to the agent\'s own view, and the pane stays on its list', async ($, on) => {
  const reads: string[] = []
  boundaries(on, {}, { agentMessages: id => { reads.push(id); return [] } })
  http(on)
  judgeStub(on)
  spawnStub(on)
  stepStub(on, { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  const viewed: unknown[] = []
  on('ui.view', ($, e) => { viewed.push(e); return { value: {} } })
  await start($)
  await $.agent.spawn(SPAWN)
  await step($, 'deepseek-v4.1-flash@low', 'high', 'worker-1')
  const ui = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface: 'terminal', props: { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  await ui.press({ key: 'open-worker-1' })
  expect(viewed).toEqual([{ agentId: 'worker-1' }])
  expect(reads).toEqual([])
  expect(await ui.find({ type: 'Button', key: 'open-worker-1' })).toBeDefined()
})

test('an agent\'s run of tool calls unfolds on press, its paths short against the session folder, and folds again once the pane goes back', async ($, on) => {
  boundaries(on, {}, { agentMessages: () => [
    { role: 'user', text: 'Run the tests.', toolUses: [] },
    { role: 'assistant', text: 'Running.', toolUses: [
      { tool_use_id: 'c1', tool: 'Bash', input: { command: 'cd /work/android && ./gradlew test' }, text: 'ok' },
      { tool_use_id: 'c2', tool: 'Read', input: { file_path: '/work/core/A.kt' }, text: 'ok' },
    ] },
  ] })
  http(on)
  judgeStub(on)
  spawnStub(on)
  stepStub(on)
  const runs: unknown[] = []
  on('state.set', { plugin: 'ripple', key: 'agentRunsOpen' }, async ($, e, next) => {
    runs.push(e.value)
    return next(e)
  })
  await start($)
  await $.agent.spawn(SPAWN)
  const ui = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface: 'terminal', props: { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  await ui.press({ key: 'open-worker-1' })
  expect(await ui.find({ type: 'Button', text: /^Ran a command, read a file/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: './gradlew test' })).toBeUndefined()
  await ui.press({ key: 'run-c1' })
  expect(await ui.find({ type: 'Text', text: /^\.\/gradlew test$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^core\/A\.kt$/ })).toBeDefined()
  await ui.press({ key: 'run-c1' })
  expect(await ui.find({ type: 'Text', text: './gradlew test' })).toBeUndefined()
  await ui.press({ key: 'run-c1' })
  expect(runs.at(-1)).toEqual(['c1'])
  await ui.press({ key: 'back' })
  // Back on the list, the unfolded run is forgotten.
  expect(runs.at(-1)).toEqual([])
  await ui.press({ key: 'open-worker-1' })
  expect(await ui.find({ type: 'Text', text: './gradlew test' })).toBeUndefined()
})

// ---- Handoff (2026-10-24: one press, the session's model writes it in a fork) -------------------

/** The claude:// link a handoff opened, and its query. */
function opened(b: { processes: { argv: readonly string[] }[] }): URLSearchParams | undefined {
  const link = b.processes.map(p => p.argv.at(-1) ?? '').find(arg => arg.startsWith('claude://code/new?'))
  return link ? new URLSearchParams(link.slice('claude://code/new?'.length)) : undefined
}

// 2026-10-13: a handoff that cleared the chat lost the owner the chat. It never clears, and it
// sends nothing to this chat: the note waits in the new session's prompt box.
test('the band\'s Handoff has the session write the note in a fork and opens a new session in the folder, this chat untouched', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const commands: string[] = []
  on('command.run', { command: 'clear' }, () => { commands.push('clear'); return {} })
  const prompts: string[] = []
  on('model.fork', ($, e) => { prompts.push(e.prompt); return { value: { isAnswered: true, text: 'Resume: the band fix is half done.', usage: USAGE } } })
  await start($)
  const ui = await band($)
  expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeDefined()
  await ui.press({ key: 'handoff' })
  await b.clock.advance(15000)
  expect(prompts).toEqual([QUICK_PROMPT])
  const query = opened(b)
  expect(query?.get('folder')).toBe('/work')
  expect(query?.get('source')).toBe('services')
  expect(query?.get('q')).toContain('the band fix is half done')
  expect(query?.get('q')).toContain('Continue with the justified next action')
  expect(b.submitted).toEqual([])
  expect(b.filled).toEqual([])
  expect(commands).toEqual([])
  const card = await band($, 'desktop')
  expect(await card.find({ type: 'Text', text: 'Handoff done' })).toBeDefined()
  expect(await card.find({ type: 'Text', text: /^A new session opened with the handoff filled in/ })).toBeDefined()
})

test('a long handoff is saved under handoffs and the new session\'s box only names the file', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const note = 'Resume: ' + 'verify the pending step. '.repeat(600)
  on('model.fork', () => ({ value: { isAnswered: true, text: note, usage: USAGE } }))
  await start($)
  await (await band($)).press({ key: 'handoff' })
  await b.clock.advance(15000)
  const path = [...b.files.keys()].find(p => p.startsWith('/home/test/.clauderipple/handoffs/handoff-') && p.endsWith('.md'))
  expect(path).toBeDefined()
  expect(b.files.get(path!)).toContain(note.trim())
  expect(opened(b)?.get('q')).toBe(`Read the handoff in ${path} and continue from it.`)
})

test('a handoff that cannot open a new session is copied; without a clipboard it fills this prompt', async ($, on) => {
  const b = boundaries(on, {}, { browserFailure: 'exit' })
  http(on)
  const copied: string[] = []
  let clipboard = true
  on('ui.copy', ($, e) => { copied.push(e.text); return { value: clipboard ? { isCopied: true } : { isCopied: false, reason: 'no-clipboard' } } as never })
  on('model.fork', () => ({ value: { isAnswered: true, text: 'Pending: verify the changed files.', usage: USAGE } }))
  await start($)
  await (await band($)).press({ key: 'handoff' })
  await b.clock.advance(15000)
  expect(copied.length).toBe(1)
  expect(copied[0]).toContain('Pending: verify the changed files.')
  expect(b.toasts.some(t => t.includes('Could not open a new session'))).toBe(true)
  expect(b.filled).toEqual([])
  const card = await band($, 'desktop')
  expect(await card.find({ type: 'Text', text: 'The resume note was copied; this chat was kept.' })).toBeDefined()
  // Copy again, with the clipboard gone: the note goes into this chat's prompt box, not sent.
  clipboard = false
  await card.press({ key: 'copy' })
  expect(b.filled[0]).toContain('Pending: verify the changed files.')
  expect(b.toasts.some(t => t.includes('clipboard unavailable'))).toBe(true)
  expect(b.submitted).toEqual([])
})

test('a handoff whose fork fails or answers nothing fails with a toast and sends nothing here', async ($, on) => {
  const b = boundaries(on)
  http(on)
  let forks = 0
  on('model.fork', () => ({ value: ++forks === 1 ? { isAnswered: false, reason: 'nothing-to-fork' } : { isAnswered: true, text: '  ', usage: USAGE } }) as never)
  await start($)
  const first = await band($)
  await first.press({ key: 'handoff' })
  await first.unmount()
  await b.clock.advance(15000)
  expect(forks).toBe(1)
  expect(b.toasts.filter(t => t.includes('handoff failed')).length).toBe(1)
  const card = await band($, 'desktop')
  expect(await card.find({ type: 'Text', text: 'That did not finish' })).toBeDefined()
  await card.press({ key: 'dismiss' })
  await (await band($)).press({ key: 'handoff' })
  await b.clock.advance(15000)
  expect(forks).toBe(2)
  expect(b.toasts.filter(t => t.includes('handoff failed')).length).toBe(2)
  expect(b.submitted).toEqual([])
  expect(b.filled).toEqual([])
  expect(opened(b)).toBeUndefined()
})

test('a handoff pressed mid-turn is written once the turn ends', async ($, on) => {
  const b = boundaries(on, { effortAuto: false })
  http(on)
  let forks = 0
  on('model.fork', () => { forks++; return { value: { isAnswered: true, text: 'Resume: tests pending.', usage: USAGE } } })
  await start($)
  await submit($)
  await (await band($)).press({ key: 'handoff' })
  await b.clock.advance(15000)
  expect(forks).toBe(0)
  await complete($)
  await b.clock.advance(15000)
  expect(forks).toBe(1)
  expect(opened(b)?.get('q')).toContain('tests pending')
  // Only the person's own prompt went to this chat.
  expect(b.submitted).toEqual(['Implement the bounded change and verify the tests.'])
})

test('a restored manual pick yields to the first app effort, but a fresh manual pick applies', async ($, on) => {
  const b = boundaries(on, { effortAuto: false })
  b.saved.set('pick', { effort: 'max', by: 'manual', why: 'old chat', at: 0 })
  http(on)
  const sent = stepStub(on)
  await start($)
  await step($, 'claude-opus-5-5', 'medium')
  expect(sent[0]?.effort).toBe('medium')
  await complete($)
  const ui = await band($)
  await ui.press({ key: 'effort' })
  await ui.press({ key: 'pick-high' })
  await step($, 'claude-opus-5-5', 'medium')
  expect(sent[1]?.effort).toBe('high')
})

test('first-run setup finishes once and keeps its saved choices', async ($, on) => {
  const b = boundaries(on, { setupDone: false })
  http(on)
  await start($)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'Welcome to ClaudeRipple' })).toBeDefined()
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'set-warm' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'finish' })
  expect(b.router().settings).toMatchObject({ setupDone: true, keepWarm: true })
  expect(b.storeWrites).not.toContain('settings')
  expect(b.storeWrites).not.toContain('setupDone')
})

test('saving unrelated settings cannot revive stopped keep-warm; toggling it can', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  stepStub(on)
  let forks = 0
  on('model.fork', () => { forks++; return { value: { isAnswered: false, reason: 'nothing-to-fork' } } })
  await start($)
  await step($)
  await complete($)
  await b.clock.advance(3375000)
  expect(forks).toBe(1)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'bias-1' })
  await b.clock.advance(15000)
  expect(forks).toBe(1)
  await command($, 'warm')
  await command($, 'warm')
  await b.clock.advance(15000)
  expect(forks).toBe(2)
})

test('Save caps an existing high pick without another judge and records sent effort', async ($, on) => {
  const b = boundaries(on, {}, { limits: [{ kind: 'five_hour', percentUsed: 86, resetsAt: new Date(NOW + 60000).toISOString() }] })
  http(on)
  judgeStub(on, '{"effort":"high","why":"scope"}')
  const sent = stepStub(on)
  await start($)
  await b.clock.advance(1)
  await submit($)
  await step($)
  await command($, 'save')
  await step($)
  expect(sent.map(s => s.effort)).toEqual(['high', 'medium'])
  expect((await command($, 'stats')).text).toContain('medium 0 prompts / 4150 weighted')
})

test('fork aggregate usage wins over the last step without main cost contamination', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  judgeStub(on)
  stepStub(on)
  let forks = 0
  on('model.fork', async () => {
    forks++
    await step($)
    await step($)
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 80000, cache_creation_input_tokens: 0 } } }
  })
  await start($)
  await step($)
  await complete($)
  await b.clock.advance(3375000)
  expect(forks).toBe(1)
  const out = await command($, 'stats')
  expect(out.text).toContain('Auto: 0 prompts, 0 requests')
  expect(out.text).toContain('Warm: 1 pings, 8300 weighted tokens')
})

// ---- Regressions of 2026-10-10 (setup step 2, the band) ----------------------------------------

test('setup step 2 opens the dashboard; its draft preserves edits and follows remote worker settings', async ($, on) => {
  const b = boundaries(on, { setupDone: false })
  http(on)
  await start($)
  const ui = await band($)
  await ui.press({ key: 'judge-model' })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: 'Workers start on the ladder; set it up on the dashboard.' })).toBeDefined()
  await ui.press({ key: 'all-settings' })
  expect(b.processes.at(-1)?.argv).toEqual(['xdg-open', 'http://127.0.0.1:9992/#mod'])
  // Changes on the dashboard reach setup without replacing the person's judge edit.
  const general = DEFAULTS.rules.general
  const light = { target: { agent: 'general-purpose', model: 'haiku' }, effort: 'low' }
  b.remote({ settings: normalizeSettings({ setupDone: false, rules: { general: { ...general, rungs: { ...(general.mode === 'ladder' ? general.rungs : {}), light } } }, keepWarmHours: 8 }), revision: 2, stored: true })
  await b.clock.advance(3000)
  await ui.press({ key: 'next' })
  await ui.press({ key: 'set-warm' })
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: 'Claude Haiku · gpt-6-1-sol · gpt-6-astra · Claude Opus' })).toBeDefined()
  await ui.press({ key: 'finish' })
  expect(b.router().settings).toMatchObject({ judge: 'model', keepWarm: true, keepWarmHours: 8, setupDone: true })
  const saved = b.router().settings.rules.general
  expect(saved.mode === 'ladder' && saved.rungs.light).toEqual([light])
  expect(b.settingsRequests.filter(r => r.method === 'PUT').map(r => r.revision)).toEqual([2])
  await ui.unmount()
})

test('a poll that finds nothing new writes no state, and the band draws the same pictures', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const writes: string[] = []
  let counting = false
  on('state.set', { plugin: 'ripple' }, async ($, e, next) => { if (counting) writes.push(e.key); return next(e) })
  await start($)
  const ui = await band($, 'desktop')
  await b.clock.advance(3000)
  const before = JSON.stringify(await ui.drawn())
  counting = true
  await b.clock.advance(3000)
  await b.clock.advance(3000)
  expect(writes).toEqual([])
  expect(JSON.stringify(await ui.drawn())).toBe(before)
  await ui.unmount()
})

// 2026-10-24: with workers running, 리플이 and the water stopped short and started over — the band
// read the agent list, written on every agent step and tool call, and took each worker request as
// its route. Each redraw is a new picture, so every one restarts the motion.
test('workers do not redraw the band: it reads agent counts, not the list, and its route is the chat\'s own', async ($, on) => {
  const b = boundaries(on)
  const request = (at: string, target: string, subagent: boolean) => ({ at, source: target, target, provider: 'anthropic', status: 200, ok: true, ms: 1000, session: 'session-test', ...(subagent ? { subagent: true } : {}) })
  let requests = [request('2026-10-10T13:19:10', 'claude-opus-5-5', false)]
  on('http.fetch', { url: /\/api\/requests/ }, () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ requests }) } }))
  http(on)
  const reads: string[] = []
  const writes: string[] = []
  let reading = false
  let writing = false
  on('state.get', { plugin: 'ripple' }, ($, e, next) => { if (reading) reads.push(e.key); return next(e) })
  on('state.set', { plugin: 'ripple' }, async ($, e, next) => { if (writing) writes.push(e.key); return next(e) })
  await start($)
  await b.clock.advance(3000)
  reading = true
  const ui = await band($, 'desktop')
  await ui.drawn()
  reading = false
  expect(reads).toContain('agentCounts')
  expect(reads).not.toContain('agents')
  writing = true
  requests = [request('2026-10-10T13:19:20', 'deepseek-v4.1-flash', true), ...requests]
  await b.clock.advance(3000)
  expect(writes).not.toContain('last')
  requests = [request('2026-10-10T13:19:30', 'claude-opus-5-5', false), ...requests]
  await b.clock.advance(3000)
  expect(writes).toContain('last')
  await ui.unmount()
})

test('an idle band is asked again only when the minute it shows changes', async ($, on) => {
  // Each ask is a new answer the desktop draws afresh; idle, only the countdown may cause one.
  const b = boundaries(on)
  http(on)
  judgeStub(on)
  stepStub(on)
  const writes: string[] = []
  const invalidates: number[] = []
  let counting = false
  on('state.set', { plugin: 'ripple' }, async ($, e, next) => { if (counting) writes.push(e.key); return next(e) })
  on('ui.invalidate', ($, e, next) => { if (counting) invalidates.push(b.clock.now()); return next(e) })
  await start($)
  await submit($)
  await step($)
  await complete($)
  const replied = b.clock.now()
  const ui = await band($, 'desktop')
  await b.clock.advance(20_000)
  const before = JSON.stringify(await ui.drawn())
  expect(before).toMatch(/"\d+m"/)
  counting = true
  // Three minutes of polls (3 s) and ticks (15 s).
  for (let i = 0; i < 12; i++) await b.clock.advance(15_000)
  expect(writes).toEqual([])
  expect(invalidates).toEqual([replied + 60_000, replied + 120_000, replied + 180_000])
  const after = JSON.stringify(await ui.drawn())
  expect(after).not.toBe(before)
  // Only the countdown moved: its minutes (value and tip) and the clock of its share.
  const countdownless = (tree: string) => tree.replace(/"handle":\d+/g, '').replace(/\b\d+m\b/g, 'm').replace(/[●◕◑◔○]/g, 'o').replace(/"source":"(?:[^"\\]|\\.)*","alt":"Cache"/g, '"alt":"Cache"')
  expect(countdownless(after)).toBe(countdownless(before))
  await ui.unmount()
})

test('the judge says a failure once per reason, and Jev without a TypeSafe key asks Zen', async ($, on) => {
  const b = boundaries(on, { judge: 'jev' }, { config: { ...CONFIG, providers: { ...CONFIG.providers, 'opencode-zen': { headers: { authorization: 'zen-key' }, models: [{ id: 'jev-1.13' }] } } } })
  const sent: string[] = []
  http(on, false, { ...CONFIG, providers: { ...CONFIG.providers, 'opencode-zen': { headers: { authorization: 'zen-key' }, models: [{ id: 'jev-1.13' }] } } }, e => { sent.push(e.init?.headers?.authorization ?? '') })
  judgeStub(on)
  stepStub(on)
  await start($)
  await submit($)
  expect(sent).toEqual(['zen-key'])
  expect(b.toasts.filter(t => t.startsWith('Judge'))).toEqual([])
})

test('a judge failing for the same reason is said once in a session', async ($, on) => {
  const b = boundaries(on, { judge: 'jev' })
  http(on)
  judgeStub(on)
  stepStub(on)
  await start($)
  await submit($)
  await complete($)
  await submit($, 'Implement the next bounded change and verify the tests again.')
  expect(b.toasts.filter(text => text.includes('keeping the current effort or asking Haiku')).length, JSON.stringify(b.toasts)).toBe(1)
})

// 2026-10-11: on the desktop a toggle was told only by dimness, which the host's hover undoes, so a
// click showed nothing. Each control must change what is drawn next, and a toggle's state must be in
// the drawing itself (the picture's own `on` / `off` on the desktop, ● / ○ on the terminal).
test('every band control changes the next drawing, and a toggle says its state outright', async ($, on) => {
  const b = boundaries(on)
  on('http.fetch', { url: /\/api\/requests/ }, () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ requests: [{ at: '2026-10-10T13:19:10', source: 'gpt-6-1-sol@high', target: 'gpt-6.1-sol', provider: 'chatgpt', status: 200, ok: true, ms: 2140, session: 'session-test' }] }) } }))
  http(on)
  await start($)
  await b.clock.advance(3000)
  // The terminal says it in the label (● / ○); the desktop in the control's drawing: a lit icon,
  // a lit word, each picture marked `on` or `off` at its root.
  const desktopState = (n: unknown) => {
    const drawing = JSON.stringify(n ?? '')
    return /<svg[^>]* class=\\"on\\"/.test(drawing) ? 'on' : /<svg[^>]* class=\\"off\\"/.test(drawing) ? 'off' : 'other'
  }
  const state = async (ui: Awaited<ReturnType<typeof band>>, key: string, surface: string) =>
    surface === 'desktop'
      ? desktopState(await ui.find({ type: 'Box', key: key === 'auto' ? 'word-on-auto' : 'hv-' + key }) ?? await ui.find({ type: 'Box', key: 'ghost-' + key }))
      : (n => /●/.test(String(n?.props.label)) ? 'on' : /○/.test(String(n?.props.label)) ? 'off' : 'other')(await ui.find({ type: 'Button', key }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    const drawn = async () => JSON.stringify(await ui.drawn()).replace(/"handle":\d+/g, '')
    for (const key of surface === 'terminal' ? ['auto', 'warm', 'log', 'agents'] : ['auto', 'warm', 'agents']) {
      const before = await state(ui, key, surface)
      expect(before, surface + ' ' + key).not.toBe('other')
      const tree = await drawn()
      await ui.press({ key })
      expect(await drawn(), surface + ' ' + key).not.toBe(tree)
      expect(await state(ui, key, surface), surface + ' ' + key).toBe(before === 'on' ? 'off' : 'on')
      await ui.press({ key })
      expect(await state(ui, key, surface), surface + ' ' + key + ' again').toBe(before)
    }
    // The effort opens its row of levels (the terminal's `e: Effort`, the desktop's level itself).
    expect(await ui.find({ key: 'pick-low' })).toBeUndefined()
    await ui.press({ key: 'effort' })
    expect(await ui.find({ type: 'Button', key: 'pick-low' }), surface).toBeDefined()
    await ui.press({ key: 'effort' })
    expect(await ui.find({ key: 'pick-low' })).toBeUndefined()
    if (surface === 'desktop') {
      // The route opens the log, shown as on at once.
      expect(await ui.find({ type: 'Text', text: 'gpt-6.1-sol' })).toBeDefined()
      await ui.press({ key: 'route' })
      expect(b.panes.has('ripple-log')).toBe(true)
      await ui.press({ key: 'route' })
      expect(b.panes.has('ripple-log')).toBe(false)
    }
    await ui.unmount()
  }
})

// 2026-10-14: the band's Clear icon asks before it runs /clear; Cancel leaves the chat alone.
test('the band Clear asks first, and confirming runs the clear once', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const commands: string[] = []
  on('command.run', { command: 'clear' }, () => { commands.push('clear'); return {} })
  await start($)
  const ui = await band($, 'desktop')
  expect(await ui.find({ key: 'clear' })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(commands).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Start this conversation over?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /context is emptied/ })).toBeDefined()
  // Cancel keeps the conversation and closes the card.
  await ui.press({ key: 'dismiss' })
  expect(commands).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Start this conversation over?' })).toBeUndefined()
  // The main action runs the clear once.
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'clear-go' })
  await b.clock.advance(3000)
  expect(commands).toEqual(['clear'])
  expect(await ui.find({ type: 'Text', text: 'Start this conversation over?' })).toBeUndefined()
  await ui.unmount()
})

// The phone inbox is a first-wins handoff, never a retry of a submitted prompt.
// Only the app's own CLI process polls it: the app sets this entrypoint, the host's runs do not.
const APP_ENV = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }
test('a session the app does not run never polls the phone inbox', async ($, on) => {
  const calls: string[] = []
  const b = boundaries(on, {}, { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } })
  on('http.fetch', { url: /\/api\/phone-inbox/ }, ($, e) => { calls.push(e.url); return { value: { ok: true, status: 200, headers: {}, text: '{"offers":[]}' } } })
  http(on)
  await start($)
  await b.clock.advance(4500)
  expect(calls).toEqual([])
})
for (const outcome of ['submitted', 'drop', 'throw', 'refused'] as const) test(`phone inbox ${outcome} claims before submitting and reports the outcome`, async ($, on) => {
  const events: string[] = []
  let offered = true
  const b = boundaries(on, {}, { env: APP_ENV, phoneSubmit: text => {
    events.push(`submit:${text}`)
    return outcome === 'refused' ? 'submitted' : outcome
  } })
  on('http.fetch', { url: /\/api\/phone-inbox/ }, ($, e) => {
    const url = new URL(e.url)
    if (url.pathname === '/api/phone-inbox') {
      events.push(`poll:${url.searchParams.get('session')}`)
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ offers: offered ? [{ sessionId: 'session-test', itemId: 'item-1', text: 'private message', offeredAt: NOW }] : [] }) } }
    }
    const body = JSON.parse(e.init?.body ?? '{}')
    if (url.pathname.endsWith('/claim')) {
      events.push(`claim:${body.itemId}`)
      offered = false
      return { value: { ok: outcome !== 'refused', status: outcome === 'refused' ? 409 : 200, headers: {}, text: '{}' } }
    }
    events.push(`result:${body.itemId}:${body.outcome}`)
    return { value: { ok: true, status: 200, headers: {}, text: '{}' } }
  })
  http(on)
  await start($)
  await b.clock.advance(1500)
  expect(events).toEqual(outcome === 'refused' ? ['poll:session-test', 'claim:item-1'] : ['poll:session-test', 'claim:item-1', 'submit:private message', `result:item-1:${outcome === 'submitted' ? 'submitted' : 'failed'}`])
  expect(b.logs.join('\n')).not.toContain('private message')
})

test('phone inbox handles offers in order and refuses a different session', async ($, on) => {
  const events: string[] = []
  const b = boundaries(on, {}, { env: APP_ENV, phoneSubmit: text => { events.push(`submit:${text}`); return 'submitted' } })
  let wrong = false
  on('http.fetch', { url: /\/api\/phone-inbox/ }, ($, e) => {
    const url = new URL(e.url)
    if (url.pathname === '/api/phone-inbox') return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ offers: wrong ? [{ sessionId: 'other', itemId: 'three', text: 'wrong' }] : [{ sessionId: 'session-test', itemId: 'one', text: 'first' }, { sessionId: 'session-test', itemId: 'two', text: 'second' }] }) } }
    const body = JSON.parse(e.init?.body ?? '{}')
    events.push(url.pathname.endsWith('/claim') ? `claim:${body.itemId}` : `result:${body.itemId}:${body.outcome}`)
    return { value: { ok: true, status: 200, headers: {}, text: '{}' } }
  })
  http(on)
  await start($)
  await b.clock.advance(1500)
  expect(events).toEqual(['claim:one', 'submit:first', 'result:one:submitted', 'claim:two', 'submit:second', 'result:two:submitted'])
  wrong = true
  await b.clock.advance(1500)
  expect(events).toHaveLength(6)
})

test('a claim response delayed past the safe window never submits the message', async ($, on) => {
  const b = boundaries(on, {}, { env: APP_ENV })
  const results: string[] = []
  on('http.fetch', { url: /\/api\/phone-inbox/ }, async ($, e) => {
    if (e.url.includes('?session=')) return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ offers: [{ sessionId: 'session-test', itemId: 'one', text: 'late' }] }) } }
    if (e.url.endsWith('/claim')) await b.clock.sleep(11_000)
    else results.push(JSON.parse(e.init?.body ?? '{}').outcome)
    return { value: { ok: true, status: 200, headers: {}, text: '{}' } }
  })
  http(on)
  await start($)
  await b.clock.advance(1500)
  await b.clock.advance(11_000)
  expect(b.submitted).toEqual([])
  expect(results).toEqual(['failed'])
})

test('phone inbox skips overlapping polls and backs off after a failed request', async ($, on) => {
  const b = boundaries(on, {}, { env: APP_ENV })
  let calls = 0
  let release: (() => void) | undefined
  on('http.fetch', { url: /\/api\/phone-inbox/ }, async () => {
    calls++
    if (calls === 1) await new Promise<void>(resolve => { release = resolve })
    if (calls === 1) return { value: { ok: false, status: 503, headers: {}, text: '{}' } }
    return { value: { ok: true, status: 200, headers: {}, text: '{"offers":[]}' } }
  })
  http(on)
  await start($)
  await b.clock.advance(1500)
  await b.clock.advance(4500)
  expect(calls).toBe(1)
  release!()
  await b.clock.settle()
  await b.clock.advance(13_500)
  expect(calls).toBe(1)
  await b.clock.advance(1500)
  expect(calls).toBe(2)
})

// Settings jobs use another app process, and only after the host grants its claim.
const SETTINGS_JOB = { jobId: 'job-1', appSessionId: 'local_target', cliSessionId: 'cli-target', model: 'opus', effort: 'high' }
function settingsMcp(on: On, events: string[], options: { mode?: () => string; failure?: 'isError' | 'throw'; missing?: boolean } = {}) {
  on('mcp.call', ($, e) => {
    expect(e.server).toBe('ccd_session_mgmt')
    if (e.tool === 'get_session') {
      events.push('self')
      expect(e.args).toEqual({ session_id: 'self' })
      if (options.missing) throw new Error('server unavailable')
      return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ sessionId: 'local_helper', permissionMode: options.mode?.() ?? 'bypassPermissions' }) }] } }
    }
    events.push(`${e.tool}:${JSON.stringify(e.args)}`)
    if (options.failure === 'throw') throw new Error('private session text')
    return { value: { isError: options.failure === 'isError', content: [{ type: 'text', text: options.failure ? 'private session text' : 'ok' }] } }
  })
}
function settingsHttp(on: On, events: string[], options: { status?: number; jobs?: unknown[] } = {}) {
  on('http.fetch', { url: /\/api\/settings-jobs/ }, ($, e) => {
    const url = new URL(e.url)
    if (url.pathname === '/api/settings-jobs') {
      events.push(`poll:${url.searchParams.get('exclude')}`)
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ jobs: options.jobs ?? [SETTINGS_JOB] }) } }
    }
    const body = JSON.parse(e.init?.body ?? '{}')
    if (url.pathname.endsWith('/claim')) {
      events.push(`claim:${body.jobId}:${body.helper}`)
      const status = options.status ?? 200
      return { value: { ok: status === 200, status, headers: {}, text: '{}' } }
    }
    events.push(`result:${body.jobId}:${body.outcome}:${body.detail ?? ''}`)
    return { value: { ok: true, status: 200, headers: {}, text: '{}' } }
  })
}

test('settings jobs are not polled outside an app process', async ($, on) => {
  const events: string[] = []
  const b = boundaries(on, {}, { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } })
  settingsMcp(on, events); settingsHttp(on, events); http(on)
  await start($); await b.clock.advance(6000)
  expect(events).toEqual([])
})

for (const mode of ['default', 'acceptEdits', 'plan', 'auto', '']) test(`settings jobs do not poll in ${mode || 'unknown'} permission mode`, async ($, on) => {
  const events: string[] = []
  const b = boundaries(on, {}, { env: APP_ENV })
  settingsMcp(on, events, { mode: () => mode }); settingsHttp(on, events); http(on)
  await start($); await b.clock.advance(6000)
  expect(events).toEqual(['self'])
})

test('settings jobs claim in order, use the target app id and report success', async ($, on) => {
  const events: string[] = []
  const b = boundaries(on, {}, { env: APP_ENV })
  settingsMcp(on, events)
  settingsHttp(on, events, { jobs: [SETTINGS_JOB, { ...SETTINGS_JOB, jobId: 'job-2', model: undefined }] }); http(on)
  await start($); await b.clock.advance(3000)
  expect(events).toEqual([
    'self', 'poll:local_helper', 'claim:job-1:local_helper', 'self',
    'set_session_model:{"session_id":"local_target","model":"opus"}', 'self',
    'set_session_effort:{"session_id":"local_target","effort":"high"}', 'result:job-1:applied:',
    'claim:job-2:local_helper', 'self', 'set_session_effort:{"session_id":"local_target","effort":"high"}', 'result:job-2:applied:',
  ])
})

for (const failure of ['isError', 'throw'] as const) test(`settings jobs report a ${failure} tool failure without logging private text`, async ($, on) => {
  const events: string[] = []
  const b = boundaries(on, {}, { env: APP_ENV })
  settingsMcp(on, events, { failure }); settingsHttp(on, events); http(on)
  await start($); await b.clock.advance(3000)
  expect(events).toEqual(['self', 'poll:local_helper', 'claim:job-1:local_helper', 'self', 'set_session_model:{"session_id":"local_target","model":"opus"}', 'result:job-1:failed:settings change failed'])
  expect(b.logs.join('\n')).not.toContain('private session text')
  await b.clock.advance(12_000)
  expect(events.filter(event => event.startsWith('claim:'))).toHaveLength(1)
})

test('the helper refreshes its permission mode after three minutes', async ($, on) => {
  const events: string[] = []
  let mode = 'default'
  const b = boundaries(on, {}, { env: APP_ENV })
  settingsMcp(on, events, { mode: () => mode }); settingsHttp(on, events, { jobs: [] }); http(on)
  await start($); await b.clock.advance(3000)
  mode = 'bypassPermissions'
  await b.clock.advance(177_000)
  expect(events).toEqual(['self'])
  await b.clock.advance(3000)
  expect(events).toEqual(['self', 'self', 'poll:local_helper'])
})

test('a malformed or self-targeted job is never claimed', async ($, on) => {
  const events: string[] = []
  const b = boundaries(on, {}, { env: APP_ENV })
  settingsMcp(on, events); settingsHttp(on, events, { jobs: [{ ...SETTINGS_JOB, appSessionId: 'local_helper' }] }); http(on)
  await start($); await b.clock.advance(3000)
  expect(events).toEqual(['self', 'poll:local_helper'])
})

test('settings job claim conflict never calls a setter', async ($, on) => {
  const events: string[] = []
  const b = boundaries(on, {}, { env: APP_ENV })
  settingsMcp(on, events); settingsHttp(on, events, { status: 409 }); http(on)
  await start($); await b.clock.advance(3000)
  expect(events).toEqual(['self', 'poll:local_helper', 'claim:job-1:local_helper'])
})

test('a changed helper permission after a claim fails the job without an approval', async ($, on) => {
  const events: string[] = []
  let reads = 0
  const b = boundaries(on, {}, { env: APP_ENV })
  settingsMcp(on, events, { mode: () => ++reads === 1 ? 'bypassPermissions' : 'default' }); settingsHttp(on, events); http(on)
  await start($); await b.clock.advance(3000)
  expect(events).toEqual(['self', 'poll:local_helper', 'claim:job-1:local_helper', 'self', 'result:job-1:failed:settings change failed'])
})

test('a missing session server backs off and never polls', async ($, on) => {
  const events: string[] = []
  const b = boundaries(on, {}, { env: APP_ENV })
  settingsMcp(on, events, { missing: true }); settingsHttp(on, events); http(on)
  await start($); await b.clock.advance(15_000)
  expect(events).toEqual(['self'])
  await b.clock.advance(3000)
  expect(events).toEqual(['self', 'self'])
})

test('settings jobs skip overlapping polls and back off after an HTTP failure', async ($, on) => {
  const events: string[] = []
  const b = boundaries(on, {}, { env: APP_ENV })
  let calls = 0
  let release: (() => void) | undefined
  settingsMcp(on, events)
  on('http.fetch', { url: /\/api\/settings-jobs/ }, async () => {
    calls++
    if (calls === 1) await new Promise<void>(resolve => { release = resolve })
    return { value: { ok: calls !== 1, status: calls === 1 ? 503 : 200, headers: {}, text: '{"jobs":[]}' } }
  })
  http(on)
  await start($); await b.clock.advance(3000); await b.clock.advance(6000)
  expect(calls).toBe(1)
  release!(); await b.clock.settle(); await b.clock.advance(12_000)
  expect(calls).toBe(1)
  await b.clock.advance(3000)
  expect(calls).toBe(2)
  expect(events).toEqual(['self', 'self'])
})

test('a late settings claim is failed without changing the target', async ($, on) => {
  const events: string[] = []
  const b = boundaries(on, {}, { env: APP_ENV })
  settingsMcp(on, events)
  on('http.fetch', { url: /\/api\/settings-jobs/ }, async ($, e) => {
    if (e.url.includes('?exclude=')) return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ jobs: [SETTINGS_JOB] }) } }
    if (e.url.endsWith('/claim')) await b.clock.sleep(26_000)
    else events.push(JSON.parse(e.init?.body ?? '{}').outcome)
    return { value: { ok: true, status: 200, headers: {}, text: '{}' } }
  })
  http(on)
  await start($); await b.clock.advance(3000); await b.clock.advance(26_000)
  expect(events).toEqual(['self', 'self', 'failed'])
})

// The host keeps what the phone queued (packages/remote/src/queue.ts); the band reads its file and
// floats a strip over itself while this chat has something waiting, then lets it go.
for (const surface of ['terminal', 'desktop'] as const) test(`the phone queue strip shows over the ${surface} band only while this chat has something queued`, async ($, on) => {
  const b = boundaries(on)
  http(on)
  const file = '/home/test/.clauderipple/remote/queue.json'
  b.files.set(file, JSON.stringify({ other: { items: [{ id: 'x', text: 'not this chat', attachments: [], at: 1 }], held: false } }))
  await start($)
  const ui = await band($, surface)
  await b.clock.advance(3000)
  expect(JSON.stringify(await ui.drawn())).not.toContain('Phone queue')
  b.files.set(file, JSON.stringify({ phone: { desktopId: 'session-test', items: [{ id: 'a', text: 'fix the header', attachments: [], at: 1 }, { id: 'b', text: 'then the footer', attachments: [], at: 2 }], held: false } }))
  await b.clock.advance(3000)
  const shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('Phone queue 2')
  expect(shown).toContain('fix the header')
  b.files.set(file, JSON.stringify({}))
  await b.clock.advance(3000)
  expect(JSON.stringify(await ui.drawn())).not.toContain('Phone queue')
  await ui.unmount()
})
