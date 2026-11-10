// The dashboard band above the prompt, and its minimal form in the footer.
//
// Desktop: one capsule of the deep (see "Desktop" below, art.ts and kit.tsx): 리플이 glowing at its
// left, acting out what the band is doing (thinking while Auto picks, busy while a request is out,
// drowsy as the cache runs out, asleep once it has, otherwise its idle life), the effort as five
// bars rising shallow to deep, the context ring, the cache clock in whole minutes, the plan limit
// (its window a gauge, its name and reset in the tip) and the mode when on, the last route, the
// judge's reason; then the drawn controls and the way out.
// What each fact means shows in the reason's place on hover. The terminal draws the same facts as
// one quiet row of text, without 리플이.
//
// Facts of the desktop host that shape it (claude.ai assets, read 2026-10-10 and 2026-10-12):
// - Each answer the band gives is drawn as a freshly built DOM tree swapped in for the last one,
//   and an Svg becomes a new <img> of a data URL or, interactive, a new sandboxed <iframe srcdoc>.
//   The frame paints blank until loaded, so an interactive Svg blinks on every redraw; the image
//   does not (seen in the owner's app, 2026-10-11), and its CSS motion runs. So every picture is
//   a plain image whose source is fixed per state: a redraw hands the host the same document and
//   only starts its motion over.
// - The surface asks again on every write of state the band read and on every invalidate, and
//   takes each answer as new. So the countdown shows whole minutes, and register.tsx invalidates
//   only when the minute shown changes.
// - The host's own buttons are its idiom (its primary button is the app's clay orange, and a plain
//   one's label takes the theme's ink), so the desktop draws its controls (art.ts) and lays a blank
//   native button over each (kit.tsx); a state is in the drawing (a switch's track, a lit flame).
//
// No item's width depends on its value: each fact has a slot sized for the widest value its
// language can show; the route is counted at a fixed room and takes what the row leaves. The
// controls sit at the right end, so a changing value never moves a neighbour.

import { t } from '../i18n'
import type { Lang } from '../i18n'
import type { RenderChildren, RenderNode } from 'claude-code'

import type { Effort, LimitItem } from '../../types'
import { AGENTS_W, CELL_PX, DEPTH, countedWidth, ICON_PX, METER_H, METER_W, MUTE, ROW_PX, SUB, TONE, barArt, textPx } from './art'
import { lookOf } from './look'
import type { Word } from './look'
import type { Sea, Tone } from './art'
import { CLOSE_CELLS, capsule, closeButton, hoverLight, lift, lit, pic, pill, press, ripple, rowsOf, segmented, word, wordCells } from './kit'
import { textButton } from './parts'
import { DISPLAY, displayText } from './display'
import type { Els } from './parts'
import type { Face } from './ripple'
import { cacheTone, chOf, clip, contextTone, displayWidth, limitTone, providerColor, textTone } from './theme'
import type { BandActions, DashboardView, Frame, LimitGroup } from './view'
import { EFFORTS, bandLimitGroups, compactNumber, effortIndex, effortLabel, effortName, exhaustLeft, exhaustSentence, exhaustShort, exhaustShortWidest, isRich, limitGroupName, limitGroupNumbered, limitGroups, limitItemName, limitItemTip, limitItemTone, limitName, minutesLeft, modelName, narrowLimitGroups, rateText, resetsLabel, seconds } from './view'

/** Growing ripples: low → max. */
const RIPPLE_CHAR = ['·', '∘', '○', '◎', '◉']
/** Theme keys: they follow the person's light or dark theme on every surface. */
const WARN = 'warning'
const BAD = 'error'
/** Cells between facts, and between controls. */
const GAP = 2
const CTRL_GAP = 1
/** The least room a route is drawn in; on the desktop the host cuts the name to what is left. */
const ROUTE_MIN = 14
const RICH_ROUTE_MIN = 6
/** Desktop: the slot of the live agents' count after its control. */
const COUNT_CELLS = 2
/** The cache's last stretch, when 리플이 grows drowsy: five minutes, or a fifth of a short life. */
const DROWSY_MS = 5 * 60_000

/** What 리플이 acts out in the band, and so which of its fixed sources the band shows. */
export type BandMood = { face: Extract<Face, 'thinking' | 'working' | 'drowsy' | 'sleepy' | 'calm'>; dim: boolean }

/**
 * Thinking while Auto picks, working while a request is out, asleep once the cache has run out
 * and drowsy in its last minutes (not while keep-warm holds it), else its idle life; dimmed at
 * rest when Auto is off or paused. Read from whole minutes, as the countdown is, so the mood
 * changes no more often than what the band shows.
 */
export function bandMood(frame: Frame, view: DashboardView): BandMood {
  const quiet = view.effort.mode === 'off' || view.effort.mode === 'paused'
  if (view.effort.mode === 'deciding') return { face: 'thinking', dim: false }
  if (view.isWorking) return { face: 'working', dim: false }
  const cache = view.cache
  if (cache && !view.hide.includes('timer')) {
    const left = cache.expiresAt - frame.now
    if (left <= 0) return { face: 'sleepy', dim: quiet }
    const shown = Math.ceil(left / 60_000) * 60_000
    const held = view.warm.on && !view.warm.stopped
    if (!held && shown <= Math.min(DROWSY_MS, cache.ttlMs / 5)) return { face: 'drowsy', dim: quiet }
  }
  return { face: 'calm', dim: quiet }
}
/** The reason's slot on a wide terminal. */
const WHY_CELLS = 28

type Run = { text: string; color?: string; dim?: boolean; bold?: boolean }

/** One fact of the band: a slot of fixed width holding a glyph, a value and quiet trailing runs. */
export type Fact = {
  key: string
  /** Cells the slot takes, whatever it shows. */
  width: number
  /** Desktop: a quiet name before the value, so a bare "60 min" says what it is. */
  label?: Run
  glyph?: Run
  value: Run
  /** The value is a button (desktop): the effort opens its menu, the route the log. */
  onPress?: () => void
  /** Desktop: the slot takes the room the row leaves instead of `width` (the route). */
  grow?: true
  tail?: Run[]
  /** What a hover card says, a line each (desktop). */
  card?: string[]
}

/**
 * Cells `text` takes: terminal columns, or on the desktop the host's `ch`, the width of "0" in its
 * 14 px sans. Measured 2026-10-10 in Chromium on macOS: ch 8.8 px, Hangul and kana ~12 px (1.36 ch),
 * "Medium" 5.9 ch, "X-High" 5.1 ch. Each class of character is taken a little wide of that; the
 * terminal's 2 cells for a wide character would leave a gap after every short Korean value.
 */
function cells(frame: Frame, text: string): number {
  return isRich(frame) ? Math.ceil(chOf(text)) : displayWidth(text)
}

function widest(frame: Frame, texts: readonly string[]): number {
  return Math.max(1, ...texts.map(text => cells(frame, text)))
}

/** The host's padding either side of a Button's label in the band, in ch (about 8 px each). */
const PAD = 2

/** What the effort slot can show: the names and "Deciding…" (a dash when there is no level). */
function effortWords(lang: Lang, rich: boolean): string[] {
  const words = [...EFFORTS.map(e => effortName(e, lang)), t(lang, 'band.deciding')]
  return rich ? words : words.map(w => w.toLowerCase())
}

// ---- Facts -------------------------------------------------------------------------------------

export function effortFact(frame: Frame, view: DashboardView, onPress: () => void): Fact {
  const rich = isRich(frame)
  const accent = textTone(frame.appearance).accent
  const { level, mode, why } = view.effort
  const idx = effortIndex(level)
  const quiet = mode === 'off' || mode === 'paused'
  const glyph: Run =
    mode === 'deciding' ? { text: '◌', color: accent } : mode === 'paused' ? { text: '‖', dim: true } : { text: idx >= 0 ? RIPPLE_CHAR[idx]! : '○', ...(mode === 'auto' ? { color: accent } : quiet ? { dim: true } : {}) }
  // Paused or off with no level known: a dash; the glyph, the Auto toggle and the card say why.
  const word = mode === 'deciding' ? t(frame.lang, 'band.deciding') : level ? effortName(level, frame.lang) : '—'
  const label = rich ? word : word.toLowerCase()
  const value: Run = mode === 'deciding' ? { text: label, color: accent } : quiet ? { text: label, dim: true } : { text: label, bold: !rich }
  const tag = t(frame.lang, mode === 'auto' || mode === 'deciding' ? 'band.auto' : mode === 'manual' ? 'band.manual' : mode === 'paused' ? 'band.paused' : 'band.autoOff')
  const hint =
    mode === 'paused' ? t(frame.lang, 'band.pausedHint') : mode === 'off' ? t(frame.lang, 'band.offHint') : mode === 'deciding' ? t(frame.lang, 'band.decidingHint') : why ?? ''
  // Terminal: glyph, a cell, the label. Desktop: the glyph, then the label's button, whose own
  // padding is the air on both sides.
  // The desktop names the slot instead of a glyph: a ripple a few pixels across read as noise, not
  // as a level. A cell to spare: a host font a little wider than the estimate must not wrap it.
  const name = t(frame.lang, 'band.effortShort')
  const width = rich ? Math.ceil(chOf(name) + PAD + 1 + Math.max(...effortWords(frame.lang, rich).map(chOf))) : 2 + widest(frame, effortWords(frame.lang, rich))
  return {
    key: 'effort',
    width,
    ...(rich ? { label: { text: name, dim: true } } : { glyph }),
    value,
    ...(rich ? { onPress } : {}),
    card: [[view.model, tag].filter(Boolean).join(' · '), t(frame.lang, 'band.effortTitle', { value: word, hint: hint ? ' — ' + hint : '' })],
  }
}

/** Cells a mode's name may take in the band; a longer one is cut with an ellipsis. */
export const MODE_CELLS = 12

/** The active mode's name as the band shows it: whole, or cut to its slot. */
export function modeLabel(name: string): string {
  return clip(name, MODE_CELLS)
}

/**
 * The active operating mode, when one is on: "Mode Burn GPT" in the accent, its slot the same
 * width whatever the name (cut past MODE_CELLS), the whole name in the hover card.
 */
