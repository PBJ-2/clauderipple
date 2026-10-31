// The drawings in hooks/ui, mounted through the engine on the terminal and the desktop.
//
// register.tsx does not draw them yet, so each test answers `ui.render` for a Pane of its own with
// the renderer under test (a test's own hooks may close over this file's imports; an inline
// plugin's may not). The engine validates every tree against the surface's element table, and
// presses reach the callbacks below, so these check both the trees and their wiring.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf } from 'claude-code'

import type { AgentRec, Settings, Skin, StatusRequest } from '../types'
import { STRINGS } from '../hooks/i18n'
import { normalizeSettings } from '../hooks/settings'
import { cardRows, renderAgents, talkOf, timeCells } from '../hooks/ui/agents'
import { chOf, displayWidth } from '../hooks/ui/theme'
import { commandLine, editLines, runDiff, runSummary, shortPath, toolDetail } from '../hooks/ui/tools'
import { renderAlert } from '../hooks/ui/alerts'
import { BAND_RIPPLE, CREST_CELLS, bandMood, besideBand, modeLabel, renderBand, renderFooter } from '../hooks/ui/band'
import { renderLimits } from '../hooks/ui/limits'
import { renderPhoneQueue } from '../hooks/ui/queue'
import { rippleSource } from '../hooks/ui/parts'
import { pic } from '../hooks/ui/kit'
import { CELL_PX, SVG_MAX_PX, svg } from '../hooks/ui/art'
import { renderLog } from '../hooks/ui/log'
import { renderSettings } from '../hooks/ui/settings'
import { renderSetup } from '../hooks/ui/setup'
import { countdown, elapsed, minutesLeft, modelName, nextMinuteChange, resetsLabel, routeOf, seconds, targetOf, targetValue } from '../hooks/ui/view'
import type { AgentEntry, AgentsActions, AgentsView, AlertView, DashboardView, Frame, JevState, SettingsActions, Surface } from '../hooks/ui/view'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-10T13:20:00')
const PRESSER = 'test'

function paneProps(columns: number, rows = 30): RenderPropsOf['Pane'] {
  return { title: 'ui', isFocused: true, bodyColumns: columns, placement: 'inline', scroll: { offset: 0, bodyRows: rows }, view: {} } as RenderPropsOf['Pane']
}

function frameOf(surface: Surface, columns = 140, maxRows = 12, skin: Skin = 'deep'): Frame {
  return { surface, columns, maxRows, now: NOW, appearance: 'auto', skin, lang: 'en' }
}

/** The drawn picture whose `alt` is `alt` (a query matches no `alt` of its own). */
async function svgByAlt(ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }, alt: string) {
  return (await ui.findAll({ type: 'Svg' })).find(svg => svg.props.alt === alt)
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
  agents: { live: 0, total: 0 },
  compactions: 0,
  logOpen: false,
  agentsOpen: false,
  effortMenu: false,
  hide: [],
  extras: ['context'],
  isWorking: false,
}

const SETTINGS: Settings = normalizeSettings({
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
  compactModel: 'claude-haiku-5-5',
  layout: 'dashboard',
  appearance: 'auto',
  language: 'auto',
  hide: [],
  setupDone: false,
})

const QUICK_ACTIONS: SettingsActions = { patch: () => undefined, jevKey: () => undefined, testJev: () => undefined, openAllSettings: () => undefined, close: () => undefined }

type Draw = (el: Parameters<typeof renderBand>[0], surface: Surface) => ReturnType<typeof renderBand>

/** Answers ui.render for the Pane `id` with `draw`. */
function drawPane(on: On, id: string, draw: Draw) {
  on('ui.render', { component: 'Pane', requestId: id }, ($, e) => draw($.ui.resolve(e), e.surface) as RenderElement)
}

function mount<S extends Surface>($: Engine, id: string, surface: S, columns = 140) {
  return $.ui.mount({ plugin: PRESSER, surface, component: 'Pane', requestId: id, props: paneProps(columns), viewport: { columns, rows: 40 } })
}

// ---- Pure helpers ------------------------------------------------------------------------------

test('view helpers', () => {
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelName('claude-mythos-5-1')).toBe('Mythos 5.1')
  expect(modelName('mythos')).toBe('Mythos')
  expect(modelName('sonnet')).toBe('Sonnet')
  expect(modelName('gpt-6.1-sol')).toBe('gpt-6.1-sol')
  expect(countdown(41 * 60_000, 'en')).toBe('41m')
  expect(countdown(105_000, 'en')).toBe('1:45')
  expect(countdown(0, 'en')).toBe('cold')
  expect(countdown(41 * 60_000, 'ko')).toBe('41분')
  expect(countdown(105_000, 'ko')).toBe('1:45')
  expect(countdown(0, 'ko')).toBe(STRINGS.ko['band.cold'])
  expect(countdown(41 * 60_000, 'es')).toBe('41 min')
  expect(elapsed(12_000, 'en')).toBe('12s')
  expect(elapsed(245_000, 'ko')).toBe('4분 05초')
  expect(elapsed(3_720_000, 'ja')).toBe('1時間02分')
  expect(resetsLabel('2026-10-10T13:45:00', NOW, 'en')).toBe('resets in 25m')
  expect(resetsLabel('2026-10-10T13:45:00', NOW, 'ko')).toBe('25분 뒤 초기화')
  expect(resetsLabel('2026-10-13T13:20:00', NOW, 'zh')).toBe('3天后重置')
  expect(seconds(2.14, 'ko')).toBe('2.1초')
  expect(targetOf(targetValue({ agent: 'general-purpose', model: 'sonnet' }))).toEqual({ agent: 'general-purpose', model: 'sonnet' })
  expect(targetOf('gpt-6-1-sol')).toEqual({ agent: 'gpt-6-1-sol' })
  const record: StatusRequest = { at: '2026-10-10T13:19:10', source: 'gpt-6-1-sol@high', target: 'gpt-6.1-sol', provider: 'chatgpt', status: 200, ok: true, ms: 2140, usage: { input: 3000, cached: 41_000, output: 900 } }
  expect(routeOf(record)).toMatchObject({ model: 'gpt-6.1-sol (gpt-6-1-sol)', cachePct: 93, seconds: 2.14 })
  // A hosted id's vendor path is not drawn.
  expect(routeOf({ ...record, source: 'deepseek-ai-deepseek-v4-1-flash-1017@high', target: 'deepseek-ai/deepseek-v4.1-flash-1017' }).model).toBe('deepseek-v4.1-flash-1017 (deepseek-ai-deepseek-v4-1-flash-1017)')
  expect(routeOf({ ...record, source: 'deepseek-ai/deepseek-v4.1-flash-1017', target: 'deepseek-ai/deepseek-v4.1-flash-1017' }).model).toBe('deepseek-v4.1-flash-1017')
  expect(minutesLeft(41 * 60_000 + 1, 'en')).toBe('42m')
  expect(minutesLeft(41 * 60_000, 'en')).toBe('41m')
  expect(minutesLeft(30_000, 'ko')).toBe('1분')
  expect(minutesLeft(0, 'en')).toBe('cold')
  // The shown minute changes exactly when a whole minute is left, and at expiry.
  expect(nextMinuteChange(NOW + 41 * 60_000 + 30_000, NOW)).toBe(NOW + 30_000)
  expect(nextMinuteChange(NOW + 41 * 60_000, NOW)).toBe(NOW + 60_000)
  expect(nextMinuteChange(NOW + 20_000, NOW)).toBe(NOW + 20_000)
  expect(nextMinuteChange(NOW, NOW)).toBe(null)
})

// ---- Band --------------------------------------------------------------------------------------

test('the band draws on both surfaces and its controls reach their callbacks', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = {
    toggleAuto: fn('auto'), toggleWarm: fn("warm"), compact: fn("compact"), clear: fn("clear"), handoff: fn('handoff'), toggleLog: fn('log'),
    toggleAgents: fn('agents'), openSettings: fn('settings'), toggleEffortMenu: fn('menu'), pickEffort: fn('pick'),
  }
  drawPane(on, 'band', (el, surface) => renderBand(el, frameOf(surface), DASH, actions))
  drawPane(on, 'band-busy', (el, surface) =>
    renderBand(el, frameOf(surface), { ...DASH, effort: { level: null, mode: 'deciding', since: NOW - 500 }, warm: { on: true, pings: 2, cost: 9000 }, limit: { kind: 'five_hour', percent: 86, resetsAt: '2026-10-10T15:40:00', save: true }, agents: { live: 2, total: 3 }, effortMenu: true }, actions),
  )
  for (const surface of SURFACES) {
    const ui = await mount($, 'band', surface)
    // Compact and clear are the desktop's icons; the terminal has no Log (the route is its own press)…
    // Handoff shows on both, always (2026-10-24).
    const keys = surface === 'terminal' ? ['handoff', 'auto', 'warm', 'log', 'agents', 'settings'] : ['handoff', 'auto', 'warm', 'agents', 'compact', 'clear', 'settings']
    // …but no Compact clear card here: the desktop's Compact opens the note bar from the band.
    if (surface === 'terminal') expect(await ui.find({ key: 'compact' })).toBeUndefined()
    for (const key of keys) {
      expect(await ui.find({ type: 'Button', key }), "ui { type: 'Button', key } " + surface).toBeDefined()
      await ui.press({ key })
    }
    // Every picture a plain image: the desktop draws each answer afresh, and an interactive picture
    // (a frame) reloads blank each time; an image of the same source does not.
    const pictures = await ui.findAll({ type: 'Svg' })
    if (surface === 'terminal') expect(pictures.length).toBe(0)
    for (const picture of pictures) expect(picture.props.isInteractive).toBeFalsy()
    if (surface === 'terminal') {
      expect((await ui.find({ key: 'auto' }))?.props.hotkey).toBe('a')
      expect(await ui.find({ type: 'Text', text: 'gpt-6.1-sol' }), "ui { type: 'Text', text: 'gpt-6.1-sol' } " + surface).toBeDefined()
    } else {
      // The route is words in the capsule's own ink with its press laid over them.
      expect(await ui.find({ type: 'Button', key: 'route' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'gpt-6.1-sol' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'High' })).toBeDefined()
      // Pointing at a control says what it does, in the reason's place.
      expect(await ui.find({ type: 'Text', text: /^Keep cache warm Off · / })).toBeDefined()
      // What captions said is in the hover tips.
      expect(await ui.find({ type: 'Text', text: /^Opus 5\.5 · Auto · Effort High — multi-file refactor/ })).toBeDefined()
      // The route has no tip of its own: the log it opens is its card (028aee5).
      expect(await ui.find({ type: 'Text', text: /^Last route: / })).toBeUndefined()
      // The route opens the log too; the effort its menu.
      await ui.press({ key: 'route' })
      await ui.press({ key: 'effort' })
    }
    await ui.unmount()

    const busy = await mount($, 'band-busy', surface)
    await busy.press({ key: 'pick-low' })
    if (surface === 'desktop') {
      expect(await busy.find({ type: 'Text', text: 'Deciding…' })).toBeDefined()
      expect(await busy.find({ type: 'Text', text: /keep-warm on, 2 pings/ })).toBeDefined()
      // The live agents' count, drawn in its badge.
      expect((await busy.findAll({ type: 'Svg' })).some(svg => svg.props.alt === 'Agents 2')).toBe(true)
    } else {
      expect(await busy.find({ type: 'Text', text: /deciding/ }), "busy { type: 'Text', text: /deciding/ } " + surface).toBeDefined()
    }
    await busy.unmount()
  }
  expect(calls.filter(c => c === 'auto').length).toBe(2)
  expect(calls.filter(c => c === 'log').length).toBe(2)
  expect(calls.filter(c => c === 'compact').length).toBe(1)
  expect(calls.filter(c => c === 'clear').length).toBe(1)
  expect(calls.filter(c => c === 'handoff').length).toBe(2)
  expect(calls.filter(c => c === 'menu').length).toBe(1)
  expect(calls.filter(c => c === 'pick:["low"]').length).toBe(2)
})

test('the band draws the same markup for the same view', async ($, on) => {
  const noop = () => undefined
  const actions = { toggleAuto: noop, toggleWarm: noop, compact: noop, clear: noop, handoff: noop, toggleLog: noop, toggleAgents: noop, openSettings: noop, toggleEffortMenu: noop, pickEffort: noop }
  drawPane(on, 'band', (el, surface) => renderBand(el, frameOf(surface), { ...DASH, effort: { level: 'medium', mode: 'deciding', since: NOW - 300 } }, actions))
  const once = await mount($, 'band', 'desktop')
  const first = JSON.stringify(await once.drawn())
  await once.unmount()
  const second = JSON.stringify(await (await mount($, 'band', 'desktop')).drawn())
  expect(first.replace(/"handle":\d+/g, '')).toBe(second.replace(/"handle":\d+/g, ''))
})

