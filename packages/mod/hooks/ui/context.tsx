// The Context pane: what fills the conversation's context, as /context breaks it down, opened from
// the band's context chip. The Claude app used to open such a view from the ring under its composer
// and dropped it (2026-10-24); this is ours.
//
// Its figures are `$.session.usage({ breakdown })`'s (register.tsx): a `summary` estimate when the
// pane opens (local, free), the token-count API's `full` count when the person asks for it. Every
// share is of `rawMaxTokens`, the window compaction measures against, not the model's whole window:
// that is the figure /context and the auto-compact threshold speak of.
//
// The desktop draws one capsule (kit.tsx): a dial of the categories with the share in its middle, the
// tokens and the model beside it; the grid /context draws, square by square in each category's
// colour, beside its legend; then a tile each for the memory files, the MCP tools by server, the
// skills and the custom agents, each the largest few and the rest a press away; last, how compaction
// stands. Colour is the categories' own, on the deep's water or the app's surface (flat); the accent
// is not a ground anywhere. The terminal draws the same in lines of text, /context's own glyphs in
// the engine's theme colours.
//
// The pane redraws on each step of the conversation (it reads the context the band reads), so the
// water holds still: no ripples to start over.

import { t } from '../i18n'
import type { Lang } from '../i18n'
import type { ContextCategory, ContextGridSquare, RenderNode, SessionContextBreakdown } from 'claude-code'

import { CELL_PX, INK, ROW_PX, SVG_MAX_PX, r, svg } from './art'
import { CLOSE_CELLS, capsule, closeButton, pic, pill } from './kit'
import { DISPLAY, displayText } from './display'
import { lookOf } from './look'
import type { Look } from './look'
import { canDraw, textButton } from './parts'
import type { Els } from './parts'
import { chOf, clip, contextTone, svgDoc, textTone } from './theme'
import { shortPath } from './tools'
import type { Place } from './tools'
import type { Frame } from './view'
import { compactNumber } from './view'

/** Rows a section shows before "more". */
export const CONTEXT_SHOWN = 5
/** Rows a section shows at most, opened: a long list of tools must not run the tree past its budget. */
const CONTEXT_MAX = 60

export type ContextSection = 'memory' | 'mcp' | 'skills' | 'agents'

export type ContextView = {
  /** The breakdown, or null where the host has none (no session bound, a remote one not answering). */
  breakdown: SessionContextBreakdown | null
  /** How it was counted: the local estimate, or the token-count API. */
  basis: 'summary' | 'full'
  /** A precise count is under way. */
  busy: boolean
  /** The token-count API counts this model (session.ts `countsPrecisely`); else no precise count is offered. */
  precise: boolean
  /** Why the last precise count failed. */
  error?: string
  /** Sections shown whole. */
  open: readonly ContextSection[]
  /** The session's folder and home, to say a memory file's path short. */
  place: Place
}

export type ContextActions = {
  /** Counts again with the token-count API. */
  refresh: () => void
  /** Shows a section whole, or its largest few again. */
  toggle: (section: ContextSection) => void
  close: () => void
}

type Kind = ContextCategory['kind']

// ---- Words ---------------------------------------------------------------------------------------

/** The engine's category names (/context's own rows) and the keys their words have here. */
const CATEGORY: Readonly<Record<string, string>> = {
  'System prompt': 'systemPrompt',
  'System tools': 'systemTools',
  'System tools (deferred)': 'systemDeferred',
  'MCP tools': 'mcpTools',
  'MCP tools (deferred)': 'mcpDeferred',
  'MCP server instructions': 'mcpInstructions',
  'Custom agents': 'agents',
  'Memory files': 'memory',
  Skills: 'skills',
  Messages: 'messages',
  'Free space': 'free',
  'Autocompact buffer': 'buffer',
  'Compact buffer': 'compactBuffer',
}

function categoryName(c: ContextCategory, lang: Lang): string {
  const key = CATEGORY[c.name]
  return key ? t(lang, 'context.cat.' + key) : displayText(c.name, DISPLAY.name)
}

/** Where a memory file, a skill or an agent comes from, by the engine's word, in the person's words. */
const SOURCE: Readonly<Record<string, string>> = {
  Project: 'project', projectSettings: 'project',
  User: 'user', userSettings: 'user',
  Local: 'local', localSettings: 'local',
  Managed: 'managed', policySettings: 'managed',
  AutoMem: 'automem',
  plugin: 'plugin',
  'built-in': 'builtin', builtin: 'builtin', bundled: 'builtin',
  mcp: 'mcp',
  syncedSkills: 'synced',
}

