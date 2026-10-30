import os from "node:os";
import type { ProcessPriority } from "./config.ts";

export type ProcessPriorityState = {
  supported: boolean;
  setting: ProcessPriority;
  current: ProcessPriority | "idle" | "realtime" | null;
  error?: string;
};

export type ProcessPriorityDeps = {
  platform?: NodeJS.Platform;
  getPriority?: () => number;
  setPriority?: (priority: number) => void;
  log?: (line: string) => void;
};

const PRIORITY_VALUES: Record<ProcessPriority, number> = {
  "below-normal": os.constants.priority.PRIORITY_BELOW_NORMAL,
  normal: os.constants.priority.PRIORITY_NORMAL,
  "above-normal": os.constants.priority.PRIORITY_ABOVE_NORMAL,
  high: os.constants.priority.PRIORITY_HIGH,
};

function priorityName(priority: number): ProcessPriority | "idle" | "realtime" | null {
  switch (priority) {
    case os.constants.priority.PRIORITY_BELOW_NORMAL: return "below-normal";
    case os.constants.priority.PRIORITY_NORMAL: return "normal";
    case os.constants.priority.PRIORITY_ABOVE_NORMAL: return "above-normal";
    case os.constants.priority.PRIORITY_HIGH: return "high";
    case os.constants.priority.PRIORITY_LOW: return "idle";
    case os.constants.priority.PRIORITY_HIGHEST: return "realtime";
    default: return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A scheduled task registered without a priority runs at Task Scheduler's default 7, which is
 * BELOW_NORMAL, and the launcher's children inherit it. On 2026-10-29, with cargo and rustc holding
 * every core at Normal, the router took 1-3 s to answer /api/status and refused new connections
 * (a full accept queue), so an update's final probe failed. The task and launcher establish a Normal
 * baseline; the router now applies the configured level, Normal by default.
 */
export function applyProcessPriority(setting: ProcessPriority | undefined, deps: ProcessPriorityDeps = {}): ProcessPriorityState {
  const selected = setting ?? "normal";
  if ((deps.platform ?? process.platform) !== "win32") return { supported: false, setting: selected, current: null };

  const getPriority = deps.getPriority ?? (() => os.getPriority());
  const setPriority = deps.setPriority ?? ((priority) => os.setPriority(priority));
  const log = deps.log ?? (() => {});
  const target = PRIORITY_VALUES[selected];
  try {
    const before = getPriority();
    if (before === target) return { supported: true, setting: selected, current: priorityName(before) };
    setPriority(target);
    log(`process priority: ${priorityName(before) ?? before} → ${selected}`);
    return { supported: true, setting: selected, current: priorityName(getPriority()) };
  } catch (error) {
    const message = errorMessage(error);
    log(`process priority: could not set ${selected}: ${message}`);
    let current: ProcessPriorityState["current"] = null;
    try { current = priorityName(getPriority()); }
    catch { /* The original error is the useful one. */ }
    return { supported: true, setting: selected, current, error: message };
  }
}

export function processPriorityState(setting: ProcessPriority | undefined, deps: ProcessPriorityDeps = {}): ProcessPriorityState {
  const selected = setting ?? "normal";
  if ((deps.platform ?? process.platform) !== "win32") return { supported: false, setting: selected, current: null };
  try {
    const current = (deps.getPriority ?? (() => os.getPriority()))();
    return { supported: true, setting: selected, current: priorityName(current) };
  } catch (error) {
    return { supported: true, setting: selected, current: null, error: errorMessage(error) };
  }
}
