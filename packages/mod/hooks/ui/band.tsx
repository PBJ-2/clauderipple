// The dashboard above the prompt, and its minimal form in the footer.
//
// Desktop: a row of SVG chips (effort ripple with the model, context ring, cache countdown, plan
// limit, the last route) and a row of controls; both wrap at narrow widths. Terminal: the same
// facts as text in rows packed to the band's width, controls as hotkey buttons.
//
// The cache chip counts down by itself (SMIL frames and a CSS drain), so the band needs no
// per-second redraw; markup that shows nothing new stays byte-identical between redraws.

import type { RenderChildren, RenderNode } from 'claude-code'

import type { Effort } from '../../types'
import { CHIP_H, WAVE_CSS, WAVE_PERIOD, chip, gauge, icon, meter, meterWave, pill, plate, text, textButton } from './parts'
import type { Els } from './parts'
import { clip, contextTone, esc, limitTone, providerColor, cacheTone, svgDoc, textTone, textWidth, v } from './theme'
import type { BandActions, DashboardView, Frame } from './view'
import { EFFORTS, compactNumber, countdown, effortIndex, effortName, isRich, limitName, resetsLabel } from './view'

const CAP_Y = 13.5
const VAL_Y = 27

// ---- Desktop chips -----------------------------------------------------------------------------

type Chip = { key: string; source: string; alt: string; width: number; live?: boolean; onPress?: () => void }

function effortChip(frame: Frame, view: DashboardView, onPress: () => void): Chip {
  const { level, mode, why } = view.effort
  const idx = effortIndex(level)
  const model = (view.model ?? 'Model').toUpperCase()
  const tag = mode === 'auto' || mode === 'deciding' ? 'AUTO' : mode === 'manual' ? 'MANUAL' : mode === 'paused' ? 'PAUSED' : 'AUTO OFF'
  const caption = model + ' · ' + tag
  const value =
    mode === 'deciding' ? 'Deciding…' : level ? effortName(level) : mode === 'paused' ? 'Paused' : mode === 'off' ? 'Off' : '—'
  const showWhy = mode === 'auto' && why && !view.hide.includes('reason')
  const whyText = showWhy ? clip(why!, 34) : ''
  const gx = 22
  const cy = CHIP_H / 2
  const tx = 44
  const valW = textWidth(value, 12.5, 'bold')
  const width = Math.ceil(tx + Math.max(textWidth(caption, 8.5) * 1.12, valW + (whyText ? 8 + textWidth(whyText, 11.5) : 0)) + 14)
  let glyph: string
  let css = ''
  let outline = ''
  if (mode === 'deciding') {
    const since = view.effort.since ?? frame.now
    const phase = ((frame.now - since) / 1000) % WAVE_PERIOD
    glyph = meterWave(gx, cy, phase)
    css = WAVE_CSS
    outline =
      '<rect class="glow" style="animation-delay:-' + phase.toFixed(2) + 's" x="1" y="1" width="' + (width - 2) + '" height="' + (CHIP_H - 2) +
      '" rx="8.5" fill="none" stroke="' + v('accent') + '" stroke-width="1.6"/>'
  } else {
    const quiet = mode === 'off' || mode === 'paused'
    glyph = meter(gx, cy, Math.max(0, idx), mode === 'auto' ? v('accent') : quiet ? v('muted') : v('ink'))
  }
  let body = plate(width, CHIP_H, mode === 'deciding') + outline + glyph
  body += text(tx, CAP_Y, 'cap', caption)
  body += text(tx, VAL_Y, 'val', value, mode === 'deciding' ? v('accent') : mode === 'off' || mode === 'paused' ? v('muted') : undefined)
  if (whyText) body += text(tx + valW + 8, VAL_Y, 'sub', whyText)
  const hint =
    mode === 'paused'
      ? 'Auto pauses on this model: effort changes there are not known to keep the cache.'
      : mode === 'off'
        ? 'Auto is off; the effort is yours.'
        : mode === 'deciding'
          ? 'The judge is picking the effort for this prompt.'
          : why ?? ''
  body += '<title>' + esc('Effort ' + value + (hint ? ' — ' + hint : '') + ' · Click to pick an effort') + '</title>'
  return {
    key: 'effort',
    source: svgDoc(width, CHIP_H, frame.appearance, body, css),
    alt: 'Effort ' + value + ' (' + tag.toLowerCase() + ')' + (whyText ? ': ' + whyText : ''),
    width,
    live: true,
    onPress,
  }
}

