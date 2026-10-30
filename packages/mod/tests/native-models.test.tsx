// Dispatch through the real mods engine; no model calls, files or network leave these stubs.
import { expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'
import { CLAUDE_WORKERS, normalizeSettings } from '../hooks/settings'

const SPAWN: AgentSpawnInput = {
  tool_use_id: 'native-model-test', subagentType: 'coder-agent', prompt: 'Inspect the code.',
  description: 'Inspect code', parentModel: 'claude-opus-4-6',
  provider: { plugin: 'engine', tier: 'core' }, background: false, fork: false,
}

function boundaries(on: On, options: { fileModel?: string; automatic?: string; disabled?: boolean } = {}) {
  mock.clock(on, { now: 1000000 })
  mock.env(on, { HOME: '/home/test' })
  const settings = normalizeSettings({
    agentAuto: 'auto', providers: options.disabled ? { anthropic: false } : {},
    ...(options.automatic ? { rules: { general: { mode: 'ladder', rungs: {
      standard: [{ target: { agent: 'general-purpose', model: options.automatic }, effort: 'high' }],
    } } } } : {}),
  })
  on('state.get', { plugin: 'ripple', key: 'settings' }, () => ({ value: { value: settings, version: 0 } }))
  const logs: string[] = []
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('agent.register', ($, e) => ({ value: { agent: 'ripple:' + e.name } }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', ($, e) => ({ value: e.path.endsWith('generated-agents.json')
    ? JSON.stringify({ agents: options.fileModel ? ['native-worker'] : [] })
    : e.path.endsWith('/native-worker.md')
      ? `---\nname: native-worker\ndescription: Executor via anthropic.\nmodel: ${options.fileModel}\n---\nExecute.`
      : '{}' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('http.fetch', ($, e) => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify(
    e.url.endsWith('/api/mod-options') ? { providers: [], agents: [], claudeEfforts: ['low', 'medium', 'high'] } : {},
  ) } }))
  const sent: AgentSpawnInput[] = []
  on('agent.spawn', ($, e) => { sent.push(e); return { model: e.model ?? SPAWN.parentModel, agentId: 'native-worker-id' } })
  return { sent, logs }
}

for (const worker of CLAUDE_WORKERS) {
  test(`automatic ${worker.target.model} dispatches the concrete worker id and logs it`, async ($, on) => {
    const { sent, logs } = boundaries(on, { automatic: worker.target.model })
    await $.agent.spawn({ ...SPAWN, subagentType: 'ripple:auto' })
    expect(sent[0]?.model).toBe(worker.model)
    expect(sent[0]?.description).toContain(worker.model.includes('fable') ? 'Fable5.1' : worker.model.includes('haiku') ? 'Haiku5.5' : worker.model.includes('sonnet') ? 'Sonnet5.5' : 'Opus5.5')
    const entry = JSON.parse(logs.find(line => line.startsWith('ClaudeRipple worker pick: '))!.slice('ClaudeRipple worker pick: '.length))
    expect(entry.model).toBe(sent[0]?.model)
  })
  test(`direct named agent resolves explicit ${worker.target.model} before dispatch and title`, async ($, on) => {
    const { sent } = boundaries(on)
    await $.agent.spawn({ ...SPAWN, model: worker.target.model })
    expect(sent[0]?.model).toBe(worker.model)
    expect(sent[0]?.description).not.toBe(SPAWN.description)
  })
  test(`generated agent-file alias ${worker.target.model} resolves without an explicit model`, async ($, on) => {
    const { sent } = boundaries(on, { fileModel: worker.target.model })
    await $.agent.spawn({ ...SPAWN, subagentType: 'native-worker' })
    expect(sent[0]?.model).toBe(worker.model)
  })
  test(`generated ${worker.target.model} alias keeps marker effort on the concrete id`, async ($, on) => {
    const { sent } = boundaries(on, { fileModel: `${worker.target.model}@medium` })
    await $.agent.spawn({ ...SPAWN, subagentType: 'native-worker', prompt: '[[ripple: native-worker@max]]\nInspect.' })
    expect(sent[0]?.model).toBe(`${worker.model}@max`)
    expect(sent[0]?.prompt).toBe('Inspect.')
  })
}

test('native explicit markers on auto dispatch a concrete id and are consumed', async ($, on) => {
  const { sent } = boundaries(on)
  await $.agent.spawn({ ...SPAWN, subagentType: 'ripple:auto', prompt: '[[ripple: sonnet@high]]\nModel reason: rule CLAUDE.md — use Sonnet for this step\nInspect.' })
  expect(sent[0]?.model).toBe('claude-sonnet-5-5')
  expect(sent[0]?.prompt).toBe('Inspect.')
})

for (const annotation of ['', '[1m]']) {
  test(`a direct native alias marker keeps ${annotation || 'default context'} and puts no effort suffix on the claude id`, async ($, on) => {
    const { sent } = boundaries(on)
    await $.agent.spawn({ ...SPAWN, model: `sonnet${annotation}`, prompt: '[[ripple: sonnet@high]]\nInspect.' })
    expect(sent[0]?.model).toBe(`claude-sonnet-5-5${annotation}`)
    expect(sent[0]?.prompt).toBe('Inspect.')
  })
}

test('automatic context-qualified alias preserves its context annotation', async ($, on) => {
  const { sent } = boundaries(on, { automatic: 'opus[1m]' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'ripple:auto' })
  expect(sent[0]?.model).toBe('claude-opus-5-5[1m]')
})

for (const model of [undefined, 'inherit', 'claude-opus-4-6', 'claude-opus-4-6[1m]@high', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'custom-model', 'gpt-6.1-sol@high']) {
  test(`direct selection ${model} is preserved`, async ($, on) => {
    const { sent } = boundaries(on)
    await $.agent.spawn({ ...SPAWN, ...(model ? { model } : {}) })
    expect(sent[0]?.model).toBe(model)
  })
}

test('routed generated workers keep their own model despite a Claude alias override', async ($, on) => {
  const { sent } = boundaries(on, { fileModel: 'gpt-6.1-sol@medium' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'native-worker', model: 'sonnet', prompt: '[[ripple: native-worker@max]]\nInspect.' })
  expect(sent[0]?.model).toBe('gpt-6.1-sol@max')
  expect(sent[0]?.prompt).toBe('Inspect.')
})

for (const guard of [{ fork: true }, { workflow: { runId: 'wf_test', agentIndex: 1 } }, { resume: { agentId: 'resumed' } }, { isTeammate: true as const }, { subagentType: 'Explore' }, { subagentType: 'Plan' }, { subagentType: 'my-plugin:reviewer' }]) {
  test(`engine-owned spawn ${'subagentType' in guard ? guard.subagentType : Object.keys(guard)[0]} keeps its model`, async ($, on) => {
    const { sent } = boundaries(on)
    await $.agent.spawn({ ...SPAWN, ...guard, model: 'sonnet' })
    expect(sent[0]?.model).toBe('sonnet')
  })
}

test('native normalization does not bypass provider-disable refusal', async ($, on) => {
  const { sent } = boundaries(on, { disabled: true })
  const result = await $.agent.spawn({ ...SPAWN, model: 'sonnet' })
  expect('deny' in result).toBe(true)
  expect(sent.length).toBe(0)
})
