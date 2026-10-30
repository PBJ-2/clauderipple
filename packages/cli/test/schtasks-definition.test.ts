import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installAgent, renderLauncher, renderTaskRegistration, taskDefinitionMatches, taskRouterPid, taskUser, type TaskDeps } from "../src/schtasks.ts";

const expected = { execute: "conhost.exe", arguments: '--headless powershell.exe -NoProfile -File "C:\\Users\\me\\.clauderipple\\router.ps1"', userId: "me" };
const valid = {
  actionCount: 1,
  execute: "conhost.exe",
  arguments: expected.arguments,
  userId: "ME",
  runLevel: 0,
  logonType: 3,
  triggerCount: 1,
  triggerType: "MSFT_TaskLogonTrigger",
  triggerUserId: "me",
  restartCount: 99,
  restartInterval: "PT1M",
  executionTimeLimit: "PT0S",
  multipleInstances: 2,
  priority: 4,
  allowStartIfOnBatteries: true,
  dontStopIfGoingOnBatteries: true,
};

test("accepts only the expected limited per-user task", () => {
  assert.equal(taskDefinitionMatches(valid, expected), true);
  assert.equal(taskDefinitionMatches(null, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, actionCount: 2 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, execute: "cmd.exe" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, execute: "CONHOST.EXE" }, expected), true);
  // #49: the task from before the headless console host no longer counts as the expected one.
  assert.equal(taskDefinitionMatches({ ...valid, execute: "powershell.exe" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, arguments: "-File foreign.ps1" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, userId: "other" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, runLevel: 1 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, logonType: 0 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, triggerCount: 2 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, triggerType: "MSFT_TaskDailyTrigger" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, triggerUserId: "other" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, restartCount: 0 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, restartInterval: "PT5M" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, executionTimeLimit: "PT72H" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, multipleInstances: 0 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, priority: 7 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, priority: undefined }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, priority: 4 }, expected), true);
  assert.equal(taskDefinitionMatches({ ...valid, allowStartIfOnBatteries: false }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, dontStopIfGoingOnBatteries: false }, expected), false);
});

test("registration and launcher keep router children at Normal priority", () => {
  const registration = renderTaskRegistration("ClaudeRippleTest", "me", "conhost.exe", "--headless powershell.exe");
  assert.match(registration, /New-ScheduledTaskSettingsSet[^;]* -Priority 4/);

  const launcher = renderLauncher({ program: "C:\\node.exe", args: ["C:\\router.js"], home: "C:\\home" });
  const raise = launcher.indexOf("[System.Diagnostics.Process]::GetCurrentProcess()");
  const loop = launcher.indexOf("while ($true)");
  assert.ok(raise >= 0 && raise < loop);
  assert.match(launcher, /PriorityClass -eq \[System\.Diagnostics\.ProcessPriorityClass\]::BelowNormal/);
  assert.match(launcher, /PriorityClass -eq \[System\.Diagnostics\.ProcessPriorityClass\]::Idle/);
  assert.match(launcher, /PriorityClass = \[System\.Diagnostics\.ProcessPriorityClass\]::Normal/);
  assert.doesNotMatch(launcher, /::(?:High|RealTime|AboveNormal)/);
  assert.equal(launcher.charCodeAt(0), 0xFEFF);
  assert.doesNotMatch(launcher.replace(/\r\n/g, ""), /[\r\n]/);
});

test("registration failure retains only a task whose sole mismatch is priority", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-task-priority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const user = taskUser();
  const definition = (home: string, extra: Record<string, unknown> = {}) => ({
    ...valid,
    execute: "conhost.exe",
    arguments: `--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(home, "clauderipple-router.ps1")}"`,
    userId: user,
    triggerUserId: user,
    priority: 7,
    ...extra,
  });
  const denied = (name: string, value: unknown): TaskDeps => ({
    name,
    definition: () => value,
    run: script => {
      assert.match(script, /Register-ScheduledTask/);
      return { ok: false, out: "Access is denied" };
    },
  });

  const acceptedHome = path.join(root, "accepted");
  const accepted = installAgent(
    { program: "C:\\node.exe", args: ["C:\\router.js"], home: acceptedHome },
    denied("ClaudeRipplePriorityFallbackAccepted", definition(acceptedHome)),
  );
  assert.equal(accepted, path.join(acceptedHome, "clauderipple-router.ps1"));

  const rejectedHome = path.join(root, "rejected");
  assert.throws(
    () => installAgent(
      { program: "C:\\node.exe", args: ["C:\\router.js"], home: rejectedHome },
      denied("ClaudeRipplePriorityFallbackRejected", definition(rejectedHome, { restartCount: 0 })),
    ),
    /Register-ScheduledTask failed: Access is denied/,
  );
});

