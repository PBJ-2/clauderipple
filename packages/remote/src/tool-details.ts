// Pure tool presentation data. Shared by host serialization, web and native; no platform imports.
import type { Text, ToolCall } from "./protocol.ts";

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function toolInput(value: Text | undefined): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try { return record(JSON.parse(value)); } catch { return null; } // Legacy tools may store a plain prompt, not JSON.
}
export const stringField = (input: Record<string, unknown> | null, key: string): string => typeof input?.[key] === "string" ? input[key] : "";

export interface DiffLine { kind: "context" | "add" | "remove"; text: string; old: number | null; next: number | null }
export interface ChangeCount { added: number; removed: number }
export interface ToolDiff { path: string; header: string; lines: DiffLine[] }
function lines(text: string): string[] {
  if (!text) return [];
  const list = text.replace(/\r\n/g, "\n").split("\n");
  if (list.at(-1) === "") list.pop();
  return list;
}

/** A linear-space line diff. Common edges are peeled before finding the next shared line,
 * avoiding an N×M matrix for large writes. Equal-distance anchors prefer removals. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before), b = lines(after);
  const positions = new Map<string, number[]>();
  b.forEach((line, i) => { const at = positions.get(line) ?? []; at.push(i); positions.set(line, at); });
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  const remove = () => out.push({ kind: "remove", text: a[i]!, old: ++i, next: null });
  const add = () => out.push({ kind: "add", text: b[j]!, old: null, next: ++j });
  const context = () => out.push({ kind: "context", text: a[i]!, old: ++i, next: ++j });
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { context(); continue; }
    let anchor: { i: number; j: number; distance: number } | null = null;
    for (let k = i; k < a.length; k++) {
      if (anchor && k - i > anchor.distance) break;
      const candidates = positions.get(a[k]!);
      if (!candidates) continue;
      // Binary search: the same repeated line can occur thousands of times.
      let lo = 0, hi = candidates.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (candidates[mid]! < j) lo = mid + 1; else hi = mid; }
      const next = candidates[lo];
      if (next === undefined) continue;
      const distance = k - i + next - j;
      if (!anchor || distance < anchor.distance) anchor = { i: k, j: next, distance };
    }
    if (!anchor) { while (i < a.length) remove(); while (j < b.length) add(); break; }
    while (i < anchor.i) remove();
    while (j < anchor.j) add();
  }
  while (i < a.length) remove();
  while (j < b.length) add();
  // A changed final newline is a real edit, even if every visible line is equal.
  if (before !== after && before.endsWith("\n") !== after.endsWith("\n") && a.length && b.length && a.at(-1) === b.at(-1)) {
    const last = out.at(-1);
    if (last?.kind === "context") out.splice(out.length - 1, 1,
      { kind: "remove", text: last.text + (before.endsWith("\n") ? "" : "\n\\ No newline at end of file"), old: last.old, next: null },
      { kind: "add", text: last.text + (after.endsWith("\n") ? "" : "\n\\ No newline at end of file"), old: null, next: last.next });
  }
  return out;
}

export function toolDiffs(name: string, input: Record<string, unknown> | null): ToolDiff[] {
  if (!input || !["Edit", "MultiEdit", "Write"].includes(name)) return [];
  const path = stringField(input, "file_path") || stringField(input, "path") || "file";
  const edits = name === "MultiEdit" && Array.isArray(input.edits) ? input.edits.map(record).filter(e => e !== null) : [input];
  return edits.map(edit => {
    const before = name === "Write" ? stringField(edit, "old_content") : stringField(edit, "old_string");
    const after = name === "Write" ? stringField(edit, "content") : stringField(edit, "new_string");
    const diff = diffLines(before, after);
    return { path, header: `@@ -${before ? 1 : 0},${lines(before).length} +${after ? 1 : 0},${lines(after).length} @@`, lines: diff };
  });
}
export function changeCount(name: string, input: Record<string, unknown> | null): ChangeCount {
  return toolDiffs(name, input).flatMap(d => d.lines).reduce((sum, line) => ({
    added: sum.added + Number(line.kind === "add"), removed: sum.removed + Number(line.kind === "remove"),
  }), { added: 0, removed: 0 });
}

export interface ActivityTool extends ToolCall { result?: { ok: boolean } }
export type SummaryRow =
  | { type: "tool"; tool: ActivityTool }
  /** A worker. `call` is the Agent call it came from; `background` says it was started in the background (its call may not say so). */
  | { type: "subagent"; status: "running" | "done" | "failed" | "stopped"; call?: ActivityTool; description?: string; background?: boolean };
