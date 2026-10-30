// The Context pane (hooks/ui/context.tsx): drawn from a breakdown in /context's shape on every
// surface and skin, its presses reaching their callbacks, the band's context chip opening it, and
// register.tsx drawing it from `$.session.usage({ breakdown })`.

import { expect, mock, test } from 'claude-code/testing'
import type { ContextGridSquare, RenderElement, RenderPropsOf, SessionContextBreakdown } from 'claude-code'

import { renderBand } from '../hooks/ui/band'
import { CONTEXT_SHOWN, renderContext } from '../hooks/ui/context'
import type { ContextActions, ContextView } from '../hooks/ui/context'
import { SVG_MAX_PX } from '../hooks/ui/art'
import type { BandActions, DashboardView, Frame, Surface } from '../hooks/ui/view'
import type { Skin } from '../types'

const NOW = Date.parse('2026-10-24T13:20:00')
const MAX = 160_000

/** The categories as the engine reports them (2.1.304's names and theme keys). */
const CATEGORIES: SessionContextBreakdown['categories'] = [
  { name: 'System prompt', tokens: 3100, color: 'promptBorder', isDeferred: false, kind: 'used' },
  { name: 'System tools', tokens: 14_800, color: 'inactive', isDeferred: false, kind: 'used' },
  { name: 'MCP tools', tokens: 6200, color: 'cyan_FOR_SUBAGENTS_ONLY', isDeferred: false, kind: 'used' },
  { name: 'MCP tools (deferred)', tokens: 21_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
  { name: 'Custom agents', tokens: 1900, color: 'permission', isDeferred: false, kind: 'used' },
  { name: 'Memory files', tokens: 4100, color: 'claude', isDeferred: false, kind: 'used' },
  { name: 'Skills', tokens: 2600, color: 'warning', isDeferred: false, kind: 'used' },
  { name: 'Messages', tokens: 41_200, color: 'purple_FOR_SUBAGENTS_ONLY', isDeferred: false, kind: 'used' },
  { name: 'Free space', tokens: 70_100, color: 'promptBorder', isDeferred: false, kind: 'free' },
  { name: 'Autocompact buffer', tokens: 16_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
]

/** /context's 10 by 10 grid for those categories: each a run of squares, its last one part full. */
function gridOf(categories: SessionContextBreakdown['categories']): ContextGridSquare[][] {
  const squares: ContextGridSquare[] = []
  const per = MAX / 100
  for (const c of categories.filter(c => c.kind !== 'deferred')) {
    const exact = c.tokens / per
    const count = Math.max(1, Math.round(exact))
    for (let i = 0; i < count && squares.length < 100; i++) {
      squares.push({ color: c.color, isFilled: c.kind !== 'free', categoryName: c.name, tokens: c.tokens, percentage: Math.round((c.tokens / MAX) * 100), squareFullness: i === count - 1 && exact % 1 > 0 ? exact % 1 : 1 })
    }
  }
  while (squares.length < 100) squares.push({ color: 'promptBorder', isFilled: false, categoryName: 'Free space', tokens: 0, percentage: 0, squareFullness: 1 })
  return Array.from({ length: 10 }, (_, y) => squares.slice(y * 10, y * 10 + 10))
}

const BREAKDOWN: SessionContextBreakdown = {
  categories: CATEGORIES,
  totalTokens: 73_900,
  maxTokens: MAX,
  rawMaxTokens: MAX,
  autocompactSource: 'model-default',
  percentage: 46,
  gridRows: gridOf(CATEGORIES),
  model: 'claude-opus-5-5',
  memoryFiles: [
    { path: '/work/CLAUDE.md', type: 'Project', tokens: 1800 },
    { path: '/home/test/.claude/CLAUDE.md', type: 'User', tokens: 2100 },
    { path: '/home/test/.claude/projects/work/memory/MEMORY.md', type: 'AutoMem', tokens: 200 },
  ],
  mcpTools: [
    ...Array.from({ length: 8 }, (_, i) => ({ name: 'mcp__linear__tool_' + i, serverName: 'linear', tokens: 500, isLoaded: true })),
    ...Array.from({ length: 6 }, (_, i) => ({ name: 'mcp__browser__tool_' + i, serverName: 'browser', tokens: 366, isLoaded: true })),
    ...Array.from({ length: 20 }, (_, i) => ({ name: 'mcp__gmail__tool_' + i, serverName: 'gmail', tokens: 1050, isLoaded: false })),
  ],
  agents: ['gpt-6-1-sol', 'gpt-6-astra', 'deepseek-v4-1-flash', 'gemini-3-8-flash', 'ripple:auto', 'statusline-setup'].map((agentType, i) => ({ agentType, source: i < 4 ? 'userSettings' : 'plugin', tokens: 420 - i * 30 })),
  slashCommands: { totalCommands: 34, includedCommands: 30, tokens: 1100 },
  skills: {
    totalSkills: 9,
    includedSkills: 8,
    tokens: 2600,
    skillFrontmatter: ['code-discipline', 'seo-os', 'store-release', 'plugin-authoring', 'dataviz', 'docs', 'pdf', 'xlsx'].map((name, i) => ({ name, source: i % 3 ? 'userSettings' : 'plugin', ...(i % 3 ? {} : { pluginName: 'anthropic-skills' }), tokens: 520 - i * 40 })),
  },
  autoCompactThreshold: 144_000,
  isAutoCompactEnabled: true,
  apiUsage: null,
}

const VIEW: ContextView = { breakdown: BREAKDOWN, basis: 'summary', busy: false, precise: true, open: [], place: { cwd: '/work', home: '/home/test' } }

function frameOf(surface: Surface, lang: Frame['lang'] = 'en', skin: Skin = 'deep', columns = 68): Frame {
  return { surface, columns, maxRows: 30, now: NOW, appearance: 'auto', skin, lang }
}

function paneProps(columns: number): RenderPropsOf['Pane'] {
  return { title: 'context', isFocused: true, bodyColumns: columns, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } as RenderPropsOf['Pane']
}

function recorder() {
  const calls: string[] = []
  const actions: ContextActions = { refresh: () => { calls.push('refresh') }, toggle: section => { calls.push('toggle:' + section) }, close: () => { calls.push('close') } }
  return { calls, actions }
}

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
function walk(node: unknown, visit: (n: Drawn) => void): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  const n = node as Drawn
  visit(n)
  for (const child of n.children ?? []) walk(child, visit)
}

test('the Context pane draws the breakdown on the terminal and the desktop, in either skin', async ($, on) => {
  const { calls, actions } = recorder()
  const cases: { id: string; surface: Surface; lang: Frame['lang']; skin: Skin; columns: number }[] = [
    { id: 'ctx-term', surface: 'terminal', lang: 'en', skin: 'deep', columns: 100 },
    { id: 'ctx-deep', surface: 'desktop', lang: 'en', skin: 'deep', columns: 68 },
    { id: 'ctx-flat', surface: 'desktop', lang: 'ko', skin: 'flat', columns: 68 },
    { id: 'ctx-narrow', surface: 'desktop', lang: 'ko', skin: 'deep', columns: 40 },
  ]
  for (const c of cases) on('ui.render', { component: 'Pane', requestId: c.id }, ($, e) => renderContext($.ui.resolve(e), frameOf(e.surface, c.lang, c.skin, c.columns), VIEW, actions) as RenderElement)
  for (const c of cases) {
    const ui = await $.ui.mount({ plugin: 'test', surface: c.surface, component: 'Pane', requestId: c.id, props: paneProps(c.columns), viewport: { columns: c.columns, rows: 40 } })
    const L = c.lang === 'ko'
    expect(await ui.find({ type: 'Text', text: L ? '컨텍스트 구성' : 'Context breakdown' }), c.id).toBeDefined()
    // Every category by the person's words; the deferred tools named as not counted.
    for (const name of L ? ['메시지', '시스템 도구', '남은 공간', '자동 압축 예비 공간'] : ['Messages', 'System tools', 'Free space', 'Auto-compact buffer']) {
      expect(await ui.find({ type: 'Text', text: new RegExp('^' + name.replace(/[()]/g, '\\$&')) }), c.id + ' ' + name).toBeDefined()
    }
    // A memory file's path short against the session's folder and home.
    expect(await ui.find({ type: 'Text', text: 'CLAUDE.md' }), c.id).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~\/\.claude\/CLAUDE\.md/ }), c.id).toBeDefined()
    // MCP tools by server, the largest first: linear's 4k before browser's 2.2k; gmail's tools wait on demand.
    expect(await ui.find({ type: 'Text', text: /^linear/ }), c.id).toBeDefined()
    expect(await ui.find({ type: 'Text', text: L ? /필요 시 로드 20개/ : /20 on demand/ }), c.id).toBeDefined()
    // Compaction's standing in words.
    expect(await ui.find({ type: 'Text', text: L ? '자동 압축은 144k 토큰에서 실행됩니다.' : 'Auto-compact runs at 144k tokens.' }), c.id).toBeDefined()
    // Eight skills: the largest five, the rest a press away.
    expect(await ui.find({ type: 'Text', text: /^code-discipline/ }), c.id).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^xlsx/ }), c.id).toBeUndefined()
    await ui.press({ key: 'context-more-skills' })
    await ui.press({ key: 'context-refresh' })
    await ui.press({ key: 'context-close' })
    const tree = await ui.drawn()
    if (c.surface === 'desktop') {
      // One dial, one grid, a swatch per legend row; every picture plain and within the engine's limits.
      const svgs: Drawn[] = []
      walk(tree, n => { if (n.type === 'Svg') svgs.push(n) })
      expect(svgs.some(s => s.props?.alt === (L ? '컨텍스트 구성 46%' : 'Context breakdown 46%')), c.id).toBe(true)
      for (const s of svgs) {
        expect(s.props?.isInteractive, c.id).toBeFalsy()
        expect(Number(s.props?.width) <= SVG_MAX_PX && Number(s.props?.height ?? 0) <= SVG_MAX_PX, c.id).toBe(true)
      }
      // Every press a blank one laid over our own drawing: no host Button paints our words.
      walk(tree, n => { if (n.type === 'Button') expect(String(n.props?.label ?? '').trim(), c.id + ' ' + String(n.props?.key)).toBe('') })
    }
    // Nothing is cut by the host: names are shortened by us, never by a truncating Text.
    walk(tree, n => { if (n.type === 'Text') expect(String(n.props?.wrap ?? 'wrap').startsWith('truncate'), c.id).toBe(false) })
    await ui.unmount()
  }
  expect(calls).toEqual(cases.flatMap(() => ['toggle:skills', 'refresh', 'close']))
})

