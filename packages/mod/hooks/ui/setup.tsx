// First run: three short steps (who judges, which agent runs each worker tier, keep warm) and a
// done card. Shown once, in the band; every step can be changed later in settings.

import type { RenderNode } from 'claude-code'

import { action, chip } from './parts'
import type { Els } from './parts'
import { TIER_INFO, cacheCard, judgeCard, row, workersCard } from './settings'
import { svgDoc, textTone, v } from './theme'
import type { Frame, SettingsActions, SettingsView, SetupActions, SetupView } from './view'
import { TIERS, isRich, targetLabel } from './view'

const STEPS = [
  { title: 'Who decides', blurb: 'Ripple sets the reasoning effort of each prompt and picks the worker for each delegated task. A small, fast judge makes the call.' },
  { title: 'Who does the work', blurb: 'Delegated tasks come in four kinds. Each runs on the agent below; Ripple picks the kind and the effort.' },
  { title: 'Keep the cache warm?', blurb: 'An idle chat’s cache expires and the next prompt pays full price for the whole chat. Ripple can ping it while you are away.' },
] as const

function dots(el: Els, frame: Frame, step: number): RenderNode {
  const tone = textTone(frame.appearance)
  if (isRich(frame) && 'Svg' in el) {
    const w = 3 * 18
    let body = '<line x1="9" y1="7" x2="' + (w - 9) + '" y2="7" stroke="' + v('faint') + '" stroke-width="1.5"/>'
    for (let i = 0; i < 3; i++) {
      const cx = 9 + i * 18
      const done = i + 1 < step
      const now = i + 1 === step
      body += now
        ? '<circle cx="' + cx + '" cy="7" r="5.5" fill="none" stroke="' + v('accent') + '" stroke-width="1.5"/><circle cx="' + cx + '" cy="7" r="2.6" fill="' + v('accent') + '"/>'
        : '<circle cx="' + cx + '" cy="7" r="' + (done ? 3.4 : 3) + '" fill="' + (done ? v('accent') : v('faint')) + '"/>'
    }
    return chip(el, { key: 'steps', source: svgDoc(w, 14, frame.appearance, body), alt: 'Step ' + Math.min(step, 3) + ' of 3', width: w, height: 14 })
  }
  const { Text } = el
  return <Text color={tone.accent}>{[1, 2, 3].map(i => (i < step ? '●' : i === step ? '◉' : '○')).join(' ')}</Text>
}

/** The first-run setup in the band. */
export function renderSetup(el: Els, frame: Frame, view: SetupView, actions: SetupActions): RenderNode {
  const { Box, Text } = el
  const rich = isRich(frame)
  const tone = textTone(frame.appearance)
  // The settings cards draw the controls; setup lends them its draft and handlers.
  const asSettings: SettingsView = { tab: 'judge', draft: view.draft, dirty: false, agents: view.agents, routerModels: view.routerModels, skills: [], jev: view.jev }
  const noop = () => undefined
  const asActions: SettingsActions = {
    setTab: noop,
    patch: actions.patch,
    setTier: actions.setTier,
    setFallback: noop,
    jevKey: actions.jevKey,
    testJev: actions.testJev,
    save: noop,
    close: noop,
  }
  const d = view.draft
  const done = view.step === 4
  const step = done ? null : STEPS[view.step - 1]!
  const body: RenderNode[] = done
    ? [
        row(el, 'sum-effort', 'Effort', <Text>{'Auto ' + (d.effortAuto ? 'on' : 'off') + ', judged by ' + (d.judge === 'haiku' ? 'Haiku' : d.judge === 'jev' ? 'Jev' : d.judgeModel)}</Text>),
        row(el, 'sum-workers', 'Workers', <Text wrap="wrap">{TIERS.map(t => TIER_INFO[t].label + ' → ' + targetLabel(d.tiers[t])).join(' · ')}</Text>),
        row(el, 'sum-cache', 'Cache', <Text>{d.keepWarm ? 'kept warm for ' + d.keepWarmHours + 'h after each reply' : 'not kept warm'}</Text>),
        <Text dimColor>
          {rich ? 'Change any of this from the ⚙ in the band, or with /ripple.' : 'Change any of this with s: ⚙ in the band, or /ripple.'}
        </Text>,
      ]
    : view.step === 1
      ? judgeCard(el, frame, asSettings, asActions)
      : view.step === 2
        ? workersCard(el, frame, asSettings, asActions).slice(1)
        : cacheCard(el, frame, view.draft, asActions)
  return (
    <Box flexDirection="column" rowGap={rich ? 1 : 0}>
      <Box key="head" flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
        <Text bold>{done ? 'ClaudeRipple is ready' : 'Welcome to ClaudeRipple'}</Text>
        {done ? null : <Text dimColor>{'· ' + step!.title}</Text>}
        <Box marginLeft={2}>{dots(el, frame, view.step)}</Box>
      </Box>
      {step ? (
        <Text dimColor wrap="wrap">
          {step.blurb}
        </Text>
      ) : null}
      <Box key="card" flexDirection="column" rowGap={rich ? 1 : 0} paddingLeft={rich ? 1 : 0}>
        {body}
      </Box>
      <Box key="foot" flexDirection="row" alignItems="center" columnGap={2} flexWrap="wrap" rowGap={1}>
        {done
          ? action(el, frame, 'finish', 'Start', actions.finish, { hotkey: 'g', primary: true })
          : action(el, frame, 'next', view.step === 3 ? 'Finish' : 'Next', actions.next, { hotkey: 'n', primary: true })}
        {view.step > 1 ? action(el, frame, 'back', 'Back', actions.back, { hotkey: 'b' }) : null}
        {done ? null : action(el, frame, 'skip', 'Skip setup', actions.skip, { hotkey: 'k' })}
        <Text dimColor>ClaudeRipple is not affiliated with Anthropic.</Text>
      </Box>
    </Box>
  )
}