/** A background worker's end, as the group it arrived in counts it ("완료함 백그라운드 에이전트 1개"). */
export interface FinishedAgent { id: string; status: "done" | "failed" | "stopped"; description: string }
export type Language = "ko" | "en";

// The wording of the Claude desktop app's Code tab, read from its UI bundle (ion-dist.asar, 2026-11-13):
// the summary line of a folded group (a function that builds {verb, meta} parts and joins them as
// "verb meta, verb meta"), and the verb every call row opens with. Strings are the app's own
// (ko-KR / en-US catalogs); the code is ours.
type Pair = readonly [ko: string, en: string];
const pick = (pair: Pair, language: Language): string => pair[language === "ko" ? 0 : 1];
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
const upperFirst = (text: string, language: Language): string => text.charAt(0).toLocaleUpperCase(language) + text.slice(1);
/** The app lowercases an English group word ("Used easel" → "used easel") unless its first word has a capital inside. */
const groupWord = (text: string, language: Language): string => language !== "en" || /^\S+\p{Lu}/u.test(text) ? text : lowerFirst(text);

interface Verbs { done: Pair; running: Pair; failed?: Pair; /** what the folded line says when it differs from `done`/`running` */ group?: { done: Pair; running: Pair } }
const bash: Verbs = { done: ["실행함", "Ran"], running: ["실행 중", "Running"], failed: ["실행 실패", "Failed to run"] };
const edit: Verbs = { done: ["편집됨", "Edited"], running: ["편집 중", "Editing"], failed: ["편집 실패", "Failed to edit"] };
const stopTask: Verbs = { done: ["작업 중지됨", "Stopped task"], running: ["작업 중지 중", "Stopping task"], failed: ["작업 중지 실패", "Failed to stop task"] };
const VERBS: Record<string, Verbs> = {
  Bash: bash, BashTool: bash, PowerShell: bash,
  Read: { done: ["읽음", "Read"], running: ["읽는 중", "Reading"], failed: ["읽기 실패", "Failed to read"] },
  Write: { done: ["생성됨", "Created"], running: ["생성 중", "Creating"], failed: ["쓰기 실패", "Failed to write"] },
  Edit: edit, MultiEdit: edit, NotebookEdit: edit,
  Grep: { done: ["검색됨", "Searched"], running: ["검색 중", "Searching"], failed: ["검색 실패", "Failed to search"] },
  Glob: { done: ["파일 검색됨", "Searched files"], running: ["파일 검색 중", "Searching files"], failed: ["파일 검색 실패", "Failed to search files"] },
  LS: {
    done: ["목록 조회됨", "Listed"], running: ["목록 조회 중", "Listing"], failed: ["목록 조회 실패", "Failed to list"],
    group: { done: ["파일 목록 조회됨", "Listed files"], running: ["파일 목록 가져오는 중", "Listing files"] },
  },
  WebFetch: { done: ["가져옴", "Fetched"], running: ["가져오는 중", "Fetching"], failed: ["가져오기 실패", "Failed to fetch"] },
  WebSearch: { done: ["웹 검색함", "Searched web"], running: ["웹 검색 중", "Searching web"], failed: ["웹 검색 실패", "Failed to search web"] },
  Task: { done: ["에이전트 실행함", "Ran agent"], running: ["에이전트 실행 중", "Running agent"], failed: ["에이전트 실행 실패", "Failed to run agent"] },
  Agent: { done: ["에이전트 실행함", "Ran agent"], running: ["에이전트 실행 중", "Running agent"], failed: ["에이전트 실행 실패", "Failed to run agent"] },
  Skill: { done: ["Skill 실행됨", "Ran skill"], running: ["Skill 실행 중", "Running skill"], failed: ["Skill 실행 실패", "Failed to run skill"] },
  TodoWrite: { done: ["할 일 업데이트됨", "Updated todos"], running: ["할 일 업데이트 중", "Updating todos"] },
  ToolSearch: { done: ["도구 로드됨", "Loaded tools"], running: ["도구 로드 중", "Loading tools"], failed: ["도구를 불러오지 못했습니다", "Failed to load tools"] },
  TaskStop: stopTask, KillShell: stopTask, KillBash: stopTask,
  TaskCreate: { done: ["작업 추가됨", "Added task"], running: ["작업 추가 중", "Adding task"], failed: ["작업 추가 실패", "Failed to add task"] },
  TaskUpdate: { done: ["작업 업데이트됨", "Updated task"], running: ["작업 업데이트 중", "Updating task"], failed: ["작업 업데이트 실패", "Failed to update task"] },
  TaskGet: { done: ["작업 읽음", "Read task"], running: ["작업 읽는 중", "Reading task"], failed: ["작업을 읽지 못했습니다", "Failed to read task"] },
  TaskList: { done: ["작업 나열됨", "Listed tasks"], running: ["작업 목록 표시 중", "Listing tasks"], failed: ["작업 목록을 불러오지 못했습니다", "Failed to list tasks"] },
  TaskOutput: { done: ["작업 출력 읽음", "Read task output"], running: ["작업 출력 읽는 중", "Reading task output"], failed: ["작업 출력 읽기 실패", "Failed to read task output"] },
  EnterPlanMode: { done: ["계획 시작됨", "Started planning"], running: ["계획 수립 중", "Making a plan"], failed: ["계획 시작에 실패했습니다.", "Failed to start planning"] },
  ExitPlanMode: { done: ["계획 제안됨", "Proposed plan"], running: ["계획 제안 중", "Proposing plan"], failed: ["계획 제안 실패", "Failed to propose plan"] },
  AskUserQuestion: {
    done: ["요청됨", "Asked"], running: ["질문 중", "Asking"], failed: ["질문을 전송하지 못했습니다", "Failed to ask a question"],
    group: { done: ["질문함", "Asked a question"], running: ["질문함", "Asked a question"] },
  },
  Monitor: { done: ["모니터링 시작됨", "Started watching"], running: ["감시 중", "Watching"], failed: ["감시를 시작하지 못했습니다", "Failed to start watching"] },
  Workflow: { done: ["워크플로 실행됨", "Ran workflow"], running: ["워크플로우 실행 중", "Running workflow"], failed: ["워크플로우 실행 실패", "Failed to run workflow"] },
};