function contextChip(frame: Frame, view: DashboardView): Chip | null {
  const ctx = view.context
  if (!ctx) return null
  const t = contextTone(ctx.percent, view.swampAt)
  const paint = t === 'ink' ? v('ink') : v(t)
  const value = Math.round(ctx.percent) + '%'
  const sub = compactNumber(ctx.tokens)
  const tx = 38
  const valW = textWidth(value, 12.5, 'bold')
  const width = Math.ceil(tx + Math.max(textWidth('CONTEXT', 8.5) * 1.12, valW + 6 + textWidth(sub, 11.5)) + 14)
  const body =
    plate(width, CHIP_H, false) + gauge(20, CHIP_H / 2, 8.5, ctx.percent / 100, paint) +
    text(tx, CAP_Y, 'cap', 'CONTEXT') + text(tx, VAL_Y, 'val', value, t === 'ink' ? undefined : paint) +
    text(tx + valW + 6, VAL_Y, 'sub', sub)
  return { key: 'context', source: svgDoc(width, CHIP_H, frame.appearance, body), alt: 'Context ' + value + ' of ' + compactNumber(ctx.window) + ' (' + sub + ' tokens)', width }
}

/**
 * The cache countdown. Frames of text switch with SMIL `set` at each change of the shown value, and
 * the ring drains with a CSS animation, both timed from the drawing's load, so it keeps time with
 * no redraw; the last minute turns amber and zero reads "cold".
 */
function cacheChip(frame: Frame, view: DashboardView): Chip | null {
  if (view.hide.includes('timer')) return null
  const cache = view.cache
  const warm = view.warm
  const left = cache ? Math.max(0, cache.expiresAt - frame.now) : 0
  const leftS = Math.ceil(left / 1000)
  const caption = warm.on ? (warm.stopped ? 'CACHE · WARM STOPPED' : 'CACHE · WARM') : 'CACHE'
  const sub = warm.on && warm.pings > 0 ? '×' + warm.pings : ''
  const tx = 38
  const longest = cache ? countdown(left) : '—'
  const valW = Math.max(textWidth('0:00', 12.5, 'bold'), textWidth(longest, 12.5, 'bold'))
  const width = Math.ceil(tx + Math.max(textWidth(caption, 8.5) * 1.12, valW + (sub ? 6 + textWidth(sub, 11.5) : 0)) + 14)
  const cx = 20
  const cy = CHIP_H / 2
  const r = 8.5
  const c = 2 * Math.PI * r
  const ring = warm.on && !warm.stopped ? v('accent') : v('ink')
  let body = plate(width, CHIP_H, false)
  let css = ''
  body += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + v('faint') + '" stroke-width="2.6" opacity="0.55"/>'
  if (!cache) {
    body += text(tx, VAL_Y, 'val', '—', v('muted'))
  } else if (leftS <= 0) {
    body += icon('snow', cx - 7, cy - 7, v('muted')) + text(tx, VAL_Y, 'val', 'cold', v('muted'))
  } else {
    const frac = Math.min(1, left / cache.ttlMs)
    const start = (c * (1 - frac)).toFixed(2)
    css =
      '@keyframes drain{from{stroke-dashoffset:' + start + '}to{stroke-dashoffset:' + c.toFixed(2) + '}}' +
      '.drain{animation:drain ' + leftS + 's linear forwards}'
    const warnAt = Math.max(0, leftS - 60)
    body +=
      '<circle class="drain" cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + ring + '" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="' +
      c.toFixed(2) + ' ' + c.toFixed(2) + '" stroke-dashoffset="' + start + '" transform="rotate(-90 ' + cx + ' ' + cy + ')">' +
      (leftS > 60 ? '<set attributeName="stroke" to="' + v('warn') + '" begin="' + warnAt + 's"/>' : '') + '</circle>'
    // One <text> per shown value, each visible from its start to the next one's.
    let shown = countdown(left)
    let from = 0
    const frames: [number, number, string][] = []
    for (let t = 1; t <= leftS; t++) {
      const next = countdown(left - t * 1000)
      if (next !== shown) {
        frames.push([from, t, shown])
        shown = next
        from = t
      }
    }
    frames.push([from, -1, shown])
    for (const [a, b, label] of frames) {
      const cold = label === 'cold'
      const late = !cold && leftS - a <= 60
      const fill = cold ? v('muted') : late ? v('warn') : undefined
      body +=
        '<text x="' + tx + '" y="' + VAL_Y + '" class="val"' + (fill ? ' style="fill:' + fill + '"' : '') + ' visibility="' + (a === 0 ? 'visible' : 'hidden') + '">' + esc(label) +
        (a > 0 ? '<set attributeName="visibility" to="visible" begin="' + a + 's"/>' : '') +
        (b > 0 ? '<set attributeName="visibility" to="hidden" begin="' + b + 's"/>' : '') +
        '</text>'
    }
  }
  body += text(tx, CAP_Y, 'cap', caption, warm.on && !warm.stopped ? v('accent') : undefined)
  // Keep-warm's mark: a small flame inside the ring.
  if (warm.on && cache && leftS > 0) body += '<g transform="translate(' + (cx - 4.2) + ' ' + (cy - 4.6) + ') scale(0.6)">' + icon('flame', 0, 0, warm.stopped ? v('muted') : v('accent')) + '</g>'
  if (sub) body += text(tx + valW + 6, VAL_Y, 'sub', sub)
  const tip = cache
    ? 'Prompt cache ' + (leftS > 0 ? 'warm for ' + countdown(left) : 'expired') + (warm.on ? ' · keep-warm ' + (warm.stopped ? 'stopped: ' + warm.stopped : 'on, ' + warm.pings + ' pings') : '')
    : 'No reply yet'
  body += '<title>' + esc(tip) + '</title>'
  return {
    key: 'cache',
    source: svgDoc(width, CHIP_H, frame.appearance, body, css),
    alt: 'Cache ' + (cache ? (leftS > 0 ? countdown(left) + ' left' : 'cold') : 'unknown') + (warm.on ? ', keep warm on' + (sub ? ' ' + sub : '') : ''),
    width,
    live: true,
  }
}

