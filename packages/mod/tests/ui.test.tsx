// The drawings in hooks/ui, mounted through the engine on the terminal and the desktop.
//
// register.tsx does not draw them yet, so each test answers `ui.render` for a Pane of its own with
// the renderer under test (a test's own hooks may close over this file's imports; an inline
// plugin's may not). The engine validates every tree against the surface's element table, and
// presses reach the callbacks below, so these check both the trees and their wiring.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf } from 'claude-code'

import type { AgentRec, Settings, StatusRequest } from '../types'
import { renderAgents } from '../hooks/ui/agents'
import { renderAlert } from '../hooks/ui/alerts'
import { pack, renderBand, renderFooter } from '../hooks/ui/band'
import { renderLog } from '../hooks/ui/log'
import { renderSettings } from '../hooks/ui/settings'
import { renderSetup } from '../hooks/ui/setup'
import { countdown, modelName, routeOf, targetOf, targetValue } from '../hooks/ui/view'
import type { AlertView, DashboardView, Frame, SettingsTab, Surface } from '../hooks/ui/view'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-10T13:20:00')
const PRESSER = 'test'

function paneProps(columns: number, rows = 30): RenderPropsOf['Pane'] {
  return { title: 'ui', isFocused: true, bodyColumns: columns, placement: 'inline', scroll: { offset: 0, bodyRows: rows }, view: {} } as RenderPropsOf['Pane']
}

function frameOf(surface: Surface, columns = 140, maxRows = 12): Frame {
  return { surface, columns, maxRows, now: NOW, appearance: 'auto' }
}

/** Records which callback ran, with what. */
function recorder() {
  const calls: string[] = []
  const fn = (name: string) => (...args: unknown[]) => {
    calls.push(args.length ? name + ':' + JSON.stringify(args) : name)
  }
  return { calls, fn }
}

const DASH: DashboardView = {
  effort: { level: 'high', mode: 'auto', why: 'multi-file refactor' },
  model: 'Opus 5.5',
  context: { percent: 38, tokens: 76_000, window: 200_000 },
  cache: { expiresAt: NOW + 41 * 60_000, ttlMs: 3_600_000 },
  warm: { on: false, pings: 0, cost: 0 },
  limit: null,
  route: { model: 'gpt-6.1-sol', provider: 'chatgpt', ok: true, resent: false, status: '200', effort: 'high', cachePct: 96, seconds: 2.1 },
  notice: null,
  auto: true,
  handoff: 'off',
  agents: { live: 0, total: 0 },
  logOpen: false,
  agentsOpen: false,
  effortMenu: false,
  swampAt: 50,
  hide: [],
  isWorking: false,
}

const SETTINGS: Settings = {
  effortAuto: true,
  judge: 'jev',
  judgeModel: 'deepseek-v4.1-flash',
  bias: 0,
  floor: 'low',
  ceiling: 'max',
  agentAuto: 'auto',
  tiers: { light: { agent: 'deepseek-v4-1-flash' }, standard: { agent: 'gpt-6-1-sol' }, deep: { agent: 'gpt-6-astra' }, design: { agent: 'general-purpose', model: 'sonnet' } },
  fallback: { agent: 'general-purpose', model: 'sonnet' },
  keepWarm: false,
  keepWarmHours: 2,
  keepWarmMinTokens: 30_000,
  compactWith: 'haiku',
  handoffSkill: '',
  handoffAfter: 'continue',
  handoffButton: 'advised',
  swampAt: 50,
  layout: 'dashboard',
  appearance: 'auto',
  hide: [],
  setupDone: false,
}

const AGENT_OPTIONS = [
  { value: 'deepseek-v4-1-flash', label: 'deepseek-v4-1-flash', available: true },
  { value: 'gpt-6-1-sol', label: 'gpt-6-1-sol', available: true },
  { value: 'gpt-6-astra', label: 'gpt-6-astra', available: false },
  { value: 'general-purpose+sonnet', label: 'Claude Sonnet', available: true },
]

