// The bands that take the dashboard's place when something wants a decision: cold cache, heavy
// context, a hot plan limit, a judge that failed, the compact bar, and the cards that report a
// compact or a handoff in progress and done.
//
// Each one is 리플이 telling you one thing: its face of the moment on the left, a short title that
// says what, one line that says why, then at most one main action, the others quiet, and a way to
// let it go. Where the card is about a figure (context, plan limit), its ring is that gauge. The
// terminal draws it as 리플이's column (parts.tsx `speak`); the desktop as a capsule of the deep
// lit in the card's own colour (see "Desktop" below).

import { t } from '../i18n'
import type { RenderNode } from 'claude-code'

import { CELL_PX, ROW_PX } from './art'
import { DISPLAY, displayText } from './display'
import { lookOf } from './look'
import type { Sea } from './art'
import { capsule, closeButton, pill, ripple, segmented, well } from './kit'
import { action, actions, canDraw, dismiss, speak } from './parts'
import type { Els } from './parts'
import { FACE_TONE } from './ripple'
import type { Face } from './ripple'
import { chOf, textTone } from './theme'
import type { AlertActions, AlertView, Frame } from './view'
import { compactNumber, isRich, limitName, resetsLabel } from './view'

type Choice = { key: string; label: string; hotkey: string; onPress: () => void }

export type Card = {
  key: string
  /** 리플이's face; on the terminal its tone colours the title's mark. */
  face: Face
  /** The ring as a gauge (context or limit percent). */
  percent?: number
  title: string
  body: string
  /** The one thing to press, drawn as the host's primary button. */
  main?: Choice
  /** Other actions, quiet. */
  quiet?: Choice[]
  /** Letting the card go: the host's × on the desktop. */
  close?: Choice
}

const JUDGE_NAME = { haiku: 'settings.haiku', jev: 'settings.jev', model: 'alerts.routerModel' } as const

export function cardOf(frame: Frame, alert: AlertView, a: AlertActions): Card {
  const L = frame.lang
  const notNow: Choice = { key: 'dismiss', label: t(L, 'alerts.notNow'), hotkey: 'n', onPress: a.dismiss }
  const cancel: Choice = { key: 'dismiss', label: t(L, 'alerts.cancel'), hotkey: 'x', onPress: a.dismiss }
  const compact: Choice = { key: 'compact', label: t(L, 'band.compact'), hotkey: 'c', onPress: () => a.compact() }
  switch (alert.kind) {
    case 'cold':
      return {
        key: 'cold',
        face: 'sleepy',
        title: t(L, 'alerts.coldTitle'),
        body: t(L, 'alerts.coldBody', { tokens: compactNumber(alert.tokens), minutes: alert.idleMinutes }),
        main: compact,
        close: notNow,
      }
    case 'kept':
      return {
        key: 'kept',
        face: 'pleased',
        title: t(L, 'alerts.keptTitle'),
        body: t(L, 'alerts.keptBody', { pings: alert.pings, tokens: compactNumber(alert.tokens), minutes: alert.minutesLeft }),
        close: { key: 'dismiss', label: t(L, 'alerts.gotIt'), hotkey: 'x', onPress: a.dismiss },
      }
    case 'swamp':
      return {
        key: 'swamp',
        face: 'uneasy',
        percent: alert.percent,
        title: t(L, 'alerts.swampTitle', { percent: Math.round(alert.percent) }),
        body: t(L, 'alerts.swampBody', { tokens: compactNumber(alert.tokens) }),
        main: compact,
        close: notNow,
      }
    case 'hot': {
      const resets = resetsLabel(alert.resetsAt, frame.now, L)
      const save: Choice = { key: 'save', label: alert.save ? t(L, 'alerts.saveOff') : t(L, 'alerts.save'), hotkey: 's', onPress: a.toggleSave }
      return {
        key: 'hot',
        face: alert.percent >= 95 ? 'alarmed' : 'strained',
        percent: alert.percent,
        title: t(L, 'alerts.hotTitle', { window: limitName(alert.limitKind, L), percent: Math.round(alert.percent) }),
        body: (resets ? resets.charAt(0).toUpperCase() + resets.slice(1) + '. ' : '') + (alert.save ? t(L, 'alerts.saveOnBody') : t(L, 'alerts.saveBody')),
        // Save mode on, there is nothing left to do: turning it off is the quiet way back.
        ...(alert.save ? { quiet: [save] } : { main: save }),
        close: notNow,
      }
    }
    case 'judgeDown':
      return {
        key: 'judge',
        face: 'dazed',
        title: t(L, alert.network ? 'alerts.judgeNetworkTitle' : 'alerts.judgeTitle'),
        body: t(L, 'alerts.judgeBody', { judge: t(L, JUDGE_NAME[alert.judge]), reason: displayText(alert.reason), fallback: t(L, alert.judge === 'haiku' ? 'alerts.keepEffort' : 'alerts.askHaiku') }),
        main: { key: 'settings', label: t(L, 'alerts.openSettings'), hotkey: 'o', onPress: a.openSettings },
        close: notNow,
      }
    case 'result':
      return resultCard(frame, alert, a)
    case 'compactNote': {
      // The tidy-up is on unless the person turned it off; its switch sits quiet beside Compact.
      const tidy: Choice = { key: 'tidy', label: t(L, 'alerts.tidyFirst', { state: t(L, alert.tidy ? 'band.on' : 'band.off') }), hotkey: 't', onPress: a.toggleTidy }
      return {
        key: 'note',
        face: 'asking',
        title: t(L, 'alerts.compactTitle'),
        body: t(L, 'alerts.compactBody') + (alert.pick === 'session' && alert.cold ? '\n' + t(L, 'alerts.compactCold') : ''),
        quiet: [tidy],
        main: { ...compact, onPress: () => a.compact(alert.draft) },
        close: cancel,
      }
    }
    case 'clear':
      return {
        key: 'clear',
        face: 'asking',
        title: t(L, 'alerts.clearTitle'),
        body: t(L, 'alerts.clearBody'),
        main: { key: 'clear-go', label: t(L, 'alerts.clearGo'), hotkey: 'g', onPress: a.clear },
        close: cancel,
      }
  }
}