function limitChip(frame: Frame, view: DashboardView): Chip | null {
  const limit = view.limit
  if (!limit || view.hide.includes('limits')) return null
  const t = limitTone(limit.percent)
  const paint = t === 'ink' ? v('ink') : v(t)
  const caption = limitName(limit.kind).toUpperCase() + ' LIMIT' + (limit.save ? ' · SAVE' : '')
  const value = Math.round(limit.percent) + '%'
  const resets = resetsLabel(limit.resetsAt, frame.now)
  const tx = 12
  const valW = textWidth(value, 12.5, 'bold')
  const barW = 34
  const subW = resets ? textWidth(resets, 11.5) + 8 : 0
  const width = Math.ceil(tx + Math.max(textWidth(caption, 8.5) * 1.12, valW + 8 + barW + subW) + 14)
  const bx = tx + valW + 8
  const fill = Math.max(2, (barW * Math.min(100, limit.percent)) / 100)
  const body =
    plate(width, CHIP_H, false) + text(tx, CAP_Y, 'cap', caption, limit.save ? v('accent') : undefined) + text(tx, VAL_Y, 'val', value, t === 'ink' ? undefined : paint) +
    '<rect x="' + bx + '" y="' + (VAL_Y - 6) + '" width="' + barW + '" height="4" rx="2" fill="' + v('faint') + '" opacity="0.6"/>' +
    '<rect x="' + bx + '" y="' + (VAL_Y - 6) + '" width="' + fill.toFixed(1) + '" height="4" rx="2" fill="' + paint + '"/>' +
    (resets ? text(bx + barW + 8, VAL_Y, 'sub', resets) : '')
  return { key: 'limit', source: svgDoc(width, CHIP_H, frame.appearance, body), alt: limitName(limit.kind) + ' limit ' + value + (resets ? ', ' + resets : ''), width }
}