export function modeFact(frame: Frame, view: DashboardView): Fact | null {
  if (!view.mode) return null
  const rich = isRich(frame)
  const name = t(frame.lang, 'band.mode')
  const value: Run = { text: rich ? modeLabel(view.mode) : name + ' ' + modeLabel(view.mode), color: textTone(frame.appearance).accent }
  const card = [t(frame.lang, 'band.modeTip', { name: view.mode })]
  // Desktop: a cell is about a ch; Latin capitals run a little wider, so the slot takes 1.1 ch each.
  if (rich) return { key: 'mode', width: Math.ceil(chOf(name) + 1 + MODE_CELLS * 1.1), label: { text: name, dim: true }, value, card }
  return { key: 'mode', width: cells(frame, name) + 1 + MODE_CELLS, value, card }
}

/** The pie a share of the cache's life reads as. */
function pie(frac: number): string {
  return frac > 0.875 ? '●' : frac > 0.625 ? '◕' : frac > 0.375 ? '◑' : frac > 0.125 ? '◔' : '○'
}

export function cacheFact(frame: Frame, view: DashboardView): Fact | null {
  if (view.hide.includes('timer')) return null
  const accent = textTone(frame.appearance).accent
  const cache = view.cache
  const left = cache ? cache.expiresAt - frame.now : 0
  // Whole minutes, as shown: the slot changes once a minute and no more.
  const shown = cache && left > 0 ? Math.ceil(left / 60_000) : 0
  const warm = view.warm
  const lit = warm.on && !warm.stopped
  const last = shown === 1
  const glyph: Run = { text: shown > 0 && cache ? pie(Math.min(1, (shown * 60_000) / cache.ttlMs)) : '○', ...(last ? { color: WARN } : lit && shown > 0 ? { color: accent } : { dim: true }) }
  const text = cache ? minutesLeft(left, frame.lang) : '—'
  const value: Run = last ? { text, color: WARN } : { text, dim: shown === 0 }
  const tip = cache
    ? t(frame.lang, 'band.cacheTip', {
        state: shown > 0 ? t(frame.lang, 'band.warmFor', { time: text }) : t(frame.lang, 'band.expired'),
        warm: warm.on ? (warm.stopped ? t(frame.lang, 'band.warmStoppedTip', { reason: warm.stopped }) : t(frame.lang, 'band.warmOnTip', { count: warm.pings })) : '',
      })
    : t(frame.lang, 'band.noReply')
  const words = [t(frame.lang, 'units.minutes', { n: 60 }), t(frame.lang, 'band.cold'), '—']
  if (!isRich(frame)) return { key: 'cache', width: 2 + widest(frame, words), glyph, value, card: [tip] }
  // Desktop: "Cache 58 min", the last minute in the warning colour; the pie read as a status dot.
  const name = t(frame.lang, 'band.cache')
  return { key: 'cache', width: Math.ceil(chOf(name) + 1 + Math.max(...words.map(chOf))), label: { text: name, dim: true }, value, card: [tip] }
}

export function contextFact(frame: Frame, view: DashboardView): Fact | null {
  const ctx = view.context
  if (!ctx || !view.extras.includes('context')) return null
  const tone = contextTone(ctx.percent)
  const rich = isRich(frame)
  // Desktop: "Context 38%" in the facts' idiom; the terminal keeps its short "ctx 38%".
  const text = rich ? Math.round(ctx.percent) + '%' : t(frame.lang, 'band.footerContext', { percent: Math.round(ctx.percent) })
  const value: Run = tone === 'ink' ? { text, dim: !rich } : { text, color: tone === 'warn' ? WARN : BAD }
  const name = t(frame.lang, 'band.context')
  const width = rich ? Math.ceil(chOf(name) + 1 + chOf('100%')) : cells(frame, t(frame.lang, 'band.footerContext', { percent: 100 }))
  return { key: 'context', width, ...(rich ? { label: { text: name, dim: true } } : {}), value, card: [t(frame.lang, 'band.contextAlt', { value: Math.round(ctx.percent) + '%', window: compactNumber(ctx.window), tokens: compactNumber(ctx.tokens) })] }
}

export function limitFact(frame: Frame, view: DashboardView): Fact | null {
  const limit = view.limit
  if (!limit || !view.extras.includes('limits')) return null
  const tone = limitTone(limit.percent)
  const rich = isRich(frame)
  const save = t(frame.lang, 'band.save')
  const tail: Run[] = limit.save ? [{ text: save, color: textTone(frame.appearance).accent }] : []
  const resets = resetsLabel(limit.resetsAt, frame.now, frame.lang)
  const card = [t(frame.lang, 'band.limitAlt', { window: limitName(limit.kind, frame.lang), value: Math.round(limit.percent) + '%', reset: resets ? ', ' + resets : '' })]
  if (rich) {
    // Desktop: "5h limit 64%", not a bare "5h 64%".
    const names = (['five_hour', 'seven_day'] as const).map(kind => t(frame.lang, 'band.limitCaption', { window: limitName(kind, frame.lang), save: '' }))
    const text = Math.round(limit.percent) + '%'
    const value: Run = tone === 'ink' ? { text } : { text, color: tone === 'warn' ? WARN : BAD }
    const width = Math.ceil(Math.max(...names.map(chOf)) + 1 + chOf('100%') + 1 + chOf(save))
    return { key: 'limit', width, label: { text: names[limit.kind === 'five_hour' ? 0 : 1]!, dim: true }, value, tail, card }
  }
  const text = limitName(limit.kind, frame.lang) + ' ' + Math.round(limit.percent) + '%'
  const value: Run = tone === 'ink' ? { text, dim: true } : { text, color: tone === 'warn' ? WARN : BAD }
  const width = widest(frame, [limitName('five_hour', frame.lang), limitName('seven_day', frame.lang)]) + cells(frame, ' 100%') + 1 + cells(frame, save)
  return { key: 'limit', width, value, tail, card: [t(frame.lang, 'band.limitAlt', { window: limitName(limit.kind, frame.lang), value: Math.round(limit.percent) + '%', reset: resets ? ', ' + resets : '' })] }
}

/** The router's notice when it has one, else the last route, in `room` cells; null when there is neither or no room. */
export function routeFact(frame: Frame, view: DashboardView, room: number, onPress: () => void): Fact | null {
  const rich = isRich(frame)
  if (view.hide.includes('route') || room < (rich ? RICH_ROUTE_MIN : ROUTE_MIN)) return null
  // The notice is the router's state now; a route is a record of an earlier request, and it must
  // not stand for a router that has stopped answering (2026-10-25).
  if (view.notice) return { key: 'route', width: room, ...(rich ? { grow: true as const } : {}), value: { text: clip(view.notice.replace(/^ClaudeRipple:\s*/, ''), room), dim: true } }
  const r = view.route
  if (!r) return null
  const glyph: Run = r.resent ? { text: '↻', dim: true } : r.ok ? { text: rich ? '→' : '↳', dim: true } : { text: '✕', color: BAD }
  // The desktop says what the figure is ("hit 100%"); a bare percentage beside a model name read as anything.
  const hit = r.cachePct !== undefined ? (rich ? t(frame.lang, 'band.hit', { percent: r.cachePct }) : r.cachePct + '%') : ''
  const base: Run[] = !r.ok
    ? [r.resent ? { text: t(frame.lang, 'band.resent', { status: r.status }), dim: true } : { text: r.status, color: BAD }]
    : r.cachePct !== undefined
      ? [cacheTone(r.cachePct) === 'ok' ? { text: hit, dim: true } : { text: hit, color: cacheTone(r.cachePct) === 'warn' ? WARN : BAD }]
      : []
  // The answer's speed after the hit, as the log says it (2026-11-07), kept only while the model's
  // whole name still fits beside it: the name is what the route is, and is never cut for the rate.
  const rate = r.ok && r.rate !== undefined ? t(frame.lang, 'log.rate', { rate: rateText(r.rate) }) : ''
  const cellsOf = (runs: readonly Run[]) => runs.reduce((n, run) => n + 1 + cells(frame, run.text), 0)
  const withRate: Run[] = rate ? [...base, { text: rate, dim: true }] : base
  const tail = room - 2 - cellsOf(withRate) >= cells(frame, r.model) ? withRate : base
  const modelRoom = room - 2 - cellsOf(tail)
  if (!rich && modelRoom < 4) return null
  const secs = seconds(r.seconds, frame.lang)
  const card = [
    t(frame.lang, 'band.routeAlt', { model: r.model, provider: r.provider, effort: r.effort ? ', ' + effortLabel(r.effort, frame.lang) : '', cache: r.cachePct !== undefined ? t(frame.lang, 'band.routeCache', { percent: r.cachePct }) : '', time: secs + (rate ? ', ' + rate : ''), status: r.ok ? '' : t(frame.lang, r.resent ? 'band.routeResent' : 'band.routeFailed', { status: r.status }) }),
    ...(r.note ? [r.note] : []),
    t(frame.lang, 'band.logHint'),
  ]
  // The desktop shows the whole name in whatever the row leaves; the host cuts it only past that.
  if (rich) return { key: 'route', width: room, grow: true, glyph, value: { text: r.model, dim: true }, onPress, tail, card }
  return { key: 'route', width: room, glyph, value: { text: clip(r.model, modelRoom) }, tail, card }
}

// ---- Controls ----------------------------------------------------------------------------------

/**
 * A control: its label, the hotkey, and whether it is on (a toggle that is on, an open pane). The
 * terminal says it in the label (● / ○), as its plain Buttons take no colour.
 */
type Control = { key: string; label: string; hotkey: string; onPress: () => void; on: boolean; count?: string }