test('the terminal band fits its rows at narrow widths', async ($, on) => {
  const noop = () => undefined
  const actions = { toggleAuto: noop, toggleWarm: noop, compact: noop, clear: noop, handoff: noop, toggleLog: noop, toggleAgents: noop, openSettings: noop, toggleEffortMenu: noop, pickEffort: noop }
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

test('a ko frame resolves temporary Korean text in labels and hover cards', async ($, on) => {
  const original = { ...STRINGS.ko }
  const noop = () => undefined
  const actions = { toggleAuto: noop, toggleWarm: noop, compact: noop, clear: noop, handoff: noop, toggleLog: noop, toggleAgents: noop, openSettings: noop, toggleEffortMenu: noop, pickEffort: noop }
  try {
    STRINGS.ko['band.auto'] = '자동'
    STRINGS.ko['band.high'] = '높음'
    STRINGS.ko['band.effortTitle'] = '강도 {value}{hint} · 선택'
    STRINGS.ko['band.effortAlt'] = '강도 {value} ({mode}){why}'
    drawPane(on, 'ko-band', (el, surface) => renderBand(el, { ...frameOf(surface), lang: 'ko' }, DASH, actions))
    const terminal = await mount($, 'ko-band', 'terminal')
    expect((await terminal.find({ key: 'auto' }))?.props.label).toBe('자동 ●')
    expect(await terminal.find({ type: 'Text', text: /높음/ })).toBeDefined()
    await terminal.unmount()
    const desktop = await mount($, 'ko-band', 'desktop')
    expect(await desktop.find({ type: 'Text', text: '높음' })).toBeDefined()
    expect(await desktop.find({ type: 'Text', text: '자동' })).toBeDefined()
    expect(await desktop.find({ type: 'Text', text: /강도 높음 — multi-file refactor · 선택$/ })).toBeDefined()
    await desktop.unmount()
  } finally { Object.assign(STRINGS.ko, original) }
})

// ---- Alerts ------------------------------------------------------------------------------------

const ALERTS: AlertView[] = [
  { kind: 'cold', tokens: 182_000, idleMinutes: 74 },
  { kind: 'kept', pings: 2, tokens: 312_000, minutesLeft: 47 },
  { kind: 'swamp', percent: 63, tokens: 126_000 },
  { kind: 'hot', limitKind: 'five_hour', percent: 86, resetsAt: '2026-10-10T15:40:00', save: false },
  { kind: 'judgeDown', judge: 'jev', reason: 'key rejected (401)' },
  { kind: 'result', stage: 'handingOff' },
  { kind: 'result', stage: 'handoffDone', detail: 'A new session opened with the handoff filled in: press Enter there to go on.' },
  { kind: 'result', stage: 'tidying' },
  { kind: 'result', stage: 'compacting' },
  { kind: 'result', stage: 'compacted' },
  { kind: 'result', stage: 'failed', detail: 'Haiku timed out' },
  { kind: 'compactNote', draft: '', tidy: true, pick: 'claude-haiku-5-5', models: [{ value: 'claude-haiku-5-5', label: 'Claude Haiku' }], cold: false },
]

test('every alert draws on both surfaces', async ($, on) => {
  const noop = () => undefined
  const actions = { compact: noop, clear: noop, dismiss: noop, toggleSave: noop, openSettings: noop, noteInput: noop, toggleTidy: noop, pickCompactModel: noop, copy: noop }
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
    compact: fn("compact"), clear: fn("clear"), dismiss: fn("dismiss"), toggleSave: fn('save'), openSettings: fn('settings'), noteInput: fn('note'), toggleTidy: fn('tidy'), pickCompactModel: fn('model'), copy: fn('copy'),
  }
  drawPane(on, 'cold', (el, surface) => renderAlert(el, frameOf(surface), ALERTS[0]!, actions))
  drawPane(on, 'kept', (el, surface) => renderAlert(el, frameOf(surface), ALERTS[1]!, actions))
  drawPane(on, 'hot', (el, surface) => renderAlert(el, frameOf(surface), ALERTS[3]!, actions))
  drawPane(on, 'note', (el, surface) => renderAlert(el, frameOf(surface), { kind: 'compactNote', draft: '', tidy: true, pick: 'claude-haiku-5-5', models: [{ value: 'claude-haiku-5-5', label: 'Claude Haiku' }], cold: false }, actions))
  drawPane(on, 'handed', (el, surface) => renderAlert(el, frameOf(surface), { kind: 'result', stage: 'handoffDone' }, actions))
  for (const surface of SURFACES) {
    const cold = await mount($, 'cold', surface)
    await cold.press({ key: 'compact' })
    await cold.press({ key: 'dismiss' })
    const kept = await mount($, 'kept', surface)
    await kept.press({ key: 'dismiss' })
    const hot = await mount($, 'hot', surface)
    await hot.press({ key: 'save' })
    const note = await mount($, 'note', surface)
    await note.press({ key: 'tidy' })
    await note.input({ key: 'note', text: 'keep the API decision' })
    const handed = await mount($, 'handed', surface)
    await handed.press({ key: 'copy' })
  }
  const once = ['compact', 'dismiss', 'dismiss', 'save', 'tidy', 'compact:["keep the API decision"]', 'copy']
  expect(calls).toEqual([...once, ...once])
})

/**
 * The px a picture is drawn at: its document's own width. The Svg asks wider than that and fills
 * the cells laid out for it (kit.tsx `filled`), so its `width` prop is not its size.
 */
function ownPx(picture: Drawn): number {
  return Number(/^<svg\b[^>]*?\swidth="([\d.]+)"/.exec(String(picture.props?.source))?.[1])
}

/** The mascot pictures in a drawn tree: the Svgs on its 56 grid. */
function mascots(tree: unknown): Drawn[] {
  const out: Drawn[] = []
  walk(tree, n => {
    if (n.type === 'Svg' && String(n.props?.source).includes('viewBox="0 0 56 56"')) out.push(n)
  })
  return out
}

test('each alert shows 리플이 with the face of its state, its gauge in 5% steps; the terminal keeps a text mark', async ($, on) => {
  const noop = () => undefined
  const actions = { compact: noop, clear: noop, dismiss: noop, toggleSave: noop, openSettings: noop, noteInput: noop, toggleTidy: noop, pickCompactModel: noop, copy: noop }
  const variants: [string, AlertView][] = [
    ['swamp-59', { kind: 'swamp', percent: 59, tokens: 118_000 }],
    ['swamp-61', { kind: 'swamp', percent: 61, tokens: 122_000 }],
    ['swamp-66', { kind: 'swamp', percent: 66, tokens: 132_000 }],
    ['hot-94', { kind: 'hot', limitKind: 'five_hour', percent: 94, save: false }],
    ['hot-95', { kind: 'hot', limitKind: 'five_hour', percent: 95, save: false }],
  ]
  ALERTS.forEach((alert, i) => drawPane(on, 'face-' + i, (el, surface) => renderAlert(el, frameOf(surface), alert, actions)))
  for (const [id, alert] of variants) drawPane(on, id, (el, surface) => renderAlert(el, frameOf(surface), alert, actions))
  const sources: string[] = []
  for (let i = 0; i < ALERTS.length; i++) {
    const ui = await mount($, 'face-' + i, 'desktop')
    const found = mascots(await ui.drawn())
    expect(found.length, 'alert ' + i).toBe(1)
    // The full drawing (34 px up): brows and mouth say what the card is about.
    expect(ownPx(found[0]!)).toBe(34)
    // An image, not a frame: the desktop rebuilds a frame blank on each redraw.
    expect(found[0]!.props?.isInteractive, 'alert ' + i).toBeFalsy()
    sources.push(String(found[0]!.props?.source))
    await ui.unmount()
    const terminal = await mount($, 'face-' + i, 'terminal')
    expect(mascots(await terminal.drawn()).length).toBe(0)
    await terminal.unmount()
  }
  // handoffDone, compacted and kept share the pleased face; every other state has its own.
  expect(new Set(sources).size).toBe(ALERTS.length - 2)
  const source = async (id: string) => {
    const ui = await mount($, id, 'desktop')
    const s = String(mascots(await ui.drawn())[0]?.props?.source)
    await ui.unmount()
    return s
  }
  expect(await source('swamp-59')).toBe(await source('swamp-61'))
  expect(await source('swamp-61') === await source('swamp-66')).toBe(false)
  expect((await source('hot-94')).includes('fill="var(--warn)"')).toBe(true)
  expect((await source('hot-95')).includes('fill="var(--bad)"')).toBe(true)
  const terminal = await mount($, 'hot-95', 'terminal')
  expect(await terminal.find({ type: 'Text', text: /^✕ / })).toBeDefined()
})

test('리플이 greets in setup and quick settings and waits in empty panes, never among running agents', async ($, on) => {
  const noop = () => undefined
  const setupActions = { patch: noop, jevKey: noop, testJev: noop, openAllSettings: noop, back: noop, next: noop, finish: noop, skip: noop }
  drawPane(on, 'm-setup-1', (el, surface) => renderSetup(el, frameOf(surface), { step: 1, draft: SETTINGS, jev: { source: 'env', test: { state: 'idle' } } }, setupActions))
  drawPane(on, 'm-setup-4', (el, surface) => renderSetup(el, frameOf(surface), { step: 4, draft: SETTINGS, jev: { source: 'env', test: { state: 'idle' } } }, setupActions))
  drawPane(on, 'm-quick', (el, surface) => renderSettings(el, frameOf(surface), { settings: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, QUICK_ACTIONS))
  drawPane(on, 'm-agents', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: AGENTS, now: NOW, showDone: true }, { ...AGENT_NOOP, toggleDone: noop }))
  drawPane(on, 'm-agents-empty', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: [], now: NOW, showDone: false }, { ...AGENT_NOOP, toggleDone: noop }))
  drawPane(on, 'm-log-empty', (el, surface) => renderLog(el, frameOf(surface, 64), { rows: [], mineOnly: true }, { toggleScope: noop }))
  // It greets and waits at 56 px, and heads the quick settings at 48.
  const expected: [string, number, string, number][] = [['m-setup-1', 1, 'var(--accent)', 56], ['m-setup-4', 1, 'var(--ok)', 56], ['m-quick', 1, 'var(--accent)', 48], ['m-agents', 0, '', 0], ['m-agents-empty', 1, 'var(--accent)', 56], ['m-log-empty', 1, 'var(--accent)', 56]]
  for (const [id, count, tone, size] of expected) {
    const ui = await mount($, id, 'desktop', 64)
    const found = mascots(await ui.drawn())
    expect(found.length, id).toBe(count)
    if (tone) expect(String(found[0]!.props?.source).includes('stroke="' + tone + '"'), id).toBe(true)
    if (size) expect(ownPx(found[0]!), id).toBe(size)
    await ui.unmount()
    const terminal = await mount($, id, 'terminal', 64)
    expect(mascots(await terminal.drawn()).length, id).toBe(0)
    await terminal.unmount()
  }
})

// ---- Settings and setup ------------------------------------------------------------------------

/** Every quick control, on one screen on both surfaces (the desktop's tiles, the terminal's rows). */
const QUICK_KEYS = ['set-auto', 'bias-2', 'judge-haiku', 'judge-jev', 'judge-model', 'set-warm']

test('quick settings draw on both surfaces with only session controls', async ($, on) => {
  drawPane(on, 'quick', (el, surface) => renderSettings(el, frameOf(surface), { settings: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, QUICK_ACTIONS))
  drawPane(on, 'quick-off', (el, surface) => renderSettings(el, frameOf(surface), { settings: { ...SETTINGS, effortAuto: false }, jev: { source: null, test: { state: 'idle' } } }, QUICK_ACTIONS))
  for (const surface of SURFACES) {
    const ui = await mount($, 'quick', surface)
    // The terminal names the brand and the panel quietly; the desktop's head is the panel's name.
    if (surface === 'terminal') {
      expect((await ui.find({ type: 'Text', text: 'ClaudeRipple' }))?.props.bold).toBe(true)
      expect((await ui.find({ type: 'Text', text: 'Quick settings' }))?.props.dimColor).toBe(true)
    } else {
      expect((await ui.find({ type: 'Text', text: 'Quick settings' }))?.props.bold).toBe(true)
      expect(await ui.find({ type: 'Text', text: 'ClaudeRipple' })).toBeDefined()
      // 리플이 says what the settings do now.
      expect(await ui.find({ type: 'Text', text: 'Jev picks the effort for every prompt.' })).toBeDefined()
    }
    for (const key of [...QUICK_KEYS, 'all-settings', 'close']) expect(await ui.find({ key }), surface + ' ' + key).toBeDefined()
    for (const key of ['save', 'tab-workers', 'floor', 'judge-model', 'jev-source', 'warm-hours', 'worker-next']) {
      if (key === 'judge-model') expect(await ui.find({ type: 'Select', key })).toBeUndefined()
      else expect(await ui.find({ key })).toBeUndefined()
    }
    expect(await ui.find({ type: 'Text', text: '● unsaved' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'not affiliated with Anthropic' })).toBeUndefined()
    await ui.unmount()
    const off = await mount($, 'quick-off', surface)
    expect(await off.find({ key: 'bias-2' })).toBeUndefined()
    await off.unmount()
  }
})

test('quick settings controls reach their callbacks on both surfaces', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { patch: fn('patch'), jevKey: fn('key'), testJev: fn('test'), openAllSettings: fn('all'), close: fn('close') }
  drawPane(on, 'quick', (el, surface) => renderSettings(el, frameOf(surface), { settings: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, actions))
  for (const surface of SURFACES) {
    const ui = await mount($, 'quick', surface)
    await ui.press({ key: 'set-auto' })
    await ui.press({ key: 'bias-2' })
    await ui.press({ key: 'judge-model' })
    await ui.input({ key: 'jev-key', text: 'ts-key' })
    await ui.press({ key: 'jev-test' })
    await ui.press({ key: 'set-warm' })
    await ui.press({ key: 'all-settings' })
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  const once = ['patch:[{"effortAuto":false}]', 'patch:[{"bias":2}]', 'patch:[{"judge":"model"}]', 'key:["ts-key"]', 'test', 'patch:[{"keepWarm":true}]', 'all', 'close']
  expect(calls).toEqual([...once, ...once])
})

// ---- Skins (look.ts) ---------------------------------------------------------------------------

const SKINS: readonly Skin[] = ['deep', 'flat']

test('the skin tile offers deep and flat on the desktop alone, and a pick patches the setting', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { ...QUICK_ACTIONS, patch: fn('patch') }
  drawPane(on, 'skin', (el, surface) => renderSettings(el, frameOf(surface), { settings: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, actions))
  const desktop = await mount($, 'skin', 'desktop')
  for (const skin of SKINS) expect(await desktop.find({ key: 'skin-' + skin }), skin).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: 'Skin' })).toBeDefined()
  await desktop.press({ key: 'skin-flat' })
  await desktop.unmount()
  // The terminal draws text whatever the skin, so it does not offer one.
  const terminal = await mount($, 'skin', 'terminal')
  for (const skin of SKINS) expect(await terminal.find({ key: 'skin-' + skin })).toBeUndefined()
  await terminal.unmount()
  expect(calls).toEqual(['patch:[{"skin":"flat"}]'])
})

/** The deep's three inks for host Text (art.ts): a skin that is not the deep uses none of them. */
const DEEP_INKS = ['#f2f0eb', '#cbc8bf', '#9c988e']

test('every skin draws the band, the quick settings and a card on the desktop; flat paints the app\'s surface and its quiet words', async ($, on) => {
  const noop = () => undefined
  const bandActions = { toggleAuto: noop, toggleWarm: noop, compact: noop, clear: noop, handoff: noop, toggleLog: noop, toggleAgents: noop, openSettings: noop, toggleEffortMenu: noop, pickEffort: noop, hide: noop }
  const alertActions = { compact: noop, clear: noop, dismiss: noop, toggleSave: noop, openSettings: noop, noteInput: noop, toggleTidy: noop, pickCompactModel: noop, copy: noop }
  const full: DashboardView = { ...DASH, extras: ['context', 'limits'], limit: { kind: 'five_hour', percent: 42, save: true }, effortMenu: true, warm: { on: true, pings: 2, cost: 9000 }, agents: { live: 2, total: 3 }, mode: 'Burn GPT' }
  for (const skin of SKINS) {
    drawPane(on, skin + '-band', el => renderBand(el, frameOf('desktop', 100, 12, skin), full, bandActions))
    drawPane(on, skin + '-quick', el => renderSettings(el, frameOf('desktop', 140, 12, skin), { settings: { ...SETTINGS, skin, jevSource: 'typesafe' }, jev: { source: null, test: { state: 'fail', message: 'no' } } }, QUICK_ACTIONS))
    drawPane(on, skin + '-card', el => renderAlert(el, frameOf('desktop', 100, 12, skin), { kind: 'compactNote', draft: '', tidy: true, pick: 'claude-haiku-5-5', models: [{ value: 'claude-haiku-5-5', label: 'Claude Haiku' }], cold: false }, alertActions))
    drawPane(on, skin + '-setup', el => renderSetup(el, frameOf('desktop', 100, 12, skin), { step: 1, draft: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, { patch: noop, jevKey: noop, testJev: noop, openAllSettings: noop, back: noop, next: noop, finish: noop, skip: noop }))
  }
  for (const skin of SKINS) {
    for (const what of ['band', 'quick', 'card', 'setup']) {
      const ui = await mount($, skin + '-' + what, 'desktop')
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.length, skin + ' ' + what + ' pictures').toBeGreaterThan(3)
      for (const svg of svgs) expect(String(svg.props.source), skin + ' ' + what + ' ' + svg.props.alt).not.toMatch(/NaN|undefined/)
      // The desktop draws nothing for a picture whose alt is blank.
      for (const svg of svgs) expect(String(svg.props.alt ?? '').trim(), skin + ' ' + what + ' alt').not.toBe('')
      // The capsule's backdrop: a picture as wide as the frame (flat's is the app's own surface).
      const backdrop = svgs.some(svg => svg.props.alt === 'ClaudeRipple' && Number(svg.props.width) > 300)
      expect(backdrop, skin + ' ' + what + ' backdrop').toBe(true)
      const colours = new Set((await ui.findAll({ type: 'Text' })).map(text => String(text.props.color ?? '')))
      if (skin === 'deep') expect(DEEP_INKS.some(ink => colours.has(ink)), skin + ' ' + what + ' ink').toBe(true)
      else for (const ink of DEEP_INKS) expect(colours.has(ink), skin + ' ' + what + ' ' + ink).toBe(false)
      if (skin === 'flat') {
        // The host's ink for values, the app's quiet text colour for the names and asides.
        expect(['#73726c', '#9c9a92', '#86847d'].some(c => colours.has(c)), skin + ' ' + what + ' quiet words').toBe(true)
      }
      await ui.unmount()
    }
  }
})

test('band, settings and log pictures stay within the SVG limit on every surface and theme', async ($, on) => {
  const cases: { id: string; columns: number }[] = []
  const logRows: StatusRequest[] = Array.from({ length: 40 }, (_, i) => ({ at: new Date(NOW - i * 1000).toISOString(), source: 'gpt-6.1-sol', target: 'gpt-6.1-sol', provider: 'chatgpt', status: 200, ok: true, ms: 100 }))
  for (const skin of SKINS) for (const appearance of ['light', 'dark'] as const) for (const columns of [40, 600]) {
    const frame = (surface: Surface): Frame => ({ ...frameOf(surface, columns, 12, skin), appearance })
    const variants: [string, Draw][] = [
      ['band', (el, surface) => renderBand(el, frame(surface), { ...DASH, effortMenu: true }, BAND_ACTIONS)],
      ['settings', (el, surface) => renderSettings(el, frame(surface), { settings: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, QUICK_ACTIONS)],
      ['log', (el, surface) => renderLog(el, frame(surface), { rows: logRows, mineOnly: false }, { toggleScope: () => undefined })],
    ]
    for (const [name, draw] of variants) {
      const id = [name, skin, appearance, columns].join('-')
      drawPane(on, id, draw)
      cases.push({ id, columns })
    }
  }
  for (const { id, columns } of cases) for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await mount($, id, surface, columns)
    expect((await ui.findAll({ type: 'Text' })).length > 0, id + ' ' + surface).toBe(true)
    for (const picture of await ui.findAll({ type: 'Svg' })) {
      expect(Number(picture.props.width) <= SVG_MAX_PX, id + ' width').toBe(true)
      expect(Number(picture.props.height ?? 0) <= SVG_MAX_PX, id + ' height').toBe(true)
    }
    await ui.unmount()
  }
})

