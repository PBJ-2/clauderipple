// Integration through the actual mods engine. Only external host boundaries are stubbed.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, ModelCompleteInput, ModelUsage, On, SessionMessage, ToolCallInput, TurnStepInput } from 'claude-code'
import { normalizeSettings } from '../hooks/settings'
import type { Settings } from '../types'

const NOW = 1000000
const USAGE: ModelUsage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 }
const FILES: Record<string, string> = {
  'deepseek-v4-1-flash': '---\nname: deepseek-v4-1-flash\ndescription: Executor via deepseek.\nmodel: deepseek-v4.1-flash@medium\n---\nExecute.',
  'gpt-6-1-sol': '---\nname: gpt-6-1-sol\ndescription: Executor via chatgpt.\nmodel: gpt-6.1-sol@medium\n---\nExecute.',
  'gpt-6-astra': '---\nname: gpt-6-astra\ndescription: Executor via chatgpt.\nmodel: gpt-6-astra@high\n---\nExecute.',
}
const SPAWN: AgentSpawnInput = { tool_use_id: 'tool1', subagentType: 'ripple:auto', prompt: 'Rename one local variable and verify it.', description: 'Rename variable', parentModel: 'claude-opus-5-5', provider: { plugin: 'engine', tier: 'core' }, background: false, fork: false }
const MESSAGES: SessionMessage[] = [{ role: 'user', text: 'Implement the specified change and verify it.', toolUses: [] }, { role: 'assistant', text: 'The implementation is ready.', toolUses: [] }]

function boundaries(on: On, patch: Partial<Settings> = {}, options: { key?: string; envFile?: string; limits?: { kind: string; percentUsed: number; resetsAt?: string }[] } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>([['settings', normalizeSettings({ setupDone: true, ...patch })]])
  const toasts: string[] = []
  const logs: string[] = []
  const submitted: string[] = []
  const filled: string[] = []
  const panes = new Set<string>()
  let model = 'claude-opus-5-5'
  let percent = 20
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => { saved.set(e.key, e.value); return { value: undefined } })
  mock.env(on, { HOME: '/home/test', ...(options.key ? { TYPESAFE_API_KEY: options.key } : {}) })
  on('fs.read', ($, e) => {
    if (e.path.endsWith('generated-agents.json')) return { value: JSON.stringify({ agents: Object.keys(FILES) }) }
    if (e.path.endsWith('config.json')) return { value: JSON.stringify({ admin: { port: 9992 } }) }
    if (e.path.endsWith('/.config/jev/.env')) return { value: options.envFile ?? '' }
    const name = e.path.split('/').pop()?.replace(/\.md$/, '') ?? ''
    return { value: FILES[name] ?? '' }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.SessionStart', () => ({}))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.register', () => ({ value: { agent: 'ripple:auto' } }))
  on('command.list', () => ({ value: [{ name: 'clear', description: 'Clear', source: 'builtin' }, { name: 'compact', description: 'Compact', source: 'builtin' }, { name: 'model', description: 'Model', source: 'builtin' }] }))
  on('session.id', () => ({ value: 'session-test' }))
  on('session.model', () => ({ value: model }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { percent, tokens: 40000, window: 200000 }, rateLimits: options.limits ?? [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', ($, e) => { panes.add(e.id); return { value: { isPlaced: true } } })
  on('ui.close', ($, e) => { panes.delete(e.id); return { value: undefined } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['host drawing'] }))
  on('prompt.submit', ($, e) => { submitted.push(e.text); return { text: e.text } })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true } })
  return { clock, saved, toasts, logs, panes, submitted, filled, setModel: (id: string) => { model = id }, setPercent: (value: number) => { percent = value } }
}
function http(on: On, exhausted = false) {
  const urls: string[] = []
  on('http.fetch', ($, e) => {
    urls.push(e.url)
    const body = e.url.endsWith('/api/status') ? { chatgpt: { accounts: { chatgpt: [{ state: 'ready', quota: { rate_limits: { primary: { used_percent: exhausted ? 100 : 20 } } } }] } } } : { requests: [] }
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(body) } }
  })
  return urls
}
function judgeStub(on: On, text = '{"tier":"light","effort":"low","sure":0.9,"why":"small rename"}') {
  const calls: ModelCompleteInput[] = []
  on('model.complete', ($, e) => { calls.push(e); return { value: { isAnswered: true, text, usage: USAGE } } })
  return calls
}
function spawnStub(on: On) {
  const sent: AgentSpawnInput[] = []
  on('agent.spawn', ($, e) => { sent.push(e); return { model: e.model ?? 'sonnet', agentId: 'worker-1' } })
  return sent
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

test('ripple:auto is judged and rewritten to the light agent with @effort', async ($, on) => {
  const b = boundaries(on)
  const urls = http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const result = await $.agent.spawn(SPAWN)
  expect(result.agentId).toBe('worker-1')
  expect(sent[0]).toMatchObject({ subagentType: 'deepseek-v4-1-flash', model: 'deepseek-v4.1-flash@low' })
  expect(judges[0]?.model).toBe('claude-haiku-5-5')
  expect(urls).toContain('http://127.0.0.1:9992/api/status')
  expect(b.logs).toEqual([])
  const stats = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(stats.text).toContain('light 1')
})

test('ChatGPT exhaustion selects the configured fallback and explains it in a toast', async ($, on) => {
  const b = boundaries(on, { fallback: { agent: 'general-purpose', model: 'opus' } })
  http(on, true)
  judgeStub(on, '{"tier":"standard","effort":"high","why":"implementation"}')
  const sent = spawnStub(on)
  const steps = stepStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  expect(sent[0]).toMatchObject({ subagentType: 'general-purpose', model: 'opus' })
  expect(b.toasts.some(t => t.includes('ChatGPT') && t.includes('fallback') === false)).toBe(true)
  await step($, 'claude-opus-5-5', 'low', 'worker-1')
  expect(steps[0]?.effort).toBe('high')
})

test('explicit generated worker preserves the old dropped-model and misplaced-marker fix', async ($, on) => {
  const b = boundaries(on)
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

test('an explicit marker on ripple:auto bypasses its judge', async ($, on) => {
  boundaries(on)
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-1-sol@xhigh]]\nReview this.' })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@xhigh' })
})