function sourceName(source: string, lang: Lang): string {
  const key = SOURCE[source]
  return key ? t(lang, 'context.src.' + key) : displayText(source, DISPLAY.name)
}

/** A share of the window: one decimal under 10%, whole above; a sliver says "<0.1%". */
function share(tokens: number, max: number): string {
  if (max <= 0) return '–'
  const p = (tokens / max) * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  return (p < 10 ? p.toFixed(1) : String(Math.round(p))) + '%'
}

/** `text` cut to `room` of the desktop's `ch`, an ellipsis where it was cut (agents.tsx `clipCh`). */
function clipCh(text: string, room: number): string {
  if (chOf(text) <= room) return text
  let out = ''
  let used = 0
  for (const char of text) {
    used += chOf(char)
    if (used > room - 1) break
    out += char
  }
  return out.trimEnd() + '…'
}

// ---- Colours -------------------------------------------------------------------------------------
//
// The engine names each category's colour by its key in the terminal's theme (/context's own). The
// terminal takes those keys as they are; the pictures need colours, one set per skin: light marks on
// the deep's water, mid tones that read on the app's light surface and its dark one alike (flat).
// Messages, mostly the largest share, are a cool blue; violet is kept to the small custom-agents row.

const DEEP_HUE: Readonly<Record<string, string>> = {
  promptBorder: '#d6d3cb',
  inactive: '#8f8b82',
  cyan_FOR_SUBAGENTS_ONLY: '#5ee0f0',
  green_FOR_SUBAGENTS_ONLY: '#7ee2a8',
  permission: '#c4b5fd',
  claude: '#e8946f',
  warning: '#fcd77a',
  purple_FOR_SUBAGENTS_ONLY: '#7dc3fc',
}
const FLAT_HUE: Readonly<Record<string, string>> = {
  promptBorder: '#8a867d',
  inactive: '#b3afa6',
  cyan_FOR_SUBAGENTS_ONLY: '#0ea5c6',
  green_FOR_SUBAGENTS_ONLY: '#22a35a',
  permission: '#7c69e0',
  claude: '#d97757',
  warning: '#d99a06',
  purple_FOR_SUBAGENTS_ONLY: '#3b8fd9',
}
/** A key neither set knows: a hue picked by its name, away from the status colours. */
const SPARE = ['#f0abfc', '#99f6e4', '#fda4af', '#bef264', '#a5b4fc']
const FLAT_SPARE = ['#c026d3', '#0d9488', '#db2777', '#65a30d', '#4f46e5']

function hue(frame: Frame, key: string): string {
  const flat = frame.skin === 'flat'
  const known = (flat ? FLAT_HUE : DEEP_HUE)[key]
  if (known) return known
  let hash = 0
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const spare = flat ? FLAT_SPARE : SPARE
  return spare[hash % spare.length]!
}

/** One picture in the skin's document: the deep's plain SVG, flat's following the app's theme. */
function doc(frame: Frame, width: number, height: number, body: string): string {
  return frame.skin === 'flat' ? svgDoc(width, height, frame.appearance, body) : svg(width, height, body)
}

/** The free and reserved squares' strokes and fills, by skin. */
function quiet(frame: Frame): { line: string; lineOpacity: number; fill: string; fillOpacity: number; hatch: string } {
  return frame.skin === 'flat'
    ? { line: '#8a867d', lineOpacity: 0.45, fill: '#8a867d', fillOpacity: 0.06, hatch: '#8a867d' }
    : { line: '#ffffff', lineOpacity: 0.16, fill: '#ffffff', fillOpacity: 0.035, hatch: '#ffffff' }
}

// ---- Pictures ------------------------------------------------------------------------------------

/** The grid's square and the air between squares, px: smaller for the wide grid of a large window. */
function squarePx(cols: number): { size: number; gap: number } {
  return cols >= 20 ? { size: 11, gap: 3 } : { size: 15, gap: 4 }
}

function gridSize(rows: readonly ContextGridSquare[][]): { width: number; height: number; cols: number } {
  const cols = Math.max(1, ...rows.map(row => row.length))
  const { size, gap } = squarePx(cols)
  return { width: cols * size + (cols - 1) * gap, height: Math.max(1, rows.length) * size + Math.max(0, rows.length - 1) * gap, cols }
}

/**
 * /context's grid as one picture: each square in its category's colour, a category's last square
 * lighter while under 0.7 full (/context draws it hollow there), the free ones an outline, the
 * compaction reserve hatched.
 */