test('a section opened shows all its rows and folds again; a count under way takes no second press', async ($, on) => {
  const { calls, actions } = recorder()
  on('ui.render', { component: 'Pane', requestId: 'ctx-open' }, ($, e) => renderContext($.ui.resolve(e), frameOf(e.surface), { ...VIEW, open: ['skills'], busy: true }, actions) as RenderElement)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'ctx-open', props: paneProps(68), viewport: { columns: 68, rows: 40 } })
    expect(BREAKDOWN.skills!.skillFrontmatter.length).toBeGreaterThan(CONTEXT_SHOWN)
    expect(await ui.find({ type: 'Text', text: /^xlsx/ }), surface).toBeDefined()
    expect((await ui.findAll({ type: 'Svg' })).some(s => s.props.alt === 'Show fewer') || !!await ui.find({ key: 'context-more-skills' }), surface).toBe(true)
    // Busy, the count's control says so and a press does nothing.
    if (surface === 'terminal') expect((await ui.find({ key: 'context-refresh' }))?.props.label).toBe('Counting…')
    else expect((await ui.findAll({ type: 'Svg' })).some(s => s.props.alt === 'Counting…')).toBe(true)
    await ui.press({ key: 'context-refresh' })
    await ui.press({ key: 'context-more-skills' })
    await ui.unmount()
  }
  expect(calls).toEqual(['toggle:skills', 'toggle:skills'])
})

