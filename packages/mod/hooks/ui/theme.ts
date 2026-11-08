// Colours and SVG plumbing shared by every drawing of the mod. Pure: no engine calls.
//
// The look is calm at rest: neutral ink on the host's own background, the ClaudeRipple accent
// (#6a56d6, packages/ui/style.css) only where something wants attention, and green/amber/red kept
// for results. SVG chips do not know the host's background, so they are drawn in translucent ink
// (a few percent of the text colour) and sit on the Code tab's warm or cool greys alike.

export type Appearance = 'auto' | 'dark' | 'light'

export type Palette = {
  /** Body text. */
  ink: string
  /** Secondary text. */
  muted: string
  /** Hairlines, unlit glyph parts. */
  faint: string
  /** Chip fill and stroke: ink at a few percent. */
  fill: string
  stroke: string
  accent: string
  /** The accent as a wash behind a lit control. */
  accentWash: string
  accentLine: string
  /** Fill of a primary action, white text on it. */
  primary: string
  ok: string
  warn: string
  bad: string
}

export const ACCENT = '#6a56d6'

export const DARK: Palette = {
  ink: '#ecebf2',
  muted: '#a19fae',
  faint: '#55535f',
  fill: 'rgba(236,235,242,0.045)',
  stroke: 'rgba(236,235,242,0.13)',
  accent: '#a594f5',
  accentWash: 'rgba(150,130,245,0.17)',
  accentLine: 'rgba(165,148,245,0.62)',
  primary: '#6f5bdc',
  ok: '#3ecb7d',
  warn: '#e0b436',
  bad: '#ef5a5a',
}

export const LIGHT: Palette = {
  ink: '#1d1b26',
  muted: '#64616f',
  faint: '#c9c6d2',
  fill: 'rgba(29,27,38,0.035)',
  stroke: 'rgba(29,27,38,0.13)',
  accent: '#6a56d6',
  accentWash: 'rgba(106,86,214,0.10)',
  accentLine: 'rgba(106,86,214,0.55)',
  primary: '#6a56d6',
  ok: '#1a8a4a',
  warn: '#b5820a',
  bad: '#c73434',
}

/**
 * Colours for native Text, which the host draws on its own background. With appearance auto the
 * mod cannot know that background, so these are mid tones that read on both.
 */
export const TEXT = {
  accent: '#7c69e0',
  ok: '#16a34a',
  warn: '#d97706',
  bad: '#dc2626',
}

export function textTone(appearance: Appearance): typeof TEXT {
  if (appearance === 'dark') return { accent: DARK.accent, ok: DARK.ok, warn: DARK.warn, bad: DARK.bad }
  if (appearance === 'light') return { accent: LIGHT.accent, ok: LIGHT.ok, warn: LIGHT.warn, bad: LIGHT.bad }
  return TEXT
}

// A provider is named by whoever added it, so most names are not known here. The presets' default
// names keep their vendor's hue; any other name gets one from PALETTE picked by a hash of the name,
// so it keeps that colour from one session to the next. The palette leaves out the status
// red/green/amber, so a provider is never read as a result.
const KNOWN: Record<string, string> = {
  anthropic: '#d97757',
  chatgpt: '#10a37f',
  google: '#4285f4',
  'google-gemini': '#4285f4',
  deepseek: '#4d6bfe',
  'opencode-go': '#9333ea',
  'opencode-zen': '#9333ea',
  // MiniMax's red, so its row is told from the others by the vendor's own hue.
  minimax: '#e5484d',
  // xAI's mark is black on white; silver reads on the band's dark capsule.
  grok: '#a8a29e',
}
const PALETTE = ['#0891b2', '#db2777', '#7c3aed', '#0d9488', '#c026d3', '#4f46e5', '#0284c7', '#be185d']

export function providerColor(provider: string): string {
  if (provider === 'refused') return TEXT.bad
  const known = KNOWN[provider]
  if (known) return known
  let hash = 0
  for (const char of provider) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]!
}

/** Worker tiers keep one hue each, away from the status colours and from each other. */
export const TIER_HUE: Record<'light' | 'standard' | 'deep' | 'design', string> = {
  light: '#0891b2',
  standard: '#6a56d6',
  deep: '#be185d',
  design: '#d97757',
}

// The acceptance bar for translated providers is a 90% cache hit.
export function cacheTone(percent: number): 'ok' | 'warn' | 'bad' {
  return percent >= 90 ? 'ok' : percent >= 50 ? 'warn' : 'bad'
}

/** Context fill: neutral until 80% of the compaction window, amber past it, red from 95%. */
export function contextTone(percent: number): 'ink' | 'warn' | 'bad' {
  return percent >= 95 ? 'bad' : percent >= 80 ? 'warn' : 'ink'
}