function controls(frame: Frame, view: DashboardView, actions: BandActions): Control[] {
  const L = frame.lang
  const mark = (on: boolean) => (on ? ' ●' : ' ○')
  const out: Control[] = []
  // Handoff always shows (2026-10-24: one press, no advice), first in the row as it was.
  out.push({ key: 'handoff', label: t(L, 'band.handoff'), hotkey: 'h', onPress: actions.handoff, on: false })
  out.push(
    { key: 'auto', label: t(L, 'band.auto') + mark(view.auto), hotkey: 'a', onPress: actions.toggleAuto, on: view.auto },
    { key: 'warm', label: t(L, 'band.warm') + mark(view.warm.on), hotkey: 'w', onPress: actions.toggleWarm, on: view.warm.on },
    // The desktop opens the log from the route itself (its value is that button), so it has no Log of its own.
    ...(!isRich(frame) ? [{ key: 'log', label: t(L, 'band.log') + mark(view.logOpen), hotkey: 'l', onPress: actions.toggleLog, on: view.logOpen }] : []),
    // The count has a slot of its own (desktop) or is always a number (terminal): no width change.
    { key: 'agents', label: t(L, 'band.agents') + (isRich(frame) ? '' : ' ' + (view.agents.live || '·')) + mark(view.agentsOpen), hotkey: 'g', onPress: actions.toggleAgents, on: view.agentsOpen, ...(isRich(frame) ? { count: view.agents.live > 0 ? String(view.agents.live) : '' } : {}) },
    // The desktop's Clear asks first (a card of its own, "clear" in bandPriority); Compact opens its note bar.
    ...(isRich(frame) ? [{ key: 'compact', label: t(L, 'band.compact'), hotkey: 'c', onPress: actions.compact, on: false, count: view.compactions > 0 ? String(view.compactions) : '' }, { key: 'clear', label: t(L, 'band.clear'), hotkey: 'x', onPress: actions.clear, on: false }] : []),
    // A word on the desktop: the host's 14 px font draws ⚙ as a small ring that reads as "o".
    { key: 'settings', label: isRich(frame) ? t(L, 'band.settings') : '⚙', hotkey: 's', onPress: actions.openSettings, on: false },
  )
  return out
}

/** Cells a control takes. Desktop: the label in the button's padding, then the count's slot. */
function controlCells(frame: Frame, c: Control): number {
  if (!isRich(frame)) return cells(frame, c.hotkey) + 2 + cells(frame, c.label)
  return cells(frame, c.label) + PAD + (c.count !== undefined ? COUNT_CELLS : 0)
}

/** Every control's cells, so the route's room stays put. */
function controlsCells(frame: Frame, view: DashboardView, actions: BandActions): number {
  const list = controls(frame, view, actions)
  return list.reduce((n, c) => n + controlCells(frame, c), 0) + CTRL_GAP * (list.length - 1) * (isRich(frame) ? 1 : 2)
}

// ---- Layout ------------------------------------------------------------------------------------

const span = (facts: readonly Fact[]) => facts.reduce((n, f) => n + f.width, 0) + GAP * Math.max(0, facts.length - 1)

/** The facts in order, the route in what the row leaves it. */
function factsFor(frame: Frame, view: DashboardView, actions: BandActions, room: number, drop: readonly string[] = []): Fact[] {
  const fixed = [effortFact(frame, view, actions.toggleEffortMenu), modeFact(frame, view), contextFact(frame, view), cacheFact(frame, view), limitFact(frame, view)].filter(
    (f): f is Fact => f !== null && !drop.includes(f.key),
  )
  const left = room - span(fixed) - (fixed.length ? GAP : 0)
  // The desktop's route is a flex item: it takes what the row really leaves and the host cuts its
  // name past that.
  const route = drop.includes('route') ? null : routeFact(frame, view, isRich(frame) ? Math.max(left, RICH_ROUTE_MIN) : left, actions.toggleLog)
  return route ? [...fixed, route] : fixed
}

// ---- Desktop -----------------------------------------------------------------------------------
//
// One capsule of the deep (kit.tsx `capsule`): 리플이 at its left in a glow, ripples spreading from
// it (quick while a request is out, a current running along the floor), a sonar sweep while the
// judge sounds how deep to think, amber light as the cache runs out, frost and snow once it has. On
// it, left to right: the effort as five bars rising shallow to deep and its word; a rule; the
// context ring, the cache clock, the plan limit and the mode when on; a rule; the last route (its
// model the way into the log); the judge's reason in what is left. Then the controls, each lit
// under the pointer: Handoff, Auto's switch, keep-warm's flame, the agents, settings, and the way out.
// Pointing at a fact shows what it means in the reason's place.
// With the `limits` extra on and any window known, a second row under the first (starting where
// the effort does) gauges every plan window — Claude's, then each ChatGPT account's — and the
// first row's limit fact steps aside for the route. The row is a button: pressed, it opens the
// limits pane, where each window's share and when it resets are spelled out.

/** 리플이 in the band, px: the mini drawing (ripple.ts), a little taller than a line of text. */
export const BAND_RIPPLE = 24
/** 리플이's slot at the row's start, in cells: 24 px and its air. */
export const CREST_CELLS = 4
/** The row's height, px: a pill's, whether or not one shows, so nothing moves the band. */
const ROW_H = 26
// Fact and control widths alone decide the row, never a value, so a changing figure never moves its
// neighbours. The air between facts and between controls is trimmed below what reads as a whole cell
// (the limit's word became a gauge for the same reason): at 100 columns a route name of 13
// characters ("glm-5.3-flash") must draw whole beside everything else, and a loose gap ate the
// route's room and cut it (2026-10-14).
/** The air between facts, in cells (the host takes fractions of a cell). */
const DRAWN_GAP = 0.2
/** A rule between the band's groups, in cells. */
const RULE_CELLS = 1
/** The room the route is counted at (a model name and its hit); it takes more when the row has it. */
const ROUTE_ROOM = 14
/** The controls whose words go first when the band is narrow, in that order; Auto's goes last. */
const WORDLESS = ['clear', 'compact', 'settings', 'agents', 'warm'] as const
/** The capsule's own air, in cells across and rows down. */
const PAD_X = 1
const PAD_Y = 0.5

/** The water's light and motion for what 리플이 is acting out. */
function bandSea(mood: BandMood): Omit<Sea, 'at'> {
  const strength = mood.dim ? 0.5 : 1
  if (mood.face === 'thinking') return { tone: 'violet', ripples: 'calm', sweep: true, motes: true }
  if (mood.face === 'working') return { tone: 'violet', ripples: 'busy', current: true, strength }
  if (mood.face === 'drowsy') return { tone: 'amber', ripples: 'calm', motes: true, strength }
  if (mood.face === 'sleepy') return { tone: 'ice', weather: 'snow', strength: 0.8 }
  return { tone: 'violet', ripples: 'calm', motes: true, strength }
}

/** A fact's hover group: pointing at it shows its tip in the reason's place. */
const tipScope = (key: string) => 'ripple-tip-' + key

/**
 * `press`: the fact is a button, so its tip starts past it and leaves its light in sight. `counted`:
 * what the row's budget takes for it when its slot is drawn tight to the value shown, the widest
 * value's slot, so what the band drops never depends on a value (the route takes the difference).
 */
type DrawnFact = { key: string; cells: number; counted?: number; node: RenderNode; tip?: string; press?: () => void }
const countedCells = (f: DrawnFact): number => f.counted ?? f.cells

/** The air either side of a fact that is a button, in cells, inside its light as a control's is. */
const PRESS_PAD = 0.5
/**
 * Cells between a fact's picture and its words. A whole cell, and slots rounded up to whole cells,
 * read as loose once the app's type widened a cell (2026-10-25); slots are now exact.
 */
const FACT_GAP = 0.5

/**
 * A fact's Box. `lit`: the fact is a button, lit under the pointer as the controls are, so it reads
 * as one before it is pressed (2026-10-24: the context chip opened a pane and nothing said so).
 */
function drawnFact(el: Els, key: string, cells: number, children: RenderNode[], tip?: string, lit?: Frame): DrawnFact {
  const { Box } = el
  const scope = tip ? tipScope(key) : undefined
  const hover = lit ? { ...hoverLight(lit, scope), paddingX: PRESS_PAD } : scope ? { hover: { scope } } : {}
  return {
    key,
    cells,
    tip,
    node: (
      <Box key={'fact-' + key} position="relative" flexDirection="row" alignItems="center" columnGap={FACT_GAP} width={cells} flexShrink={0} {...hover}>
        {children}
      </Box>
    ),
  }
}

/** A figure's colour by its tone: bright ink while all is well, amber, then red. */
function figure(frame: Frame, tone: 'ink' | 'ok' | 'warn' | 'bad'): Word {
  const k = lookOf(frame)
  return tone === 'warn' ? { color: k.tone('amber') } : tone === 'bad' ? { color: k.tone('red') } : k.ink
}

function effortDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions): DrawnFact {
  const { Box, Text } = el
  const k = lookOf(frame)
  const { level, mode } = view.effort
  const idx = effortIndex(level)
  const word = mode === 'deciding' ? t(frame.lang, 'band.deciding') : level ? effortName(level, frame.lang) : '—'
  const look = mode === 'deciding' ? 'deciding' : mode === 'auto' ? 'auto' : mode === 'manual' ? 'manual' : 'quiet'
  // The word's slot is the word shown, taken a little wide for bold: a slot for the widest word left
  // "높음" in room for "매우 높음" (2026-10-25). The budget still counts the widest.
  const slot = (w: string) => (METER_W + FACT_GAP * CELL_PX + textPx(w) * 1.06) / CELL_PX + PRESS_PAD * 2
  const cells = slot(word)
  const tip = effortFact(frame, view, actions.toggleEffortMenu).card?.join(' · ')
  return withCounted(Math.max(...effortWords(frame.lang, true).map(slot)), drawnFact(
    el,
    'effort',
    cells,
    [
      pic(el, 'meter', k.art.meter(mode === 'deciding' ? 5 : idx + 1, look), t(frame.lang, 'band.effort'), METER_W, METER_H),
      <Box key="effort-word" flexShrink={0}>
        <Text bold {...(mode === 'deciding' ? { color: k.tone('violet') } : look === 'quiet' ? k.mute : k.ink)}>{word}</Text>
      </Box>,
      press(el, 'effort', cells * CELL_PX, actions.toggleEffortMenu),
    ],
    tip,
    frame,
  ))
}

const withCounted = (counted: number, f: DrawnFact): DrawnFact => ({ ...f, counted })

/**
 * The context ring and its share. With the Context pane to open it is a button (the app dropped the
 * breakdown its own ring under the composer opened, 2026-10-24): our ring and words, lit under the
 * pointer, a blank press laid over them, and its tip starting past it (bandDrawn). A tip laid over
 * the chip took its press and hid its light behind the tip's plate (2026-10-24). The pressable
 * tip leaves out the share the chip already shows.
 */