// 2026-10-30: a GPT chat's "precise" count was the router's characters-over-four, item by item.
test('a routed model is offered no precise count, and the estimate stays labelled as one', async ($, on) => {
  const { calls, actions } = recorder()
  on('ui.render', { component: 'Pane', requestId: 'ctx-routed' }, ($, e) => renderContext($.ui.resolve(e), frameOf(e.surface, 'ko'), { ...VIEW, precise: false }, actions) as RenderElement)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'ctx-routed', props: paneProps(68), viewport: { columns: 68, rows: 40 } })
    expect(await ui.find({ key: 'context-refresh' }), surface).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /로컬 추정치/ }), surface).toBeDefined()
    await ui.press({ key: 'context-close' })
    await ui.unmount()
  }
  expect(calls).toEqual(['close', 'close'])
})

test('with no breakdown the pane says so and keeps its way out; a failed count is said in plain words', async ($, on) => {
  const { calls, actions } = recorder()
  on('ui.render', { component: 'Pane', requestId: 'ctx-none' }, ($, e) => renderContext($.ui.resolve(e), frameOf(e.surface, 'ko'), { ...VIEW, breakdown: null, error: 'token count unavailable' }, actions) as RenderElement)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'ctx-none', props: paneProps(68), viewport: { columns: 68, rows: 40 } })
    expect(await ui.find({ type: 'Text', text: '아직 컨텍스트 구성을 확인할 수 없습니다.' }), surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '정밀 계산에 실패했습니다: token count unavailable' }), surface).toBeDefined()
    expect(await ui.find({ key: 'context-refresh' }), surface).toBeUndefined()
    await ui.press({ key: 'context-close' })
    await ui.unmount()
  }
  expect(calls).toEqual(['close', 'close'])
})

