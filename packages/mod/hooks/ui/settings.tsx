// The settings panel, drawn in the band: a header with the name and one tab per card, the
// open card, and a footer with Save / Close. Every change goes to a draft; Save keeps it, Close
// drops it. One card at a time keeps the panel inside the band's rows at any terminal size.

import type { RenderNode } from 'claude-code'

import type { Effort, Settings, Tier } from '../../types'
import { action, chip, segmented, toggle } from './parts'
import type { Els } from './parts'
import { TIER_HUE, esc, svgDoc, textTone, textWidth, v } from './theme'
import type { Frame, SettingsActions, SettingsTab, SettingsView } from './view'
import { EFFORTS, TIERS, effortName, isRich, targetOf, targetValue } from './view'

export const TABS: readonly { value: SettingsTab; label: string; hotkey: string; blurb: string }[] = [
  { value: 'effort', label: 'Effort', hotkey: 'e', blurb: 'How Auto picks the effort for each prompt you send.' },
  { value: 'workers', label: 'Workers', hotkey: 'w', blurb: 'Which agent runs each kind of delegated task.' },
  { value: 'judge', label: 'Judge', hotkey: 'j', blurb: 'Who decides: effort for prompts, tier for tasks.' },
  { value: 'cache', label: 'Cache', hotkey: 'c', blurb: 'Keep the prompt cache warm while you step away.' },
  { value: 'handoff', label: 'Compact & Handoff', hotkey: 'h', blurb: 'How a heavy chat is compacted or handed to a fresh one.' },
  { value: 'look', label: 'Look', hotkey: 'l', blurb: 'What the band shows and how.' },
]

export const TIER_INFO: Record<Tier, { label: string; blurb: string }> = {
  light: { label: 'Light', blurb: 'chores, repetition, lookups' },
  standard: { label: 'Standard', blurb: 'designed builds, research, review' },
  deep: { label: 'Deep', blurb: 'careful, high-stakes, hard reasoning' },
  design: { label: 'Design', blurb: 'UI, visual, brand' },
}

const LABEL_W = 15

/** A labelled row: label column, the control, an optional quiet hint. */
export function row(el: Els, key: string, label: string, control: RenderNode, hint?: string): RenderNode {
  const { Box, Text } = el
  return (
    <Box key={'row-' + key} flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
      <Box width={LABEL_W} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      {control}
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  )
}

/** A Select, or on a surface without one (mobile) the value as text. */
export function picker(el: Els, key: string, options: readonly { value: string; label?: string }[], value: string, onSelect: (value: string) => void): RenderNode {
  if (!('Select' in el)) {
    const { Text } = el
    return <Text>{options.find(o => o.value === value)?.label ?? value}</Text>
  }
  const { Select } = el
  const list = options.some(o => o.value === value) ? options : [{ value, label: value }, ...options]
  return <Select key={key} options={list} value={value} onSelect={(picked: string) => onSelect(picked)} />
}

/** A tier's name with its hue: a dot and the name. */
export function tierTag(el: Els, frame: Frame, tier: Tier): RenderNode {
  const label = TIER_INFO[tier].label
  if (isRich(frame) && 'Svg' in el) {
    const w = 18 + textWidth(label, 11.5, 'bold') + 10
    const ht = 20
    const body =
      '<rect x="0.5" y="0.5" width="' + (w - 1) + '" height="' + (ht - 1) + '" rx="10" fill="' + TIER_HUE[tier] + '" fill-opacity="0.12" stroke="' + TIER_HUE[tier] + '" stroke-opacity="0.45"/>' +
      '<circle cx="10" cy="10" r="3.2" fill="' + TIER_HUE[tier] + '"/>' +
      '<text x="18" y="14" style="font-size:11.5px;font-weight:600;fill:' + TIER_HUE[tier] + '">' + esc(label) + '</text>'
    return chip(el, { key: 'tier-' + tier, source: svgDoc(Math.ceil(w), ht, frame.appearance, body), alt: label + ' tier', width: Math.ceil(w), height: ht })
  }
  const { Text } = el
  return <Text color={TIER_HUE[tier]}>{'● ' + label}</Text>
}

// ---- The bias slider ---------------------------------------------------------------------------

const BIAS: readonly Settings['bias'][] = [-2, -1, 0, 1, 2]