function contextDrawn(el: Els, frame: Frame, view: DashboardView, onPress?: () => void): DrawnFact | null {
  const ctx = view.context
  if (!ctx || !view.extras.includes('context')) return null
  const { Text } = el
  const tone = contextTone(ctx.percent)
  const tip = onPress
    ? t(frame.lang, 'band.contextOpen', { tokens: compactNumber(ctx.tokens), window: compactNumber(ctx.window) })
    : contextFact(frame, view)?.card?.join(' · ') || undefined
  // Drawn to the share shown (its digits are tabular, so only a new digit count moves what follows),
  // counted at "100%".
  const slot = (shown: string) => (16 + FACT_GAP * CELL_PX + textPx(shown)) / CELL_PX + (onPress ? PRESS_PAD * 2 : 0)
  const cells = slot(Math.round(ctx.percent) + '%')
  const counted = slot('100%')
  const ring = pic(el, 'ring', lookOf(frame).art.ring(ctx.percent, tone === 'ink' ? 'ink' : tone === 'warn' ? 'amber' : 'red'), t(frame.lang, 'band.context'), 16, 16)
  const value = <Text key="ctx-value" {...figure(frame, tone)}>{Math.round(ctx.percent) + '%'}</Text>
  if (!onPress) return withCounted(counted, drawnFact(el, 'context', cells, [ring, value], tip))
  return { ...drawnFact(el, 'context', cells, [ring, value, press(el, 'context', cells * CELL_PX, onPress)], tip, frame), counted, press: onPress }
}

function cacheDrawn(el: Els, frame: Frame, view: DashboardView): DrawnFact | null {
  if (view.hide.includes('timer')) return null
  const { Text } = el
  const cache = view.cache
  const left = cache ? cache.expiresAt - frame.now : 0
  const shown = cache && left > 0 ? Math.ceil(left / 60_000) : 0
  const held = view.warm.on && !view.warm.stopped
  const k = lookOf(frame)
  const drowsy = !!cache && shown > 0 && !held && shown * 60_000 <= Math.min(DROWSY_MS, cache.ttlMs / 5)
  const tone: Tone | 'soft' = shown === 0 ? 'soft' : drowsy ? 'amber' : held ? 'violet' : 'soft'
  const text = cache ? minutesLeft(left, frame.lang) : '—'
  const words = [t(frame.lang, 'units.minutes', { n: 60 }), t(frame.lang, 'band.cold'), '—']
  const cells = (16 + FACT_GAP * CELL_PX + Math.max(...words.map(textPx))) / CELL_PX
  const tip = cacheFact(frame, view)?.card?.join(' · ')
  return drawnFact(el, 'cache', cells, [
    pic(el, 'clock', k.art.clock(cache ? (shown * 60_000) / cache.ttlMs : 0, tone), t(frame.lang, 'band.cache'), 16, 16),
    <Text key="cache-value" {...(drowsy ? { color: k.tone('amber') } : shown === 0 ? k.mute : held ? { color: k.tone('violet') } : k.ink)}>{text}</Text>,
  ], tip)
}

function limitDrawn(el: Els, frame: Frame, view: DashboardView): DrawnFact | null {
  const limit = view.limit
  if (!limit || !view.extras.includes('limits')) return null
  const { Text } = el
  const save = t(frame.lang, 'band.save')
  // The window is a gauge (art.ts), not its word: at 100 columns the name "주간"/"Weekly" was cut
  // to "g…" beside the route, and the window's name and reset stay in the tip (2026-10-14). Save's
  // word takes room only while save mode is on: reserved always, it cost the limit its place on a
  // band near 95 columns (2026-10-14).
  const cells = (16 + FACT_GAP * CELL_PX + textPx('100%') + (limit.save ? FACT_GAP * CELL_PX + textPx(save) : 0)) / CELL_PX
  return drawnFact(el, 'limit', cells, [
    pic(el, 'limit', lookOf(frame).art.gauge(limit.kind), t(frame.lang, 'band.limit'), 16, 16),
    <Text key="limit-value" {...figure(frame, limitTone(limit.percent))}>{Math.round(limit.percent) + '%'}</Text>,
    limit.save ? <Text key="limit-save" color={lookOf(frame).tone('violet')}>{save}</Text> : '',
  ], limitFact(frame, view)?.card?.join(' · '))
}

function modeDrawn(el: Els, frame: Frame, view: DashboardView): DrawnFact | null {
  if (!view.mode) return null
  const { Text } = el
  // One slot whatever the name (cut past MODE_CELLS; Latin capitals run ~1.1 ch).
  const amber = lookOf(frame).tone('amber')
  return drawnFact(el, 'mode', 2 + Math.ceil(MODE_CELLS * 1.1), [<Text key="mode-mark" color={amber}>◆</Text>, <Text key="mode-name" color={amber}>{modeLabel(view.mode)}</Text>], t(frame.lang, 'band.modeTip', { name: view.mode }))
}

// ---- Limits row ----------------------------------------------------------------------------------
//
// The capsule's second row, under the first and starting where the effort does (a CREST_CELLS
// indent): every plan window as a small gauge — Claude's 5-hour, weekly and per-model weeklies,
// then each ChatGPT account's. A thinner row than the first (a line of text or so), and a button:
// pressed, it opens the limits pane, where each window's share and when it resets are readable
// (2026-10-25: the row has no room to add the reset beside every figure). Widths alone decide,
// never values: the bar is one width, the figure's slot fits "100%", and only the name takes what
// it takes (a changing figure never moves a neighbour). Narrow, the later providers' scoped windows
// (3P) go first, then the GPT accounts (the last one first), then the later providers' whole groups,
// and only then Claude's per-model windows (Fable): Claude's own windows outlast every later
// provider (the owner, 2026-11-10). Then the scoped windows that fit again come back (the refill).
// What is left not fitting means no second row, and the first row keeps its limit fact as before.
//
// A window the router expects to run out before it resets (`exhaustsAt`) is the one exception to
// "the share alone": its tone is at least amber, red within the hour, and after its figure the row
// says how long is left ("~2시간"). The forecast takes a slot of its own as wide as any form it can
// read as, so its value never moves a neighbour, and only while the window has one: every other
// window is drawn as it always was. Compact keeps to the tone, and the tip has the whole sentence.

/** A limit window's bar, px: beside each window's name and figure, in the row's own line. */
const BAR_W = 36
const BAR_H = 6
/** The air between the row's groups, in cells (a rule stands in it, as on the first row). */
const LIMITS_GAP = 2
/** The air above the row, in the host's vertical units (half a row each, 9.5 px). */
const LIMITS_TOP = 0.5
/** A lit Box's round edge above and below (1 px each), in those units: what the pressable row gives back. */
const LIGHT_EDGE = 2 / (ROW_PX / 2)

/** Cells a window's figure takes: whatever it shows, the slot fits the widest ("100%"). */
function figureCells(): number {
  return Math.ceil(textPx('100%') / CELL_PX)
}

/**
 * How much each window takes, widest first; the row takes the first that fits all its groups.
 * `gauge`: name, bar, figure. `figures`: name and figure. `compact`: a group's figures alone,
 * "1 / 88 / 2%" in its windows' order (the menu-bar and old footer idiom), each in its own tone, the
 * names and resets in the group's tip. At ~100 columns four providers fit only compact
 * (2026-10-15: Claude, GPT, Gemini and Go took ~207 cells as gauges against 96).
 */
type LimitDensity = 'gauge' | 'figures' | 'compact'
const DENSITIES: readonly LimitDensity[] = ['gauge', 'figures', 'compact']

/**
 * The slot a window's pace forecast takes after its figure ("~2시간"): the widest it can read as
 * (minutes, hours or days) and the air before it, so the forecast's value never moves a neighbour.
 */
function exhaustCells(lang: Lang): number {
  return Math.ceil(Math.max(...exhaustShortWidest(lang).map(textPx)) / CELL_PX) + 1
}

/**
 * Cells one window takes at a density (compact: its number's slot and the separator after it). A
 * window with a pace forecast takes the forecast's slot too (gauge and figures; compact has only
 * its tone), which is why the clock is asked for: the forecast ends when its moment passes.
 */
export function limitItemCells(item: LimitItem, density: LimitDensity, lang: Lang, now: number): number {
  // A figure's slot and the " / " after it, in fractions of a cell: summed per group, then rounded up.
  // Two digits: a window at 100% is spent and runs into the air after its group, which is wider.
  if (density === 'compact') return textPx('00 / ') / CELL_PX
  const name = Math.ceil(textPx(limitItemName(item, lang)) / CELL_PX) + 1
  return name + (density === 'gauge' ? Math.ceil(BAR_W / CELL_PX) + 1 : 0) + figureCells() + (exhaustLeft(item, now) === null ? 0 : exhaustCells(lang))
}

function limitItemDrawn(el: Els, frame: Frame, item: LimitItem, key: string, tip: string, density: Exclude<LimitDensity, 'compact'>): DrawnFact {
  const { Text } = el
  const tone = limitItemTone(item, frame.now)
  const name = limitItemName(item, frame.lang)
  const left = exhaustLeft(item, frame.now)
  return drawnFact(
    el,
    key,
    limitItemCells(item, density, frame.lang, frame.now),
    [
      <Text key="limit-name" {...lookOf(frame).mute}>{name}</Text>,
      density === 'gauge' ? pic(el, key + '-bar', barArt(item.percent, tone === 'ink' ? 'ink' : tone === 'warn' ? 'amber' : 'red'), name, BAR_W, BAR_H) : '',
      <Text key="limit-value" {...figure(frame, tone)}>{Math.round(item.percent) + '%'}</Text>,
      left === null ? '' : <Text key="limit-exhaust" {...figure(frame, tone)}>{exhaustShort(left, frame.lang)}</Text>,
    ],
    tip,
  )
}

/** A group's windows as one run of figures, "1 / 88 / 2%", each figure in its own tone. */
function compactDrawn(el: Els, frame: Frame, group: LimitGroup, key: string, tip: string, lang: Lang): DrawnFact {
  const { Text } = el
  const runs: RenderNode[] = []
  group.items.forEach((item, i) => {
    runs.push(<Text key={'n' + i} {...figure(frame, limitItemTone(item, frame.now))}>{String(Math.round(item.percent))}</Text>)
    runs.push(<Text key={'s' + i} {...lookOf(frame).mute}>{i < group.items.length - 1 ? ' / ' : '%'}</Text>)
  })
  const cells = Math.ceil(group.items.reduce((n, item) => n + limitItemCells(item, 'compact', lang, frame.now), 0))
  return drawnFact(el, key, cells, [<Text key="limit-figures">{runs}</Text>], tip)
}