test('Jev key and Test row appear only for TypeSafe Jev with no known key', async ($, on) => {
  const sources: JevState['source'][] = [null, 'zen', 'env', 'file', 'pasted']
  for (const judge of ['haiku', 'jev', 'model'] as const) {
    for (const jevSource of ['typesafe', 'zen'] as const) {
      for (const source of sources) drawPane(on, [judge, jevSource, source].join('-'), (el, surface) => renderSettings(el, frameOf(surface), { settings: { ...SETTINGS, judge, jevSource }, jev: { source, test: { state: 'idle' } } }, QUICK_ACTIONS))
    }
  }
  for (const surface of SURFACES) {
    for (const judge of ['haiku', 'jev', 'model'] as const) {
      for (const jevSource of ['typesafe', 'zen'] as const) {
        for (const source of sources) {
          const ui = await mount($, [judge, jevSource, source].join('-'), surface)
          const shown = judge === 'jev' && jevSource === 'typesafe' && (source === null || source === 'zen')
          expect(!!await ui.find({ type: 'Input', key: 'jev-key' }), surface + ' ' + [judge, jevSource, source]).toBe(shown)
          expect(!!await ui.find({ key: 'jev-test' })).toBe(shown)
          await ui.unmount()
        }
      }
    }
  }
})

test('setup steps draw on both surfaces and move on', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { patch: fn('patch'), jevKey: fn('key'), testJev: fn('test'), openAllSettings: fn('all'), back: fn('back'), next: fn('next'), finish: fn('finish'), skip: fn('skip') }
  for (const step of [1, 2, 3, 4] as const) {
    drawPane(on, 'setup-' + step, (el, surface) =>
      renderSetup(el, frameOf(surface), { step, draft: SETTINGS, jev: { source: 'env', test: { state: 'idle' } } }, actions),
    )
  }
  for (const surface of SURFACES) {
    await (await mount($, 'setup-1', surface)).press({ key: 'next' })
    const workers = await mount($, 'setup-2', surface)
    expect(await workers.find({ type: 'Text', text: 'Workers start on the ladder; set it up on the dashboard.' })).toBeDefined()
    expect(await workers.find({ key: 'rule-mode-auto' })).toBeUndefined()
    await workers.press({ key: 'all-settings' })
    await workers.press({ key: 'back' })
    await (await mount($, 'setup-3', surface)).press({ key: 'set-warm' })
    const done = await mount($, 'setup-4', surface)
    // The four workers' models, lowest first (the old tiers become the ladder; Max takes the Hard model).
    expect(await done.find({ type: 'Text', text: 'deepseek-v4-1-flash · gpt-6-1-sol · gpt-6-astra · gpt-6-astra' }), 'done workers ' + surface).toBeDefined()
    expect(await done.find({ type: 'Text', text: 'not affiliated with Anthropic' })).toBeUndefined()
    await done.press({ key: 'finish' })
  }
  const once = ['next', 'all', 'back', 'patch:[{"keepWarm":true}]', 'finish']
  expect(calls).toEqual([...once, ...once])
})

// ---- Panes -------------------------------------------------------------------------------------

const AGENTS: AgentRec[] = [
  {
    id: 'a1',
    description: 'Port the request log renderer',
    type: 'gpt-6-1-sol',
    model: 'gpt-6.1-sol@high',
    pick: { domain: 'frontend', rule: 'ui', rung: 'standard', level: 'standard', effort: 'high', sure: 0.8, why: 'designed refactor', target: { agent: 'gpt-6-1-sol' }, by: 'haiku', ms: 900 },
    state: 'running',
    now: 'Edit hooks/ui/log.tsx',
    toolSince: NOW - 14_000,
    startedAt: NOW - 192_000,
    cost: 38_400,
    provider: 'chatgpt',
    effort: 'high',
    answeredBy: 'gpt-6.1-sol',
    usage: { input: 1200, cached: 38_000, cacheWrite: 800, output: 5100 },
    tools: 12,
  },
  { id: 'a2', description: 'Summarize the docs', type: 'deepseek-v4-1-flash', state: 'done', startedAt: NOW - 900_000, endedAt: NOW - 800_000, cost: 9000 },
]

const AGENT_NOOP: AgentsActions = { toggleDone: () => undefined, open: () => undefined, back: () => undefined, toggleRun: () => undefined }

test('the Agents pane draws a worker the session\'s own model runs', async ($, on) => {
  const onSession: AgentRec = { ...AGENTS[0]!, id: 's1', description: 'Review on the session model', pick: { ...AGENTS[0]!.pick!, target: { agent: 'general-purpose' }, by: 'session' } }
  drawPane(on, 'agents-session', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: [onSession], now: NOW, showDone: false }, { ...AGENT_NOOP, toggleDone: () => undefined }))
  for (const surface of SURFACES) {
    const ui = await mount($, 'agents-session', surface, 64)
    expect(await ui.find({ type: 'Text', text: 'Review on the session model' }), surface).toBeDefined()
    await ui.unmount()
  }
})

test('the Agents pane draws live, finished and empty', async ($, on) => {
  const { calls, fn } = recorder()
  drawPane(on, 'agents', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: AGENTS, now: NOW, showDone: false }, { ...AGENT_NOOP, toggleDone: fn('done') }))
  drawPane(on, 'agents-open', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: AGENTS, now: NOW, showDone: true }, { ...AGENT_NOOP, toggleDone: fn('done') }))
  drawPane(on, 'agents-empty', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: [], now: NOW, showDone: false }, { ...AGENT_NOOP, toggleDone: fn('done') }))
  for (const surface of SURFACES) {
    const ui = await mount($, 'agents', surface, 64)
    expect(await ui.find({ type: 'Text', text: 'Port the request log renderer' }), "ui { type: 'Text', text: 'Port the request log renderer' } " + surface).toBeDefined()
    // What it does now, on the terminal; the desktop's cards hold still and leave it to the
    // conversation and the host's task list (2026-10-20).
    const doing = await ui.find({ type: 'Text', text: /Edit hooks\/ui\/log.tsx · 14s/ })
    if (surface === 'terminal') expect(doing, surface).toBeDefined()
    else expect(doing, surface).toBeUndefined()
    // A finished agent is a card too, not a line behind a fold.
    expect(await ui.find({ type: 'Text', text: 'Summarize the docs' }), surface).toBeDefined()
    // Who picked it and why, on the terminal; the desktop's cards leave it out (2026-10-20).
    const why = await ui.find({ type: 'Text', text: /Frontend \/ Standard/ })
    if (surface === 'terminal') {
      expect(why, surface).toBeDefined()
      expect(why?.text).toContain('ui/')
    } else expect(why, surface).toBeUndefined()
    // The Claude app's count: the last prompt (1200 + 38000 + 800) plus the reply (5100), the cache's
    // 95% share, and 12 tools.
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: 'tokens 45k · cache 95% · tools 12' }), surface).toBeDefined()
    else for (const value of ['45k', '95%', '12']) expect(await ui.find({ type: 'Text', text: value }), value).toBeDefined()
    // Two agents finished: nothing hides behind "more".
    expect(await ui.find({ type: 'Button', key: 'done' }), surface).toBeUndefined()
    const empty = await mount($, 'agents-empty', surface, 64)
    expect(await empty.find({ type: 'Text', text: 'No agents or background tasks yet' }), "empty { type: 'Text', text: 'No agents or background tasks yet' } " + surface).toBeDefined()
  }
  expect(calls).toEqual([])
})

test('the Agents pane draws forty agents at once, and a record missing its title or type', async ($, on) => {
  // 2026-10-23: a session of dozens of workers left the pane on the engine's "Nothing to show yet":
  // the list's capsule asked for a sea taller than the 4096 px an Svg may be, and the engine refused
  // the whole tree. The store keeps the latest 40.
  const forty: AgentRec[] = Array.from({ length: 40 }, (_, i): AgentRec => ({ ...AGENTS[0]!, id: 'w' + i, description: 'cheongju:송수아 ' + i, ...(i < 31 ? {} : { state: 'done', endedAt: NOW - i * 1000, now: undefined, toolSince: undefined }) }))
  // A record as an older mod or the engine may leave it: no description, no type, no model.
  const bare: AgentRec = { id: 'bare', state: 'done', startedAt: NOW - 5000, endedAt: NOW - 1000, cost: 0 }
  const cases: { id: string; columns: number }[] = []
  for (const skin of SKINS) for (const appearance of ['light', 'dark'] as const) for (const columns of [40, 64]) {
    const id = [skin, appearance, columns].join('-')
    const frame = (surface: Surface) => ({ ...frameOf(surface, columns, 12, skin), appearance })
    drawPane(on, 'forty-' + id, (el, surface) => renderAgents(el, frame(surface), { agents: forty, now: NOW, showDone: true }, AGENT_NOOP))
    drawPane(on, 'bare-' + id, (el, surface) => renderAgents(el, frame(surface), { agents: [AGENTS[0]!, bare], now: NOW, showDone: true }, AGENT_NOOP))
    cases.push({ id, columns })
  }
  for (const { id, columns } of cases) {
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await mount($, 'forty-' + id, surface, columns)
      // The title is the whole title on one line (the engine cuts it at the edge), so every card has it.
      for (const i of [0, 30, 31, 39]) expect(await ui.find({ type: 'Text', text: 'cheongju:송수아 ' + i }), surface + ' ' + id + ' ' + i).toBeDefined()
      const pictures = await ui.findAll({ type: 'Svg' })
      if (surface === 'terminal' || surface === 'mobile') expect(pictures).toHaveLength(0)
      else {
        const tiles = pictures.filter(p => String(p.props.source).includes('viewBox="0 4096 '))
        expect(tiles.length > 0, surface + ' ' + id + ' continuation').toBe(true)
        for (const picture of pictures) {
          expect(Number(picture.props.width) <= SVG_MAX_PX).toBe(true)
          expect(Number(picture.props.height ?? 0) <= SVG_MAX_PX).toBe(true)
        }
      }
      await ui.unmount()
      const one = await mount($, 'bare-' + id, surface, columns)
      expect(await one.find({ type: 'Text', text: 'Port the request log renderer' }), surface + ' ' + id).toBeDefined()
      expect(await one.find({ type: 'Text', text: 'bare' }), surface + ' ' + id).toBeDefined()
      await one.unmount()
    }
  }
})

test('the Agents pane draws forty mixed real-world records on every surface, skin and theme', async ($, on) => {
  const by = ['marker', 'session', 'judge', 'haiku', 'jev', 'model', 'default', 'tier'] as const
  const states = ['running', 'done', 'failed', 'killed'] as const
  const mixed: AgentRec[] = Array.from({ length: 40 }, (_, i): AgentRec => ({
    ...AGENTS[0]!, id: 'mixed-' + i, description: '에이전트 표시 오류 수정 ' + i,
    state: states[i % states.length]!,
    model: i % 3 === 0 ? 'gemini-3.8-flash@high' : i % 3 === 1 ? 'gpt-6.1-sol@medium' : undefined,
    type: i % 3 === 0 ? 'ripple:auto' : i % 3 === 1 ? 'general-purpose' : undefined,
    answeredBy: undefined, provider: i % 3 === 0 ? undefined : 'chatgpt', effort: i % 3 === 0 ? undefined : 'high',
    pick: i % 3 === 0 ? undefined : { ...AGENTS[0]!.pick!, by: by[i % by.length]!, target: i % 2 ? { agent: 'general-purpose', model: 'opus' } : { agent: 'gpt-6-1-sol' }, fallbackReason: i % 5 === 0 ? '요청한 모델의 사용 한도를 초과했습니다.' : undefined },
    now: 'Bash ' + '아주 긴 도구 실행 명령어 '.repeat(1000),
    usage: { input: 1_234_567, cached: 9_876_543, cacheWrite: 100_000, output: 50_000 }, tools: 150,
    endedAt: NOW - i * 1000,
  }))
  // Exercise the real register.tsx boundary too: text the engine's FINAL validation refuses must
  // be caught before the tree leaves us, and an unreadable conversation must return to the list.
  mock.clock(on, { now: NOW })
  let broken: string | null = null
  let selected: string | null = null
  let closes = 0
  const errors: string[] = []
  on('state.get', { plugin: 'ripple', key: 'settings' }, () => ({ value: { value: SETTINGS, version: 0 } }))
  on('state.get', { plugin: 'ripple', key: 'lang' }, () => ({ value: { value: 'ko', version: 0 } }))
  on('state.get', { plugin: 'ripple', key: 'agents' }, () => ({ value: { value: broken === null ? mixed : [{ ...mixed[0]!, description: broken }, ...mixed.slice(1)], version: 0 } }))
  on('state.get', { plugin: 'ripple', key: 'agentOpen' }, async ($, e, next) => {
    const held = await next(e)
    return { value: { value: selected, version: held.value?.version ?? 0 } }
  })
  on('state.set', { plugin: 'ripple', key: 'agentOpen' }, async ($, e, next) => { selected = typeof e.value === 'string' ? e.value : null; return next(e) })
  on('session.messages', () => ({ value: { deny: '대화 기록을 읽을 수 없습니다.' } }))
  on('ui.log', ($, e) => { errors.push(e.text); return { value: undefined } })
  on('ui.close', () => { closes++; return { value: undefined } })
  for (const skin of SKINS) for (const appearance of ['light', 'dark'] as const) {
    const id = ['mixed', skin, appearance].join('-')
    drawPane(on, id, (el, surface) => renderAgents(el, { ...frameOf(surface, 40, 12, skin), appearance, lang: 'ko' }, { agents: mixed, now: NOW, showDone: true }, AGENT_NOOP))
  }
  for (const skin of SKINS) for (const appearance of ['light', 'dark'] as const) {
    const id = ['mixed', skin, appearance].join('-')
    for (const surface of ['desktop', 'terminal', 'vscode', 'mobile'] as const) {
      const ui = await mount($, id, surface, 40)
      // The whole title is in the tree; the engine cuts it only as it draws.
      for (const i of [0, 39]) expect(await ui.find({ type: 'Text', text: '에이전트 표시 오류 수정 ' + i }), id + ' ' + surface + ' ' + i).toBeDefined()
      await ui.unmount()
    }
  }
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const description of ['표시 오류 \u001b[31m\u0085\u{10eeee}\u{2800}\u{0305}', '\u{0305}표시 오류', '\u{2800}\u{0305}표시 오류']) {
      broken = description
      selected = null
      const fallback = await $.ui.mount({ plugin: 'ripple', surface, component: 'Pane', requestId: 'ripple-agents', props: paneProps(40), viewport: { columns: 40, rows: 40 } })
      expect(await fallback.find({ type: 'Text', text: /제어 문자|결합 문자/ }), surface + ' validation reason').toBeDefined()
      expect(await fallback.find({ type: 'Text', text: '에이전트 표시 오류 수정 39' }), surface + ' fallback list').toBeDefined()
      expect(await fallback.findAll({ type: 'Svg' })).toHaveLength(0)
      expect(await fallback.find({ key: 'back' })).toBeUndefined()
      await fallback.press({ key: 'close' })
      await fallback.unmount()
    }
    broken = null
    selected = 'mixed-0'
    const denied = await $.ui.mount({ plugin: 'ripple', surface, component: 'Pane', requestId: 'ripple-agents', props: paneProps(40), viewport: { columns: 40, rows: 40 } })
    expect(await denied.find({ type: 'Text', text: '대화 기록을 읽을 수 없습니다.' }), surface + ' conversation reason').toBeDefined()
    expect(await denied.find({ type: 'Text', text: '에이전트 표시 오류 수정 39' }), surface + ' returned to list').toBeDefined()
    await denied.press({ key: 'back' })
    expect(selected).toBe(null)
    await denied.unmount()
  }
  expect(closes).toBe(12)
  expect(errors.some(error => error.includes('결합 문자'))).toBe(true)
})

test('pictures tile at the SVG side limit without rescaling or restarting their artwork', async ($, on) => {
  for (const size of [4095, 4096, 4097, 8200]) {
    const source = svg(size, size, '<rect width="' + size + '" height="' + size + '" fill="#262523"/>')
    drawPane(on, 'tiles-' + size, el => pic(el, 'tiles', source, 'whole', size, size))
  }
  for (const size of [4095, 4096, 4097, 8200]) {
    const source = svg(size, size, '<rect width="' + size + '" height="' + size + '" fill="#262523"/>')
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await mount($, 'tiles-' + size, surface)
      const pictures = await ui.findAll({ type: 'Svg' })
      const across = Math.ceil(size / SVG_MAX_PX)
      expect(pictures).toHaveLength(across * across)
      for (const [i, picture] of pictures.entries()) {
        const x = (i % across) * SVG_MAX_PX
        const y = Math.floor(i / across) * SVG_MAX_PX
        const width = Math.min(SVG_MAX_PX, size - x)
        const height = Math.min(SVG_MAX_PX, size - y)
        // Each tile is its own size in its document and fills its cells as any picture does.
        expect(ownPx(picture)).toBe(width)
        expect(String(picture.props.source)).toMatch(new RegExp('^<svg\\b[^>]*\\sheight="' + height + '"'))
        expect(Number(picture.props.width) >= width && picture.props.height === undefined).toBe(true)
        expect(String(picture.props.source)).toContain('viewBox="' + [x, y, width, height].join(' ') + '"')
        expect(String(picture.props.source).slice(String(picture.props.source).indexOf('><style>'))).toBe(source.slice(source.indexOf('><style>')))
      }
      await ui.unmount()
    }
  }
})

