// The request log pane: the router's records of model requests, newest first, one entry each with
// what matters (model, provider, effort, tokens, cache, time, result). Moved here unchanged in
// content from register.tsx's own drawing.

import type { RenderNode } from 'claude-code'

import type { StatusRequest } from '../../types'
import { textButton } from './parts'
import type { Els } from './parts'
import { cacheTone, providerColor, textTone } from './theme'
import type { Frame, LogActions, LogView } from './view'
import { cachePercent, clockTime, isRich, modelOf, promptTokens } from './view'

function entry(el: Els, frame: Frame, record: StatusRequest, mineOnly: boolean): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const cache = cachePercent(record.usage)
  return (
    <Box key={record.at + '-' + record.target} flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        {mineOnly ? null : (
          <Text color={record.mine ? tone.accent : undefined} dimColor={!record.mine}>
            {record.mine ? '●' : '○'}
          </Text>
        )}
        <Text dimColor>{clockTime(record.at)}</Text>
        <Text bold wrap="truncate-end">
          {modelOf(record)}
        </Text>
        <Text color={providerColor(record.provider)}>{record.provider}</Text>
        {record.resent ? (
          <Text dimColor>{'↻ ' + String(record.status) + ' resent'}</Text>
        ) : (
          <Text color={record.ok ? tone.ok : tone.bad} bold={!record.ok}>
            {record.ok ? '✓' : '✕ ' + String(record.status)}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>{record.effort ?? '-'}</Text>
        {record.usage ? <Text dimColor>{'in ' + tokens(promptTokens(record.usage))}</Text> : null}
        {cache !== undefined ? <Text color={tone[cacheTone(cache)]}>{'cache ' + cache + '%'}</Text> : null}
        {record.usage ? <Text dimColor>{'out ' + tokens(record.usage.output)}</Text> : null}
        <Text dimColor>{(record.ms / 1000).toFixed(1) + 's'}</Text>
      </Box>
      {!record.ok && record.note ? (
        <Text color={record.resent ? undefined : tone.bad} dimColor={record.resent} wrap="wrap">
          {record.note}
        </Text>
      ) : null}
    </Box>
  )
}

/** The log pane body. */
export function renderLog(el: Els, frame: Frame, view: LogView, actions: LogActions): RenderNode {
  const { Box, Text } = el
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold>{view.mineOnly ? 'This session' : 'All sessions'}</Text>
        {textButton(el, 'scope', view.mineOnly ? 'Show all sessions' : 'This session only', actions.toggleScope, isRich(frame) ? undefined : 'a')}
      </Box>
      {!view.mineOnly && <Text dimColor>● this session  ○ other sessions</Text>}
      {view.rows.length === 0 && <Text dimColor>No model requests yet.</Text>}
      {view.rows.map(record => entry(el, frame, record, view.mineOnly))}
    </Box>
  )
}

// The log keeps one decimal at every size (12.3k), as it always has.
function tokens(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}