/** Save mode's word after Claude's windows while it is on (it holds Auto down until Claude's reset). */
function saveWord(group: LimitGroup, save: boolean, lang: Lang): string {
  return save && (group.type === 'anthropic' || group.provider === 'claude') ? t(lang, 'band.save') : ''
}

/** Cells a group takes at a density: its head (the provider's dot and short name), its windows, save's word. */
function limitGroupCells(group: LimitGroup, name: string, lang: Lang, now: number, density: LimitDensity, save = false): number {
  const head = Math.ceil(textPx('•') / CELL_PX) + 1 + Math.ceil(textPx(name) / CELL_PX)
  const items = Math.ceil(group.items.reduce((n, item) => n + limitItemCells(item, density, lang, now), 0))
  const gaps = density === 'compact' ? 0 : Math.max(0, group.items.length - 1)
  const word = saveWord(group, save, lang)
  return head + 1 + items + gaps + (word ? 1 + Math.ceil(textPx(word) / CELL_PX) : 0)
}

function limitGroupDrawn(el: Els, frame: Frame, group: LimitGroup, name: string, save: boolean, density: LimitDensity): { node: RenderNode; tips: { key: string; text: string }[] } {
  const { Box, Text } = el
  const dot = providerColor(group.type ?? group.provider)
  const word = saveWord(group, save, frame.lang)
  const tipOf = (item: LimitItem) => limitItemTip(item, name, frame.lang, frame.now)
  // Compact: one figure run for the group, its tip naming every window in turn.
  const items = density === 'compact'
    ? [compactDrawn(el, frame, group, 'limits-' + group.key, group.items.map(tipOf).join(' · '), frame.lang)]
    : group.items.map((item, ii) => limitItemDrawn(el, frame, item, 'limits-' + group.key + '-' + ii, tipOf(item), density))
  return {
    node: (
      <Box key={'limits-' + group.key} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
        <Text key="limits-dot" color={dot}>•</Text>
        <Text key="limits-name" {...lookOf(frame).sub}>{name}</Text>
        {items.map(f => f.node)}
        {word ? <Text key="limits-save" color={TONE.violet.text}>{word}</Text> : null}
      </Box>
    ),
    tips: items.map(f => ({ key: f.key, text: f.tip! })),
  }
}

/**
 * The pace forecasts of the windows drawn, one phrase each ("Claude 주간: 이 속도라면 2시간 10분 뒤
 * 한도가 소진됩니다"): the pressable row's one tip gives way for the pane's, which would otherwise
 * leave a window's forecast no place to be read in full.
 */
function forecastTips(groups: readonly LimitGroup[], numbered: (g: LimitGroup) => boolean, frame: Frame): string[] {
  return groups.flatMap(g => g.items.flatMap(item => {
    const sentence = exhaustSentence(item, frame.now, frame.lang)
    return sentence ? [limitGroupName(g, numbered(g)) + ' ' + limitItemName(item, frame.lang) + ': ' + sentence] : []
  }))
}

/**
 * The second row, or null: no `limits` extra, no windows at all, or not even Claude's own windows
 * fitting. Narrow, the scoped windows of the later providers (3P, …) go first, then a later
 * provider's secondary accounts (the last one first), then a later provider's whole group, and
 * only then Claude's own scoped windows (Fable): Claude's own group stays to the last, and its Fable
 * outlasts every later provider (the owner, 2026-11-10). Then whatever scoped windows fit again come
 * back into the groups drawn (Claude's first), so the row keeps every window that fits. Of each
 * provider's accounts the row shows
 * only the one in use (bandLimitGroups), unnumbered; the limits pane lists them all.
 * `onPress`: the row is a button (the limits pane); pressed it says so in the tip place, and each
 * window's own tip (its name and reset) gives way to that one.
 */
function limitsRowDrawn(el: Els, frame: Frame, view: DashboardView, budget: number, onPress?: () => void): { node: RenderNode; tips: { key: string; text: string }[] } | null {
  const { Box } = el
  const items = view.limits ?? []
  if (!items.length || !view.extras.includes('limits')) return null
  // Of each provider's accounts only the one in use: the pane lists the rest.
  const all = bandLimitGroups(limitGroups(items))
  // Numbering follows the whole set of accounts a provider has, decided before any narrowing.
  const numbered = limitGroupNumbered(all)
  // Save mode's word sat beside the first row's limit; with this row drawn it follows Claude's windows.
  const save = !!view.limit?.save
  const width = (density: LimitDensity) => (gs: readonly LimitGroup[]) => gs.reduce((n, g) => n + limitGroupCells(g, limitGroupName(g, numbered(g)), frame.lang, frame.now, density, save), 0) + RULE_CELLS * Math.max(0, gs.length - 1) + LIMITS_GAP * Math.max(0, 2 * gs.length - 2)
  // Pressable, the row's light keeps a fact's air either side of the figures, which the row takes
  // from its budget.
  const room = onPress ? budget - PRESS_PAD * 2 : budget
  // Every provider at the roomiest density that holds them all; past compact, windows and then
  // groups give way (narrowLimitGroups), compact as the row is then.
  const density = DENSITIES.find(d => width(d)(all) <= room) ?? 'compact'
  const groups = narrowLimitGroups(all, room, width(density))
  if (!groups) return null
  const drawn = groups.map(g => limitGroupDrawn(el, frame, g, limitGroupName(g, numbered(g)), save, density))
  const children: RenderNode[] = []
  drawn.forEach((d, i) => {
    if (i > 0) children.push(rule(el, frame, 'limits-' + groups[i]!.key))
    children.push(d.node)
  })
  // Pressable, the row is lit under the pointer exactly as the band's other buttons are (the route,
  // the effort and context chips): its own Box carries the skin's light, with a fact's air either
  // side, and the press is laid over it. The light first sat in an empty absolute Box laid over the
  // row so its edge could not grow the row; the app never drew it, and the row showed no box under
  // the pointer where every other control did (the owner, 2026-10-29). A bordered host Box adds
  // 8 px above and below unless paddingY is set, so it is set to none, and the row starts its
  // round edge's two pixels higher, so the band stays the height it was. The figures start where
  // they did: the row's own air is taken from the indent before it.
  const lit = onPress ? { ...hoverLight(frame, tipScope('limits-open')), paddingX: PRESS_PAD, paddingY: 0 } : {}
  return {
    node: (
      <Box key="band-limits" flexDirection="row" alignItems="center" paddingLeft={onPress ? CREST_CELLS - PRESS_PAD : CREST_CELLS} paddingTop={onPress ? LIMITS_TOP - LIGHT_EDGE : LIMITS_TOP}>
        <Box key="limits-row" position="relative" flexDirection="row" alignItems="center" columnGap={LIMITS_GAP} flexShrink={0} {...lit}>
          {children}
          {onPress ? press(el, 'limits-open', (width(density)(groups) + PRESS_PAD * 2) * CELL_PX, onPress) : null}
        </Box>
      </Box>
    ),
    tips: onPress
      ? [{ key: 'limits-open', text: [t(frame.lang, 'band.limitsOpen'), ...forecastTips(groups, numbered, frame)].join(' · ') }]
      : drawn.flatMap(d => d.tips),
  }
}

/**
 * The routed model as the band names it: what was asked dropped, and Claude's ids by their
 * family and version ("claude-opus-5-5" → "Opus 5.5"); the whole route is in the tip.
 */
export function routeName(model: string): string {
  return modelName(model.replace(/\s*\(.*\)$/, ''))
}

/** The router's notice when it has one, else the last route: where it went, its model and cache hit; the way into the log. */
function routeDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions, room: number): RenderNode {
  const { Box, Text } = el
  if (view.hide.includes('route')) return ''
  // The router's state now outranks a record of an earlier request (2026-10-25).
  if (view.notice) {
    return (
      <Box key="fact-route" position="relative" flexShrink={1} minWidth={0} overflow="hidden">
        <Text {...lookOf(frame).mute} wrap="truncate">{view.notice.replace(/^ClaudeRipple:\s*/, '')}</Text>
      </Box>
    )
  }
  const r = view.route
  if (!r) return ''
  const tone = r.cachePct !== undefined ? cacheTone(r.cachePct) : 'ok'
  const k = lookOf(frame)
  const name = routeName(r.model)
  const tail = !r.ok ? (r.resent ? t(frame.lang, 'band.resent', { status: r.status }) : r.status) : r.cachePct !== undefined ? r.cachePct + '%' : ''
  // The light is as wide as what it holds (its air, the dot, the name, the figure), giving way only
  // when the row has less, and the blank press laid over it is that wide too: a press wider is cut
  // with an ellipsis (three dark dots on flat's light page), and a narrower one lights a smaller box
  // inside the route's own light (2026-10-16).
  const held = 1 + cells(frame, '•') + 0.5 + cells(frame, name) + (tail ? 0.5 + cells(frame, tail) : 0)
  // The answer's speed after the hit, as the log says it (2026-11-07).
  const rate = r.ok && r.rate !== undefined ? t(frame.lang, 'log.rate', { rate: rateText(r.rate) }) : ''
  const width = Math.max(Math.min(ROUTE_ROOM, room), Math.ceil(held + (rate ? 0.5 + cells(frame, rate) : 0)))
  // The route is a button (it opens the log), so it lights under the pointer like the controls do.
  // It has no tip: the light says it is a button, and its card is what the log shows (asked 2026-10-14).
  return (
    // The slot keeps no width of the value's (what the band holds never depends on one); the light
    // inside it is as wide as the value.
    <Box key="fact-route" flexDirection="row" flexShrink={1} minWidth={Math.min(ROUTE_ROOM, room)} overflow="hidden">
    {/* The air between the parts is each part's own left padding, not the row's gap: a gap stayed
        before the rate's emptied box and cut the name's last letters (2026-11-07). */}
    <Box key="route-light" position="relative" flexDirection="row" alignItems="center" paddingX={0.5} width={width} flexShrink={1} minWidth={0} overflow="hidden" {...hoverLight(frame)}>
      <Box flexShrink={0}>
        {r.ok ? <Text {...(r.resent ? k.mute : { color: providerColor(r.provider) })}>{r.resent ? '↻' : '•'}</Text> : <Text color={k.tone('red')}>✕</Text>}
      </Box>
      <Box flexShrink={1} minWidth={0} paddingLeft={0.5}>
        <Text {...k.sub} wrap="truncate">{name}</Text>
      </Box>
      {tail ? (
        <Box key="route-tail" flexShrink={0} paddingLeft={0.5}>
          {!r.ok ? (
            <Text {...(r.resent ? k.mute : { color: k.tone('red') })}>{tail}</Text>
          ) : (
            <Text {...(tone === 'ok' ? { color: k.tone('green') } : figure(frame, tone === 'warn' ? 'warn' : 'bad'))}>{tail}</Text>
          )}
        </Box>
      ) : null}
      {/* Where the row is short, the rate goes before the name gives a letter, and goes whole: its
          box starts at nothing and takes only what the name and the hit leave (a shrink weighted
          against the name still cut it by a fraction of a pixel, and an ellipsis with it), and once
          that is less than the rate the rate (its air with it) wraps past an empty first item onto
          a second line the box's one-row height hides. Cut, it read as a stray "8…", and the name
          is what the route is. */}
      {rate ? (
        <Box key="route-rate" flexDirection="row" flexWrap="wrap" width={0} flexGrow={1} flexShrink={0} minWidth={0} height={1} overflow="hidden">
          <Box key="hold" width={0} height={1} />
          <Box key="said" flexShrink={0} paddingLeft={0.5}>
            <Text {...k.mute}>{rate}</Text>
          </Box>
        </Box>
      ) : null}
      {press(el, 'route', width * CELL_PX, actions.toggleLog)}
    </Box>
    </Box>
  )
}

