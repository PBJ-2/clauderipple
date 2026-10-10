import type { SessionMessage } from 'claude-code'
import type { HandoffKind, Settings } from '../types'

export const QUICK_PROMPT = `Prepare a concise resume note for a fresh coding chat, in the user's language, about forty lines of bullets. Use only this conversation; do not run tools. Record project, folder and branch if known, the goal, verified completed work, unfinished work and blockers, git state as last checked, decisions and failed approaches, permissions or resume details, and the highest-priority runnable next action. Mark actions requiring the user. Keep only current relevant state and point to files or specs instead of copying them. Exclude secrets, environment values and raw logs. Output only the note, without an introduction or farewell.`

export const FULL_PROMPT = `Write a durable handoff for the next coding chat. First verify the working directory, git status, recent commits and whether changes are pushed; check open pull requests if gh is available. Rebuild project-root HANDOFF.md from the current facts, fewer than eighty lines, in the user's language. Include the goal, verified done and undone work, blockers, changed files, decisions and failed approaches, permissions, exact current state and a prioritized next action. Distinguish facts from unverified claims. Never expose secrets, environment values or raw logs. Finish with the saved file path and a concise status for the next chat.`

export function wrapForNewChat(text: string, after: Settings['handoffAfter'], kind: HandoffKind, hasSkill: boolean): string {
  const source = kind === 'full' && hasSkill ?
    'First read the saved handoff files named below; if no file is named, read HANDOFF.md. The last answer alone may not contain the handoff.\n\n' : ''
  const action = after === 'confirm' ?
    'State the current status and proposed next action in two lines, then wait for my confirmation without starting work.' :
    'Continue with the justified next action. If it needs my permission or input, explain what is needed and wait.'
  return `${source}Resume context from the previous chat:\n\n${text.trim()}\n\n${action}`
}

export const ADVICE_SYSTEM = `Decide whether starting a fresh chat clearly helps this coding work. Recommend it only when completed work is followed by a different task, unrelated history is dead weight, the topic changed, or repeated failed approaches are going in circles. A long chat, high context usage, or an ordinary next step is not enough. When uncertain, do not recommend it. Output only JSON {"handoff":null} or {"handoff":"reason"}, using the user's language and at most eight words.`

/** Cadence counts real eligible prompts, not tool steps, pings or judge requests. */
export function adviceDue(count: number, percent: number): boolean {
  return percent >= 30 && Number.isInteger(count) && count > 0 && count % 2 === 0
}

export function adviceInput(input: { messages: readonly SessionMessage[]; next: string; contextPercent: number; warm: boolean }): string {
  const users = input.messages.filter(message => message.role === 'user' && message.text.trim())
  const assistant = input.messages.findLast(message => message.role === 'assistant' && message.text.trim())
  const trail = users.slice(-8, -1).map(message => message.text.replace(/\s+/g, ' ').slice(0, 160)).join('\n')
  return [`Context: ${Math.round(input.contextPercent)}%; user messages: ${users.length}; cache: ${input.warm ? 'warm' : 'cold'}`,
    `Initial request: ${users[0]?.text.slice(0, 500) ?? ''}`, `Earlier requests:\n${trail}`,
    `Assistant tail: ${assistant?.text.slice(-700) ?? ''}`, `Next request: ${input.next.slice(0, 600)}`].join('\n\n')
}

export function parseAdvice(text: string): string | null {
  const span = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!span) return null
  try {
    const value: unknown = JSON.parse(span)
    if (!value || typeof value !== 'object' || !('handoff' in value)) return null
    return typeof value.handoff === 'string' && value.handoff.trim() ? value.handoff.trim().slice(0, 70) : null
  } catch {
    return null
  }
}
