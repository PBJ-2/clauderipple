// The limits pane, opened from the band's limits row: every plan window the router answered —
// Claude's 5-hour, weekly and per-model weeklies, then each other provider account's — with the
// share used in it and exactly when it resets. The band's row gauges the shares alone; its room went
// to them, so the reset reads here (2026-10-25). The first pane was a bare table of figures and
// "4시간 뒤" or "수 15:35", and the owner asked for the mod's own look and the exact moment
// (2026-10-29): the reset as a local date and time to the minute and the time left, both.
//
// Every account the owner added has its tile, Claude's stored accounts too (2026-11-04: the pane
// showed only the Claude account in use); the band's row keeps to that one (view.ts bandLimitGroups).
//
// The desktop draws one capsule, as the Context pane does: a dial of the window closest to its cap
// with the pane's title and how many windows are past 80%, then a tile per provider account (its
// colour's dot, "GPT 1"/"GPT 2" when a provider has several, then "사용 중" as a small badge on the
// one the router serves new turns with, then the account's label, dim, cut before the badge ever is),
// and in it a line per window: its name, a bar of the share in limitTone's colour, the figure, and
// under them when it resets and the time left. A window whose reset has passed says so, and that its share may be from before it. Save
// mode, while on, says until when under Claude's tile (the one in use, of several). The terminal
// draws the same in lines of text, the badge as "(사용 중)" and the label after a "·".
//
// A window the router expects to run out before its reset (`exhaustsAt`, 2026-11-09) is at least
// amber, red within the hour, and says under its reset how long until it runs out at its pace.
// After the windows a cost tile says what the requests cost at public API prices (see costDrawn).
//
// The pane redraws when the limits are read again (once a minute at most) and as the minute
// changes, so the water holds still: no ripples to start over.

import { t } from '../i18n'
import type { Lang } from '../i18n'
import type { RenderNode } from 'claude-code'

import type { CostSummary, LimitItem } from '../../types'
import { CELL_PX, INK, ROW_PX, TONE, barArt, esc, labelPx, r, svg } from './art'
import type { Tone } from './art'
import { capsule, closeButton, pic } from './kit'
import { DISPLAY, displayText } from './display'
import { lookOf } from './look'
import type { Look } from './look'
import { canDraw, textButton } from './parts'
import type { Els } from './parts'
import { chOf, displayWidth, limitTone, providerColor, svgDoc, textTone } from './theme'
import { costFigure, exhaustSentence, limitGroupAccount, limitGroupName, limitGroupNumbered, limitGroups, limitItemName, limitItemTone, resetMoment, timeLeft } from './view'
import type { Frame, LimitGroup, LimitsActions, LimitsView } from './view'

// ---- What each window says -----------------------------------------------------------------------

/** When a window resets: still ahead, already passed (the share may predate it), or not given. */
type Reset = { kind: 'ahead'; at: number } | { kind: 'passed'; at: number } | { kind: 'none' }

function resetOf(item: LimitItem, now: number): Reset {
  const at = item.resetsAt ? Date.parse(item.resetsAt) : NaN
  if (!Number.isFinite(at)) return { kind: 'none' }
  return at > now ? { kind: 'ahead', at } : { kind: 'passed', at }
}

type Tonal = ReturnType<typeof limitTone>

/** The window closest to its cap, with its group: the highest share, the first of equals. */
function topOf(groups: readonly LimitGroup[]): { group: LimitGroup; item: LimitItem } | null {
  let top: { group: LimitGroup; item: LimitItem } | null = null
  for (const group of groups) for (const item of group.items) if (!top || item.percent > top.item.percent) top = { group, item }
  return top
}

/** How many windows are at 80% or more (limitTone's amber and red), in a sentence. */
function nearLine(items: readonly LimitItem[], lang: Lang): string {
  const near = items.filter(item => limitTone(item.percent) !== 'ink').length
  return near === 0 ? t(lang, 'limits.clear') : near === 1 ? t(lang, 'limits.nearOne') : t(lang, 'limits.near', { count: near })
}

const isClaudeGroup = (group: LimitGroup): boolean => group.type === 'anthropic' || group.provider === 'claude' || group.provider === 'anthropic'

/**
 * The Claude tile save mode's sentence goes under: the account in use, else the first. Save mode
 * follows the plan of the account the turns are spent on, and once is enough: with every Claude
 * account listed it stood under each of them (2026-11-04).
 */