export function gridArt(frame: Frame, rows: readonly ContextGridSquare[][], kinds: ReadonlyMap<string, Kind>): { source: string; width: number; height: number } {
  const { width, height, cols } = gridSize(rows)
  const { size, gap } = squarePx(cols)
  const q = quiet(frame)
  const rx = r(size * 0.24)
  let body = '<defs><pattern id="h" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.5" height="4" fill="' + q.hatch + '" fill-opacity="' + (frame.skin === 'flat' ? 0.45 : 0.3) + '"/></pattern></defs>'
  rows.forEach((row, y) => {
    row.forEach((sq, x) => {
      const at = ' x="' + r(x * (size + gap) + 0.5) + '" y="' + r(y * (size + gap) + 0.5) + '" width="' + (size - 1) + '" height="' + (size - 1) + '" rx="' + rx + '"'
      const kind = kinds.get(sq.categoryName) ?? 'used'
      if (kind === 'free' || !sq.isFilled) body += '<rect' + at + ' fill="' + q.fill + '" fill-opacity="' + q.fillOpacity + '" stroke="' + q.line + '" stroke-opacity="' + q.lineOpacity + '"/>'
      else if (kind === 'buffer') body += '<rect' + at + ' fill="url(#h)" stroke="' + q.line + '" stroke-opacity="' + q.lineOpacity + '"/>'
      else {
        const color = hue(frame, sq.color)
        body += sq.squareFullness < 0.7
          ? '<rect' + at + ' fill="' + color + '" fill-opacity=".38" stroke="' + color + '" stroke-opacity=".9"/>'
          : '<rect' + at + ' fill="' + color + '"/>'
      }
    })
  })
  return { source: doc(frame, width, height, body), width, height }
}

/** The dial's side, px. */
const DIAL_PX = 64

/**
 * The share as a dial: each used category an arc in its colour, clockwise from the top, the
 * compaction reserve hatched at the end of the turn, the share in the middle in its tone.
 */
export function dialArt(frame: Frame, b: SessionContextBreakdown): string {
  const s = DIAL_PX
  const c = s / 2
  const rad = c - 6
  const stroke = 7
  const turn = 2 * Math.PI * rad
  const max = Math.max(1, b.rawMaxTokens)
  const q = quiet(frame)
  const flat = frame.skin === 'flat'
  let body = '<defs><pattern id="h" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.6" height="4" fill="' + q.hatch + '" fill-opacity="' + (flat ? 0.5 : 0.34) + '"/></pattern></defs>'
  body += '<circle cx="' + c + '" cy="' + c + '" r="' + rad + '" fill="none" stroke="' + q.line + '" stroke-opacity="' + (flat ? 0.22 : 0.12) + '" stroke-width="' + stroke + '"/>'
  const arc = (from: number, length: number, paint: string) =>
    '<circle cx="' + c + '" cy="' + c + '" r="' + rad + '" fill="none" stroke="' + paint + '" stroke-width="' + stroke + '" stroke-dasharray="' + r(length) + ' ' + r(turn) + '" stroke-dashoffset="' + r(-from) + '" transform="rotate(-90 ' + c + ' ' + c + ')"/>'
  const buffer = b.categories.filter(x => x.kind === 'buffer').reduce((n, x) => n + x.tokens, 0)
  const room = turn * (1 - Math.min(1, buffer / max))
  let at = 0
  for (const cat of b.categories) {
    if (cat.kind !== 'used' || cat.tokens <= 0 || at >= room) continue
    const length = Math.min(room - at, (cat.tokens / max) * turn)
    // A hair of air between arcs, so neighbours of near colours stay apart.
    if (length > 0.4) body += arc(at, Math.max(0.4, length - (length > 3 ? 1.2 : 0)), hue(frame, cat.color))
    at += length
  }
  if (buffer > 0) body += arc(room, turn - room, 'url(#h)')
  const tone = contextTone(b.percentage)
  const ink = tone === 'bad' ? (flat ? textTone(frame.appearance).bad : '#fda9b4') : tone === 'warn' ? (flat ? textTone(frame.appearance).warn : '#fcd77a') : flat ? 'var(--ink)' : INK
  const figure = Math.round(b.percentage) + '%'
  body += '<text x="' + c + '" y="' + r(c + 5) + '" text-anchor="middle" font-size="' + (figure.length > 3 ? 14 : 16) + '" font-weight="680" style="fill:' + ink + '">' + figure + '</text>'
  return doc(frame, s, s, body)
}

