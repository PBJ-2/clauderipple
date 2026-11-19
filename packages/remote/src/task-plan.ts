// Successful task tools → one ordered task list. No transport, UI or filesystem dependencies.
import type { EventBody, PlanStep, Text } from "./protocol.ts";
import { toolInput } from "./tool-details.ts";
import { WRAP_TOOL } from "./wrap-up.ts";

type Input = Record<string, unknown>;
const object = (value: unknown): Input | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Input : null;
const words = (value: unknown): string => typeof value === "string" ? value : "";
const idOf = (value: unknown): string => typeof value === "string" || typeof value === "number" ? String(value) : "";
const statusOf = (value: unknown): PlanStep["status"] => value === "completed" || value === "in_progress" ? value : "pending";
const PLAN_TOOL = "mcp__ccd_turn__update_plan";
export const isTaskTool = (name: string): boolean => [PLAN_TOOL, "update_plan", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList"].includes(name);
/** Calls that move the list: the task tools, and the Code tab's wrap_up, which checks its plan off. */
const tracked = (name: string): boolean => isTaskTool(name) || name === WRAP_TOOL;
const perTurn = (name: string): boolean => name === PLAN_TOOL || name === "update_plan" || name === WRAP_TOOL;

/** Code's indexed edits and the replacement lists used by Code and translated providers. */
export function nextPlan(steps: PlanStep[] | null, input: Input): PlanStep[] | null {
  const replacement = Array.isArray(input.items) ? input.items : Array.isArray(input.plan) ? input.plan : null;
  if (replacement) return replacement.flatMap((value): PlanStep[] => {
    const item = object(value);
    const text = words(item?.content) || words(item?.step);
    return text.trim() ? [{ text, status: statusOf(item?.status) }] : [];
  });
  if (!steps) return null;
  const next = steps.map(step => ({ ...step }));
  const step = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= next.length ? next[n - 1] : undefined;
  for (const n of Array.isArray(input.done) ? input.done : []) { const done = step(n); if (done) done.status = "completed"; }
  const start = step(input.start);
  if (start) start.status = "in_progress";
  if (input.advance === true || input.advance === "true") {
    const at = next.findIndex(s => s.status === "in_progress");
    const current = next[at];
    if (current) current.status = "completed";
    const following = next.find((s, i) => i > at && s.status === "pending") ?? next.find(s => s.status === "pending");
    if (following) following.status = "in_progress";
  }
  return next;
}

function task(value: unknown): PlanStep | null {
  const item = object(value);
  const id = idOf(item?.id ?? item?.taskId);
  const text = words(item?.subject) || words(item?.content);
  if (!id || !text.trim() || item?.status === "deleted") return null;
  return { id, text, status: statusOf(item?.status) };
}
function resultValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; } // A task tool can return human-readable text instead of JSON.
}
function taskList(text: string): PlanStep[] | null {
  const value = resultValue(text);
  const list = Array.isArray(value) ? value : object(value)?.tasks;
  if (Array.isArray(list)) {
    const parsed = list.map(task);
    // An unreadable authoritative list is not an empty list; preserve the last confirmed state.
    return parsed.some(item => item === null) ? null : parsed.filter((item): item is PlanStep => item !== null);
  }
  if (/^\s*No tasks found\.?\s*$/i.test(text)) return [];
  const lines = text.trim().split("\n");
  const parsed = lines.map(line => /^#([\w-]+)\s+\[(pending|in_progress|completed)\]\s+(.+)$/.exec(line));
  if (!parsed.length || parsed.some(line => line === null)) return null;
  return parsed.flatMap(line => line ? [{ id: line[1]!, text: line[3]!, status: statusOf(line[2]) }] : []);
}

/** The steps a phone shows: a list with every step done is finished work, so none (2026-11-20: a
 * checked-off plan stayed under the last message for hours after the turn). */
export function shownPlan(steps: PlanStep[]): PlanStep[] {
  return steps.every(step => step.status === "completed") ? [] : steps;
}

export class TaskPlan {
  private calls = new Map<string, { name: string; input: Input }>();
  private applied = new Set<string>();
  private steps: PlanStep[] = [];
  private source = "";
  version = 0;
  get list(): PlanStep[] { return this.steps.map(step => ({ ...step })); }

  /** A new human turn clears Code's per-turn plan, not session-scoped TaskCreate/TodoWrite work. */
  newTurn(): void {
    for (const [id, call] of this.calls) {
      if (!perTurn(call.name)) continue;
      this.calls.delete(id);
      this.applied.add(id);
    }
    if (this.source === PLAN_TOOL || this.source === "update_plan") this.replace([], this.source);
  }
  call(id: string, name: string, input: Input): void {
    if (tracked(name) && !this.applied.has(id)) this.calls.set(id, { name, input });
  }
  result(id: string, ok: boolean, text: string): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    this.applied.add(id);
    if (!ok) return;
    const { name, input } = call;
    if (name === PLAN_TOOL || name === "update_plan") {
      this.replace(nextPlan(this.steps, input) ?? [], name);
    } else if (name === WRAP_TOOL) {
      // The Code tab checks its plan off when the turn wraps up, so a turn that ends without a last
      // advance shows done there (2026-10-27: a phone kept "1 in progress, 0/3" after the turn ended).
      if (this.source === PLAN_TOOL) this.replace(this.steps.map(step => ({ ...step, status: "completed" })), PLAN_TOOL);
    } else if (name === "TodoWrite" && Array.isArray(input.todos)) {
      this.replace(input.todos.flatMap((value): PlanStep[] => {
        const item = object(value);
        const text = words(item?.content);
        return text.trim() ? [{ text, status: statusOf(item?.status) }] : [];
      }), name);
    } else if (name === "TaskCreate") {
      const value = object(resultValue(text));
      const created = task(value?.task ?? value);
      const id = created?.id || /Task\s+#([\w-]+)\s+created successfully\b/i.exec(text)?.[1];
      const subject = created?.text || words(input.subject);
      if (id && subject.trim()) this.replace([...this.steps.filter(step => step.id !== id), { id, text: subject, status: created?.status ?? "pending" }], name);
    } else if (name === "TaskUpdate") {
      const id = idOf(input.taskId);
      if (!id || !this.steps.some(step => step.id === id)) return;
      const list = input.status === "deleted" ? this.steps.filter(step => step.id !== id) : this.steps.map((step): PlanStep => step.id === id ? { ...step, ...(typeof input.subject === "string" ? { text: input.subject } : {}), ...(input.status === "pending" || input.status === "in_progress" || input.status === "completed" ? { status: input.status } : {}) } : step);
      this.replace(list, name);
    } else if (name === "TaskList") {
      const list = taskList(text);
      if (list) this.replace(list, name);
    }
  }

  /** Replaying durable events also resolves externalized input/result strings through the caller's log. */
  accept(event: EventBody, load: (text: Text) => string): void {
    if (event.kind === "user") this.newTurn();
    if (event.kind === "assistant") for (const tool of event.tools) {
      if (!tracked(tool.name) || tool.input === undefined) continue;
      const input = toolInput(load(tool.input));
      if (input) this.call(tool.id, tool.name, input);
    }
    if (event.kind === "tool_result" && this.calls.has(event.toolUseId)) this.result(event.toolUseId, event.ok, load(event.text));
  }

  private replace(steps: PlanStep[], source: string): void {
    this.source = source;
    if (JSON.stringify(steps) === JSON.stringify(this.steps)) return;
    this.steps = steps;
    this.version++;
  }
}