/** Plan window: neutral under 80%, amber to 95%, red above. */
export function limitTone(percent: number): 'ink' | 'warn' | 'bad' {
  return percent >= 95 ? 'bad' : percent >= 80 ? 'warn' : 'ink'
}

// ---- SVG ------------------------------------------------------------------------------------

const VARS: (keyof Palette)[] = ['ink', 'muted', 'faint', 'fill', 'stroke', 'accent', 'accentWash', 'accentLine', 'primary', 'ok', 'warn', 'bad']

function varsOf(p: Palette): string {
  return VARS.map(k => '--' + k + ':' + p[k]).join(';')
}

/** `var(--name)` for a palette key: what SVG markup paints with. */
export function v(key: keyof Palette): string {
  return 'var(--' + key + ')'
}

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',system-ui,sans-serif"

/**
 * One SVG document. The palette is set as CSS variables on the root: fixed for dark or light, and
 * for auto switched by the frame's `prefers-color-scheme`. `viewBox` draws a grid of its own at
 * this size (the mascot's 56 units); absent, one unit is one pixel.
 */
export function svgDoc(width: number, height: number, appearance: Appearance, body: string, css = '', viewBox = '0 0 ' + width + ' ' + height): string {
  const vars =
    appearance === 'dark'
      ? 'svg{' + varsOf(DARK) + '}'
      : appearance === 'light'
        ? 'svg{' + varsOf(LIGHT) + '}'
        : 'svg{' + varsOf(LIGHT) + '}@media (prefers-color-scheme:dark){svg{' + varsOf(DARK) + '}}'
  const base =
    'text{font-family:' + FONT + ';font-variant-numeric:tabular-nums;fill:var(--ink)}' +
    '.cap{font-size:8.5px;letter-spacing:.09em;font-weight:600;fill:var(--muted)}' +
    '.val{font-size:12.5px;font-weight:600}' +
    '.sub{font-size:11.5px;fill:var(--muted)}' +
    '.lbl{font-size:12px;font-weight:500}'
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
    '" viewBox="' + viewBox + '"><style>' + vars + base + css + '</style>' + body + '</svg>'
  )
}

// East Asian Wide and Fullwidth ranges (UAX #11), and the emoji planes terminals draw two wide.
const WIDE = /[ᄀ-ᅟ⌚⌛〈〉⏩-⏬⏰⏳◽◾☔☕♈-♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦\u{16FE0}-\u{16FE4}\u{17000}-\u{18CFF}\u{1B000}-\u{1B2FF}\u{1F004}\u{1F0CF}\u{1F18E}\u{1F191}-\u{1F19A}\u{1F200}-\u{1F251}\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F7E0}-\u{1F7EB}\u{1F90C}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
// Combining marks, zero-width spaces and joiners, variation selectors: no cell of their own.
const ZERO = /[\p{Mn}\p{Me}​-‏⁠-⁤﻿︀-️]/u

/** Terminal cells a code point takes: 2 for East Asian Wide/Fullwidth, 0 for combining and controls, else 1. */
function cellWidth(char: string): number {
  const code = char.codePointAt(0)!
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  if (ZERO.test(char)) return 0
  return WIDE.test(char) ? 2 : 1
}

/** Terminal columns `text` takes: East Asian Wide/Fullwidth count 2, combining marks 0. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += cellWidth(char)
  return width
}

/**
 * The desktop width of `text` in `ch`, unrounded: the host's `ch` is the width of "0" in its 14 px
 * sans. Measured 2026-10-10 in Chromium on macOS: ch 8.8 px, Hangul and kana ~12 px (1.36 ch),
 * "Medium" 5.9 ch, "X-High" 5.1 ch. Each class of character is taken a little wide of that.
 */
export function chOf(text: string): number {
  let ch = 0
  for (const char of text) {
    if (displayWidth(char) === 2) ch += 1.45
    else if (char === ' ') ch += 0.45
    else if (/[ilIj.,:;|'!]/.test(char)) ch += 0.4
    else if (/[mwMW@%]/.test(char)) ch += 1.35
    else if (/[A-Z]/.test(char)) ch += 1.1
    else if (/[0-9]/.test(char)) ch += 1
    else ch += 0.85
  }
  return ch
}

/** Cuts text to at most `max` terminal columns, the ellipsis included. */
export function clip(text: string, max: number): string {
  if (displayWidth(text) <= max) return text
  const room = Math.max(1, max - 1)
  let out = ''
  let used = 0
  for (const char of text) {
    const w = cellWidth(char)
    if (used + w > room) break
    out += char
    used += w
  }
  return out + '…'
}