/** A legend's swatch, 10 px: the category's colour, an outline for the free space, hatched for the reserve. */
function swatchArt(frame: Frame, kind: Kind, color: string): string {
  const q = quiet(frame)
  const at = ' x=".5" y=".5" width="9" height="9" rx="2.4"'
  if (kind === 'free') return doc(frame, 10, 10, '<rect' + at + ' fill="' + q.fill + '" fill-opacity="' + q.fillOpacity + '" stroke="' + q.line + '" stroke-opacity="' + Math.min(1, q.lineOpacity * 2) + '"/>')
  if (kind === 'buffer') return doc(frame, 10, 10, '<defs><pattern id="h" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.2" height="3" fill="' + q.hatch + '" fill-opacity=".5"/></pattern></defs><rect' + at + ' fill="url(#h)" stroke="' + q.line + '" stroke-opacity="' + Math.min(1, q.lineOpacity * 2) + '"/>')
  if (kind === 'deferred') return doc(frame, 10, 10, '<rect' + at + ' fill="none" stroke="' + hue(frame, color) + '" stroke-dasharray="2 1.6"/>')
  return doc(frame, 10, 10, '<rect' + at + ' fill="' + hue(frame, color) + '"/>')
}

// ---- What the sections list ----------------------------------------------------------------------

type Item = { key: string; name: string; meta: string; tokens: number }
type Section = { key: ContextSection; title: string; count: string; tokens: number; items: Item[] }

function sectionsOf(b: SessionContextBreakdown, place: Place, lang: Lang): Section[] {
  const out: Section[] = []
  const byTokens = (a: Item, z: Item) => z.tokens - a.tokens
  if (b.memoryFiles.length) {
    const items = b.memoryFiles.map((f, i): Item => ({ key: 'm' + i, name: displayText(shortPath(f.path, place), DISPLAY.preview), meta: sourceName(f.type, lang), tokens: f.tokens })).sort(byTokens)
    out.push({ key: 'memory', title: t(lang, 'context.memory'), count: t(lang, 'context.count', { count: items.length }), tokens: items.reduce((n, x) => n + x.tokens, 0), items })
  }
  if (b.mcpTools.length) {
    const servers = new Map<string, { tools: number; deferred: number; tokens: number }>()
    for (const tool of b.mcpTools) {
      const s = servers.get(tool.serverName) ?? { tools: 0, deferred: 0, tokens: 0 }
      s.tools++
      if (!tool.isLoaded) s.deferred++
      else s.tokens += tool.tokens
      servers.set(tool.serverName, s)
    }
    const items = [...servers].map(([name, s], i): Item => ({
      key: 's' + i,
      name: displayText(name, DISPLAY.name),
      meta: s.deferred ? t(lang, 'context.toolsDeferred', { count: s.tools, deferred: s.deferred }) : t(lang, 'context.tools', { count: s.tools }),
      tokens: s.tokens,
    })).sort(byTokens)
    out.push({ key: 'mcp', title: t(lang, 'context.mcp'), count: t(lang, 'context.servers', { count: items.length, tools: b.mcpTools.length }), tokens: items.reduce((n, x) => n + x.tokens, 0), items })
  }
  const skills = b.skills
  if (skills && skills.skillFrontmatter.length) {
    const items = skills.skillFrontmatter.map((s, i): Item => ({ key: 'k' + i, name: displayText(s.name, DISPLAY.name), meta: s.pluginName ? displayText(s.pluginName, DISPLAY.name) : sourceName(s.source, lang), tokens: s.tokens })).sort(byTokens)
    const count = skills.includedSkills < skills.totalSkills ? t(lang, 'context.skillsOf', { included: skills.includedSkills, total: skills.totalSkills }) : t(lang, 'context.count', { count: skills.totalSkills })
    out.push({ key: 'skills', title: t(lang, 'context.skills'), count, tokens: skills.tokens, items })
  }
  if (b.agents.length) {
    const items = b.agents.map((a, i): Item => ({ key: 'a' + i, name: displayText(a.agentType, DISPLAY.name), meta: sourceName(a.source, lang), tokens: a.tokens })).sort(byTokens)
    out.push({ key: 'agents', title: t(lang, 'context.agents'), count: t(lang, 'context.count', { count: items.length }), tokens: items.reduce((n, x) => n + x.tokens, 0), items })
  }
  return out
}

/** What a section shows: the largest few, or all of them (up to CONTEXT_MAX) once opened. */
function shownItems(section: Section, open: readonly ContextSection[]): Item[] {
  return section.items.slice(0, open.includes(section.key) ? CONTEXT_MAX : CONTEXT_SHOWN)
}