// Humanising a tool id the app's way: "draw_shapes" → "draw shapes", "CustomTool" → "custom tool".
function humanize(name: string): string {
  if (/\s/.test(name)) return name;
  const flat = name.replace(/_+|:/g, "_");
  const base = /[a-z]/.test(flat) ? flat : flat.toLowerCase();
  const words = (/[_.\-\s]/.test(base) ? base : base.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).split(/[_.\-\s]+/).filter(Boolean);
  const [first] = words;
  if (first === undefined) return flat;
  const joined = words.map(word => /[A-Z]/.test(word.slice(1)) ? word : word.toLowerCase()).join(" ");
  return lowerFirst(/[A-Z]/.test(first.slice(1)) ? joined : joined.charAt(0).toUpperCase() + joined.slice(1));
}
/** `mcp__<server>__<tool>`: the tool is whatever follows the last `__`. */
function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5).replace(/_+$/, "");
  const at = rest.lastIndexOf("__");
  if (at <= 0) return null;
  const server = rest.slice(0, at).replace(/^_+|_+$/g, ""), tool = rest.slice(at + 2);
  return server && tool ? { server, tool } : null;
}
/** A server as a person reads it. The app asks its server registry; the phone has only the id, where a plugin's
 * server arrives as `plugin_<plugin>_<server>`: "plugin_easel_easel" reads "easel". */