const noop = () => undefined
const BAND: BandActions = { toggleAuto: noop, toggleWarm: noop, compact: noop, clear: noop, handoff: noop, toggleLog: noop, toggleAgents: noop, openSettings: noop, toggleEffortMenu: noop, pickEffort: noop }
const DASH: DashboardView = {
  effort: { level: 'high', mode: 'auto' }, model: 'Opus 5.5', context: { percent: 38, tokens: 76_000, window: 200_000 }, cache: null,
  warm: { on: false, pings: 0, cost: 0 }, limit: null, route: null, notice: null, auto: true, agents: { live: 0, total: 0 },
  compactions: 0, logOpen: false, agentsOpen: false, effortMenu: false, hide: [], extras: ['context'], isWorking: false,
}

test('the band\'s context chip is a lit press that opens the pane; without the pane it is a figure', async ($, on) => {
  let opened = 0
  on('ui.render', { component: 'Pane', requestId: 'band-plain' }, ($, e) => renderBand($.ui.resolve(e), frameOf(e.surface, 'ko', 'deep', 100), DASH, BAND) as RenderElement)
  const skins = ['deep', 'flat'] as const
  for (const skin of skins) {
    on('ui.render', { component: 'Pane', requestId: 'band-ctx-' + skin }, ($, e) => renderBand($.ui.resolve(e), frameOf(e.surface, 'ko', skin, 100), DASH, { ...BAND, toggleContext: () => { opened++ } }) as RenderElement)
  }
  for (const skin of skins) {
    const ui = await $.ui.mount({ plugin: 'test', surface: 'desktop', component: 'Pane', requestId: 'band-ctx-' + skin, props: paneProps(100), viewport: { columns: 100, rows: 40 } })
    // The chip's ring and figure are our own drawing, the press a blank button laid over them.
    const button = await ui.find({ type: 'Button', key: 'context' })
    expect(String(button?.props.label ?? 'x').trim(), skin).toBe('')
    expect(await ui.find({ type: 'Text', text: '38%' }), skin).toBeDefined()
    // Lit under the pointer as the controls are, so it reads as a button.
    // (the light's edge rests transparent; the host keeps `hover` itself out of the drawn props)
    expect((await ui.find({ type: 'Box', key: 'fact-context' }))?.props.borderStyle, skin).toBe('round')
    // The tip leaves out the share the chip shows, so it fits its room; it starts past the chip
    // rather than over it, so the press and the light stay the chip's.
    expect(await ui.find({ type: 'Text', text: '76k / 200k 토큰 · 눌러서 자세히 보기' }), skin).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tip-context' }), skin).toBeUndefined()
    await ui.press({ key: 'context' })
    await ui.unmount()
  }
  const plain = await $.ui.mount({ plugin: 'test', surface: 'desktop', component: 'Pane', requestId: 'band-plain', props: paneProps(100), viewport: { columns: 100, rows: 40 } })
  expect(await plain.find({ type: 'Button', key: 'context' })).toBeUndefined()
  expect((await plain.find({ type: 'Box', key: 'fact-context' }))?.props.borderStyle).toBeUndefined()
  expect(await plain.find({ type: 'Text', text: '38%' })).toBeDefined()
  expect(await plain.find({ type: 'Text', text: /^컨텍스트 38% \/ 200k/ })).toBeDefined()
  await plain.unmount()
  expect(opened).toBe(2)
})