/** The lines under the sections: how compaction stands, the slash commands' listing. */
function footLines(b: SessionContextBreakdown, lang: Lang): string[] {
  const lines = [
    b.isAutoCompactEnabled
      ? (b.autoCompactThreshold ? t(lang, 'context.autoAt', { tokens: compactNumber(b.autoCompactThreshold) }) : t(lang, 'context.autoOn'))
      : t(lang, 'context.autoOff'),
  ]
  const c = b.slashCommands
  if (c && c.totalCommands) lines.push(t(lang, 'context.commands', { included: c.includedCommands, total: c.totalCommands, tokens: compactNumber(c.tokens) }))
  return lines
}

/** The categories the legend lists: every one with tokens, the free space and the reserve last. */
function legendOf(b: SessionContextBreakdown): ContextCategory[] {
  const rank = (k: Kind) => (k === 'used' ? 0 : k === 'deferred' ? 1 : k === 'free' ? 2 : 3)
  return b.categories.filter(c => c.tokens > 0 || c.kind === 'free').map((c, i) => ({ c, i })).sort((a, z) => rank(a.c.kind) - rank(z.c.kind) || a.i - z.i).map(x => x.c)
}

// ---- Desktop -------------------------------------------------------------------------------------

/** Cells of the tokens' slot and the share's. */
const TOKENS_CELLS = Math.ceil(chOf('999.9k'))
const SHARE_CELLS = Math.ceil(chOf('100.0%'))
/** Below this many cells beside the grid, the legend goes under it. */
const LEGEND_MIN = 30
const LEGEND_MAX = 46

/** Cells of text a capsule has across: the pane less its air and edges. */
function innerCells(frame: Frame): number {
  return Math.max(24, frame.columns - 4)
}

function headDrawn(el: Els, frame: Frame, view: ContextView, b: SessionContextBreakdown, actions: ContextActions): RenderNode {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const label = view.busy ? t(L, 'context.refreshing') : t(L, view.basis === 'full' ? 'context.refreshAgain' : 'context.refresh')
  const refresh = view.precise ? pill(el, frame, 'context-refresh', label, 'ghost', () => { if (!view.busy) actions.refresh() }, 'violet') : null
  const over = b.totalTokens > b.rawMaxTokens
  // The model and how the count was made share a line while it fits beside the dial and the
  // controls; else each takes its own, so the second never starts with a stray "·".
  const model = displayText(b.model, DISPLAY.name)
  const basis = t(L, view.basis === 'full' ? 'context.precise' : 'context.estimate')
  const sayCells = innerCells(frame) - Math.ceil(DIAL_PX / CELL_PX) - 4 - (refresh ? lookOf(frame).art.pill(label, 'ghost', 'violet').cells + 1 : 0) - CLOSE_CELLS
  const about = model && chOf(model + ' · ' + basis) > sayCells ? [model, basis] : [[model, basis].filter(Boolean).join(' · ')]
  return (
    <Box key="context-head" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
      {pic(el, 'context-dial', dialArt(frame, b), t(L, 'band.contextAlt', { value: Math.round(b.percentage) + '%', window: compactNumber(b.rawMaxTokens), tokens: compactNumber(b.totalTokens) }), DIAL_PX, DIAL_PX)}
      <Box key="context-say" flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text bold {...k.ink}>{t(L, 'context.title')}</Text>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
          <Text bold {...(over ? { color: k.tone('red') } : k.ink)}>{compactNumber(b.totalTokens)}</Text>
          <Text {...k.sub}>{t(L, 'context.of', { max: compactNumber(b.rawMaxTokens) })}</Text>
        </Box>
        {about.map((line, i) => <Text key={'about-' + i} {...k.mute} wrap="wrap">{line}</Text>)}
      </Box>
      <Box key="context-tools" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
        {refresh}
        {closeButton(el, frame, 'context-close', t(L, 'settings.close'), actions.close)}
      </Box>
    </Box>
  )
}

function legendRow(el: Els, frame: Frame, k: Look, c: ContextCategory, max: number, room: number, i: number): RenderNode {
  const { Box, Text } = el
  const L = frame.lang
  const quietRow = c.kind !== 'used'
  // A deferred kind says it in its own name ("… (loaded on demand)"), its swatch dashed and its share
  // left blank, so no suffix that would cut the name at a narrow legend.
  const name = categoryName(c, L)
  return (
    <Box key={'legend-' + i} flexDirection="row" alignItems="center" columnGap={1} width="100%" minWidth={0}>
      {pic(el, 'swatch-' + i, swatchArt(frame, c.kind, c.color), categoryName(c, L), 10, 10)}
      <Box key="name" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text {...(quietRow ? k.sub : k.ink)}>{clipCh(name, Math.max(6, room))}</Text>
      </Box>
      <Box key="tokens" width={TOKENS_CELLS} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        <Text {...(quietRow ? k.mute : k.sub)}>{compactNumber(c.tokens)}</Text>
      </Box>
      <Box key="share" width={SHARE_CELLS} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        <Text {...k.mute}>{c.kind === 'deferred' ? '' : share(c.tokens, max)}</Text>
      </Box>
    </Box>
  )
}