function serverName(id: string): string {
  const plugin = /^plugin_(.+)$/.exec(id)?.[1];
  const twice = plugin === undefined ? null : /^(.+)_\1$/.exec(plugin)?.[1];
  return (twice ?? plugin ?? id).replace(/_+/g, " ");
}
/** What the app calls a tool that has no wording of its own: "easel: draw shapes", or "custom tool". */
function activityLabel(name: string): string {
  const mcp = mcpParts(name);
  if (mcp) return `${serverName(mcp.server)}: ${humanize(mcp.tool)}`;
  if (name.startsWith("mcp__")) return (name.split("__").filter(Boolean).pop() ?? name).replace(/_/g, " ");
  const colon = name.lastIndexOf(":");
  return colon > 0 ? `${name.slice(0, colon)}: ${humanize(name.slice(colon + 1))}` : humanize(name);
}
/** The server (or `prefix:`) a label opens with: the app's folded line says only that. */
function labelServer(name: string): string | undefined {
  const mcp = mcpParts(name);
  if (mcp) return serverName(mcp.server);
  const colon = name.lastIndexOf(":");
  return !name.startsWith("mcp__") && colon > 0 ? name.slice(0, colon) : undefined;
}
const used = (label: string, language: Language): { done: string; running: string; failed: string } => language === "ko"
  ? { done: `${label} 사용함`, running: `${label} 사용 중`, failed: `${label} 사용 실패` }
  : { done: `Used ${label}`, running: `Using ${label}`, failed: `Failed to use ${label}` };

/** The word a call row opens with, as the Claude app words it: "읽음" / "읽는 중" / "읽기 실패". */
export function toolVerb(name: string, state: "done" | "running" | "failed", language: Language): string {
  const verbs = VERBS[name];
  if (verbs) return pick(state === "failed" ? verbs.failed ?? ["실패", "Failed"] : verbs[state], language);
  return used(activityLabel(name), language)[state];
}

/** The tools the app folds into a counted phrase ("읽음 파일 2개"); every other tool is worded by what it is. */
type Category = "read" | "write" | "edit" | "notebook" | "bash" | "grep" | "glob" | "web" | "fetch" | "task" | "todo" | "plan";
const CATEGORY: Record<string, Category> = {
  read: "read", write: "write", edit: "edit", multi_edit: "edit", notebook_edit: "notebook", bash: "bash", bash_tool: "bash", power_shell: "bash",
  grep: "grep", glob: "glob", web_search: "web", web_fetch: "fetch", task: "task", agent: "task", todo_write: "todo", exit_plan_mode: "plan",
};
function categoryOf(name: string): Category | undefined {
  const tool = (mcpParts(name)?.tool ?? name.replace(/_+$/, "").split("__").filter(Boolean).pop() ?? name).replace(/^_+/, "") || name;
  return CATEGORY[tool.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()];
}
const FILE_CATEGORIES: ReadonlySet<Category> = new Set(["read", "write", "edit", "notebook"]);
const isAgent = (name: string): boolean => name === "Agent" || name === "Task";
const count = (n: number, one: string, many: string): string => n === 1 ? one : `${n} ${many}`;
const WORDS: Record<Category | "unnamed" | "background", { verb: Pair; meta: (n: number) => Pair }> = {
  read: { verb: ["읽음", "read"], meta: n => [`파일 ${n}개`, count(n, "a file", "files")] },
  write: { verb: ["생성됨", "created"], meta: n => [`파일 ${n}개`, count(n, "a file", "files")] },
  edit: { verb: ["편집함", "edited"], meta: n => [`파일 ${n}개`, count(n, "a file", "files")] },
  notebook: { verb: ["편집함", "edited"], meta: n => [`노트북 ${n}개`, count(n, "a notebook", "notebooks")] },
  bash: { verb: ["실행됨", "ran"], meta: n => [`명령 ${n}개`, count(n, "a command", "commands")] },
  grep: { verb: ["검색함", "searched"], meta: () => ["코드", "code"] },
  glob: { verb: ["검색함", "searched"], meta: () => ["파일", "for files"] },
  web: { verb: ["검색함", "searched"], meta: n => [`웹 ${n}회`, n === 1 ? "the web" : `the web ${n} times`] },
  fetch: { verb: ["가져옴", "fetched"], meta: n => [`페이지 ${n}개`, count(n, "a page", "pages")] },
  task: { verb: ["실행됨", "ran"], meta: n => [`에이전트 ${n}개`, count(n, "an agent", "agents")] },
  todo: { verb: ["업데이트됨", "updated"], meta: () => ["할 일", "todos"] },
  plan: { verb: ["제안함", "proposed"], meta: () => ["계획", "a plan"] },
  unnamed: { verb: ["사용함", "used"], meta: n => [`도구 ${n}개`, count(n, "a tool", "tools")] },
  background: { verb: ["완료함", "finished"], meta: n => [`백그라운드 에이전트 ${n}개`, n === 1 ? "a background agent" : `${n} background agents`] },
};

