import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import ts from 'typescript'
import type { AgentRec } from '../../packages/mod/types/index.d.ts'
import type { Frame } from '../../packages/mod/hooks/ui/view.ts'

// The engine's JSX factory is an external boundary. Keep its plain tree here; the matching
// packages/mod/tests/agents-boundary.test.tsx mounts these cases through the actual engine too.
type Tree = { type: string; props: Record<string, unknown>; children: (Tree | string)[] }
function h(type: string, props: Record<string, unknown> | null, ...children: unknown[]): Tree {
  const flatten = (value: unknown): (Tree | string)[] => {
    if (Array.isArray(value)) return value.flatMap(flatten)
    if (value === null || value === undefined || typeof value === 'boolean') return []
    return [typeof value === 'number' ? String(value) : value as Tree | string]
  }
  return { type, props: props ?? {}, children: children.flatMap(flatten) }
}
Object.assign(globalThis, { h })
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/packages/mod/hooks/') && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) {
      const url = new URL(specifier, context.parentURL)
      return next(specifier + (existsSync(new URL(url.href + '.tsx')) ? '.tsx' : '.ts'), context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.endsWith('.tsx')) return next(url, context)
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'h' },
    }).outputText }
  },
})
const { cardRows, renderAgents, renderAgentsFallback, TALK_ENTRIES } = await import('../../packages/mod/hooks/ui/agents.tsx')
const el = { Box: 'Box', Text: 'Text', Button: 'Button', Markdown: 'Markdown', Svg: 'Svg' } as Parameters<typeof renderAgents>[0]
const frame: Frame = { surface: 'desktop', columns: 40, maxRows: 30, now: 1_000_000, skin: 'deep', appearance: 'auto', lang: 'ko' }
const actions = { open: (_id: string) => {}, back: () => {}, toggleDone: () => {}, toggleRun: (_id: string) => {} }
const base: AgentRec = {
  id: 'worker', description: '워크트리 격리 검토 · 재개된 에이전트', type: 'ripple:auto', model: 'gpt-6.1-sol@high',
  state: 'running', startedAt: 1, cost: 0, provider: 'chatgpt', effort: 'high', tools: 500,
  usage: { input: 100_000, cached: 900_000, cacheWrite: 1000, output: 50_000 },
}
function nodes(tree: unknown): Tree[] {
  const out: Tree[] = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('type' in value)) return
    const node = value as Tree
    out.push(node)
    node.children.forEach(visit)
  }
  visit(tree)
  return out
}
function textOf(tree: unknown): string {
  return nodes(tree).flatMap(n => [n.props.text ?? '', ...n.children.filter(c => typeof c === 'string')]).join('\n')
}

test('long fallback reasons do not create an unbounded SVG sea or thousands of card press strips', () => {
  const agent: AgentRec = { ...base, pick: { domain: 'general', level: 'standard', effort: 'high', by: 'session', why: '', target: { agent: 'general-purpose' }, rule: 'general', ms: 0, fallbackReason: '사용 한도를 초과했습니다. '.repeat(1000) } }
  assert.ok(cardRows(frame, agent) < 50)
  const records = Array.from({ length: 48 }, (_, i) => ({ ...agent, id: 'w' + i }))
  const tree = renderAgents(el, frame, { agents: records, now: frame.now, showDone: true }, actions)
  const all = nodes(tree)
  assert.ok(all.length < 10_000)
  assert.ok(all.filter(n => n.type === 'Button').length < 2000)
  const chars = all.reduce((n, node) => n + node.children.reduce((sum, child) => sum + (typeof child === 'string' ? child.length : 0), 0) + ['label', 'text', 'alt'].reduce((sum, key) => sum + (typeof node.props[key] === 'string' ? node.props[key].length : 0), 0), 0)
  assert.ok(chars < 90_000, 'rendered characters including blank press strips: ' + chars)
  // The list row holds the model and tokens only (the Claude app's task list); the reason is on
  // the open conversation's card, cut.
  const opened = renderAgents(el, frame, { agents: records, now: frame.now, showDone: true, open: { id: 'w0', talk: { entries: [] } } }, actions)
  assert.ok(textOf(opened).includes('사용 한도를 초과했습니다.'))
  assert.ok(!textOf(opened).includes(agent.pick!.fallbackReason!))
  assert.ok(!textOf(tree).includes(agent.pick!.fallbackReason!))
  for (const svg of all.filter(n => n.type === 'Svg')) {
    assert.ok(Number(svg.props.width) <= 4096)
    assert.ok(Number(svg.props.height ?? 0) <= 4096)
    assert.ok(String(svg.props.source).length <= 131_072)
  }
})

