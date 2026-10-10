// The bands that take the dashboard's place when something wants a decision: cold cache, heavy
// context, a hot plan limit, a judge that failed, the compact and handoff bars, and the cards that
// report a compact or handoff in progress and done. One layout for all: a tinted badge, a title
// and one line of why, then the choices — the main one filled.

import type { RenderNode } from 'claude-code'

import type { HandoffKind, Settings } from '../../types'
import { WAVE_CSS, action, chip, icon, segmented } from './parts'
import type { Els } from './parts'
import { svgDoc, textTone, v } from './theme'
import type { Palette } from './theme'
import type { AlertActions, AlertView, Frame } from './view'
import { compactNumber, isRich, limitName, resetsLabel } from './view'

type Tone = 'accent' | 'ok' | 'warn' | 'bad'
type IconName = Parameters<typeof icon>[0]

type Choice = { key: string; label: string; hotkey: string; onPress: () => void; primary?: boolean; lit?: boolean }

type Card = {
  key: string
  tone: Tone
  glyph: IconName | 'wave'
  title: string
  body: string
  choices: Choice[]
  /** Controls drawn between the text and the choices (fields, option rows). */
  extra?: RenderNode[]
}

const JUDGE_NAME = { haiku: 'Haiku', jev: 'Jev', model: 'The router model' } as const

function badge(el: Els, frame: Frame, card: Card): RenderNode {
  const s = 34
  const paint = v(card.tone as keyof Palette)
  const plate =
    '<rect x="0.5" y="0.5" width="' + (s - 1) + '" height="' + (s - 1) + '" rx="10" fill="' + paint + '" fill-opacity="0.13" stroke="' + paint + '" stroke-opacity="0.45"/>'
  let body: string
  let css = ''
  if (card.glyph === 'wave') {
    // Work in progress: three dots lighting in turn.
    body = ''
    ;[11, 17, 23].forEach((x, i) => {
      body += '<circle class="wave" style="animation-delay:' + (i * 0.25).toFixed(2) + 's" cx="' + x + '" cy="17" r="2.4" fill="' + paint + '"/>'
    })
    css = WAVE_CSS
  } else {
    body = '<g transform="translate(17 17) scale(1.15) translate(-7 -7)">' + icon(card.glyph, 0, 0, paint) + '</g>'
  }
  const spec: Parameters<typeof chip>[1] = { key: 'badge-' + card.key, source: svgDoc(s, s, frame.appearance, plate + body, css), alt: card.title, width: s, height: s }
  if (css) spec.live = true
  return chip(el, spec)
}