type Status = "succeeded" | "failed" | "stopped" | "pending";
interface Call { id: string; name: string; summary: string; input: Record<string, unknown> | null; status: Status; /** a worker started in the background */ background: boolean; worker: boolean; description: string }
function callOf(row: SummaryRow, index: number): Call {
  const tool = row.type === "tool" ? row.tool : row.call;
  const name = tool?.name ?? "Agent", input = toolInput(tool?.input);
  const status: Status = row.type === "tool" ? (tool?.result ? tool.result.ok ? "succeeded" : "failed" : "pending")
    : row.status === "running" ? "pending" : row.status === "done" ? "succeeded" : row.status;
  return {
    id: tool?.id ?? `#${index}`, name, summary: tool?.summary ?? "", input, status, worker: row.type === "subagent",
    background: isAgent(name) && (input?.run_in_background === true || (row.type === "subagent" && row.background === true)), description: row.type === "subagent" ? row.description ?? "" : "",
  };
}
const filePathOf = (input: Record<string, unknown> | null): string => stringField(input, "file_path") || stringField(input, "notebook_path");
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
/** A later call on the same file replaces an earlier one's status; a stop never replaces a known status; an open call clears it. */
const settle = (before: Status | undefined, next: Status): Status | undefined => next === "stopped" && before !== undefined ? before : next === "pending" ? undefined : next;
const tally = (statuses: Iterable<Status | undefined>, which: Status): number => [...statuses].filter(status => status === which).length;

interface Part { verb: string; meta: string; count: number; failed?: number }
/** "(1개 실패)", "(중지됨 1개)": how many of a part's calls failed or were stopped. */
function outcome(part: Part, failed: number, stopped: number, language: Language): Part {
  if (failed === 0 && stopped === 0) return part;
  const note = language === "ko"
    ? failed === 0 ? `(중지됨 ${stopped}개)` : stopped === 0 ? `(${failed}개 실패)` : `(${failed}개 실패, ${stopped}개 중지됨)`
    : failed === 0 ? `(${stopped} stopped)` : stopped === 0 ? `(${failed} failed)` : `(${failed} failed, ${stopped} stopped)`;
  return { ...part, meta: part.meta ? `${part.meta} ${note}` : note, ...(failed > 0 ? { failed } : {}) };
}
const wordsPart = (kind: keyof typeof WORDS, n: number, language: Language): Part => ({ verb: pick(WORDS[kind].verb, language), meta: pick(WORDS[kind].meta(n), language), count: n });
/** "a and b", "a, b and c" (ko) / "a, b, and c" (en): the app's list of verbs when one file took several. */
function list(items: readonly string[], language: Language): string {
  if (items.length < 2) return items[0] ?? "";
  const last = items.at(-1)!, head = items.slice(0, -1);
  if (language === "ko") return items.length === 2 ? `${head[0]} 및 ${last}` : `${head.join(", ")} 및 ${last}`;
  return items.length === 2 ? `${head[0]} and ${last}` : `${head.join(", ")}, and ${last}`;
}
/** A folded line shows three parts; with five or more it keeps three and counts the rest ("그 외 작업 2개"). */
const SHOWN = 3;
function limit(parts: Part[], language: Language): Part[] {
  if (parts.length < SHOWN + 2) return parts;
  const rest = parts.slice(SHOWN), total = rest.reduce((sum, part) => sum + part.count, 0), failed = rest.reduce((sum, part) => sum + (part.failed ?? 0), 0);
  const label = language === "ko" ? `그 외 작업 ${total}개` : `and ${total} more ${total === 1 ? "action" : "actions"}`;
  return [...parts.slice(0, SHOWN), outcome({ verb: label, meta: "", count: total }, failed, 0, language)];
}