test('48 mixed workers including 31 Workflow workers keep their rows, Korean titles and SVG bounds', () => {
  const agents = Array.from({ length: 48 }, (_, i): AgentRec => ({ ...base, id: 'w' + i, description: '검토 ' + i + ' · 긴 한국어 설명'.repeat(200), state: i < 31 ? 'running' : 'done', endedAt: frame.now - i }))
  for (const skin of ['deep', 'flat'] as const) for (const appearance of ['light', 'dark'] as const) {
    const tree = renderAgents(el, { ...frame, skin, appearance }, { agents, now: frame.now, showDone: true }, actions)
    const all = nodes(tree)
    // Thirty cards at most: the latest thirty running, then the four newest finished.
    assert.equal(all.filter(n => n.props.key === 'card-w1').length, 1)
    assert.equal(all.filter(n => n.props.key === 'card-w34').length, 1)
    assert.equal(all.filter(n => n.props.key === 'card-w0' || n.props.key === 'card-w35').length, 0)
    assert.ok(textOf(tree).includes('검토 34'))
    for (const svg of all.filter(n => n.type === 'Svg')) {
      assert.ok(Number(svg.props.width) <= 4096)
      assert.ok(Number(svg.props.height ?? 0) <= 4096)
    }
  }
})

test('a card is one title line over two body rows at every width, its state on the time instead of a dot', () => {
  const agent: AgentRec = { ...base, description: '긴 제목 '.repeat(200), usage: { input: 1000, cached: 30_000, cacheWrite: 0, output: 200 }, outputTotal: 5200, tools: 23 }
  const widths = [20, 33, 44, 68, 140]
  const heights = widths.map(columns => cardRows({ ...frame, columns }, agent))
  assert.equal(new Set(heights).size, 1, heights.join(','))
  for (const columns of widths) {
    const tree = renderAgents(el, { ...frame, columns }, { agents: [agent], now: frame.now, showDone: false }, actions)
    const all = nodes(tree)
    // The title row lost its state dot; the body is exactly the model's row and the numbers' row.
    assert.equal(all.some(n => n.props.key === 'mark'), false, 'state dot at ' + columns)
    assert.equal(all.filter(n => n.props.key === 'model-row').length, 1)
    assert.equal(all.filter(n => n.props.key === 'nums').length, 1)
    assert.equal(all.filter(n => String(n.props.key).startsWith('nums-')).length, 0)
    // The title is the whole title on one line: the engine cuts it at the edge, since the app's type
    // is proportional. The body starts where the title does, and no number is given a fixed slot.
    const titleBox = all.find(n => n.props.key === 'title')!
    const titleText = titleBox.children.find((c): c is Tree => typeof c !== 'string')!
    assert.equal(titleText.props.wrap, 'truncate-end')
    // The display boundary cuts the shown text at its preview length; the card itself pre-cuts nothing.
    assert.ok(String(titleText.children[0]).startsWith('긴 제목'), String(titleText.children[0]))
    const modelText = all.find(n => n.props.key === 'model-text')!
    assert.equal(modelText.props.wrap, 'truncate-end')
    assert.equal(modelText.children[0], 'gpt-6.1-sol')
    for (const key of ['model-row', 'nums']) assert.equal(all.find(n => n.props.key === key)!.props.paddingLeft, undefined, key)
    // The model's row is the dot, the name and the effort; the tools sit with the numbers below.
    assert.equal(all.some(n => n.props.key === 'tools'), false)
    const numsRow = all.find(n => n.props.key === 'nums')!
    const figureBoxes = numsRow.children.filter((c): c is Tree => typeof c !== 'string' && c.props.position !== 'absolute')
    assert.deepEqual(figureBoxes.map(c => c.props.key), ['n-tokens', 'n-cache', 'n-tools'])
    // Every row of a list card opens the conversation, not only the title (the head's press, then
    // one under the model's row and one under the numbers').
    for (const key of ['model-row', 'nums']) {
      const row = all.find(n => n.props.key === key)!
      assert.ok(row.children.some(c => typeof c !== 'string' && c.props.position === 'absolute'), 'press under ' + key)
    }
    assert.equal(all.some(n => n.props.key === 'value' && typeof n.props.width === 'number'), false)
    // Neither the effort's bars nor the cache's ring is drawn any more.
    assert.equal(all.some(n => n.type === 'Svg' && ['추론 강도', '캐시'].includes(String(n.props.alt))), false)
    // The Claude app's count: the last prompt (1000 + 30000) plus every step's output (5200).
    const text = textOf(tree)
    assert.ok(text.includes('토큰') && text.includes('36k'), text)
    // Cached share rounded down: 30000 / 31000 is 96.7%, never a whole 100.
    assert.ok(text.includes('캐시') && text.includes('96%'), text)
    assert.ok(text.includes('도구') && text.includes('23'), text)
  }
})