// The desktop's newer type (2026-10-25) set a cell at ~8.8 px, not the CELL_PX the pictures are
// drawn for: pictures asked at their own px fell short of their cells, the band's sea ended before
// its right edge and its icons sat in wide gaps.
test('every picture fills the cells laid out for it, so it keeps its place whatever px a cell is', async ($, on) => {
  const noop = () => undefined
  const draws: [string, Draw][] = [
    ['band', el => renderBand(el, frameOf('desktop', 100), DASH, BAND_ACTIONS)],
    ['settings', el => renderSettings(el, frameOf('desktop', 100), { settings: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, QUICK_ACTIONS)],
    ['agents', el => renderAgents(el, frameOf('desktop', 64), { agents: AGENTS, now: NOW, showDone: true }, AGENT_NOOP)],
    ['alert', el => renderAlert(el, frameOf('desktop', 100), ALERTS[0]!, { compact: noop, clear: noop, dismiss: noop, toggleSave: noop, openSettings: noop, noteInput: noop, toggleTidy: noop, pickCompactModel: noop, copy: noop })],
  ]
  for (const [id, draw] of draws) drawPane(on, 'cells-' + id, draw)
  for (const [id] of draws) {
    const ui = await mount($, 'cells-' + id, 'desktop', 100)
    let pictures = 0
    walk(await ui.drawn(), n => {
      const only = n.type === 'Box' && n.children?.length === 1 ? n.children[0] as Drawn : null
      if (only?.type !== 'Svg') return
      pictures++
      const key = id + ' ' + String(n.props?.key)
      expect(Math.abs(Number(n.props?.width) * CELL_PX - ownPx(only)) < 0.5, key + ' cells').toBe(true)
      expect(Number(only.props?.width) >= ownPx(only) && only.props?.height === undefined, key + ' fills').toBe(true)
    })
    expect(pictures > 0, id).toBe(true)
    await ui.unmount()
  }
})

test('the Agents pane shows the latest finished agents and the rest behind more; a card opens its conversation', async ($, on) => {
  const { calls, fn } = recorder()
  const many: AgentRec[] = [AGENTS[0]!, ...Array.from({ length: 7 }, (_, i): AgentRec => ({ id: 'd' + i, description: 'Finished task ' + i, type: 'Explore', model: 'claude-haiku-5-5', state: i === 0 ? 'failed' : 'done', startedAt: NOW - 600_000, endedAt: NOW - 500_000 + i * 1000, cost: 0 }))]
  const actions = { ...AGENT_NOOP, toggleDone: fn('done'), open: fn('open') }
  drawPane(on, 'agents-many', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: many, now: NOW, showDone: false }, actions))
  drawPane(on, 'agents-all', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: many, now: NOW, showDone: true }, actions))
  for (const surface of SURFACES) {
    const ui = await mount($, 'agents-many', surface, 64)
    // Newest first: the four latest show, the oldest three wait behind "more".
    for (const i of [6, 5, 4, 3]) expect(await ui.find({ type: 'Text', text: 'Finished task ' + i }), surface + ' ' + i).toBeDefined()
    for (const i of [2, 1, 0]) expect(await ui.find({ type: 'Text', text: 'Finished task ' + i }), surface + ' ' + i).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'done' }), surface).toBeDefined()
    await ui.press({ key: 'done' })
    // A desktop row is one blank press under its title and facts, our own Text, so the host's button
    // ink never paints them.
    await ui.press({ key: 'open-a1' })
    const all = await mount($, 'agents-all', surface, 64)
    expect(await all.find({ type: 'Text', text: 'Finished task 0' }), surface).toBeDefined()
    expect(await all.find({ type: 'Text', text: /failed/ }) ?? await all.find({ type: 'Text', text: /^✕/ }), surface).toBeDefined()
    if (surface === 'desktop') {
      expect(await all.find({ type: 'Button', key: 'open-d0' }), surface).toBeDefined()
      await all.press({ key: 'open-d0' })
    }
  }
  expect(calls).toEqual(['done', 'open:["a1"]', 'done', 'open:["a1"]', 'open:["d0"]'])
})

test('an agent\'s conversation reads in the pane: the task, its words, its tools, the answer, and a way back', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { ...AGENT_NOOP, back: fn('back') }
  const talk: AgentEntry[] = [
    { kind: 'prompt', text: 'Port the log renderer to the new kit.' },
    { kind: 'text', text: 'Reading the **current** renderer first.' },
    { kind: 'tool', id: 't1', tool: 'Read', detail: 'hooks/ui/log.tsx', state: 'ok' },
    { kind: 'tool', id: 't2', tool: 'Bash', detail: 'npm test', state: 'error' },
    { kind: 'tool', id: 't3', tool: 'Edit', detail: 'hooks/ui/log.tsx', state: 'running' },
  ]
  const done: AgentRec = { ...AGENTS[0]!, id: 'a9', state: 'done', endedAt: NOW - 1000, now: undefined, toolSince: undefined }
  const long: AgentEntry[] = [talk[0]!, ...Array.from({ length: 45 }, (_, i): AgentEntry => ({ kind: 'tool', id: 'x' + i, tool: 'Grep', detail: 'pattern ' + i, state: 'ok' }))]
  drawPane(on, 'talk-live', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: AGENTS, now: NOW, showDone: false, open: { id: 'a1', talk: { entries: talk } } }, actions))
  drawPane(on, 'talk-done', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: [done], now: NOW, showDone: false, open: { id: 'a9', talk: { entries: [...talk.slice(0, 3), { kind: 'text', text: 'Ported; tests pass.' }] } } }, actions))
  drawPane(on, 'talk-long', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: AGENTS, now: NOW, showDone: false, open: { id: 'a1', talk: { entries: long }, runsOpen: ['x0'] } }, actions))
  const huge: AgentEntry[] = [talk[0]!, ...Array.from({ length: 60 }, (_, i): AgentEntry => ({ kind: 'text', text: 'words ' + i + ' ' + 'x'.repeat(2000) }))]
  drawPane(on, 'talk-huge', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: AGENTS, now: NOW, showDone: false, open: { id: 'a1', talk: { entries: huge } } }, actions))
  drawPane(on, 'talk-deny', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: AGENTS, now: NOW, showDone: false, open: { id: 'a1', talk: { deny: 'no saved transcript for a1' } } }, actions))
  drawPane(on, 'talk-gone', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: AGENTS, now: NOW, showDone: false, open: { id: 'zz', talk: { entries: [] } } }, actions))
  for (const surface of SURFACES) {
    const live = await mount($, 'talk-live', surface, 64)
    expect(await live.find({ type: 'Text', text: 'Port the request log renderer' }), surface).toBeDefined()
    // The desktop sets the prompt in a card, as the Claude app does, with no label; the terminal labels it.
    expect(await live.find({ type: 'Text', text: 'Task' }) !== undefined, surface).toBe(surface === 'terminal')
    expect(await live.find({ key: 'task-body' }) !== undefined, surface).toBe(surface === 'desktop')
    // Its three calls fold into one line. The terminal keeps the failure count and the call in
    // flight under it; the desktop's line is the app's: its words alone, no mark, no count.
    expect(await live.find({ type: surface === 'desktop' ? 'Text' : 'Button', text: /^Read a file, ran a command, edited a file/ }), surface).toBeDefined()
    expect(await live.find({ type: 'Text', text: '1 failed' }) !== undefined, surface).toBe(surface === 'terminal')
    expect(await live.find({ type: 'Text', text: /^Edit$/ }) !== undefined, surface).toBe(surface === 'terminal')
    for (const tool of ['Read', 'Bash']) expect(await live.find({ type: 'Text', text: new RegExp('^' + tool + '$') }), surface + ' ' + tool).toBeUndefined()
    // Its words as Markdown on the desktop, plain text on the terminal; no answer while it runs.
    if (surface === 'desktop') expect((await live.findAll({ type: 'Markdown' })).some(m => m.props.text === 'Reading the **current** renderer first.'), surface).toBe(true)
    else expect(await live.find({ type: 'Text', text: 'Reading the **current** renderer first.' }), surface).toBeDefined()
    expect(await live.find({ type: 'Text', text: 'Final answer' }), surface).toBeUndefined()
    await live.press({ key: 'back' })
    const finished = await mount($, 'talk-done', surface, 64)
    expect(await finished.find({ type: 'Text', text: 'Final answer' }), surface).toBeDefined()
    const long_ = await mount($, 'talk-long', surface, 64)
    // Every entry shows, as in the Claude app's chat: no "earlier" to press.
    expect(await long_.find({ type: 'Text', text: 'pattern 44' }), surface).toBeDefined()
    expect(await long_.find({ type: 'Text', text: 'pattern 0' }), surface).toBeDefined()
    expect(await long_.find({ key: 'earlier' }), surface).toBeUndefined()
    expect(await long_.find({ key: 'dropped' }), surface).toBeUndefined()
    // Only a conversation past what a tree can draw loses its oldest entries, and says so.
    const huge = await mount($, 'talk-huge', surface, 64)
    expect(await huge.find({ key: 'dropped' }), surface).toBeDefined()
    const latest = surface === 'desktop'
      ? (await huge.findAll({ type: 'Markdown' })).some(m => String(m.props.text).startsWith('words 59'))
      : (await huge.find({ type: 'Text', text: /^words 59/ })) !== undefined
    expect(latest, surface).toBe(true)
    const deny = await mount($, 'talk-deny', surface, 64)
    expect(await deny.find({ type: 'Text', text: /can’t be read: no saved transcript for a1/ }), surface).toBeDefined()
    const gone = await mount($, 'talk-gone', surface, 64)
    expect(await gone.find({ type: 'Text', text: 'This agent is no longer in the list.' }), surface).toBeDefined()
    await gone.press({ key: 'back' })
  }
  expect(calls).toEqual(['back', 'back', 'back', 'back'])
})

test('an open conversation is headed by a chevron back and its title, which stay at the window\'s top on the pane\'s surface once scrolled', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { ...AGENT_NOOP, back: fn('back') }
  const talk: AgentEntry[] = [{ kind: 'prompt', text: 'Do it.' }, ...Array.from({ length: 20 }, (_, i): AgentEntry => ({ kind: 'text', text: 'words ' + i }))]
  const view = { agents: AGENTS, now: NOW, showDone: false, open: { id: 'a1', talk: { entries: talk } } }
  drawPane(on, 'float-top', el => renderAgents(el, frameOf('desktop', 64), view, actions))
  drawPane(on, 'float-down', el => renderAgents(el, { ...frameOf('desktop', 64), offset: 12 }, view, actions))
  const top = await mount($, 'float-top', 'desktop', 64)
  // The head: a drawn chevron under a blank press, then the title; no pill over the words.
  const head = await top.find({ key: 'open-head' })
  expect(head).toBeDefined()
  expect(await svgByAlt(top, 'All agents')).toBeDefined()
  expect(await top.find({ type: 'Text', text: 'Port the request log renderer' })).toBeDefined()
  expect(await top.find({ key: 'float-head' })).toBeUndefined()
  for (const key of ['pill-back', 'ghost-back', 'pill-back-float', 'ghost-back-float']) expect(await top.find({ key }), key).toBeUndefined()
  // The card under the head names no title again: the head has it.
  expect(await top.findAll({ type: 'Text', text: 'Port the request log renderer' })).toHaveLength(1)
  await top.press({ key: 'back' })
  // Scrolled, no copy of the head is redrawn at the window's top: the engine pins no row, and the
  // copy trailed the words, landed mid-pane and flickered (2026-10-25).
  const down = await mount($, 'float-down', 'desktop', 64)
  expect(await down.find({ key: 'float-head' })).toBeUndefined()
  expect(await down.findAll({ key: 'open-head' })).toHaveLength(1)
  for (const svg of await down.findAll({ type: 'Svg' })) expect(String(svg.props.alt ?? '').trim(), String(svg.props.source).slice(0, 80)).not.toBe('')
  expect(calls).toEqual(['back'])
})

test('a long prompt folds to its first lines under a fade, and Show more unfolds it', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { ...AGENT_NOOP, toggleRun: fn('run') }
  const long = Array.from({ length: 12 }, (_, i) => 'Line ' + i + ' of a long delegated prompt that wraps across the pane.').join('\n')
  const talk: AgentEntry[] = [{ kind: 'prompt', text: long }, { kind: 'text', text: 'On it.' }, { kind: 'prompt', text: 'Short follow-up.' }]
  const draw = (runsOpen: string[]) => (el: Parameters<typeof renderBand>[0]) => renderAgents(el, frameOf('desktop', 64), { agents: AGENTS, now: NOW, showDone: false, open: { id: 'a1', talk: { entries: talk }, runsOpen } }, actions)
  drawPane(on, 'fold-shut', draw([]))
  drawPane(on, 'fold-open', draw(['prompt:first']))
  const shut = await mount($, 'fold-shut', 'desktop', 64)
  const body = await shut.find({ key: 'task-body' })
  expect(body?.props.height).toBe(5)
  expect(body?.props.overflow).toBe('hidden')
  expect(await shut.find({ key: 'pic-task-fade' })).toBeDefined()
  expect(await shut.find({ type: 'Text', text: 'Show more' })).toBeDefined()
  // The short one does not fold, and has nothing to press.
  expect(await shut.find({ key: 'prompt-2-body' })).toBeDefined()
  expect(await shut.find({ key: 'prompt-2-more' })).toBeUndefined()
  expect((await shut.find({ key: 'prompt-2-body' }))?.props.height).toBeUndefined()
  await shut.press({ key: 'task-more' })
  const open = await mount($, 'fold-open', 'desktop', 64)
  expect((await open.find({ key: 'task-body' }))?.props.height).toBeUndefined()
  expect(await open.find({ key: 'pic-task-fade' })).toBeUndefined()
  expect(await open.find({ type: 'Text', text: 'Show less' })).toBeDefined()
  await open.press({ key: 'task-more' })
  expect(calls).toEqual(['run:["prompt:first"]', 'run:["prompt:first"]'])
})

test('while its agent works the conversation ends in Claude\'s spark, one picture that a redraw does not change', async ($, on) => {
  const talk: AgentEntry[] = [{ kind: 'prompt', text: 'Do it.' }, { kind: 'text', text: 'On it.' }]
  const done: AgentRec = { ...AGENTS[0]!, state: 'done', endedAt: NOW - 1000 }
  drawPane(on, 'spark-live', el => renderAgents(el, frameOf('desktop', 64), { agents: AGENTS, now: NOW, showDone: false, open: { id: 'a1', talk: { entries: talk } } }, AGENT_NOOP))
  drawPane(on, 'spark-later', el => renderAgents(el, frameOf('desktop', 64), { agents: [{ ...AGENTS[0]!, toolSince: NOW - 2000, now: 'Bash ls' }], now: NOW + 7000, showDone: false, open: { id: 'a1', talk: { entries: [...talk, { kind: 'text', text: 'More.' }] } } }, AGENT_NOOP))
  drawPane(on, 'spark-done', el => renderAgents(el, frameOf('desktop', 64), { agents: [done], now: NOW, showDone: false, open: { id: 'a1', talk: { entries: talk } } }, AGENT_NOOP))
  const live = await mount($, 'spark-live', 'desktop', 64)
  const spark = await svgByAlt(live, 'Working')
  expect(spark).toBeDefined()
  expect(String(spark?.props.source)).toContain('#d97757')
  expect(String(spark?.props.source)).toContain('@keyframes')
  // No "thinking" line in its place.
  expect(await live.find({ type: 'Text', text: 'thinking' })).toBeUndefined()
  // Drawn again a tick and a step later, the same key and the same document.
  const later = await mount($, 'spark-later', 'desktop', 64)
  expect((await svgByAlt(later, 'Working'))?.props.source).toBe(spark?.props.source)
  expect(await later.find({ key: 'pic-spark' })).toBeDefined()
  const finished = await mount($, 'spark-done', 'desktop', 64)
  expect(await svgByAlt(finished, 'Working')).toBeUndefined()
})

