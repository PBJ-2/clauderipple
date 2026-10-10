import type { SessionCompacted, SessionMessage } from 'claude-code'

export const COMPACT_SYSTEM = `Create a faithful continuation record of this coding conversation. Keep the user's intent and changes of mind, decisions and constraints, relevant concepts, files and code touched, errors and their fixes, and user feedback. List user requests in order, distinguish solved from pending work, and state exactly what is happening now. Include a next step only when the conversation justifies it. Preserve useful exact paths and commands, but omit secrets, redundant logs, and obsolete detail. Do not invent verification or claim unfinished work is complete. Write in the user's language.`

function clipped(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text
}

function render(messages: readonly SessionMessage[], tight: boolean): string {
  return messages.map((message, index) => {
    const tail = index >= messages.length - 6
    const inputLimit = tail ? (tight ? 4000 : 20000) : 400
    const resultLimit = tail ? (tight ? 4000 : 20000) : (tight ? 300 : 2000)
    const parts = [`${message.role}:\n${message.text}`]
    for (const use of message.toolUses) {
      parts.push(`tool ${use.tool} (${use.tool_use_id}):\n${clipped(JSON.stringify(use.input), inputLimit)}`)
      const result = use.text ?? (use.result !== undefined ? JSON.stringify(use.result) : undefined)
      if (result !== undefined) parts.push(`result${use.isError ? ' ERROR' : ''}:\n${clipped(result, resultLimit)}`)
    }
    if (!message.toolUses.length) {
      for (const result of message.toolResults ?? []) parts.push(`result ${result.tool_use_id}${result.isError ? ' ERROR' : ''}:\n${clipped(result.text, resultLimit)}`)
    }
    return parts.join('\n\n')
  }).join('\n\n---\n\n')
}

/** Shrink only tool bulk; losing user intent to hit a budget is worse than engine fallback. */
export function serializeTranscript(messages: readonly SessionMessage[], budget = 2400000): string | null {
  if (!messages.length) return null
  const full = render(messages, false)
  if (full.length <= budget) return full
  const tight = render(messages, true)
  return tight.length <= budget ? tight : null
}

/** No handle: the engine builds this replacement from role, text and tool blocks. */
export function compactResult(summary: string): SessionCompacted {
  return { messages: [{ role: 'user', toolUses: [], text:
    `Continuation record from the previous conversation:\n\n${summary.trim()}\n\nResume the pending work from this record. Do not repeat completed work or ask for information already recorded.` }] }
}
