// The pieces every drawing is made of: the element table, the desktop chip (an SVG with a
// transparent native button laid over it), the terminal's hotkey button, and the SVG glyphs that
// give the mod its look (the effort meter: five rising bars, one per effort step).
//
// Engine facts these follow (Claude Code 2.1.293):
// - A Button's label is text only and its colours are the host's, so a styled control is an Svg
//   in the flow with an absolutely placed Box after it holding a plain Button whose label is
//   no-break spaces. The hit layer comes after the picture so it paints, and takes the pointer,
//   above it. Braille blanks are not used: some fonts draw them as dots.
// - An Svg needs alt, width and height (an interactive one without both falls back to ~300×150),
//   and animates only with isInteractive.
// - A band redraw restarts every SVG animation, so motion is SMIL/CSS inside the SVG, phased by a
//   negative delay computed from a stable anchor, and markup stays byte-identical when nothing
//   it shows changed.

import type { ElementTable, RenderNode } from 'claude-code'

import type { Frame } from './view'
import { esc, svgDoc, textWidth, v } from './theme'
import type { Palette } from './theme'

export type Els = ElementTable

const NBSP = ' '

/** A label of no-break spaces wide enough to cover a chip `width` px across (clipped to it). */
export function hitLabel(width: number): string {
  return NBSP.repeat(Math.max(2, Math.ceil(width / 3.4)))
}

export type ChipSpec = {
  key: string
  /** The SVG document, from svgDoc. */
  source: string
  alt: string
  width: number
  height: number
  /** True for markup that animates or carries a <title> tooltip. */
  live?: boolean
  onPress?: () => void
}

/** A picture, and a hit button over it when it is pressable. Desktop and the editor only. */
export function chip(el: Els, spec: ChipSpec): RenderNode {
  if (!('Svg' in el)) return ''
  const { Box, Button, Svg } = el
  const picture = spec.live ? (
    <Svg source={spec.source} alt={spec.alt} width={spec.width} height={spec.height} isInteractive />
  ) : (
    <Svg source={spec.source} alt={spec.alt} width={spec.width} height={spec.height} />
  )
  const onPress = spec.onPress
  if (!onPress) return picture
  return (
    <Box key={'chip-' + spec.key} position="relative" overflow="hidden">
      {picture}
      <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
        <Button key={spec.key} plain label={hitLabel(spec.width)} onPress={() => onPress()} />
      </Box>
    </Box>
  )
}

/** A terminal (or mobile) control: `k: Label` with a hotkey, the label alone without one. */
export function textButton(el: Els, key: string, label: string, onPress: () => void, hotkey?: string, primary?: boolean): RenderNode {
  const { Button } = el
  // A bracketed button hides its hotkey on the terminal, so one with a hotkey stays plain (`s: Save`).
  if (primary && !hotkey) return <Button key={key} variant="primary" label={label} onPress={() => onPress()} />
  return hotkey ? <Button key={key} plain hotkey={hotkey} label={label} onPress={() => onPress()} /> : <Button key={key} plain label={label} onPress={() => onPress()} />
}

// ---- SVG building blocks -----------------------------------------------------------------------

export const CHIP_H = 34
export const PILL_H = 28

/** A chip's body: translucent ink, or the accent wash when lit. */
export function plate(w: number, ht: number, lit: boolean, r = 9): string {
  return (
    '<rect x="0.5" y="0.5" width="' + (w - 1) + '" height="' + (ht - 1) + '" rx="' + r + '" fill="' +
    (lit ? v('accentWash') : v('fill')) + '" stroke="' + (lit ? v('accentLine') : v('stroke')) + '"/>'
  )
}

/** A filled accent plate: the one primary action of a card. */
export function primaryPlate(w: number, ht: number, r = 9): string {
  return '<rect x="0" y="0" width="' + w + '" height="' + ht + '" rx="' + r + '" fill="' + v('primary') + '"/>'
}