/**
 * What the row leaves, blank, and each fact's or control's tip laid over it on hover. The judge's
 * reason is no longer written here (cut to a word or two it said nothing, 2026-10-13); it is in the
 * effort's tip.
 *
 * Each tip is placed absolutely over the row from column `left` to `right` columns short of its end
 * (just before the controls) rather than drawn in what the row leaves free: at the band's real width
 * (2026-10-14: 100 columns with every fact and control drawn) nothing is left free, and a tip drawn
 * in a zero-width box never showed. Covering the facts while a tip shows is expected.
 *
 * The tips are the row's own children with no Box spanning them: the pointer on an absolute Box is
 * on its parent, so a standing layer over the facts took every hover and press from what lay under
 * it (2026-10-14, the route stopped opening the log). A tip resting `display: "none"` takes no
 * pointer. Tips carry no `key`: a keyed Box drawn `display: "none"` is refused as a hover scope (the
 * pointer could never be over it), so each tip reveals through its own `hover.scope`, which the
 * fact's or control's hover lights.
 */
function whyDrawn(el: Els, frame: Frame, tips: { key: string; text: string; at?: number }[], at: number, right: number): RenderNode[] {
  const { Box, Text } = el
  // Placed Box offsets are whole cells; a tip starts at the first cell past 리플이 and the effort,
  // or past its own fact when that is a button.
  const width = Math.max(40, frame.columns) * CELL_PX
  return tips.map(tip => (
    <Box position="absolute" top={0} bottom={0} left={Math.ceil(tip.at ?? at)} right={Math.ceil(right)} display="none" hover={{ scope: tipScope(tip.key), display: 'flex' }} overflow="hidden">
      <Box position="absolute" top={0} left={0}>
        {pic(el, 'tip-plate-' + tip.key, lookOf(frame).art.plate(width, ROW_PX), tip.text, width, ROW_PX)}
      </Box>
      <Box position="relative" flexShrink={1} minWidth={0}>
        {lift(el)}
        <Text {...lookOf(frame).ink} wrap="truncate">{tip.text}</Text>
      </Box>
    </Box>
  ))
}

/** A thin rule between the band's groups. */
function rule(el: Els, frame: Frame, key: string): RenderNode {
  const { Box } = el
  return (
    <Box key={'rule-' + key} width={RULE_CELLS} flexShrink={0} alignItems="center">
      {pic(el, 'rule-' + key, lookOf(frame).art.rule(), '|', 9, 16)}
    </Box>
  )
}

/** `counted`: what the row's budget takes for a control drawn narrower than it can grow (see DrawnFact). */
type DrawnControl = { key: string; cells: number; counted?: number; node: RenderNode; tip: string }

/**
 * An icon control, lit under the pointer: its picture, its word when the band has room, its press.
 * `widestPx`: the picture's width at its widest (a counted icon with its badge), which the budget takes.
 */
function iconControl(el: Els, frame: Frame, key: string, source: string, artPx: number, alt: string, tip: string, onPress: () => void, label?: string, word?: Word, widestPx = artPx): DrawnControl {
  const { Text } = el
  const pad = label ? 0.5 : 0.25
  // Exact, not rounded up to whole cells: the host takes fractions, and up to 0.7 of a cell after
  // each icon read as a gap once the app's type made a cell wider (2026-10-25).
  const slot = (px: number) => (px + (label ? CELL_PX + chOf(label) * CELL_PX * 1.04 : 0)) / CELL_PX + pad * 2
  const cells = slot(artPx)
  return {
    key,
    cells,
    counted: slot(widestPx),
    tip,
    node: lit(el, frame, key, cells, [pic(el, key, source, alt, artPx, 16), label ? <Text key={key + '-word'} {...(word ?? lookOf(frame).sub)}>{label}</Text> : '', press(el, key, cells * CELL_PX, onPress)], pad, tipScope(key)),
  }
}

/** The controls at the right end, each naming what it does on hover; `words` the ones with their word. */
function controlsDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions, words: readonly string[]): DrawnControl[] {
  const L = frame.lang
  const out: DrawnControl[] = []
  const k = lookOf(frame)
  const state = (on: boolean) => t(L, on ? 'band.on' : 'band.off')
  // Handoff, a quiet pill that names itself: always there, so it is counted like any control.
  const handoffLabel = t(L, 'band.handoff')
  out.push({ key: 'handoff', cells: k.art.pill(handoffLabel, 'ghost', 'violet').cells + 1, node: pill(el, frame, 'handoff', handoffLabel, 'ghost', actions.handoff, 'violet'), tip: t(L, 'alerts.handoffTitle') })
  // Auto's word is the control (art.ts `wordArt`): lit violet while on, a quiet ghost while off,
  // pulsing while the judge decides. No switch: the state is in the word's own light (2026-10-14).
  const autoLabel = t(L, 'band.auto')
  const autoTip = t(L, 'band.effortAutoAlt', { state: state(view.auto) }) + ' · ' + t(L, 'settings.autoLine')
  out.push({ key: 'auto', cells: wordCells(frame, autoLabel), node: word(el, frame, 'auto', view.auto, autoLabel, actions.toggleAuto, view.effort.mode === 'deciding', tipScope('auto')), tip: autoTip })
  const warmLabel = t(L, 'band.warm')
  out.push(iconControl(el, frame, 'warm', k.art.icon('flame', view.warm.on, 'amber'), ICON_PX, warmLabel, t(L, 'band.warmAlt', { state: state(view.warm.on) }) + ' · ' + t(L, view.warm.here ? 'band.warmHere' : 'settings.warmLine'), actions.toggleWarm, words.includes('warm') ? warmLabel : undefined, view.warm.on ? { color: k.tone('amber') } : k.sub))
  const agentsLabel = t(L, 'band.agents')
  const live = view.agents.live
  // The live count sits on the icon's shoulder, which is drawn only while there is a count: kept
  // blank at zero it read as a gap after the icon (2026-10-25). The budget counts the shoulder.
  out.push(iconControl(el, frame, 'agents', k.art.agents(live, view.agentsOpen || live > 0), countedWidth(live), live > 0 ? agentsLabel + ' ' + live : agentsLabel, t(L, 'band.agentsAlt', { count: live }), actions.toggleAgents, words.includes('agents') ? agentsLabel : undefined, view.agentsOpen ? k.ink : k.sub, AGENTS_W))
  const compactLabel = t(L, 'band.compact')
  // How many times the chat was compacted sits on the icon's shoulder, as the agents' live count
  // does, drawn only once there is one.
  const compactions = view.compactions
  const compactTip = t(L, 'band.compactAlt') + (compactions > 0 ? ' · ' + t(L, 'band.compactedTimes', { count: compactions }) : '')
  out.push(iconControl(el, frame, 'compact', k.art.counted('compact', compactions, false), countedWidth(compactions), compactions > 0 ? compactLabel + ' ' + compactions : compactLabel, compactTip, actions.compact, words.includes('compact') ? compactLabel : undefined, undefined, AGENTS_W))
  const clearLabel = t(L, 'band.clear')
  out.push(iconControl(el, frame, 'clear', k.art.icon('clear', false), ICON_PX, clearLabel, t(L, 'band.clearAlt'), actions.clear, words.includes('clear') ? clearLabel : undefined))
  const settingsLabel = t(L, 'band.settings')
  out.push(iconControl(el, frame, 'settings', k.art.icon('gear', false), ICON_PX, settingsLabel, t(L, 'band.settingsAlt'), actions.openSettings, words.includes('settings') ? settingsLabel : undefined))
  return out
}

function effortMenuDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  const { Box } = el
  const current = view.effort.mode === 'manual' || view.effort.mode === 'off' ? view.effort.level : null
  return (
    <Box key="effort-menu" flexDirection="row" alignItems="center" flexWrap="wrap" columnGap={2} rowGap={1} paddingTop={1} paddingLeft={CREST_CELLS}>
      {word(el, frame, 'pick-auto', view.auto, t(frame.lang, 'band.auto'), actions.toggleAuto)}
      {segmented(el, frame, 'pick', EFFORTS.map(effort => ({ value: effort, label: effortName(effort, frame.lang) })), current, effort => actions.pickEffort(effort), 'violet', DEPTH)}
    </Box>
  )
}

