// The prefix the router tells the parent to put on an Agent description must be one the mod strips
// again, whatever title shape the generator wrote, so a retitle replaces it and never stacks.
// Built from real syncAgentFiles() output, with and without an account and with and without effort.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS, type Config } from '../../packages/router/src/config.ts'
import { syncAgentFiles } from '../../packages/router/src/agents.ts'
import { storedAccountsFor } from '../../packages/router/src/pinned-accounts.ts'
import { saveClaudeOAuthAccount } from '../../packages/router/src/providers/anthropic-accounts.ts'
import { saveChatGptAccount, updateChatGptAccount } from '../../packages/router/src/providers/chatgpt/accounts.ts'
import { saveGoogleAccount, updateGoogleAccount } from '../../packages/router/src/providers/google/accounts.ts'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  const source = context.parentURL?.includes('/packages/mod/hooks/')
  return next(source && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { bareTitle, pinnedAccountNames, spawnTitle } = await import('../../packages/mod/hooks/workers.ts')

const grant = { accessToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 }

test('every prefix the generator writes is stripped, with and without account and effort', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-title-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dir = path.join(home, 'agents')
  const claude = saveClaudeOAuthAccount(home, { ...grant, accountId: 'claude-upstream', email: 'mambo20211@example.test' })
  const chatgpt = saveChatGptAccount(home, { ...grant, accountId: 'chatgpt-account' })
  updateChatGptAccount(home, chatgpt.id, { label: 'Work account' })
  const google = saveGoogleAccount(home, { ...grant, projectId: 'proj-1', email: 'g@example.test' })
  updateGoogleAccount(home, google.id, { label: '업무·개인' })
  const cfg: Config = {
    ...DEFAULTS,
    providers: {
      anthropic: { type: 'anthropic', auth: 'claude-code', accountPool: true, models: [
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', effortLevels: ['low', 'high'] },
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', effortLevels: [] },
        { id: 'claude-haiku-5-5', effortLevels: ['high'] },
      ] },
      chatgpt: { type: 'chatgpt', auth: 'own', models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', effortLevels: ['low', 'high'] },
        { id: 'gpt-6.1-luna', name: 'GPT-6.1 Luna', effortLevels: [] },
      ] },
      google: { type: 'google', auth: 'antigravity', models: [
        { id: 'gemini-4-argon', name: 'Gemini 4 Argon', effortLevels: ['high'] },
        { id: 'gemini-4-neon', name: 'Gemini 4 Neon', effortLevels: [] },
      ] },
      deepseek: { type: 'anthropic-compatible', url: 'http://127.0.0.1:9', models: [
        { id: 'deepseek-v4.1-flash', effortLevels: ['high'] },
        { id: 'deepseek-v4.1-pro', effortLevels: [] },
      ] },
    },
    routes: {}, direct: [], aliases: {},
  }
  syncAgentFiles(cfg, dir, undefined, { manifestPath: path.join(home, 'generated-agents.json'), pinnedAccounts: (p) => storedAccountsFor(p, home) })
  const files = fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8'))
  const accounts = pinnedAccountNames(files)
  assert.deepEqual([...accounts].sort(), ['Work account', 'mambo20211', '업무·개인'].sort())

  const shapes = new Set<string>()
  let withAccount = 0, withEffort = 0, withoutEffort = 0
  for (const file of files) {
    const asked = /Start the Agent description with "([^"]+)"/.exec(file)![1]!
    const prefix = asked.replace('<level>', 'high')
    shapes.add(asked.replace(/^[^·\s]+/, 'T'))
    if (/^model: [^\s#]+#/m.test(file)) withAccount++
    if (asked.includes('<level>')) withEffort++; else withoutEffort++
    // What the parent writes when it follows the instruction.
    const written = prefix + 'Review parser'
    assert.equal(bareTitle(written, accounts), 'Review parser', `stripped: ${prefix}`)
    // What the mod then writes: one prefix, never two.
    const model = /^model: (\S+)$/m.exec(file)![1]!
    const retitled = spawnTitle(written, model, /@([a-z]+)$/.exec(model)?.[1], [], undefined, accounts)
    assert.equal(bareTitle(retitled, accounts), 'Review parser', `no stacking: ${retitled}`)
  }
  assert.ok(withAccount >= 6 && withEffort >= 6 && withoutEffort >= 6, `shapes covered: ${withAccount}/${withEffort}/${withoutEffort}`)
  // The bare "5.5" form (a Claude model named "Claude Opus 5.5") with its account is among them.
  assert.ok(files.some(f => /with "5\.5·mambo20211/.test(f)))
  assert.ok(files.some(f => /with "Luna·Work-account · "/.test(f)), 'ChatGPT worker with no effort levels')
  assert.ok(files.some(f => /with "Argon·업무-개인·<level> · "/.test(f)))
  assert.ok(files.some(f => /with "deepseek-v4\.1-flash·<level> · "/.test(f)))
  assert.ok(shapes.size >= 4)
})

test('a heading the parent wrote is not taken for a prefix', () => {
  const accounts = ['Work account', 'mambo20211']
  for (const heading of ['UI·UX · Review navigation', 'iOS·Android · Fix notifications', 'Fix·bug · x']) {
    assert.equal(bareTitle(heading, accounts), heading, heading)
  }
  // An account name does make a prefix; the same words without one do not.
  assert.equal(bareTitle('Sol·Work-account · Review', accounts), 'Review')
  assert.equal(bareTitle('Sol·Other · Review', accounts), 'Sol·Other · Review')
})