export function text(x: number, y: number, cls: string, content: string, fill?: string, anchor?: 'end' | 'middle'): string {
  return (
    '<text x="' + x + '" y="' + y + '" class="' + cls + '"' + (fill ? ' style="fill:' + fill + '"' : '') +
    (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + esc(content) + '</text>'
  )
}

const BAR_H = [4, 6.5, 9, 11.5, 14]
const BAR_W = 2.4
const BAR_GAP = 1.6

/** One bar of the meter, bottom-aligned on the box centred at (cx, cy). */
function bar(cx: number, cy: number, i: number, scale: number, attrs: string): string {
  const x = cx - ((BAR_W * 5 + BAR_GAP * 4) / 2) * scale + i * (BAR_W + BAR_GAP) * scale
  const h = BAR_H[i]! * scale
  return '<rect ' + attrs + ' x="' + x.toFixed(2) + '" y="' + (cy + 7 * scale - h).toFixed(2) + '" width="' + (BAR_W * scale).toFixed(2) + '" height="' + h.toFixed(2) + '" rx="' + (0.9 * scale).toFixed(2) + '"/>'
}

/** The effort meter: five rising bars, `level` 0..4 lighting low (one bar) to max (all five). */
export function meter(cx: number, cy: number, level: number, tone: string, unlit = v('faint'), scale = 1): string {
  let out = ''
  for (let i = 0; i < 5; i++) out += bar(cx, cy, i, scale, 'fill="' + (i <= level ? tone : unlit) + '"' + (i <= level ? '' : ' opacity="0.7"'))
  return out
}

/**
 * The meter while the judge thinks: bars light up left to right in a loop. `phase` (seconds into
 * the loop) becomes a negative delay, so a redraw continues the sweep instead of restarting it.
 */
export function meterWave(cx: number, cy: number, phase: number, scale = 1): string {
  let out = ''
  for (let i = 0; i < 5; i++) out += bar(cx, cy, i, scale, 'class="wave" style="animation-delay:' + (i * 0.18 - phase).toFixed(2) + 's" fill="' + v('accent') + '"')
  return out
}

export const WAVE_PERIOD = 1.8
export const WAVE_CSS =
  '@keyframes wave{0%{opacity:.14}28%{opacity:1}70%{opacity:.14}100%{opacity:.14}}' +
  '.wave{animation:wave ' + WAVE_PERIOD + 's ease-in-out infinite;opacity:.14}' +
  '@keyframes glow{0%,100%{opacity:.25}50%{opacity:.9}}' +
  '.glow{animation:glow ' + WAVE_PERIOD + 's ease-in-out infinite}'

/** A ring gauge: track and an arc from 12 o'clock, `frac` 0..1. */
export function gauge(cx: number, cy: number, r: number, frac: number, tone: string, width = 2.6): string {
  const c = 2 * Math.PI * r
  const f = Math.max(0, Math.min(1, frac))
  return (
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + v('faint') + '" stroke-width="' + width + '" opacity="0.55"/>' +
    (f > 0
      ? '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + tone + '" stroke-width="' + width +
        '" stroke-linecap="round" stroke-dasharray="' + (c * f).toFixed(2) + ' ' + c.toFixed(2) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>'
      : '')
  )
}

/** A small switch: track and knob, lit in the accent. */
export function switchGlyph(x: number, y: number, on: boolean): string {
  return (
    '<rect x="' + x + '" y="' + y + '" width="22" height="12" rx="6" fill="' + (on ? v('accent') : 'none') + '" stroke="' +
    (on ? v('accent') : v('muted')) + '" stroke-width="1.2"/>' +
    '<circle cx="' + (on ? x + 16 : x + 6) + '" cy="' + (y + 6) + '" r="' + (on ? 4 : 3.4) + '" fill="' + (on ? '#fff' : v('muted')) + '"/>'
  )
}

// A cog of eight teeth around (7, 7): outer radius 6.2, root 4.6.
const COG = (() => {
  const pts: string[] = []
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    for (const [da, r] of [[-0.2, 4.6], [-0.12, 6.2], [0.12, 6.2], [0.2, 4.6]] as const) {
      pts.push((7 + r * Math.cos(a + da)).toFixed(2) + ' ' + (7 + r * Math.sin(a + da)).toFixed(2))
    }
  }
  return 'M' + pts.join('L') + 'Z'
})()

