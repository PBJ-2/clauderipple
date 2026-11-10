import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundActivity } from "../src/background-activity.ts";
import { BackgroundTasks } from "../src/desktop.ts";
import { activityOverview } from "../web/activity.ts";
import type { TimelineItem } from "../web/timeline.ts";

const launch = (activity: BackgroundActivity, id: string, tool: string, input: Record<string, unknown>, result: Record<string, unknown>, ok = true) => {
  activity.call(id, tool, input); activity.result(id, ok, JSON.stringify(result), 10);
};

test("a worker's effort is shown only when its record gives one", () => {
  const activity = new BackgroundActivity();
  activity.accept({ kind: "subagent", toolUseId: "w1", sub: "sub-w1", description: "Review", model: "claude-haiku-5-5", effort: "high", status: "running", steps: 0 }, text => String(text));
  activity.accept({ kind: "subagent", toolUseId: "w2", sub: "sub-w2", description: "Plain", model: "claude-haiku-5-5", status: "running", steps: 0 }, text => String(text));
  assert.deepEqual(activity.active.map(task => [task.sub, task.model, task.effort ?? null]), [
    ["sub-w1", "claude-haiku-5-5", "high"],
    ["sub-w2", "claude-haiku-5-5", null],
  ]);
  // A later update without an effort keeps the one already recorded.
  activity.accept({ kind: "subagent", toolUseId: "w1", sub: "sub-w1", description: "Review", model: "claude-haiku-5-5", status: "done", steps: 2 }, text => String(text));
  assert.equal([...activity.active, ...activity.history].find(task => task.sub === "sub-w1")?.effort, "high");
});

test("background commands, Monitor, CronCreate/List/Delete and dynamic wakeups retain exact observed lifecycle", () => {
  const activity = new BackgroundActivity();
  launch(activity, "bash", "Bash", { command: "npm test\nsecond command" }, { backgroundTaskId: "shell" });
  launch(activity, "monitor", "Monitor", { description: "PR CI watch", command: "gh pr checks 1 --watch" }, { taskId: "watch", timeoutMs: 300000 });
  launch(activity, "cron", "CronCreate", { cron: "*/5 * * * *", prompt: "Check CI\nDo not merge" }, { id: "cron-1", recurring: true });
  launch(activity, "wakeup", "ScheduleWakeup", { reason: "Wait for CI", prompt: "Resume check" }, { scheduledFor: 1000 });
  assert.deepEqual(activity.active.map(task => task.kind), ["shell", "monitor", "schedule", "schedule"]);
  assert.equal(activity.active[0]?.command, "npm test\nsecond command");
  launch(activity, "failed-stop", "TaskStop", { task_id: "watch" }, {}, false);
  assert.equal(activity.active.length, 4);
  launch(activity, "stop", "TaskStop", { task_id: "watch" }, {});
  activity.notice("<task-notification><task-id>shell</task-id><status>failed</status></task-notification>", 20);
  launch(activity, "delete", "CronDelete", { id: "cron-1" }, { id: "cron-1" });
  launch(activity, "cancel-wakeup", "ScheduleWakeup", { stop: true }, { stopped: true, cancelledWakeups: 1 });
  assert.equal(activity.active.length, 0);
  assert.deepEqual(activity.history.map(task => task.state), ["stopped", "stopped", "stopped", "failed"]);
  launch(activity, "list", "CronList", {}, { jobs: [{ id: "listed", cron: "0 * * * *", prompt: "Exact pending prompt" }] });
  assert.equal(activity.active[0]?.id, "listed");
  launch(activity, "empty-list", "CronList", {}, { jobs: [] });
  assert.equal(activity.active.length, 0);
});

