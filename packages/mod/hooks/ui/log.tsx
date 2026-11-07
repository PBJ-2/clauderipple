// The request log pane: the router's records of model requests, newest first, one entry each with
// what matters (model, provider, effort, tokens, cache, time, result). Moved here unchanged in
// content from register.tsx's own drawing.

import { t } from '../i18n'
import { DISPLAY, displayChars, displayText } from './display'
import type { RenderNode } from 'claude-code'

import type { JudgeRun, StatusRequest } from '../../types'
import { GREET_SIZE, action, actions as actions_, speak } from './parts'
import type { Els } from './parts'
import { cacheTone, providerColor, textTone } from './theme'
import type { Frame, LogActions, LogView } from './view'
import { cachePercent, clockTime, effortLabel, modelOf, outputRate, promptTokens, rateText, seconds } from './view'

/**
 * The router's answer to a thread continue on a model without server-side threads: answered here at
 * once, never sent upstream, and the CLI goes on stateless. Every worker of a Workflow does it once,
 * and drawn as three lines like a failure it read as dozens of errors (2026-10-23).
 */
const STATELESS_SWITCH = /^(?:thread continue refused|continue of a translated turn refused)/

function entry(el: Els, frame: Frame, record: StatusRequest, mineOnly: boolean): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const cache = cachePercent(record.usage)
  const rate = outputRate(record)
  if (record.resent && STATELESS_SWITCH.test(record.note ?? '')) {
    return (
      <Box key={record.at + '-' + displayText(record.target, DISPLAY.name)} flexDirection="row" flexWrap="wrap" columnGap={1}>
        {mineOnly ? null : <Text dimColor>{record.mine ? '●' : '○'}</Text>}
        <Text dimColor>{clockTime(record.at)}</Text>
        <Text dimColor wrap="wrap">{modelOf(record)}</Text>
        <Text dimColor>{t(frame.lang, 'log.statelessSwitch')}</Text>
      </Box>
    )
  }
  return (
    <Box key={record.at + '-' + displayText(record.target, DISPLAY.name)} flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {mineOnly ? null : (
          <Text color={record.mine ? tone.accent : undefined} dimColor={!record.mine}>
            {record.mine ? '●' : '○'}
          </Text>
        )}
        <Text dimColor>{clockTime(record.at)}</Text>
        <Text bold wrap="wrap">
          {modelOf(record)}
        </Text>
        <Text color={providerColor(record.provider)}>{record.provider}</Text>
        {record.resent ? (
          <Text dimColor>{t(frame.lang, 'log.resent', { status: String(record.status) })}</Text>
        ) : (
          <Text color={record.ok ? tone.ok : tone.bad} bold={!record.ok}>
            {record.ok ? '✓' : '✕ ' + String(record.status)}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text dimColor>{record.effort ? effortLabel(record.effort, frame.lang) : '-'}</Text>
        {/* The tier asked for, not the one served: the ChatGPT sign-in answers `default` to a Fast request (#54). */}
        {record.requestedTier === 'priority' ? <Text color={tone.accent} bold>FAST</Text> : null}
        {record.usage ? <Text dimColor>{t(frame.lang, 'log.input', { tokens: tokens(promptTokens(record.usage)) })}</Text> : null}
        {cache !== undefined ? <Text color={tone[cacheTone(cache)]}>{t(frame.lang, 'band.cachePercent', { percent: cache })}</Text> : null}
        {record.usage ? <Text dimColor>{t(frame.lang, 'log.output', { tokens: tokens(record.usage.output) })}</Text> : null}
        <Text dimColor>{seconds(record.ms / 1000, frame.lang)}</Text>
        {rate !== undefined ? <Text dimColor>{t(frame.lang, 'log.rate', { rate: rateText(rate) })}</Text> : null}
      </Box>
      {!record.ok && record.note ? (
        <Text color={record.resent ? undefined : tone.bad} dimColor={record.resent} wrap="wrap">
          {record.note}
        </Text>
      ) : null}
    </Box>
  )
}

const JUDGE_NAME = { haiku: 'settings.haiku', jev: 'settings.jev', model: 'agents.routerModel' } as const

/** A verdict of this session's judge: who answered, in how long, what it chose, or why it fell back. */
function judgeEntry(el: Els, frame: Frame, run: JudgeRun): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const fell = run.by !== run.asked
  const who = fell ? t(frame.lang, 'log.judgeFell', { asked: t(frame.lang, JUDGE_NAME[run.asked]), by: t(frame.lang, JUDGE_NAME[run.by]) }) : t(frame.lang, JUDGE_NAME[run.by])
  const verdict = run.effort ? effortLabel(run.effort, frame.lang) + (run.sure !== undefined ? ' · ' + t(frame.lang, 'log.sure', { percent: Math.round(run.sure * 100) }) : '') : t(frame.lang, 'toasts.noVerdict')
  return (
    <Box key={'judge-' + run.at} flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text dimColor>{clockTime(run.at)}</Text>
        <Text bold>{t(frame.lang, run.for === 'worker' ? 'log.judgeWorker' : 'log.judge')}</Text>
        <Text color={fell ? tone.warn : tone.accent}>{who}</Text>
        <Text dimColor>{'→ ' + verdict}</Text>
        <Text dimColor>{seconds(run.ms / 1000, frame.lang)}</Text>
      </Box>
      {run.error ? (
        <Text color={tone.warn} wrap="wrap">
          {run.error}
        </Text>
      ) : null}
    </Box>
  )
}