test('register.tsx draws the pane from the session\'s summary breakdown and counts precisely on press', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  const asked: string[] = []
  let failFull = false
  on('session.usage', ($, e) => {
    asked.push(e.breakdown ?? 'none')
    if (e.breakdown === 'full' && failFull) return { deny: 'token count unavailable' }
    const breakdown = e.breakdown === 'full' ? { ...BREAKDOWN, totalTokens: 81_300 } : BREAKDOWN
    return { value: { startedAt: NOW, context: { window: 200_000, ...(e.breakdown ? { breakdown } : {}) }, rateLimits: [] } }
  })
  // The precise count's key names the model it counted (register.tsx countContext).
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('http.fetch', () => ({ value: { ok: false, status: 503, headers: {}, text: '' } }))
  const mount = (surface: Surface) => $.ui.mount({ plugin: 'ripple', surface, component: 'Pane', requestId: 'ripple-context', props: paneProps(80), viewport: { columns: 80, rows: 40 } })
  // The terminal asks for the grid at its own width.
  const text = await mount('terminal')
  expect(asked).toEqual(['summary'])
  expect(await text.find({ type: 'Text', text: /^74k \/ 160k tokens \(46%\)$/ })).toBeDefined()
  await text.unmount()
  asked.length = 0
  const ui = await mount('desktop')
  expect(asked).toEqual(['summary'])
  expect(await ui.find({ type: 'Text', text: 'Context breakdown' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Local estimate/ })).toBeDefined()
  await ui.press({ key: 'context-refresh' })
  expect(asked).toContain('full')
  // Drawn again from the precise count, not from an estimate asked for over it.
  expect(await ui.find({ type: 'Text', text: /Counted by the token-count API/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '81k' })).toBeDefined()
  // A count that fails says why, over the estimate.
  failFull = true
  await ui.press({ key: 'context-refresh' })
  expect(await ui.find({ type: 'Text', text: /^Precise count failed: / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Local estimate/ })).toBeDefined()
  await ui.press({ key: 'context-close' })
  await ui.unmount()
})