function routeChip(frame: Frame, view: DashboardView, onPress: () => void): Chip | null {
  if (view.hide.includes('route')) return null
  const tx = 12
  if (!view.route) {
    if (!view.notice) return null
    const value = clip(view.notice.replace(/^ClaudeRipple:\s*/, ''), 52)
    const width = Math.ceil(tx + Math.max(textWidth('ROUTER', 8.5) * 1.12, textWidth(value, 12)) + 14)
    const body = plate(width, CHIP_H, false) + text(tx, CAP_Y, 'cap', 'ROUTER') + text(tx, VAL_Y, 'lbl', value, v('muted'))
    return { key: 'route', source: svgDoc(width, CHIP_H, frame.appearance, body), alt: 'Router: ' + value, width, onPress }
  }
  const r = view.route
  const caption = r.resent ? 'RESENT · ' + r.status : !r.ok ? 'FAILED · ' + r.status : 'LAST ROUTE'
  const model = clip(r.model, 30)
  let x = tx + 13
  let line = '<path d="M' + tx + ' ' + (VAL_Y - 9) + 'v5.5a2 2 0 0 0 2 2h6M' + (tx + 6.5) + ' ' + (VAL_Y - 4) + 'l2.6 2.5-2.6 2.5" fill="none" stroke="' + (r.ok ? v('muted') : r.resent ? v('muted') : v('bad')) + '" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
  line += text(x, VAL_Y, 'val', model, r.ok || r.resent ? undefined : v('bad'))
  x += textWidth(model, 12.5, 'bold') + 9
  const hue = providerColor(r.provider)
  line += '<circle cx="' + (x + 3) + '" cy="' + (VAL_Y - 4) + '" r="3.2" fill="' + hue + '"/>'
  x += 10
  line += '<text x="' + x + '" y="' + VAL_Y + '" class="sub" style="fill:' + hue + ';font-weight:600">' + esc(r.provider) + '</text>'
  x += textWidth(r.provider, 11.5, 'bold') + 8
  if (r.effort) {
    line += text(x, VAL_Y, 'sub', r.effort)
    x += textWidth(r.effort, 11.5) + 8
  }
  if (r.ok && r.cachePct !== undefined) {
    const label = r.cachePct + '%'
    line += text(x, VAL_Y, 'sub', label, v(cacheTone(r.cachePct)))
    x += textWidth(label, 11.5) + 8
  }
  const secs = r.seconds.toFixed(1) + 's'
  line += text(x, VAL_Y, 'sub', secs)
  x += textWidth(secs, 11.5)
  const width = Math.ceil(Math.max(x, tx + textWidth(caption, 8.5) * 1.12) + 14)
  const body =
    plate(width, CHIP_H, false) + text(tx, CAP_Y, 'cap', caption, !r.ok && !r.resent ? v('bad') : undefined) + line +
    '<title>' + esc((r.note ? r.note + ' · ' : '') + 'Click for the request log') + '</title>'
  const alt =
    'Last route: ' + r.model + ' via ' + r.provider + (r.effort ? ', ' + r.effort : '') + (r.cachePct !== undefined ? ', cache ' + r.cachePct + '%' : '') + ', ' + secs + (r.ok ? '' : ', ' + (r.resent ? 'resent ' : 'failed ') + r.status)
  return { key: 'route', source: svgDoc(width, CHIP_H, frame.appearance, body), alt, width, live: r.note !== undefined, onPress }
}

function drawChip(el: Els, c: Chip): RenderNode {
  const spec: Parameters<typeof chip>[1] = { key: c.key, source: c.source, alt: c.alt, width: c.width, height: CHIP_H }
  if (c.live) spec.live = true
  if (c.onPress) spec.onPress = c.onPress
  return chip(el, spec)
}

function effortMenuRich(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  const { Box } = el
  const current = view.effort.mode === 'manual' || view.effort.mode === 'off' ? view.effort.level : null
  return (
    <Box key="effort-menu" flexDirection="row" flexWrap="wrap" gap={1}>
      {pill(el, frame, { key: 'pick-auto', label: 'Auto', lit: view.auto, onPress: actions.toggleAuto, height: CHIP_H - 4, glyph: (x, y) => meter(x + 7, y + 7, 2, v('accent'), v('faint'), 0.75) })}
      {EFFORTS.map((effort, i) =>
        pill(el, frame, {
          key: 'pick-' + effort,
          label: effortName(effort),
          lit: current === effort,
          onPress: () => actions.pickEffort(effort),
          height: CHIP_H - 4,
          glyph: (x, y) => meter(x + 7, y + 7, i, current === effort ? v('accent') : v('ink'), v('faint'), 0.75),
        }),
      )}
    </Box>
  )
}