test('talkOf reads a conversation into prompts, words and tool calls that stand answered, failed or running', () => {
  const entries = talkOf([
    { role: 'user', text: ' Do the thing. ', toolUses: [] },
    { role: 'assistant', text: 'On it.', toolUses: [
      { tool_use_id: 'u1', tool: 'Bash', input: { command: 'npm test\nmore' }, text: 'ok' },
      { tool_use_id: 'u2', tool: 'Read', input: { file_path: '/a.ts' }, text: 'nope', isError: true },
      { tool_use_id: 'u3', tool: 'Grep', input: { pattern: 'x' } },
    ] },
    { role: 'user', text: '', toolUses: [] },
  ])
  expect(entries).toEqual([
    { kind: 'prompt', text: 'Do the thing.' },
    { kind: 'text', text: 'On it.' },
    { kind: 'tool', id: 'u1', tool: 'Bash', detail: 'npm test', state: 'ok' },
    { kind: 'tool', id: 'u2', tool: 'Read', detail: '/a.ts', state: 'error' },
    { kind: 'tool', id: 'u3', tool: 'Grep', detail: 'x', state: 'running' },
  ])
})

test('the log pane lists this session\'s verdicts among its requests, a fallback in plain words', async ($, on) => {
  const rows: StatusRequest[] = [{ at: '2026-10-10T13:19:10', source: 'claude-opus-5-5', target: 'claude-opus-5-5', provider: 'anthropic', status: 200, ok: true, ms: 19_400, effort: 'low', mine: true }]
  const judges = [
    { at: Date.parse('2026-10-10T13:19:09'), for: 'prompt' as const, asked: 'jev' as const, by: 'jev' as const, ms: 610, effort: 'low' as const, sure: 0.94 },
    { at: Date.parse('2026-10-10T13:20:00'), for: 'prompt' as const, asked: 'jev' as const, by: 'haiku' as const, ms: 3400, effort: 'medium' as const, error: 'Jev timed out' },
  ]
  drawPane(on, 'log-judges', (el, surface) => renderLog(el, frameOf(surface, 80), { rows, mineOnly: true, judges }, { toggleScope: () => undefined }))
  drawPane(on, 'log-all', (el, surface) => renderLog(el, frameOf(surface, 80), { rows, mineOnly: false, judges }, { toggleScope: () => undefined }))
  for (const surface of SURFACES) {
    const ui = await mount($, 'log-judges', surface, 80)
    expect(await ui.find({ type: 'Text', text: 'Effort judge' }), surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /sure 94%/ }), surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Jev failed → Haiku' }), surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Jev timed out' }), surface).toBeDefined()
    // Newest first: the fallback, the request, then the verdict that preceded it.
    const order: string[] = []
    walk(await ui.drawn(), n => { const text = (n.children ?? []).join(''); if (n.type === 'Text' && /^(Jev failed → Haiku|claude-opus-5-5|Jev)$/.test(text)) order.push(text) })
    expect(order).toEqual(['Jev failed → Haiku', 'claude-opus-5-5', 'Jev'])
    // Another session's requests have no verdicts of ours beside them.
    const all = await mount($, 'log-all', surface, 80)
    expect(await all.find({ type: 'Text', text: 'Effort judge' }), surface).toBeUndefined()
  }
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

test('a request made on the Fast tier shows FAST beside its effort, and no other request does (#97)', async ($, on) => {
  const base = { source: 'gpt-6-1-sol@high', target: 'gpt-6.1-sol', provider: 'chatgpt', status: 200, ok: true, ms: 2140, effort: 'high', mine: true }
  const rows: StatusRequest[] = [
    { ...base, at: '2026-10-10T13:19:10', requestedTier: 'priority', servedTier: 'default' } as StatusRequest,
    { ...base, at: '2026-10-10T13:18:55' },
    { ...base, at: '2026-10-10T13:18:40', requestedTier: 'flex' },
  ]
  drawPane(on, 'log-fast', (el, surface) => renderLog(el, frameOf(surface, 64), { rows, mineOnly: true }, { toggleScope: () => undefined }))
  drawPane(on, 'log-fast-none', (el, surface) => renderLog(el, frameOf(surface, 64), { rows: rows.slice(1), mineOnly: true }, { toggleScope: () => undefined }))
  for (const surface of SURFACES) {
    const ui = await mount($, 'log-fast', surface, 64)
    // One badge for the one priority request, on the effort line (the line after the model's).
    expect((await ui.findAll({ type: 'Text', text: 'FAST' })).length, surface).toBe(1)
    const efforts: string[][] = []
    walk(await ui.drawn(), n => { if (n.type === 'Box' && (n.children ?? []).some(c => (c as Drawn).type === 'Text' && ((c as Drawn).children ?? []).join('') === 'high')) efforts.push(((n.children ?? []) as Drawn[]).map(c => (c.children ?? []).join(''))) })
    expect(efforts.map(line => line.includes('FAST')), surface).toEqual([true, false, false])
    const none = await mount($, 'log-fast-none', surface, 64)
    expect(await none.find({ type: 'Text', text: 'FAST' }), surface).toBeUndefined()
  }
})

// ---- Nothing cut, nothing reloaded (2026-10-10) -------------------------------------------------

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
function walk(node: unknown, visit: (n: Drawn) => void): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  const n = node as Drawn
  visit(n)
  for (const child of n.children ?? []) walk(child, visit)
}
const isBlank = (n: Drawn) => n.type === 'Button' && typeof n.props?.label === 'string' && /^ +$/.test(n.props.label)

/**
 * Each blank press and whether it lies over something drawn: the nearest Box around it (at most
 * three levels up) that holds a picture or words besides the press itself.
 */
function presses(tree: unknown): { key: string; over: boolean }[] {
  const out: { key: string; over: boolean }[] = []
  const drawnIn = (n: unknown) => {
    let found = false
    walk(n, d => { if (d.type === 'Svg' || (d.type === 'Text' && (d.children ?? []).join('').trim())) found = true })
    return found
  }
  const visit = (n: Drawn, up: Drawn[]) => {
    if (isBlank(n)) out.push({ key: String(n.props?.key), over: up.slice(-4).some(a => drawnIn(a)) })
    for (const child of n.children ?? []) if (child && typeof child === 'object') visit(child as Drawn, [...up, n])
  }
  visit(tree as Drawn, [])
  return out
}

test('every picture is a plain image, 리플이 the one face, and every blank press lies over a drawn control', async ($, on) => {
  // Each Svg is a new <img> (or, interactive, a frame that reloads blank) on every desktop redraw
  // (parts.tsx). A control is drawn (art.ts) and takes its press from a blank native button laid
  // over it (kit.tsx), never from a blank button over nothing.
  const noop = () => undefined
  const setupActions = { patch: noop, jevKey: noop, testJev: noop, openAllSettings: noop, back: noop, next: noop, finish: noop, skip: noop }
  const alertActions = { compact: noop, clear: noop, dismiss: noop, toggleSave: noop, openSettings: noop, noteInput: noop, toggleTidy: noop, pickCompactModel: noop, copy: noop }
  const cases: [string, Draw][] = [
    ['one-quick', (el, surface) => renderSettings(el, frameOf(surface, 64, 30), { settings: { ...SETTINGS, jevSource: 'typesafe' }, jev: { source: null, test: { state: 'idle' } } }, QUICK_ACTIONS)],
    ...([1, 2, 3, 4] as const).map((step): [string, Draw] => ['one-setup-' + step, (el, surface) => renderSetup(el, frameOf(surface, 64, 30), { step, draft: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, setupActions)]),
    ...ALERTS.map((alert, i): [string, Draw] => ['one-alert-' + i, (el, surface) => renderAlert(el, frameOf(surface, 60), alert, alertActions)]),
    ['one-hot-save', (el, surface) => renderAlert(el, frameOf(surface, 60), { kind: 'hot', limitKind: 'five_hour', percent: 97, save: true }, alertActions)],
  ]
  for (const [id, draw] of cases) drawPane(on, id, draw)
  for (const [id] of cases) {
    const ui = await mount($, id, 'desktop', 64)
    const tree = await ui.drawn()
    walk(tree, n => { if (n.type === 'Svg') expect(n.props?.isInteractive, id).toBeFalsy() })
    expect(mascots(tree).length, id).toBe(1)
    for (const press of presses(tree)) expect(press.over, id + ' ' + press.key).toBe(true)
    await ui.unmount()
  }
})

test('a card says one thing: at most one main action, the others quiet, one way to let it go', async ($, on) => {
  const noop = () => undefined
  const alertActions = { compact: noop, clear: noop, dismiss: noop, toggleSave: noop, openSettings: noop, noteInput: noop, toggleTidy: noop, pickCompactModel: noop, copy: noop }
  const all: AlertView[] = [...ALERTS, { kind: 'hot', limitKind: 'five_hour', percent: 97, save: true }]
  all.forEach((alert, i) => drawPane(on, 'say-' + i, (el, surface) => renderAlert(el, frameOf(surface), alert, alertActions)))
  for (let i = 0; i < all.length; i++) {
    const ui = await mount($, 'say-' + i, 'desktop')
    const buttons: Drawn[] = []
    walk(await ui.drawn(), n => { if (n.type === 'Button') buttons.push(n) })
    // The main action is a lit pill (a picture with its press); the rest are ghost pills, the
    // options a drawn segmented control, the way out a drawn ×: every press a blank one.
    let pills = 0
    walk(await ui.drawn(), n => { if (n.type === 'Box' && String(n.props?.key ?? '').startsWith('pill-')) pills++ })
    expect(buttons.every(b => isBlank(b)), 'alert ' + i).toBe(true)
    const main = buttons.filter(b => b.props?.variant === 'primary')
    const closes = buttons.filter(b => b.props?.role === 'dismiss')
    const others = buttons.filter(b => b.props?.variant !== 'primary' && b.props?.role !== 'dismiss' && !isBlank(b))
    expect(main.length + pills <= 1, 'alert ' + i).toBe(true)
    expect(closes.length <= 1, 'alert ' + i).toBe(true)
    // Quiet: dim at rest (the note's field submit is the host's own).
    for (const b of others) expect(b.props?.dimColor === true, 'alert ' + i + ' ' + String(b.props?.key)).toBe(true)
    await ui.unmount()
  }
  // Save mode on: nothing left to press but turning it off, quietly (a ghost pill, no lit one).
  const on_ = await mount($, 'say-' + (all.length - 1), 'desktop')
  expect(await on_.find({ type: 'Box', key: 'ghost-save' })).toBeDefined()
  expect(await on_.find({ type: 'Box', key: 'pill-save' })).toBeUndefined()
  expect((await on_.findAll({ type: 'Svg' })).some(svg => svg.props.alt === 'Turn save mode off')).toBe(true)
  expect(await on_.find({ type: 'Button', key: 'dismiss' })).toBeDefined()
})

test('no drawing cuts its text, but for the agent card\'s title and model name, which the app\'s proportional type cuts at the edge', async ($, on) => {
  const noop = () => undefined
  // The engine's own ellipsis, on the two spots whose width the app's type decides: a character
  // count there measured cells and cut too soon (2026-10-25).
  const settingsActions = QUICK_ACTIONS
  const cases: [string, Draw][] = [
    ['cut-quick', (el, surface) => renderSettings(el, frameOf(surface, 60, 30), { settings: SETTINGS, jev: { source: null, test: { state: 'fail', message: 'key rejected (401) '.repeat(4) } } }, settingsActions)],
    ['cut-log', (el, surface) => renderLog(el, frameOf(surface, 40), { rows: [{ at: '2026-10-10T13:19:10', source: 'a-very-long-requested-model-name@high', target: 'another-very-long-routed-model-name', provider: 'opencode-go', status: 200, ok: true, ms: 2140 }], mineOnly: false }, { toggleScope: noop })],
    ...ALERTS.map((alert, i): [string, Draw] => ['cut-alert-' + i, (el, surface) => renderAlert(el, frameOf(surface, 40), alert, { compact: noop, clear: noop, dismiss: noop, toggleSave: noop, openSettings: noop, noteInput: noop, toggleTidy: noop, pickCompactModel: noop, copy: noop })]),
  ]
  for (const [id, draw] of cases) drawPane(on, id, draw)
  for (const surface of SURFACES) {
    for (const [id] of cases) {
      const ui = await mount($, id, surface, 40)
      walk(await ui.drawn(), n => {
        if (n.type === 'Text') expect(String(n.props?.wrap ?? 'wrap').startsWith('truncate'), id + ' ' + surface).toBe(false)
      })
      await ui.unmount()
    }
  }
})

test('the agent card is the one drawing the engine cuts: its title and its model name alone', async ($, on) => {
  // The app's type is proportional, so a character count cut too soon; these two take their row's
  // free width and the engine ellipsis them at the edge (2026-10-25).
  const agent: AgentRec = { ...AGENTS[0]!, description: 'Mobile / motion — a title long enough to reach the edge of any pane', model: 'gpt-6.1-sol@high' }
  drawPane(on, 'cut-card', (el, surface) => renderAgents(el, frameOf(surface, 40), { agents: [agent], now: NOW, showDone: false }, AGENT_NOOP))
  const cuts = async (surface: Surface): Promise<string[]> => {
    const ui = await mount($, 'cut-card', surface, 40)
    const cut: string[] = []
    walk(await ui.drawn(), n => { if (n.type === 'Text' && String(n.props?.wrap ?? '').startsWith('truncate')) cut.push(String((n.children ?? []).join(''))) })
    await ui.unmount()
    return cut
  }
  expect(await cuts('desktop'), 'desktop').toEqual([agent.description, 'gpt-6.1-sol'])
  // The terminal draws its own rows and wraps; the app's ellipsis is the desktop's.
  expect(await cuts('terminal'), 'terminal').toEqual([])
})

// ---- The band holds still (2026-10-10) ----------------------------------------------------------

const BAND_ACTIONS = { toggleAuto: () => undefined, toggleWarm: () => undefined, compact: () => undefined, clear: () => undefined, handoff: () => undefined, toggleLog: () => undefined, toggleAgents: () => undefined, openSettings: () => undefined, toggleEffortMenu: () => undefined, pickEffort: () => undefined }
const unhandled = (tree: unknown) => JSON.stringify(tree).replace(/"handle":\d+/g, '')

test('within a minute the band draws the same tree; a minute on, only the countdown changes', async ($, on) => {
  const view: DashboardView = { ...DASH, cache: { expiresAt: NOW + 41 * 60_000 + 30_000, ttlMs: 3_600_000 }, effort: { level: null, mode: 'deciding', since: NOW - 300 } }
  for (const surface of SURFACES) {
    drawPane(on, 'now-' + surface, el => renderBand(el, frameOf(surface), view, BAND_ACTIONS))
    // Twenty-nine seconds on, the judge further along: the same minute shown, so the same tree.
    drawPane(on, 'later-' + surface, el => renderBand(el, { ...frameOf(surface), now: NOW + 29_000 }, { ...view, effort: { ...view.effort, since: NOW - 2_000 } }, BAND_ACTIONS))
    drawPane(on, 'minute-' + surface, el => renderBand(el, { ...frameOf(surface), now: NOW + 31_000 }, view, BAND_ACTIONS))
  }
  for (const surface of SURFACES) {
    const drawn = async (id: string) => unhandled(await (await mount($, id, surface)).drawn())
    const now = await drawn('now-' + surface)
    expect(now).toContain('"42m"')
    expect(await drawn('later-' + surface)).toBe(now)
    expect((await drawn('minute-' + surface)).replace(/\b41m\b/g, '42m')).toBe(now)
  }
})

test('while it works the current runs along the capsule\'s true bottom, in a picture of its own that a redraw keeps', async ($, on) => {
  const working = (live: number, total: number, extra: Partial<DashboardView> = {}): DashboardView => ({ ...DASH, isWorking: true, agents: { live, total }, ...extra })
  const busy = working(1, 1)
  // The same band a moment on, with more requests out and every row it can add (the pin, the
  // limits, the effort menu): nothing in the current depends on any of it.
  const more = working(2, 3, { effortMenu: true, delegationPin: 'Opus', extras: ['limits'], limits: [{ provider: 'claude', account: 0, kind: 'five_hour', label: '', percent: 28 }] })
  for (const skin of SKINS) {
    drawPane(on, 'current-' + skin, el => renderBand(el, frameOf('desktop', 94, 12, skin), busy, BAND_ACTIONS))
    drawPane(on, 'current-more-' + skin, el => renderBand(el, frameOf('desktop', 94, 12, skin), more, BAND_ACTIONS))
    drawPane(on, 'current-idle-' + skin, el => renderBand(el, frameOf('desktop', 94, 12, skin), DASH, BAND_ACTIONS))
  }
  /** The pictures that carry `part` of a drawing (the current's class, the sea's glows). */
  const pictures = async (ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }, part: string) =>
    (await ui.findAll({ type: 'Svg' })).map(picture => String(picture.props.source)).filter(source => source.includes(part))
  for (const skin of SKINS) {
    const ui = await mount($, 'current-' + skin, 'desktop', 94)
    const later = await mount($, 'current-more-' + skin, 'desktop', 94)
    const idle = await mount($, 'current-idle-' + skin, 'desktop', 94)
    // Only the deep has water for a current to run in; a band at rest has none.
    expect(await pictures(ui, 'class="cu"'), skin).toHaveLength(skin === 'deep' ? 1 : 0)
    expect(await pictures(idle, 'class="cu"'), skin + ' at rest').toHaveLength(0)
    const line = await ui.find({ key: 'band-current' })
    if (skin === 'deep') {
      // A separate placed node at the capsule's own bottom: no `top`, and no `height` of its own,
      // which the host takes in whole rows and painted as a plate over the band.
      expect(line?.props).toMatchObject({ position: 'absolute', bottom: 0, left: 0 })
      expect(line?.props.top).toBeUndefined()
      expect(line?.props.height).toBeUndefined()
      expect(line?.props.backgroundColor).toBeUndefined()
      // The line is its picture's own 2 px, so the picture, not the Box, sizes it.
      expect((await pictures(ui, 'class="cu"'))[0]).toMatch(/\sheight="2"/)
    } else expect(line).toBeUndefined()
    // No wash over the band: nothing is painted in the colour of the plate that was there.
    const plates: string[] = []
    for (const mounted of [ui, later, idle]) walk(await mounted.drawn(), n => {
      if (n.type === 'Box' && String(n.props?.backgroundColor ?? '').includes('103,232,249')) plates.push(String(n.props?.key ?? 'Box'))
    })
    expect(plates, skin).toEqual([])
    // Not in the sea's picture: its height is only an estimate of the capsule's.
    const seas = await pictures(ui, 'class="br"')
    expect(seas, skin).toHaveLength(skin === 'deep' ? 1 : 0)
    for (const source of seas) expect(source).not.toContain('class="cu"')
    if (skin === 'deep') {
      // Two frames that differ only in the requests out: the same key and the same document, so a
      // host that keeps the picture keeps its motion; no negative delay to open it part way.
      expect(await pictures(later, 'class="cu"')).toEqual(await pictures(ui, 'class="cu"'))
      expect(await later.find({ key: 'band-current' })).toBeDefined()
      expect(await later.find({ key: 'pic-band-current' })).toBeDefined()
      expect((await pictures(ui, 'class="cu"'))[0]).not.toContain('animation-delay')
    }
    await ui.unmount()
    await later.unmount()
    await idle.unmount()
  }
})