function saveGroupOf(groups: readonly LimitGroup[]): LimitGroup | undefined {
  const claude = groups.filter(isClaudeGroup)
  return claude.find(group => group.inUse) ?? claude[0]
}

/** Save mode's sentence under Claude's own windows, while it holds Auto down. */
function saveLine(view: LimitsView, group: LimitGroup, saveGroup: LimitGroup | undefined, now: number, lang: Lang): string {
  return group === saveGroup && view.saveUntil !== undefined && view.saveUntil > now ? t(lang, 'limits.saveOn', { date: resetMoment(view.saveUntil, lang) }) : ''
}

const percentOf = (item: LimitItem): string => Math.round(item.percent) + '%'

/**
 * A window's name in the pane: the band's (limitItemName), and its span after it when another
 * window of the account shares that name — Gemini's two "3P" windows read "3P 5시간", "3P 주간".
 */
function windowName(item: LimitItem, group: LimitGroup, lang: Lang): string {
  const name = limitItemName(item, lang)
  const twin = group.items.some(other => other !== item && limitItemName(other, lang) === name)
  return twin && item.windowMinutes ? name + ' ' + limitItemName({ kind: 'window', label: '', windowMinutes: item.windowMinutes }, lang) : name
}

// ---- Desktop -------------------------------------------------------------------------------------

/** The dial's side, px. */
const DIAL_PX = 56
/** A window's bar: its height, px, and the least and most it is drawn across. */
const BAR_H = 8
const BAR_MIN = 48
const BAR_MAX = 640
/** The least room a window's name takes, so the bars start alike. */
const NAME_MIN = 6
/** Cells a figure takes: the widest ("100%") in bold, right-aligned in it. */
const FIGURE_CELLS = Math.ceil(chOf('100%') * 1.08)

/** Cells of text a capsule has across: the pane less its air and edges (context.tsx). */
function innerCells(frame: Frame): number {
  return Math.max(24, frame.columns - 4)
}

/** A tone of limitTone as the deep's lights name it. */
const lightOf = (tone: Tonal): Tone | 'ink' => (tone === 'warn' ? 'amber' : tone === 'bad' ? 'red' : 'ink')

/** A figure's colour on a capsule: the skin's ink while all is well, amber, then red. */
function figureWord(k: Look, tone: Tonal): { color?: string } {
  return tone === 'warn' ? { color: k.tone('amber') } : tone === 'bad' ? { color: k.tone('red') } : k.ink
}

/**
 * A window's share as a bar `width` px across: the band's own (art.ts `barArt`) on the deep, its
 * track a hairline on the water; on flat the app's surface, the track a soft grey and the fill the
 * accent, amber or red of the theme.
 */
function barOf(frame: Frame, percent: number, tone: Tonal, width: number): string {
  if (frame.skin !== 'flat') return barArt(percent, lightOf(tone), width, BAR_H)
  const share = Math.max(0, Math.min(1, Math.round(percent) / 100))
  const fill = tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--bad)' : 'var(--accent)'
  return svgDoc(width, BAR_H,
    frame.appearance,
    '<defs><clipPath id="c"><rect width="' + width + '" height="' + BAR_H + '" rx="' + BAR_H / 2 + '"/></clipPath></defs>' +
    '<rect width="' + width + '" height="' + BAR_H + '" rx="' + BAR_H / 2 + '" fill="#8a867d" fill-opacity=".2"/>' +
    '<g clip-path="url(#c)"><rect width="' + r(width * share) + '" height="' + BAR_H + '" fill="' + fill + '"/></g>')
}

