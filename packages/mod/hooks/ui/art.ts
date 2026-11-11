// The pictures of the desktop drawings, in one look: "the deep" (2026-10-12). Every band, card and
// panel is a capsule of dark water, warm graphite whatever the app's theme: 리플이 glows at its left,
// ripples spread from it, a few motes drift, and what the capsule is about tints that light (amber
// as the cache runs out, ice once it has, embers for a hot limit). Controls are drawn on it in light
// ink; colour is kept for points (a lit switch, a tile's picture, an alert's light). Pure: SVG only.
//
// Why one dark look on both themes (host facts, see parts.tsx and kit.tsx for the rest):
// - The host styles its own text and buttons per theme, and a mod cannot read which theme is on. A
//   capsule that is always dark lets every colour be ours: host Text is given explicit light colours
//   (never `dimColor`, the host's grey), and nothing on it is a labelled host Button.
// - A plain Svg is ours to the pixel, keeps its CSS motion and does not blink on a redraw. A redraw
//   starts its motion over, so every loop opens on a pose that reads as going on (negative delays).
// - The desktop sets text at 13 px with 19 px lines; a cell is 1ch, 7.917 px. Controls are sized in
//   whole cells so a picture and the presses laid over it share one grid.

import type { Skin } from '../../types/index.d.ts'
import { chOf } from './theme.ts'

/** One desktop cell (1ch of the host's 13 px sans), px. */
export const CELL_PX = 7.917
/** One desktop row (the host's line height), px. */
export const ROW_PX = 19
/** The most an Svg may be a side, px: past it the engine refuses the whole tree and draws its own. */
export const SVG_MAX_PX = 4096

// ---- Colours ------------------------------------------------------------------------------------

/** Host Text on a capsule: bright for values, soft for names, quiet for asides. */
export const INK = '#f2f0eb'
export const SUB = '#cbc8bf'
export const MUTE = '#9c988e'

/**
 * The water: warm graphite, the Claude app's own dark family, so the capsule sits in the app on
 * either theme and violet stays a point of light (리플이's glow, a switch that is on), never the
 * ground (the owner, 2026-10-13: a violet ground "stands out far too much").
 */
const WATER = ['#262523', '#1f1e1c', '#1a1917'] as const
/** Lines drawn on the water (white at a strength), unlit marks, and drawn labels. */
const HAIR = '#ffffff'
const SOFT = '#d6d3cb'
const LABEL = '#e9e7e1'

/** The lights of the deep, by what they are about. */
export type Tone = 'violet' | 'cyan' | 'teal' | 'amber' | 'ember' | 'ice' | 'green' | 'red'

type Light = { hi: string; lo: string; glow: string; text: string; on: string }
export const TONE: Record<Tone, Light> = {
  violet: { hi: '#c4b5fd', lo: '#7c5cff', glow: '#8b6bff', text: '#cdbfff', on: '#ffffff' },
  cyan: { hi: '#a5f3fc', lo: '#22c7e6', glow: '#22d3ee', text: '#8fe9f8', on: '#04252e' },
  teal: { hi: '#99f6e4', lo: '#14b8a6', glow: '#2dd4bf', text: '#86efdf', on: '#03302a' },
  amber: { hi: '#fde68a', lo: '#f5a00b', glow: '#fbbf24', text: '#fcd77a', on: '#3a2604' },
  ember: { hi: '#fdba74', lo: '#f9731f', glow: '#fb923c', text: '#fdbb84', on: '#3b1505' },
  ice: { hi: '#bae6fd', lo: '#38bdf8', glow: '#7dd3fc', text: '#a7defb', on: '#062438' },
  green: { hi: '#bbf7d0', lo: '#22c55e', glow: '#4ade80', text: '#93f0b4', on: '#052e16' },
  red: { hi: '#fecdd3', lo: '#f43f5e', glow: '#fb7185', text: '#fda9b4', on: '#ffffff' },
}

/** Effort runs shallow to deep: cyan for low, through periwinkle, to violet for max. */
export const DEPTH = ['#67e8f9', '#7dd3fc', '#a5b4fc', '#a78bfa', '#c084fc'] as const

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Apple SD Gothic Neo','Segoe UI',system-ui,sans-serif"

export const r = (x: number): string => String(Math.round(x * 100) / 100)

/** One SVG document, `width` × `height` px; nothing in it moves when less motion is asked for. */
export function svg(width: number, height: number, body: string, css = '', extra = ''): string {
  const base = 'svg{display:block}text{font-family:' + FONT + ';font-variant-numeric:tabular-nums}' + '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + r(width) + '" height="' + r(height) + '" viewBox="0 0 ' + r(width) + ' ' + r(height) + '"' + extra + '><style>' + base + css + '</style>' + body + '</svg>'
}

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Pixels a run of host text takes, from its estimate in ch. */
export function textPx(text: string): number {
  return chOf(text) * CELL_PX
}

/**
 * Pixels a label drawn in an SVG takes at `size` px (the system sans: SF Pro, Apple SD Gothic Neo),
 * each class of character taken a little wide.
 */
