// Background work as the Claude app lists it beside the agents: a command Claude left running (Bash
// `run_in_background`, or one the person or a timeout moved there) or a watch (Monitor).
//
// A tool call's result starts one; the engine's notification ends it, in the words it tells the
// model (`<task-notification>` with the task's `<task-id>` and `<status>`, read 2026-10-24). A stop
// the model asked for (TaskStop) ends it at once; a command bound to its agent's final response ends
// with that agent; and a Stop that no longer lists one in flight settles it until a notice says how.
//
// An agent that ends its turn while its own commands still run is not finished: the Claude app lists
// it as running, and it may wake by itself when one ends (read 2026-11-24, engine 2.1.330). The card
// stays running, `waiting`, until its last command ends or a notification says it finished.

import type { AgentRec, BgTask } from '../types'

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
 * a worker's, its worker listed too, unless the worker is one waiting on its own commands (`waiting`:
 * its ids), which the Claude app keeps running with them. The app drops a finished worker's commands
 * from its list; and a session kept four dead commands of a long-ended worker running for ten hours,
 * no notice of theirs ever arriving (2026-11-01).
 */
export function stillRunning(task: BgTask, inFlight: readonly string[], waiting: readonly string[] = []): boolean {
  return inFlight.includes(task.id) && (task.agentId === undefined || inFlight.includes(task.agentId) || waiting.includes(task.agentId))
}

/**
 * The running tasks a Stop no longer holds in flight (stillRunning), ended: one whose notification
 * has not reached a hook. How it ended is not known yet, so it reads as done until a notice says
 * otherwise (endTasks).
 */
export function settleTasks(list: readonly BgTask[], inFlight: readonly string[], now: number, waiting: readonly string[] = []): BgTask[] {
  return list.map(task => task.state === 'running' && !stillRunning(task, inFlight, waiting) ? settled(task, now) : task)
}

/**
 * The running tasks agent `agentId` leaves behind as it ends for good, settled: a notice that comes
 * later says how each ended. An agent with commands of its own still running is not ended for good
 * (ownRunning), so this is only for one with none that outlive its turn.
 */
export function settleWithAgent(list: readonly BgTask[], agentId: string, now: number): BgTask[] {
  return list.map(task => task.agentId === agentId && task.state === 'running' ? settled(task, now) : task)
}

/**
 * The running commands of agent `agentId` that outlive its turn: the work it is still waiting on when
 * it ends one. A command bound to its final response ends with that turn (endWithAgent), so it is not one.
 */
export function ownRunning(list: readonly BgTask[], agentId: string): BgTask[] {
  return list.filter(task => task.agentId === agentId && task.state === 'running' && !task.endsWithAgent)
}

/**
 * The engine's summary for an agent that ended its turn with its own background work still running
 * ("<description> is waiting on its own background work"); a finished one reads "<description> finished".
 * Only that suffix form counts, at the very end: a description that merely mentions the words
 * ("Fix the agent waiting on its own background work") is the agent's own, and a finished agent whose
 * description says so must not come back to life. Read only where the task list cannot say (agentsAfterNotice).
 */
export function isWaitingSummary(summary: string | undefined): boolean {
  return /(^|\s)is waiting on its own background work$/i.test((summary ?? '').trim())
}

/** The card of an agent whose turn ended with work of its own still running: running, as the Claude app shows it, its clock kept. */
export function waitOnOwn(agent: AgentRec): AgentRec {
  const { endedAt: _ended, now: _now, toolSince: _since, ...rest } = agent
  return { ...rest, state: 'running', waiting: true }
}

/** A waiting agent's card ended, its wait counted in its time. */
export function endWaiting(agent: AgentRec, state: 'done' | 'failed', now: number): AgentRec {
  const { waiting: _waiting, ...rest } = agent
  return { ...rest, state, endedAt: now }
}