// #38: a local account named after its computer does not resolve by its bare name, so the task is
// registered as HOST\user — and Windows then stores the principal bare and the trigger qualified.
test("the task user is domain-qualified, and either spelling of it matches", () => {
  assert.equal(taskUser("x", "X"), "X\\x");
  assert.equal(taskUser("x", ""), "x");

  const qualified = { ...expected, userId: "X\\x" };
  assert.equal(taskDefinitionMatches({ ...valid, userId: "x", triggerUserId: "X\\x" }, qualified), true);
  assert.equal(taskDefinitionMatches({ ...valid, userId: "x", triggerUserId: "x" }, qualified), true);
  assert.equal(taskDefinitionMatches({ ...valid, userId: "Y\\x", triggerUserId: "X\\x" }, qualified), false);
  assert.equal(taskDefinitionMatches({ ...valid, userId: "x", triggerUserId: "X\\other" }, qualified), false);
});

const home = path.resolve("task-pid-fixture");
const launcher = path.join(home, "clauderipple-router.ps1");
const launcherCommand = `powershell.exe -File "${launcher}"`;
const routerCommand = '"C:\\node.exe" "C:\\shared\\router\\src\\index.js"';
type ProcessRow = { ProcessId: number; ParentProcessId: number; CommandLine: string | null };
const tree: ProcessRow[] = [
  { ProcessId: 31664, ParentProcessId: 100, CommandLine: `conhost.exe --headless ${launcherCommand}` },
  { ProcessId: 33820, ParentProcessId: 31664, CommandLine: launcherCommand },
  { ProcessId: 752, ParentProcessId: 33820, CommandLine: routerCommand },
];

/** Model CIM's read-only process queries, including the old immediate-child query. */
function processDeps(rows: ProcessRow[]): TaskDeps {
  return {
    definition: () => ({ arguments: `--headless ${launcherCommand}` }),
    run: script => {
      assert.match(script, /^Get-CimInstance|^\$c = Get-CimInstance/);
      const parent = /ParentProcessId=(\d+)/.exec(script);
      if (parent) {
        const child = rows.find(row => row.ParentProcessId === Number(parent[1]) && row.CommandLine?.includes("router\\src\\index."));
        return { ok: true, out: JSON.stringify(child ? { pid: child.ProcessId } : null) };
      }
      const selected = script.includes("Where-Object") ? rows.filter(row => row.CommandLine?.includes("clauderipple-router.ps1")) : rows;
      return { ok: true, out: JSON.stringify(selected) };
    },
  };
}

test("issue #100: finds the router grandchild of conhost regardless of process order", () => {
  const idle = { ProcessId: 0, ParentProcessId: 0, CommandLine: null };
  for (const rows of [tree, [...tree].reverse(), [idle, ...tree]]) {
    assert.equal(taskRouterPid(undefined, { home, deps: processDeps(rows) }), 752);
  }
});

test("finds direct and deeper descendants, including the packaged runtime", () => {
  assert.equal(taskRouterPid(undefined, { home, deps: processDeps(tree.slice(1)) }), 752);
  const deeper = [
    ...tree.slice(0, 2),
    { ProcessId: 500, ParentProcessId: 33820, CommandLine: null },
    { ProcessId: 752, ParentProcessId: 500, CommandLine: routerCommand.replace("node.exe", "ClaudeRipple.exe") },
  ];
  assert.equal(taskRouterPid(undefined, { home, deps: processDeps(deeper) }), 752);
});

test("a shared-runtime router outside our launcher tree is never a control target", () => {
  const foreign = [
    { ProcessId: 900, ParentProcessId: 100, CommandLine: 'powershell.exe -File "C:\\other\\clauderipple-router.ps1"' },
    { ProcessId: 901, ParentProcessId: 900, CommandLine: routerCommand },
    { ProcessId: 902, ParentProcessId: 100, CommandLine: routerCommand },
  ];
  assert.equal(taskRouterPid(undefined, { home, deps: processDeps([...foreign, ...tree]) }), 752);
  assert.equal(taskRouterPid(undefined, { home, deps: processDeps([...foreign, ...tree.slice(0, 2)]) }), null);
  assert.equal(taskRouterPid(undefined, { home, deps: processDeps(foreign) }), null);
});

test("cyclic parent links terminate without selecting an unrelated router", () => {
  const cyclic = [
    { ...tree[0]!, ParentProcessId: 33820 },
    tree[1]!,
    { ProcessId: 902, ParentProcessId: 100, CommandLine: routerCommand },
  ];
  assert.equal(taskRouterPid(undefined, { home, deps: processDeps(cyclic) }), null);
});

test("unreadable process lists yield no PID without changing task ownership", () => {
  for (const result of [{ ok: false, out: "Access denied" }, { ok: true, out: "invalid JSON" }, { ok: true, out: "null" }, { ok: true, out: "[]" }]) {
    const deps = { ...processDeps(tree), run: () => result };
    assert.equal(taskRouterPid(undefined, { home, deps }), null);
  }
  for (const definition of [() => null, () => ({}), () => ({ arguments: '-File "C:\\other\\clauderipple-router.ps1"' })]) {
    const deps = { definition, run: () => { assert.fail("unowned tasks must not inspect processes"); } };
    assert.equal(taskRouterPid(undefined, { home, deps }), null);
  }
});