function resultCard(frame: Frame, alert: Extract<AlertView, { kind: 'result' }>, a: AlertActions): Card {
  const L = frame.lang
  const close: Choice = { key: 'dismiss', label: t(L, 'alerts.dismiss'), hotkey: 'x', onPress: a.dismiss }
  switch (alert.stage) {
    case 'handingOff':
      return { key: 'result', face: 'going', title: t(L, 'alerts.handingOff'), body: (alert.detail === undefined ? undefined : displayText(alert.detail)) ?? t(L, 'alerts.quickProgress') }
    case 'handoffDone':
      return { key: 'result', face: 'pleased', title: t(L, 'alerts.handoffDone'), body: (alert.detail === undefined ? undefined : displayText(alert.detail)) ?? t(L, 'alerts.summaryReady'), quiet: [{ key: 'copy', label: t(L, 'alerts.copyAgain'), hotkey: 'y', onPress: a.copy }], close }
    case 'tidying':
      // Put away while it runs: the turn is in the chat, and the compaction follows it either way.
      return { key: 'result', face: 'working', title: t(L, 'alerts.tidying'), body: (alert.detail === undefined ? undefined : displayText(alert.detail)) ?? t(L, 'alerts.tidyingBody'), close }
    case 'compacting':
      return { key: 'result', face: 'squeezing', title: t(L, 'alerts.compacting'), body: (alert.detail === undefined ? undefined : displayText(alert.detail)) ?? t(L, 'alerts.compactingBody') }
    case 'compacted':
      return { key: 'result', face: 'pleased', title: t(L, 'alerts.compacted'), body: (alert.detail === undefined ? undefined : displayText(alert.detail)) ?? t(L, 'alerts.compactedBody'), close }
    case 'failed':
      return { key: 'result', face: 'sorry', title: t(L, 'alerts.failed'), body: (alert.detail === undefined ? undefined : displayText(alert.detail)) ?? t(L, 'alerts.unchanged'), close }
  }
}

function extras(el: Els, frame: Frame, alert: AlertView, a: AlertActions): RenderNode[] {
  const { Box } = el
  if (alert.kind === 'compactNote' && 'Input' in el) {
    const Field = el.Input
    return [
      ...('Select' in el && alert.models.length > 1 ? [<Box key="compact-model-row" flexDirection="row" alignItems="center" columnGap={2}><el.Text dimColor>{t(frame.lang, 'alerts.compactModel')}</el.Text><el.Select key="compact-model" options={alert.models} value={alert.pick} onSelect={(value: string) => a.pickCompactModel(value)} /></Box>] : []),
      <Field
        key="note"
        label={t(frame.lang, 'alerts.keep')}
        placeholder={t(frame.lang, 'alerts.keepPlaceholder')}
        value={displayText(alert.draft, DISPLAY.conversation)}
        submitLabel={t(frame.lang, 'alerts.compactSubmit')}
        autoFocus
        onInput={(text: string) => a.noteInput(text)}
        onSubmit={(text: string) => a.compact(text)}
      />,
    ]
  }
  return []
}