// ---- The delegation pin ------------------------------------------------------------------------
//
// A session-only authorization shown as one line of plain words: the pin's name, the person's own
// sentence that set it (or, without one, how long it holds), and a way to release it. On the desktop
// it is the capsule's own first row (the app lays a grey plate behind the band, so anything drawn
// apart from the capsule floats on it, 2026-10-23); on the terminal and in the footer it is a line
// of text. Not pinned, there is no line and the band draws as it always did.

/** The pin line's height on the desktop, px. */
const PIN_ROW_PX = 24
/** The least room the person's sentence gets before it is dropped for the name alone. */
const PIN_REASON_MIN = 20
/** A name's place in the pin's label: what lies before it and after it, whatever the language. */
const PIN_HOLE = String.fromCharCode(1)

type PinWords = { before: string; name: string; after: string; reason: string }

function pinWords(frame: Frame, view: DashboardView): PinWords {
  const [before = '', after = ''] = t(frame.lang, 'band.delegationPin', { name: PIN_HOLE }).split(PIN_HOLE)
  const reason = view.delegationSaid ? t(frame.lang, 'band.pinSaid', { said: view.delegationSaid }) : t(frame.lang, 'band.pinKept')
  return { before, name: view.delegationPin ?? '', after, reason }
}

/** Cells the sentence has beside the label, or 0 when it would be cut to less than PIN_REASON_MIN. */
function pinReasonRoom(frame: Frame, words: PinWords, taken: number, columns: number): number {
  const room = columns - taken - cells(frame, words.before + words.name + words.after) - cells(frame, ' · ') - 1
  return room >= PIN_REASON_MIN ? room : 0
}

/** The pin as a line of text (terminal, minimal footer): label, name in the accent, sentence, Unpin. */
function pinText(el: Els, frame: Frame, view: DashboardView, actions: Pick<BandActions, 'releaseDelegationPin'>, reserve: number): RenderNode {
  if (!view.delegationPin) return ''
  const { Box, Text } = el
  const words = pinWords(frame, view)
  const release = actions.releaseDelegationPin ? t(frame.lang, 'band.releasePin') : ''
  const room = pinReasonRoom(frame, words, reserve + (release ? cells(frame, release) + 1 : 0), frame.columns)
  return (
    <Box key="delegation-pin" flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Text>
        <Text dimColor>{words.before}</Text>
        <Text color={textTone(frame.appearance).accent}>{words.name}</Text>
        <Text dimColor>{words.after + (room ? ' · ' + clip(words.reason, room) : '')}</Text>
      </Text>
      {actions.releaseDelegationPin ? textButton(el, 'release-pin', release, actions.releaseDelegationPin) : null}
    </Box>
  )
}

/**
 * The desktop's pin line, the capsule's first row: the pin's mark, the label in soft ink with the
 * name in violet, the person's sentence quieter, and Unpin lit under the pointer at the right.
 * Narrow, the sentence goes and only the label, the name and Unpin are left.
 */
function pinRowDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions, cols: number): RenderNode {
  if (!view.delegationPin) return ''
  const { Box, Text } = el
  const k = lookOf(frame)
  const words = pinWords(frame, view)
  const release = actions.releaseDelegationPin
  const releaseLabel = t(frame.lang, 'band.releasePin')
  const releaseCells = release ? Math.ceil((textPx(releaseLabel) * 1.05) / CELL_PX + 1.2) : 0
  // The row's own air: the indent, the mark and its gap, the release control and the gap before it.
  const taken = CREST_CELLS + Math.ceil((ICON_PX + CELL_PX) / CELL_PX) + (release ? releaseCells + 1 : 0)
  const room = pinReasonRoom(frame, words, taken, cols)
  return (
    <Box key="delegation-pin" flexDirection="row" alignItems="center" columnGap={1} width="100%" minWidth={0} height={rowsOf(PIN_ROW_PX)} paddingLeft={CREST_CELLS}>
      {pic(el, 'pin-mark', k.art.icon('pin', true, 'violet'), '', ICON_PX, 16)}
      <Box key="pin-words" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate">
          <Text {...k.sub}>{words.before}</Text>
          <Text color={k.tone('violet')} bold>{words.name}</Text>
          <Text {...k.sub}>{words.after}</Text>
          {room ? <Text {...k.mute}>{' · ' + words.reason}</Text> : ''}
        </Text>
      </Box>
      {release ? lit(el, frame, 'release-pin', releaseCells, [<Text key="release-pin-word" {...k.sub}>{releaseLabel}</Text>, press(el, 'release-pin', releaseCells * CELL_PX, release)], 0.5) : ''}
    </Box>
  )
}

function bandDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  const { Box } = el
  // The capsule's air and edge take their share of the frame.
  const cols = Math.max(30, frame.columns) - 2 * PAD_X - 1
  const mood = bandMood(frame, view)
  // The row's budget, widths alone (never values): 리플이, the facts at their slots, the rules, a
  // route at its least, the controls, the way out. Narrow, the controls drop their words first,
  // then the quietest facts go.
  const close = actions.hide ? CLOSE_CELLS : 0
  const effort = effortDrawn(el, frame, view, actions)
  // The second row is decided before the first row's budget: when it draws, the first row's limit
  // fact steps aside and the route takes its room.
  const limitsRow = limitsRowDrawn(el, frame, view, cols - CREST_CELLS, actions.toggleLimits)
  const optional = [modeDrawn(el, frame, view), contextDrawn(el, frame, view, actions.toggleContext), cacheDrawn(el, frame, view), ...(limitsRow ? [] : [limitDrawn(el, frame, view)])].filter((f): f is DrawnFact => f !== null)
  // The Auto word is its control: it never loses its shape, so no word of it is dropped, and the
  // spare words (the icons' beside it) go first when the row narrows.
  let words: readonly string[] = [...WORDLESS]
  // Counted at a fixed room (a long model name is cut, a short one leaves air): what the band holds
  // never depends on a value. The air between controls is the row's own columnGap (a fraction of a
  // cell, as the facts' air), and the hide button a half-separator of its own.
  const counted = (w: readonly string[]) => {
    const list = controlsDrawn(el, frame, view, actions, w)
    return list.reduce((n, c) => n + (c.counted ?? c.cells), 0) + 0.15 * (list.length - 1) + (actions.hide ? 0.15 : 0)
  }
  let controlCells = counted(words)
  let route = view.hide.includes('route') ? 0 : ROUTE_ROOM
  let ruled = true
  const span = (facts: DrawnFact[]) => facts.reduce((n, f) => n + countedCells(f) + DRAWN_GAP, 0)
  const rules = (facts: DrawnFact[]) => (ruled ? (facts.length ? RULE_CELLS + DRAWN_GAP : 0) + (route ? RULE_CELLS + DRAWN_GAP : 0) : 0)
  const need = (facts: DrawnFact[]) => CREST_CELLS + DRAWN_GAP + countedCells(effort) + DRAWN_GAP + rules(facts) + span(facts) + (route ? route + DRAWN_GAP : 0) + controlCells + close + 1
  let facts = optional
  // Narrow, things go in this order until the row fits: the icons' words (clear, compact,
  // settings, agents, keep-warm), the rules, then the route draws in to its least, then the mode
  // and the context chip, last the cache. The limit and the new icons stay (2026-10-14: the band
  // sits at its ~100-column maximum and must hold everything there).
  for (const drop of [...WORDLESS, 'rules', 'route', 'mode', 'context', 'cache']) {
    if (need(facts) <= cols) break
    if ((WORDLESS as readonly string[]).includes(drop)) {
      words = words.filter(w => w !== drop)
      controlCells = counted(words)
    } else if (drop === 'rules') ruled = false
    else if (drop === 'route') route = RICH_ROUTE_MIN
    else facts = facts.filter(f => f.key !== drop)
  }
  const controls = controlsDrawn(el, frame, view, actions, words)
  // A fact that is a button keeps its light in sight: its tip starts where the next fact does.
  const past: Record<string, number> = {}
  let x = CREST_CELLS + DRAWN_GAP + effort.cells + DRAWN_GAP + (ruled && facts.length ? RULE_CELLS + DRAWN_GAP : 0)
  for (const f of facts) {
    x += f.cells + DRAWN_GAP
    if (f.press) past[f.key] = x
  }
  const tips = [effort, ...facts].filter(f => f.tip).map(f => ({ key: f.key, text: f.tip!, ...(past[f.key] !== undefined ? { at: past[f.key] } : {}) }))
  if (limitsRow) for (const tip of limitsRow.tips) tips.push(tip)
  // Handoff names itself in its pill: no tip of its own.
  for (const c of controls) if (c.key !== 'handoff') tips.push({ key: c.key, text: c.tip })
  if (actions.hide) tips.push({ key: 'hide', text: t(frame.lang, 'band.hideBand') })
  const crest = (
    <Box key="band-crest" width={CREST_CELLS} flexShrink={0} alignItems="center">
      {ripple(el, frame, 'band-' + mood.face + (mood.dim ? '-dim' : ''), mood.face, 'ClaudeRipple', BAND_RIPPLE, undefined, mood.dim)}
    </Box>
  )
  const routeNode = route > 0 ? routeDrawn(el, frame, view, actions, route) : ''
  const row = (
    <Box key="band-row" flexDirection="row" alignItems="center" width="100%" minWidth={0} height={rowsOf(ROW_H)}>
      {/* The facts keep their own width (the drop rules above already made them fit); the route
          follows them directly, and what the row leaves free is after it, before the controls. The
          route is what gives way, down to its own minimum, truncating the model's name: a facts box
          allowed to shrink let the route draw over them, and a facts box that grew left a short
          model name far right with a gap before it (2026-10-14). */}
      <Box key="band-facts" flexDirection="row" alignItems="center" columnGap={DRAWN_GAP} flexShrink={0}>
        {crest}
        {effort.node}
        {ruled && facts.length ? rule(el, frame, 'facts') : null}
        {facts.map(f => f.node)}
      </Box>
      {routeNode ? (
        <Box key="band-route" flexDirection="row" alignItems="center" columnGap={DRAWN_GAP} marginLeft={DRAWN_GAP} flexShrink={1} minWidth={0}>
          {ruled ? rule(el, frame, 'route') : null}
          {routeNode}
        </Box>
      ) : null}
      <Box key="band-free" flexGrow={1} flexShrink={1} minWidth={0} />
      {whyDrawn(el, frame, tips, CREST_CELLS + DRAWN_GAP + effort.cells + DRAWN_GAP, controlCells + close + 0.5)}
      <Box key="band-controls" flexDirection="row" alignItems="center" columnGap={0.15} flexShrink={0} marginLeft={0.5}>
        {controls.map(c => c.node)}
        {actions.hide ? closeButton(el, frame, 'hide', t(frame.lang, 'band.hideBand'), () => actions.hide!(), tipScope('hide')) : null}
      </Box>
    </Box>
  )
  // A pinned model adds one line at the top of the capsule; the sea and its glow follow 리플이 down.
  const pinned = !!view.delegationPin
  return capsule(el, frame, {
    key: 'band',
    sea: { ...bandSea(mood), reach: 120, at: { x: PAD_X * CELL_PX + (CREST_CELLS * CELL_PX) / 2, y: PAD_Y * ROW_PX * 0.5 + ROW_H / 2 + (pinned ? PIN_ROW_PX : 0) } },
    rows: (view.effortMenu ? (limitsRow ? 4.6 : 3.4) : limitsRow ? 3 : 1.8) + (pinned ? rowsOf(PIN_ROW_PX) : 0),
    paddingX: PAD_X,
    paddingY: PAD_Y,
    children: [...(pinned ? [pinRowDrawn(el, frame, view, actions, cols)] : []), row, ...(limitsRow ? [limitsRow.node] : []), view.effortMenu ? effortMenuDrawn(el, frame, view, actions) : ''],
  })
}

