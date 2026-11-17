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
import type { DelegationPin } from '../types/index.d.ts'

/**
 * The router's marker, found anywhere in the prompt rather than only at its top. A tier marker may
 * add a domain word, `[[ripple: standard ui]]`; the router's own pattern stops at the name, so a
 * marker with a domain never reaches it as a model.
 */
export const MARKER = /\[\[\s*(?:ripple|gpt)\s*:\s*([A-Za-z0-9._:/\-]+)\s*(?:@\s*([A-Za-z]+))?(?:\s+([A-Za-z][A-Za-z-]*))?\s*\]\]/

// The session's model markers no longer authorize a worker (2026-10-24). The judge reads one-shot
// delegation intent; these name helpers remain for the user's explicit standing pin.
/** The words in a model id that name it: `gemini-3.8-flash` → gemini; `gpt-6.1-sol` → gpt, sol. */
const GENERIC = new Set(['flash', 'free', 'pro', 'mini', 'max', 'lite', 'preview', 'latest', 'contributor', 'spark', 'code', 'chat', 'instruct', 'claude', 'turbo', 'high', 'low', 'medium', 'xhigh'])
/** How the user says them in Korean. */
const SPOKEN: Record<string, readonly string[]> = {
  gemini: ['제미나이', '제미니'], deepseek: ['딥시크'], minimax: ['미니맥스'], gpt: ['지피티'], sol: ['솔'], astra: ['아스트라'],
  luna: ['루나'], terra: ['테라'], opus: ['오푸스', '오퍼스'], sonnet: ['소넷'], haiku: ['하이쿠'], fable: ['페이블'], mythos: ['미토스'],
  muse: ['뮤즈'], kimi: ['키미'], qwen: ['큐웬'], mimo: ['미모'], longcat: ['롱캣'], argon: ['아르곤'], hydrogen: ['하이드로젠'],
}
const PROVIDER_SPOKEN: Record<string, readonly string[]> = {
  opencode: ['오픈코드'], google: ['구글'], chatgpt: ['챗지피티'], antigravity: ['안티그래비티'], anthropic: ['앤트로픽'],
}
// A Korean name counts when a particle or nothing Korean follows it: "솔한테" names Sol, "솔직히" does not.
const PARTICLE = '(?:이한테|이랑|이가|이는|이를|이도|이로|이나|한테|에게|으로|께|로|이|가|은|는|을|를|도|만|랑|와|과|의|님|에)'
export function modelWords(id: string): string[] {
  return [...new Set(id.toLowerCase().split(/[^a-z]+/).filter(word => word.length >= 3 && !GENERIC.has(word)))]
}
// A delegating verb written onto the name: "오푸스시켜 중요한거잖아" named Opus and was read as
// unnamed (2026-10-24), so the marker went and the tier sent the task to Sol.
const VERB = '(?:시켜|시키|써|쓰|돌려|돌리|맡겨|맡기|불러|부르|줘)'
function says(text: string, word: string): boolean {
  if (new RegExp(`(?<![a-z])${word}(?![a-z])`, 'i').test(text)) return true
  return [...(SPOKEN[word] ?? []), ...(PROVIDER_SPOKEN[word] ?? [])].some(name => new RegExp(`${name}(?:쪽)?(?:${PARTICLE}|${VERB}|(?![가-힣]))`).test(text))
}
type Said ={ role: 'user' | 'assistant'; text: string; toolResults?: readonly unknown[] }
type ModelSource = { model: string; provider: string }
/** Once the provider is known, metadata and intent checks use its original model id. */
export function providerModelId(model: string, provider?: string): string {
  const base = model.replace(/@[^@]*$/, '')
  return provider && base.startsWith(provider + ':') ? base.slice(provider.length + 1) : base
}
/** The person's words alone, shared by one-shot authorization and session pinning. */
export function humanText(m: Said): string | null {
  const text = m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  return m.role === 'user' && !m.toolResults?.length && !!text && !/^<[a-z][a-z-]*>/i.test(text) && !text.startsWith('This session is being continued') ? text : null
}