function controlsRich(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode[] {
  const ht = CHIP_H
  const handoff = view.handoff !== 'off'
  return [
    pill(el, frame, { key: 'auto', label: 'Auto', toggle: view.auto, onPress: actions.toggleAuto, height: ht, alt: 'Effort Auto ' + (view.auto ? 'on' : 'off') }),
    pill(el, frame, { key: 'warm', label: 'Warm', toggle: view.warm.on, onPress: actions.toggleWarm, height: ht, alt: 'Keep cache warm ' + (view.warm.on ? 'on' : 'off') }),
    handoff
      ? pill(el, frame, { key: 'handoff', label: 'Handoff', lit: view.handoff === 'advised', onPress: actions.handoff, height: ht, glyph: (x, y) => icon('handoff', x, y, view.handoff === 'advised' ? v('accent') : v('ink')), alt: view.handoff === 'advised' ? 'Handoff (advised: a fresh chat pays now)' : 'Handoff' })
      : pill(el, frame, { key: 'compact', label: 'Compact', onPress: actions.compact, height: ht, glyph: (x, y) => icon('compact', x, y, v('ink')) }),
    pill(el, frame, { key: 'log', label: 'Log', lit: view.logOpen, onPress: actions.toggleLog, height: ht, glyph: (x, y) => icon('log', x, y, view.logOpen ? v('accent') : v('ink')), alt: view.logOpen ? 'Close the request log' : 'Open the request log' }),
    pill(el, frame, (() => {
      const o: Parameters<typeof pill>[2] = { key: 'agents', label: 'Agents', lit: view.agentsOpen, onPress: actions.toggleAgents, height: ht, glyph: (x, y) => icon('agents', x, y, view.agentsOpen ? v('accent') : v('ink')), alt: 'Agents: ' + view.agents.live + ' running' }
      if (view.agents.live > 0) o.badge = String(view.agents.live)
      return o
    })()),
    pill(el, frame, { key: 'settings', label: '', onPress: actions.openSettings, height: ht, glyph: (x, y) => icon('gear', x, y, v('muted')), alt: 'Ripple settings' }),
  ]
}

function bandRich(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  const { Box } = el
  const chips = [
    effortChip(frame, view, actions.toggleEffortMenu),
    contextChip(frame, view),
    cacheChip(frame, view),
    limitChip(frame, view),
    routeChip(frame, view, actions.toggleLog),
  ].filter((c): c is Chip => c !== null)
  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" rowGap={1} columnGap={2}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {chips.map(c => drawChip(el, c))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {controlsRich(el, frame, view, actions)}
        </Box>
      </Box>
      {view.effortMenu ? effortMenuRich(el, frame, view, actions) : null}
    </Box>
  )
}

// ---- Terminal ----------------------------------------------------------------------------------

type Run = { text: string; color?: string; dim?: boolean; bold?: boolean }
type Segment = { key: string; runs: Run[] }

/** Growing ripples: low → max. */
const RIPPLE_CHAR = ['·', '∘', '○', '◎', '◉']

function width(seg: Segment): number {
  return seg.runs.reduce((n, r) => n + r.text.length, 0) + Math.max(0, seg.runs.length - 1)
}