function biasSlider(el: Els, frame: Frame, bias: Settings['bias'], onPick: (bias: Settings['bias']) => void): RenderNode {
  const { Box, Text } = el
  if (!isRich(frame) || !('Svg' in el)) {
    return segmented(
      el,
      frame,
      'bias',
      BIAS.map(b => ({ value: String(b), label: b > 0 ? '+' + b : b < 0 ? '−' + -b : '0' })),
      String(bias),
      picked => onPick(Number(picked) as Settings['bias']),
    )
  }
  // Five adjacent stops, each its own pressable picture of its stretch of the track.
  const w = 34
  const ht = 24
  const stops = BIAS.map((b, i) => {
    const on = b === bias
    const passed = (b <= bias && b >= 0 && bias > 0) || (b >= bias && b <= 0 && bias < 0)
    const y = ht / 2
    const left = i === 0 ? w / 2 : 0
    const right = i === BIAS.length - 1 ? w / 2 : w
    let body = '<line x1="' + left + '" y1="' + y + '" x2="' + right + '" y2="' + y + '" stroke="' + v('faint') + '" stroke-width="2"/>'
    if (passed && b !== 0) {
      const toward = b > 0 ? 0 : w
      body += '<line x1="' + toward + '" y1="' + y + '" x2="' + w / 2 + '" y2="' + y + '" stroke="' + v('accent') + '" stroke-width="2"/>'
    }
    if (passed && b === 0 && bias !== 0) {
      body += '<line x1="' + w / 2 + '" y1="' + y + '" x2="' + (bias > 0 ? w : 0) + '" y2="' + y + '" stroke="' + v('accent') + '" stroke-width="2"/>'
    }
    body += on
      ? '<circle cx="' + w / 2 + '" cy="' + y + '" r="7" fill="' + v('primary') + '"/><circle cx="' + w / 2 + '" cy="' + y + '" r="2.6" fill="#fff"/>'
      : '<circle cx="' + w / 2 + '" cy="' + y + '" r="' + (b === 0 ? 3.6 : 3) + '" fill="' + (passed ? v('accent') : v('faint')) + '"/>'
    return chip(el, {
      key: 'bias-' + b,
      source: svgDoc(w, ht, frame.appearance, body),
      alt: 'Bias ' + (b > 0 ? '+' + b : String(b)) + (on ? ' (selected)' : ''),
      width: w,
      height: ht,
      onPress: () => onPick(b),
    })
  })
  return (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      <Text dimColor>Cheaper</Text>
      <Box flexDirection="row">{stops}</Box>
      <Text dimColor>Smarter</Text>
    </Box>
  )
}

// ---- Cards -------------------------------------------------------------------------------------

const EFFORT_OPTIONS = EFFORTS.map((e: Effort) => ({ value: e, label: effortName(e) }))

export function effortCard(el: Els, frame: Frame, d: Settings, a: SettingsActions): RenderNode[] {
  return [
    row(el, 'auto', 'Auto', toggle(el, frame, 'set-auto', d.effortAuto ? 'On' : 'Off', d.effortAuto, () => a.patch({ effortAuto: !d.effortAuto })), 'picks per prompt; your own pick turns it off'),
    row(el, 'bias', 'Lean', biasSlider(el, frame, d.bias, bias => a.patch({ bias })), 'tips close calls only'),
    row(el, 'floor', 'Never below', picker(el, 'floor', EFFORT_OPTIONS, d.floor, floor => a.patch({ floor: floor as Effort }))),
    row(el, 'ceiling', 'Never above', picker(el, 'ceiling', EFFORT_OPTIONS, d.ceiling, ceiling => a.patch({ ceiling: ceiling as Effort })), EFFORTS.indexOf(d.ceiling) < EFFORTS.indexOf(d.floor) ? 'below the floor: the floor wins' : undefined),
  ]
}