/**
 * Explicit standing intent, never inferred from a one-off model choice. Everyday words stay out:
 * "솔이 계속 실패하네" complains about Sol, and "헤더 고정해 줘" pins a header, not a worker.
 */
export const PIN_PHRASES = ['앞으로', '이제부터', '이 세션은', '이번 세션 내내', '위임 고정', '로 고정', 'from now on', 'for this session'] as const
// A release must name the choice or the pin itself. Bare "알아서 골라" may mean test data;
// "헤더 고정 풀어" is not a delegation instruction either.
const REQUEST_END = '(?:\\s*(?:해\\s*)?(?:줘|주세요|주라|라|요))?[.!?。]*$'
const CHOICE = '(?:위임(?:\\s*모델)?|모델)(?:\\s*선택)?'
export const UNPIN_PHRASES: readonly RegExp[] = [
  new RegExp(`^(?:${CHOICE}\\s*)?고정(?:을|은)?\\s*(?:풀어|해제)(?:해)?${REQUEST_END}`),
  new RegExp(`^${CHOICE}(?:은|는|을|를)?\\s*(?:알아서|자동으로)\\s*(?:골라|정해|선택해|해)${REQUEST_END}`),
  /^(?:please\s+)?unpin(?:\s+(?:the\s+)?(?:delegation|model|worker))?[.!?]*$/i,
  /^(?:please\s+)?(?:choose|select)\s+(?:the\s+)?(?:delegation\s+)?(?:model|worker)\s+automatically[.!?]*$/i,
]
const hasPhrase = (text: string, phrases: readonly string[]) => phrases.some(phrase => /[a-z]/i.test(phrase)
  ? new RegExp(`\\b${phrase}\\b`, 'i').test(text) : text.includes(phrase))
