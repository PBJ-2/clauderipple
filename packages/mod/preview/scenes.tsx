// The scenes the preview draws (render.mjs copies this in as the mod's only test). Each one is a
// renderer with fixed data, drawn on the desktop surface and printed as `@@SCENE {...}`.

import { test } from 'claude-code/testing'
import type { ContextGridSquare, RenderElement, RenderPropsOf, SessionContextBreakdown } from 'claude-code'

import type { AgentRec, BgTask, LimitItem, Settings, Skin } from '../types'
import { normalizeSettings } from '../hooks/settings'
import { renderAgents, talkOf } from '../hooks/ui/agents'
import { renderAlert } from '../hooks/ui/alerts'
import { renderBand } from '../hooks/ui/band'
import { renderContext } from '../hooks/ui/context'
import type { ContextView } from '../hooks/ui/context'
import { renderPhoneQueue } from '../hooks/ui/queue'
import { renderLog } from '../hooks/ui/log'
import { renderLimits } from '../hooks/ui/limits'
import { renderSettings } from '../hooks/ui/settings'
import { renderSetup } from '../hooks/ui/setup'
import type { AgentEntry, AlertView, DashboardView, Frame, SettingsView } from '../hooks/ui/view'
import type { Els } from '../hooks/ui/parts'

const LANG = 'ko'
const SKIN = 'deep'
const ONLY: string[] = []
/** The composer's width in a wide window, 768 px, in the desktop's cells. */
const WIDTH = 94
const NOW = Date.parse('2026-10-12T13:20:00')
const noop = new Proxy({}, { get: () => () => undefined }) as never

