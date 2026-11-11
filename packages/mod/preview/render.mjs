#!/usr/bin/env node
// Draws the mod's desktop trees as a page, to look at a visual change before shipping it.
//
//   node packages/mod/preview/render.mjs [--only band,alert-cold] [--lang ko]
//
// 1. The trees come from the real renderers: the mod is copied to a temp folder, scenes.tsx goes in
//    as its only test, and `claude plugin test` runs it. Each scene's tree is printed and collected.
//    hooks/ is never touched.
// 2. The page maps each element to DOM the way the desktop app does (page.js), from the app's own
//    computed styles (an Effortless render of the band, 2026-10: 13 px anthropic-sans, 19 px lines,
//    a cell is 1ch = 7.917 px, a row 1lh, a gap row half of one, `round` borders 1 px with a 10 px
//    radius and 8 px of air above and below, plain Buttons 12/17 px with no padding). It is close,
//    not the app: check the result in the app before calling a change done.
//
// Writes preview/out/index.html and prints its path.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = join(here, '..')
const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf('--' + name)
  return at < 0 ? undefined : args[at + 1]
}

const work = mkdtempSync(join(tmpdir(), 'ripple-preview-'))
try {
  for (const part of ['hooks', 'types', '.claude-plugin', 'tsconfig.json']) cpSync(join(mod, part), join(work, part), { recursive: true })
  mkdirSync(join(work, 'tests'))
  let scenes = readFileSync(join(here, 'scenes.tsx'), 'utf8')
  scenes = scenes.replace("const LANG = 'ko'", "const LANG = '" + (flag('lang') ?? 'ko') + "'").replace('const ONLY: string[] = []', 'const ONLY: string[] = ' + JSON.stringify((flag('only') ?? '').split(',').filter(Boolean)))
  writeFileSync(join(work, 'tests', 'scenes.test.tsx'), scenes)
  const run = spawnSync('claude', ['plugin', 'test', work], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const out = (run.stdout ?? '') + (run.stderr ?? '')
  const found = [...out.matchAll(/@@SCENE (\{.*\})\s*$/gm)].map(m => JSON.parse(m[1]))
  if (!found.length || run.status !== 0) {
    process.stderr.write(out.slice(-4000) + '\n')
    process.exitCode = 1
  }
  if (found.length) {
    const page = readFileSync(join(here, 'page.js'), 'utf8')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ripple mod preview</title></head><body>
<script>window.SCENES = ${JSON.stringify(found).replace(/</g, '\\u003c')}</script>
<script>${page}</script></body></html>`
    mkdirSync(join(here, 'out'), { recursive: true })
    const file = join(here, 'out', 'index.html')
    writeFileSync(file, html)
    console.log(file + '  (' + found.length + ' scenes)')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
