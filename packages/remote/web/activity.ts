import type { BackgroundTask } from "../src/protocol.ts";
import type { TimelineItem, WorkerItem } from "./timeline.ts";
import type { Key } from "./i18n.ts";

export function activityStateKey(task: BackgroundTask): Key {
  if (task.state === "unknown") return "tasks.unknown";
  if (!task.state || task.state === "running") {
    if (task.kind === "schedule") return "tasks.scheduled";
    if (task.kind === "monitor") return "tasks.monitoring";
    if (task.kind === "subscription") return "tasks.subscribed";
  }
  return `sub.${task.state ?? "running"}`;
}

/** The dock and web share the same de-duplicated active work and terminal worker counts. */
export function activityOverview(items: readonly TimelineItem[], background: readonly BackgroundTask[] = [], history: readonly BackgroundTask[] = []) {
  const tasks = new Map<string, BackgroundTask>();
  const key = (task: BackgroundTask) => task.sub ?? task.id;
  for (const task of [...history].reverse()) tasks.set(key(task), task);
  for (const task of background) tasks.set(key(task), task);
  const workers: WorkerItem[] = items.flatMap(item => item.type === "subagent" ? [item] : item.type === "toolGroup" ? item.rows.filter((row): row is WorkerItem => row.type === "subagent") : []);
  for (const worker of workers) {
    const previous = tasks.get(worker.sub);
    const model = worker.model ?? previous?.model;
    const effort = worker.effort ?? previous?.effort;
    tasks.set(worker.sub, { ...previous, id: previous?.id ?? worker.toolUseId, sub: worker.sub, kind: "agent", label: worker.description, startedAt: previous?.startedAt ?? null, state: worker.status === "running" && previous?.state && previous.state !== "running" ? previous.state : worker.status, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  }
  const all = [...tasks.values()];
  const active = all.filter(task => !task.state || task.state === "running" || task.state === "unknown");
  const recent = all.filter(task => task.state === "done" || task.state === "failed" || task.state === "stopped").reverse();
  const counts = { running: 0, unknown: 0, done: 0, failed: 0, stopped: 0 };
  for (const task of all) counts[task.state ?? "running"]++;
  return { active, recent, counts };
}