/** What a running call adds after its verb: the file, the pattern, the command's own description. */
function captionMeta(call: Call): string {
  const input = call.input, category = categoryOf(call.name);
  if (category && FILE_CATEGORIES.has(category)) return baseName(filePathOf(input) || call.summary);
  switch (category) {
    case "bash": return stringField(input, "description") || call.summary;
    case "grep": case "glob": return stringField(input, "pattern") || call.summary;
    case "web": return stringField(input, "query") || call.summary;
    case "fetch": return /^https?:\/\/([^/]+)/.exec(stringField(input, "url"))?.[1] ?? call.summary;
    case "task": return stringField(input, "description") || stringField(input, "subagent_type") || call.description || call.summary;
    default: return call.name === "Skill" && stringField(input, "skill") ? `/${stringField(input, "skill")}` : "";
  }
}

/**
 * The line a folded group of calls wears, as the Claude app's Code tab words it ("읽음 파일 2개, easel 사용함,
 * 완료함 백그라운드 에이전트 1개"): one "verb meta" part per kind of call, kinds in the order they first appear,
 * then the other tools by name ("easel 사용함", counted "N회" when repeated), then the unnamed ones
 * ("사용함 도구 N개"), then the finished background agents; the first verb capitalised (English), parts
 * joined with ", ", five or more cut to three and "그 외 작업 N개". A file, not a call, is counted;
 * one file alone is named ("읽음 foo.ts"). While a call runs, the line is that call's own words ("읽는 중 foo.ts").
 *
 * Not in the phone's data: whether a Write replaced a file (the app then says "편집함"), a call the person
 * declined or a policy blocked (the app counts those apart), and the server registry's name for an MCP server.
 */