// ---- Terminal ----------------------------------------------------------------------------------

function runText(el: Els, key: string, run: Run): RenderNode {
  const { Text } = el
  return (
    <Text key={key} color={run.color} dimColor={run.dim} bold={run.bold}>
      {run.text}
    </Text>
  )
}

function factText(el: Els, f: Fact): RenderNode {
  const { Box } = el
  return (
    <Box key={'fact-' + f.key} flexDirection="row" columnGap={1} width={f.width} flexShrink={0}>
      {f.glyph ? runText(el, 'glyph', f.glyph) : null}
      {runText(el, 'value', f.value)}
      {(f.tail ?? []).map((run, i) => runText(el, 'tail-' + i, run))}
    </Box>
  )
}

/**
 * The judge's reason in a slot of its own on a wide terminal, cut to it; the slot stays, blank,
 * while there is no reason, so the route beside it never changes width.
 */
function whyFact(view: DashboardView): Fact | null {
  if (view.hide.includes('reason')) return null
  const why = view.effort.mode === 'auto' ? view.effort.why : undefined
  return { key: 'why', width: WHY_CELLS, value: { text: why ? clip('“' + why + '”', WHY_CELLS) : '', dim: true } }
}

function bandText(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  const { Box } = el
  const cols = Math.max(20, frame.columns)
  const ctrls = controls(frame, view, actions)
  const ctrlCells = controlsCells(frame, view, actions)
  const budget = Math.max(1, frame.maxRows)
  // One row when the facts (a route at its least) and the controls fit; else facts, then controls.
  // Too tall for the band: the quietest facts go first. Widths alone decide, never values.
  let drop: string[] = []
  const plan = () => {
    const routeCells = view.hide.includes('route') || drop.includes('route') ? 0 : GAP + ROUTE_MIN
    const oneRow = span(factsFor(frame, view, actions, cols, [...drop, 'route'])) + routeCells + GAP + ctrlCells <= cols
    const room = oneRow ? cols - ctrlCells - GAP : cols
    return { oneRow, facts: factsFor(frame, view, actions, room, drop), room }
  }
  let p = plan()
  for (const key of ['limit', 'context', 'route', 'mode', 'cache']) {
    if ((p.oneRow ? 1 : 2) <= budget) break
    drop = [...drop, key]
    p = plan()
  }
  let facts = p.facts
  // The reason only where the row has room for its whole slot and a roomy route beside it.
  const why = whyFact(view)
  const routeNeed = view.hide.includes('route') || drop.includes('route') ? 0 : GAP + 2 * WHY_CELLS
  if (why && p.room - span(factsFor(frame, view, actions, p.room, [...drop, 'route'])) - GAP >= WHY_CELLS + routeNeed) {
    const room = p.room - WHY_CELLS - GAP
    facts = factsFor(frame, view, actions, room, drop)
    const at = facts.findIndex(f => f.key === 'route')
    facts = at < 0 ? [...facts, why] : [...facts.slice(0, at), why, ...facts.slice(at)]
  }
  const factRow = (
    <Box key="facts" flexDirection="row" columnGap={GAP} flexShrink={0}>
      {facts.map(f => factText(el, f))}
    </Box>
  )
  const ctrlRow = (
    <Box key="controls" flexDirection="row" flexWrap="wrap" columnGap={GAP} flexShrink={0}>
      {ctrls.map(c => textButton(el, c.key, c.label, c.onPress, c.hotkey))}
    </Box>
  )
  const menu = view.effortMenu ? (
    <Box key="effort-menu" flexDirection="row" flexWrap="wrap" columnGap={GAP}>
      {textButton(el, 'pick-auto', t(frame.lang, 'band.auto') + ' ' + (view.auto ? '●' : '○'), actions.toggleAuto, '0')}
      {EFFORTS.map((effort: Effort, i) => textButton(el, 'pick-' + effort, RIPPLE_CHAR[i]! + ' ' + effortName(effort, frame.lang).toLowerCase(), () => actions.pickEffort(effort), String(i + 1)))}
    </Box>
  ) : null
  return (
    <Box flexDirection="column" width="100%">
      {pinText(el, frame, view, actions, 0)}
      {p.oneRow ? (
        <Box key="row" flexDirection="row" width="100%">
          {factRow}
          <Box flexGrow={1} minWidth={GAP} />
          {ctrlRow}
        </Box>
      ) : (
        [factRow, ctrlRow]
      )}
      {menu}
    </Box>
  )
}

/**
 * Cells the caller's controls beside the band take (the close control, and the terminal's effort
 * button `e: Effort`), with the gap before them: what to take off the frame's columns.
 */
export function besideBand(frame: Frame): number {
  return isRich(frame) ? 5 : 2 + displayWidth('e: ' + t(frame.lang, 'band.effort')) + 2 + 1
}

/** Only display copies change; ids and state used by the actions remain untouched. */
function bandDisplay(view: DashboardView): DashboardView {
  return {
    ...view,
    model: view.model === null ? null : displayText(view.model, DISPLAY.name),
    notice: view.notice === null ? null : displayText(view.notice),
    effort: { ...view.effort, ...(view.effort.why ? { why: displayText(view.effort.why) } : {}) },
    warm: { ...view.warm, ...(view.warm.stopped ? { stopped: displayText(view.warm.stopped) } : {}) },
    ...(view.mode ? { mode: displayText(view.mode, DISPLAY.name) } : {}),
    ...(view.delegationPin ? { delegationPin: displayText(view.delegationPin, DISPLAY.name) } : {}),
    ...(view.delegationSaid ? { delegationSaid: displayText(view.delegationSaid) } : {}),
    route: view.route ? { ...view.route, model: displayText(view.route.model, DISPLAY.name), provider: displayText(view.route.provider, DISPLAY.name), status: displayText(view.route.status, DISPLAY.name), ...(view.route.effort ? { effort: displayText(view.route.effort, DISPLAY.name) } : {}), ...(view.route.note ? { note: displayText(view.route.note) } : {}) } : null,
  }
}

/** The dashboard band, `frame.columns` being its own width (see besideBand). */
export function renderBand(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  view = bandDisplay(view)
  if (!isRich(frame) || !('Svg' in el)) return bandText(el, frame, view, actions)
  return bandDrawn(el, frame, view, actions)
}

// ---- Minimal: the footer -----------------------------------------------------------------------

export type FooterActions = Pick<BandActions, 'toggleAuto' | 'openSettings' | 'releaseDelegationPin'>

/**
 * The minimal layout: one quiet line in the footer's mode area (SessionMode), the engine's own
 * modes kept beside it. `engine` is what `next(e)` drew there.
 */
export function renderFooter(el: Els, frame: Frame, view: DashboardView, actions: FooterActions, engine?: RenderChildren): RenderNode {
  view = bandDisplay(view)
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const { level, mode } = view.effort
  const idx = effortIndex(level)
  const effortText =
    mode === 'deciding' ? t(frame.lang, 'band.decidingText') : (idx >= 0 ? RIPPLE_CHAR[idx]! : '○') + ' ' + (level ? effortName(level, frame.lang).toLowerCase() : '—') + (mode === 'auto' ? '' : mode === 'paused' ? t(frame.lang, 'band.footerPaused') : mode === 'off' ? t(frame.lang, 'band.footerOff') : t(frame.lang, 'band.footerManual'))
  const left = view.cache ? view.cache.expiresAt - frame.now : 0
  const ctxTone = view.context ? contextTone(view.context.percent) : 'ink'
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
      <Text color={mode === 'deciding' || mode === 'auto' ? tone.accent : undefined} dimColor={mode === 'paused' || mode === 'off'}>
        {effortText}
      </Text>
      {view.mode ? <Text color={tone.accent}>{t(frame.lang, 'band.mode') + ' ' + modeLabel(view.mode)}</Text> : null}
      {view.context && view.extras.includes('context') ? (
        <Text dimColor color={ctxTone === 'ink' ? undefined : ctxTone === 'warn' ? WARN : BAD}>
          {t(frame.lang, 'band.footerContext', { percent: Math.round(view.context.percent) })}
        </Text>
      ) : null}
      {view.cache && !view.hide.includes('timer') ? <Text dimColor>{'⧗ ' + minutesLeft(left, frame.lang) + (view.warm.on ? ' ≈' : '')}</Text> : null}
      {view.limit && view.extras.includes('limits') ? <Text dimColor>{limitName(view.limit.kind, frame.lang) + ' ' + Math.round(view.limit.percent) + '%'}</Text> : null}
      {textButton(el, 'auto', t(frame.lang, 'band.auto') + (view.auto ? ' ●' : ' ○'), actions.toggleAuto)}
      {textButton(el, 'settings', '⚙', actions.openSettings)}
      {pinText(el, frame, view, actions, 60)}
      {engine ?? null}
    </Box>
  )
}