/** The grid and its legend: side by side when the pane has room for both, else the legend under it. */
function mapDrawn(el: Els, frame: Frame, b: SessionContextBreakdown): { node: RenderNode; rows: number } {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const inner = innerCells(frame)
  const kinds = new Map(b.categories.map(c => [c.name, c.kind] as const))
  const grid = b.gridRows.length ? gridArt(frame, b.gridRows, kinds) : null
  const gridCells = grid ? Math.ceil(grid.width / CELL_PX) : 0
  const side = !!grid && inner - gridCells - 3 >= LEGEND_MIN
  // A wide pane keeps each figure near its name rather than across the window from it.
  const legendCells = Math.min(side ? inner - gridCells - 3 : inner, LEGEND_MAX)
  const legend = legendOf(b)
  const room = legendCells - 2 - TOKENS_CELLS - SHARE_CELLS - 3
  const list = (
    <Box key="context-legend" flexDirection="column" width={legendCells} flexShrink={1} minWidth={0} rowGap={0}>
      <Text key="legend-title" {...k.mute}>{t(L, 'context.byCategory')}</Text>
      {legend.map((c, i) => legendRow(el, frame, k, c, b.rawMaxTokens, room, i))}
    </Box>
  )
  const gridNode = grid ? pic(el, 'context-grid', grid.source, t(L, 'context.title') + ' ' + Math.round(b.percentage) + '%', grid.width, grid.height) : null
  const gridRows = grid ? grid.height / ROW_PX : 0
  const rows = side ? Math.max(gridRows, legend.length + 1) : gridRows + 1 + legend.length + 1
  return {
    node: (
      <Box key="context-map" flexDirection={side ? 'row' : 'column'} alignItems="flex-start" columnGap={3} rowGap={1} width="100%" minWidth={0}>
        {gridNode}
        {list}
      </Box>
    ),
    rows,
  }
}

function sectionDrawn(el: Els, frame: Frame, view: ContextView, section: Section, actions: ContextActions): { node: RenderNode; rows: number } {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const items = shownItems(section, view.open)
  const hidden = section.items.length - Math.min(section.items.length, CONTEXT_SHOWN)
  const opened = view.open.includes(section.key)
  const width = innerCells(frame) - 3
  const rows: RenderNode[] = [
    <Box key="head" flexDirection="row" alignItems="center" columnGap={1} width="100%" minWidth={0}>
      <Text key="title" bold {...k.ink}>{section.title}</Text>
      <Box key="count" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text {...k.mute}>{clipCh(section.count, Math.max(6, width - chOf(section.title) - TOKENS_CELLS - 3))}</Text>
      </Box>
      <Box key="tokens" width={TOKENS_CELLS} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        <Text {...k.sub}>{compactNumber(section.tokens)}</Text>
      </Box>
    </Box>,
  ]
  let lines = 0
  for (const item of items) {
    // The name, where it came from and its tokens on one line while they fit; else where it came
    // from goes under the name, so neither is cut to a stub on a narrow pane.
    const room = width - 1 - TOKENS_CELLS - 2
    const one = chOf(item.name) + 1 + chOf(item.meta) <= room
    const tokens = (
      <Box key="tokens" width={TOKENS_CELLS} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        <Text {...k.sub}>{compactNumber(item.tokens)}</Text>
      </Box>
    )
    lines += one ? 1 : 2
    rows.push(
      <Box key={'item-' + item.key} flexDirection="row" alignItems={one ? 'center' : 'flex-start'} columnGap={1} paddingLeft={1} width="100%" minWidth={0}>
        <Box key="what" flexDirection={one ? 'row' : 'column'} columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
          <Text key="name" {...k.ink}>{clipCh(item.name, Math.max(8, room))}</Text>
          <Text key="meta" {...k.mute}>{clipCh(item.meta, Math.max(8, room - 1))}</Text>
        </Box>
        {tokens}
      </Box>,
    )
  }
  if (hidden > 0) {
    rows.push(
      <Box key="more" flexDirection="row" justifyContent="center" width="100%" paddingTop={0.5}>
        {opened
          ? pill(el, frame, 'context-more-' + section.key, t(L, 'agents.less'), 'ghost', () => actions.toggle(section.key), 'violet', 'back')
          : pill(el, frame, 'context-more-' + section.key, t(L, 'agents.more', { count: hidden }), 'ghost', () => actions.toggle(section.key), 'violet', 'next')}
      </Box>,
    )
  }
  return {
    node: (
      <Box key={'section-' + section.key} flexDirection="column" width="100%" minWidth={0} paddingX={1.5} paddingY={0.5} {...k.tile}>
        {rows}
      </Box>
    ),
    rows: 1 + lines + (hidden > 0 ? 2 : 0) + 1.2,
  }
}