test('failed worker judge uses standard/high; unavailable fallback still reaches Sonnet', async ($, on) => {
  boundaries(on, { fallback: { agent: 'missing-worker' } })
  http(on, true)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }))
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  expect(sent[0]).toMatchObject({ subagentType: 'general-purpose', model: 'sonnet' })
  const debug = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'debug' })
  expect(debug.text).toContain('"effort": "high"')
  expect(debug.text).toContain('"by": "default"')
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
  expect(b.saved.get('settings')).toMatchObject({ effortAuto: false })
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

test('/ripple stats returns plain measured text', async ($, on) => {
  boundaries(on)
  const out = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(out.text).toContain('Auto: 0 prompts, 0 requests; 0 weighted tokens')
  expect(out.text).toContain('Workers: light 0, standard 0, deep 0, design 0')
})

test('settings draft saves only on Save, and the dashboard title remains ClaudeRipple', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'ClaudeRipple' })).toBeDefined()
  await ui.press({ key: 'settings' })
  await ui.select({ key: 'floor', value: 'medium' })
  expect(b.saved.get('settings')).toMatchObject({ floor: 'low' })
  await ui.press({ key: 'save' })
  expect(b.saved.get('settings')).toMatchObject({ floor: 'medium' })
  await ui.press({ key: 'hide' })
  expect(b.saved.get('bandHidden')).toBe(true)
  await $.command.run({ command: 'ripple-bar', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: '' })
  expect(b.saved.get('bandHidden')).toBe(false)
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