type Draw = (el: Parameters<typeof renderBand>[0], surface: Surface) => ReturnType<typeof renderBand>

/** Answers ui.render for the Pane `id` with `draw`. */
function drawPane(on: On, id: string, draw: Draw) {
  on('ui.render', { component: 'Pane', requestId: id }, ($, e) => draw($.ui.resolve(e), e.surface) as RenderElement)
}

function mount($: Engine, id: string, surface: (typeof SURFACES)[number], columns = 140) {
  return $.ui.mount({ plugin: PRESSER, surface, component: 'Pane', requestId: id, props: paneProps(columns), viewport: { columns, rows: 40 } })
}

// ---- Pure helpers ------------------------------------------------------------------------------

test('view helpers', () => {
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelName('sonnet')).toBe('Sonnet')
  expect(modelName('gpt-6.1-sol')).toBe('gpt-6.1-sol')
  expect(countdown(41 * 60_000)).toBe('41m')
  expect(countdown(105_000)).toBe('1:45')
  expect(countdown(0)).toBe('cold')
  expect(targetOf(targetValue({ agent: 'general-purpose', model: 'sonnet' }))).toEqual({ agent: 'general-purpose', model: 'sonnet' })
  expect(targetOf('gpt-6-1-sol')).toEqual({ agent: 'gpt-6-1-sol' })
  const record: StatusRequest = { at: '2026-10-10T13:19:10', source: 'gpt-6-1-sol@high', target: 'gpt-6.1-sol', provider: 'chatgpt', status: 200, ok: true, ms: 2140, usage: { input: 3000, cached: 41_000, output: 900 } }
  expect(routeOf(record)).toMatchObject({ model: 'gpt-6.1-sol (gpt-6-1-sol)', cachePct: 93, seconds: 2.14 })
  expect(pack([5, 5, 5, 5], n => n, 12, 2)).toEqual([[5, 5], [5, 5]])
})

// ---- Band --------------------------------------------------------------------------------------

test('the band draws on both surfaces and its controls reach their callbacks', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = {
    toggleAuto: fn('auto'), toggleWarm: fn('warm'), compact: fn('compact'), handoff: fn('handoff'), toggleLog: fn('log'),
    toggleAgents: fn('agents'), openSettings: fn('settings'), toggleEffortMenu: fn('menu'), pickEffort: fn('pick'),
  }
  drawPane(on, 'band', (el, surface) => renderBand(el, frameOf(surface), DASH, actions))
  drawPane(on, 'band-busy', (el, surface) =>
    renderBand(el, frameOf(surface), { ...DASH, effort: { level: null, mode: 'deciding', since: NOW - 500 }, warm: { on: true, pings: 2, cost: 9000 }, limit: { kind: 'five_hour', percent: 86, resetsAt: '2026-10-10T15:40:00', save: true }, handoff: 'advised', agents: { live: 2, total: 3 }, effortMenu: true }, actions),
  )
  for (const surface of SURFACES) {
    const ui = await mount($, 'band', surface)
    for (const key of ['auto', 'warm', 'compact', 'log', 'agents', 'settings']) {
      expect(await ui.find({ type: 'Button', key }), "ui { type: 'Button', key } " + surface).toBeDefined()
      await ui.press({ key })
    }
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      expect((await ui.find({ key: 'auto' }))?.props.hotkey).toBe('a')
      expect(await ui.find({ type: 'Text', text: 'gpt-6.1-sol' }), "ui { type: 'Text', text: 'gpt-6.1-sol' } " + surface).toBeDefined()
    } else {
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.length > 5).toBe(true)
      for (const svg of svgs) {
        expect(typeof svg.props.alt).toBe('string')
        expect(typeof svg.props.width).toBe('number')
        expect(typeof svg.props.height).toBe('number')
        expect((svg.props.source as string).length < 131_072).toBe(true)
      }
      // The route chip opens the log too.
      await ui.press({ key: 'route' })
    }
    await ui.unmount()

    const busy = await mount($, 'band-busy', surface)
    expect(await busy.find({ key: 'handoff' }), "busy { key: 'handoff' } " + surface).toBeDefined()
    expect(await busy.find({ key: 'compact' })).toBeUndefined()
    await busy.press({ key: 'handoff' })
    await busy.press({ key: 'pick-low' })
    if (surface === 'desktop') {
      const alts = (await busy.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt))
      expect(alts.some(alt => alt.startsWith('Effort Deciding'))).toBe(true)
      expect(alts.some(alt => alt.includes('keep warm on'))).toBe(true)
    } else {
      expect(await busy.find({ type: 'Text', text: /deciding/ }), "busy { type: 'Text', text: /deciding/ } " + surface).toBeDefined()
    }
    await busy.unmount()
  }
  expect(calls.filter(c => c === 'auto').length).toBe(2)
  expect(calls.filter(c => c === 'log').length).toBe(3)
  expect(calls.filter(c => c === 'pick:["low"]').length).toBe(2)
  expect(calls.filter(c => c === 'handoff').length).toBe(2)
})