function infoSegments(frame: Frame, view: DashboardView): Segment[] {
  const tone = textTone(frame.appearance)
  const segs: Segment[] = []
  const { level, mode, why } = view.effort
  const idx = effortIndex(level)
  const runs: Run[] = []
  if (mode === 'deciding') runs.push({ text: '◌ deciding…', color: tone.accent, bold: true })
  else if (mode === 'paused') runs.push({ text: '‖ ' + (level ?? 'paused'), dim: true }, { text: 'auto paused', dim: true })
  else if (mode === 'off') runs.push({ text: (idx >= 0 ? RIPPLE_CHAR[idx]! : '○') + ' ' + (level ?? 'off'), bold: true }, { text: 'auto off', dim: true })
  else runs.push({ text: (idx >= 0 ? RIPPLE_CHAR[idx]! : '○') + ' ' + (level ?? '—'), bold: true, color: mode === 'auto' ? tone.accent : undefined }, { text: mode === 'auto' ? 'auto' : 'manual', dim: true })
  if (view.model) runs.push({ text: '· ' + view.model, dim: true })
  segs.push({ key: 'effort', runs })
  if (mode === 'auto' && why && !view.hide.includes('reason')) segs.push({ key: 'why', runs: [{ text: '“' + clip(why, 30) + '”', dim: true }] })
  if (view.context) {
    const t = contextTone(view.context.percent, view.swampAt)
    const pct = view.context.percent
    const pie = pct >= 87.5 ? '●' : pct >= 62.5 ? '◕' : pct >= 37.5 ? '◑' : pct >= 12.5 ? '◔' : '○'
    segs.push({ key: 'context', runs: [{ text: pie + ' ' + Math.round(pct) + '%', color: t === 'ink' ? undefined : tone[t] }, { text: compactNumber(view.context.tokens), dim: true }] })
  }
  if (!view.hide.includes('timer')) {
    const left = view.cache ? view.cache.expiresAt - frame.now : 0
    const r: Run[] = [{ text: '⧗ ' + (view.cache ? countdown(left) : '—'), color: view.cache && left > 0 && left <= 60_000 ? tone.warn : undefined, dim: !view.cache || left <= 0 }]
    if (view.warm.on) r.push({ text: view.warm.stopped ? 'warm stopped' : '≈warm' + (view.warm.pings ? ' ×' + view.warm.pings : ''), color: view.warm.stopped ? undefined : tone.accent, dim: view.warm.stopped !== undefined })
    segs.push({ key: 'cache', runs: r })
  }
  if (view.limit && !view.hide.includes('limits')) {
    const t = limitTone(view.limit.percent)
    const r: Run[] = [{ text: limitName(view.limit.kind), dim: true }, { text: Math.round(view.limit.percent) + '%', color: t === 'ink' ? undefined : tone[t] }]
    if (view.limit.save) r.push({ text: 'save', color: tone.accent })
    segs.push({ key: 'limit', runs: r })
  }
  if (!view.hide.includes('route')) {
    const route = view.route
    if (route) {
      const r: Run[] = [
        route.resent ? { text: '↻', dim: true } : { text: route.ok ? '↳' : '✕', color: route.ok ? tone.ok : tone.bad },
        { text: clip(route.model, 34), bold: true },
        { text: route.provider, color: providerColor(route.provider) },
      ]
      if (route.effort) r.push({ text: route.effort, dim: true })
      if (!route.ok) r.push(route.resent ? { text: route.status + ' resent', dim: true } : { text: route.status, color: tone.bad })
      if (route.ok && route.cachePct !== undefined) r.push({ text: 'cache ' + route.cachePct + '%', color: tone[cacheTone(route.cachePct)] })
      r.push({ text: route.seconds.toFixed(1) + 's', dim: true })
      segs.push({ key: 'route', runs: r })
    } else if (view.notice) {
      segs.push({ key: 'route', runs: [{ text: view.notice, dim: true }] })
    }
  }
  return segs
}

type Control = { key: string; label: string; hotkey: string; onPress: () => void; primary?: boolean }

function controls(view: DashboardView, actions: BandActions): Control[] {
  const handoff = view.handoff !== 'off'
  return [
    { key: 'auto', label: 'Auto ' + (view.auto ? '●' : '○'), hotkey: 'a', onPress: actions.toggleAuto },
    { key: 'warm', label: 'Warm ' + (view.warm.on ? '●' : '○'), hotkey: 'w', onPress: actions.toggleWarm },
    handoff
      ? { key: 'handoff', label: view.handoff === 'advised' ? 'Handoff ◆' : 'Handoff', hotkey: 'h', onPress: actions.handoff }
      : { key: 'compact', label: 'Compact', hotkey: 'c', onPress: actions.compact },
    { key: 'log', label: view.logOpen ? 'Close log' : 'Log', hotkey: 'l', onPress: actions.toggleLog },
    { key: 'agents', label: 'Agents' + (view.agents.live ? ' ' + view.agents.live : ''), hotkey: 'g', onPress: actions.toggleAgents },
    { key: 'settings', label: '⚙', hotkey: 's', onPress: actions.openSettings },
  ]
}

/** Packs items of the given widths into rows no wider than `columns`, `gap` apart. */
export function pack<T>(items: readonly T[], widthOf: (item: T) => number, columns: number, gap: number): T[][] {
  const rows: T[][] = []
  let row: T[] = []
  let used = 0
  for (const item of items) {
    const w = widthOf(item)
    if (row.length > 0 && used + gap + w > columns) {
      rows.push(row)
      row = []
      used = 0
    }
    used += (row.length > 0 ? gap : 0) + w
    row.push(item)
  }
  if (row.length > 0) rows.push(row)
  return rows
}

