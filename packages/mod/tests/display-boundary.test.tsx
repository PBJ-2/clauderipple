import { expect, mock, test } from 'claude-code/testing'
import type { RenderElement, RenderNode, RenderPropsOf } from 'claude-code'
import type { AgentRec, StatusRequest } from '../types'
import { normalizeSettings } from '../hooks/settings'
import { renderAgents } from '../hooks/ui/agents'
import { renderAlert } from '../hooks/ui/alerts'
import { renderBand, renderFooter } from '../hooks/ui/band'
import { renderLog } from '../hooks/ui/log'
import { renderPhoneQueue } from '../hooks/ui/queue'
import { renderSettings } from '../hooks/ui/settings'
import { renderSetup } from '../hooks/ui/setup'
import { DISPLAY, displayChars, displayText } from '../hooks/ui/display'
import type { AlertActions, BandActions, DashboardView, Frame, SettingsActions } from '../hooks/ui/view'

const noop = () => undefined
const SETTINGS = normalizeSettings({ setupDone: true, language: 'ko', judge: 'jev', jevSource: 'typesafe' })
const PROPS: RenderPropsOf['Pane'] = { title: '경계', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} }
const frame = (surface: Frame['surface'], columns = 100): Frame => ({ surface, columns, maxRows: 30, now: 1_000_000, lang: 'ko', skin: 'deep', appearance: 'auto' })
const BAND: BandActions = { toggleAuto: noop, toggleWarm: noop, compact: noop, clear: noop, handoff: noop, toggleLog: noop, toggleAgents: noop, openSettings: noop, toggleEffortMenu: noop, pickEffort: noop, releaseDelegationPin: noop }
const ALERT: AlertActions = { compact: noop, clear: noop, dismiss: noop, toggleSave: noop, openSettings: noop, noteInput: noop, toggleTidy: noop, pickCompactModel: noop, copy: noop }
const QUICK: SettingsActions = { patch: noop, jevKey: noop, testJev: noop, openAllSettings: noop, close: noop }
const DASH: DashboardView = { effort: { level: 'high', mode: 'auto' }, model: 'Opus', context: null, cache: null, warm: { on: false, pings: 0, cost: 0 }, limit: null, route: null, notice: null, auto: true, agents: { live: 0, total: 0 }, compactions: 0, logOpen: false, agentsOpen: false, effortMenu: false, hide: [], extras: [], isWorking: false }
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const HUGE = '긴 내용'.repeat(30_000)
const CONTROL = '앞\x1b[31m빨강\x1b[0m\x00\x07\x7f\x85뒤'
const record = (i: number, note: string): StatusRequest => ({ at: new Date(1_000_000 - i * 1000).toISOString(), source: 'model-' + i, target: 'model-' + i, provider: 'chatgpt', status: 500, ok: false, ms: 10, note })
const AGENTS: AgentRec[] = Array.from({ length: 40 }, (_, i) => ({ id: 'a' + i, description: '검토 ' + i, model: 'gpt-6.1-sol', type: 'general-purpose', state: 'running', startedAt: 1, cost: 0, tools: 10, usage: { input: 100, cached: 200, cacheWrite: 0, output: 50 } }))

test('the display boundary removes escape payloads and refused controls without splitting emoji or changing ordinary text', () => {
  expect(displayText('안녕 café é 😀\n다음\t줄')).toBe('안녕 café é 😀\n다음\t줄')
  expect(displayText(CONTROL)).toBe('앞빨강뒤')
  expect(displayText('앞\x1b]8;;https://example.com\x07링크\x1b]8;;\x1b\\뒤')).toBe('앞링크뒤')
  expect(displayText('앞\x1bP숨긴 내용\x1b\\뒤')).toBe('앞뒤')
  expect(displayText('앞\x9d숨긴 내용\x9c뒤')).toBe('앞뒤')
  expect(displayText('앞\ud800뒤\u{10eeee}')).toBe('앞뒤')
  expect(displayText('😀😀끝', 4)).toBe('😀…')
  expect(displayText('원문', 0)).toBe('')
  expect(displayText('원문', 1)).toBe('…')
  expect(displayText(HUGE).length).toBe(DISPLAY.preview)
})