test('the band draws the same markup for the same view', async ($, on) => {
  const noop = () => undefined
  const actions = { toggleAuto: noop, toggleWarm: noop, compact: noop, handoff: noop, toggleLog: noop, toggleAgents: noop, openSettings: noop, toggleEffortMenu: noop, pickEffort: noop }
  drawPane(on, 'band', (el, surface) => renderBand(el, frameOf(surface), { ...DASH, effort: { level: 'medium', mode: 'deciding', since: NOW - 300 } }, actions))
  const once = await mount($, 'band', 'desktop')
  const first = JSON.stringify(await once.drawn())
  await once.unmount()
  const second = JSON.stringify(await (await mount($, 'band', 'desktop')).drawn())
  expect(first.replace(/"handle":\d+/g, '')).toBe(second.replace(/"handle":\d+/g, ''))
})

test('the terminal band fits its rows at narrow widths', async ($, on) => {
  const noop = () => undefined
  const actions = { toggleAuto: noop, toggleWarm: noop, compact: noop, handoff: noop, toggleLog: noop, toggleAgents: noop, openSettings: noop, toggleEffortMenu: noop, pickEffort: noop }
  const busy: DashboardView = { ...DASH, warm: { on: true, pings: 3, cost: 0 }, limit: { kind: 'seven_day', percent: 91, save: false } }
  drawPane(on, 'wide', el => renderBand(el, frameOf('terminal', 200, 3), busy, actions))
  drawPane(on, 'narrow', el => renderBand(el, frameOf('terminal', 60, 4), busy, actions))
  const wide = (await (await mount($, 'wide', 'terminal', 200)).drawn()) as { children: unknown[] }
  const narrow = (await (await mount($, 'narrow', 'terminal', 60)).drawn()) as { children: unknown[] }
  expect(wide.children.length <= 3).toBe(true)
  expect(narrow.children.length <= 4).toBe(true)
})

test('the minimal footer draws on both surfaces', async ($, on) => {
  const { calls, fn } = recorder()
  drawPane(on, 'footer', (el, surface) => renderFooter(el, frameOf(surface), DASH, { toggleAuto: fn('auto'), openSettings: fn('settings') }, 'focus'))
  for (const surface of SURFACES) {
    const ui = await mount($, 'footer', surface)
    expect(await ui.find({ type: 'Text', text: /high/ }), "ui { type: 'Text', text: /high/ } " + surface).toBeDefined()
    await ui.press({ key: 'settings' })
  }
  expect(calls).toEqual(['settings', 'settings'])
})

// ---- Alerts ------------------------------------------------------------------------------------

