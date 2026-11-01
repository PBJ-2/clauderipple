import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TASKS_KEPT, addTask, endTasks, endWithAgent, exitCode, settleTasks, settleWithAgent, taskEnds, taskStarted } from '../../packages/mod/hooks/tasks.ts'
import type { BgTask } from '../../packages/mod/types/index.d.ts'

const shell: BgTask = { id: 'b1', kind: 'shell', title: 'Start the dev server', command: 'npm run dev', state: 'running', startedAt: 1 }

test('a backgrounded call starts a task; a call that answered in the foreground starts none', () => {
  assert.deepEqual(taskStarted('Bash', { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }, { stdout: '', backgroundTaskId: 'b1' }, undefined, 1), shell)
  assert.equal(taskStarted('Bash', { command: 'ls' }, { stdout: 'a' }, undefined, 1), undefined)
  // A subagent's command bound to its final response says so; a watch takes its socket when it has no command.
  assert.deepEqual(taskStarted('Bash', { command: 'sleep 9' }, { backgroundTaskId: 'b2', backgroundEndsWithFinalResponse: true }, 'worker', 5), { id: 'b2', kind: 'shell', title: 'sleep 9', command: 'sleep 9', agentId: 'worker', endsWithAgent: true, state: 'running', startedAt: 5 })
  assert.deepEqual(taskStarted('Monitor', { description: 'Watch the feed', ws: { url: 'wss://feed' }, timeout_ms: 1 }, { taskId: 'm1', timeoutMs: 1 }, undefined, 2), { id: 'm1', kind: 'monitor', title: 'Watch the feed', command: 'wss://feed', state: 'running', startedAt: 2 })
  assert.equal(taskStarted('Read', { file_path: '/a' }, { backgroundTaskId: 'x' }, undefined, 1), undefined)
})

test('a notification as Claude Code 2.1.308 words it ends its task; an event without a status ends nothing', () => {
  // The notice of 2026-10-24, as this session received it.
  const text = '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>/tmp/b1.output</output-file>\n<status>completed</status>\n<summary>Background command "Start the dev server" completed (exit code 0)</summary>\n</task-notification>'
  assert.deepEqual(taskEnds(text), [{ id: 'b1', status: 'completed', summary: 'Background command "Start the dev server" completed (exit code 0)' }])
  assert.deepEqual(taskEnds('<task-notification><task-id>m1</task-id><event>line</event></task-notification>'), [])
  assert.deepEqual(endTasks([shell], taskEnds(text), 9), [{ ...shell, state: 'done', endedAt: 9, summary: 'Background command "Start the dev server" completed (exit code 0)' }])
  assert.equal(endTasks([shell], [{ id: 'b1', status: 'running' }], 9)[0], shell)
  assert.equal(exitCode('Background command "npm test" failed with exit code 2'), 2)
  assert.equal(exitCode(undefined), undefined)
})

test('a Stop settles what it no longer holds until the late notice says how; a stopped task keeps how', () => {
  const settled = settleTasks([shell], [], 7)
  assert.deepEqual(settled, [{ ...shell, state: 'done', endedAt: 7, settled: true }])
  assert.deepEqual(settleTasks([shell], ['b1'], 7), [shell])
  assert.deepEqual(endTasks(settled, [{ id: 'b1', status: 'failed' }], 9), [{ ...shell, state: 'failed', endedAt: 7 }])
  const stopped: BgTask = { ...shell, state: 'stopped', endedAt: 3 }
  assert.deepEqual(endTasks([stopped], [{ id: 'b1', status: 'killed' }], 9), [stopped])
  const bound: BgTask = { ...shell, id: 'b2', agentId: 'worker', endsWithAgent: true }
  assert.deepEqual(endWithAgent([shell, bound], 'worker', 4), [shell, { ...bound, state: 'stopped', endedAt: 4 }])
})

test("a worker's command leaves the running list with its worker, as the Claude app's does", () => {
  const left: BgTask = { ...shell, id: 'b3', agentId: 'worker' }
  // Listed, but its worker is not: settled, as a Stop of 2026-11-01 should have.
  assert.deepEqual(settleTasks([shell, left], ['b1', 'b3'], 7), [shell, { ...left, state: 'done', endedAt: 7, settled: true }])
  assert.deepEqual(settleTasks([left], ['b3', 'worker'], 7), [left])
  // The worker's own end settles every command it left running; a later notice still says how.
  const ended = settleWithAgent([shell, left], 'worker', 5)
  assert.deepEqual(ended, [shell, { ...left, state: 'done', endedAt: 5, settled: true }])
  assert.deepEqual(endTasks(ended, [{ id: 'b3', status: 'failed' }], 9)[1], { ...left, state: 'failed', endedAt: 5 })
})

test('the list keeps every running task and drops the oldest ended past its bound', () => {
  let list: BgTask[] = [shell]
  for (let i = 0; i < TASKS_KEPT + 5; i++) list = addTask(list, { ...shell, id: 'e' + i, state: 'done', endedAt: i })
  assert.equal(list.length, TASKS_KEPT)
  assert.equal(list[0], shell)
  assert.equal(list.at(-1)?.id, 'e' + (TASKS_KEPT + 4))
  assert.equal(addTask(list, { ...shell, title: 'again' }).filter(task => task.id === 'b1').length, 1)
})
