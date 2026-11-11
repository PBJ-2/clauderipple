// Confirmed background lifecycle shared by desktop transcript scans and SDK event replay.
import type { BackgroundTask, EventBody, Text } from "./protocol.ts";
import { record, stringField, toolInput } from "./tool-details.ts";

type Fields = Record<string, unknown>;
const idOf = (value: unknown): string => typeof value === "string" ? value : "";
const endState = (status: string): BackgroundTask["state"] => status === "completed" || status === "done" ? "done" : status === "failed" ? "failed" : status === "killed" || status === "stopped" ? "stopped" : undefined;
const parse = (text: string): Fields | null => { try { return record(JSON.parse(text)); } catch { return null; } };
const activityTools = new Set(["Agent", "Task", "Bash", "Monitor", "TaskStop", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup"]);

export class BackgroundActivity {
  private calls = new Map<string, { name: string; input: Fields }>();
  private entries = new Map<string, BackgroundTask>();
  private ended = new Set<string>();
  version = 0;
  known = false;
  at: number | null = null;
  get active(): BackgroundTask[] { return [...this.entries.values()].filter(task => task.state === "running").map(task => ({ ...task })); }
  get history(): BackgroundTask[] { return [...this.entries.values()].filter(task => task.state === "done" || task.state === "failed" || task.state === "stopped" || task.state === "unknown").slice(-40).reverse().map(task => ({ ...task })); }

  /** A dead/replaced query cannot confirm any of its old work is still running. */
  invalidate(): void {
    for (const task of this.active) this.put({ ...task, state: "unknown" });
    this.calls.clear();
    this.known = false;
  }

  call(id: string, name: string, input: Fields): void {
    if (activityTools.has(name)) this.calls.set(id, { name, input });
  }
  result(id: string, ok: boolean, text: string, at: number | null, structured?: Fields | null): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    if (!ok) return;
    const { name, input } = call;
    const result = structured ?? parse(text) ?? {};
    if (name === "TaskStop") { this.end(idOf(input.task_id) || idOf(input.shell_id), "stopped", at); return; }
    if (name === "CronDelete") { this.end(idOf(result.id) || idOf(input.id), "stopped", at); return; }
    if (name === "CronList" && Array.isArray(result.jobs)) {
      const listed = new Set<string>();
      for (const value of result.jobs) {
        const job = record(value), taskId = idOf(job?.id);
        if (!job || !taskId) continue;
        listed.add(taskId);
        this.put({ id: taskId, kind: "schedule", label: stringField(job, "prompt") || taskId, startedAt: at, state: "running", schedule: stringField(job, "cron") });
      }
      for (const task of this.active) if (task.kind === "schedule" && task.schedule && !listed.has(task.id)) this.end(task.id, "stopped", at);
      return;
    }
    if (name === "ScheduleWakeup") {
      if (result.stopped === true) { this.end("dynamic-wakeup", "stopped", at); return; }
      if (typeof result.scheduledFor === "number" && Number.isFinite(result.scheduledFor)) this.put({ id: "dynamic-wakeup", kind: "schedule", label: stringField(input, "reason") || stringField(input, "prompt") || name, command: stringField(input, "prompt"), startedAt: at, nextAt: result.scheduledFor, state: "running" });
      return;
    }
    if (name === "CronCreate" && typeof result.id === "string") {
      this.put({ id: result.id, kind: "schedule", label: stringField(input, "prompt") || name, startedAt: at, schedule: stringField(input, "cron"), state: "running" }); return;
    }
    const asyncAgent = result.isAsync === true || /(?:launched asynchronously|async(?: agent)? launched)/i.test(text);
    let taskId = name === "Monitor" ? idOf(result.taskId) : name === "Bash" ? idOf(result.backgroundTaskId) : asyncAgent ? idOf(result.agentId) || idOf(result.taskId) : "";
    if (!taskId && name === "Bash" && input.run_in_background === true) taskId = /(?:ID|id):\s*([\w-]+)/.exec(text)?.[1] ?? "";
    if (!taskId && asyncAgent) taskId = /(?:agentId|task[_ -]?id):\s*([\w-]+)/i.exec(text)?.[1] ?? "";
    if (!taskId || this.ended.has(taskId)) return;
    const kind = name === "Monitor" ? "monitor" : name === "Bash" ? "shell" : "agent";
    const command = stringField(input, "command") || stringField(record(input.ws), "url");
    const previous = [...this.entries.values()].find(task => task.sub === `sub-${id}`);
    if (previous && previous.id !== taskId) this.entries.delete(previous.id);
    this.put({ id: taskId, kind, label: stringField(input, "description") || command || name, startedAt: at, state: "running", ...(command ? { command } : {}), ...(kind === "agent" ? { sub: `sub-${id}` } : {}) });
  }

  notice(text: string, at: number | null): void {
    for (const [, body = ""] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1] ?? "";
      const state = endState(/<status>([^<]+)<\/status>/.exec(body)?.[1] ?? "");
      if (id && state) this.end(id, state, at);
    }
  }

  /** The SDK Stop hook supplies an authoritative inventory, including unknown engine task types. */
  inventory(value: Fields, at: number): void {
    if (Array.isArray(value.background_tasks)) {
      const listed = new Set<string>();
      for (const entry of value.background_tasks) {
        const task = record(entry), id = idOf(task?.id);
        if (!task || !id) continue;
        listed.add(id);
        const category = stringField(task, "type");
        const kind = category === "shell" ? "shell" : category === "subagent" ? "agent" : category === "monitor" ? "monitor" : category === "subscription" || category.endsWith("_subscription") ? "subscription" : "other";
        const previous = this.entries.get(id);
        this.put({ ...previous, id, kind, category, label: previous?.label ?? (stringField(task, "description") || id), startedAt: previous?.startedAt ?? null, state: endState(stringField(task, "status")) ?? "running", ...(typeof task.command === "string" && !previous?.command ? { command: task.command } : {}) });
      }
      // An absent task is no longer confirmed in flight, but its terminal result is still unknown.
      for (const task of this.active) if (task.kind !== "schedule" && !listed.has(task.id)) this.put({ ...task, state: "unknown" });
      this.known = true;
      this.at = at;
      this.version++;
    }
    if (Array.isArray(value.session_crons)) {
      const listed = new Set<string>();
      for (const entry of value.session_crons) {
        const job = record(entry), id = idOf(job?.id);
        if (!job || !id) continue;
        listed.add(id);
        const previous = this.entries.get(id);
        this.put({ ...previous, id, kind: "schedule", label: previous?.label ?? (stringField(job, "prompt") || id), startedAt: previous?.startedAt ?? null, state: "running", schedule: stringField(job, "schedule") });
      }
      for (const task of this.active) if (task.kind === "schedule" && !listed.has(task.id)) this.end(task.id, "stopped", at);
    }
  }

  accept(event: EventBody & { at?: number }, load: (text: Text) => string): void {
    const at = event.at ?? null;
    if (event.kind === "assistant") for (const tool of event.tools) {
      if (!activityTools.has(tool.name) || tool.input === undefined) continue;
      const input = toolInput(load(tool.input));
      if (input) this.call(tool.id, tool.name, input);
    }
    if (event.kind === "tool_result" && this.calls.has(event.toolUseId)) this.result(event.toolUseId, event.ok, load(event.text), at);
    if (event.kind === "user") this.notice(event.text, at);
    if (event.kind === "subagent") {
      const old = [...this.entries.values()].find(task => task.sub === event.sub);
      const model = event.model ?? old?.model;
      const effort = event.effort ?? old?.effort;
      const modelLabel = event.modelLabel ?? old?.modelLabel;
      this.put({ id: old?.id ?? event.toolUseId, kind: "agent", label: event.description, startedAt: old?.startedAt ?? at, sub: event.sub, state: event.status, ...(model ? { model } : {}), ...(modelLabel ? { modelLabel } : {}), ...(effort ? { effort } : {}) });
    }
    if (event.kind === "background") {
      for (const task of event.tasks) this.put(task);
      this.known = event.known; this.at = event.at ?? null; this.version++;
    }
    if (event.kind === "notice" && (event.code === "host_restarted" || event.code === "interrupted")) {
      this.invalidate();
    }
  }

  private end(id: string, state: BackgroundTask["state"], at: number | null): void {
    this.ended.add(id);
    const task = this.entries.get(id);
    if (task) this.put({ ...task, state: state ?? "unknown", ...(at === null ? {} : { endedAt: at }) });
  }
  private put(task: BackgroundTask): void {
    if (JSON.stringify(this.entries.get(task.id)) === JSON.stringify(task)) return;
    this.entries.set(task.id, task); this.version++;
    const terminal = [...this.entries.values()].filter(item => item.state === "done" || item.state === "failed" || item.state === "stopped");
    for (const old of terminal.slice(0, Math.max(0, terminal.length - 40))) this.entries.delete(old.id);
  }
}