const ALERTS: AlertView[] = [
  { kind: 'cold', tokens: 182_000, idleMinutes: 74 },
  { kind: 'swamp', percent: 63, tokens: 126_000 },
  { kind: 'hot', limitKind: 'five_hour', percent: 86, resetsAt: '2026-10-10T15:40:00', save: false },
  { kind: 'judgeDown', judge: 'jev', reason: 'key rejected (401)' },
  { kind: 'result', stage: 'handingOff', handoffKind: 'quick' },
  { kind: 'result', stage: 'handoffDone' },
  { kind: 'result', stage: 'compacting' },
  { kind: 'result', stage: 'compacted' },
  { kind: 'result', stage: 'failed', detail: 'Haiku timed out' },
  { kind: 'compactNote', draft: '' },
  { kind: 'handoffChoice', handoffKind: 'quick', after: 'continue' },
]

test('every alert draws on both surfaces', async ($, on) => {
  const noop = () => undefined
  const actions = { compact: noop, handoff: noop, dismiss: noop, toggleSave: noop, openSettings: noop, noteInput: noop, setHandoffKind: noop, setHandoffAfter: noop, go: noop, copy: noop }
  ALERTS.forEach((alert, i) => drawPane(on, 'alert-' + i, (el, surface) => renderAlert(el, frameOf(surface), alert, actions)))
  for (const surface of SURFACES) {
    for (let i = 0; i < ALERTS.length; i++) {
      const ui = await mount($, 'alert-' + i, surface)
      expect(await ui.drawn()).toBeDefined()
      await ui.unmount()
    }
  }
})

test('alert choices reach their callbacks', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = {
    compact: fn('compact'), handoff: fn('handoff'), dismiss: fn('dismiss'), toggleSave: fn('save'), openSettings: fn('settings'), noteInput: fn('note'),
    setHandoffKind: fn('kind'), setHandoffAfter: fn('after'), go: fn('go'), copy: fn('copy'),
  }
  drawPane(on, 'cold', (el, surface) => renderAlert(el, frameOf(surface), ALERTS[0]!, actions))
  drawPane(on, 'hot', (el, surface) => renderAlert(el, frameOf(surface), ALERTS[2]!, actions))
  drawPane(on, 'note', (el, surface) => renderAlert(el, frameOf(surface), { kind: 'compactNote', draft: '' }, actions))
  drawPane(on, 'choice', (el, surface) => renderAlert(el, frameOf(surface), ALERTS[10]!, actions))
  for (const surface of SURFACES) {
    const cold = await mount($, 'cold', surface)
    await cold.press({ key: 'compact' })
    await cold.press({ key: 'handoff' })
    await cold.press({ key: 'dismiss' })
    const hot = await mount($, 'hot', surface)
    await hot.press({ key: 'save' })
    const note = await mount($, 'note', surface)
    await note.input({ key: 'note', text: 'keep the API decision' })
    const choice = await mount($, 'choice', surface)
    await choice.press({ key: 'kind-full' })
    await choice.press({ key: 'after-copy' })
    await choice.press({ key: 'go' })
  }
  const once = ['compact', 'handoff', 'dismiss', 'save', 'compact:["keep the API decision"]', 'kind:["full"]', 'after:["copy"]', 'go']
  expect(calls).toEqual([...once, ...once])
})

// ---- Settings and setup ------------------------------------------------------------------------

const TABS: SettingsTab[] = ['effort', 'workers', 'judge', 'cache', 'handoff', 'look']

test('every settings card draws on both surfaces, with the notice', async ($, on) => {
  const noop = () => undefined
  const actions = { setTab: noop, patch: noop, setTier: noop, setFallback: noop, jevKey: noop, testJev: noop, save: noop, close: noop }
  for (const tab of TABS) {
    for (const judge of tab === 'judge' ? (['haiku', 'jev', 'model'] as const) : (['haiku'] as const)) {
      drawPane(on, 'settings-' + tab + '-' + judge, (el, surface) =>
        renderSettings(el, frameOf(surface, 120, 14), { tab, draft: { ...SETTINGS, judge }, dirty: false, agents: AGENT_OPTIONS, routerModels: ['deepseek-v4.1-flash'], skills: ['handoff'], jev: { source: 'file', test: { state: 'ok' } } }, actions),
      )
    }
  }
  for (const surface of SURFACES) {
    for (const tab of TABS) {
      for (const judge of tab === 'judge' ? ['haiku', 'jev', 'model'] : ['haiku']) {
        const ui = await mount($, 'settings-' + tab + '-' + judge, surface)
        expect(await ui.find({ type: 'Text', text: 'not affiliated with Anthropic' }), "ui { type: 'Text', text: 'not affiliated with Anthropic' } " + surface).toBeDefined()
        expect(await ui.find({ key: 'save' }), "ui { key: 'save' } " + surface).toBeDefined()
        await ui.unmount()
      }
    }
  }
})

