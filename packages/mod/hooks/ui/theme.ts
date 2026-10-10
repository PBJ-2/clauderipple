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
  'google-gemini': '#4285f4',
  deepseek: '#4d6bfe',
  'opencode-go': '#9333ea',
  'opencode-zen': '#9333ea',
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

/** Context fill: neutral until the swamp line, amber past it, red from 85%. */
export function contextTone(percent: number, swampAt: number): 'ink' | 'warn' | 'bad' {
  return percent >= 85 ? 'bad' : percent >= swampAt ? 'warn' : 'ink'
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
 * for auto switched by the frame's `prefers-color-scheme`.
 */
export function svgDoc(width: number, height: number, appearance: Appearance, body: string, css = ''): string {
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
    '" viewBox="0 0 ' + width + ' ' + height + '"><style>' + vars + base + css + '</style>' + body + '</svg>'
  )
}

/** Escapes text for SVG markup. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * A width estimate for SVG text, in px, so chips can be sized before the frame lays them out.
 * Errs wide: a chip with a little air reads better than clipped text.
 */
export function textWidth(text: string, size = 12, weight: 'normal' | 'bold' = 'normal'): number {
  let units = 0
  for (const char of text) {
    if (/[ilI.,:;|'!]/.test(char)) units += 0.3
    else if (/[mwMW@%]/.test(char)) units += 0.86
    else if (/[A-Z0-9]/.test(char)) units += 0.64
    else if (char === ' ') units += 0.3
    else if (char.charCodeAt(0) > 0x2e80) units += 1
    else units += 0.55
  }
  return Math.ceil(units * size * (weight === 'bold' ? 1.06 : 1))
}

/** Cuts text to at most `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '…'
}