// ---- Desktop: the card as a capsule of the deep ------------------------------------------------
//
// The card's colour is its light (ice and falling snow for a cold cache, amber and bubbles for a
// heavy chat, embers for a hot limit, a red scanline for a broken judge, sparkles while it asks, a
// current while it works, green and a tick drawn in when done); 리플이 at the start in its full
// drawing, so its face says what the card is about; the title in the card's colour, the why after it
// in soft ink, then the quiet actions as ghost buttons, the main one lit, and the way out. One row
// when it all fits; else the why and the choices go under the title.

function seaOf(card: Card, alert: AlertView): Omit<Sea, 'at'> {
  switch (card.key) {
    case 'cold':
      return { tone: 'ice', weather: 'snow', motes: true }
    case 'kept':
      return { tone: 'amber', weather: 'sparkles', ripples: 'calm' }
    case 'swamp':
      return { tone: 'amber', weather: 'bubbles', ripples: 'calm' }
    case 'hot':
      return { tone: (card.percent ?? 0) >= 95 ? 'red' : 'ember', weather: 'embers' }
    case 'judge':
      return { tone: 'red', weather: 'static' }
    case 'note':
    case 'clear':
      return { tone: 'violet', weather: 'sparkles', ripples: 'calm' }
    default: {
      const stage = alert.kind === 'result' ? alert.stage : 'failed'
      if (stage === 'handingOff' || stage === 'compacting' || stage === 'tidying') return { tone: 'violet', ripples: 'busy', current: true }
      if (stage === 'failed') return { tone: 'red', weather: 'static' }
      return { tone: 'green', tick: true, weather: 'sparkles' }
    }
  }
}

/** 리플이 on a card, px: the full drawing (ripple.ts), brows and mouth and all. */
const CARD_FACE = 34

function drawnExtras(el: Els, frame: Frame, alert: AlertView, a: AlertActions): RenderNode[] {
  const { Box, Text } = el
  const k = lookOf(frame)
  if (alert.kind === 'compactNote' && 'Input' in el) {
    const Field = el.Input
    const name = t(frame.lang, 'alerts.keep').trim()
    const placeholder = t(frame.lang, 'alerts.keepPlaceholder')
    // The field's own label would take the host's ink; its name is ours, beside its well.
    const cells = Math.max(20, frame.columns - Math.ceil(CARD_FACE / CELL_PX) - Math.ceil(chOf(name)) - 10)
    return [
      // Drawn, as the settings' own pickers are: the host's Select takes the host's ink, which a light
      // theme leaves dark on this dark card (2026-10-31). The dashboard keeps the choices to five.
      ...(alert.models.length > 1 ? [<Box key="compact-model-row" flexDirection="row" alignItems="center" columnGap={2} flexWrap="wrap"><Text {...k.sub}>{t(frame.lang, 'alerts.compactModel')}</Text>{segmented(el, frame, 'compact-model', alert.models, alert.pick, value => a.pickCompactModel(value))}</Box>] : []),
      <Box key="note-row" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
        <Text {...k.sub}>{name}</Text>
        {well(el, frame, 'note', cells, (
          <Field
            key="note"
            placeholder={placeholder}
            value={displayText(alert.draft, DISPLAY.conversation)}
            submitLabel={t(frame.lang, 'alerts.compactSubmit')}
            autoFocus
            onInput={(text: string) => a.noteInput(text)}
            onSubmit={(text: string) => a.compact(text)}
          />
        ), placeholder)}
      </Box>,
    ]
  }
  return []
}