test('settings controls reach their callbacks', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { setTab: fn('tab'), patch: fn('patch'), setTier: fn('tier'), setFallback: fn('fallback'), jevKey: fn('key'), testJev: fn('test'), save: fn('save'), close: fn('close') }
  const view = (tab: SettingsTab) => ({ tab, draft: SETTINGS, dirty: true, agents: AGENT_OPTIONS, routerModels: [], skills: [], jev: { source: null, test: { state: 'idle' as const } } })
  drawPane(on, 'effort', (el, surface) => renderSettings(el, frameOf(surface), view('effort'), actions))
  drawPane(on, 'workers', (el, surface) => renderSettings(el, frameOf(surface), view('workers'), actions))
  drawPane(on, 'judge', (el, surface) => renderSettings(el, frameOf(surface), view('judge'), actions))
  for (const surface of SURFACES) {
    const effort = await mount($, 'effort', surface)
    await effort.press({ key: 'tab-cache' })
    await effort.press({ key: surface === 'desktop' ? 'bias-2' : 'bias-2' })
    await effort.select({ key: 'floor', value: 'medium' })
    await effort.press({ key: 'save' })
    await effort.press({ key: 'close' })
    const workers = await mount($, 'workers', surface)
    await workers.select({ key: 'tier-design', value: 'gpt-6-1-sol' })
    await workers.press({ key: 'agent-auto-all' })
    const judge = await mount($, 'judge', surface)
    await judge.input({ key: 'jev-key', text: 'ts-key' })
    await judge.press({ key: 'jev-test' })
  }
  const once = [
    'tab:["cache"]',
    'patch:[{"bias":2}]',
    'patch:[{"floor":"medium"}]',
    'save',
    'close',
    'tier:["design",{"agent":"gpt-6-1-sol"}]',
    'patch:[{"agentAuto":"all"}]',
    'key:["ts-key"]',
    'test',
  ]
  expect(calls).toEqual([...once, ...once])
})

test('setup steps draw on both surfaces and move on', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { patch: fn('patch'), setTier: fn('tier'), jevKey: fn('key'), testJev: fn('test'), back: fn('back'), next: fn('next'), finish: fn('finish'), skip: fn('skip') }
  for (const step of [1, 2, 3, 4] as const) {
    drawPane(on, 'setup-' + step, (el, surface) =>
      renderSetup(el, frameOf(surface), { step, draft: SETTINGS, agents: AGENT_OPTIONS, routerModels: [], jev: { source: 'env', test: { state: 'idle' } } }, actions),
    )
  }
  for (const surface of SURFACES) {
    await (await mount($, 'setup-1', surface)).press({ key: 'next' })
    await (await mount($, 'setup-2', surface)).press({ key: 'back' })
    await (await mount($, 'setup-3', surface)).press({ key: 'set-warm' })
    const done = await mount($, 'setup-4', surface)
    expect(await done.find({ type: 'Text', text: /Light → deepseek-v4-1-flash/ }), "done { type: 'Text', text: /Light → deepseek-v4-1-flash/ } " + surface).toBeDefined()
    await done.press({ key: 'finish' })
  }
  const once = ['next', 'back', 'patch:[{"keepWarm":true}]', 'finish']
  expect(calls).toEqual([...once, ...once])
})

// ---- Panes -------------------------------------------------------------------------------------