test('리플이 acts out the band: thinking, working, drowsy, asleep or idle, one fixed source per mood in a slot that never moves', async ($, on) => {
  const cache = (minutes: number) => ({ cache: { expiresAt: NOW + minutes * 60_000 - 1, ttlMs: 3_600_000 } })
  const cases: [string, DashboardView, ReturnType<typeof bandMood>][] = [
    ['idle', DASH, { face: 'calm', dim: false }],
    ['deciding', { ...DASH, effort: { level: null, mode: 'deciding' }, isWorking: true }, { face: 'thinking', dim: false }],
    ['working', { ...DASH, isWorking: true, ...cache(2) }, { face: 'working', dim: false }],
    ['drowsy-4', { ...DASH, ...cache(4) }, { face: 'drowsy', dim: false }],
    ['drowsy-2', { ...DASH, ...cache(2) }, { face: 'drowsy', dim: false }],
    ['held', { ...DASH, ...cache(2), warm: { on: true, pings: 1, cost: 0 } }, { face: 'calm', dim: false }],
    ['short-life', { ...DASH, cache: { expiresAt: NOW + 3 * 60_000, ttlMs: 300_000 } }, { face: 'calm', dim: false }],
    ['asleep', { ...DASH, cache: { expiresAt: NOW - 1, ttlMs: 3_600_000 } }, { face: 'sleepy', dim: false }],
    ['off', { ...DASH, effort: { level: 'high', mode: 'off' } }, { face: 'calm', dim: true }],
  ]
  for (const [id, view, mood] of cases) {
    expect(bandMood(frameOf('desktop'), view), id).toEqual(mood)
    drawPane(on, 'mood-' + id, el => renderBand(el, frameOf('desktop'), view, BAND_ACTIONS))
  }
  const sources: Record<string, string> = {}
  for (const [id, , mood] of cases) {
    const ui = await mount($, 'mood-' + id, 'desktop')
    const tree = await ui.drawn()
    const found = mascots(tree)
    expect(found.length, id).toBe(1)
    expect(ownPx(found[0]!), id).toBe(BAND_RIPPLE)
    expect(found[0]!.props?.isInteractive, id).toBeFalsy()
    sources[id] = String(found[0]!.props?.source)
    // Drawn for the capsule's dark water whatever the app's theme.
    expect(sources[id], id).toBe(rippleSource(mood.face, BAND_RIPPLE, 'dark', undefined, mood.dim))
    // The mini drawing below 34 px: every part in the tone, no ink face.
    expect(/="var\(--ink\)"/.test(sources[id]!), id).toBe(false)
    expect((await ui.find({ type: 'Box', key: 'band-crest' }))?.props.width, id).toBe(CREST_CELLS)
    await ui.unmount()
  }
  // The source changes with the mood alone: four minutes or two, drowsy is one picture.
  expect(sources['drowsy-4']).toBe(sources['drowsy-2'])
  expect(new Set(Object.values(sources)).size).toBe(6)
})

/** Each fact's slot width and each control's label, by key, as drawn. */
function layoutOf(tree: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  walk(tree, n => {
    const key = String(n.props?.key ?? '')
    if (n.type === 'Box' && key.startsWith('fact-')) out[key] = n.props?.width
    if (n.type === 'Button' && ['auto', 'warm', 'log', 'agents', 'settings'].includes(key)) out[key] = typeof n.props?.label === 'string' ? [...n.props.label].map(c => (/[●○·0-9]/.test(c) ? '#' : c)).join('') : n.props?.label
  })
  return out
}

// The host sends what the phone queued when the turn ends; the Claude app never sees it, so a strip
// over the band says it is there, on both surfaces, its first message on one line (2026-10-22).
test('the phone queue strip draws on both surfaces with its count, first message and when', async ($, on) => {
  for (const surface of SURFACES) drawPane(on, 'queue-' + surface, el => renderPhoneQueue(el, frameOf(surface), { count: 2, first: 'fix the\nheader' }))
  for (const surface of SURFACES) {
    const drawn = JSON.stringify(await (await mount($, 'queue-' + surface, surface)).drawn())
    expect(drawn).toContain('Phone queue 2')
    expect(drawn).toContain('fix the header')
    expect(drawn).toContain('goes when this turn ends')
  }
})

test('no value moves a neighbour: every slot keeps its width whatever it shows', async ($, on) => {
  const levels: DashboardView['effort'][] = [
    ...(['low', 'medium', 'high', 'xhigh', 'max'] as const).flatMap(level => [{ level, mode: 'auto' as const, why: 'w' }, { level, mode: 'manual' as const }]),
    { level: null, mode: 'deciding' }, { level: 'high', mode: 'paused' }, { level: null, mode: 'off' },
  ]
  const caches: DashboardView['cache'][] = [{ expiresAt: NOW + 3_600_000, ttlMs: 3_600_000 }, { expiresAt: NOW + 9 * 60_000, ttlMs: 3_600_000 }, { expiresAt: NOW + 20_000, ttlMs: 300_000 }, { expiresAt: NOW - 1, ttlMs: 300_000 }, null]
  const routes: Pick<DashboardView, 'route' | 'notice'>[] = [
    { route: DASH.route, notice: null },
    { route: { ...DASH.route!, model: 'a-very-long-routed-model-name (and-what-was-asked)', cachePct: 100 }, notice: null },
    { route: { ...DASH.route!, ok: false, status: '429', cachePct: undefined }, notice: null },
    { route: { ...DASH.route!, ok: false, resent: true, status: '529' }, notice: null },
    { route: null, notice: 'ClaudeRipple: router not answering' },
  ]
  const views: DashboardView[] = [
    ...levels.map(effort => ({ ...DASH, effort })),
    ...caches.map(cache => ({ ...DASH, cache })),
    ...routes.map(r => ({ ...DASH, ...r })),
    { ...DASH, agents: { live: 2, total: 3 }, agentsOpen: true, logOpen: true, auto: false, warm: { on: true, pings: 12, cost: 0, stopped: 'no cache' } },
    { ...DASH, context: { percent: 100, tokens: 200_000, window: 200_000 } },
  ]
  const LANGS = ['en', 'ko', 'ja', 'es'] as const
  for (const lang of LANGS) {
    for (const surface of SURFACES) {
      // A terminal wide enough for the reason's slot, a desktop band of ~1000 px.
      for (const [i, view] of views.entries()) drawPane(on, lang + '-' + surface + '-' + i, el => renderBand(el, { ...frameOf(surface, surface === 'terminal' ? 200 : 110), lang }, view, BAND_ACTIONS))
    }
  }
  for (const lang of LANGS) {
    for (const surface of SURFACES) {
      const seen: Record<string, unknown> = {}
      // The drawn band's effort and context take the value shown, and the agents icon its badge only
      // while it has a count, tight (2026-10-25): what follows moves. Everything else keeps its width.
      const tight = surface === 'desktop' ? ['fact-effort', 'fact-context', 'agents'] : []
      for (let i = 0; i < views.length; i++) {
        const ui = await mount($, lang + '-' + surface + '-' + i, surface, 110)
        for (const [key, value] of Object.entries(layoutOf(await ui.drawn()))) {
          if (key in seen && !tight.includes(key)) expect(value, lang + ' ' + surface + ' view ' + i + ' ' + key).toEqual(seen[key])
          else seen[key] = value
        }
        await ui.unmount()
      }
      // A wide enough terminal keeps a slot for the reason, blank while there is none.
      const why = surface === 'terminal' ? ['fact-why'] : []
      expect(Object.keys(seen).sort()).toEqual(['agents', 'auto', 'fact-cache', 'fact-context', 'fact-effort', 'fact-route', ...why, ...(surface === 'terminal' ? ['log'] : []), 'settings', 'warm'])
    }
  }
})

test('the band names the mode that is on, cut to a slot of its own that keeps its width', async ($, on) => {
  expect(modeLabel('Burn GPT')).toBe('Burn GPT')
  expect(modeLabel('Burn the GPT quota before it resets')).toBe('Burn the GP…')
  expect(modeLabel('클로드는 지휘만 하기')).toBe('클로드는 지…')
  const names = ['Burn GPT', 'Burn the GPT quota before it resets', '클로드는 지휘만 하기']
  for (const surface of SURFACES) {
    for (const [i, mode] of names.entries()) drawPane(on, 'mode-' + surface + '-' + i, el => renderBand(el, frameOf(surface), { ...DASH, mode }, BAND_ACTIONS))
    drawPane(on, 'mode-' + surface + '-none', el => renderBand(el, frameOf(surface), DASH, BAND_ACTIONS))
  }
  for (const surface of SURFACES) {
    const widths = new Set<unknown>()
    for (const [i, name] of names.entries()) {
      const ui = await mount($, 'mode-' + surface + '-' + i, surface)
      const shown = surface === 'desktop' ? modeLabel(name) : 'Mode ' + modeLabel(name)
      expect(await ui.find({ type: 'Text', text: shown }), surface + ' ' + name).toBeDefined()
      // The whole name is in the hover card on the desktop.
      if (surface === 'desktop') expect(await ui.find({ type: 'Text', text: 'Mode “' + name + '” is on: the workers follow it. Change it in quick settings.' })).toBeDefined()
      widths.add(layoutOf(await ui.drawn())['fact-mode'])
      await ui.unmount()
    }
    expect(widths.size, surface).toBe(1)
    const none = await mount($, 'mode-' + surface + '-none', surface)
    expect(layoutOf(await none.drawn())['fact-mode']).toBeUndefined()
    await none.unmount()
  }
})

test('the desktop band keeps the route and every control in one row at 770 px (Chinese), 830 px (Korean, English, Japanese), 870 px (Spanish, Portuguese)', async ($, on) => {
  // The band counts every slot at a fixed width (never by value), drops the controls' words, then
  // the quietest facts, until the route and the controls fit; the reason takes what is left.
  // The Clear and Compact icons joined the row (2026-10-14), so the narrowest window grew by
  // about a control: Hangul labels are the widest, so Korean moved to 830.
  const busy: DashboardView = { ...DASH, effort: { level: 'xhigh', mode: 'manual' }, agents: { live: 2, total: 3 }, warm: { on: true, pings: 3, cost: 0 } }
  const langs = Object.keys(STRINGS) as (keyof typeof STRINGS)[]
  // Cells counted at 8.8 px (the 14 px measure the band used before, 2026-10-10): a margin over
  // the host's 7.917 px for the site's padding and the band's own border.
  const columns = (lang: string) => Math.floor((lang === 'es' || lang === 'pt' ? 870 : lang === 'zh' ? 770 : lang === 'ko' || lang === 'en' || lang === 'ja' ? 830 : 770) / 8.8)
  for (const lang of langs) drawPane(on, 'row-' + lang, el => renderBand(el, { ...frameOf('desktop', columns(lang)), lang }, busy, { ...BAND_ACTIONS, hide: () => undefined }))
  for (const lang of langs) {
    const ui = await mount($, 'row-' + lang, 'desktop', columns(lang))
    expect(await ui.find({ type: 'Box', key: 'fact-route' }), lang).toBeDefined()
    expect(await ui.find({ type: 'Box', key: 'fact-effort' }), lang).toBeDefined()
    for (const key of ['handoff', 'auto', 'warm', 'agents', 'settings', 'hide']) expect(await ui.find({ type: 'Button', key }), lang + ' ' + key).toBeDefined()
    await ui.unmount()
  }
})

// 2026-10-14: Auto's word is the control itself (the switch picture is gone): pressing the word
// toggles, and the state is in its own drawing — lit violet while on, a quiet ghost while off.
test('the Auto word toggles on press and draws its state', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { ...BAND_ACTIONS, toggleAuto: fn('auto') }
  drawPane(on, 'word-auto', el => renderBand(el, frameOf('desktop'), DASH, actions))
  drawPane(on, 'word-auto-off', el => renderBand(el, frameOf('desktop'), { ...DASH, auto: false }, actions))
  const on_ = await mount($, 'word-auto', 'desktop')
  // Lit while on: the picture's root class reads on; the old switch is gone.
  expect(await on_.find({ type: 'Box', key: 'word-on-auto' })).toBeDefined()
  expect(await on_.findAll({ type: 'Svg' }).then(list => list.some(svg => svg.props.alt === 'Auto' && String(svg.props.source).includes('class="on"')))).toBe(true)
  // The press is on the word itself: it reaches the toggle.
  await on_.press({ key: 'auto' })
  expect(calls).toEqual(['auto'])
  await on_.unmount()
  // Off, the same slot draws the quiet ghost instead of the lit pill.
  const off = await mount($, 'word-auto-off', 'desktop')
  expect(await off.find({ type: 'Box', key: 'ghost-auto' })).toBeDefined()
  expect(await off.findAll({ type: 'Svg' }).then(list => list.some(svg => svg.props.alt === 'Auto' && String(svg.props.source).includes('class="off"')))).toBe(true)
  await off.unmount()
})

// 2026-10-14: at the band's narrowest real width (94 columns) everything asked of the band holds:
// the limit and the new icons stay; Handoff, Auto and the way out draw with them.
test('at 94 columns the limit is drawn beside the new controls', async ($, on) => {
  const busy: DashboardView = { ...DASH, limit: { kind: 'seven_day', percent: 42, resetsAt: '2026-10-10T15:40:00', save: false }, extras: ['context', 'limits'] }
  drawPane(on, 'n94', el => renderBand(el, frameOf('desktop', 94), busy, { ...BAND_ACTIONS, hide: () => undefined }))
  const ui = await mount($, 'n94', 'desktop', 94)
  expect(await ui.find({ type: 'Box', key: 'fact-limit' }), 'limit at 94').toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'fact-cache' }), 'cache at 94').toBeDefined()
  expect(await ui.find({ type: 'Box', key: 'fact-effort' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'route' })).toBeDefined()
  for (const key of ['handoff', 'auto', 'warm', 'agents', 'compact', 'clear', 'settings', 'hide']) expect(await ui.find({ type: 'Button', key }), key + ' at 94').toBeDefined()
  await ui.unmount()
})