export function workersCard(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode[] {
  const d = view.draft
  const options = view.agents.map(o => ({ value: o.value, label: o.label + (o.available ? '' : ' (unavailable)') }))
  const out: RenderNode[] = [
    row(
      el,
      'agent-auto',
      'Takes over',
      segmented(
        el,
        frame,
        'agent-auto',
        [
          { value: 'off', label: 'Off' },
          { value: 'auto', label: 'ripple:auto' },
          { value: 'all', label: 'All spawns' },
        ] as const,
        d.agentAuto,
        agentAuto => a.patch({ agentAuto }),
      ),
    ),
  ]
  for (const tier of TIERS) {
    const { Box, Text } = el
    out.push(
      <Box key={'row-tier-' + tier} flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
        <Box width={LABEL_W} flexShrink={0}>
          {tierTag(el, frame, tier)}
        </Box>
        {picker(el, 'tier-' + tier, options, targetValue(d.tiers[tier]), value => a.setTier(tier, targetOf(value)))}
        <Text dimColor>{TIER_INFO[tier].blurb}</Text>
      </Box>,
    )
  }
  out.push(row(el, 'fallback', 'Fallback', picker(el, 'fallback', options, targetValue(d.fallback), value => a.setFallback(targetOf(value))), 'when a tier’s provider is out of quota'))
  return out
}

export function judgeCard(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode[] {
  const d = view.draft
  const tone = textTone(frame.appearance)
  const { Box, Text } = el
  const out: RenderNode[] = [
    row(
      el,
      'judge',
      'Judge',
      segmented(
        el,
        frame,
        'judge',
        [
          { value: 'haiku', label: 'Haiku' },
          { value: 'jev', label: 'Jev' },
          { value: 'model', label: 'Router model' },
        ] as const,
        d.judge,
        judge => a.patch({ judge }),
      ),
    ),
  ]
  if (d.judge === 'haiku') out.push(row(el, 'haiku', '', <Text dimColor>Haiku 5.5 on your Claude login · about a second a prompt</Text>))
  if (d.judge === 'jev') {
    const jev = view.jev
    const placeholder =
      jev.source === 'env' ? 'from TYPESAFE_API_KEY' : jev.source === 'file' ? 'saved in ~/.config/jev/.env' : jev.source === 'pasted' ? 'saved' : 'paste a TypeSafe API key'
    const field =
      'Input' in el ? (
        <el.Input key="jev-key" placeholder={placeholder} value="" submitLabel="save" onSubmit={(key: string) => a.jevKey(key)} />
      ) : (
        <Text dimColor>{placeholder}</Text>
      )
    const result =
      jev.test.state === 'testing' ? (
        <Text dimColor>Testing…</Text>
      ) : jev.test.state === 'ok' ? (
        <Text color={tone.ok}>{'✓ ' + (jev.test.message ?? 'Key works')}</Text>
      ) : jev.test.state === 'fail' ? (
        <Text color={tone.bad}>{'✕ ' + (jev.test.message ?? 'Key rejected')}</Text>
      ) : null
    out.push(
      row(
        el,
        'jev-key',
        'Key',
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {field}
          {action(el, frame, 'jev-test', 'Test', a.testJev, { hotkey: 't' })}
          {result}
        </Box>,
      ),
    )
    out.push(row(el, 'jev-note', '', <Text color={tone.warn}>▲ Prompts sent to Jev leave this machine for TypeSafe (api.typesafe.ai).</Text>))
  }
  if (d.judge === 'model') {
    const models = view.routerModels.map(m => ({ value: m, label: m }))
    out.push(row(el, 'judge-model', 'Model', models.length ? picker(el, 'judge-model', models, d.judgeModel, judgeModel => a.patch({ judgeModel })) : <Text dimColor>no router models listed</Text>, 'falls back to Haiku'))
  }
  return out
}

export function cacheCard(el: Els, frame: Frame, d: Settings, a: SettingsActions): RenderNode[] {
  const { Text } = el
  return [
    row(el, 'warm', 'Keep warm', toggle(el, frame, 'set-warm', d.keepWarm ? 'On' : 'Off', d.keepWarm, () => a.patch({ keepWarm: !d.keepWarm })), 'pings the cache just before it expires'),
    row(
      el,
      'warm-hours',
      'For',
      segmented(el, frame, 'warm-hours', ([1, 2, 4, 8] as const).map(n => ({ value: String(n), label: n + 'h' })), String(d.keepWarmHours), ht => a.patch({ keepWarmHours: Number(ht) as Settings['keepWarmHours'] })),
      'after the last reply',
    ),
    row(
      el,
      'warm-min',
      'Chats from',
      segmented(el, frame, 'warm-min', [10_000, 30_000, 60_000, 100_000].map(n => ({ value: String(n), label: n / 1000 + 'k' })), String(d.keepWarmMinTokens), n => a.patch({ keepWarmMinTokens: Number(n) })),
      'tokens',
    ),
    row(el, 'warm-cost', '', <Text dimColor wrap="wrap">Each ping re-reads the whole chat from cache: about a tenth of its input price, and the same share of plan limits.</Text>),
  ]
}

function handoffCard(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode[] {
  const d = view.draft
  const skills = [{ value: '', label: 'None: a turn writes HANDOFF.md' }, ...view.skills.map(s => ({ value: s, label: s }))]
  return [
    row(el, 'compact-with', 'Compact with', segmented(el, frame, 'compact-with', [{ value: 'haiku', label: 'Haiku' }, { value: 'session', label: 'The session’s own' }] as const, d.compactWith, compactWith => a.patch({ compactWith }))),
    row(
      el,
      'handoff-after',
      'After handoff',
      segmented(el, frame, 'handoff-after', [{ value: 'continue', label: 'Continue' }, { value: 'confirm', label: 'Confirm first' }, { value: 'copy', label: 'Copy only' }] as const, d.handoffAfter, handoffAfter => a.patch({ handoffAfter })),
    ),
    row(
      el,
      'handoff-button',
      'Handoff button',
      segmented(el, frame, 'handoff-button', [{ value: 'advised', label: 'When advised' }, { value: 'always', label: 'Always' }] as const, d.handoffButton, handoffButton => a.patch({ handoffButton })),
    ),
    row(el, 'handoff-skill', 'Full handoff', picker(el, 'handoff-skill', skills, d.handoffSkill, handoffSkill => a.patch({ handoffSkill }))),
    row(
      el,
      'swamp-at',
      'Heavy at',
      segmented(el, frame, 'swamp-at', [40, 50, 60, 70].map(n => ({ value: String(n), label: n + '%' })), String(d.swampAt), n => a.patch({ swampAt: Number(n) })),
      'context',
    ),
  ]
}

const PARTS: readonly { value: string; label: string }[] = [
  { value: 'timer', label: 'Cache timer' },
  { value: 'reason', label: 'Reason' },
  { value: 'route', label: 'Route' },
  { value: 'limits', label: 'Limits' },
]

function lookCard(el: Els, frame: Frame, d: Settings, a: SettingsActions): RenderNode[] {
  const { Box } = el
  return [
    row(el, 'layout', 'Layout', segmented(el, frame, 'layout', [{ value: 'dashboard', label: 'Dashboard' }, { value: 'minimal', label: 'Minimal' }] as const, d.layout, layout => a.patch({ layout })), d.layout === 'minimal' ? 'one line in the footer' : undefined),
    row(el, 'appearance', 'Appearance', segmented(el, frame, 'appearance', [{ value: 'auto', label: 'Auto' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }] as const, d.appearance, appearance => a.patch({ appearance }))),
    row(
      el,
      'parts',
      'Show',
      <Box flexDirection="row" flexWrap="wrap" gap={isRich(frame) ? 1 : 0} columnGap={2}>
        {PARTS.map(p => {
          const shown = !d.hide.includes(p.value)
          return toggle(el, frame, 'show-' + p.value, p.label, shown, () => a.patch({ hide: shown ? [...d.hide, p.value] : d.hide.filter(ht => ht !== p.value) }))
        })}
      </Box>,
    ),
  ]
}

// ---- The panel ---------------------------------------------------------------------------------

/** The settings panel for the band; fits `frame.maxRows` by dropping the card's blurb first. */
export function renderSettings(el: Els, frame: Frame, view: SettingsView, actions: SettingsActions): RenderNode {
  const { Box, Text } = el
  const rich = isRich(frame)
  const tab = TABS.find(t => t.value === view.tab) ?? TABS[0]!
  const d = view.draft
  const body =
    view.tab === 'effort'
      ? effortCard(el, frame, d, actions)
      : view.tab === 'workers'
        ? workersCard(el, frame, view, actions)
        : view.tab === 'judge'
          ? judgeCard(el, frame, view, actions)
          : view.tab === 'cache'
            ? cacheCard(el, frame, d, actions)
            : view.tab === 'handoff'
              ? handoffCard(el, frame, view, actions)
              : lookCard(el, frame, d, actions)
  // Header + tabs, blurb, rows, footer: on the terminal tabs take their own row under ~110 columns.
  const tabsOwnRow = !rich && frame.columns < 110
  const rows = 1 + (tabsOwnRow ? 1 : 0) + 1 + body.length + 1
  const showBlurb = rows <= frame.maxRows
  const tabs = segmented(
    el,
    frame,
    'tab',
    TABS.map(t => ({ value: t.value, label: t.label, hotkey: t.hotkey })),
    view.tab,
    picked => actions.setTab(picked),
  )
  const tone = textTone(frame.appearance)
  const title = (
    <Box key="title" flexDirection="row" alignItems="center" columnGap={1}>
      <Text bold>ClaudeRipple</Text>
      <Text dimColor>settings</Text>
    </Box>
  )
  return (
    <Box flexDirection="column" rowGap={rich ? 1 : 0}>
      {tabsOwnRow ? (
        [title, <Box key="tabs">{tabs}</Box>]
      ) : (
        <Box key="head" flexDirection="row" alignItems="center" columnGap={3} flexWrap="wrap" rowGap={1}>
          {title}
          {tabs}
        </Box>
      )}
      {showBlurb ? (
        <Text dimColor>
          {tab.blurb}
        </Text>
      ) : null}
      <Box key="card" flexDirection="column" rowGap={rich ? 1 : 0} paddingLeft={rich ? 1 : 0}>
        {body}
      </Box>
      <Box key="foot" flexDirection="row" alignItems="center" columnGap={2} flexWrap="wrap" rowGap={1}>
        {action(el, frame, 'save', 'Save', actions.save, { hotkey: 's', primary: true })}
        {action(el, frame, 'close', view.dirty ? 'Discard' : 'Close', actions.close, { hotkey: 'x' })}
        {view.dirty ? <Text color={tone.accent}>● unsaved</Text> : null}
        <Text dimColor>ClaudeRipple is not affiliated with Anthropic.</Text>
      </Box>
    </Box>
  )
}