test('wide agent panes keep all forty cards and clickable open controls without space strips', async ($, on) => {
  const opened: string[] = []
  on('ui.render', { component: 'Pane', requestId: 'wide' }, ($, e) => renderAgents($.ui.resolve(e), frame(e.surface, e.props.bodyColumns), { agents: AGENTS, now: 1_000_000, showDone: true }, { open: id => { opened.push(id) }, back: noop, toggleDone: noop, toggleRun: noop }) as RenderElement)
  for (const surface of ['desktop', 'vscode'] as const) for (const columns of [200, 300, 600]) {
    const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'wide', props: { ...PROPS, bodyColumns: columns } })
    for (let i = 0; i < 40; i++) {
      expect(await ui.find({ type: 'Text', text: '검토 ' + i }), surface + ' ' + columns + ' card ' + i).toBeDefined()
      const buttons = await ui.findAll({ type: 'Button' })
      const open = buttons.find(b => String(b.props.key).startsWith('open-a' + i + '-') || b.props.key === 'open-a' + i)
      expect(open).toBeDefined()
      await ui.press({ key: String(open!.props.key) })
    }
    await ui.unmount()
  }
  expect(opened.length).toBe(240)
})

test('a 120000 character phone queue preview leaves the following band controls pressable', async ($, on) => {
  let presses = 0
  on('ui.render', { component: 'Pane', requestId: 'queue-budget' }, ($, e) => {
    const el = $.ui.resolve(e), f = frame(e.surface)
    return <el.Box flexDirection="column">{renderPhoneQueue(el, f, { count: 1, first: '메'.repeat(120_000) })}{renderBand(el, f, DASH, { ...BAND, openSettings: () => { presses++ } })}</el.Box>
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'queue-budget', props: PROPS })
    expect(await ui.find({ key: 'settings' })).toBeDefined()
    await ui.press({ key: 'settings' })
    await ui.unmount()
  }
  expect(presses).toBe(4)
})

test('external controls and ANSI are removed before every surface builds its tree', async ($, on) => {
  on('ui.render', { component: 'Pane', requestId: /^controls-/ }, ($, e) => {
    const el = $.ui.resolve(e), f = frame(e.surface)
    const jev = { source: null, test: { state: 'fail' as const, message: CONTROL } }
    const draws: Record<string, () => RenderNode> = {
      log: () => renderLog(el, f, { rows: [record(0, CONTROL)], mineOnly: false }, { toggleScope: noop }),
      queue: () => renderPhoneQueue(el, f, { count: 1, first: CONTROL }),
      alert: () => renderAlert(el, f, { kind: 'judgeDown', judge: 'jev', reason: CONTROL }, ALERT),
      settings: () => renderSettings(el, f, { settings: SETTINGS, jev }, QUICK),
      setup: () => renderSetup(el, f, { step: 1, draft: SETTINGS, jev }, { ...QUICK, back: noop, next: noop, finish: noop, skip: noop }),
      agents: () => renderAgents(el, f, { agents: [{ ...AGENTS[0]!, description: CONTROL }], now: f.now, showDone: true }, { open: noop, back: noop, toggleDone: noop, toggleRun: noop }),
      band: () => renderBand(el, f, { ...DASH, delegationPin: CONTROL, delegationSaid: CONTROL, effort: { level: 'high', mode: 'auto', why: CONTROL } }, BAND),
    }
    return draws[e.requestId!.slice(9)]!() as RenderElement
  })
  for (const surface of SURFACES) for (const name of ['log', 'queue', 'alert', 'settings', 'setup', 'agents', 'band']) {
    const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'controls-' + name, props: PROPS })
    expect((await ui.findAll({ type: 'Text' })).length > 0, surface + ' ' + name).toBe(true)
    expect(JSON.stringify(await ui.drawn())).not.toContain('[31m')
    await ui.unmount()
  }
})

test('long judge failures and pinned names never consume settings dismiss or release controls', async ($, on) => {
  let pressed = 0
  on('ui.render', { component: 'Pane', requestId: /^long-/ }, ($, e) => {
    const el = $.ui.resolve(e), f = frame(e.surface)
    const a = { ...BAND, releaseDelegationPin: () => { pressed++ } }
    if (e.requestId === 'long-alert') return renderAlert(el, f, { kind: 'judgeDown', judge: 'jev', reason: HUGE }, { ...ALERT, dismiss: () => { pressed++ }, openSettings: () => { pressed++ } }) as RenderElement
    const d = { ...DASH, delegationPin: HUGE, delegationSaid: HUGE }
    return (e.requestId === 'long-footer' ? renderFooter(el, f, d, a) : renderBand(el, f, d, a)) as RenderElement
  })
  for (const surface of SURFACES) for (const name of ['alert', 'pin', 'footer']) {
    const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'long-' + name, props: PROPS })
    for (const key of name === 'alert' ? ['settings', 'dismiss'] : ['release-pin']) {
      expect(await ui.find({ key })).toBeDefined()
      await ui.press({ key })
    }
    await ui.unmount()
  }
  expect(pressed).toBe(16)
})