/** The window closest to its cap as a dial: its share as an arc from the top, the figure in the middle. */
function dialOf(frame: Frame, percent: number): string {
  const s = DIAL_PX
  const c = s / 2
  const rad = c - 4
  const stroke = 5
  const turn = 2 * Math.PI * rad
  const tone = limitTone(percent)
  const flat = frame.skin === 'flat'
  const length = r((turn * Math.max(0, Math.min(100, Math.round(percent)))) / 100)
  const paint = flat
    ? (tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--bad)' : 'var(--accent)')
    : tone === 'ink' ? 'url(#g)' : TONE[lightOf(tone) as Tone].hi
  const ink = flat
    ? (tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--bad)' : 'var(--ink)')
    : tone === 'ink' ? INK : TONE[lightOf(tone) as Tone].text
  const figure = Math.round(percent) + '%'
  const body =
    '<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#67e8f9"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs>' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + rad + '" fill="none" stroke="' + (flat ? '#8a867d' : '#fff') + '" stroke-opacity="' + (flat ? 0.22 : 0.12) + '" stroke-width="' + stroke + '"/>' +
    (length !== '0' ? '<circle cx="' + c + '" cy="' + c + '" r="' + rad + '" fill="none" stroke="' + paint + '" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + length + ' ' + r(turn) + '" transform="rotate(-90 ' + c + ' ' + c + ')"/>' : '') +
    '<text x="' + c + '" y="' + r(c + 5) + '" text-anchor="middle" font-size="' + (figure.length > 3 ? 12 : 14) + '" font-weight="680" style="fill:' + ink + '">' + figure + '</text>'
  return flat ? svgDoc(s, s, frame.appearance, body) : svg(s, s, body)
}

/** The in-use badge's height, px, and its type size: under a line's, so the tile's head keeps its height. */
const TAG_H = 16
const TAG_TYPE = 10.5

/**
 * "사용 중" as a small badge right after the account's number: on the deep a faint glass capsule
 * edged and lettered in violet (the accent, never a violet ground); on flat the app's grey with the
 * accent. Its width is the label's own, px; it is never cut, the account's name beside it is.
 */
function tagOf(frame: Frame, label: string): { source: string; width: number } {
  const flat = frame.skin === 'flat'
  const pad = 6
  const width = Math.ceil(labelPx(label, TAG_TYPE) + pad * 2)
  const edge = flat ? 'var(--accent)' : TONE.violet.hi
  const ink = flat ? 'var(--accent)' : TONE.violet.text
  const body =
    '<rect x=".5" y=".5" width="' + (width - 1) + '" height="' + (TAG_H - 1) + '" rx="' + r((TAG_H - 1) / 2) + '" fill="' + (flat ? '#8a867d' : '#fff') + '" fill-opacity="' + (flat ? 0.1 : 0.06) + '" stroke="' + edge + '" stroke-opacity=".5"/>' +
    '<text x="' + r(width / 2) + '" y="' + r(TAG_H / 2 + TAG_TYPE * 0.36) + '" text-anchor="middle" font-size="' + TAG_TYPE + '" font-weight="600" style="fill:' + ink + '">' + esc(label) + '</text>'
  return { source: flat ? svgDoc(width, TAG_H, frame.appearance, body) : svg(width, TAG_H, body), width }
}

function headDrawn(el: Els, frame: Frame, view: LimitsView, groups: readonly LimitGroup[], numbered: (g: LimitGroup) => boolean, actions: LimitsActions): RenderNode {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const top = topOf(groups)
  const close = closeButton(el, frame, 'limits-close', t(L, 'settings.close'), actions.close)
  if (!top) {
    return (
      <Box key="limits-head" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold {...k.ink}>{t(L, 'limits.title')}</Text>
          <Text {...k.sub} wrap="wrap">{t(L, 'limits.empty')}</Text>
        </Box>
        {close}
      </Box>
    )
  }
  const tone = limitTone(top.item.percent)
  const name = limitGroupName(top.group, numbered(top.group)) + ' ' + windowName(top.item, top.group, L)
  return (
    <Box key="limits-head" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
      {pic(el, 'limits-dial', dialOf(frame, top.item.percent), t(L, 'limits.top') + ' ' + name + ' ' + percentOf(top.item), DIAL_PX, DIAL_PX)}
      <Box key="limits-say" flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text bold {...k.ink}>{t(L, 'limits.title')}</Text>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
          <Text {...k.sub}>{t(L, 'limits.top')}</Text>
          <Text bold {...figureWord(k, tone)}>{name + ' ' + percentOf(top.item)}</Text>
        </Box>
        <Text {...k.mute} wrap="wrap">{nearLine(view.items, L)}</Text>
      </Box>
      <Box key="limits-tools" flexDirection="row" alignItems="center" flexShrink={0}>
        {close}
      </Box>
    </Box>
  )
}

/** Cells the widest window name of a group takes, so its bars start alike. */
function nameCells(group: LimitGroup, lang: Lang): number {
  return Math.max(NAME_MIN, ...group.items.map(item => Math.ceil(chOf(windowName(item, group, lang)))))
}

/** Lines `text` wraps to in `cells` of room. */
function linesOf(text: string, cells: number): number {
  return Math.max(1, Math.ceil(chOf(text) / Math.max(8, cells)))
}

/**
 * Lines the reset takes under a window's bar, in `cells` (the tile's room less the name's). In a
 * narrow pane the date wraps and the time left drops to a line of its own: counted as one line, the
 * water stopped short of the last tiles and the page showed white beneath them (2026-11-07, four
 * accounts in a pane a phone's width).
 */
function whenLines(reset: Reset, cells: number, lang: Lang, now: number): number {
  if (reset.kind === 'none') return linesOf(t(lang, 'limits.noReset'), cells)
  if (reset.kind === 'passed') return linesOf(t(lang, 'limits.passed', { date: resetMoment(reset.at, lang) }), cells) + linesOf(t(lang, 'limits.stale'), cells)
  const on = t(lang, 'limits.resetsOn', { date: resetMoment(reset.at, lang) })
  const left = t(lang, 'limits.left', { time: timeLeft(reset.at - now, lang) })
  return chOf(on) + 2 + chOf(left) <= cells ? 1 : linesOf(on, cells) + linesOf(left, cells)
}

/** One window: its name, bar and figure on a line; when it resets and the time left under them. */
function windowDrawn(el: Els, frame: Frame, group: LimitGroup, item: LimitItem, i: number, name: number, barPx: number, whenCells: number): { node: RenderNode; rows: number } {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  // A forecast that the window runs out before it resets makes the line at least amber (view.ts).
  const tone = limitItemTone(item, frame.now)
  const reset = resetOf(item, frame.now)
  const label = windowName(item, group, L)
  const exhaust = exhaustSentence(item, frame.now, L)
  // A passed reset leaves a share that may be the old window's, so its figure is quiet.
  const figure = reset.kind === 'passed' ? k.sub : figureWord(k, tone)
  const when: RenderNode[] = reset.kind === 'ahead'
    ? [
        <Box key="on" flexShrink={1} minWidth={0}><Text {...k.sub} wrap="wrap">{t(L, 'limits.resetsOn', { date: resetMoment(reset.at, L) })}</Text></Box>,
        <Box key="left" flexShrink={0}><Text bold {...k.ink}>{t(L, 'limits.left', { time: timeLeft(reset.at - frame.now, L) })}</Text></Box>,
      ]
    : reset.kind === 'passed'
      ? [
          <Box key="passed" flexDirection="column" flexShrink={1} minWidth={0}>
            <Text color={k.tone('amber')} wrap="wrap">{t(L, 'limits.passed', { date: resetMoment(reset.at, L) })}</Text>
            <Text {...k.mute} wrap="wrap">{t(L, 'limits.stale')}</Text>
          </Box>,
        ]
      : [<Box key="none" flexShrink={1} minWidth={0}><Text {...k.mute} wrap="wrap">{t(L, 'limits.noReset')}</Text></Box>]
  return {
    node: (
      <Box key={'window-' + i} flexDirection="column" width="100%" minWidth={0}>
        <Box key="gauge" flexDirection="row" alignItems="center" columnGap={1} width="100%" minWidth={0}>
          <Box key="name" width={name} flexShrink={0}>
            <Text {...k.ink} wrap="truncate">{label}</Text>
          </Box>
          <Box key="bar" flexGrow={1} flexShrink={1} minWidth={0} alignItems="center">
            {pic(el, 'bar-' + i, barOf(frame, item.percent, tone, barPx), label + ' ' + percentOf(item), barPx, BAR_H)}
          </Box>
          <Box key="figure" width={FIGURE_CELLS} flexShrink={0} flexDirection="row" justifyContent="flex-end">
            <Text bold {...figure}>{percentOf(item)}</Text>
          </Box>
        </Box>
        <Box key="when" flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2} paddingLeft={name + 1} width="100%" minWidth={0}>
          {when}
        </Box>
        {exhaust ? (
          <Box key="exhaust" paddingLeft={name + 1} width="100%" minWidth={0}>
            <Text {...figureWord(k, tone)} wrap="wrap">{exhaust}</Text>
          </Box>
        ) : null}
      </Box>
    ),
    rows: 1.2 + whenLines(reset, whenCells, L, frame.now) * 1.05 + (exhaust ? linesOf(exhaust, whenCells) * 1.05 : 0),
  }
}