// Keep a future instruction in one sentence/clause from making a separate one-shot choice stick.
const pinParts = (text: string) => text.split(/(?<=[.!?。])\s+|\n+|[,;，；]+/).map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean)
/** Cheap intent check before the hook loads the worker catalogue; pinning still needs a target. */
export function pinInstruction(text: string): 'pin' | 'release' | undefined {
  // A standing "don't": "앞으로 솔은 쓰지 마", "솔 말고", "솔로 고정하지 마".
  if (/(?:고정\s*(?:하지|하지는|말|안)|(?:하지|쓰지|고르지|시키지|맡기지|보내지)\s*(?:마|말)|말고|빼고|\b(?:do not|don't|never|stop)\b)/i.test(text)) return undefined
  const parts = pinParts(text)
  if (parts.some(part => UNPIN_PHRASES.some(phrase => phrase.test(part)))) return 'release'
  return parts.some(part => hasPhrase(part, PIN_PHRASES) || /고정/.test(part)) ? 'pin' : undefined
}
const modelId = (model: string) => model.toLowerCase().replace(/@[^@]*$/, '').replace(/\./g, '-')
const pinId = (model: string) => modelId(model).replace(/^claude-/, '').replace(/^(opus|sonnet|haiku|fable|mythos)-.*$/, '$1')
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Dots and hyphens normalize alike, but no substring of a longer model id is exact. */
const fullIdPattern = (model: string) => `(?<![a-z0-9_.-])${modelId(model).split('-').map(escapePattern).join('[.-]')}(?![a-z0-9_-]|\\.[a-z0-9])`
function modelPattern(model: string): string {
  const words = modelWords(model)
  return `(?:${fullIdPattern(model)}|${words.map(word => `(?<![a-z])${word}(?![a-z])`).concat(words.flatMap(word => SPOKEN[word] ?? [])).join('|')})`
}
// Directional particles must lead to a delegation command (or finish an elliptical "솔로").
// A name followed by "오류 로그" or "작성한 로그" is a subject, not the selected worker.
const COMMAND_END = '(?:\\s*(?:줘|주세요|주라|라|요))?(?=$|\\s|[.!?。])'
const PIN_COMMAND = `고정(?:해|하자|하세요)?${COMMAND_END}`
const DELEGATION_VERB = `(?:해|하자|하세요|하라|시켜|시키자|시키세요|맡겨|맡기자|맡기세요|써|쓰자|쓰세요|돌려|돌리자|돌리세요|고정(?:해|하자|하세요)?|위임(?:해|하자|하세요)?|사용(?:해|하자|하세요)?)${COMMAND_END}`
const DELEGATION_TASK = '(?:(?:검토|리뷰|작업|구현|교정|분석|테스트)(?:을|를)?\\s*)?'
function pinsModel(text: string, model: string): boolean {
  const name = modelPattern(model)
  if (/위임\s*고정/.test(text)) return true // userNamed separately checks the named model/source.
  if (new RegExp(`${name}\\s*(?:으로|로)?\\s*${PIN_COMMAND}`, 'i').test(text)) return true
  if (!hasPhrase(text, PIN_PHRASES)) return false
  const directed = new RegExp(`${name}\\s*(?:(?:으로|로|에게|한테|이한테)\\s*(?:${DELEGATION_TASK}${DELEGATION_VERB}|[.!?。]*$)|(?:을|를|은|는)?\\s*${DELEGATION_TASK}${DELEGATION_VERB})`, 'i')
  const paired = new RegExp(`${name}(?:과|와|랑|이랑|\\s+(?:and|or))\\s*\\S+?(?:으로|로|에게|한테)\\s*${DELEGATION_TASK}${DELEGATION_VERB}`, 'i')
  const english = new RegExp(`\\b(?:(?:use|pin)\\s+|(?:delegate|assign)\\s+(?:(?:work|tasks?)\\s+)?to\\s+)${name}(?=$|[.!?。]|\\s+(?:for|from|to|on|as|at)\\b)`, 'i')
  return directed.test(text) || paired.test(text) || english.test(text)
}

/** Compare version components as numbers: 6.10 is newer than 6.9, and 7 is newer than 6.99. */
function compareModelVersions(a: string, b: string): number {
  const version = (model: string) => (modelId(model).match(/\d+(?:-\d+)*/)?.[0] ?? '0').split('-').map(Number)
  const left = version(a), right = version(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference) return difference
  }
  return 0
}
/** A family name chooses its one generated worker, otherwise its latest version. Never cross families. */
function familyPinSources(sources: readonly ModelSource[], workers: readonly ModelSource[]): readonly ModelSource[] {
  if (new Set(sources.map(source => modelWords(providerModelId(source.model, source.provider)).join('|'))).size !== 1) return []
  const generated = sources.filter(source => workers.some(worker => modelId(worker.model) === modelId(source.model) && worker.provider === source.provider))
  if (new Set(generated.map(source => modelId(source.model))).size === 1) return generated
  const latest = sources.reduce((best, source) => compareModelVersions(source.model, best.model) > 0 ? source : best)
  // Equal-version variants remain together: the caller refuses them rather than breaking a tie by order.
  return sources.filter(source => compareModelVersions(source.model, latest.model) === 0)
}

/** undefined means no change; null explicitly releases the pin. Ambiguous models never pin. */
export function delegationPin(message: Said, sources: readonly ModelSource[], workers: readonly ModelSource[] = []): DelegationPin | null | undefined {
  const text = humanText(message)
  if (!text) return undefined
  const instruction = pinInstruction(text)
  if (instruction === 'release') return null
  if (instruction !== 'pin') return undefined
  const parts = pinParts(text).filter(part => pinInstruction(part) === 'pin')
  const matches = sources.flatMap(source => {
    const providers = rivalProviders(source.model, sources)
    const model = providerModelId(source.model, source.provider)
    const targeted = parts.filter(part => pinsModel(part, model) && userNamed(source.model, [{ role: 'user', text: part }], [], { ...source, providers }))
    if (!targeted.length) return []
    const exact = targeted.some(part => new RegExp(fullIdPattern(model), 'i').test(part))
    const score = Math.max(...targeted.map(part => modelWords(model).filter(word => says(part, word)).length))
    return [{ ...source, exact, score }]
  })
  const exact = matches.some(source => source.exact)
  const eligible = matches.filter(source => source.exact === exact)
  const best = Math.max(1, ...eligible.map(source => source.score))
  const ranked = eligible.filter(source => source.score === best)
  const named = exact ? ranked : familyPinSources(ranked, workers)
  if (new Set(named.map(source => modelId(source.model))).size !== 1) return undefined
  const first = named[0]!
  const providers = [...new Set(named.map(source => source.provider))]
  return { model: first.model.replace(/@[^@]*$/, ''), ...(providers.length === 1 ? { provider: providers[0]! } : {}) }
}

/** The most characters of the person's sentence the band keeps beside a pin. */
export const PIN_SAID_MAX = 60
/**
 * The sentence that pinned, for the band to show: the first one carrying a standing phrase, its
 * whitespace folded and cut to PIN_SAID_MAX characters. Session state only.
 */
export function pinSaid(text: string, model?: string): string | undefined {
  const parts = pinParts(text)
  const part = parts.find(p => pinInstruction(p) === 'pin' && (!model || pinsModel(p, model))) ?? parts[0]
  if (!part) return undefined
  const chars = [...part]
  return chars.length > PIN_SAID_MAX ? chars.slice(0, PIN_SAID_MAX - 1).join('') + '…' : part
}

export function pinAllows(pin: DelegationPin | null, model: string, provider?: string): boolean {
  return !!pin && pinId(pin.model) === pinId(model) && (!pin.provider || pin.provider === provider)
}
/**
 * Whether the user named this model (an id, agent name or Claude alias) in what they last wrote:
 * their last two messages, and the answer they replied to when the last one is a short "go".
 * Tool results, notices and compaction summaries are not the user.
 */
export function userNamed(model: string, messages: readonly Said[], prompts: readonly string[] = [], source: { provider?: string; providers?: readonly string[] } = {}): boolean {
  const words = modelWords(providerModelId(model, source.provider))
  if (!words.length) return false
  // A notice opens on a tag (`<task-notification>`, `<local-command-stdout>`); a reply the app quotes
  // opens on `<!-- reply 1 -->` and is the user's own words.
  const at = messages.flatMap((m, index) => humanText(m) ? [index] : []).slice(-2)
  const last = at.at(-1)
  const heard = at.map(index => humanText(messages[index]!)!)
  if (last !== undefined && messages[last]!.text.trim().length <= 12) {
    const answer = messages.slice(0, last).findLast(m => m.role === 'assistant' && m.text.trim())
    if (answer) heard.push(answer.text.slice(-2000))
  }
  // The prompts as submitted (`heardPrompts`): one typed mid-turn is in no user message above.
  const texts = [...heard, ...prompts]
  // Naming a provider chooses the source of a named model; it never authorizes all its models.
  const providers = [...new Set([...(source.providers ?? []), ...(source.provider ? [source.provider] : [])])]
  const distinct = providers.filter(provider => modelWords(provider).some(word => !Object.hasOwn(SPOKEN, word) && !words.includes(word)))
  // The "gemini" inside the provider id "google-gemini" is not a separate model choice.
  const modelTexts = texts.map(text => distinct.reduce((own, provider) => own.replace(new RegExp(`(?<![a-z0-9_-])${escapePattern(provider)}(?![a-z0-9_-])`, 'gi'), ' '), text))
  if (!modelTexts.some(text => words.some(word => says(text, word)))) return false
  // A provider names the source, not just its model: "Argon on OpenCode" must not authorize the
  // Google API worker with the same model. Without a provider, the model name covers either source.
  // Only the user's own words choose a source: the answer a short "go" replies to mentions
  // providers in passing ("Google API is out of quota"), and that is not a choice.
  const own = [...at.map(index => humanText(messages[index]!)!), ...prompts]
  // "Sol or DeepSeek" names two models, not a requirement to run Sol on the DeepSeek API.
  const named = providers.filter(provider => modelWords(provider).some(word => !Object.hasOwn(SPOKEN, word) && !words.includes(word) && own.some(text => says(text, word))))
  if (named.length) return !!source.provider && named.includes(source.provider)
  return true
}

/**
 * The providers a named source could tell this model apart from: those serving a model that shares
 * one of its name words. Naming OpenCode then decides between two Argons, and says nothing about Sol.
 */
export function rivalProviders(model: string, sources: readonly { model: string; provider: string }[]): string[] {
  const owner = sources.find(s => model.startsWith(s.provider + ':'))?.provider
  const words = modelWords(providerModelId(model, owner))
  return [...new Set(sources.filter(s => modelWords(providerModelId(s.model, s.provider)).some(word => words.includes(word))).map(s => s.provider))]
}

export type Spawn = { subagentType: string; prompt: string; model?: string }
export type WorkerFix = { prompt: string; model: string; dropped?: string }

/**
 * The `model:` line of an agent file's frontmatter. A file written by hand may have CRLF line ends
 * (Windows editors) or a quoted value; the generated ones have neither.
 */
export function agentModel(file: string): string | undefined {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(file)?.[1]
  return head ? /^model:\s*["']?([^\s"']+)["']?\s*$/m.exec(head)?.[1] : undefined
}

/**
 * Where Claude Code reads the definition of a named agent, nearest first: each project folder's
 * `.claude/agents` (`projectFolders`, nearest first), then the user's. A plugin agent
 * (`plugin:name`) has no file in any of them.
 */
export function agentFilePaths(subagentType: string, claudeHome: string, projectFolders: readonly string[] = []): string[] {
  if (!/^[A-Za-z0-9_.-]+$/.test(subagentType)) return []
  // A root folder ("/", "E:\") loses its separator here and gets it back from the join.
  const projects = projectFolders.filter(Boolean).map(folder => `${folder.replace(/[\\/]+$/, '')}/.claude/agents/${subagentType}.md`)
  return [...projects, `${claudeHome}/agents/${subagentType}.md`]
}

/**
 * The folder the session started in and each one above it, nearest first, up to and not including
 * the user's home (whose `.claude` is the user's own folder) or the filesystem root, included.
 * Claude Code reads project agents from these folders of the start folder, not of the folder the
 * session later moved to with `cd`; the caller stops the walk at the repository root as it does.
 */
export function ancestorFolders(start: string, home?: string): string[] {
  const windows = /^[A-Za-z]:|\\/.test(start)
  const key = (path: string) => {
    const flat = path.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
    return windows ? flat.toLowerCase() : flat
  }
  const stop = home ? key(home) : undefined
  const out: string[] = []
  let folder = start.replace(/(.)[\\/]+$/, '$1')
  // A path has fewer parts than this; the bound only keeps a malformed one from looping.
  for (let depth = 0; depth < 256 && folder; depth++) {
    if (stop !== undefined && key(folder) === stop) break
    out.push(folder)
    const cut = Math.max(folder.lastIndexOf('/'), folder.lastIndexOf('\\'))
    if (cut < 0) break
    const head = folder.slice(0, cut)
    const parent = cut === 0 ? folder.slice(0, 1) : /^[A-Za-z]:$/.test(head) ? folder.slice(0, cut + 1) : head
    if (parent === folder) break
    folder = parent
  }
  return out
}

/** The model a definition starts its agent on, for a title: `inherit` is the parent's, so none. */
export function definedModel(file: string): string | undefined {
  const model = agentModel(file)
  return model && model.toLowerCase() !== 'inherit' ? model : undefined
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