const AGENTS: AgentRec[] = [
  {
    id: 'a1',
    description: 'Port the request log renderer',
    type: 'gpt-6-1-sol',
    model: 'gpt-6.1-sol@high',
    pick: { tier: 'standard', effort: 'high', sure: 0.8, why: 'designed refactor', target: { agent: 'gpt-6-1-sol' }, by: 'haiku', ms: 900 },
    state: 'running',
    now: 'Edit hooks/ui/log.tsx',
    toolSince: NOW - 14_000,
    startedAt: NOW - 192_000,
    cost: 38_400,
  },
  { id: 'a2', description: 'Summarize the docs', type: 'deepseek-v4-1-flash', state: 'done', startedAt: NOW - 900_000, endedAt: NOW - 800_000, cost: 9000 },
]

test('the Agents pane draws live, finished and empty', async ($, on) => {
  const { calls, fn } = recorder()
  drawPane(on, 'agents', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: AGENTS, now: NOW, showDone: false }, { toggleDone: fn('done') }))
  drawPane(on, 'agents-open', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: AGENTS, now: NOW, showDone: true }, { toggleDone: fn('done') }))
  drawPane(on, 'agents-empty', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: [], now: NOW, showDone: false }, { toggleDone: fn('done') }))
  for (const surface of SURFACES) {
    const ui = await mount($, 'agents', surface, 64)
    expect(await ui.find({ type: 'Text', text: 'Port the request log renderer' }), "ui { type: 'Text', text: 'Port the request log renderer' } " + surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Edit hooks\/ui\/log.tsx/ }), "ui { type: 'Text', text: /Edit hooks\/ui\/log.tsx/ } " + surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Summarize the docs' })).toBeUndefined()
    await ui.press({ key: 'done' })
    const open = await mount($, 'agents-open', surface, 64)
    expect(await open.find({ type: 'Text', text: 'Summarize the docs' }), "open { type: 'Text', text: 'Summarize the docs' } " + surface).toBeDefined()
    const empty = await mount($, 'agents-empty', surface, 64)
    expect(await empty.find({ type: 'Text', text: 'No agents yet' }), "empty { type: 'Text', text: 'No agents yet' } " + surface).toBeDefined()
  }
  expect(calls).toEqual(['done', 'done'])
})

test('the log pane keeps its content', async ($, on) => {
  const { calls, fn } = recorder()
  const rows: StatusRequest[] = [
    { at: '2026-10-10T13:19:10', source: 'gpt-6-1-sol@high', target: 'gpt-6.1-sol', provider: 'chatgpt', status: 200, ok: true, ms: 2140, effort: 'high', usage: { input: 3000, cached: 41_000, output: 900 }, mine: true },
    { at: '2026-10-10T13:18:55', source: 'deepseek-v4.1-flash', target: 'deepseek-v4.1-flash', provider: 'opencode-go', status: 429, ok: false, ms: 310, note: 'rate limited', mine: false },
  ]
  drawPane(on, 'log', (el, surface) => renderLog(el, frameOf(surface, 64), { rows, mineOnly: false }, { toggleScope: fn('scope') }))
  drawPane(on, 'log-empty', (el, surface) => renderLog(el, frameOf(surface, 64), { rows: [], mineOnly: true }, { toggleScope: fn('scope') }))
  for (const surface of SURFACES) {
    const ui = await mount($, 'log', surface, 64)
    expect(await ui.find({ type: 'Text', text: 'gpt-6.1-sol (gpt-6-1-sol)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'cache 93%' }), "ui { type: 'Text', text: 'cache 93%' } " + surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'in 44.0k' }), "ui { type: 'Text', text: 'in 44.0k' } " + surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✕ 429' }), "ui { type: 'Text', text: '✕ 429' } " + surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'rate limited' }), "ui { type: 'Text', text: 'rate limited' } " + surface).toBeDefined()
    await ui.press({ key: 'scope' })
    const empty = await mount($, 'log-empty', surface, 64)
    expect(await empty.find({ type: 'Text', text: 'No model requests yet.' }), "empty { type: 'Text', text: 'No model requests yet.' } " + surface).toBeDefined()
  }
  expect(calls).toEqual(['scope', 'scope'])
})
