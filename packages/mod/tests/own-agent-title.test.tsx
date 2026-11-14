// Dispatch through the real mods engine; no model calls, files or network leave these stubs.
//
// A worker the user wrote by hand (`~/.claude/agents/<name>.md` with its own `model:`) is not in
// generated-agents.json. Claude Code starts it on the model in its file and the router sends it
// there, so the task title has to name that model, not the parent's.
import { expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'
import { normalizeSettings } from '../hooks/settings'

const SPAWN: AgentSpawnInput = {
  tool_use_id: 'own-agent-title-test', subagentType: 'gpt-worker', prompt: 'Port the parser.',
  description: 'Port the parser', parentModel: 'claude-opus-5-5',
  provider: { plugin: 'engine', tier: 'core' }, background: false, fork: false,
}

const definition = (model: string | undefined, eol = '\n') =>
  ['---', 'name: gpt-worker', 'description: >-', '  A backend labourer.', ...(model ? [`model: ${model}`] : []), 'tools: Read, Edit', '---', 'Do the work.'].join(eol)

// The engine hands a path over in the host's form (backslashes and a drive on Windows).
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// `root` is the folder the session started in, where Claude Code read its agents; `cwd` is where
// it is now, after any `cd`.
function boundaries(on: On, files: Record<string, string>, session: { root?: string; cwd?: string } = {}) {
  mock.clock(on, { now: 1000000 })
  mock.env(on, { HOME: '/home/test' })
  on('state.get', { plugin: 'ripple', key: 'settings' }, () => ({ value: { value: normalizeSettings({ agentAuto: 'auto' }), version: 0 } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.register', ($, e) => ({ value: { agent: 'ripple:' + e.name } }))
  on('session.messages', () => ({ value: [] }))
  if (session.root) on('session.root', () => ({ value: session.root }))
  if (session.cwd) on('session.cwd', () => ({ value: session.cwd }))
  on('fs.read', ($, e) => ({ value: files[posix(e.path)] ?? (e.path.endsWith('generated-agents.json') ? JSON.stringify({ agents: [] }) : '{}') }))
  on('fs.exists', ($, e) => ({ value: posix(e.path) in files }))
  on('fs.write', () => ({ value: undefined }))
  on('http.fetch', ($, e) => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify(
    e.url.endsWith('/api/mod-options') ? { providers: [], agents: [], claudeEfforts: ['low', 'medium', 'high'] } : {},
  ) } }))
  const sent: AgentSpawnInput[] = []
  on('agent.spawn', ($, e) => { sent.push(e); return { model: e.model ?? SPAWN.parentModel, agentId: 'own-agent-id' } })
  return { sent }
}

const USER = '/home/test/.claude/agents/gpt-worker.md'
const PROJECT = '/work/app/.claude/agents/gpt-worker.md'

test('a hand-written worker is titled with the model in its definition, and its spawn is left alone', async ($, on) => {
  const { sent } = boundaries(on, { [USER]: definition('gpt-6.1-sol@high') })
  await $.agent.spawn(SPAWN)
  expect(sent[0]?.description).toBe('Sol·high · Port the parser')
  // Claude Code applies the definition's model itself; the mod only names it.
  expect(sent[0]?.model).toBe(undefined)
  expect(sent[0]?.prompt).toBe(SPAWN.prompt)
})

test('the title replaces a prefix the parent guessed', async ($, on) => {
  const { sent } = boundaries(on, { [USER]: definition('gpt-6.1-sol@high') })
  await $.agent.spawn({ ...SPAWN, description: 'Opus5.5 · Port the parser' })
  expect(sent[0]?.description).toBe('Sol·high · Port the parser')
})

test('a definition with CRLF line ends is read', async ($, on) => {
  const { sent } = boundaries(on, { [USER]: definition('gpt-6.1-sol@high', '\r\n') })
  await $.agent.spawn(SPAWN)
  expect(sent[0]?.description).toBe('Sol·high · Port the parser')
})

test("the project's definition decides before the user's", async ($, on) => {
  const { sent } = boundaries(on, { [USER]: definition('gpt-6.1-sol@high'), [PROJECT]: definition('gpt-6-astra@medium') }, { root: '/work/app' })
  await $.agent.spawn(SPAWN)
  expect(sent[0]?.description).toBe('Astra·medium · Port the parser')
})

test("a project definition that inherits is titled with the parent's model, not the user file's", async ($, on) => {
  const { sent } = boundaries(on, { [USER]: definition('gpt-6.1-sol@high'), [PROJECT]: definition('inherit') }, { root: '/work/app' })
  await $.agent.spawn(SPAWN)
  expect(sent[0]?.description).toBe('Opus5.5 · Port the parser')
})

// The session started in ~/bridge, whose .claude/agents holds astra-worker, then moved into a
// repository below it with `cd`. Claude Code still ran the agent from the start folder's
// definition; the title named the parent's Mythos 5.2 while it ran on gpt-6-astra (2026-11-14).
test("a session that moved with cd still titles a project agent from the folder it started in", async ($, on) => {
  const { sent } = boundaries(on, {
    '/home/test/bridge/.claude/agents/gpt-worker.md': definition('gpt-6-astra@high'),
    '/home/test/bridge/repo/.git': '',
  }, { root: '/home/test/bridge', cwd: '/home/test/bridge/repo' })
  await $.agent.spawn({ ...SPAWN, description: 'Astra·high · Port the parser' })
  expect(sent[0]?.description).toBe('Astra·high · Port the parser')
})

test("a project agent in a folder above the start folder is found, up to the repository's root", async ($, on) => {
  const { sent } = boundaries(on, { [PROJECT]: definition('gpt-6-astra@medium'), '/work/app/.git': '' }, { root: '/work/app/packages/core' })
  await $.agent.spawn(SPAWN)
  expect(sent[0]?.description).toBe('Astra·medium · Port the parser')
})

test("a definition above the repository's root is not the project's", async ($, on) => {
  const { sent } = boundaries(on, { '/work/.claude/agents/gpt-worker.md': definition('gpt-6-astra@medium'), '/work/app/.git': '' }, { root: '/work/app' })
  await $.agent.spawn(SPAWN)
  expect(sent[0]?.description).toBe('Opus5.5 · Port the parser')
})

test('an explicit model on the call names the title before the definition', async ($, on) => {
  const { sent } = boundaries(on, { [USER]: definition('gpt-6.1-sol@high') })
  await $.agent.spawn({ ...SPAWN, model: 'gpt-6-astra@max' })
  expect(sent[0]?.description).toBe('Astra·max · Port the parser')
})

for (const [name, files] of [['no definition', {}], ['a definition without a model', { [USER]: definition(undefined) }]] as const) {
  test(`an agent with ${name} keeps the parent's model in its title`, async ($, on) => {
    const { sent } = boundaries(on, files)
    await $.agent.spawn(SPAWN)
    expect(sent[0]?.description).toBe('Opus5.5 · Port the parser')
  })
}

// A worker pinned to a stored account has a qualified model id (provider#pin:model). The task
// title names the model and the account the dashboard shows, never the id or the pin.
test("a pinned worker's title names its model and account, not its qualified id", async ($, on) => {
  const pinned = ['---', 'name: claude-haiku-5-5-f952fac6', 'description: claude-haiku-5-5 via anthropic. Runs on mambo20211 (account f952fac6). Start it.', 'model: anthropic#f952fac6:claude-haiku-5-5@high', '---', 'Do the work.'].join('\n')
  const { sent } = boundaries(on, {
    '/home/test/.clauderipple/generated-agents.json': JSON.stringify({ agents: ['claude-haiku-5-5-f952fac6'] }),
    '/home/test/.claude/agents/claude-haiku-5-5-f952fac6.md': pinned,
  })
  await $.agent.spawn({ ...SPAWN, subagentType: 'claude-haiku-5-5-f952fac6' })
  expect(sent[0]?.description).toBe('Haiku5.5·mambo20211·high · Port the parser')
})

test("a pinned worker with no effort replaces the account-only prefix the router asked the parent to write", async ($, on) => {
  const pinned = ['---', 'name: claude-opus-5-5-f952fac6', 'description: claude-opus-5-5 via anthropic. Runs on mambo20211 (account f952fac6). Start it.', 'model: anthropic#f952fac6:claude-opus-5-5', '---', 'Do the work.'].join('\n')
  const { sent } = boundaries(on, {
    '/home/test/.clauderipple/generated-agents.json': JSON.stringify({ agents: ['claude-opus-5-5-f952fac6'] }),
    '/home/test/.claude/agents/claude-opus-5-5-f952fac6.md': pinned,
  })
  await $.agent.spawn({ ...SPAWN, subagentType: 'claude-opus-5-5-f952fac6', description: '5.5·mambo20211 · Port the parser' })
  expect(sent[0]?.description).toBe('Opus5.5·mambo20211 · Port the parser')
})