test('the time\'s colour carries running, waiting, done and failed once the title dot is gone', () => {
  const colour = (state: AgentRec['state']): unknown => nodes(renderAgents(el, frame, {
    agents: [{ ...base, state, endedAt: state === 'running' || state === 'waiting' ? undefined : frame.now - 1 }], now: frame.now, showDone: false,
  }, actions)).find(n => n.props.key === 'elapsed')?.props.color
  assert.notEqual(colour('running'), colour('done'))
  assert.notEqual(colour('waiting'), colour('running'))
  assert.notEqual(colour('failed'), colour('done'))
})

test('the list head is one total: every agent\'s tokens added up', () => {
  const six: AgentRec = { ...base, usage: { input: 100_000, cached: 500_000, cacheWrite: 0, output: 0 }, outputTotal: 0 }
  const tree = renderAgents(el, frame, { agents: [{ ...six, id: 'x' }, { ...six, id: 'y' }], now: frame.now, showDone: false }, actions)
  const text = textOf(tree)
  assert.ok(text.includes('전체 에이전트'))
  assert.ok(text.includes('600k'), text)
  assert.ok(text.includes('1.2M'), text)
})

test('background tasks sit with the agents, running with running and ended with ended, on either surface', () => {
  const tasks = [
    { id: 'b-dev', kind: 'shell' as const, title: '개발 서버 실행', command: 'npm run dev', state: 'running' as const, startedAt: 2 },
    { id: 'b-test', kind: 'shell' as const, title: 'npm test', command: 'npm test', state: 'failed' as const, startedAt: 3, endedAt: frame.now - 1, summary: 'Background command "npm test" failed with exit code 1' },
  ]
  const done: AgentRec = { ...base, id: 'old', state: 'done', endedAt: frame.now - 5 }
  for (const surface of ['desktop', 'terminal'] as const) {
    const tree = renderAgents(el, { ...frame, surface }, { agents: [base, done], tasks, now: frame.now, showDone: true }, actions)
    const keys = nodes(tree).map(n => String(n.props.key))
    const text = textOf(tree)
    assert.ok(text.includes('2개 실행 중') && text.includes('2개 완료'), text)
    assert.ok(keys.indexOf('task-b-dev') > keys.indexOf(surface === 'desktop' ? 'card-worker' : 'agent-worker'))
    assert.ok(keys.indexOf('task-b-test') < keys.indexOf(surface === 'desktop' ? 'card-old' : 'done-old'))
    assert.ok(text.includes('npm run dev') && text.includes('종료 코드 1') && text.includes('실패'))
  }
  // Tasks alone are a list, not the empty pane.
  assert.ok(textOf(renderAgents(el, frame, { agents: [], tasks, now: frame.now, showDone: false }, actions)).includes('개발 서버 실행'))
})

test('unfolded short tool histories are bounded by entries as well as characters and keep the latest calls', () => {
  const entries = Array.from({ length: 1800 }, (_, i) => ({ kind: 'tool' as const, id: 't' + i, tool: 'Bash', detail: 'pwd', state: 'ok' as const }))
  const first = entries.length - TALK_ENTRIES
  const tree = renderAgents(el, frame, { agents: [base], now: frame.now, showDone: false, open: { id: base.id, talk: { entries }, runsOpen: ['t' + first] } }, actions)
  const all = nodes(tree)
  assert.equal(all.filter(n => n.props.key === 'tool-t1799').length, 1)
  assert.equal(all.filter(n => n.props.key === 'tool-t0').length, 0)
  assert.equal(all.filter(n => String(n.props.key).startsWith('tool-t')).length, TALK_ENTRIES)
  assert.ok(textOf(tree).includes(String(first)))
  assert.ok(all.length < 10_000)
})

test('diagnostic fallback keeps safe text, opens the original agent id, and offers back and close', () => {
  const opened: string[] = []
  const tree = renderAgentsFallback(el, frame, [{ ...base, description: '검토\u001b̅' }], '오류\u0000', { ...actions, open: id => { opened.push(id) }, close: () => {} }, true)
  const all = nodes(tree)
  assert.equal(all.some(n => n.type === 'Svg'), false)
  assert.ok(all.some(n => n.props.key === 'back'))
  assert.ok(all.some(n => n.props.key === 'close'))
  assert.ok(!/[\u0000\u001b̅]/u.test(textOf(tree)))
  const press = all.find(n => n.props.key === 'fallback-open-0')?.props.onPress
  assert.equal(typeof press, 'function')
  if (typeof press === 'function') press()
  assert.deepEqual(opened, [base.id])
})