function groupDrawn(el: Els, frame: Frame, view: LimitsView, group: LimitGroup, numbered: boolean, saveGroup: LimitGroup | undefined): { node: RenderNode; rows: number } {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const name = nameCells(group, L)
  // The tile's text room: the capsule's, less the tile's own air and edge.
  const room = innerCells(frame) - 4
  const barPx = Math.max(BAR_MIN, Math.min(BAR_MAX, Math.floor((room - name - FIGURE_CELLS - 2) * CELL_PX)))
  const save = saveLine(view, group, saveGroup, frame.now, L)
  const account = limitGroupAccount(group, numbered, L)
  const tag = account.tag ? tagOf(frame, account.tag) : null
  const windows = group.items.map((item, i) => windowDrawn(el, frame, group, item, i, name, barPx, room - name - 1))
  return {
    node: (
      <Box key={'limits-group-' + group.key} flexDirection="column" rowGap={1} width="100%" minWidth={0} paddingX={1.5} paddingY={0.5} {...k.tile}>
        <Box key="head" flexDirection="column" width="100%" minWidth={0}>
          <Box key="name" flexDirection="row" alignItems="center" columnGap={1} width="100%" minWidth={0}>
            <Text color={providerColor(group.type ?? group.provider)}>●</Text>
            <Box key="title" flexShrink={0}><Text bold {...k.ink}>{limitGroupName(group, numbered)}</Text></Box>
            {tag ? <Box key="tag" flexShrink={0} alignItems="center">{pic(el, 'in-use-' + group.key, tag.source, account.tag, tag.width, TAG_H)}</Box> : null}
            {account.label ? <Box key="label" flexShrink={1} minWidth={0}><Text {...k.mute} wrap="truncate">{account.label}</Text></Box> : null}
            {save ? <Box key="save" flexShrink={0}><Text color={k.tone('violet')}>{t(L, 'alerts.save')}</Text></Box> : null}
          </Box>
          {save ? <Text key="save" {...k.sub} wrap="wrap">{save}</Text> : null}
        </Box>
        {windows.map(w => w.node)}
      </Box>
    ),
    rows: 1 + (save ? 2 : 0) + windows.reduce((n, w) => n + w.rows + 0.5, 0) + 0.6,
  }
}