/** The log pane body: this session's verdicts in time order among its requests. */
export function renderLog(el: Els, frame: Frame, view: LogView, actions: LogActions): RenderNode {
  const { Box, Text } = el
  const judges = view.mineOnly ? (view.judges ?? []) : []
  // Share the content allowance across all entries, not just the first few long errors.
  // First reserve room per entry for names and chrome, giving every error a preview.
  // Then count the actual drawn content against the shared allowance, newest first.
  const count = view.rows.length + judges.length
  const detail = Math.max(0, Math.min(DISPLAY.detail, Math.floor(DISPLAY.log / Math.max(1, count)) - 400))
  const items = [...view.rows.map(record => ({ at: Date.parse(record.at), node: () => entry(el, frame, { ...record, provider: displayText(record.provider, 60), effort: displayText(record.effort ?? '', 40), status: displayText(String(record.status), 40), note: displayText(record.note ?? '', detail) }, view.mineOnly) })), ...judges.map(run => ({ at: run.at, node: () => judgeEntry(el, frame, { ...run, error: displayText(run.error ?? '', detail) }) }))].sort((a, b) => b.at - a.at)
  const shown: RenderNode[] = []
  let remaining: number = DISPLAY.log
  for (const item of items) {
    const node = item.node()
    const chars = displayChars(node)
    if (chars > remaining) break
    shown.push(node)
    remaining -= chars
  }
  const scopeName = view.mineOnly ? t(frame.lang, 'log.thisSession') : t(frame.lang, 'log.allSessions')
  const scope = action(el, frame, 'scope', view.mineOnly ? t(frame.lang, 'log.showAll') : t(frame.lang, 'log.onlySession'), actions.toggleScope, { hotkey: 'a' })
  const legend = !view.mineOnly ? <Text key="legend" dimColor wrap="wrap">{t(frame.lang, 'log.legend')}</Text> : ''
  // Empty, the pane has nothing to redraw it, so 리플이 can live out its idle loops here; with
  // requests every poll redraws it and would start its motion over, so the list has no picture.
  if (items.length === 0) return speak(el, frame, { key: 'log', face: 'calm', size: GREET_SIZE, title: scopeName, line: t(frame.lang, 'log.empty'), blocks: [legend, actions_(el, frame, [scope])] })
  return (
    <Box flexDirection="column" gap={1} width="100%">
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
        <Text bold>{scopeName}</Text>
        {scope}
      </Box>
      {legend}
      {shown}
      {shown.length < items.length ? <Text dimColor>{t(frame.lang, 'agents.dropped', { count: items.length - shown.length })}</Text> : null}
    </Box>
  )
}

// The log keeps one decimal at every size (12.3k), as it always has.
function tokens(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}