function cardOf(frame: Frame, alert: AlertView, a: AlertActions): Card {
  switch (alert.kind) {
    case 'cold':
      return {
        key: 'cold',
        tone: 'accent',
        glyph: 'snow',
        title: 'The cache went cold',
        body:
          'This ' + compactNumber(alert.tokens) + '-token chat sat ' + alert.idleMinutes + ' min, so the next prompt re-reads all of it at full price. ' +
          'Compact it or hand off to a fresh chat first?',
        choices: [
          { key: 'compact', label: 'Compact', hotkey: 'c', onPress: () => a.compact(), primary: true },
          { key: 'handoff', label: 'Handoff', hotkey: 'h', onPress: a.handoff },
          { key: 'dismiss', label: 'Not now', hotkey: 'n', onPress: a.dismiss },
        ],
      }
    case 'swamp':
      return {
        key: 'swamp',
        tone: 'warn',
        glyph: 'alert',
        title: 'Context ' + Math.round(alert.percent) + '% full',
        body: compactNumber(alert.tokens) + ' tokens ride along with every prompt; long chats get slower, dearer and blurrier. A compact or a fresh chat keeps answers sharp.',
        choices: [
          { key: 'compact', label: 'Compact', hotkey: 'c', onPress: () => a.compact(), primary: true },
          { key: 'handoff', label: 'Handoff', hotkey: 'h', onPress: a.handoff },
          { key: 'dismiss', label: 'Not now', hotkey: 'n', onPress: a.dismiss },
        ],
      }
    case 'hot': {
      const resets = resetsLabel(alert.resetsAt, frame.now)
      return {
        key: 'hot',
        tone: alert.percent >= 95 ? 'bad' : 'warn',
        glyph: 'clock',
        title: limitName(alert.limitKind) + ' limit at ' + Math.round(alert.percent) + '%',
        body:
          (resets ? resets.charAt(0).toUpperCase() + resets.slice(1) + '. ' : '') +
          (alert.save ? 'Save mode is on: Auto stays at medium or below until the window resets.' : 'Save mode keeps Auto at medium or below until the window resets.'),
        choices: [
          { key: 'save', label: alert.save ? 'Save mode on' : 'Save mode', hotkey: 's', onPress: a.toggleSave, primary: !alert.save, lit: alert.save },
          { key: 'dismiss', label: 'Not now', hotkey: 'n', onPress: a.dismiss },
        ],
      }
    }
    case 'judgeDown':
      return {
        key: 'judge',
        tone: 'bad',
        glyph: 'alert',
        title: 'The effort judge is not answering',
        body: JUDGE_NAME[alert.judge] + ': ' + alert.reason + '. ' + (alert.judge === 'haiku' ? 'Auto keeps the current effort meanwhile.' : 'Auto asks Haiku meanwhile.'),
        choices: [
          { key: 'settings', label: 'Open settings', hotkey: 'o', onPress: a.openSettings, primary: true },
          { key: 'dismiss', label: 'Not now', hotkey: 'n', onPress: a.dismiss },
        ],
      }
    case 'result':
      return resultCard(alert, a)
    case 'compactNote':
      return {
        key: 'note',
        tone: 'accent',
        glyph: 'compact',
        title: 'Compact this chat',
        body: 'Say what the summary must keep, or leave it to the summary.',
        choices: [
          { key: 'compact', label: 'Compact', hotkey: 'c', onPress: () => a.compact(alert.draft), primary: true },
          { key: 'dismiss', label: 'Cancel', hotkey: 'x', onPress: a.dismiss },
        ],
      }
    case 'handoffChoice':
      return {
        key: 'handoff',
        tone: 'accent',
        glyph: 'handoff',
        title: 'Hand off to a fresh chat',
        body:
          alert.handoffKind === 'quick'
            ? 'Quick: a summary of this chat, written from its cache, that the new chat resumes from.'
            : 'Full: the handoff skill (or a turn) checks git and writes HANDOFF.md before the switch.',
        choices: [
          { key: 'go', label: 'Go', hotkey: 'g', onPress: a.go, primary: true },
          { key: 'dismiss', label: 'Cancel', hotkey: 'x', onPress: a.dismiss },
        ],
      }
  }
}

function resultCard(alert: Extract<AlertView, { kind: 'result' }>, a: AlertActions): Card {
  const dismiss: Choice = { key: 'dismiss', label: 'Dismiss', hotkey: 'x', onPress: a.dismiss }
  switch (alert.stage) {
    case 'handingOff':
      return {
        key: 'result',
        tone: 'accent',
        glyph: 'wave',
        title: 'Handing off…',
        body: alert.detail ?? (alert.handoffKind === 'full' ? 'Running the handoff: checking git and writing HANDOFF.md.' : 'Writing a summary a fresh chat can resume from.'),
        choices: [],
      }
    case 'handoffDone':
      return {
        key: 'result',
        tone: 'ok',
        glyph: 'check',
        title: 'Handoff done',
        body: alert.detail ?? 'The summary is ready.',
        choices: [{ key: 'copy', label: 'Copy again', hotkey: 'y', onPress: a.copy }, dismiss],
      }
    case 'compacting':
      return { key: 'result', tone: 'accent', glyph: 'wave', title: 'Compacting…', body: alert.detail ?? 'Summarizing the chat; it continues from the summary.', choices: [] }
    case 'compacted':
      return { key: 'result', tone: 'ok', glyph: 'check', title: 'Compacted', body: alert.detail ?? 'The chat continues from the summary.', choices: [dismiss] }
    case 'failed':
      return { key: 'result', tone: 'bad', glyph: 'cross', title: 'That did not finish', body: alert.detail ?? 'Nothing was changed.', choices: [dismiss] }
  }
}