const DASH: DashboardView = {
  effort: { level: 'high', mode: 'auto', why: '여러 파일에 걸친 리팩터', by: 'jev' },
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

const SETTINGS: Settings = normalizeSettings({ judge: 'jev', judgeModel: 'deepseek-v4.1-flash', modes: [{ id: 'm1', name: 'GPT 우선' }, { id: 'm2', name: '절약' }], activeMode: 'm1' } as never)

/**
 * Every plan window the limits row gauges: Claude's 5-hour (no reset given), weekly (near its cap)
 * and Fable, then two GPT accounts, the second's 5-hour past its reset and its weekly nearly spent.
 */
const LIMITS: LimitItem[] = [
  { provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'five_hour', label: '', percent: 1 },
  { provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'seven_day', label: '', percent: 88, resetsAt: '2026-10-12T18:20:00' },
  { provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'scoped', label: 'Fable', percent: 2, resetsAt: '2026-10-15T10:59:59+00:00' },
  { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 0, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 23, resetsAt: '2026-10-19T13:20:00' },
  { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 1, kind: 'five_hour', label: '', windowMinutes: 300, percent: 64, resetsAt: '2026-10-12T13:05:00' },
  { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 1, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 97, resetsAt: '2026-10-14T09:42:00' },
]

/** Every readable provider at once, for the general limits row: Claude, GPT, Gemini and OpenCode Go. */
const LIMITS_ALL: LimitItem[] = [
  { provider: 'anthropic', type: 'anthropic', title: 'Claude', account: 0, kind: 'five_hour', label: '', percent: 1 },
  { provider: 'anthropic', type: 'anthropic', title: 'Claude', account: 0, kind: 'seven_day', label: '', percent: 88, resetsAt: '2026-10-12T18:20:00' },
  { provider: 'anthropic', type: 'anthropic', title: 'Claude', account: 0, kind: 'scoped', label: 'Fable', percent: 2, resetsAt: '2026-10-15T10:59:59+00:00' },
  { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 0, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 23, resetsAt: '2026-10-19T13:20:00' },
  { provider: 'google-gemini', type: 'google', title: 'Gemini', account: 0, kind: 'five_hour', label: '', windowMinutes: 300, percent: 0 },
  { provider: 'google-gemini', type: 'google', title: 'Gemini', account: 0, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 2, resetsAt: '2026-10-19T13:20:00' },
  { provider: 'google-gemini', type: 'google', title: 'Gemini', account: 0, kind: 'scoped', label: '3P', windowMinutes: 10080, percent: 10, resetsAt: '2026-10-19T13:20:00' },
  { provider: 'google-gemini', type: 'google', title: 'Gemini', account: 0, kind: 'scoped', label: '3P', windowMinutes: 300, percent: 0 },
  { provider: 'opencode-go', type: 'opencode-go', title: 'Go', account: 0, kind: 'five_hour', label: '', windowMinutes: 300, percent: 3, resetsAt: '2026-10-15T05:39:48Z' },
  { provider: 'opencode-go', type: 'opencode-go', title: 'Go', account: 0, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 52, resetsAt: '2026-10-19T00:00:00Z' },
  { provider: 'opencode-go', type: 'opencode-go', title: 'Go', account: 0, kind: 'window', label: '', windowMinutes: 43200, percent: 92, resetsAt: '2026-10-18T05:43:30Z' },
]
const SETTINGS_VIEW: SettingsView = { settings: SETTINGS, jev: { source: 'env', test: { state: 'idle' } } }

/** The Agents pane's width in a wide window, ~560 px, in cells; and a narrow one, ~360 px. */
const PANE = 68
const PANE_NARROW = 44

/** Two running (a Sol·high GPT worker, a DeepSeek one in a long tool), three finished (an Explore on the session model, a failed Astra, a Sonnet). */
const AGENTS: AgentRec[] = [
  {
    id: 'g1', description: 'Sol·high · 요청 로그 렌더러를 새 키트로 옮기기', type: 'gpt-6-1-sol', model: 'gpt-6.1-sol@high', provider: 'chatgpt',
    pick: { domain: 'frontend', level: 'standard', effort: 'high', sure: 0.82, why: '설계가 정해진 여러 파일 수정', target: { agent: 'gpt-6-1-sol' }, by: 'jev', rung: 'standard', ms: 640 },
    state: 'running', now: 'Edit packages/mod/hooks/ui/log.tsx', toolSince: NOW - 6000, startedAt: NOW - 192_000, cost: 0,
    effort: 'high', answeredBy: 'gpt-6.1-sol', usage: { input: 3200, cached: 182_000, cacheWrite: 9400, output: 14_200 }, tools: 23,
  },
  {
    id: 'd1', description: 'deepseek-v4.1-flash·low · 테스트 실패 원인 조사', type: 'deepseek-v4-1-flash', model: 'deepseek-v4.1-flash@low', provider: 'deepseek',
    pick: { domain: 'test', level: 'light', effort: 'low', why: '로그 한 군데만 보면 되는 조사', target: { agent: 'deepseek-v4-1-flash' }, by: 'marker', rung: 'light', ms: 0 },
    state: 'running', now: 'Bash npm test -- --runInBand', toolSince: NOW - 41_000, startedAt: NOW - 95_000, cost: 0,
    effort: 'low', answeredBy: 'deepseek-v4.1-flash', usage: { input: 900, cached: 41_000, cacheWrite: 2100, output: 3100 }, tools: 9,
  },
  {
    id: 'e1', description: 'Opus5.5 · 라우터 설정 파일 위치 찾기', type: 'Explore', model: 'claude-opus-5-5', provider: 'anthropic',
    state: 'done', startedAt: NOW - 700_000, endedAt: NOW - 640_000, cost: 0,
    effort: 'medium', answeredBy: 'claude-opus-5-5', usage: { input: 1200, cached: 64_000, cacheWrite: 18_000, output: 2600 }, tools: 14,
  },
  {
    id: 'a1', description: 'Astra·xhigh · 설정 마이그레이션 스크립트 작성', type: 'gpt-6-astra', model: 'gpt-6-astra@xhigh', provider: 'chatgpt',
    pick: { domain: 'backend', level: 'deep', effort: 'xhigh', sure: 0.7, why: '데이터 이전이라 실수 비용이 큼', target: { agent: 'gpt-6-astra' }, by: 'haiku', rung: 'hard', ms: 900, fallbackReason: 'gpt-6-1-sol 한도 소진' },
    state: 'failed', startedAt: NOW - 1_400_000, endedAt: NOW - 1_310_000, cost: 0,
    effort: 'xhigh', answeredBy: 'gpt-6-astra', usage: { input: 2100, cached: 12_000, cacheWrite: 30_000, output: 900 }, tools: 4,
  },
  {
    id: 's1', description: 'Sonnet5.5 · 변경 문서 요약', type: 'general-purpose', model: 'claude-sonnet-5-5', provider: 'anthropic',
    pick: { domain: 'docs', level: 'light', effort: 'medium', why: '짧은 요약', target: { agent: 'general-purpose', model: 'claude-sonnet-5-5' }, by: 'session', ms: 0 },
    state: 'done', startedAt: NOW - 2_000_000, endedAt: NOW - 1_950_000, cost: 0,
    effort: 'medium', answeredBy: 'claude-sonnet-5-5', usage: { input: 400, cached: 22_000, cacheWrite: 3000, output: 1200 }, tools: 2,
  },
]

/**
 * As the owner's pane showed them at ~260 px (2026-10-20): a hosted DeepSeek worker picked on the
 * session's rung, its id with a vendor path; a finished Explore; the failed Astra.
 */
const HOSTED: AgentRec = {
  id: 'h1', description: 'deepseek-v4.1-flash-1017 · 안드로이드 core 파서 테스트 실패 원인 찾아 고치기', type: 'deepseek-ai-deepseek-v4-1-flash-1017', model: 'deepseek-ai/deepseek-v4.1-flash-1017@medium', provider: 'deepseek',
  pick: { domain: 'general', level: 'standard', effort: 'medium', why: '메인 대화가 정한 등급: standard', target: { agent: 'deepseek-ai-deepseek-v4-1-flash-1017' }, by: 'session', ms: 0 },
  state: 'running', now: 'Bash cd /Users/pbj/Documents/tabripple/android && ./gradlew :core:test -q', toolSince: NOW - 7000, startedAt: NOW - 1_287_000, cost: 0,
  effort: 'medium', answeredBy: 'deepseek-ai/deepseek-v4.1-flash-1017', usage: { input: 2100, cached: 410_000, cacheWrite: 12_000, output: 18_400 }, tools: 81,
}
const CARDS: AgentRec[] = [HOSTED, AGENTS[2]!, AGENTS[3]!]
/** The hosted worker at 9분 59초, and a second on at 10분 00초: the card must not move. */
const at = (ms: number): AgentRec[] => [{ ...HOSTED, startedAt: NOW - ms }]

/** One running agent and eight finished: the list shows the latest four and "more". */
const TASKS: BgTask[] = [
  { id: 'b-dev', kind: 'shell', title: '개발 서버 실행', command: 'npm run dev -- --port 5173', state: 'running', startedAt: NOW - 420_000 },
  { id: 'm-log', kind: 'monitor', title: '라우터 로그에서 오류 감시', command: 'tail -f ~/.clauderipple/logs/router.log | grep --line-buffered ERROR', state: 'running', startedAt: NOW - 130_000 },
  { id: 'b-test', kind: 'shell', title: 'npm test', command: 'npm test', state: 'failed', startedAt: NOW - 400_000, endedAt: NOW - 300_000, summary: 'Background command "npm test" failed with exit code 1' },
  { id: 'b-wait', kind: 'shell', title: '5분 대기', command: 'sleep 300', state: 'stopped', startedAt: NOW - 900_000, endedAt: NOW - 800_000 },
]
const MANY: AgentRec[] = [AGENTS[0]!, ...Array.from({ length: 8 }, (_, i): AgentRec => ({ ...AGENTS[i % 2 ? 2 : 4]!, id: 'm' + i, description: ['문서 링크 점검', '타입 오류 정리', 'i18n 키 대조', '빌드 로그 요약', '테스트 이름 정리', '캐시 적중률 확인', '라우터 로그 검색', '설정 스키마 비교'][i]!, endedAt: NOW - 60_000 * (i + 1), startedAt: NOW - 60_000 * (i + 2) }))]

/** The Sol worker's conversation so far: its task, its words, its tools, one still running. */
const TALK: AgentEntry[] = [
  { kind: 'prompt', text: '요청 로그 렌더러(`hooks/ui/log.tsx`)를 새 키트로 옮겨 주세요.\n\n- 내용은 그대로 두고 그리는 방식만 바꿉니다\n- 터미널 표면은 손대지 않습니다\n- `claude plugin test packages/mod`로 확인합니다' },
  { kind: 'text', text: '먼저 지금 렌더러와 키트의 **capsule**, `lift()` 쓰임새를 읽겠습니다.' },
  { kind: 'tool', id: 't1', tool: 'Read', detail: 'packages/mod/hooks/ui/log.tsx', state: 'ok' },
  { kind: 'tool', id: 't2', tool: 'Read', detail: 'packages/mod/hooks/ui/kit.tsx', state: 'ok' },
  { kind: 'tool', id: 't3', tool: 'Grep', detail: 'renderLog', state: 'ok' },
  { kind: 'text', text: '로그 항목은 한 줄 머리와 숫자 줄로 나뉩니다. 머리는 그대로 두고 숫자 줄만 타일 안으로 옮기겠습니다.' },
  { kind: 'tool', id: 't4', tool: 'Edit', detail: 'packages/mod/hooks/ui/log.tsx', state: 'ok' },
  { kind: 'tool', id: 't5', tool: 'Bash', detail: 'claude plugin test packages/mod', state: 'error' },
  { kind: 'text', text: '테스트 하나가 `dimColor`를 기대해서 실패했습니다. 캡슐 위 글자는 명시 색을 쓰도록 테스트를 고칩니다.' },
  { kind: 'tool', id: 't6', tool: 'Edit', detail: 'packages/mod/hooks/ui/log.tsx', state: 'running' },
]

/** The Explore agent's finished conversation, its answer last. */
const TALK_DONE: AgentEntry[] = [
  { kind: 'prompt', text: '라우터 설정 파일이 어디서 읽히는지 찾아 주세요.' },
  { kind: 'tool', id: 'u1', tool: 'Grep', detail: 'config.json', state: 'ok' },
  { kind: 'tool', id: 'u2', tool: 'Read', detail: 'packages/router/src/config.ts', state: 'ok' },
  { kind: 'text', text: '설정은 `packages/router/src/config.ts`의 `loadConfig`가 읽습니다.\n\n- 경로: `~/.clauderipple/config.json`\n- 환경변수 `CLAUDERIPPLE_HOME`이 있으면 그 아래를 봅니다' },
]

/**
 * A worker's run as the owner saw it (2026-10-20): eight gradle and grep commands, each behind a
 * `cd` into the project, one failing, then an edit; a word, then two more commands, the last running.
 * Read through talkOf, so the commands lose their `cd` and the paths go short as in the app.
 */
const GRADLE = 'cd /Users/pbj/Documents/tabripple/android && '
const PARSER = '/Users/pbj/Documents/tabripple/android/core/src/main/kotlin/com/tabripple/core/TabParser.kt'
const bash = (id: string, command: string, text?: string, isError?: boolean) => ({ tool_use_id: id, tool: 'Bash', input: { command }, ...(text !== undefined ? { text } : {}), ...(isError ? { isError } : {}) })
const TALK_TOOLS: AgentEntry[] = talkOf([
  { role: 'user', text: 'tabripple 안드로이드 core 모듈의 파서 테스트가 깨진 원인을 찾아 고쳐 주세요. `./gradlew :core:test`로 확인합니다.', toolUses: [] },
  { role: 'assistant', text: '먼저 core 모듈 테스트를 돌려 어디서 깨지는지 보겠습니다.', toolUses: [
    bash('r1', GRADLE + './gradlew :core:test -q 2>&1 | grep -vE "^(w:|warning:)" | tail -60', 'ok'),
    bash('r2', GRADLE + './gradlew :core:test --tests "*TabParserTest*" -q 2>&1 | tail -80', 'ok'),
    bash('r3', GRADLE + 'grep -rn "parseMeasure" core/src/main/kotlin | head -20', 'ok'),
    bash('r4', GRADLE + './gradlew :core:compileKotlin -q 2>&1 | grep -E "^e:" | head -30', 'e: unresolved reference', true),
    bash('r5', 'cd /Users/pbj/Documents/tabripple/android; git diff --stat HEAD~3 -- core/', 'ok'),
    bash('r6', GRADLE + 'sed -n 120,180p core/src/main/kotlin/com/tabripple/core/TabParser.kt', 'ok'),
    bash('r7', GRADLE + './gradlew :core:test --tests "*MeasureTest*" -q 2>&1 | tail -40', 'ok'),
    bash('r8', GRADLE + 'git log --oneline -5 -- core/src/main/kotlin/com/tabripple/core/TabParser.kt', 'ok'),
    { tool_use_id: 'r9', tool: 'Edit', input: { file_path: PARSER, old_string: 'a', new_string: 'b' }, text: 'ok' },
  ] },
  { role: 'assistant', text: '마디 경계의 빈 줄을 건너뛰지 않아 인덱스가 하나씩 밀렸습니다. 고친 뒤 전체 테스트를 다시 돌립니다.', toolUses: [
    bash('s1', GRADLE + './gradlew :core:compileKotlin -q 2>&1 | grep -E "^e:" | head -30', 'ok'),
    bash('s2', GRADLE + './gradlew :core:test -q 2>&1 | grep -vE "^(w:|warning:)" | tail -60'),
  ] },
], { cwd: '/Users/pbj/Documents/tabripple', home: '/Users/pbj' })

/**
 * The owner's side-by-side of 2026-10-24: a worker removing a feature, its long delegated prompt,
 * a run of twenty commands and fifteen reads, then seven commands, nine edits and three reads.
 */
const NATIVE_PROMPT = [
  'Remove the "handoff" feature from the mod entirely — its settings and its functions. Compaction stays (it will be reworked in a later step, so keep `compactWith` and the heavy-context `swampAt`/`swampAlert` settings as they are for now).',
  '',
  'Remove:',
  '- `hooks/handoff.ts` and its test',
  '- the band\'s handoff button and its advised state (`band.tsx`, `alerts.tsx`)',
  '- Dashboard (packages/ui/app.js, packages/ui/i18n.js): `modHandoffCard` becomes a compaction card; remove the handoff rows, defaults and unused i18n keys in every language.',
  '- Docs: where docs/ARCHITECTURE.md, docs/specs/*, README or docs/HANDOFF mention it.',
].join('\n')
const step = (prefix: string, n: number, tool: string, extra: Partial<AgentEntry> = {}): AgentEntry[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'tool', id: prefix + i, tool, detail: tool === 'Bash' ? 'grep -rn handoff packages/mod' : 'packages/mod/hooks/file' + i + '.ts', state: 'ok', ...extra }) as AgentEntry)
const TALK_NATIVE: AgentEntry[] = [
  { kind: 'prompt', text: NATIVE_PROMPT },
  { kind: 'text', text: 'I’ll start by mapping every handoff reference.' },
  ...step('a', 20, 'Bash'), ...step('b', 15, 'Read'),
  { kind: 'text', text: 'Now I’ll make the changes. First, remove the handoff module and its test.' },
  ...step('c', 7, 'Bash'), ...step('d', 9, 'Edit', { added: 6, removed: 42 }), ...step('e', 3, 'Read'),
]
const NATIVE_AGENT: AgentRec = { ...HOSTED, id: 'n1', description: 'deepseek-v4.1-flash·high · Remove the handoff feature from the mod', state: 'running', startedAt: NOW - 252_000, tools: 54, usage: { input: 22_000, cached: 410_000, cacheWrite: 0, output: 9_100 }, effort: 'high' }