/**
 * What a notification, and the change it made to the task list (`before` to `after`), leave of each
 * agent that waits on work of its own. A waiting agent ends when its last command of its own ended,
 * or when a notification says it finished (or failed). A notification that it is waiting returns
 * an agent shown done to running: it comes a few milliseconds after the turn's end, and the list is
 * the first word on it, this one only where the list knows no command of the agent's. A running
 * agent that is not waiting has woken or is mid-turn, and the notice leaves it be.
 */
export function agentsAfterNotice(agents: readonly AgentRec[], ends: readonly TaskEnd[], before: readonly BgTask[], after: readonly BgTask[], now: number): AgentRec[] {
  return agents.map(agent => {
    const notice = ends.find(end => end.id === agent.id)
    const how = notice ? endState(notice.status) : undefined
    const waits = how === 'done' && isWaitingSummary(notice?.summary)
    if (waits && !agent.waiting) {
      if (agent.state !== 'done') return agent
      const mine = after.filter(task => task.agentId === agent.id && !task.endsWithAgent)
      // Every command it left has ended: it wakes on its own or is finished, either way not waiting.
      if (mine.length && !mine.some(task => task.state === 'running')) return agent
      return waitOnOwn(agent)
    }
    if (agent.waiting && how && !waits) return endWaiting(agent, how === 'done' ? 'done' : 'failed', now)
    if (agent.waiting && ownRunning(before, agent.id).length && !ownRunning(after, agent.id).length) return endWaiting(agent, 'done', now)
    return agent
  })
}

/**
 * The waiting agents a notification says finished (or failed): their own commands still running leave
 * the list with them, as they did when a turn ended for good (settleWithAgent). The engine says
 * "finished" only when the agent has no live background work of its own left.
 */
export function finishedByNotice(agents: readonly AgentRec[], ends: readonly TaskEnd[]): string[] {
  return agents.filter(agent => {
    if (!agent.waiting) return false
    const notice = ends.find(end => end.id === agent.id)
    return !!notice && !!endState(notice.status) && !isWaitingSummary(notice.summary)
  }).map(agent => agent.id)
}

/** One entry of a Stop's `background_tasks`: its id, and its status where the engine says one. */
export type StopEntry = { id: string; status?: string }

/** An entry the engine lists as ended (the word read as endState reads a notice's): not in flight any more. */
function listedEnded(entry: StopEntry): boolean {
  return /^(completed|done|failed|error|killed|stopped|cancel+ed)$/i.test((entry.status ?? '').trim())
}

/**
 * The waiting agents a Stop's `background_tasks` (`listed`) leaves nothing of: neither the agent nor
 * any command of its own (in `tasks`) is listed, so nothing is left to wake it or to say it ended.
 * One a hot reload left behind ends this way, done, the wait counted in its time.
 *
 * A wait the engine's notice alone opened (no command of its own tracked) also needs the list to
 * hold no running entry we cannot place: engine 2.1.330 lists running work without owner ids, and
 * an agent that gave the waiting notice is internally completed, so a command of its own whose start
 * the mod missed is listed unattributed. An entry is placed when it is another known agent or a task
 * the mod tracks (the main session's, or another agent's); an explicitly empty list ends the wait.
 */
export function agentsAfterStop(agents: readonly AgentRec[], listed: readonly StopEntry[], tasks: readonly BgTask[], now: number): AgentRec[] {
  const inFlight = listed.map(entry => entry.id)
  const known = new Set([...agents.map(a => a.id), ...tasks.map(task => task.id)])
  const unplaced = listed.some(entry => !listedEnded(entry) && !known.has(entry.id))
  return agents.map(agent => {
    if (!agent.waiting || inFlight.includes(agent.id)) return agent
    const own = tasks.filter(task => task.agentId === agent.id && !task.endsWithAgent)
    if (own.some(task => inFlight.includes(task.id))) return agent
    if (!own.length && unplaced) return agent
    return endWaiting(agent, 'done', now)
  })
}

/** The exit code a command's summary names ("… failed with exit code 1"), if any. */
export function exitCode(summary: string | undefined): number | undefined {
  const code = /exit code (\d+)/i.exec(summary ?? '')?.[1]
  return code === undefined ? undefined : Number(code)
}