function footDrawn(el: Els, frame: Frame, view: ContextView, b: SessionContextBreakdown): RenderNode {
  const { Box, Text } = el
  const k = lookOf(frame)
  return (
    <Box key="context-foot" flexDirection="column" width="100%" minWidth={0} paddingX={0.5}>
      {footLines(b, frame.lang).map((line, i) => <Text key={'foot-' + i} {...k.mute} wrap="wrap">{line}</Text>)}
      {view.error ? <Text key="foot-error" color={k.tone('red')} wrap="wrap">{t(frame.lang, 'context.failed', { reason: displayText(view.error) })}</Text> : null}
    </Box>
  )
}

function emptyDrawn(el: Els, frame: Frame, view: ContextView, actions: ContextActions): RenderNode {
  const { Box, Text } = el
  const k = lookOf(frame)
  return capsule(el, frame, {
    key: 'context',
    sea: { tone: 'violet', reach: 90, at: { x: 1.5 * CELL_PX + 20, y: 24 } },
    rows: 4,
    paddingY: 1,
    gap: 1,
    children: [
      <Box key="context-head" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold {...k.ink}>{t(frame.lang, 'context.title')}</Text>
          <Text {...k.sub} wrap="wrap">{t(frame.lang, 'context.none')}</Text>
          {view.error && view.error !== t(frame.lang, 'context.none') ? <Text color={k.tone('red')} wrap="wrap">{t(frame.lang, 'context.failed', { reason: displayText(view.error) })}</Text> : null}
        </Box>
        {closeButton(el, frame, 'context-close', t(frame.lang, 'settings.close'), actions.close)}
      </Box>,
    ],
  })
}

function contextDrawn(el: Els, frame: Frame, view: ContextView, actions: ContextActions): RenderNode {
  const b = view.breakdown
  if (!b) return emptyDrawn(el, frame, view, actions)
  const map = mapDrawn(el, frame, b)
  const sections = sectionsOf(b, view.place, frame.lang).map(s => sectionDrawn(el, frame, view, s, actions))
  const foot = footLines(b, frame.lang).length + (view.error ? 2 : 0)
  // Taken generously: a capsule taller than its water would show the page beneath (kit.tsx).
  const rows = 4.5 + 1 + map.rows + sections.reduce((n, s) => n + s.rows + 1, 0) + foot + 3
  return capsule(el, frame, {
    key: 'context',
    // The light sits behind the dial; nothing moves, as the pane redraws on every step.
    sea: { tone: 'violet', reach: 100, at: { x: 1.5 * CELL_PX + DIAL_PX / 2, y: ROW_PX + DIAL_PX / 2 - 6 } },
    rows: Math.min(rows, (SVG_MAX_PX * 3) / ROW_PX),
    paddingY: 1,
    gap: 1,
    children: [headDrawn(el, frame, view, b, actions), map.node, ...sections.map(s => s.node), footDrawn(el, frame, view, b)],
  })
}

// ---- Terminal ------------------------------------------------------------------------------------

/** /context's own glyphs: a full square, a part-full one, the free space, the reserve. */
function glyph(sq: ContextGridSquare, kind: Kind): string {
  if (kind === 'free' || !sq.isFilled) return '⛶'
  if (kind === 'buffer') return '⛝'
  return sq.squareFullness < 0.7 ? '⛀' : '⛁'
}