const AGENT_ACTIONS = { toggleDone: () => undefined, open: () => undefined, back: () => undefined, earlier: () => undefined, toggleRun: () => undefined }

/** The AbovePrompt site as register.tsx composes it on the desktop: the band, its × inside. */
function site(el: Els, frame: Frame, view: DashboardView): RenderElement {
  return renderBand(el, frame, view, noop) as RenderElement
}

type Scene = { name: string; columns?: number; skin?: Skin; draw: (el: Els, frame: Frame) => unknown }

const alert = (a: AlertView) => (el: Els, frame: Frame) => renderAlert(el, frame, a, noop)

/** The band with the phone queue's strip over it, as register.tsx stacks them. */
function queued(el: Els, frame: Frame, view: DashboardView, first: string): RenderElement {
  const { Box } = el
  return (<Box flexDirection="column" rowGap={0.5} width="100%" minWidth={0}>{renderPhoneQueue(el, frame, { count: 2, first })}{renderBand(el, frame, view, noop)}</Box>) as RenderElement
}

/** A session's context as `$.session.usage({ breakdown })` reports it (2.1.304's category names and theme keys). */
const CONTEXT: SessionContextBreakdown = (() => {
  const max = 160_000
  const categories: SessionContextBreakdown['categories'] = [
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
  const squares: ContextGridSquare[] = []
  for (const c of categories.filter(c => c.kind !== 'deferred')) {
    const exact = c.tokens / (max / 100)
    const count = Math.max(1, Math.round(exact))
    for (let i = 0; i < count && squares.length < 100; i++) squares.push({ color: c.color, isFilled: c.kind !== 'free', categoryName: c.name, tokens: c.tokens, percentage: Math.round((c.tokens / max) * 100), squareFullness: i === count - 1 && exact % 1 > 0 ? exact % 1 : 1 })
  }
  return {
    categories, totalTokens: 73_900, maxTokens: max, rawMaxTokens: max, autocompactSource: 'model-default', percentage: 46,
    gridRows: Array.from({ length: 10 }, (_, y) => squares.slice(y * 10, y * 10 + 10)),
    model: 'claude-opus-5-5',
    memoryFiles: [
      { path: '/work/CLAUDE.md', type: 'Project', tokens: 1800 },
      { path: '/home/me/.claude/CLAUDE.md', type: 'User', tokens: 2100 },
      { path: '/home/me/.claude/projects/work/memory/MEMORY.md', type: 'AutoMem', tokens: 200 },
    ],
    mcpTools: [
      ...Array.from({ length: 8 }, (_, i) => ({ name: 'mcp__linear__t' + i, serverName: 'linear', tokens: 500, isLoaded: true })),
      ...Array.from({ length: 6 }, (_, i) => ({ name: 'mcp__browser__t' + i, serverName: 'browser', tokens: 366, isLoaded: true })),
      ...Array.from({ length: 20 }, (_, i) => ({ name: 'mcp__gmail__t' + i, serverName: 'gmail', tokens: 1050, isLoaded: false })),
    ],
    agents: ['gpt-6-1-sol', 'gpt-6-astra', 'deepseek-v4-1-flash', 'gemini-3-8-flash', 'ripple:auto', 'statusline-setup'].map((agentType, i) => ({ agentType, source: i < 4 ? 'userSettings' : 'plugin', tokens: 420 - i * 30 })),
    slashCommands: { totalCommands: 34, includedCommands: 30, tokens: 1100 },
    skills: {
      totalSkills: 9, includedSkills: 8, tokens: 2600,
      skillFrontmatter: ['code-discipline', 'seo-os', 'store-release', 'plugin-authoring', 'dataviz', 'docs', 'pdf', 'xlsx'].map((name, i) => ({ name, source: i % 3 ? 'userSettings' : 'plugin', ...(i % 3 ? {} : { pluginName: 'anthropic-skills' }), tokens: 520 - i * 40 })),
    },
    autoCompactThreshold: 144_000, isAutoCompactEnabled: true, apiUsage: null,
  }
})()
const CONTEXT_VIEW: ContextView = { breakdown: CONTEXT, basis: 'summary', busy: false, precise: true, open: [], place: { cwd: '/work', home: '/home/me' } }

const SCENES: Scene[] = [
  // The Context pane the band's context chip opens (2026-10-24): an estimate, a precise count under
  // way with a section opened, a narrow pane, the flat skin, and nothing to show yet.
  { name: 'context', columns: PANE, draw: (el, f) => renderContext(el, f, CONTEXT_VIEW, noop) },
  { name: 'context-busy-open', columns: PANE, draw: (el, f) => renderContext(el, f, { ...CONTEXT_VIEW, busy: true, open: ['skills'] }, noop) },
  { name: 'context-narrow', columns: PANE_NARROW, draw: (el, f) => renderContext(el, f, CONTEXT_VIEW, noop) },
  // A routed model (a GPT chat): no precise count to offer (2026-10-30).
  { name: 'context-routed', columns: PANE, draw: (el, f) => renderContext(el, f, { ...CONTEXT_VIEW, precise: false }, noop) },
  { name: 'context-wide', columns: 100, draw: (el, f) => renderContext(el, f, { ...CONTEXT_VIEW, basis: 'full' }, noop) },
  { name: 'flat-context', columns: PANE, skin: 'flat', draw: (el, f) => renderContext(el, f, CONTEXT_VIEW, noop) },
  { name: 'context-none', columns: PANE, draw: (el, f) => renderContext(el, f, { ...CONTEXT_VIEW, breakdown: null, error: 'count_tokens 529 overloaded' }, noop) },
  { name: 'band', draw: (el, f) => site(el, f, DASH) },
  // The delegation pin's line at the top of the capsule (2026-10-23): with the person's sentence, without, narrow, flat.
  { name: 'band-pinned', draw: (el, f) => site(el, f, { ...DASH, delegationPin: 'Sol', delegationSaid: '앞으로 솔로 해' }) },
  { name: 'band-pinned-limits', draw: (el, f) => site(el, f, { ...DASH, delegationPin: 'Sol', delegationSaid: '이 세션은 솔로 고정해서 진행해 줘', limits: LIMITS, extras: ['context', 'limits'] }) },
  { name: 'band-pinned-nosaid', draw: (el, f) => site(el, f, { ...DASH, delegationPin: 'Sol' }) },
  { name: 'band-pinned-narrow', columns: 70, draw: (el, f) => site(el, f, { ...DASH, delegationPin: 'Sol', delegationSaid: '앞으로 솔로 해' }) },
  { name: 'band-pinned-tiny', columns: 40, draw: (el, f) => site(el, f, { ...DASH, delegationPin: 'GPT-6.1 Sol', delegationSaid: '앞으로 솔로 해' }) },
  { name: 'flat-band-pinned', skin: 'flat', draw: (el, f) => site(el, f, { ...DASH, delegationPin: 'Sol', delegationSaid: '앞으로 솔로 해' }) },
  { name: 'band-phone-queue', draw: (el, f) => queued(el, f, { ...DASH, isWorking: true }, '홈 카드 제목이랑 점수 알약도 같이 정리해 줘') },
  { name: 'band-phone-queue-long', columns: 70, draw: (el, f) => queued(el, f, { ...DASH, isWorking: true }, '이 날의 흐름 이것도 한국어가 좀 어색한데 사람마다 달라지는 리포트 같은 건 빼고 모든 한국어를 정리해서 자연스럽게') },
  { name: 'band-phone-queue-flat', skin: 'flat', draw: (el, f) => queued(el, f, { ...DASH, isWorking: true }, '홈 카드 제목이랑 점수 알약도 같이 정리해 줘') },
  { name: 'band-deciding', draw: (el, f) => site(el, f, { ...DASH, effort: { level: null, mode: 'deciding', since: NOW - 500 } }) },
  { name: 'band-working', draw: (el, f) => site(el, f, { ...DASH, isWorking: true, warm: { on: true, pings: 2, cost: 9000 }, agents: { live: 2, total: 3 }, context: { percent: 64, tokens: 128_000, window: 200_000 }, mode: 'GPT 우선' }) },
  { name: 'band-compacted', draw: (el, f) => site(el, f, { ...DASH, agents: { live: 1, total: 1 }, compactions: 3 }) },
  { name: 'band-drowsy-off', draw: (el, f) => site(el, f, { ...DASH, auto: false, effort: { level: 'medium', mode: 'off' }, cache: { expiresAt: NOW + 60_000, ttlMs: 3_600_000 }, limit: { kind: 'five_hour', percent: 86, resetsAt: '2026-10-12T15:40:00', save: false }, extras: ['context', 'limits'] }) },
  { name: 'band-warm-here', draw: (el, f) => site(el, f, { ...DASH, warm: { on: false, pings: 0, cost: 0, here: true } }) },
  { name: 'band-asleep', draw: (el, f) => site(el, f, { ...DASH, cache: { expiresAt: NOW - 1, ttlMs: 3_600_000 } }) },
  { name: 'band-menu', draw: (el, f) => site(el, f, { ...DASH, effortMenu: true, effort: { level: 'xhigh', mode: 'manual' } }) },
  { name: 'band-narrow', columns: 70, draw: (el, f) => site(el, f, DASH) },
  { name: 'band-700-busy', columns: 79, draw: (el, f) => site(el, f, { ...DASH, effort: { level: 'xhigh', mode: 'manual' }, agents: { live: 2, total: 3 }, warm: { on: true, pings: 3, cost: 0 } }) },
  // The band's two real widths, at its new maximum (2026-10-14): everything on — context, limits, a
  // limit, a route and every control — must hold at both.
  { name: 'band-94-full', columns: 94, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 42, resetsAt: '2026-10-15T15:40:00', save: false }, extras: ['context', 'limits'] }) },
  { name: 'band-100-full', columns: 100, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 42, resetsAt: '2026-10-15T15:40:00', save: false }, extras: ['context', 'limits'] }) },
  // The limits row (2026-10-15): every plan window gauges the second row, and the first row's
  // limit fact steps aside for the route. Narrow, the GPT accounts go first, then Fable.
  { name: 'band-limits-94', columns: 94, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, extras: ['context', 'limits'], limits: LIMITS }) },
  { name: 'band-limits-100', columns: 100, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, extras: ['context', 'limits'], limits: LIMITS }) },
  { name: 'band-limits-70', columns: 70, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, extras: ['context', 'limits'], limits: LIMITS }) },
  // The limits pane the row opens (2026-10-25, redrawn 2026-10-29): a dial of the window closest to
  // its cap, a tile per provider account, each window's bar and share, the exact local date and
  // time it resets and the time left; a passed reset says so, a window without one says that, and
  // save mode says until when.
  { name: 'limits-pane', columns: PANE, draw: (el, f) => renderLimits(el, f, { items: LIMITS, saveUntil: Date.parse('2026-10-12T18:20:00') }, noop) },
  { name: 'limits-pane-narrow', columns: PANE_NARROW, draw: (el, f) => renderLimits(el, f, { items: LIMITS }, noop) },
  { name: 'limits-pane-all', columns: 100, draw: (el, f) => renderLimits(el, f, { items: LIMITS_ALL }, noop) },
  { name: 'limits-pane-none', columns: PANE, draw: (el, f) => renderLimits(el, f, { items: [] }, noop) },
  { name: 'flat-limits-pane', columns: PANE, skin: 'flat', draw: (el, f) => renderLimits(el, f, { items: LIMITS }, noop) },
  // Every readable provider (2026-10-15): Claude, GPT, Gemini and OpenCode Go in one row, at the
  // two real widths. Narrow, the scoped windows go first, then a later provider's group.
  { name: 'band-limits-all-100', columns: 100, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, extras: ['context', 'limits'], limits: LIMITS_ALL }) },
  { name: 'band-limits-all-140', columns: 140, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, extras: ['context', 'limits'], limits: LIMITS_ALL }) },
  { name: 'band-limits-all-94', columns: 94, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, extras: ['context', 'limits'], limits: LIMITS_ALL }) },
  { name: 'settings', draw: (el, f) => renderSettings(el, f, SETTINGS_VIEW, noop) },
  { name: 'settings-off', draw: (el, f) => renderSettings(el, f, { ...SETTINGS_VIEW, settings: { ...SETTINGS, effortAuto: false, judge: 'haiku', keepWarm: true, activeMode: undefined } }, noop) },
  { name: 'settings-key', draw: (el, f) => renderSettings(el, f, { settings: { ...SETTINGS, jevSource: 'typesafe', judge: 'jev' }, jev: { source: null, test: { state: 'fail', message: 'key rejected (401)' } } }, noop) },
  { name: 'settings-router', columns: 70, draw: (el, f) => renderSettings(el, f, { ...SETTINGS_VIEW, settings: { ...SETTINGS, judge: 'model', bias: 1 } }, noop) },
  { name: 'alert-cold', draw: alert({ kind: 'cold', tokens: 182_000, idleMinutes: 74 }) },
  { name: 'alert-kept', draw: alert({ kind: 'kept', pings: 2, tokens: 312_000, minutesLeft: 47 }) },
  { name: 'alert-swamp', draw: alert({ kind: 'swamp', percent: 63, tokens: 126_000 }) },
  { name: 'alert-hot', draw: alert({ kind: 'hot', limitKind: 'five_hour', percent: 86, resetsAt: '2026-10-12T15:40:00', save: false }) },
  { name: 'alert-judge', draw: alert({ kind: 'judgeDown', judge: 'jev', reason: 'key rejected (401)' }) },
  { name: 'alert-compact', draw: alert({ kind: 'compactNote', draft: '', tidy: true }) },
  { name: 'alert-tidying', draw: alert({ kind: 'result', stage: 'tidying' }) },
  { name: 'alert-handing', draw: alert({ kind: 'result', stage: 'handingOff' }) },
  { name: 'alert-handed', draw: alert({ kind: 'result', stage: 'handoffDone', detail: '새 대화를 열고 입력창에 인수인계 내용을 넣었습니다. 새 대화에서 Enter를 누르면 이어갑니다.' }) },
  { name: 'alert-compacted', draw: alert({ kind: 'result', stage: 'compacted' }) },
  { name: 'setup', draw: (el, f) => renderSetup(el, f, { step: 1, draft: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, noop) },
  { name: 'setup-2', draw: (el, f) => renderSetup(el, f, { step: 2, draft: SETTINGS, jev: { source: 'env', test: { state: 'idle' } } }, noop) },
  { name: 'setup-3', draw: (el, f) => renderSetup(el, f, { step: 3, draft: SETTINGS, jev: { source: 'env', test: { state: 'idle' } } }, noop) },
  { name: 'setup-done', draw: (el, f) => renderSetup(el, f, { step: 4, draft: SETTINGS, jev: { source: 'env', test: { state: 'idle' } } }, noop) },
  // The flat skin (look.ts), on the band, the quick settings, a card and a setup step.
  { name: 'flat-band', skin: 'flat', draw: (el, f) => site(el, f, { ...DASH, warm: { on: true, pings: 2, cost: 9000 }, agents: { live: 2, total: 3 }, extras: ['context', 'limits'], limit: { kind: 'five_hour', percent: 42, resetsAt: '2026-10-12T15:40:00', save: false } }) },
  { name: 'flat-band-menu', skin: 'flat', draw: (el, f) => site(el, f, { ...DASH, effortMenu: true, effort: { level: 'xhigh', mode: 'manual' } }) },
  { name: 'flat-settings', skin: 'flat', draw: (el, f) => renderSettings(el, f, SETTINGS_VIEW, noop) },
  { name: 'flat-settings-key', skin: 'flat', draw: (el, f) => renderSettings(el, f, { settings: { ...SETTINGS, jevSource: 'typesafe', judge: 'jev', effortAuto: false, keepWarm: true }, jev: { source: null, test: { state: 'fail', message: 'key rejected (401)' } } }, noop) },
  { name: 'flat-alert-swamp', skin: 'flat', draw: (el, f) => renderAlert(el, f, { kind: 'swamp', percent: 63, tokens: 126_000 }, noop) },
  { name: 'flat-setup', skin: 'flat', draw: (el, f) => renderSetup(el, f, { step: 1, draft: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, noop) },
  { name: 'agents', columns: 90, draw: (el, f) => renderAgents(el, f, { agents: [], now: NOW, showDone: false }, noop) },
  { name: 'agents-empty', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: [], now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'agents-live', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'agents-live-narrow', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'agents-tasks', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, tasks: TASKS, now: NOW, showDone: true }, AGENT_ACTIONS) },
  { name: 'agents-tasks-narrow', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: AGENTS.slice(2), tasks: TASKS, now: NOW, showDone: true }, AGENT_ACTIONS) },
  { name: 'agents-idle', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS.slice(2), now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'agents-many', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: MANY, now: NOW, showDone: false }, AGENT_ACTIONS) },
  ...(['deep', 'flat'] as const).map(skin => ({
    name: 'agents-forty-' + skin, columns: PANE_NARROW, skin,
    draw: (el: Els, f: Frame) => renderAgents(el, f, {
      agents: Array.from({ length: 40 }, (_, i): AgentRec => ({ ...AGENTS[0]!, id: 'w' + i, description: '작업 진행 상황과 테스트 결과를 확인하고 변경 사항 정리하기 ' + i })),
      now: NOW, showDone: true,
    }, AGENT_ACTIONS),
  })),
  { name: 'agents-talk', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'agents-talk-narrow', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'agents-talk-done', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'e1', talk: { entries: TALK_DONE }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'agents-talk-deny', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { deny: 'agent g1 has no saved transcript' }, earlier: 0 } }, AGENT_ACTIONS) },
  // Cards that hold still and read at narrow widths (2026-10-20): ~260 px and ~360 px, running and
  // done; and one card a second apart across 9분 59초 → 10분 00초.
  { name: 'cards-260', columns: 33, draw: (el, f) => renderAgents(el, f, { agents: CARDS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-360', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: CARDS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-560', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: CARDS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-tick-959', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: at(599_000), now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-tick-1000', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: at(600_000), now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-tick-959-wide', columns: 56, draw: (el, f) => renderAgents(el, f, { agents: at(599_000), now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-tick-1000-wide', columns: 56, draw: (el, f) => renderAgents(el, f, { agents: at(600_000), now: NOW, showDone: false }, AGENT_ACTIONS) },
  // A worker's run of commands, folded to its head and unfolded call by call (2026-10-20).
  { name: 'agents-tools', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK_TOOLS }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'agents-tools-open', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK_TOOLS }, earlier: 0, runsOpen: ['r1', 's1'] } }, AGENT_ACTIONS) },
  { name: 'agents-tools-narrow', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK_TOOLS }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'agents-tools-open-narrow', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK_TOOLS }, earlier: 0, runsOpen: ['r1', 's1'] } }, AGENT_ACTIONS) },
  { name: 'flat-agents-live', columns: PANE, skin: 'flat', draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'flat-agents-talk', columns: PANE, skin: 'flat', draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK }, earlier: 0 } }, AGENT_ACTIONS) },
  // The conversation as the Claude app draws an agent's (2026-10-24): folded, unfolded, scrolled, flat.
  { name: 'agents-native', columns: 50, draw: (el, f) => renderAgents(el, f, { agents: [NATIVE_AGENT], now: NOW, showDone: false, open: { id: 'n1', talk: { entries: TALK_NATIVE } } }, AGENT_ACTIONS) },
  { name: 'agents-native-open', columns: 50, draw: (el, f) => renderAgents(el, f, { agents: [NATIVE_AGENT], now: NOW, showDone: false, open: { id: 'n1', talk: { entries: TALK_NATIVE }, runsOpen: ['prompt:first', 'c0'] } }, AGENT_ACTIONS) },
  { name: 'agents-native-scrolled', columns: 50, draw: (el, f) => renderAgents(el, { ...f, offset: 6 }, { agents: [NATIVE_AGENT], now: NOW, showDone: false, open: { id: 'n1', talk: { entries: TALK_NATIVE } } }, AGENT_ACTIONS) },
  { name: 'flat-agents-native', columns: 50, skin: 'flat', draw: (el, f) => renderAgents(el, f, { agents: [NATIVE_AGENT], now: NOW, showDone: false, open: { id: 'n1', talk: { entries: TALK_NATIVE } } }, AGENT_ACTIONS) },
  { name: 'log', columns: 90, draw: (el, f) => renderLog(el, f, { rows: [], mineOnly: true }, noop) },
]

test('scenes', async ($, on) => {
  const shown = SCENES.filter(scene => !ONLY.length || ONLY.includes(scene.name))
  for (const scene of shown) {
    const columns = scene.columns ?? WIDTH
    on('ui.render', { component: 'Pane', requestId: scene.name }, ($, e) => {
      const frame: Frame = { surface: 'desktop', columns, maxRows: 12, now: NOW, appearance: 'auto', skin: scene.skin ?? SKIN, lang: LANG }
      const tree = scene.draw($.ui.resolve(e), frame)
      console.log('@@SCENE ' + JSON.stringify({ name: scene.name, columns, tree }))
      return tree as RenderElement
    })
  }
  for (const scene of shown) {
    const columns = scene.columns ?? WIDTH
    const props = { title: 'ui', isFocused: true, bodyColumns: columns, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } as RenderPropsOf['Pane']
    const ui = await $.ui.mount({ plugin: 'test', surface: 'desktop', component: 'Pane', requestId: scene.name, props, viewport: { columns, rows: 40 } })
    await ui.unmount()
  }
})