/** Every tip as drawn: the words it shows, and the hover that reveals it. */
function tipsOf(tree: unknown): { text: string; display: unknown; scope: string | undefined }[] {
  const out: { text: string; display: unknown; scope: string | undefined }[] = []
  walk(tree, n => {
    const hover = (n as Drawn & { hover?: { scope?: string; display?: string } }).hover
    if (n.type !== 'Box' || n.props?.display !== 'none' || hover?.display !== 'flex' || !hover.scope) return
    const shown = [...walkText(n)]
    out.push({ text: shown.join(''), display: n.props?.display, scope: hover?.scope })
  })
  return out
}
function* walkText(node: unknown): Generator<string> {
  if (typeof node === 'string') { yield node; return }
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const c of node) yield* walkText(c); return }
  const n = node as Drawn
  if (n.type === 'Text') yield (n.children ?? []).join('')
  for (const c of n.children ?? []) yield* walkText(c)
}

// 2026-10-14: at the band's real width (100 columns) every slot is drawn and the row leaves nothing
// free, so a tip must not depend on that free room; each rests hidden (and carries no `key`: a keyed
// Box drawn display "none" is refused as a hover scope) and reveals through the scope its fact or
// control joins, so a control's tip shows in a full band.
test('a control\'s tip is drawn in a full band, hidden and revealed by its scope', async ($, on) => {
  const busy: DashboardView = { ...DASH, limit: { kind: 'seven_day', percent: 42, resetsAt: '2026-10-10T15:40:00', save: false }, extras: ['context', 'limits'] }
  drawPane(on, 'n100', el => renderBand(el, frameOf('desktop', 100), busy, { ...BAND_ACTIONS, hide: () => undefined }))
  const ui = await mount($, 'n100', 'desktop', 100)
  const tree = await ui.drawn()
  const tips = tipsOf(tree)
  // One tip per fact and control (the effort, the context, the cache, the limit, and every control
  // but Handoff, which names itself in its pill) plus the way out — the row is full and all are drawn. The route has none: it lights as a
  // button, and the log it opens is its card (028aee5).
  expect(tips.length, 'tips: ' + tips.map(t => t.text.slice(0, 14)).join(' / ')).toBe(11)
  const words = (start: string) => tips.find(tip => tip.text.startsWith(start))
  expect(words('Last route')).toBeUndefined()
  for (const start of ['Opus 5.5 · Auto', 'Context 38%', 'Prompt cache', 'Weekly limit 42%', 'Effort Auto', 'Keep cache warm', 'Agents:', 'Compact — ', 'New start (/clear) — ', 'Ripple settings', 'Hide the band']) {
    expect(words(start), start).toBeDefined()
  }
  for (const tip of tips) {
    expect(tip.display, tip.text).toBe('none')
    expect(typeof tip.scope, tip.text).toBe('string')
  }
  // Hovering the compact control (its own hover carries the same scope) reveals the compact tip.
  const compact = words('Compact — ')!
  const joined = JSON.stringify(tree).includes('"scope":"' + compact.scope + '"')
  expect(joined, 'the compact control joins its tip\'s scope').toBe(true)
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
  await ui.unmount()
})

test('with the limits row drawn, save mode\'s word follows Claude\'s windows', async ($, on) => {
  const limits: DashboardView['limits'] = [
    { provider: 'claude', account: 0, kind: 'five_hour', label: '', percent: 86 },
    { provider: 'claude', account: 0, kind: 'seven_day', label: '', percent: 40 },
  ]
  const view = (save: boolean): DashboardView => ({ ...DASH, limit: { kind: 'five_hour', percent: 86, save }, limits, extras: ['limits'] })
  drawPane(on, 'saving', el => renderBand(el, frameOf('desktop', 100), view(true), BAND_ACTIONS))
  drawPane(on, 'spending', el => renderBand(el, frameOf('desktop', 100), view(false), BAND_ACTIONS))
  const saving = await mount($, 'saving', 'desktop', 100)
  expect(await saving.find({ type: 'Text', text: /^save$/ }), 'save word').toBeDefined()
  // The first row's limit stepped aside: 86% shows once, in the limits row.
  const at86 = await saving.findAll({ type: 'Text', text: /^86%$/ })
  expect(at86.length).toBe(1)
  await saving.unmount()
  const spending = await mount($, 'spending', 'desktop', 100)
  expect(await spending.find({ type: 'Text', text: /^save$/ })).toBeUndefined()
  await spending.unmount()
})


// 2026-10-25: the owner moved the reset times off the band into a pane the row opens. 2026-10-29:
// that pane was a bare table of "4시간 뒤" and "수 15:35"; it now says each reset's exact local date
// and time to the minute and the time left, both, under its provider account's head, with the
// window closest to its cap first, a passed reset and a missing one said plainly, and save mode's
// end. NOW is Saturday 10 October 2026, 13:20 local.
test('the limits pane names each window\'s exact reset and the time left', async ($, on) => {
  const limits = [
    { provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'five_hour' as const, label: '', percent: 28, resetsAt: new Date(NOW + 2 * 3_600_000 + 12 * 60_000).toISOString() },
    { provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'seven_day' as const, label: '', percent: 8, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
    { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 0, kind: 'five_hour' as const, label: '', windowMinutes: 300, percent: 12, resetsAt: new Date(NOW + 45 * 60_000).toISOString() },
    { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 1, kind: 'five_hour' as const, label: '', windowMinutes: 300, percent: 64, resetsAt: new Date(NOW - 15 * 60_000).toISOString() },
    { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 1, kind: 'seven_day' as const, label: '', windowMinutes: 10080, percent: 97 },
  ]
  const { calls, fn } = recorder()
  const actions = { close: fn('close') }
  const view = { items: limits, saveUntil: NOW + 2 * 3_600_000 }
  // Every pane answered before the first mount: the hooks beneath the plugins register first.
  for (const surface of SURFACES) {
    drawPane(on, 'limits-' + surface, el => renderLimits(el, { ...frameOf(surface, 80), lang: 'ko' }, view, actions))
    drawPane(on, 'limits-none-' + surface, el => renderLimits(el, { ...frameOf(surface, 80), lang: 'ko' }, { items: [] }, actions))
  }
  drawPane(on, 'limits-en', el => renderLimits(el, frameOf('desktop', 80), view, actions))
  for (const surface of SURFACES) {
    const ui = await mount($, 'limits-' + surface, surface, 80)
    const said = (await ui.findAll({ type: 'Text' })).map(text => text.text).join('\n')
    for (const text of [
      '플랜 한도',
      // One head per provider account, numbered when a provider has several.
      'Claude', 'GPT 1', 'GPT 2',
      // Every share, and how many windows are at 80% or more.
      '28%', '8%', '12%', '64%', '97%', '사용률이 80% 이상인 한도가 1개 있습니다.',
      // Each reset to the minute in local time, and the time left.
      '10월 10일 (토) 오후 3:32 초기화', '2시간 12분 남음',
      '10월 13일 (화) 오후 1:20 초기화', '3일 남음',
      '10월 10일 (토) 오후 2:05 초기화', '45분 남음',
      // A reset already passed says so; a window without one says that.
      '초기화 시간(10월 10일 (토) 오후 1:05)이 지났습니다.', '표시된 사용률은 초기화 전 값일 수 있습니다.',
      '이 한도는 초기화 시간을 확인할 수 없습니다.',
      // Save mode, under Claude's own windows, until when it holds.
      '절약 모드가 켜져 있습니다. 10월 10일 (토) 오후 3:20까지 자동 추론 강도를 중간 이하로 유지합니다.',
    ]) expect(said, surface + ' ' + text).toContain(text)
    // Save mode is Claude's alone.
    expect(said.split('절약 모드가 켜져 있습니다.').length - 1, surface).toBe(1)
    await ui.press({ key: 'limits-close' })
    await ui.unmount()
    const none = await mount($, 'limits-none-' + surface, surface, 80)
    expect(await none.find({ type: 'Text', text: '아직 한도 사용량을 확인할 수 없습니다.' }), surface).toBeDefined()
    await none.unmount()
  }
  expect(calls).toEqual(['close', 'close'])
  // The desktop heads the pane with the window closest to its cap, as a dial and in words, and draws
  // each share as a bar.
  const desktop = await mount($, 'limits-desktop', 'desktop', 80)
  expect(await desktop.find({ type: 'Text', text: '최고 사용률' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: 'GPT 2 주간 97%' })).toBeDefined()
  expect(await svgByAlt(desktop, '최고 사용률 GPT 2 주간 97%')).toBeDefined()
  for (const alt of ['5시간 28%', '주간 8%', '5시간 12%', '5시간 64%', '주간 97%']) expect(await svgByAlt(desktop, alt), alt).toBeDefined()
  await desktop.unmount()
  const en = await mount($, 'limits-en', 'desktop', 80)
  const english = (await en.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  for (const text of ['Plan limits', 'Resets Sat, Oct 10, 3:32 PM', '2h 12m left', 'Resets Tue, Oct 13, 1:20 PM', '3d left', 'Its reset time (Sat, Oct 10, 1:05 PM) has passed.', 'One window is at 80% or more.']) expect(english, text).toContain(text)
  await en.unmount()
})

// 2026-10-25: the row itself is the way in. It lights under the pointer and says what pressing it
// shows; the reset times are no longer written on it.
test('the desktop limits row is a button that opens the limits pane', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { ...BAND_ACTIONS, toggleLimits: fn('limits') }
  const limits: DashboardView['limits'] = [
    { provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'five_hour', label: '', percent: 28, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() },
    { provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'seven_day', label: '', percent: 8, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
  ]
  drawPane(on, 'limits-row', el => renderBand(el, { ...frameOf('desktop', 94), lang: 'ko' }, { ...DASH, extras: ['limits'], limits }, actions))
  const ui = await mount($, 'limits-row', 'desktop', 94)
  expect(await ui.find({ type: 'Button', key: 'limits-open' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '눌러서 기간별 사용률과 초기화 시간 보기' })).toBeDefined()
  // The shares are on the row; the reset times are the pane's.
  for (const figure of ['28%', '8%']) expect(await ui.find({ type: 'Text', text: figure }), figure).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /뒤$/ })).toBeUndefined()
  await ui.press({ key: 'limits-open' })
  expect(calls).toEqual(['limits'])
  await ui.unmount()
})

// 2026-10-29: the row's light sat in an empty absolute Box laid over it, which the app never drew:
// every other button on the band showed a box under the pointer and the limits row none. The row
// now carries the same light as the effort chip, in flow, with no vertical air, and gives back the
// light's round edge from the air above it so the band keeps its height and the figures their place.
test('the pressable limits row lights as the band\'s other buttons do, at the same height', async ($, on) => {
  const limits: DashboardView['limits'] = [
    { provider: 'claude', account: 0, kind: 'five_hour', label: '', percent: 28 },
    { provider: 'chatgpt', account: 0, kind: 'seven_day', label: '', percent: 8 },
  ]
  for (const skin of SKINS) for (const columns of [94, 200]) for (const active of [false, true]) {
    const id = ['limits-height', skin, columns, active].join('-')
    drawPane(on, id, el => renderBand(el, frameOf('desktop', columns, 12, skin), { ...DASH, extras: ['limits'], limits }, { ...BAND_ACTIONS, ...(active ? { toggleLimits: () => undefined } : {}) }))
  }
  for (const skin of SKINS) for (const columns of [94, 200]) {
    const at: { left: number; top: number }[] = []
    for (const active of [false, true]) {
      const ui = await mount($, ['limits-height', skin, columns, active].join('-'), 'desktop', columns)
      // A drawn node carries its hover beside its props.
      const nodes = new Map<string, Drawn & { hover?: Record<string, unknown> }>()
      walk(await ui.drawn(), n => { if (typeof n.props?.key === 'string') nodes.set(n.props.key, n) })
      const outer = nodes.get('band-limits')!.props!
      const rowNode = nodes.get('limits-row')!
      const row = rowNode.props!
      expect(nodes.has('limits-light')).toBe(false)
      if (active) {
        // The effort chip's light, in the same skin: its edge at rest and under the pointer.
        const effortNode = nodes.get('fact-effort')!
        expect(row.borderStyle, skin).toBe(effortNode.props!.borderStyle)
        expect(row.borderColor, skin).toBe(effortNode.props!.borderColor)
        const { scope: _effortScope, ...effortHover } = effortNode.hover!
        const { scope, ...rowHover } = rowNode.hover!
        expect(rowHover, skin).toEqual(effortHover)
        expect(scope).toBe('ripple-tip-limits-open')
        // No host air above or below the figures; a fact's air either side.
        expect(row.paddingY).toBe(0)
        expect(row.paddingX).toBe(0.5)
        expect(await ui.find({ type: 'Button', key: 'limits-open' })).toBeDefined()
      } else expect(row.borderStyle).toBeUndefined()
      at.push({ left: (outer.paddingLeft as number) + ((row.paddingX as number | undefined) ?? 0), top: (outer.paddingTop as number) + (active ? 2 / (19 / 2) : 0) })
      await ui.unmount()
    }
    // The figures start where they did, and the row with its edge is as tall as it was.
    expect(Math.abs(at[1]!.left - at[0]!.left) < 1e-9, skin + ' ' + columns + ' left').toBe(true)
    expect(Math.abs(at[1]!.top - at[0]!.top) < 1e-9, skin + ' ' + columns + ' top').toBe(true)
  }
})

// ---- Tool runs (2026-10-20: a worker's commands read as a wall, each wrapped over lines) ------------

test('a run of tool calls is headed in one line as the Claude app heads it', () => {
  const call = (id: string, tool: string, detail: string, state: 'ok' | 'error' | 'running' = 'ok') => ({ id, tool, detail, state })
  const run = [call('1', 'Bash', 'npm test'), call('2', 'Read', 'a.ts'), call('3', 'Read', 'a.ts'), call('4', 'Bash', 'ls', 'error'), call('5', 'Edit', 'a.ts')]
  // A file read twice counts once; a read and an edit of one file count in each kind.
  // The Claude app's own Korean (2026-10-24): "실행됨 명령 20개, 읽음 파일 15개".
  expect(runSummary(run, 'ko')).toEqual({ text: '실행됨 명령 2개, 읽음 파일 1개, 편집함 파일 1개', failed: 1 })
  // The app's English: the first word capitalised, the rest as written.
  expect(runSummary(run.slice(0, 2), 'en')).toEqual({ text: 'Ran a command, read a file', failed: 0 })
  expect(runSummary([call('1', 'Bash', 'a'), call('2', 'Bash', 'b')], 'es').text).toBe('2 comandos ejecutados')
  expect(runSummary([call('1', 'Bash', 'a')], 'es').text).toBe('1 comando ejecutado')
  // Every kind shown, in the order they came, but the tools the app has no kind for last
  // (2026-10-24: ours led with "사용함 도구 2개" where the app's view beside it ended with it).
  // A search, a lookup and a browse name no count; a page fetched twice counts once.
  const kinds = [call('0', 'ToolSearch', 'q'), call('1', 'Bash', 'x'), call('2', 'Read', 'a'), call('3', 'Write', 'b'), call('4', 'Grep', 'c'), call('5', 'WebFetch', 'd'), call('6', 'WebFetch', 'd'), call('7', 'Skill', 's'), call('8', 'Glob', 'g'), call('9', 'Agent', 'w')]
  expect(runSummary(kinds, 'ko').text).toBe('실행됨 명령 1개, 읽음 파일 1개, 생성됨 파일 1개, 검색함 코드, 가져옴 페이지 1개, 찾음 파일, 실행됨 에이전트 1개, 사용함 도구 2개')
  expect(runSummary(kinds, 'en').text).toBe('Ran a command, read a file, created a file, searched code, fetched a page, found files, ran an agent, used 2 tools')
})