/** Line icons, 14px boxes, drawn in `tone`. */
export function icon(name: 'log' | 'agents' | 'gear' | 'compact' | 'handoff' | 'flame' | 'check' | 'cross' | 'alert' | 'clock' | 'snow', x: number, y: number, tone: string): string {
  const s = ' fill="none" stroke="' + tone + '" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"'
  const t = 'translate(' + x + ' ' + y + ')'
  switch (name) {
    case 'log':
      return '<g transform="' + t + '"' + s + '><path d="M2 3.5h10M2 7h10M2 10.5h6"/></g>'
    case 'agents':
      return '<g transform="' + t + '"' + s + '><circle cx="7" cy="3.2" r="1.9"/><circle cx="2.8" cy="10.8" r="1.9"/><circle cx="11.2" cy="10.8" r="1.9"/><path d="M7 5.1v2.4M7 7.5 3.6 9.2M7 7.5l3.4 1.7"/></g>'
    case 'gear':
      return '<g transform="' + t + '"' + s + '><circle cx="7" cy="7" r="1.9"/><path d="' + COG + '"/></g>'
    case 'compact':
      return '<g transform="' + t + '"' + s + '><path d="M2 2.5h10M2 11.5h10M7 4.2v5.6M4.8 6.3 7 4.2l2.2 2.1M4.8 7.7 7 9.8l2.2-2.1"/></g>'
    case 'handoff':
      return '<g transform="' + t + '"' + s + '><path d="M2 7h8.5M7.6 3.8 10.8 7l-3.2 3.2M12.5 2.5v9"/></g>'
    case 'flame':
      return '<g transform="' + t + '"' + s + '><path d="M7 1.8c.4 2.2 3.6 3.4 3.6 6.7a3.6 3.6 0 0 1-7.2 0c0-1.6.9-2.6 1.7-3.3.1 1.2.7 1.9 1.4 2.1C6 5.4 6.3 3.4 7 1.8z"/></g>'
    case 'check':
      return '<g transform="' + t + '"' + s + '><path d="M2.5 7.4 5.6 10.4 11.6 3.8"/></g>'
    case 'cross':
      return '<g transform="' + t + '"' + s + '><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></g>'
    case 'alert':
      return '<g transform="' + t + '"' + s + '><path d="M7 1.8 12.8 12H1.2z"/><path d="M7 5.6v3"/><circle cx="7" cy="10.3" r=".3"/></g>'
    case 'clock':
      return '<g transform="' + t + '"' + s + '><circle cx="7" cy="7" r="5.4"/><path d="M7 4v3.2l2.1 1.4"/></g>'
    case 'snow':
      return '<g transform="' + t + '"' + s + '><path d="M7 1.5v11M2.2 4.2l9.6 5.6M2.2 9.8l9.6-5.6"/></g>'
  }
}

// ---- Generic desktop controls ------------------------------------------------------------------

export type PillOptions = {
  key: string
  label: string
  onPress: () => void
  /** Lit: the accent wash (a selected segment, an active toggle). */
  lit?: boolean
  /** The card's main action: filled accent. */
  primary?: boolean
  /** Leading glyph, drawn in a 14px box whose top-left is (x, y). */
  glyph?: (x: number, y: number) => string
  /** A switch before the label, on or off. */
  toggle?: boolean
  /** A small count badge after the label. */
  badge?: string
  height?: number
  alt?: string
}