export function activitySummary(rows: readonly SummaryRow[], running: boolean, language: Language, finished: readonly FinishedAgent[] = []): ChangeCount & { text: string; failed: boolean } {
  const calls = rows.map(callOf);
  let added = 0, removed = 0;
  rows.forEach(row => {
    if (row.type !== "tool") return;
    const changes = row.tool.changes ?? changeCount(row.tool.name, toolInput(row.tool.input));
    added += changes.added; removed += changes.removed;
  });
  const failed = calls.some(call => call.status === "failed");

  const categories = new Map<Category, Map<string, Status | undefined>>();
  const named = new Map<string, { count: number; failed: number; done: string; running: string }>();
  const files = { paths: new Set<string>(), pathless: false, calls: [] as { category: Category; path: string; status: Status }[] };
  const unnamed = { count: 0, failed: 0 };
  for (const call of calls) {
    const category = categoryOf(call.name);
    if (category) {
      const path = filePathOf(call.input);
      const key = path || (FILE_CATEGORIES.has(category) ? call.summary : "") || call.id;
      const statuses = categories.get(category) ?? new Map<string, Status | undefined>();
      categories.set(category, statuses);
      statuses.set(key, settle(statuses.get(key), call.status));
      if (FILE_CATEGORIES.has(category)) {
        if (path) files.paths.add(path); else files.pathless = true;
        files.calls.push({ category, path, status: call.status });
      }
      continue;
    }
    // A call still open has no name of its own yet: it counts with the unnamed tools until it settles.
    if (call.status === "pending") { unnamed.count++; continue; }
    const verbs = VERBS[call.name], server = labelServer(call.name), label = activityLabel(call.name);
    const words = verbs?.group
      ? { done: pick(verbs.group.done, language), running: pick(verbs.group.running, language) }
      : verbs ? { done: pick(verbs.done, language), running: pick(verbs.running, language) }
      : server !== undefined && label.startsWith(`${server}: `) ? used(server, language) : used(label, language);
    const entry = named.get(groupWord(words.done, language)) ?? { count: 0, failed: 0, done: groupWord(words.done, language), running: groupWord(words.running, language) };
    entry.count++; entry.failed += Number(call.status === "failed");
    named.set(entry.done, entry);
  }

  // Several kinds of file call on one path read as one part: "읽음 및 편집함 foo.ts".
  const fileCategories = [...categories.keys()].filter(category => FILE_CATEGORIES.has(category));
  const verbGroups = new Map<string, Category[]>();
  for (const category of fileCategories) {
    const verb = pick(WORDS[category].verb, language);
    verbGroups.set(verb, [...verbGroups.get(verb) ?? [], category]);
  }
  const [onlyPath] = files.paths;
  const merged = (group: Category[]): Map<string, Status | undefined> => {
    const byPath = new Map<string, Status | undefined>();
    for (const call of files.calls) if (group.includes(call.category)) byPath.set(call.path, settle(byPath.get(call.path), call.status));
    return byPath;
  };
  for (const group of verbGroups.values()) {
    if (group.length < 2) continue;
    const byPath = merged(group);
    for (const category of group) for (const [path, status] of byPath) if (categories.get(category)?.has(path)) categories.get(category)!.set(path, status);
  }
  let single: Part | undefined;
  if (fileCategories.length > 0 && !files.pathless && files.paths.size === 1 && onlyPath !== undefined) {
    const states = [...verbGroups.values()].map(group => merged(group).get(onlyPath));
    single = outcome({ verb: list([...verbGroups.keys()], language), meta: baseName(onlyPath), count: verbGroups.size }, tally(states, "failed"), tally(states, "stopped"), language);
  }

  const parts: Part[] = [];
  for (const [category, statuses] of categories) {
    if (single && FILE_CATEGORIES.has(category)) {
      if (category === fileCategories[0]) parts.push(single);
      continue;
    }
    parts.push(outcome(wordsPart(category, statuses.size, language), tally(statuses.values(), "failed"), tally(statuses.values(), "stopped"), language));
  }
  for (const entry of named.values()) {
    // Calls that all failed read as the unfinished wording ("easel 사용 중 (1개 실패)"), as in the app.
    const words = entry.failed === entry.count ? entry.running : entry.done;
    parts.push(outcome({ verb: entry.count > 1 ? (language === "ko" ? `${words} ${entry.count}회` : `${words} ${entry.count} times`) : words, meta: "", count: entry.count }, entry.failed, 0, language));
  }
  if (unnamed.count > 0) parts.push(outcome(wordsPart("unnamed", unnamed.count, language), unnamed.failed, 0, language));
  // The ends that arrived in this group. A worker that failed shows its failure on its own call when that call
  // is in this group too, so the app counts such a notice as an ordinary finish rather than twice.
  let shown = calls.filter(call => call.background && call.worker && call.status === "failed").length;
  const chips: Status[] = finished.map(end => end.status === "done" ? "succeeded" : end.status === "failed" ? shown-- > 0 ? "succeeded" : "failed" : "stopped");
  if (chips.length > 0) {
    const chip = outcome(wordsPart("background", chips.length, language), tally(chips, "failed"), tally(chips, "stopped"), language);
    // A worker that failed is told first; the others close the line.
    if (chips.includes("failed")) parts.unshift(chip); else parts.push(chip);
  }

  const line = limit(parts, language).map((part, i) => {
    const verb = i === 0 ? upperFirst(part.verb, language) : part.verb, meta = part.meta.trim();
    return meta ? `${verb} ${meta}` : verb;
  }).join(", ");
  const live = running ? [...calls].reverse().find(call => call.status === "pending") : undefined;
  const meta = live && captionMeta(live);
  const text = live ? [toolVerb(live.name, "running", language), meta].filter(Boolean).join(" ") : line;
  return { text, added, removed, failed };
}

export function numberedRead(text: string, input: Record<string, unknown> | null): { number: number; text: string }[] {
  const offset = typeof input?.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 1;
  return lines(text).map((line, i) => {
    const match = /^\s*(\d+)[→\t](.*)$/.exec(line);
    return match ? { number: Number(match[1]), text: match[2]! } : { number: offset + i, text: line };
  });
}
export function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
export function webLinks(text: string): { title: string; url: string }[] {
  const out = new Map<string, string>();
  const add = (url: string, title: string) => { if (/^https?:\/\//.test(url)) out.set(url, title || url); };
  function walk(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const obj = record(value);
    if (!obj) return;
    const url = stringField(obj, "url") || stringField(obj, "link");
    if (url) add(url, stringField(obj, "title") || stringField(obj, "name"));
    Object.values(obj).forEach(v => { if (typeof v === "object") walk(v); });
  }
  try { walk(JSON.parse(text)); } catch { /* Text/Markdown output is normal. */ }
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) add(match[2]!, match[1]!);
  for (const match of text.matchAll(/https?:\/\/[^\s<>"\])]+/g)) { const url = match[0].replace(/[.,;]+$/, ""); if (!out.has(url)) add(url, url); }
  return [...out].map(([url, title]) => ({ title, url }));
}