test("authoritative hook inventory exposes unfamiliar PR/CI work without inventing status or dropping absent work", () => {
  const activity = new BackgroundActivity();
  launch(activity, "shell", "Bash", { command: "sleep 1" }, { backgroundTaskId: "shell" });
  activity.inventory({ background_tasks: [{ id: "pr-ci", type: "pr_ci_subscription", status: "pending", description: "PR #9 CI subscription" }], session_crons: [{ id: "cron", schedule: "0 9 * * *", recurring: true, prompt: "Check PR" }] }, 30);
  assert.equal(activity.known, true);
  assert.equal(activity.active.find(task => task.id === "pr-ci")?.category, "pr_ci_subscription");
  assert.equal(activity.active.some(task => task.id === "shell"), false, "unconfirmed work must not block the live query");
  assert.equal(activity.history.find(task => task.id === "shell")?.state, "unknown", "absence is not proof of success or failure");
  activity.accept({ kind: "notice", code: "host_restarted" }, text => String(text));
  assert.equal(activity.known, false);
  assert.equal(activity.active.length, 0);
  assert.equal(activity.history.length, 3);
  assert.ok(activity.history.every(task => task.state === "unknown"));
});

test("desktop records preserve Monitor and cron work after the main answer ends", () => {
  const tasks = new BackgroundTasks();
  const accept = (value: unknown) => tasks.accept(JSON.stringify(value));
  accept({ type: "assistant", message: { content: [{ type: "tool_use", id: "monitor", name: "Monitor", input: { command: "gh pr checks --watch", description: "CI" } }] } });
  accept({ type: "user", toolUseResult: { taskId: "m" }, message: { content: [{ type: "tool_result", tool_use_id: "monitor", content: "started" }] } });
  accept({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Waiting" }] } });
  assert.equal(tasks.list[0]?.kind, "monitor");
  accept({ type: "user", message: { content: "<task-notification><task-id>m</task-id><status>completed</status></task-notification>" } });
  assert.equal(tasks.count, 0);
  assert.equal(tasks.history[0]?.state, "done");
});

test("worker overview deduplicates aliases, preserves running lists and separates failed, done and stopped workers", () => {
  const items: TimelineItem[] = ["running", "done", "failed", "stopped"].map((state, index) => ({ type: "subagent", key: `s${index}`, ver: "1", toolUseId: `w${index}`, sub: `sub-${index}`, description: state, model: null, status: state as "running" | "done" | "failed" | "stopped", steps: 0 }));
  const view = activityOverview(items, [{ id: "engine-id", sub: "sub-0", kind: "agent", label: "running", startedAt: 1 }], [{ id: "duplicate", sub: "sub-2", kind: "agent", label: "failed", state: "failed", startedAt: 1 }]);
  assert.deepEqual(view.counts, { running: 1, unknown: 0, done: 1, failed: 1, stopped: 1 });
  assert.equal(view.active[0]?.id, "engine-id");
  assert.equal(view.recent.length, 3);
});

test("a worker's model reaches the task list and survives an event that does not name it", () => {
  const activity = new BackgroundActivity();
  const worker = (model: string | null, status: "running" | "done") => activity.accept({ kind: "subagent", toolUseId: "w", sub: "sub-w", description: "Review", model, status, steps: 0 }, text => String(text));
  worker("gpt-6.1-sol", "running");
  assert.equal(activity.active[0]?.model, "gpt-6.1-sol");
  worker(null, "done");
  assert.equal(activity.history[0]?.model, "gpt-6.1-sol");
  const items: TimelineItem[] = [{ type: "subagent", key: "s", ver: "1", toolUseId: "w", sub: "sub-w", description: "Review", model: null, status: "running", steps: 0 }];
  assert.equal(activityOverview(items, [{ id: "w", sub: "sub-w", kind: "agent", label: "Review", startedAt: 1, model: "gpt-6.1-sol" }]).active[0]?.model, "gpt-6.1-sol", "a timeline card without a model keeps the host's");
  items[0] = { ...items[0]!, model: "gemini-3.8-flash" } as TimelineItem;
  assert.equal(activityOverview(items).active[0]?.model, "gemini-3.8-flash");
});