export function labelPx(text: string, size = 12): number {
  let em = 0
  for (const char of text) {
    if (chOf(char) >= 1.4) em += 1.02
    else if (char === ' ') em += 0.3
    else if (/[ilIj.,:;|'!·]/.test(char)) em += 0.3
    else if (/[mwMW@%]/.test(char)) em += 0.88
    else if (/[A-Z]/.test(char)) em += 0.7
    else if (/[0-9]/.test(char)) em += 0.62
    else em += 0.58
  }
  return em * size
}

/** A pseudo-random but fixed sequence, so one state always draws the same picture. */
function seq(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
}

// ---- The sea: every capsule's backdrop ----------------------------------------------------------

/** What moves in a capsule's water. */
export type Sea = {
  /** The light's colour: what the capsule is about. */
  tone: Tone
  /** Where 리플이 sits, px from the picture's top left: the glow and the ripples centre on it. */
  at: { x: number; y: number }
  /** Ripples spreading from 리플이: unhurried, or quick while a request is out. */
  ripples?: 'calm' | 'busy'
  /** How far the ripples reach, px (about the capsule's height and a half). */
  reach?: number
  /** A sonar sweep across the water: the judge sounding how deep to think. */
  sweep?: boolean
  /** A current along the floor: work going on. The capsule draws it at its own true bottom
   * (kit.tsx `currentArt`), never inside this picture: the sea is drawn taller than the capsule,
   * so a floor placed at its height lands wherever the host's row metrics put it. */
  current?: boolean
  /** Motes drifting up (the deep's plankton), quiet life at rest. */
  motes?: boolean
  /** A slow wave across the water at this height, px: the panels' surface line under 리플이. */
  wave?: number
  weather?: 'snow' | 'bubbles' | 'embers' | 'sparkles' | 'static'
  /** A large tick drawn in at the right (done). */
  tick?: boolean
  /** The light's strength, 0..1 (Auto off dims it). */
  strength?: number
  /** How much of the picture shows, px from the top: motes and weather stay in it. */
  visible?: number
}

const PACE = { calm: 6.5, busy: 2.6 }

/**
 * The deep, `width` × `height` px, anchored at its top left: a violet-black gradient, a glass sheen
 * along the top, 리플이's glow and a far cyan one, and the motion asked for.
 */
export function seaArt(width: number, height: number, sea: Sea): string {
  const w = Math.max(80, Math.round(width))
  const full = Math.max(20, Math.round(height))
  // Motes, weather and sweeps live in what shows; the base, the sheen and the glows cover it all.
  const h = Math.min(full, Math.max(20, Math.round(sea.visible ?? full)))
  const k = sea.strength ?? 1
  const t = TONE[sea.tone]
  const { x: ax, y: ay } = sea.at
  let css = ''
  // 리플이's light reaches about as far as its ripples: a glow around it, not a wash over the water.
  const reach = sea.reach ?? 90
  let body =
    '<defs>' +
    '<linearGradient id="b" x1="0" x2="1"><stop offset="0" stop-color="' + WATER[0] + '"/><stop offset=".5" stop-color="' + WATER[1] + '"/><stop offset="1" stop-color="' + WATER[2] + '"/></linearGradient>' +
    '<linearGradient id="s" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".055"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
    '<radialGradient id="g" cx="' + r(ax) + '" cy="' + r(ay) + '" r="' + r(reach * 1.1) + '" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="' + t.glow + '" stop-opacity="' + r(0.34 * k) + '"/><stop offset=".5" stop-color="' + t.glow + '" stop-opacity="' + r(0.08 * k) + '"/><stop offset="1" stop-color="' + t.glow + '" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="c" cx="' + r(w * 0.82) + '" cy="0" r="' + r(Math.max(140, h * 2.2)) + '" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".035"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>' +
    '</defs>' +
    '<rect width="' + w + '" height="' + full + '" fill="url(#b)"/>' +
    '<rect width="' + w + '" height="' + full + '" fill="url(#c)"/>' +
    '<radialGradient id="h" cx="' + r(ax) + '" cy="' + r(ay) + '" r="34" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="' + t.hi + '" stop-opacity="' + r(0.34 * k) + '"/><stop offset="1" stop-color="' + t.hi + '" stop-opacity="0"/></radialGradient>' +
    '<rect class="br" width="' + w + '" height="' + full + '" fill="url(#g)"/>' +
    '<rect class="ha" width="' + w + '" height="' + full + '" fill="url(#h)"/>' +
    '<rect width="' + w + '" height="' + full + '" fill="url(#s)"/>' +
    '<rect y="0" width="' + w + '" height="1" fill="#fff" fill-opacity=".1"/>'
  css += '.br{animation:br 7s ease-in-out infinite;animation-delay:-2s}@keyframes br{0%,100%{opacity:.82}50%{opacity:1}}' +
    '.ha{animation:ha 4.2s ease-in-out infinite;animation-delay:-1s}@keyframes ha{0%,100%{opacity:.75}50%{opacity:1}}'
  if (sea.ripples) {
    const pace = PACE[sea.ripples]
    const count = sea.ripples === 'busy' ? 4 : 3
    body += '<g fill="none" stroke="' + t.hi + '">'
    for (let i = 0; i < count; i++) body += '<circle class="rp" cx="' + r(ax) + '" cy="' + r(ay) + '" r="' + r(reach) + '" stroke-width="1.3" style="animation-delay:-' + r((pace / count) * (i + 0.4)) + 's"/>'
    body += '</g>'
    css += '.rp{transform-box:fill-box;transform-origin:center;opacity:0;animation:rp ' + pace + 's cubic-bezier(.15,.55,.35,1) infinite}@keyframes rp{0%{transform:scale(.08);opacity:0}10%{opacity:' + r(0.42 * k) + '}100%{transform:scale(1);opacity:0}}'
  }
  if (sea.motes) {
    const rnd = seq(w % 97 + 11)
    body += '<g>'
    for (let i = 0; i < 14; i++) {
      const x = ax + 30 + rnd() * (w - ax - 40)
      const y = 3 + rnd() * (h - 6)
      const size = 0.55 + rnd() * 0.9
      const dur = 6 + rnd() * 7
      body += '<circle class="mo" cx="' + r(x) + '" cy="' + r(y) + '" r="' + r(size) + '" fill="' + (rnd() > 0.7 ? t.hi : HAIR) + '" style="animation-duration:' + r(dur) + 's;animation-delay:-' + r(rnd() * dur) + 's"/>'
    }
    body += '</g>'
    css += '.mo{opacity:0;animation:mo linear infinite}@keyframes mo{0%{transform:translateY(4px);opacity:0}30%{opacity:.4}70%{opacity:.25}100%{transform:translateY(-8px);opacity:0}}'
  }
  if (sea.wave !== undefined) {
    const period = 140
    // Two crests a period, drawn as quadratic halves, one above and one below the line.
    let d = 'M' + -period + ' ' + r(sea.wave)
    for (let x = -period, up = true; x < w + period; x += period / 2, up = !up) d += 'q' + r(period / 4) + ' ' + (up ? -5 : 5) + ' ' + r(period / 2) + ' 0'
    body += '<path class="wv" d="' + d + '" fill="none" stroke="' + HAIR + '" stroke-opacity="' + r(0.11 * k) + '" stroke-width="1.2"/>'
    body += '<path class="wv2" d="' + d + '" fill="none" stroke="' + t.hi + '" stroke-opacity="' + r(0.12 * k) + '" stroke-width="1" transform="translate(0 4)"/>'
    css += '.wv{animation:wv 9s linear infinite}.wv2{animation:wv 13s linear infinite reverse}@keyframes wv{0%{transform:translateX(0)}100%{transform:translateX(' + period + 'px)}}'
  }
  if (sea.sweep) {
    body += '<defs><linearGradient id="sw" x1="0" x2="1"><stop offset="0" stop-color="' + t.hi + '" stop-opacity="0"/><stop offset=".8" stop-color="' + t.hi + '" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity=".45"/></linearGradient></defs>' +
      '<rect class="sw" x="-120" width="120" height="' + full + '" fill="url(#sw)"/>'
    css += '.sw{animation:sw 2.2s cubic-bezier(.45,0,.25,1) infinite;animation-delay:-.3s}@keyframes sw{0%{transform:translateX(' + r(ax) + 'px)}100%{transform:translateX(' + (w + 120) + 'px)}}'
  }
  if (sea.weather) {
    const made = weather(sea.weather, w, h, t, ax)
    body += made.body
    css += made.css
  }
  if (sea.tick) {
    const s = Math.min(h * 0.8, 44)
    const x = w - s * 2.2
    const y = (h - s) / 2
    body += '<path class="tk" d="M' + r(x) + ' ' + r(y + s * 0.55) + 'L' + r(x + s * 0.38) + ' ' + r(y + s * 0.9) + 'L' + r(x + s * 1.1) + ' ' + r(y + s * 0.08) + '" fill="none" stroke="' + t.hi + '" stroke-opacity=".3" stroke-width="' + r(s * 0.14) + '" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>'
    css += '.tk{stroke-dasharray:1;stroke-dashoffset:1;animation:tk .9s .15s cubic-bezier(.3,.7,.3,1) forwards}@keyframes tk{to{stroke-dashoffset:0}}'
  }
  return svg(w, full, body, css)
}

function weather(kind: NonNullable<Sea['weather']>, w: number, h: number, t: Light, from: number): { body: string; css: string } {
  const rnd = seq(kind.length * 7 + 3)
  const start = from + 40
  let body = ''
  let css = ''
  if (kind === 'snow') {
    for (let i = 0; i < 18; i++) {
      const x = start + rnd() * (w - start)
      const size = 1.4 + rnd() * 2.2
      const dur = 5 + rnd() * 5
      const flake = rnd() > 0.5
        ? '<path d="M0 -' + r(size) + 'V' + r(size) + 'M-' + r(size * 0.87) + ' -' + r(size / 2) + 'L' + r(size * 0.87) + ' ' + r(size / 2) + 'M-' + r(size * 0.87) + ' ' + r(size / 2) + 'L' + r(size * 0.87) + ' -' + r(size / 2) + '" stroke="' + t.hi + '" stroke-width=".7" stroke-linecap="round"/>'
        : '<circle r="' + r(size * 0.42) + '" fill="' + t.hi + '"/>'
      body += '<g transform="translate(' + r(x) + ' 0)"><g class="fa" style="animation-duration:' + r(dur) + 's;animation-delay:-' + r(rnd() * dur) + 's;opacity:' + r(0.35 + rnd() * 0.45) + '">' + flake + '</g></g>'
    }
    css += '.fa{animation:fa linear infinite}@keyframes fa{0%{transform:translate(0,-8px) rotate(0)}50%{transform:translate(5px,' + r(h / 2) + 'px) rotate(90deg)}100%{transform:translate(-2px,' + r(h + 8) + 'px) rotate(180deg)}}'
  } else if (kind === 'bubbles') {
    for (let i = 0; i < 14; i++) {
      const x = start + rnd() * (w - start)
      const size = 1.2 + rnd() * 3
      const dur = 4 + rnd() * 5
      body += '<g transform="translate(' + r(x) + ' 0)"><circle class="ri" r="' + r(size) + '" fill="none" stroke="' + t.hi + '" stroke-width=".8" style="animation-duration:' + r(dur) + 's;animation-delay:-' + r(rnd() * dur) + 's"/></g>'
    }
    css += '.ri{animation:ri ease-in infinite;opacity:0}@keyframes ri{0%{transform:translate(0,' + r(h + 6) + 'px);opacity:0}20%{opacity:.6}100%{transform:translate(4px,-6px);opacity:0}}'
  } else if (kind === 'embers') {
    for (let i = 0; i < 18; i++) {
      const x = start + rnd() * (w - start)
      const size = 0.7 + rnd() * 1.5
      const dur = 2.6 + rnd() * 3
      body += '<g transform="translate(' + r(x) + ' 0)"><circle class="em" r="' + r(size) + '" fill="' + (rnd() > 0.5 ? t.hi : t.glow) + '" style="animation-duration:' + r(dur) + 's;animation-delay:-' + r(rnd() * dur) + 's"/></g>'
    }
    css += '.em{animation:em ease-out infinite;opacity:0}@keyframes em{0%{transform:translate(0,' + r(h + 4) + 'px);opacity:0}25%{opacity:.9}100%{transform:translate(-6px,-4px);opacity:0}}'
  } else if (kind === 'sparkles') {
    for (let i = 0; i < 10; i++) {
      const x = start + rnd() * (w - start - 10)
      const y = 4 + rnd() * (h - 8)
      const size = 1.8 + rnd() * 3
      const dur = 2.4 + rnd() * 2.4
      body += '<g transform="translate(' + r(x) + ' ' + r(y) + ')"><path class="sp" d="M0 -' + r(size) + 'Q0 0 ' + r(size) + ' 0Q0 0 0 ' + r(size) + 'Q0 0 -' + r(size) + ' 0Q0 0 0 -' + r(size) + 'Z" fill="' + (rnd() > 0.5 ? t.hi : '#a5f3fc') + '" style="animation-duration:' + r(dur) + 's;animation-delay:-' + r(rnd() * dur) + 's"/></g>'
    }
    css += '.sp{transform-box:fill-box;transform-origin:center;animation:sp ease-in-out infinite;opacity:0}@keyframes sp{0%,100%{transform:scale(.2) rotate(0);opacity:0}50%{transform:scale(1) rotate(45deg);opacity:.85}}'
  } else {
    for (let y = 1; y < h; y += 3) body += '<rect x="' + r(start) + '" y="' + y + '" width="' + r(w - start) + '" height=".6" fill="' + t.hi + '" opacity=".1"/>'
    body += '<rect class="sc" x="' + r(start) + '" width="' + r(w - start) + '" height="5" fill="' + t.hi + '" opacity=".14"/>'
    css += '.sc{animation:sc 3.2s linear infinite}@keyframes sc{0%{transform:translateY(-6px)}100%{transform:translateY(' + (h + 6) + 'px)}}'
  }
  return { body, css }
}

/** The work current's height, px: the line and the air under it that keeps it off the edge. */
export const CURRENT_PX = 2

/**
 * The current that says work is going on, `width` × 2 px: a cyan streak crossing the capsule's
 * floor and out at the right. The capsule draws it at its own true bottom (kit.tsx `capsule`), not
 * in the sea, whose height is only an estimate of the capsule's: a floor placed there crossed the
 * limits' words (2026-10-25).
 *
 * Nothing but the width goes into the document, rounded: the same band within a pixel or so is the
 * same string, so a host that keeps a plain picture whose source did not change keeps its motion
 * running instead of starting it over. No negative delay opens the loop part way: a loop that does
 * start over opens off the left edge, which reads as carrying on.
 */
export function currentArt(width: number): string {
  const w = Math.max(80, Math.round(width))
  const body =
    '<defs><linearGradient id="cu" x1="0" x2="1"><stop offset="0" stop-color="#67e8f9" stop-opacity="0"/><stop offset=".5" stop-color="#67e8f9" stop-opacity=".9"/><stop offset="1" stop-color="#67e8f9" stop-opacity="0"/></linearGradient></defs>' +
    '<rect class="cu" x="-180" y=".2" width="180" height="1.6" fill="url(#cu)"/>'
  const css = '.cu{animation:cu 1.7s linear infinite}@keyframes cu{0%{transform:translateX(0)}100%{transform:translateX(' + (w + 180) + 'px)}}'
  return svg(w, CURRENT_PX, body, css)
}

/**
 * A plate of the water's middle shade, faded in at its left: laid behind words that take another's
 * place (a hover tip over the reason), so the words beneath do not show through.
 */
export function plateArt(width: number, height: number): string {
  return svg(width, height, '<defs><linearGradient id="p" x1="0" x2="1"><stop offset="0" stop-color="' + WATER[1] + '" stop-opacity="0"/><stop offset="' + r(Math.min(0.2, 14 / width)) + '" stop-color="' + WATER[1] + '"/><stop offset="1" stop-color="' + WATER[2] + '"/></linearGradient></defs><rect width="' + r(width) + '" height="' + r(height) + '" fill="url(#p)"/>')
}

// ---- Controls -----------------------------------------------------------------------------------

/** A drawn control's height, px (kit.tsx holds it too for the wells). */
export const CONTROL_PX = 26

export const SWITCH_W = 36
export const SWITCH_H = 22

/** A switch, 36 × 22 px: a lit violet-to-cyan track with the knob right when on, a dark one when off. */
export function switchArt(on: boolean, busy = false): string {
  const body = on
    ? '<defs><linearGradient id="t" x1="0" x2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#38c6ee"/></linearGradient><filter id="f" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="1.6"/></filter></defs>' +
      '<rect x="3" y="4" width="30" height="14" rx="7" fill="#7c5cff" opacity=".55" filter="url(#f)"/>' +
      '<rect x="2" y="2" width="32" height="18" rx="9" fill="url(#t)"/>' +
      '<rect x="2.5" y="2.5" width="31" height="8" rx="4" fill="#fff" fill-opacity=".14"/>' +
      '<circle class="' + (busy ? 'pu' : '') + '" cx="25" cy="11" r="7" fill="#fff"/><circle cx="25" cy="11" r="2.2" fill="#7c5cff" fill-opacity=".55"/>'
    : '<rect x="2.5" y="2.5" width="31" height="17" rx="8.5" fill="#fff" fill-opacity=".08" stroke="' + HAIR + '" stroke-opacity=".22"/>' +
      '<circle cx="11" cy="11" r="6.5" fill="' + SOFT + '" fill-opacity=".85"/>'
  return svg(SWITCH_W, SWITCH_H, body, '.pu{animation:pu 1.3s ease-in-out infinite}@keyframes pu{50%{opacity:.6}}', lit(on))
}

/** The root's class on a picture of a state: `on` or `off`, so the state is in the drawing itself. */
function lit(on: boolean): string {
  return ' class="' + (on ? 'on' : 'off') + '"'
}

/**
 * One cell of the drawn light laid over a control under the pointer (kit.tsx `extraHover`): a thin
 * white wash, its edges fading, on the water's dark.
 */
export function extraHoverArt(widthPx: number): string {
  return svg(widthPx, CONTROL_PX,
    '<defs><linearGradient id="f" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
    '<linearGradient id="v" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".12"/><stop offset=".5" stop-color="#fff" stop-opacity=".02"/><stop offset="1" stop-color="#fff" stop-opacity=".12"/></linearGradient></defs>' +
    '<rect x="0" y="2" width="' + r(widthPx) + '" height="' + r(CONTROL_PX - 4) + '" fill="url(#f)"/>' +
    '<rect x="2" y="1" width="' + r(Math.max(0, widthPx - 4)) + '" height="' + r(CONTROL_PX - 2) + '" fill="url(#v)"/>')
}

/** The look of a drawn button: the one thing to press, or a quiet one. */
export type PillLook = 'primary' | 'ghost'

/** Glyphs a button may lead with, drawn on a 12 px square. */
export type Glyph = 'open' | 'close' | 'gear' | 'back' | 'next' | 'copy' | 'save' | 'compact'

export const GLYPH: Record<Glyph, string> = {
  open: '<path d="M7 2.2h2.8V5M9.8 2.2L5.6 6.4M8.8 7.4v2.4H2.2V3.2h2.4"/>',
  close: '<path d="M3 3l6 6M9 3L3 9"/>',
  gear: '<circle cx="6" cy="6" r="1.7"/><path d="M6 1.3v1.3M6 9.4v1.3M1.3 6h1.3M9.4 6h1.3M2.7 2.7l.9.9M8.4 8.4l.9.9M2.7 9.3l.9-.9M8.4 3.6l.9-.9"/><circle cx="6" cy="6" r="3.5"/>',
  back: '<path d="M7.5 2.5L4 6l3.5 3.5"/>',
  next: '<path d="M4.5 2.5L8 6 4.5 9.5"/>',
  copy: '<rect x="4" y="4" width="6" height="6" rx="1.2"/><path d="M8 4V2.8A.8.8 0 0 0 7.2 2H2.8a.8.8 0 0 0-.8.8v4.4a.8.8 0 0 0 .8.8H4"/>',
  save: '<path d="M6 1.5v9M2.5 7l3.5 3.5L9.5 7"/>',
  compact: '<path d="M3.5 1.8L6 4.3l2.5-2.5M3.5 10.2L6 7.7l2.5 2.5M1.8 6h8.4"/>',
}

/**
 * A drawn button with its label (and a leading glyph) in it, 26 px high, its width whole cells so
 * the press laid over it lines up. Returns the source and the width in cells.
 */
export function pillArt(label: string, look: PillLook, tone: Tone = 'violet', glyph?: Glyph): { source: string; cells: number } {
  const t = TONE[tone]
  const size = 12
  // Exact, not whole cells, and 10 px of air a side: rounded up and at 13 px the Handoff pill read
  // as padded once the app's type widened a cell (2026-10-25). The press is laid over its Box.
  const pad = 10
  const gw = glyph ? 12 + 6 : 0
  const cells = (labelPx(label, size) + pad * 2 + gw) / CELL_PX
  const w = cells * CELL_PX
  const h = 26
  const ink = look === 'primary' ? t.on : LABEL
  let body = ''
  if (look === 'primary') {
    body +=
      '<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="' + t.lo + '"/><stop offset="1" stop-color="' + t.hi + '"/></linearGradient></defs>' +
      '<rect x="1" y="1" width="' + r(w - 2) + '" height="' + (h - 2) + '" rx="' + (h / 2 - 1) + '" fill="url(#g)"/>' +
      '<rect x="2" y="1.5" width="' + r(w - 4) + '" height="' + (h / 2 - 2) + '" rx="' + (h / 4) + '" fill="#fff" fill-opacity=".16"/>'
  } else {
    body += '<rect x="1" y="1" width="' + r(w - 2) + '" height="' + (h - 2) + '" rx="' + (h / 2 - 1) + '" fill="#fff" fill-opacity=".06" stroke="' + HAIR + '" stroke-opacity=".24"/>'
  }
  const textW = labelPx(label, size)
  const x0 = (w - textW - gw) / 2
  if (glyph) body += '<g transform="translate(' + r(x0) + ' ' + (h / 2 - 6) + ')" fill="none" stroke="' + ink + '" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + GLYPH[glyph] + '</g>'
  body += '<text x="' + r(x0 + gw + textW / 2) + '" y="' + r(h / 2 + size * 0.36) + '" text-anchor="middle" font-size="' + size + '" font-weight="' + (look === 'primary' ? 650 : 550) + '" fill="' + ink + '">' + esc(label) + '</text>'
  return { source: svg(w, h, body), cells }
}

/**
 * A word that is itself a control, 26 px high: on, a lit violet pill with the word in white (the
 * whole capsule's one violet check, on hover a pulse breathing around it); off, a quiet ghost with
 * the word in soft ink. The deciding pulse rings the lit pill.
 */
export function wordArt(label: string, on: boolean, busy = false): { source: string; cells: number } {
  const t = TONE.violet
  const size = 12
  const pad = 11
  const cells = Math.ceil((labelPx(label, size) + pad * 2) / CELL_PX)
  const w = cells * CELL_PX
  const h = 26
  let body: string
  let css = ''
  if (on) {
    body =
      '<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="' + t.lo + '"/><stop offset="1" stop-color="' + t.hi + '"/></linearGradient>' +
      '<filter id="f" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="1.8"/></filter></defs>' +
      (busy ? '<rect class="pu" x="1" y="1" width="' + r(w - 2) + '" height="' + (h - 2) + '" rx="' + (h / 2 - 1) + '" fill="none" stroke="' + t.hi + '" stroke-width="1.4" filter="url(#f)"/>' : '') +
      '<rect x="1" y="1" width="' + r(w - 2) + '" height="' + (h - 2) + '" rx="' + (h / 2 - 1) + '" fill="url(#g)"/>' +
      '<rect x="2" y="1.5" width="' + r(w - 4) + '" height="' + (h / 2 - 2) + '" rx="' + (h / 4) + '" fill="#fff" fill-opacity=".16"/>' +
      '<text x="' + r(w / 2) + '" y="' + r(h / 2 + size * 0.36) + '" text-anchor="middle" font-size="' + size + '" font-weight="650" fill="' + t.on + '">' + esc(label) + '</text>'
    css += busy ? '.pu{transform-box:fill-box;transform-origin:center;animation:pu 1.3s ease-in-out infinite}@keyframes pu{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:.15;transform:scale(1.06)}}' : ''
  } else {
    body =
      '<rect x="1" y="1" width="' + r(w - 2) + '" height="' + (h - 2) + '" rx="' + (h / 2 - 1) + '" fill="#fff" fill-opacity=".05" stroke="' + HAIR + '" stroke-opacity=".2"/>' +
      '<text x="' + r(w / 2) + '" y="' + r(h / 2 + size * 0.36) + '" text-anchor="middle" font-size="' + size + '" font-weight="500" fill="' + SOFT + '" opacity=".55">' + esc(label) + '</text>'
  }
  return { source: svg(w, h, body, css, lit(on)), cells }
}

/**
 * A segmented control, its segments `cells` wide each and 26 px high: a dark track, the chosen
 * segment a lit pill in `tone`, the rest named in soft ink. `chosen` −1 lights none.
 */
export function segmentedArt(labels: readonly string[], cells: readonly number[], chosen: number, tone: Tone = 'violet', colors?: readonly string[]): string {
  const t = TONE[tone]
  const h = 26
  const w = cells.reduce((n, c) => n + c, 0) * CELL_PX
  let body =
    '<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="' + t.lo + '"/><stop offset="1" stop-color="' + t.hi + '" stop-opacity=".92"/></linearGradient>' +
    '<filter id="f" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>' +
    '<rect x=".5" y=".5" width="' + r(w - 1) + '" height="' + (h - 1) + '" rx="' + (h / 2 - 0.5) + '" fill="#fff" fill-opacity=".05" stroke="' + HAIR + '" stroke-opacity=".16"/>'
  let x = 0
  const starts = cells.map(c => {
    const at = x
    x += c * CELL_PX
    return at
  })
  for (let i = 1; i < labels.length; i++) {
    if (i === chosen || i - 1 === chosen) continue
    body += '<rect x="' + r(starts[i]! - 0.5) + '" y="8" width="1" height="' + (h - 16) + '" fill="' + HAIR + '" fill-opacity=".14"/>'
  }
  if (chosen >= 0 && chosen < labels.length) {
    const sx = starts[chosen]! + 3
    const sw = cells[chosen]! * CELL_PX - 6
    const fill = colors?.[chosen]
    body +=
      '<rect x="' + r(sx + 2) + '" y="6" width="' + r(sw - 4) + '" height="' + (h - 10) + '" rx="8" fill="' + (fill ?? t.glow) + '" opacity=".6" filter="url(#f)"/>' +
      '<rect x="' + r(sx) + '" y="3" width="' + r(sw) + '" height="' + (h - 6) + '" rx="' + (h / 2 - 3) + '" fill="' + (fill ?? 'url(#g)') + '"/>' +
      '<rect x="' + r(sx + 1) + '" y="3.5" width="' + r(sw - 2) + '" height="' + ((h - 6) / 2 - 1) + '" rx="' + ((h - 6) / 4) + '" fill="#fff" fill-opacity=".16"/>'
  }
  labels.forEach((label, i) => {
    const lit = i === chosen
    const cx = starts[i]! + (cells[i]! * CELL_PX) / 2
    body += '<text x="' + r(cx) + '" y="' + r(h / 2 + 12 * 0.36) + '" text-anchor="middle" font-size="12" font-weight="' + (lit ? 650 : 500) + '" fill="' + (lit ? (colors ? '#10092e' : t.on) : SOFT) + '">' + esc(label) + '</text>'
  })
  return svg(w, h, body)
}

/**
 * A stepped slider for a lean between two ends, `count` stops each `cellsPerStop` cells wide, 22 px
 * high: a cyan-to-violet track, the middle marked, the stretch from the middle to the chosen stop
 * lit, a white knob haloed on the chosen one.
 */
export function sliderArt(count: number, cellsPerStop: number, chosen: number): string {
  const part = cellsPerStop * CELL_PX
  const w = count * part
  const h = 22
  const at = (i: number) => part * (i + 0.5)
  const y = h / 2
  const mid = Math.floor(count / 2)
  const lo = Math.min(mid, chosen)
  const hi = Math.max(mid, chosen)
  let body =
    '<defs><linearGradient id="t" x1="' + r(at(0)) + '" x2="' + r(at(count - 1)) + '" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5eead4"/><stop offset=".5" stop-color="#a5b4fc"/><stop offset="1" stop-color="#b48bff"/></linearGradient>' +
    '<filter id="f" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2.4"/></filter></defs>' +
    '<rect x="' + r(at(0)) + '" y="' + (y - 2) + '" width="' + r(at(count - 1) - at(0)) + '" height="4" rx="2" fill="url(#t)" opacity=".28"/>'
  if (hi > lo) body += '<rect x="' + r(at(lo)) + '" y="' + (y - 2) + '" width="' + r(at(hi) - at(lo)) + '" height="4" rx="2" fill="url(#t)"/>'
  for (let i = 0; i < count; i++) {
    if (i === chosen) continue
    body += i === mid
      ? '<rect x="' + r(at(i) - 1) + '" y="' + (y - 5) + '" width="2" height="10" rx="1" fill="' + LABEL + '" fill-opacity=".7"/>'
      : '<circle cx="' + r(at(i)) + '" cy="' + y + '" r="2.4" fill="' + LABEL + '" fill-opacity=".45"/>'
  }
  const c = at(chosen)
  body += '<circle cx="' + r(c) + '" cy="' + y + '" r="7" fill="#9b7dff" opacity=".7" filter="url(#f)"/><circle cx="' + r(c) + '" cy="' + y + '" r="6.4" fill="#fff"/><circle cx="' + r(c) + '" cy="' + y + '" r="2.4" fill="#8b6bff"/>'
  return svg(w, h, body)
}

export const WELL_PX = 32

/**
 * A native field's plate, `width` × 32 px: the one picture that follows the app's theme (through
 * prefers-color-scheme inside it), white on a light app and the page's dark on a dark one, so the
 * host's own field text reads on it either way.
 */
export function wellArt(width: number, height: number): string {
  return svg(width, height,
    '<rect class="w" x=".5" y=".5" width="' + r(width - 1) + '" height="' + r(height - 1) + '" rx="9"/>',
    '.w{fill:#fdfcfa;stroke:#a8a49b;stroke-opacity:.7}@media (prefers-color-scheme:dark){.w{fill:#262624;stroke:#a8a49b;stroke-opacity:.45}}')
}

export const CLOSE_PX = 22

/** The way out of a capsule, 22 px: a soft disc with a ×. */
export function closeArt(lit = false): string {
  return svg(CLOSE_PX, CLOSE_PX, '<circle cx="11" cy="11" r="10" fill="#fff" fill-opacity="' + (lit ? '.16' : '.07') + '" stroke="' + HAIR + '" stroke-opacity="' + (lit ? '.45' : '.2') + '"/><path d="M7.6 7.6l6.8 6.8M14.4 7.6l-6.8 6.8" stroke="' + LABEL + '" stroke-width="1.6" stroke-linecap="round"/>')
}

// ---- The band's instruments ---------------------------------------------------------------------

export const METER_W = 24
export const METER_H = 16

/**
 * The effort, five bars rising shallow to deep, `lit` of them on: each in its depth's colour when
 * Auto chose it, white when it is the person's, quiet when Auto is off, and a sonar wave running
 * through them while the judge decides.
 */
export function meterArt(lit: number, look: 'auto' | 'manual' | 'quiet' | 'deciding'): string {
  const defs = '<defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2"/></filter></defs>'
  let bars = ''
  let glow = ''
  for (let i = 0; i < 5; i++) {
    const bh = 5 + i * 2.75
    const x = i * 4.8 + 0.5
    const on = look === 'deciding' || i < lit
    const fill = !on ? '#fff' : look === 'manual' ? '#f4f2ff' : look === 'quiet' ? '#958cc9' : DEPTH[i]!
    const wave = look === 'deciding' ? ' class="wa" style="animation-delay:' + r(i * 0.13) + 's"' : ''
    const shape = ' x="' + r(x) + '" y="' + r(METER_H - bh) + '" width="3.4" height="' + r(bh) + '" rx="1.2" fill="' + fill + '"'
    bars += '<rect' + shape + ' fill-opacity="' + (on ? 1 : 0.14) + '"' + wave + '/>'
    if (on && (look === 'auto' || look === 'deciding')) glow += '<rect' + shape + ' filter="url(#f)" opacity=".7"' + wave + '/>'
  }
  return svg(METER_W, METER_H, defs + glow + bars, '.wa{animation:wa 1.15s ease-in-out infinite;opacity:.3}@keyframes wa{0%,100%{opacity:.25}40%{opacity:1}}')
}

/** The context ring, 16 px: the share filled in the tone (ink while there is room). */
export function ringArt(percent: number, tone: Tone | 'ink'): string {
  const s = 16
  const rad = 6
  const c = 2 * Math.PI * rad
  const share = Math.max(0, Math.min(1, percent / 100))
  // Whole percents only: the same figure is the same picture.
  const dash = r((c * Math.round(share * 100)) / 100)
  const stroke = tone === 'ink' ? 'url(#g)' : TONE[tone].hi
  return svg(s, s,
    '<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#67e8f9"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs>' +
    '<circle cx="8" cy="8" r="' + rad + '" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="2.4"/>' +
    '<circle cx="8" cy="8" r="' + rad + '" fill="none" stroke="' + stroke + '" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="' + dash + ' ' + r(c) + '" transform="rotate(-90 8 8)"/>')
}

/** The cache clock, 16 px: the life left as a pie, in the tone (soft ink when nothing holds it). */
export function clockArt(share: number, tone: Tone | 'soft'): string {
  const s = 16
  const c = 8
  const rad = 6.4
  const left = Math.max(0, Math.min(1, share))
  const fill = tone === 'soft' ? SOFT : TONE[tone].hi
  let pie = ''
  const pr = rad - 1.8
  if (left >= 0.999) pie = '<circle cx="' + c + '" cy="' + c + '" r="' + r(pr) + '" fill="' + fill + '"/>'
  else if (left > 0.001) {
    const a = (2 * Math.PI * Math.round(left * 12)) / 12
    const x = c + pr * Math.sin(a)
    const y = c - pr * Math.cos(a)
    pie = '<path d="M' + c + ' ' + c + 'V' + r(c - pr) + 'A' + r(pr) + ' ' + r(pr) + ' 0 ' + (a > Math.PI ? 1 : 0) + ' 1 ' + r(x) + ' ' + r(y) + 'Z" fill="' + fill + '"/>'
  }
  return svg(s, s, '<circle cx="' + c + '" cy="' + c + '" r="' + rad + '" fill="none" stroke="' + fill + '" stroke-opacity=".75" stroke-width="1.3"/>' + pie)
}

/**
 * The plan limit's window as a small gauge, 16 px, in the idiom of the ring and the clock: a dial
 * with a needle, the two windows a needle at a different turn (the five-hour one up, the weekly one
 * leaning right). The window's name and its reset time are in the fact's own tip; a band at 100
 * columns once cut this fact's name to "g…" (2026-10-14), and the glyph buys the room back.
 */
export function gaugeArt(kind: string): string {
  const stroke = SOFT
  const arc = '<path d="M1.8 11.4A6.2 6.2 0 0 1 14.2 11.4" fill="none" stroke="' + stroke + '" stroke-opacity=".7" stroke-width="1.3" stroke-linecap="round"/>'
  const needle = kind === 'seven_day' ? 'M8 11.4L11.4 7.6' : 'M8 11.4L8 6.5'
  return svg(16, 16, arc + '<path d="' + needle + '" fill="none" stroke="' + stroke + '" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.4" r="1.2" fill="' + stroke + '"/>')
}

/** A limit window's share as a horizontal bar, 36 × 6 px on the band (the limits pane draws it
 * wider), with round ends: the track white at low strength, the fill the ring's own teal-to-violet
 * while all is well, amber, then red. Whole percents only, like the ring: the same figure is the
 * same picture. A fill that is anything above 0% draws at least a round end's width, so 7% reads
 * as a bar (36 px at 7% was 2.5 px, a sliver beside its figure, 2026-11-11); the figure in the
 * text is still the percent itself. */
export function barArt(percent: number, tone: Tone | 'ink', W = 36, H = 6): string {
  // Rounded to the integer: neighbouring readings draw byte-identical pictures.
  const share = Math.max(0, Math.min(1, Math.round(percent) / 100))
  const fill = tone === 'ink' ? 'url(#g)' : TONE[tone].hi
  const width = share > 0 ? Math.min(W, Math.max(W * share, H)) : 0
  return svg(W, H,
    '<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#67e8f9"/><stop offset="1" stop-color="#a78bfa"/></linearGradient>' +
    '<clipPath id="c"><rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + r(H / 2) + '"/></clipPath></defs>' +
    '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + r(H / 2) + '" fill="#fff" fill-opacity=".14"/>' +
    '<g clip-path="url(#c)"><rect x="0" y="0" width="' + r(width) + '" height="' + H + '" fill="' + fill + '"/></g>')
}

export const ICON_PX = 16

/** Line icons of the band's controls, 16 px. */
export type Icon = 'flame' | 'gear' | 'agents' | 'log' | 'compact' | 'clear' | 'pin'

export const FLAME = 'M8.1 14.3c2.8 0 4.5-1.9 4.5-4.4 0-2.8-2.4-4.2-2.8-7.2-1.7 1.1-2.6 2.8-2.5 4.3-1-.4-1.5-1.4-1.6-2.3-1.4 1.3-2 2.9-2 5.2 0 2.5 1.6 4.4 4.4 4.4z'

export const ICON: Record<Icon, string> = {
  flame: '<path d="' + FLAME + '"/>',
  gear: '<circle cx="8" cy="8" r="2.3"/><path d="M8 1.7v1.8M8 12.5v1.8M1.7 8h1.8M12.5 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M3.5 12.5l1.3-1.3M11.2 4.8l1.3-1.3"/><circle cx="8" cy="8" r="4.8"/>',
  agents: '<circle cx="4.8" cy="5" r="2.1"/><circle cx="11.4" cy="5" r="2.1"/><path d="M1.6 13.4c.4-2.4 1.7-3.6 3.2-3.6s2.8 1.2 3.2 3.6M8.2 13.4c.4-2.4 1.7-3.6 3.2-3.6s2.8 1.2 3.2 3.6"/>',
  log: '<path d="M2.4 3.8h11.2M2.4 8h11.2M2.4 12.2h6.8"/>',
  // A pin: a round head and its needle.
  pin: '<circle cx="9.8" cy="5.6" r="3.2"/><path d="M7.6 7.8L2.8 12.6"/>',
  // Two arrows coming in from the corners to the middle: the chat drawn down into itself.
  compact: '<path d="M3.2 3.2L7.1 7.1M7.1 7.1H4.9M7.1 7.1V4.9M12.8 12.8L8.9 8.9M8.9 8.9h2.2M8.9 8.9v2.2"/>',
  // An eraser laid on its edge, the sleeve band bold, a short line being swept away below.
  clear: '<path d="M1.33 8.69L5.8 4.94L9.01 8.77L4.55 12.52Z" fill="#fff" fill-opacity=".4" stroke="none"/><path d="M9.45 1.88L12.67 5.71L4.55 12.52L1.33 8.69Z"/><path d="M9.01 8.77L5.8 4.94"/><path d="M3.45 14.3h9.1"/>',
}

/**
 * A control's icon, 16 px: soft ink at rest, lit in `tone` with a glow when on. The lit flame is
 * filled and flickers: the cache is being kept warm.
 */
export function iconArt(icon: Icon, on: boolean, tone: Tone = 'violet'): string {
  const t = TONE[tone]
  const stroke = on ? t.hi : SOFT
  if (icon === 'flame' && on) {
    return svg(ICON_PX, ICON_PX,
      '<defs><linearGradient id="g" x1="0" x2="0" y1="1" y2="0"><stop offset="0" stop-color="#f97316"/><stop offset=".6" stop-color="#fbbf24"/><stop offset="1" stop-color="#fde68a"/></linearGradient><filter id="f" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.3"/></filter></defs>' +
      '<g class="fl"><path filter="url(#f)" opacity=".8" fill="#fb923c" d="' + FLAME + '"/><path fill="url(#g)" d="' + FLAME + '"/></g>',
      '.fl{transform-origin:8px 14px;animation:fl 1.6s ease-in-out infinite}@keyframes fl{0%,100%{transform:scale(1,1)}50%{transform:scale(.94,1.06)}}', lit(true))
  }
  const glow = on ? '<defs><filter id="f" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.2"/></filter></defs><g filter="url(#f)" opacity=".75" fill="none" stroke="' + t.glow + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + ICON[icon] + '</g>' : ''
  return svg(ICON_PX, ICON_PX, glow + '<g fill="none" stroke="' + stroke + '" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">' + ICON[icon] + '</g>', '', lit(on))
}

/**
 * A counted icon's width with its count: the 16 px glyph and its badge's overhang. The disc starts
 * just past the agents' second head (x 13.5) and above their shoulders: over the glyph's corner it
 * covered that head (2026-10-25).
 */
export const AGENTS_W = 24

/** A counted icon's width: the glyph alone at zero, so no blank shoulder follows it (2026-10-25). */
export function countedWidth(count: number): number {
  return count > 0 ? AGENTS_W : ICON_PX
}

/** A control's icon with a count in a lit disc on its shoulder, one width whatever the count. */
export function countedArt(icon: Icon, count: number, on: boolean): string {
  const stroke = on ? TONE.violet.hi : SOFT
  const label = count > 9 ? '9+' : String(count)
  const badge = count > 0
    ? '<circle cx="19.2" cy="4.8" r="4.8" fill="#22d3ee"/><text x="19.2" y="7.6" text-anchor="middle" font-size="' + (label.length > 1 ? 6 : 7.8) + '" font-weight="750" fill="#04252e">' + label + '</text>'
    : ''
  return svg(countedWidth(count), 16, '<g transform="translate(0 .5)" fill="none" stroke="' + stroke + '" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">' + ICON[icon] + '</g>' + badge, '', lit(on))
}

/** The agents icon with the live count on its shoulder. */
export function agentsArt(count: number, on: boolean): string {
  return countedArt('agents', count, on)
}

/** A thin upright rule between the band's groups, 1 × 14 px in a 9 px slot. */
export function ruleArt(): string {
  return svg(9, 16, '<rect x="4" y="1" width="1" height="14" rx=".5" fill="' + HAIR + '" fill-opacity=".16"/>')
}

// ---- The panels' pictures -----------------------------------------------------------------------

export const TILE_PX = 44

/** What a quick-settings tile pictures: its setting, as it now stands. */
export type TileArt =
  | { kind: 'effort'; on: boolean }
  | { kind: 'judge'; judge: 'haiku' | 'jev' | 'model' }
  | { kind: 'mode'; on: boolean }
  | { kind: 'warm'; on: boolean }
  | { kind: 'skin'; skin: Skin }

/**
 * A tile's picture, 44 px: a rounded square of its own colour with the setting drawn as it stands
 * (rising bars sounding by themselves for automatic effort, the judge's letter, a stack of worker
 * cards, a flame or a snowflake for keep-warm, a small panel for the skin), alive while it is on.
 */
export function tileArt(art: TileArt): string {
  const s = TILE_PX
  const square = (top: string, bottom: string, edge: string) =>
    '<defs><linearGradient id="q" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + top + '"/><stop offset="1" stop-color="' + bottom + '"/></linearGradient>' +
    '<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8"/></filter></defs>' +
    '<rect x="1" y="1" width="' + (s - 2) + '" height="' + (s - 2) + '" rx="12" fill="url(#q)" stroke="' + edge + '" stroke-opacity=".45"/>' +
    '<rect x="2" y="1.5" width="' + (s - 4) + '" height="' + (s / 2 - 2) + '" rx="10" fill="#fff" fill-opacity=".07"/>'
  if (art.kind === 'effort') {
    let bars = ''
    let glow = ''
    for (let i = 0; i < 5; i++) {
      const bh = 7 + i * 4.2
      const x = 9.2 + i * 5.4
      const rect = '<rect class="' + (art.on ? 'b' + i : '') + '" x="' + r(x) + '" y="' + r(34 - bh) + '" width="3.6" height="' + r(bh) + '" rx="1.4" fill="' + (art.on ? DEPTH[i] : SOFT) + '" fill-opacity="' + (art.on ? 1 : 0.35) + '"/>'
      bars += rect
      if (art.on) glow += rect.replace('<rect', '<rect filter="url(#f)" opacity=".7"')
    }
    const sonar = art.on ? '<circle class="so" cx="22" cy="22" r="17" fill="none" stroke="#a5f3fc" stroke-width="1"/><path class="st" d="M35 8.6l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="#fde68a"/>' : ''
    const css = art.on
      ? '.so{transform-box:fill-box;transform-origin:center;opacity:0;animation:so 3.2s ease-out infinite;animation-delay:-1s}@keyframes so{0%{transform:scale(.2);opacity:.0}15%{opacity:.7}100%{transform:scale(1.05);opacity:0}}' +
        [0, 1, 2, 3, 4].map(i => '.b' + i + '{transform-box:fill-box;transform-origin:bottom;animation:bb 3.2s ease-in-out infinite;animation-delay:-' + r(1 + i * 0.12) + 's}').join('') +
        '@keyframes bb{0%,100%{transform:none}50%{transform:scaleY(.82)}}.st{transform-box:fill-box;transform-origin:center;animation:tw 2.6s ease-in-out infinite}@keyframes tw{0%,100%{opacity:.4;transform:scale(.7)}50%{opacity:1;transform:scale(1.1)}}'
      : ''
    return svg(s, s, square(art.on ? '#33227a' : '#34322f', art.on ? '#191146' : '#232220', art.on ? '#a78bfa' : '#8f8b82') + glow + bars + sonar, css)
  }
  if (art.kind === 'judge') {
    const tone = art.judge === 'haiku' ? { top: '#5a2e1f', bottom: '#2a140d', ink: '#ffb38a', edge: '#f0a07a' } : art.judge === 'jev' ? { top: '#0f4a46', bottom: '#082624', ink: '#7ff3e0', edge: '#5eead4' } : { top: '#1f2a66', bottom: '#0f1438', ink: '#a5b4fc', edge: '#a5b4fc' }
    const mark = art.judge === 'model'
      ? '<g fill="none" stroke="' + tone.ink + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="29" r="3.2"/><circle cx="31" cy="15" r="3.2"/><path d="M16 27.5c6-1.5 4-9 12-11"/></g>'
      : '<text x="22" y="29.5" text-anchor="middle" font-size="21" font-weight="760" fill="' + tone.ink + '">' + (art.judge === 'haiku' ? 'H' : 'J') + '</text>'
    const orbit = '<g class="or"><circle cx="22" cy="22" r="16.5" fill="none" stroke="' + tone.ink + '" stroke-opacity=".28" stroke-dasharray="2 4.2"/><circle cx="22" cy="5.5" r="1.8" fill="' + tone.ink + '"/></g>'
    return svg(s, s, square(tone.top, tone.bottom, tone.edge) + orbit + '<g filter="url(#f)" opacity=".55">' + mark + '</g>' + mark, '.or{transform-origin:22px 22px;animation:or 14s linear infinite}@keyframes or{to{transform:rotate(360deg)}}')
  }
  if (art.kind === 'mode') {
    const ink = '#fcd77a'
    const card = (y: number, op: number, cls = '') => '<rect class="' + cls + '" x="11" y="' + y + '" width="22" height="9" rx="2.6" fill="' + ink + '" fill-opacity="' + op + '" stroke="' + ink + '" stroke-opacity="' + Math.min(1, op + 0.3) + '"/>'
    return svg(s, s, square('#4a3410', '#24180a', '#fbbf24') + card(28, 0.18) + card(21.5, 0.32) + '<g class="fl">' + card(15, 0.95) + '<circle cx="15.5" cy="19.5" r="1.4" fill="#3a2604"/><rect x="19" y="18.6" width="10" height="1.8" rx=".9" fill="#3a2604" fill-opacity=".7"/></g>',
      '.fl{animation:fl 4.4s ease-in-out infinite}@keyframes fl{0%,100%{transform:none}50%{transform:translateY(-1.2px)}}')
  }
  if (art.kind === 'skin') {
    // A small panel in lavender: its head's dot, a title line, two lines of words.
    const ink = '#c4b5fd'
    return svg(s, s, square('#33227a', '#191146', '#a78bfa') +
      '<rect x="10.5" y="12.5" width="23" height="19" rx="3.5" fill="' + ink + '" fill-opacity=".12" stroke="' + ink + '" stroke-width="1.6"/>' +
      '<circle cx="16" cy="18.5" r="2" fill="' + ink + '"/>' +
      '<path d="M20.5 18.5h8M15 24h12M15 27.5h8" fill="none" stroke="' + ink + '" stroke-width="1.6" stroke-linecap="round"/>')
  }
  if (art.on) {
    const flame = 'M22 35.5c6.4 0 10-4.2 10-9.6 0-6-5.2-9-6.1-15.4-3.6 2.4-5.6 6-5.4 9.3-2.2-.9-3.3-3-3.5-4.9-3 2.9-4.4 6.4-4.4 11.3 0 5.4 3.6 9.3 9.4 9.3z'
    return svg(s, s,
      square('#5a1f17', '#2a0f0b', '#fb923c') +
      '<defs><linearGradient id="fg" x1="0" x2="0" y1="1" y2="0"><stop offset="0" stop-color="#f97316"/><stop offset=".55" stop-color="#fbbf24"/><stop offset="1" stop-color="#fef3c7"/></linearGradient></defs>' +
      '<g class="fx"><path d="' + flame + '" fill="#fb923c" filter="url(#f)" opacity=".85"/><path d="' + flame + '" fill="url(#fg)"/><path d="M22 34c2.6 0 4.1-1.8 4.1-4 0-2.6-2.2-3.7-2.6-6.4-1.6 1.1-2.4 2.6-2.3 4-1-.4-1.4-1.3-1.5-2.1-1.3 1.2-1.9 2.7-1.9 4.6 0 2.2 1.5 3.9 4.2 3.9z" fill="#fff7e0" fill-opacity=".85"/></g>' +
      '<circle class="sk" cx="30" cy="12" r="1.1" fill="#fde68a"/><circle class="sk sk2" cx="14" cy="14" r=".9" fill="#fdba74"/>',
      '.fx{transform-origin:22px 35px;animation:fx 1.8s ease-in-out infinite}@keyframes fx{0%,100%{transform:scale(1,1)}35%{transform:scale(.95,1.05) skewX(-1.5deg)}70%{transform:scale(1.03,.97) skewX(1deg)}}' +
      '.sk{animation:sk 2.4s ease-out infinite;opacity:0}.sk2{animation-delay:-1.2s}@keyframes sk{0%{transform:translateY(6px);opacity:0}30%{opacity:1}100%{transform:translateY(-6px);opacity:0}}')
  }
  const arm = (a: number) => '<g transform="rotate(' + a + ' 22 22)"><path d="M22 9v26M22 13l-3-3M22 13l3-3M22 31l-3 3M22 31l3 3"/></g>'
  return svg(s, s, square('#183650', '#0c1a2a', '#7dd3fc') + '<g fill="none" stroke="#a7defb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".9">' + arm(0) + arm(60) + arm(120) + '</g>')
}

/** The setup's steps as beads on a thread, 16 px high: done filled, the current one lit and larger. */
export function beadsArt(step: number, total: number): { source: string; width: number } {
  const gap = 16
  const w = gap * (total - 1) + 16
  let body = '<rect x="8" y="7.4" width="' + (w - 16) + '" height="1.2" rx=".6" fill="' + HAIR + '" fill-opacity=".2"/>'
  for (let i = 1; i <= total; i++) {
    const cx = 8 + (i - 1) * gap
    if (i < step) body += '<circle cx="' + cx + '" cy="8" r="3.6" fill="#a78bfa"/>'
    else if (i === step) body += '<circle cx="' + cx + '" cy="8" r="7" fill="#8b6bff" opacity=".35"/><circle cx="' + cx + '" cy="8" r="4.6" fill="#fff"/><circle cx="' + cx + '" cy="8" r="2" fill="#7c5cff"/>'
    else body += '<circle cx="' + cx + '" cy="8" r="3.4" fill="' + WATER[1] + '" stroke="' + HAIR + '" stroke-opacity=".4"/>'
  }
  return { source: svg(w, 16, body), width: w }
}