test('sixty long request failures and judge errors retain the oldest record within a shared text budget', async ($, on) => {
  on('ui.render', { component: 'Pane', requestId: 'log-budget' }, ($, e) => {
    const tree = renderLog($.ui.resolve(e), frame(e.surface), {
      rows: Array.from({ length: 60 }, (_, i) => record(i, '오'.repeat(2000))), mineOnly: true,
      judges: Array.from({ length: 40 }, (_, i) => ({ at: 1_000_001 + i, for: 'prompt', asked: 'jev', by: 'haiku', ms: 1, error: HUGE })),
    }, { toggleScope: noop })
    expect(displayChars(tree) <= DISPLAY.log + 1000).toBe(true)
    return tree as RenderElement
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'log-budget', props: PROPS })
    expect(await ui.find({ type: 'Text', text: 'model-59' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text' })).some(t => String(t.text).includes('…'))).toBe(true)
    await ui.unmount()
  }
})

test('a huge routed model cannot exceed Box width or remove the band', async ($, on) => {
  on('ui.render', { component: 'Pane', requestId: 'route-width' }, ($, e) => renderBand($.ui.resolve(e), frame(e.surface), { ...DASH, route: { model: HUGE, provider: 'chatgpt', ok: true, resent: false, status: '200', seconds: 1 } }, BAND) as RenderElement)
  for (const surface of ['desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'route-width', props: PROPS })
    expect(await ui.find({ key: 'settings' })).toBeDefined()
    for (const box of await ui.findAll({ type: 'Box' })) if (typeof box.props.width === 'number') expect(box.props.width <= 10_000).toBe(true)
    await ui.unmount()
  }
})

for (const failedKey of ['lang', 'settings', 'phoneQueue', 'judgeDown', 'jev', 'setupStep', 'requests']) {
  test('state failure ' + failedKey + ' draws a usable fallback and recovers without re-reading failed state', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    let failed = true, reads = 0, closed = 0
    const defaults: Record<string, unknown> = { settings: SETTINGS, lang: 'ko', panel: failedKey === 'jev' ? 'settings' : failedKey === 'setupStep' ? 'setup' : null }
    on('state.get', { plugin: 'ripple' }, (_$, e, next) => {
      if (e.key === failedKey && failed) { reads++; return { deny: '상태 읽기 실패' } }
      return e.key in defaults ? { value: { value: defaults[e.key], version: 0 } } : next(e)
    })
    on('ui.log', () => ({ value: undefined }))
    on('ui.close', () => { closed++; return { value: undefined } })
    const site = failedKey === 'requests' ? { component: 'Pane' as const, requestId: 'ripple-log', props: PROPS } : { component: 'AbovePrompt' as const, props: { bodyColumns: 100, maxRows: 30, scroll: { offset: 0, bodyRows: 30 }, isWorking: false, hasSurvey: false, view: {} } }
    // The band asks for what is drawn under it; the engine alone answers with its own (empty) drawing.
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
    const ui = await $.ui.mount({ plugin: 'ripple', surface: 'desktop', ...site })
    expect(await ui.find({ type: 'Text', text: /상태 읽기 실패/ })).toBeDefined()
    expect(reads).toBe(1)
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.press({ key: 'close' })
    if (failedKey === 'requests') expect(closed).toBe(1)
    await ui.unmount()
    failed = false
    const recovered = await $.ui.mount({ plugin: 'ripple', surface: 'desktop', ...site })
    expect(await recovered.find({ type: 'Text', text: /상태 읽기 실패/ })).toBeUndefined()
    await recovered.unmount()
  })
}

test('SessionMode keeps the engine alongside a state-independent failure view', async ($, on) => {
  on('state.get', { plugin: 'ripple', key: 'settings' }, () => ({ deny: '설정 읽기 실패' }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', { component: 'SessionMode' }, ($, e) => { const { Text } = $.ui.resolve(e); return <Text>엔진 모드</Text> })
  const ui = await $.ui.mount({ plugin: 'ripple', surface: 'terminal', component: 'SessionMode', props: { modes: ['default'] } })
  expect(await ui.find({ type: 'Text', text: /설정 읽기 실패/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '엔진 모드' })).toBeDefined()
  await ui.unmount()
})