// ---- Cost ----------------------------------------------------------------------------------------
//
// Under the plan windows, what the requests cost at public API prices (2026-11-09): today since the
// local midnight, each provider's share and the models that cost most, then the last seven days. A
// subscription's requests are shown at what the API would have charged, which the note under the
// figures says, with what the figures leave out: requests with no known price ("—" on a line that
// has nothing but those) and the "≈" of a total that includes an estimated cache rate. A part the
// router has not answered is left out, and with none the tile says so; a failed read keeps the last
// good one (register.tsx refreshCost), so no figure here is ever a placeholder.

/** A cost line: a name (a provider's with its dot) and its amount at the right. */
type CostRow = { key: string; name: string; dot?: string; figure: string; bold?: boolean }

function costRows(summary: CostSummary): { providers: CostRow[]; models: CostRow[] } {
  return {
    providers: summary.providers.map((line, i) => ({ key: 'provider-' + i, name: displayText(line.name, DISPLAY.name), dot: providerColor(line.name), figure: costFigure(line) })),
    models: summary.models.map((line, i) => ({ key: 'model-' + i, name: displayText(line.name, DISPLAY.name), figure: costFigure(line) })),
  }
}

/**
 * The notes under the figures: how the amounts are worked out, then what they leave out. The
 * counts are the largest of the totals shown (the week holds the day), since the note is for all.
 */
function costNotes(cost: NonNullable<LimitsView['cost']>, lang: Lang): { text: string; warn: boolean }[] {
  const periods = [cost.today, cost.week].filter((p): p is CostSummary => !!p)
  if (!periods.length) return []
  const unpriced = Math.max(...periods.map(p => p.total.unpricedRequests))
  const estimated = Math.max(...periods.map(p => p.total.estimatedRequests))
  return [
    { text: t(lang, 'cost.note'), warn: false },
    ...(unpriced > 0 ? [{ text: t(lang, 'cost.unpriced', { count: unpriced }), warn: true }] : []),
    ...(estimated > 0 ? [{ text: t(lang, 'cost.estimated', { count: estimated }), warn: false }] : []),
  ]
}