function contextText(el: Els, frame: Frame, view: ContextView, actions: ContextActions): RenderNode {
  const { Box, Text } = el
  const L = frame.lang
  const b = view.breakdown
  const tone = textTone(frame.appearance)
  const buttons = (
    <Box key="buttons" flexDirection="row" flexWrap="wrap" columnGap={2}>
      {b && view.precise ? textButton(el, 'context-refresh', view.busy ? t(L, 'context.refreshing') : t(L, view.basis === 'full' ? 'context.refreshAgain' : 'context.refresh'), () => { if (!view.busy) actions.refresh() }, 'r') : null}
      {textButton(el, 'context-close', t(L, 'settings.close'), actions.close, 'x')}
    </Box>
  )
  const error = view.error ? <Text key="error" color={tone.bad} wrap="wrap">{t(L, 'context.failed', { reason: displayText(view.error) })}</Text> : null
  if (!b) {
    return (
      <Box flexDirection="column" rowGap={1} width="100%">
        <Text bold>{t(L, 'context.title')}</Text>
        <Text dimColor wrap="wrap">{t(L, 'context.none')}</Text>
        {view.error !== t(L, 'context.none') ? error : null}
        {buttons}
      </Box>
    )
  }
  const kinds = new Map(b.categories.map(c => [c.name, c.kind] as const))
  const ctx = contextTone(b.percentage)
  const width = Math.max(20, frame.columns)
  const grid = b.gridRows.map((row, y) => (
    <Text key={'grid-' + y}>
      {row.map((sq, x) => {
        const kind = kinds.get(sq.categoryName) ?? 'used'
        return <Text key={'sq-' + x} color={kind === 'free' ? undefined : sq.color} dimColor={kind === 'free'}>{glyph(sq, kind) + ' '}</Text>
      })}
    </Text>
  ))
  const legend = legendOf(b).map((c, i) => (
    <Box key={'legend-' + i} flexDirection="row" columnGap={1}>
      <Text color={c.kind === 'free' ? undefined : c.color} dimColor={c.kind === 'free'}>{c.kind === 'free' ? '⛶' : c.kind === 'buffer' ? '⛝' : '⛁'}</Text>
      <Text dimColor={c.kind !== 'used'}>{clip(categoryName(c, L), 28)}</Text>
      <Text dimColor>{compactNumber(c.tokens) + (c.kind === 'deferred' ? ' · ' + t(L, 'context.notCounted') : ' · ' + share(c.tokens, b.rawMaxTokens))}</Text>
    </Box>
  ))
  const sections = sectionsOf(b, view.place, L).map(section => {
    const items = shownItems(section, view.open)
    const hidden = section.items.length - Math.min(section.items.length, CONTEXT_SHOWN)
    return (
      <Box key={'section-' + section.key} flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text bold>{section.title}</Text>
          <Text dimColor>{section.count + ' · ' + compactNumber(section.tokens)}</Text>
        </Box>
        {items.map(item => (
          <Box key={'item-' + item.key} flexDirection="row" columnGap={1} paddingLeft={2}>
            <Text>{clip(item.name, Math.max(12, width - 30))}</Text>
            <Text dimColor>{item.meta + ' · ' + compactNumber(item.tokens)}</Text>
          </Box>
        ))}
        {hidden > 0 ? (
          <Box paddingLeft={2}>
            {textButton(el, 'context-more-' + section.key, view.open.includes(section.key) ? t(L, 'agents.less') : t(L, 'agents.more', { count: hidden }), () => actions.toggle(section.key))}
          </Box>
        ) : null}
      </Box>
    )
  })
  return (
    <Box flexDirection="column" rowGap={1} width="100%">
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text bold>{t(L, 'context.title')}</Text>
        <Text color={ctx === 'bad' ? tone.bad : ctx === 'warn' ? tone.warn : undefined}>{compactNumber(b.totalTokens) + ' ' + t(L, 'context.of', { max: compactNumber(b.rawMaxTokens) }) + ' (' + Math.round(b.percentage) + '%)'}</Text>
        <Text dimColor>{[displayText(b.model, DISPLAY.name), t(L, view.basis === 'full' ? 'context.precise' : 'context.estimate')].join(' · ')}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1}>
        <Box flexDirection="column">{grid}</Box>
        <Box flexDirection="column">{legend}</Box>
      </Box>
      {sections}
      <Box flexDirection="column">
        {footLines(b, L).map((line, i) => <Text key={'foot-' + i} dimColor wrap="wrap">{line}</Text>)}
        {error}
      </Box>
      {buttons}
    </Box>
  )
}

// ---- The pane ------------------------------------------------------------------------------------

/** The Context pane body: the breakdown drawn, or as text on the terminal. */
export function renderContext(el: Els, frame: Frame, view: ContextView, actions: ContextActions): RenderNode {
  return canDraw(el, frame) ? contextDrawn(el, frame, view, actions) : contextText(el, frame, view, actions)
}

/** The render boundary's last resort: the error in plain words and the way out, nothing to fail again. */
export function renderContextFallback(el: Els, frame: Frame, error: string, close: () => void): RenderNode {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="column" rowGap={1} width="100%">
      <Box flexDirection="row" columnGap={2}>
        <Text bold>{t(frame.lang, 'context.title')}</Text>
        <Button key="context-close" plain role="dismiss" label={t(frame.lang, 'settings.close')} onPress={() => close()} />
      </Box>
      <Text dimColor wrap="wrap">{displayText(error, DISPLAY.preview)}</Text>
    </Box>
  )
}