function drawnAlert(el: Els, frame: Frame, alert: AlertView, a: AlertActions): RenderNode {
  const { Box, Text } = el
  const k = lookOf(frame)
  const card = cardOf(frame, alert, a)
  const sea = seaOf(card, alert)
  const tone = sea.tone
  const quiet = card.quiet ?? []
  // The note's field has its own submit, which is the main action there.
  const fieldSubmits = alert.kind === 'compactNote' && 'Input' in el
  const main = card.main && !fieldSubmits ? card.main : undefined
  const more = drawnExtras(el, frame, alert, a)
  // The actions' cells, as drawn (each pill its own whole cells, a cell between, the way out last).
  const actionCells = quiet.reduce((n, c) => n + k.art.pill(c.label, 'ghost', tone).cells + 1, 0) + (main ? k.art.pill(main.label, 'primary', tone).cells + 1 : 0) + (card.close ? 4 : 0)
  const faceCells = Math.ceil(CARD_FACE / CELL_PX) + 2
  const room = frame.columns - 4
  const oneRow = !more.length && faceCells + chOf(card.title) * 1.12 + 2 + chOf(card.body) + 2 + actionCells <= room
  // Too narrow to keep the actions beside the words: they go under them.
  const actionsBelow = !oneRow && room - faceCells - actionCells < 30
  // Beside a title and a why of two lines, the actions sit at the card's middle, not on the title's
  // line (2026-10-13: they rode high). Beside the compact note's field they stay by the title, the
  // × where a way out is looked for.
  const buttons = (
    <Box key="actions" flexDirection="row" alignItems="center" alignSelf={more.length ? 'flex-start' : 'center'} columnGap={1} flexShrink={0} flexWrap="wrap" rowGap={1}>
      {quiet.map(c => pill(el, frame, c.key, c.label, 'ghost', c.onPress, tone))}
      {main ? pill(el, frame, main.key, main.label, 'primary', main.onPress, tone) : null}
      {card.close ? closeButton(el, frame, card.close.key, card.close.label, card.close.onPress) : null}
    </Box>
  )
  const face = ripple(el, frame, card.key, card.face, card.title, CARD_FACE, card.percent)
  const title = <Text key="title" bold color={k.tone(tone)} wrap="wrap">{card.title}</Text>
  const body = <Text key="body" {...k.sub} wrap="wrap">{card.body}</Text>
  const top = oneRow ? (
    <Box key="top" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
      {face}
      <Box key="title-slot" flexShrink={0}>{title}</Box>
      <Box key="say" flexDirection="row" flexGrow={1} flexShrink={1} width={0} minWidth={0}>
        {body}
      </Box>
      {buttons}
    </Box>
  ) : (
    <Box key="top" flexDirection="row" alignItems="flex-start" columnGap={2} width="100%" minWidth={0}>
      {/* Beside two lines 리플이 sits at their middle, not on the title's line (2026-10-14: it rode high). */}
      <Box key="face" alignSelf="center" flexShrink={0}>{face}</Box>
      <Box key="say" flexDirection="column" rowGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
        {title}
        {body}
        {more}
        {actionsBelow ? buttons : null}
      </Box>
      {actionsBelow ? null : buttons}
    </Box>
  )
  const rows = oneRow ? 2 : 4 + (more.length ? 3.2 + (more.length - 1) * 2 : 0) + (actionsBelow ? 2 : 0) + (frame.columns < 60 ? 3 : 0)
  return capsule(el, frame, {
    key: 'alert-' + card.key,
    // The light comes from 리플이: on the title's line in one row, at the card's middle beside more.
    sea: { ...sea, reach: 130, at: { x: 1.5 * CELL_PX + CARD_FACE / 2, y: oneRow ? 0.5 * ROW_PX * 0.5 + CARD_FACE / 2 : rows * ROW_PX / 2 } },
    rows,
    children: [top],
  })
}

/** One alert band, chosen by register.tsx from the priority list in the spec (§5 Bands). */
export function renderAlert(el: Els, frame: Frame, alert: AlertView, a: AlertActions): RenderNode {
  if (canDraw(el, frame)) return drawnAlert(el, frame, alert, a)
  const card = cardOf(frame, alert, a)
  const rich = isRich(frame)
  const tone = FACE_TONE[card.face]
  const text = textTone(frame.appearance)
  const press = (c: Choice, primary = false) => action(el, frame, c.key, c.label, c.onPress, { hotkey: c.hotkey, primary })
  const close = card.close ? dismiss(el, frame, card.close.key, card.close.label, card.close.onPress, card.close.hotkey) : ''
  const buttons = [card.main ? press(card.main, true) : '', ...(card.quiet ?? []).map(c => press(c)), rich ? '' : close]
  // The terminal has no face: a text mark says it instead (work going on, done, failed or broken,
  // a warning, a question).
  const mark = card.face === 'squeezing' || card.face === 'going' || card.face === 'working' ? '…' : tone === 'ok' ? '✓' : tone === 'bad' ? '✕' : tone === 'warn' ? '▲' : '◉'
  return speak(el, frame, {
    key: 'alert-' + card.key,
    face: card.face,
    title: rich ? card.title : mark + ' ' + card.title,
    titleColor: tone === 'accent' ? text.accent : text[tone],
    line: card.body,
    ...(card.percent !== undefined ? { percent: card.percent } : {}),
    blocks: [...extras(el, frame, alert, a), actions(el, frame, buttons)],
    ...(rich && close ? { dismiss: close } : {}),
  })
}