/** One line of the cost tile: the name gives way (cut) before the amount does. */
function costLine(el: Els, k: Look, row: CostRow): RenderNode {
  const { Box, Text } = el
  return (
    <Box key={row.key} flexDirection="row" alignItems="center" columnGap={1} width="100%" minWidth={0}>
      {row.dot ? <Text color={row.dot}>●</Text> : null}
      <Box key="name" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text {...(row.bold ? k.ink : k.sub)} wrap="truncate">{row.name}</Text>
      </Box>
      <Box key="figure" flexShrink={0}>
        <Text bold={row.bold} {...k.ink}>{row.figure}</Text>
      </Box>
    </Box>
  )
}

/** The cost tile, or null when the view carries no cost at all (an older caller). */
function costDrawn(el: Els, frame: Frame, cost: LimitsView['cost'], room: number): { node: RenderNode; rows: number } | null {
  if (!cost) return null
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const today = cost.today
  const week = cost.week
  const lists = today ? costRows(today) : { providers: [], models: [] }
  const notes = costNotes(cost, L)
  const sections: { node: RenderNode; lines: number }[] = []
  const section = (key: string, children: RenderNode[], lines: number) => sections.push({ node: <Box key={key} flexDirection="column" width="100%" minWidth={0}>{children}</Box>, lines })
  const total = (key: string, label: string, summary: CostSummary) => costLine(el, k, { key, name: label, figure: costFigure(summary.total), bold: true })
  if (!today && !week) section('none', [<Text key="none" {...k.sub} wrap="wrap">{t(L, 'cost.unavailable')}</Text>], linesOf(t(L, 'cost.unavailable'), room))
  if (today) section('today', [total('today-total', t(L, 'cost.today'), today)], 1)
  if (lists.providers.length) section('providers', [<Text key="head" {...k.mute}>{t(L, 'cost.providers')}</Text>, ...lists.providers.map(row => costLine(el, k, row))], 1 + lists.providers.length)
  if (lists.models.length) section('models', [<Text key="head" {...k.mute}>{t(L, 'cost.models')}</Text>, ...lists.models.map(row => costLine(el, k, row))], 1 + lists.models.length)
  if (week) section('week', [total('week-total', t(L, 'cost.week'), week)], 1)
  if (notes.length) {
    section('notes', notes.map((note, i) => <Text key={'note-' + i} {...(note.warn ? { color: k.tone('amber') } : k.mute)} wrap="wrap">{note.text}</Text>), notes.reduce((n, note) => n + linesOf(note.text, room), 0))
  }
  return {
    node: (
      <Box key="limits-cost" flexDirection="column" rowGap={1} width="100%" minWidth={0} paddingX={1.5} paddingY={0.5} {...k.tile}>
        <Text key="title" bold {...k.ink}>{t(L, 'cost.title')}</Text>
        {sections.map(s => s.node)}
      </Box>
    ),
    rows: 1 + sections.reduce((n, s) => n + s.lines * 1.05 + 0.5, 0) + 0.6,
  }
}

function limitsDrawn(el: Els, frame: Frame, view: LimitsView, actions: LimitsActions): RenderNode {
  const groups = limitGroups(view.items)
  const numbered = limitGroupNumbered(groups)
  const saveGroup = saveGroupOf(groups)
  const tiles = groups.map(group => groupDrawn(el, frame, view, group, numbered(group), saveGroup))
  const cost = costDrawn(el, frame, view.cost, innerCells(frame) - 4)
  if (cost) tiles.push(cost)
  const top = topOf(groups)
  // Taken generously: a capsule taller than its water would show the page beneath (kit.tsx).
  const rows = (top ? 4 : 3) + tiles.reduce((n, tile) => n + tile.rows + 0.5, 0) + 2
  return capsule(el, frame, {
    key: 'limits',
    // The light sits behind the dial, amber once a window is past 80%; still, as the pane redraws.
    sea: { tone: top && limitTone(top.item.percent) !== 'ink' ? 'amber' : 'violet', reach: 100, at: { x: 1.5 * CELL_PX + DIAL_PX / 2, y: ROW_PX * 0.5 + DIAL_PX / 2 } },
    rows,
    paddingY: 1,
    gap: 1,
    children: [headDrawn(el, frame, view, groups, numbered, actions), ...tiles.map(tile => tile.node)],
  })
}