function drawSegment(el: Els, seg: Segment): RenderNode {
  const { Box, Text } = el
  return (
    <Box key={'seg-' + seg.key} flexDirection="row" columnGap={1}>
      {seg.runs.map(run => (
        <Text color={run.color} dimColor={run.dim} bold={run.bold}>
          {run.text}
        </Text>
      ))}
    </Box>
  )
}

function bandText(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  const { Box } = el
  const cols = Math.max(20, frame.columns)
  let segs = infoSegments(frame, view)
  const ctrls = controls(view, actions)
  const ctrlWidth = (c: Control) => c.hotkey.length + 2 + c.label.length
  const layout = (s: Segment[]) => {
    // Wide: facts and controls share rows; otherwise controls get their own.
    const all: (Segment | Control)[] = [...s, ...ctrls]
    const together = pack(all, i => ('runs' in i ? width(i) : ctrlWidth(i)), cols, 2)
    const apart = [...pack(s, width, cols, 2), ...pack(ctrls, ctrlWidth, cols, 2)]
    return cols >= 120 && together.length === 1 ? together : apart
  }
  let rows = layout(segs)
  const budget = Math.max(1, frame.maxRows)
  // Too tall for the band: drop the quietest facts first.
  for (const drop of ['why', 'limit', 'cache', 'context']) {
    if (rows.length <= budget) break
    segs = segs.filter(s => s.key !== drop)
    rows = layout(segs)
  }
  const menu = view.effortMenu
    ? [
        textButton(el, 'pick-auto', 'Auto ' + (view.auto ? '●' : '○'), actions.toggleAuto, '0'),
        ...EFFORTS.map((effort: Effort, i) => textButton(el, 'pick-' + effort, RIPPLE_CHAR[i]! + ' ' + effort, () => actions.pickEffort(effort), String(i + 1))),
      ]
    : null
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={'row-' + i} flexDirection="row" columnGap={2}>
          {row.map(item => ('runs' in item ? drawSegment(el, item) : textButton(el, item.key, item.label, item.onPress, item.hotkey, item.primary)))}
        </Box>
      ))}
      {menu ? (
        <Box key="effort-menu" flexDirection="row" flexWrap="wrap" columnGap={2}>
          {menu}
        </Box>
      ) : null}
    </Box>
  )
}

/** The dashboard band. */
export function renderBand(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  return isRich(frame) ? bandRich(el, frame, view, actions) : bandText(el, frame, view, actions)
}

// ---- Minimal: the footer -----------------------------------------------------------------------

export type FooterActions = Pick<BandActions, 'toggleAuto' | 'openSettings'>

/**
 * The minimal layout: one quiet line in the footer's mode area (SessionMode), the engine's own
 * modes kept beside it. `engine` is what `next(e)` drew there.
 */
export function renderFooter(el: Els, frame: Frame, view: DashboardView, actions: FooterActions, engine?: RenderChildren): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const { level, mode } = view.effort
  const idx = effortIndex(level)
  const effortText =
    mode === 'deciding' ? '◌ deciding…' : (idx >= 0 ? RIPPLE_CHAR[idx]! : '○') + ' ' + (level ?? '—') + (mode === 'auto' ? '' : mode === 'paused' ? ' (paused)' : mode === 'off' ? ' (auto off)' : ' (manual)')
  const left = view.cache ? view.cache.expiresAt - frame.now : 0
  return (
    <Box flexDirection="row" columnGap={2} alignItems="center">
      <Text color={mode === 'deciding' || mode === 'auto' ? tone.accent : undefined} dimColor={mode === 'paused' || mode === 'off'}>
        {effortText}
      </Text>
      {view.context ? (
        <Text dimColor color={contextTone(view.context.percent, view.swampAt) === 'ink' ? undefined : tone[contextTone(view.context.percent, view.swampAt) as 'warn' | 'bad']}>
          {'ctx ' + Math.round(view.context.percent) + '%'}
        </Text>
      ) : null}
      {view.cache && !view.hide.includes('timer') ? <Text dimColor>{'⧗ ' + countdown(left) + (view.warm.on ? ' ≈' : '')}</Text> : null}
      {view.limit && !view.hide.includes('limits') ? <Text dimColor>{limitName(view.limit.kind) + ' ' + Math.round(view.limit.percent) + '%'}</Text> : null}
      {textButton(el, 'auto', view.auto ? 'Auto ●' : 'Auto ○', actions.toggleAuto)}
      {textButton(el, 'settings', '⚙', actions.openSettings)}
      {engine ?? null}
    </Box>
  )
}
