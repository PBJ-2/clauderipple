import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import type { ProcessPriority } from "../src/config.ts";
import { applyProcessPriority, processPriorityState } from "../src/process-priority.ts";

const values: Record<ProcessPriority, number> = {
  "below-normal": os.constants.priority.PRIORITY_BELOW_NORMAL,
  normal: os.constants.priority.PRIORITY_NORMAL,
  "above-normal": os.constants.priority.PRIORITY_ABOVE_NORMAL,
  high: os.constants.priority.PRIORITY_HIGH,
};

test("each configured Windows priority sets its Task Manager level", () => {
  for (const setting of Object.keys(values) as ProcessPriority[]) {
    let current = setting === "normal" ? values.high : values.normal;
    const set: number[] = [];
    const state = applyProcessPriority(setting, {
      platform: "win32",
      getPriority: () => current,
      setPriority: priority => { set.push(priority); current = priority; },
    });
    assert.deepEqual(set, [values[setting]], setting);
    assert.deepEqual(state, { supported: true, setting, current: setting });
  }
});

test("an omitted setting means normal", () => {
  let current = values["below-normal"];
  const set: number[] = [];
  const state = applyProcessPriority(undefined, {
    platform: "win32",
    getPriority: () => current,
    setPriority: priority => { set.push(priority); current = priority; },
  });
  assert.deepEqual(set, [values.normal]);
  assert.deepEqual(state, { supported: true, setting: "normal", current: "normal" });
});

test("a process already at the target is not changed or logged", () => {
  const logs: string[] = [];
  let set = false;
  const state = applyProcessPriority("above-normal", {
    platform: "win32",
    getPriority: () => values["above-normal"],
    setPriority: () => { set = true; },
    log: line => logs.push(line),
  });
  assert.equal(set, false);
  assert.deepEqual(logs, []);
  assert.deepEqual(state, { supported: true, setting: "above-normal", current: "above-normal" });
});

test("a Windows priority change logs the old and new names once", () => {
  let current = values["below-normal"];
  const logs: string[] = [];
  applyProcessPriority("high", {
    platform: "win32",
    getPriority: () => current,
    setPriority: priority => { current = priority; },
    log: line => logs.push(line),
  });
  assert.deepEqual(logs, ["process priority: below-normal → high"]);
});

test("non-Windows platforms neither inspect nor change priority", () => {
  for (const platform of ["linux", "darwin"] as const) {
    let inspected = false;
    let set = false;
    const state = applyProcessPriority("high", {
      platform,
      getPriority: () => { inspected = true; return values.normal; },
      setPriority: () => { set = true; },
      log: () => assert.fail("non-Windows priority changes must not log"),
    });
    assert.equal(inspected, false);
    assert.equal(set, false);
    assert.deepEqual(state, { supported: false, setting: "high", current: null });
  }
});

test("a Windows set failure returns an error and fresh current priority without throwing", () => {
  const logs: string[] = [];
  let state: ReturnType<typeof applyProcessPriority> | undefined;
  assert.doesNotThrow(() => {
    state = applyProcessPriority("normal", {
      platform: "win32",
      getPriority: () => values["below-normal"],
      setPriority: () => { throw new Error("Access is denied"); },
      log: line => logs.push(line),
    });
  });
  assert.deepEqual(state, { supported: true, setting: "normal", current: "below-normal", error: "Access is denied" });
  assert.deepEqual(logs, ["process priority: could not set normal: Access is denied"]);
});

test("read-back maps idle and realtime", () => {
  assert.equal(processPriorityState("normal", { platform: "win32", getPriority: () => 19 }).current, "idle");
  assert.equal(processPriorityState("normal", { platform: "win32", getPriority: () => -20 }).current, "realtime");
});

test("processPriorityState reads but never sets", () => {
  let set = false;
  const state = processPriorityState("high", {
    platform: "win32",
    getPriority: () => values.normal,
    setPriority: () => { set = true; },
  });
  assert.equal(set, false);
  assert.deepEqual(state, { supported: true, setting: "high", current: "normal" });
});