test('an edit counts the lines it adds and removes from what the model sent, and a run sums its answered edits', () => {
  expect(editLines('Edit', { old_string: 'a\nb\nc\nd', new_string: 'a\nB\nc\nd\ne' })).toEqual({ added: 2, removed: 1 })
  expect(editLines('Edit', { old_string: 'x\n', new_string: 'x\n' })).toEqual({ added: 0, removed: 0 })
  // A Write's every line is added; a MultiEdit sums its pairs; other tools count nothing.
  expect(editLines('Write', { content: 'one\ntwo\nthree\n' })).toEqual({ added: 3, removed: 0 })
  expect(editLines('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: '' }] })).toEqual({ added: 1, removed: 3 })
  expect(editLines('Bash', { command: 'ls' })).toBeUndefined()
  const call = (id: string, state: 'ok' | 'error' | 'running', added: number, removed: number) => ({ id, tool: 'Edit', detail: 'a.ts', state, added, removed })
  expect(runDiff([call('1', 'ok', 40, 300), call('2', 'ok', 12, 80), call('3', 'error', 5, 5), call('4', 'running', 7, 7)])).toEqual({ added: 52, removed: 380 })
  expect(runDiff([{ id: '1', tool: 'Bash', detail: 'ls', state: 'ok' }])).toBeUndefined()
  // talkOf carries the counts on the edit's entry, and nothing on any other call.
  expect(talkOf([{ role: 'assistant', text: '', toolUses: [
    { tool_use_id: 'e', tool: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b\nc' }, text: 'ok' },
    { tool_use_id: 'r', tool: 'Read', input: { file_path: '/a.ts' }, text: 'ok' },
  ] }])).toEqual([
    { kind: 'tool', id: 'e', tool: 'Edit', detail: '/a.ts', state: 'ok', added: 2, removed: 1 },
    { kind: 'tool', id: 'r', tool: 'Read', detail: '/a.ts', state: 'ok' },
  ])
})

test('a run is one quiet line in the app\'s words, its edits\' lines in a chip after it, with no mark and no failure count', async ($, on) => {
  const talk: AgentEntry[] = [
    { kind: 'prompt', text: 'Remove the feature.' },
    ...Array.from({ length: 7 }, (_, i): AgentEntry => ({ kind: 'tool', id: 'c' + i, tool: 'Bash', detail: 'grep -rn x', state: i === 2 ? 'error' : 'ok' })),
    ...Array.from({ length: 9 }, (_, i): AgentEntry => ({ kind: 'tool', id: 'd' + i, tool: 'Edit', detail: 'f' + i + '.ts', state: 'ok', added: i === 0 ? 4 : 6, removed: i === 0 ? 44 : 42 })),
    ...Array.from({ length: 3 }, (_, i): AgentEntry => ({ kind: 'tool', id: 'e' + i, tool: 'Read', detail: 'r' + i + '.ts', state: 'ok' })),
  ]
  const done: AgentRec = { ...AGENTS[0]!, state: 'done', endedAt: NOW - 1000 }
  drawPane(on, 'chip-ko', el => renderAgents(el, { ...frameOf('desktop', 64), lang: 'ko' }, { agents: [done], now: NOW, showDone: false, open: { id: 'a1', talk: { entries: talk } } }, AGENT_NOOP))
  drawPane(on, 'chip-open', el => renderAgents(el, { ...frameOf('desktop', 64), lang: 'ko' }, { agents: [done], now: NOW, showDone: false, open: { id: 'a1', talk: { entries: talk }, runsOpen: ['c0'] } }, AGENT_NOOP))
  const ui = await mount($, 'chip-ko', 'desktop', 64)
  expect(await ui.find({ type: 'Text', text: '실행됨 명령 7개, 편집함 파일 9개, 읽음 파일 3개' })).toBeDefined()
  // The words carry no hover of their own: lit words and the press's light fought under a still
  // pointer and the line flickered (2026-10-25). The press over the line is its one hover.
  const lit: unknown[] = []
  walk(await ui.drawn(), n => { if (n.type === 'Text' && (n.children ?? []).join('') === '실행됨 명령 7개, 편집함 파일 9개, 읽음 파일 3개') lit.push((n as { hover?: unknown }).hover) })
  expect(lit).toEqual([undefined])
  const chip = await svgByAlt(ui, '52줄 추가, 380줄 삭제')
  expect(chip).toBeDefined()
  expect(String(chip?.props.source)).toContain('+52')
  expect(String(chip?.props.source)).toContain('−380')
  expect(await ui.find({ type: 'Text', text: '1개 실패' })).toBeUndefined()
  // The agent's own card keeps its ✓; nothing marks the run.
  expect(await ui.find({ type: 'Text', text: '✕' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'run-c0' })).toBeDefined()
  // Unfolded, the failed call is still told apart in red.
  const open = await mount($, 'chip-open', 'desktop', 64)
  expect(await open.findAll({ type: 'Text', text: '✕' })).toHaveLength(1)
})

test('a call reads as one short line: no leading cd, paths short, a command\'s description first', () => {
  const place = { cwd: '/Users/pbj/Documents/tabripple', home: '/Users/pbj' }
  expect(commandLine('cd /Users/pbj/Documents/tabripple/android && ./gradlew :core:test -q 2>&1 | grep -vE "^w:"', place)).toBe('./gradlew :core:test -q 2>&1 | grep -vE "^w:"')
  expect(commandLine('cd "/tmp/a b"; npm test', place)).toBe('npm test')
  expect(commandLine('cd android\n./gradlew build', place)).toBe('./gradlew build')
  expect(commandLine('cat > /Users/pbj/Documents/tabripple/notes.md <<\'EOF\'\nline one\nEOF', place)).toBe('cat > notes.md <<\'EOF\'')
  expect(commandLine('ls /Users/pbj/Documents/tabripple /Users/pbj/.gradle /Users/pbj/Documents/tabripple2', place)).toBe('ls . ~/.gradle ~/Documents/tabripple2')
  expect(shortPath('/Users/pbj/Documents/tabripple/app/Main.kt', place)).toBe('app/Main.kt')
  expect(shortPath('/Users/pbj/.zshrc', place)).toBe('~/.zshrc')
  expect(shortPath('/etc/hosts', place)).toBe('/etc/hosts')
  expect(shortPath('/Users/pbj/x', { home: '~' })).toBe('/Users/pbj/x')
  expect(toolDetail('Bash', { command: 'cd /x && npm test', description: 'Run the unit tests\nquietly' }, place)).toBe('Run the unit tests')
  expect(toolDetail('Bash', { command: 'cd /x && npm test', description: '' }, place)).toBe('npm test')
  expect(toolDetail('Edit', { file_path: '/Users/pbj/Documents/tabripple/core/A.kt' }, place)).toBe('core/A.kt')
  expect(toolDetail('Grep', { pattern: 'TODO', path: '/Users/pbj/Documents/tabripple/core' }, place)).toBe('TODO · core')
  expect(talkOf([{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: '/Users/pbj/Documents/tabripple/a.kt' }, text: 'ok' }] }], place))
    .toEqual([{ kind: 'tool', id: 'u1', tool: 'Read', detail: 'a.kt', state: 'ok' }])
})

test('a run of calls folds into its head, unfolds call by call when pressed; a single call stays one line on the terminal and is a run of one on the desktop', async ($, on) => {
  const { calls, fn } = recorder()
  const actions = { ...AGENT_NOOP, toggleRun: fn('run') }
  const bash = (i: number, state: 'ok' | 'error' = 'ok'): AgentEntry => ({ kind: 'tool', id: 'b' + i, tool: 'Bash', detail: commandLine('cd /Users/pbj/Documents/tabripple/android && ./gradlew :core:test --tests "*Parser*" -q 2>&1 | grep -vE "^(w:|warning)" | tail -40 # run ' + i), state })
  const talk: AgentEntry[] = [
    { kind: 'prompt', text: 'Fix the parser tests.' },
    { kind: 'text', text: 'Running the suite.' },
    ...Array.from({ length: 8 }, (_, i) => bash(i, i === 3 ? 'error' : 'ok')),
    { kind: 'tool', id: 'e1', tool: 'Edit', detail: 'core/src/Parser.kt', state: 'ok' },
    { kind: 'text', text: 'One more check.' },
    { kind: 'tool', id: 'solo', tool: 'Bash', detail: 'git status', state: 'ok' },
  ]
  const done: AgentRec = { ...AGENTS[0]!, id: 'a9', state: 'done', endedAt: NOW - 1000, now: undefined, toolSince: undefined }
  drawPane(on, 'runs-folded', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: [done], now: NOW, showDone: false, open: { id: 'a9', talk: { entries: talk } } }, actions))
  drawPane(on, 'runs-open', (el, surface) => renderAgents(el, frameOf(surface, 64), { agents: [done], now: NOW, showDone: false, open: { id: 'a9', talk: { entries: talk }, runsOpen: ['b0'] } }, actions))
  for (const surface of SURFACES) {
    const folded = await mount($, 'runs-folded', surface, 64)
    expect(await folded.find({ type: surface === 'desktop' ? 'Text' : 'Button', text: /^Ran 8 commands, edited a file/ }), surface).toBeDefined()
    expect(await folded.find({ type: 'Text', text: '1 failed' }) !== undefined, surface).toBe(surface === 'terminal')
    // Folded, none of its calls show. The single call after the words: on the terminal its own
    // line, no head; on the desktop a run of one, as the Claude app draws it.
    const desktop = surface === 'desktop'
    expect(await folded.findAll({ type: 'Text', text: /^Bash$/ }), surface).toHaveLength(desktop ? 0 : 1)
    expect(await folded.find({ type: 'Text', text: 'git status' }) !== undefined, surface).toBe(!desktop)
    expect(await folded.find({ type: 'Button', key: 'run-solo' }) !== undefined, surface).toBe(desktop)
    if (desktop) expect(await folded.find({ type: 'Text', text: 'Ran a command' }), surface).toBeDefined()
    await folded.press({ key: 'run-b0' })
    const open = await mount($, 'runs-open', surface, 64)
    expect(await open.findAll({ type: 'Text', text: /^Bash$/ }), surface).toHaveLength(desktop ? 8 : 9)
    expect(await open.find({ type: 'Text', text: /^Edit$/ }), surface).toBeDefined()
    // Each call one line, its cd gone, cut with an ellipsis before the pane's edge.
    const details = (await open.findAll({ type: 'Text', text: /gradlew/ })).map(d => d.text)
    expect(details, surface).toHaveLength(8)
    for (const detail of details) {
      expect(detail.startsWith('./gradlew :core:test'), detail).toBe(true)
      expect(detail.endsWith('…'), detail).toBe(true)
      // Narrower than the 64-cell pane in the surface's own measure: cells there, the sans's ch here.
      expect((surface === 'desktop' ? chOf(detail) : displayWidth(detail)) < 64, surface + ' ' + detail).toBe(true)
    }
    await open.press({ key: 'run-b0' })
  }
  expect(calls).toEqual(['run:["b0"]', 'run:["b0"]', 'run:["b0"]', 'run:["b0"]'])
})

// ---- The cards hold still (2026-10-20: titles re-wrapped as the time ticked, and the pane jumped) --

const STILL_TITLE = 'Port the request log renderer to the new kit and keep every test green while doing it'
const STILL_AGENT: AgentRec = { ...AGENTS[0]!, description: STILL_TITLE, model: 'deepseek-ai/deepseek-v4.1-flash-1017@high', answeredBy: 'deepseek-ai/deepseek-v4.1-flash-1017', provider: 'deepseek' }
/** Each pair: the agent's elapsed time before and after one second (a tick, 59s → 1m, 9m 59s → 10m). */
const STILL_PAIRS: [number, number][] = [[192_000, 193_000], [59_000, 60_000], [599_000, 600_000]]
/** Pane widths: ~560 px, ~360 px, ~260 px. */
const STILL_COLUMNS = [68, 44, 33]
const STILL_LANGS = ['en', 'ko', 'es'] as const
const stillId = (lang: string, columns: number, i: number, side: string, page: string) => ['still', page, lang, columns, i, side].join('-')
/** The list's row, and the open conversation's card that carries the figures (2026-10-24). */
const STILL_PAGES = ['list', 'open'] as const
const stillView = (page: string, rec: AgentRec, now: number): AgentsView => ({ agents: [rec], now, showDone: false, ...(page === 'open' ? { open: { id: rec.id, talk: { entries: [] } } } : {}) })

test('a running row and card draw the same tree a tick on and across 59s → 1m 00s and 9m 59s → 10m 00s, but for its time, wide and narrow', async ($, on) => {
  for (const page of STILL_PAGES) {
    for (const lang of STILL_LANGS) {
      for (const columns of STILL_COLUMNS) {
        for (const [i, [before, after]] of STILL_PAIRS.entries()) {
          const agent: AgentRec = { ...STILL_AGENT, startedAt: NOW - before }
          // A step on, the agent is in another tool: neither the row nor the card may show it.
          const later: AgentRec = { ...agent, now: 'Edit hooks/ui/log.tsx', toolSince: NOW + 500 }
          for (const [side, ms, rec] of [['a', 0, agent], ['b', after - before, later]] as const) {
            drawPane(on, stillId(lang, columns, i, side, page), el => renderAgents(el, { ...frameOf('desktop', columns), lang, now: NOW + ms }, stillView(page, rec, NOW + ms), AGENT_NOOP))
          }
        }
      }
    }
  }
  drawPane(on, 'still-fresh', el => renderAgents(el, frameOf('desktop', 68), stillView('open', { ...STILL_AGENT, id: 'a0', usage: undefined, tools: undefined, now: undefined, toolSince: undefined }, NOW), AGENT_NOOP))
  for (const page of STILL_PAGES) for (const lang of STILL_LANGS) {
    for (const columns of STILL_COLUMNS) {
      for (const [i, [before, after]] of STILL_PAIRS.entries()) {
        const at = (s: string) => stillId(lang, columns, i, s, page)
        const times = [elapsed(before, lang), elapsed(after, lang)]
        expect(times[0], at('')).not.toBe(times[1])
        const masked = async (side: string) => {
          const ui = await mount($, at(side), 'desktop', columns)
          const tree = unhandled(await ui.drawn()).split(JSON.stringify(times[0])).join('"#"').split(JSON.stringify(times[1])).join('"#"')
          await ui.unmount()
          return tree
        }
        expect(await masked('b'), at('')).toBe(await masked('a'))
      }
    }
  }
  // The open card's second row is there from the start, a dash for each figure not yet reported.
  const fresh = await mount($, 'still-fresh', 'desktop', 68)
  expect(await fresh.findAll({ type: 'Text', text: /^–$/ })).toHaveLength(2)
  expect(await fresh.find({ type: 'Text', text: /^0$/ })).toBeDefined()
  for (const lang of ['en', 'ko', 'zh', 'ja', 'es', 'pt'] as const) {
    for (const columns of STILL_COLUMNS) {
      const frame = { ...frameOf('desktop', columns), lang }
      // The time's column holds its widest value in every language.
      for (const ms of [59_000, 3_599_000, 99 * 3_600_000 + 59 * 60_000]) expect(chOf(elapsed(ms, lang)) <= timeCells(frame, STILL_AGENT), lang + ' ' + elapsed(ms, lang)).toBe(true)
      // Growing figures never add a row.
      expect(cardRows(frame, STILL_AGENT), lang + ' ' + columns).toBe(cardRows(frame, { ...STILL_AGENT, usage: { input: 9_900_000, cached: 90_000_000, cacheWrite: 0, output: 99_000_000 }, tools: 999 }))
    }
  }
})

test('a narrow card keeps its model on one line without the vendor path, and the same two body rows as a wide one', async ($, on) => {
  const why = 'session model · General / Standard'
  const agent: AgentRec = { ...STILL_AGENT, pick: { ...STILL_AGENT.pick!, why, by: 'session' } }
  // The card heads an open conversation; the title is the page's head row there.
  drawPane(on, 'narrow-card', el => renderAgents(el, { ...frameOf('desktop', 33), lang: 'ko' }, stillView('open', agent, NOW), AGENT_NOOP))
  drawPane(on, 'wide-card', el => renderAgents(el, { ...frameOf('desktop', 68), lang: 'ko' }, stillView('open', agent, NOW), AGENT_NOOP))
  const narrow = await mount($, 'narrow-card', 'desktop', 33)
  const wide = await mount($, 'wide-card', 'desktop', 68)
  for (const [side, ui] of [['narrow', narrow], ['wide', wide]] as const) {
    // No vendor path, and no pick line.
    expect(await ui.find({ type: 'Text', text: /deepseek-ai\// }), side + ' vendor').toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^deep/ }), side + ' model').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /표준/ }), side + ' level').toBeUndefined()
    expect(await ui.find({ type: 'Text', text: why }), side + ' why').toBeUndefined()
  }
  // Neither width pre-cuts the name: the whole string is drawn and the engine ellipsis it at the
  // edge when its row is short, since the app's type is proportional.
  for (const [side, ui] of [['narrow', narrow], ['wide', wide]] as const) {
    const model = await ui.find({ type: 'Text', text: 'deepseek-v4.1-flash-1017' })
    expect(model?.props.wrap, side + ' model cut').toBe('truncate-end')
  }
  for (const [side, ui] of [['narrow', narrow], ['wide', wide]] as const) {
    expect(await ui.find({ key: 'model-row' }), side + ' model row').toBeDefined()
    expect(await ui.find({ key: 'nums' }), side + ' numbers row').toBeDefined()
    expect(await ui.find({ key: 'nums-1' }), side + ' no second numbers row').toBeUndefined()
    expect(await ui.find({ key: 'open-head-end' }), side + ' time in the head').toBeDefined()
  }
  expect(await narrow.find({ type: 'Text', text: '3분 12초' }), 'time').toBeDefined()
  // The time never takes a row of its own, and the title is the whole string, one line the engine cuts.
  for (const ui of [narrow, wide]) expect(await ui.find({ key: 'time-row' })).toBeUndefined()
  const title = await narrow.find({ type: 'Text', text: STILL_TITLE })
  expect(title?.props.wrap, 'title cut').toBe('truncate-end')
})