/** A pressable pill (desktop): plate, optional glyph or switch, label, optional badge. */
export function pill(el: Els, frame: Frame, o: PillOptions): RenderNode {
  const ht = o.height ?? PILL_H
  if (!o.label && o.glyph) {
    // An icon alone: a square plate.
    return chip(el, {
      key: o.key,
      source: svgDoc(ht, ht, frame.appearance, plate(ht, ht, o.lit === true) + o.glyph(ht / 2 - 7, ht / 2 - 7)),
      alt: o.alt ?? o.key,
      width: ht,
      height: ht,
      onPress: o.onPress,
    })
  }
  const lw = textWidth(o.label, 12)
  let x = 11
  let body = ''
  if (o.toggle !== undefined) {
    body += switchGlyph(x, ht / 2 - 6, o.toggle)
    x += 29
  } else if (o.glyph) {
    body += o.glyph(x, ht / 2 - 7)
    x += 20
  }
  const labelTone = o.primary ? '#fff' : o.lit ? v('accent') : v('ink')
  body += text(x, ht / 2 + 4.2, 'lbl', o.label, labelTone)
  x += lw
  if (o.badge) {
    const bw = Math.max(16, textWidth(o.badge, 10.5) + 9)
    x += 6
    body +=
      '<rect x="' + x + '" y="' + (ht / 2 - 8) + '" width="' + bw + '" height="16" rx="8" fill="' + v('primary') + '"/>' +
      '<text x="' + (x + bw / 2) + '" y="' + (ht / 2 + 3.8) + '" text-anchor="middle" style="fill:#fff;font-size:10.5px;font-weight:700">' + esc(o.badge) + '</text>'
    x += bw
  }
  const w = Math.ceil(x + 11)
  const plateMarkup = o.primary ? primaryPlate(w, ht) : plate(w, ht, o.lit === true)
  return chip(el, {
    key: o.key,
    source: svgDoc(w, ht, frame.appearance, plateMarkup + body),
    alt: o.alt ?? o.label + (o.toggle !== undefined ? (o.toggle ? ' (on)' : ' (off)') : o.lit ? ' (selected)' : ''),
    width: w,
    height: ht,
    onPress: o.onPress,
  })
}

/**
 * A row of options, one selected (desktop pills or terminal buttons). Terminal labels carry a
 * ●/○ so the choice reads without colour.
 */
export function segmented<T extends string>(
  el: Els,
  frame: Frame,
  key: string,
  options: readonly { value: T; label: string; hotkey?: string }[],
  value: T,
  onPick: (value: T) => void,
): RenderNode {
  const { Box } = el
  if (frame.surface === 'desktop' || frame.surface === 'vscode') {
    return (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {options.map(o => pill(el, frame, { key: key + '-' + o.value, label: o.label, lit: o.value === value, onPress: () => onPick(o.value), height: 26 }))}
      </Box>
    )
  }
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {options.map(o => textButton(el, key + '-' + o.value, (o.value === value ? '● ' : '○ ') + o.label, () => onPick(o.value), o.hotkey))}
    </Box>
  )
}

/** A two-state switch: a desktop pill with a switch, or `● On` / `○ Off` on the terminal. */
export function toggle(el: Els, frame: Frame, key: string, label: string, on: boolean, onPress: () => void, hotkey?: string): RenderNode {
  if (frame.surface === 'desktop' || frame.surface === 'vscode') return pill(el, frame, { key, label, toggle: on, onPress, height: 26 })
  return textButton(el, key, (on ? '● ' : '○ ') + label, onPress, hotkey)
}

/** A button: the desktop pill (primary filled) or a terminal button. */
export function action(el: Els, frame: Frame, key: string, label: string, onPress: () => void, opts: { hotkey?: string; primary?: boolean; lit?: boolean; glyph?: (x: number, y: number) => string } = {}): RenderNode {
  if (frame.surface === 'desktop' || frame.surface === 'vscode') {
    const o: PillOptions = { key, label, onPress }
    if (opts.primary) o.primary = true
    if (opts.lit) o.lit = true
    if (opts.glyph) o.glyph = opts.glyph
    return pill(el, frame, o)
  }
  return textButton(el, key, label, onPress, opts.hotkey, opts.primary)
}

/** Colour of a palette key as SVG paint. */
export function tone(key: keyof Palette): string {
  return v(key)
}
