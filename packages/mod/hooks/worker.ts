// How a spawn of one of ClaudeRipple's workers is set right before it starts. Plain functions, no
// engine: the hook in register.tsx feeds them and applies the answer, and the tests import them.
//
// A worker is an agent file the router generated, whose `model:` is a routed id with an optional
// `@effort` (packages/router/src/agents.ts). Two things went wrong at spawn time, both silently:
// - A `model` argument on the Agent call replaced that id with a Claude alias, so the worker ran on
//   Claude and its output was cut to 64 tokens (2026-09).
// - The `[[ripple: name@level]]` marker that sets a worker's effort counts only as the prompt's
//   first line (packages/router/src/routing.ts); anywhere else it is prose and the level is lost.
// Measured on CLI 2.1.286 (2026-10-05): an `agent.spawn` hook that sets `model` to
// `deepseek-v4.1-flash@low` runs the worker on that id, and the router records effort low.

/** The router's marker, found anywhere in the prompt rather than only at its top. */
const MARKER = /\[\[\s*(?:ripple|gpt)\s*:\s*([A-Za-z0-9.\-]+)\s*(?:@\s*([A-Za-z]+))?\s*\]\]/

export type Spawn = { subagentType: string; prompt: string; model?: string }
export type WorkerFix = { prompt: string; model: string; dropped?: string }

/** The `model:` line of an agent file's frontmatter. */
export function agentModel(file: string): string | undefined {
  const head = /^---\n([\s\S]*?)\n---/.exec(file)?.[1]
  return head ? /^model:\s*(\S+)\s*$/m.exec(head)?.[1] : undefined
}

/**
 * What the spawn should run with, or null to leave it alone. `fileModel` is the worker's agent
 * file `model:` (an id, maybe with `@effort`).
 */
export function fixSpawn(spawn: Spawn, fileModel: string): WorkerFix | null {
  const base = fileModel.replace(/@[^@]*$/, '')
  const marker = MARKER.exec(spawn.prompt)
  const dropped = spawn.model !== undefined && spawn.model !== fileModel && spawn.model.replace(/@[^@]*$/, '') !== base ? spawn.model : undefined
  if (marker) {
    const name = marker[1]!.toLowerCase()
    const level = marker[2]?.toLowerCase()
    const rest = (spawn.prompt.slice(0, marker.index) + spawn.prompt.slice(marker.index + marker[0].length)).replace(/^\s*\n/, '')
    // The marker names this worker: its level goes on the model id, where the router reads it as
    // the agent file's own suffix, and the worker no longer reads a routing note.
    if (name === spawn.subagentType.toLowerCase() || name === base.toLowerCase()) {
      return { prompt: rest, model: level ? `${base}@${level}` : fileModel, ...(dropped ? { dropped } : {}) }
    }
    // It names another model or alias, which only the router can resolve: put it where the router
    // looks. Already there, there is nothing to move.
    const atTop = MARKER.exec(spawn.prompt.replace(/^\s+/, ''))?.index === 0
    if (atTop && !dropped) return null
    return { prompt: atTop ? spawn.prompt : `${marker[0]}\n${rest}`, model: fileModel, ...(dropped ? { dropped } : {}) }
  }
  return dropped ? { prompt: spawn.prompt, model: fileModel, dropped } : null
}