function extras(el: Els, frame: Frame, alert: AlertView, a: AlertActions): RenderNode[] {
  const { Box, Text } = el
  if (alert.kind === 'compactNote' && 'Input' in el) {
    const Field = el.Input
    return [
      <Field
        key="note"
        label="Keep"
        placeholder="decisions, open questions, file names… (optional)"
        value={alert.draft}
        submitLabel="compact"
        autoFocus
        onInput={(text: string) => a.noteInput(text)}
        onSubmit={(text: string) => a.compact(text)}
      />,
    ]
  }
  if (alert.kind === 'handoffChoice') {
    const kinds: { value: HandoffKind; label: string; hotkey: string }[] = [
      { value: 'quick', label: 'Quick', hotkey: 'q' },
      { value: 'full', label: 'Full', hotkey: 'f' },
    ]
    const afters: { value: Settings['handoffAfter']; label: string; hotkey: string }[] = [
      { value: 'continue', label: 'Continue', hotkey: '1' },
      { value: 'confirm', label: 'Confirm first', hotkey: '2' },
      { value: 'copy', label: 'Copy only', hotkey: '3' },
    ]
    return [
      <Box key="kind" flexDirection="row" columnGap={2} alignItems="center">
        <Text dimColor>{'Kind '}</Text>
        {segmented(el, frame, 'kind', kinds, alert.handoffKind, k => a.setHandoffKind(k))}
      </Box>,
      <Box key="after" flexDirection="row" columnGap={2} alignItems="center">
        <Text dimColor>{'Then '}</Text>
        {segmented(el, frame, 'after', afters, alert.after, k => a.setHandoffAfter(k))}
      </Box>,
    ]
  }
  return []
}

/** One alert band, chosen by register.tsx from the priority list in the spec (§5 Bands). */
export function renderAlert(el: Els, frame: Frame, alert: AlertView, actions: AlertActions): RenderNode {
  const { Box, Text } = el
  const card = cardOf(frame, alert, actions)
  const extra = extras(el, frame, alert, actions)
  const tone = textTone(frame.appearance)
  const titleColor = card.tone === 'accent' ? undefined : tone[card.tone]
  if (isRich(frame)) {
    return (
      <Box key={'alert-' + card.key} flexDirection="column" rowGap={1}>
        <Box flexDirection="row" alignItems="center" columnGap={2} flexWrap="wrap" rowGap={1}>
          {badge(el, frame, card)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={30}>
            <Text bold color={titleColor}>
              {card.title}
            </Text>
            <Text dimColor wrap="wrap">
              {card.body}
            </Text>
          </Box>
          {card.choices.length > 0 ? (
            <Box flexDirection="row" gap={1}>
              {card.choices.map(c => {
                const o: { primary?: boolean; lit?: boolean } = {}
                if (c.primary) o.primary = true
                if (c.lit) o.lit = true
                return action(el, frame, c.key, c.label, c.onPress, o)
              })}
            </Box>
          ) : null}
        </Box>
        {extra.length > 0 ? (
          <Box flexDirection="column" rowGap={1} paddingLeft={6}>
            {extra}
          </Box>
        ) : null}
      </Box>
    )
  }
  const mark = card.glyph === 'wave' ? '…' : card.tone === 'ok' ? '✓' : card.tone === 'bad' ? '✕' : card.tone === 'warn' ? '▲' : '◉'
  return (
    <Box key={'alert-' + card.key} flexDirection="column">
      <Text wrap="wrap">
        <Text bold color={card.tone === 'accent' ? tone.accent : tone[card.tone]}>
          {mark + ' ' + card.title}
        </Text>
        <Text dimColor>{'  ' + card.body}</Text>
      </Text>
      {extra}
      {card.choices.length > 0 ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {card.choices.map(c => action(el, frame, c.key, c.label + (c.lit ? ' ●' : ''), c.onPress, { hotkey: c.hotkey }))}
        </Box>
      ) : null}
    </Box>
  )
}
