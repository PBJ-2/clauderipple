import type { SessionCompacted, SessionMessage } from 'claude-code'

export const COMPACT_SYSTEM = `Write a faithful, detailed continuation record in the user's language. Use these sections in order:
1. Primary requests and intent: every explicit request, in detail, including changes of mind.
2. Key technical concepts: technologies, frameworks and conventions in play.
3. Files and code: each file read, changed or created, its exact path, importance and changes; reproduce important snippets verbatim, including full snippets for the most recent edits.
4. Errors and fixes: each error, its fix and any user feedback.
5. Problem solving and decisions: what was solved, decided or ruled out, and ongoing troubleshooting.
6. All user messages: every message the user wrote, not tool results, in order and near-verbatim.
7. Pending tasks: what was requested and remains unfinished.
8. Current work: precisely what was underway immediately before compaction, with file names and code snippets.
9. Next step: only if it follows directly from the most recent explicit user request; quote that request verbatim. Otherwise omit this section.
Preserve exact paths and commands; omit secrets and redundant logs. Never invent verification or claim unfinished work is complete.`

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

export type CompactFile = { path: string; text: string }

/** Most recently used file paths first, including notebook edits. */
export function compactPaths(messages: readonly SessionMessage[]): string[] {
  const paths = new Set<string>()
  for (const message of [...messages].reverse()) {
    for (const use of [...message.toolUses].reverse()) {
      if (!['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(use.tool)) continue
      const input = use.input
      if (!input || typeof input !== 'object') continue
      const value = input as Record<string, unknown>
      const path = value.file_path ?? value.notebook_path
      if (typeof path === 'string' && path) paths.add(path)
      if (paths.size === 5) return [...paths]
    }
  }
  return [...paths]
}

/** Bound the content, including the truncation marker, before rendering. */
export function capCompactFiles(files: readonly CompactFile[], total = 200000, perFile = 20000): CompactFile[] {
  const marker = '\n[truncated — re-read before editing]'
  const out: CompactFile[] = []
  let left = total
  for (const file of files) {
    if (left <= 0) break
    const limit = Math.min(perFile, left)
    const text = file.text.length <= limit ? file.text : limit >= marker.length ? file.text.slice(0, limit - marker.length) + marker : ''
    if (!text && file.text) break
    out.push({ path: file.path, text })
    left -= text.length
  }
  return out
}

/** No handle: the engine builds this replacement from role, text and tool blocks. */
export function compactResult(summary: string, files: readonly CompactFile[] = []): SessionCompacted {
  const rendered = capCompactFiles(files).map(file => {
    const fence = '`'.repeat(Math.max(3, ...[...file.text.matchAll(/`+/g)].map(match => match[0].length + 1)))
    return `${file.path}\n${fence}\n${file.text}\n${fence}`
  }).join('\n\n')
  const attached = rendered ? `\n\nFiles read before the compaction, as they are now on disk:\n\n${rendered}` : ''
  return { messages: [{ role: 'user', toolUses: [], text:
    `Continuation record from the previous conversation:\n\n${summary.trim()}${attached}\n\nResume the pending work from this record. Do not repeat completed work or ask for information already recorded.` }] }
}
