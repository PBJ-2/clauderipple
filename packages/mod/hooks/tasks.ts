// Background work as the Claude app lists it beside the agents: a command Claude left running (Bash
// `run_in_background`, or one the person or a timeout moved there) or a watch (Monitor).
//
// A tool call's result starts one; the engine's notification ends it, in the words it tells the
// model (`<task-notification>` with the task's `<task-id>` and `<status>`, read 2026-10-24). A stop
// the model asked for (TaskStop) ends it at once; a command bound to its agent's final response ends
// with that agent; and a Stop that no longer lists one in flight settles it until a notice says how.

import type { BgTask } from '../types'

/** Tasks kept: every running one, then the latest that ended. */
export const TASKS_KEPT = 40

function words(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/**
 * The task a finished tool call left in the background, if any: from its input (the call's own
 * description and command) and the tool's result (`backgroundTaskId`, Monitor's `taskId`).
 */
export function taskStarted(tool: string, input: unknown, result: unknown, agentId: string | undefined, startedAt: number): BgTask | undefined {
  const given = fields(input)
  const out = fields(result)
  const from = agentId ? { agentId } : {}
  if (tool === 'Bash') {
    const id = words(out.backgroundTaskId)
    if (!id) return undefined
    const command = words(given.command)
    return { id, kind: 'shell', title: words(given.description) ?? command ?? id, ...(command ? { command } : {}), ...from, ...(out.backgroundEndsWithFinalResponse === true ? { endsWithAgent: true } : {}), state: 'running', startedAt }
  }
  if (tool === 'Monitor') {
    const id = words(out.taskId)
    if (!id) return undefined
    const command = words(given.command) ?? words(fields(given.ws).url)
    return { id, kind: 'monitor', title: words(given.description) ?? command ?? id, ...(command ? { command } : {}), ...from, state: 'running', startedAt }
  }
  return undefined
}

/** The list with `task` added (or put in place of one of its id): every running one kept, the oldest ended dropped. */
export function addTask(list: readonly BgTask[], task: BgTask): BgTask[] {
  const rest = list.filter(t => t.id !== task.id)
  const over = rest.length + 1 - TASKS_KEPT
  const drop = new Set(over > 0 ? rest.filter(t => t.state !== 'running').slice(0, over).map(t => t.id) : [])
  return [...rest.filter(t => !drop.has(t.id)), task]
}

/** What a notification says of a task that ended: its id, the word for how, and its summary line. */
export type TaskEnd = { id: string; status: string; summary?: string }

/** Each task a notification's text reports as ended. A watch's event carries no status and ends nothing. */
export function taskEnds(text: string): TaskEnd[] {
  const out: TaskEnd[] = []
  for (const [, body = ''] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const tag = (name: string) => words(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(body)?.[1])
    const id = tag('task-id')
    const status = tag('status')
    const summary = tag('summary')
    if (id && status) out.push({ id, status, ...(summary ? { summary } : {}) })
  }
  return out
}

/** The state a notification's word leaves a task in; any other word leaves it running. */
export function endState(status: string): BgTask['state'] | undefined {
  const word = status.toLowerCase()
  if (word === 'completed') return 'done'
  if (word === 'failed') return 'failed'
  if (word === 'killed' || word === 'stopped') return 'stopped'
  return undefined
}

/**
 * The running tasks `ends` names ended, as each says. One a Stop settled takes how from its notice,
 * which may come after (queued while the turn ended), and keeps the earlier time; one that ended
 * otherwise (stopped, bound to its agent) keeps how.
 */
export function endTasks(list: readonly BgTask[], ends: readonly TaskEnd[], now: number): BgTask[] {
  return list.map(task => {
    const end = task.state === 'running' || task.settled ? ends.find(e => e.id === task.id) : undefined
    const state = end ? endState(end.status) : undefined
    if (!end || !state) return task
    const { settled: _, ...rest } = task
    return { ...rest, state, endedAt: task.settled ? task.endedAt ?? now : now, ...(end.summary ? { summary: end.summary } : {}) }
  })
}

/** The running task of `id` stopped: TaskStop answered for it. */
export function stopTask(list: readonly BgTask[], id: string, now: number): BgTask[] {
  return list.map(task => task.id === id && task.state === 'running' ? { ...task, state: 'stopped', endedAt: now } : task)
}

/** The running commands bound to agent `agentId`'s final response stopped: it has given it. */
export function endWithAgent(list: readonly BgTask[], agentId: string, now: number): BgTask[] {
  return list.map(task => task.agentId === agentId && task.endsWithAgent && task.state === 'running' ? { ...task, state: 'stopped', endedAt: now } : task)
}

/** A running task ended as far as we can tell, until a notice says how (endTasks). */
function settled(task: BgTask, now: number): BgTask {
  return { ...task, state: 'done', endedAt: now, settled: true }
}

/**
 * Whether a Stop's `background_tasks` (the session's) leaves `task` running: listed itself, and, for
 * a worker's, its worker listed too. The Claude app drops a worker's commands from its list with the
 * worker; and a session kept four dead commands of a long-ended worker running for ten hours, no
 * notice of theirs ever arriving (2026-11-01).
 */
export function stillRunning(task: BgTask, inFlight: readonly string[]): boolean {
  return inFlight.includes(task.id) && (task.agentId === undefined || inFlight.includes(task.agentId))
}

/**
 * The running tasks a Stop no longer holds in flight (stillRunning), ended: one whose notification
 * has not reached a hook. How it ended is not known yet, so it reads as done until a notice says
 * otherwise (endTasks).
 */
export function settleTasks(list: readonly BgTask[], inFlight: readonly string[], now: number): BgTask[] {
  return list.map(task => task.state === 'running' && !stillRunning(task, inFlight) ? settled(task, now) : task)
}

/** The running tasks agent `agentId` leaves behind as it ends, settled: they leave the list with it. */
export function settleWithAgent(list: readonly BgTask[], agentId: string, now: number): BgTask[] {
  return list.map(task => task.agentId === agentId && task.state === 'running' ? settled(task, now) : task)
}

/** The exit code a command's summary names ("… failed with exit code 1"), if any. */
export function exitCode(summary: string | undefined): number | undefined {
  const code = /exit code (\d+)/i.exec(summary ?? '')?.[1]
  return code === undefined ? undefined : Number(code)
}