test('clear reloads store settings and resume restores cache age', async ($, on) => {
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

test('Jev low confidence falls back to Haiku and sends the key only to TypeSafe', async ($, on) => {
  boundaries(on, { judge: 'jev' }, { key: 'test-secret' })
  const judges = judgeStub(on, '{"effort":"high","why":"fallback"}')
  const sent = stepStub(on)
  const destinations: string[] = []
  on('http.fetch', ($, e) => {
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
  expect(judges.length).toBe(1)
  expect(sent[0]?.effort).toBe('high')
  expect(destinations).toEqual(['https://api.typesafe.ai/v1/systemone'])
})

test('Jev times out at three seconds without blocking the person prompt', async ($, on) => {
  const b = boundaries(on, { judge: 'jev' }, { key: 'test-secret' })
  const judges = judgeStub(on, '{"effort":"medium","why":"fallback"}')
  on('http.fetch', async ($, e) => {
    if (e.url.includes('typesafe.ai')) await b.clock.sleep(6000)
    return { value: { ok: true, status: 200, headers: {}, text: '{"requests":[]}' } }
  })
  await start($)
  const pending = submit($)
  await b.clock.settle()
  await b.clock.advance(3000)
  const out = await pending
  expect(out.text).toContain('Implement')
  expect(judges.length).toBe(1)
  expect(b.toasts.some(t => t.includes('timed out'))).toBe(true)
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
  boundaries(on, { judge: 'jev' }, { envFile: 'OTHER=keep\nTYPESAFE_API_KEY=old\nTAIL=yes\n' })
  http(on)
  let written = ''
  let path = ''
  let argv: readonly string[] = []
  on('fs.write', ($, e) => { written = e.text; path = e.path; return { value: undefined } })
  on('process.run', ($, e) => { argv = e.argv; return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'tab-judge' })
  await ui.input({ key: 'jev-key', text: 'new-$&-$$-key' })
  expect(written).toBe('OTHER=keep\nTYPESAFE_API_KEY=new-$&-$$-key\nTAIL=yes\n')
  expect(path).toBe('/home/test/.config/jev/.env')
  expect(argv).toEqual(['chmod', '600', path])
})

test('Jev Test displays latency/result from the selected judge', async ($, on) => {
  boundaries(on, { judge: 'jev' }, { key: 'test-secret' })
  on('http.fetch', ($, e) => ({ value: { ok: true, status: 200, headers: {}, text: e.url.includes('typesafe.ai') ? '{"answers":{"effort":{"choice":"low","confidence":0.9}}}' : '{"requests":[]}' } }))
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'tab-judge' })
  await ui.press({ key: 'jev-test' })
  expect(await ui.find({ type: 'Text', text: /0 ms · low · jev/ })).toBeDefined()
})

test('known agents show waiting after an eight-second tool and finish with cost', async ($, on) => {
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
  expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeDefined()
  await b.clock.advance(15000)
  await tool
  await complete($, 'worker-1')
  await ui.press({ key: 'done' })
  expect(await ui.find({ type: 'Text', text: 'Rename variable' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /≈4/ })).toBeDefined()
})

test('full handoff uses configured skill, captures its answer and clears before confirm', async ($, on) => {
  const b = boundaries(on, { handoffSkill: 'custom-handoff', handoffAfter: 'confirm' })
  http(on)
  const commands: string[] = []
  on('command.run', { command: 'custom-handoff' }, () => { commands.push('skill'); return {} })
  on('command.run', { command: 'clear' }, async () => { commands.push('clear'); await $.classic.SessionStart({ source: 'clear' }); return {} })
  await start($)
  await command($, 'handoff full')
  await b.clock.advance(15000)
  expect(commands).toEqual(['skill'])
  await complete($, undefined, 'Saved /work/HANDOFF.md; verify the pending tests.')
  await b.clock.advance(15000)
  expect(commands).toEqual(['skill', 'clear'])
  expect(b.submitted[0]).toContain('First read the saved handoff files')
  expect(b.submitted[0]).toContain('wait for my confirmation')
})

test('failed quick fork uses an ordinary summary turn and copy falls back to prompt fill', async ($, on) => {
  const b = boundaries(on, { handoffAfter: 'copy' })
  http(on)
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } }))
  await start($)
  await command($, 'handoff')
  await b.clock.advance(15000)
  expect(b.submitted[0]).toContain('Prepare a concise resume note')
  await complete($, undefined, 'The pending work is in /work.')
  await b.clock.advance(15000)
  expect(b.filled[0]).toContain('The pending work is in /work.')
  expect(b.toasts.some(t => t.includes('clipboard unavailable'))).toBe(true)
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
  expect(b.saved.get('settings')).toMatchObject({ setupDone: true, keepWarm: true })
  expect(b.saved.get('setupDone')).toBe(true)
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
  await ui.select({ key: 'floor', value: 'medium' })
  await ui.press({ key: 'save' })
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
  const b = boundaries(on, { handoffAfter: 'copy' })
  http(on)
  stepStub(on)
  on('model.fork', async () => {
    await step($)
    await step($)
    return { value: { isAnswered: true, text: 'Resume the verified work.', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 80000, cache_creation_input_tokens: 0 } } }
  })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  await start($)
  await command($, 'handoff')
  await b.clock.advance(15000)
  const out = await command($, 'stats')
  expect(out.text).toContain('Auto: 0 prompts, 0 requests')
  expect(out.text).toContain('Warm: 1 pings, 8300 weighted tokens')
})

test('handoff advice counts eligible prompts, not short followups', async ($, on) => {
  const b = boundaries(on, { effortAuto: false })
  b.setPercent(35)
  http(on)
  const calls = judgeStub(on, '{"handoff":"A different task starts now"}')
  await start($)
  await b.clock.advance(1)
  await submit($)
  await complete($)
  await submit($, 'go')
  await complete($)
  await b.clock.advance(15000)
  expect(calls.length).toBe(0)
  await submit($, 'Start the separate implementation task next.')
  await complete($)
  await b.clock.advance(15000)
  expect(calls.length).toBe(1)
  const ui = await band($)
  expect(await ui.find({ key: 'handoff' })).toBeDefined()
})

test('quick handoff runs on the timer and copies without clearing', async ($, on) => {
  const b = boundaries(on, { handoffAfter: 'copy' })
  http(on)
  let copied = ''
  let forks = 0
  on('model.fork', () => { forks++; return { value: { isAnswered: true, text: 'Pending: verify the changed files.', usage: USAGE } } })
  on('ui.copy', ($, e) => { copied = e.text; return { value: { isCopied: true } } })
  await start($)
  await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'handoff' })
  expect(forks).toBe(0)
  await b.clock.advance(15000)
  expect(forks).toBe(1)
  expect(copied).toContain('Pending: verify the changed files.')
  expect(copied).toContain('Continue with the justified next action')
})