// ---- Terminal ------------------------------------------------------------------------------------

/** Cells of the terminal's bar. */
const TEXT_BAR = 10

/** The cost as lines of text (the same sections as the cost tile), or '' when the view carries none. */
function costLines(el: Els, frame: Frame, cost: LimitsView['cost']): RenderNode {
  if (!cost) return ''
  const { Box, Text } = el
  const L = frame.lang
  const tone = textTone(frame.appearance)
  const today = cost.today
  const lists = today ? costRows(today) : { providers: [], models: [] }
  const rows = [...lists.providers, ...lists.models]
  const name = Math.min(32, Math.max(NAME_MIN, displayWidth(t(L, 'cost.today')), displayWidth(t(L, 'cost.week')), ...rows.map(row => displayWidth(row.name) + (row.dot ? 2 : 0))))
  const line = (row: CostRow, indent: number) => (
    <Box key={row.key} flexDirection="row" columnGap={2} paddingLeft={indent}>
      <Box width={name} flexShrink={0}><Text wrap="truncate">{row.dot ? <Text color={row.dot}>•</Text> : null}{row.dot ? ' ' : ''}{row.name}</Text></Box>
      <Text>{row.figure}</Text>
    </Box>
  )
  const total = (key: string, label: string, summary: CostSummary) => (
    <Box key={key} flexDirection="row" columnGap={2} paddingLeft={2}>
      <Box width={name} flexShrink={0}><Text wrap="truncate">{label}</Text></Box>
      <Text bold>{costFigure(summary.total)}</Text>
    </Box>
  )
  const notes = costNotes(cost, L)
  return (
    <Box key="limit-cost" flexDirection="column">
      <Text bold>{t(L, 'cost.title')}</Text>
      {!today && !cost.week ? <Box paddingLeft={2}><Text dimColor wrap="wrap">{t(L, 'cost.unavailable')}</Text></Box> : null}
      {today ? total('today', t(L, 'cost.today'), today) : null}
      {lists.providers.length ? <Box key="providers" flexDirection="column"><Box paddingLeft={2}><Text dimColor>{t(L, 'cost.providers')}</Text></Box>{lists.providers.map(row => line(row, 4))}</Box> : null}
      {lists.models.length ? <Box key="models" flexDirection="column"><Box paddingLeft={2}><Text dimColor>{t(L, 'cost.models')}</Text></Box>{lists.models.map(row => line(row, 4))}</Box> : null}
      {cost.week ? total('week', t(L, 'cost.week'), cost.week) : null}
      {notes.map((note, i) => <Box key={'note-' + i} paddingLeft={2}><Text color={note.warn ? tone.warn : undefined} dimColor={!note.warn} wrap="wrap">{note.text}</Text></Box>)}
    </Box>
  )
}

