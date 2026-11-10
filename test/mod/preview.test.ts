import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const scene = { name: 'band', columns: 94, tree: { type: 'Text', text: 'preview' } }

for (const scenario of [
  { name: 'successful scenes', status: 0, scenes: [scene], exit: 0 },
  { name: 'partial scene failure', status: 1, scenes: [scene], exit: 1 },
  { name: 'total scene failure', status: 1, scenes: [], exit: 1 },
  { name: 'no scenes despite a successful command', status: 0, scenes: [], exit: 1 },
  { name: 'command launch failure', status: null, scenes: [], exit: 1 },
]) {
  test('preview cleans up and reports ' + scenario.name, () => {
    const root = mkdtempSync(join(tmpdir(), 'cr-preview-test-'))
    try {
      const mod = join(root, 'mod')
      const preview = join(mod, 'preview')
      const temp = join(root, 'temp')
      mkdirSync(preview, { recursive: true })
      mkdirSync(temp)
      for (const part of ['hooks', 'types', '.claude-plugin', 'tsconfig.json', 'preview/render.mjs', 'preview/scenes.tsx', 'preview/page.js']) {
        cpSync(new URL('../../packages/mod/' + part, import.meta.url), join(mod, part), { recursive: true })
      }
      // Replace the child command in a separate Node process: never run the real CLI.
      const source = `
        import assert from 'node:assert/strict'
        import childProcess from 'node:child_process'
        import os from 'node:os'
        import { existsSync, writeFileSync } from 'node:fs'
        import { join } from 'node:path'
        import { syncBuiltinESMExports } from 'node:module'
        import { pathToFileURL } from 'node:url'
        os.tmpdir = () => ${JSON.stringify(temp)}
        childProcess.spawnSync = (command, args) => {
          assert.equal(command, 'claude')
          assert.deepEqual(args.slice(0, 2), ['plugin', 'test'])
          assert.ok(existsSync(join(args[2], 'tests', 'scenes.test.tsx')))
          writeFileSync(${JSON.stringify(join(root, 'work-path'))}, args[2])
          return ${JSON.stringify({ status: scenario.status, stdout: scenario.scenes.map(value => '@@SCENE ' + JSON.stringify(value) + '\n').join(''), stderr: scenario.exit ? 'fixture failure diagnostic' : '' })}
        }
        syncBuiltinESMExports()
        await import(pathToFileURL(${JSON.stringify(join(preview, 'render.mjs'))}).href)
      `
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 30_000 })
      assert.ifError(run.error)
      assert.equal(run.signal, null)
      const work = readFileSync(join(root, 'work-path'), 'utf8')
      assert.equal(existsSync(work), false, 'temporary mod must be removed before exit')
      assert.deepEqual(readdirSync(temp), [], 'no temporary mod is left behind')
      assert.equal(run.status, scenario.exit, run.stderr)
      const file = join(preview, 'out', 'index.html')
      assert.equal(existsSync(file), scenario.scenes.length > 0, 'only collected scenes produce a preview')
      if (scenario.scenes.length) {
        assert.ok(readFileSync(file, 'utf8').includes('window.SCENES = ' + JSON.stringify(scenario.scenes)))
        assert.ok(run.stdout.includes(file + '  (1 scenes)'))
      } else {
        assert.equal(run.stdout, '')
      }
      if (scenario.exit) assert.ok(run.stderr.includes('fixture failure diagnostic'))
      else assert.equal(run.stderr, '')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