function limitsText(el: Els, frame: Frame, view: LimitsView, actions: LimitsActions): RenderNode {
  const { Box, Text } = el
  const L = frame.lang
  const tone = textTone(frame.appearance)
  const groups = limitGroups(view.items)
  const colorOf = (level: Tonal) => (level === 'warn' ? tone.warn : level === 'bad' ? tone.bad : undefined)
  const head = (
    <Box key="limits-head" flexDirection="column" width="100%" minWidth={0}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text bold>{t(L, 'limits.title')}</Text>
        {textButton(el, 'limits-close', t(L, 'settings.close'), actions.close, 'x')}
      </Box>
      <Text dimColor wrap="wrap">{groups.length ? nearLine(view.items, L) : t(L, 'limits.empty')}</Text>
    </Box>
  )
  if (!groups.length) return <Box flexDirection="column" rowGap={1} width="100%">{head}{costLines(el, frame, view.cost)}</Box>
  const numbered = limitGroupNumbered(groups)
  const saveGroup = saveGroupOf(groups)
  const name = Math.max(NAME_MIN, ...groups.flatMap(group => group.items.map(item => displayWidth(windowName(item, group, L)))))
  return (
    <Box flexDirection="column" rowGap={1} width="100%">
      {head}
      {groups.map(group => {
        const save = saveLine(view, group, saveGroup, frame.now, L)
        const account = limitGroupAccount(group, numbered(group), L)
        return (
          <Box key={'limit-group-' + group.key} flexDirection="column">
            <Box key="head" flexDirection="row" alignItems="center" columnGap={1} minWidth={0}>
              <Text color={providerColor(group.type ?? group.provider)}>•</Text>
              <Box key="title" flexShrink={0}><Text bold>{limitGroupName(group, numbered(group))}</Text></Box>
              {account.tag ? <Box key="tag" flexShrink={0}><Text color={tone.accent}>{'(' + account.tag + ')'}</Text></Box> : null}
              {account.label ? <Box key="label" flexShrink={1} minWidth={0}><Text dimColor wrap="truncate">{'· ' + account.label}</Text></Box> : null}
              {save ? <Box key="save" flexShrink={0}><Text color={tone.accent}>{t(L, 'alerts.save')}</Text></Box> : null}
            </Box>
            {save ? <Box key="save" paddingLeft={2}><Text dimColor wrap="wrap">{save}</Text></Box> : null}
            {group.items.map((item, i) => {
              const level = limitItemTone(item, frame.now)
              const exhaust = exhaustSentence(item, frame.now, L)
              const reset = resetOf(item, frame.now)
              const filled = Math.round((Math.max(0, Math.min(100, item.percent)) / 100) * TEXT_BAR)
              const when = reset.kind === 'ahead'
                ? t(L, 'limits.resetsOn', { date: resetMoment(reset.at, L) }) + ' · ' + t(L, 'limits.left', { time: timeLeft(reset.at - frame.now, L) })
                : reset.kind === 'passed'
                  ? t(L, 'limits.passed', { date: resetMoment(reset.at, L) }) + ' ' + t(L, 'limits.stale')
                  : t(L, 'limits.noReset')
              return (
                <Box key={'window-' + i} flexDirection="column" paddingLeft={2}>
                  <Box key="gauge" flexDirection="row" columnGap={2}>
                    <Box width={name} flexShrink={0}><Text wrap="truncate">{windowName(item, group, L)}</Text></Box>
                    <Text>
                      <Text color={colorOf(level) ?? tone.accent}>{'█'.repeat(filled)}</Text>
                      <Text dimColor>{'░'.repeat(TEXT_BAR - filled)}</Text>
                    </Text>
                    <Box width={4} justifyContent="flex-end" flexShrink={0}>
                      <Text bold color={colorOf(level)}>{percentOf(item)}</Text>
                    </Box>
                  </Box>
                  <Box key="when" paddingLeft={name + 2}>
                    <Text color={reset.kind === 'passed' ? tone.warn : undefined} dimColor={reset.kind !== 'passed'} wrap="wrap">{when}</Text>
                  </Box>
                  {exhaust ? (
                    <Box key="exhaust" paddingLeft={name + 2}>
                      <Text color={colorOf(level)} wrap="wrap">{exhaust}</Text>
                    </Box>
                  ) : null}
                </Box>
              )
            })}
          </Box>
        )
      })}
      {costLines(el, frame, view.cost)}
    </Box>
  )
}

// ---- The pane ------------------------------------------------------------------------------------

/** The limits pane body: drawn in a capsule on the desktop, as lines of text on the terminal. */
export function renderLimits(el: Els, frame: Frame, view: LimitsView, actions: LimitsActions): RenderNode {
  return canDraw(el, frame) ? limitsDrawn(el, frame, view, actions) : limitsText(el, frame, view, actions)
}

/** The render boundary's last resort: the error in plain words and the way out, nothing to fail again. */
export function renderLimitsFallback(el: Els, frame: Frame, error: string, close: () => void): RenderNode {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="column" rowGap={1} width="100%">
      <Box flexDirection="row" columnGap={2}>
        <Text bold>{t(frame.lang, 'limits.title')}</Text>
        <Button key="limits-close" plain role="dismiss" label={t(frame.lang, 'settings.close')} onPress={() => close()} />
      </Box>
      <Text dimColor wrap="wrap">{displayText(error, DISPLAY.preview)}</Text>
    </Box>
  )
}
