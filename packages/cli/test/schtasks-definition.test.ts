import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installAgent, launcherProcessPid, launcherScriptPath, renderLauncher, renderTaskRegistration, stopLauncherProcess, taskDefinitionMatches, taskRouterPid, taskUser, type TaskDeps } from "../src/schtasks.ts";

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

// #131: `-Wait` on Windows PowerShell 5.1 also waits for the router's detached children (the update
// installer), which waits for this task to end. The launcher must wait on its own process only.
test("launcher waits on the router process alone, never with -Wait (#131)", () => {
  const launcher = renderLauncher({ program: "C:\\node.exe", args: ["C:\\router.js"], home: "C:\\home" });
  const lines = launcher.split("\r\n");
  const start = lines.findIndex(line => line.includes("Start-Process -FilePath"));
  assert.ok(start >= 0);
  assert.doesNotMatch(launcher, /-Wait\b/);
  assert.match(lines[start]!, /-PassThru -RedirectStandardOutput \$out -RedirectStandardError \$err$/);
  assert.equal(lines[start + 1]!.trim(), "$null = $p.Handle");
  assert.equal(lines[start + 2]!.trim(), "$p.WaitForExit()");
  // Exit-code handling is unchanged: 0 ends the loop, anything else relaunches after the backoff.
  assert.equal(lines[start + 3]!.trim(), "if ($p.ExitCode -eq 0) { break }");
  assert.ok(lines.slice(start + 4, start + 8).some(line => line.includes("$quickFailures++")));
  assert.ok(lines.some(line => line.trim() === "Start-Sleep -Seconds $(if ($quickFailures -ge 5) { 60 } else { 2 })"));
  // Redirection to the same log files as before.
  assert.ok(lines.includes(`$out = '${path.join("C:\\home", "logs", "launcher.log")}'`));
  assert.ok(lines.includes(`$err = '${path.join("C:\\home", "logs", "launcher.err.log")}'`));
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

// #131: the launcher lookup and stop may only ever name this home's launcher, by its exact quoted path.
test("the stuck-launcher lookup and stop match only this home's launcher under powershell.exe", () => {
  const home = path.resolve("launcher-stop-fixture");
  const other = path.resolve("launcher-stop-other");
  const needle = `-File "${launcherScriptPath(home)}"`;
  const definitionOf = (dir: string) => ({ arguments: `--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcherScriptPath(dir)}"` });
  const scripts: string[] = [];
  const deps = (out: string, dir = home): TaskDeps => ({
    definition: () => definitionOf(dir),
    run: script => {
      scripts.push(script);
      return { ok: true, out };
    },
  });

  // The lookup: the exact needle, PowerShell only, the query's own process excluded, nothing broader.
  assert.equal(launcherProcessPid(home, deps("4242")), 4242);
  const lookup = scripts.at(-1)!;
  assert.ok(lookup.includes(`$_.CommandLine.IndexOf('${needle}', [System.StringComparison]::OrdinalIgnoreCase) -ge 0`));
  // conhost drops the quotes (measured 2026-11-09), so the bare form must end the command line.
  const bare = `-File ${launcherScriptPath(home)}`;
  assert.ok(lookup.includes(`$_.CommandLine.TrimEnd().EndsWith('${bare}', [System.StringComparison]::OrdinalIgnoreCase)`));
  assert.equal(`powershell.exe -File ${launcherScriptPath(path.join(home, "nested"))}`.endsWith(bare), false);
  assert.equal(`powershell.exe -File ${launcherScriptPath(other)}`.endsWith(bare), false);
  assert.ok(lookup.includes("$_.Name -eq 'powershell.exe'"));
  assert.ok(lookup.includes("$_.ProcessId -ne $PID"));
  assert.doesNotMatch(lookup, /node\.exe|ClaudeRipple\.exe|conhost|-like|\*|Stop-Process|Stop-ScheduledTask|schtasks/);
  // Another home's launcher, or one nested under this home, never contains this home's needle.
  assert.equal(`-File "${launcherScriptPath(other)}"`.includes(needle), false);
  assert.equal(`-File "${launcherScriptPath(path.join(home, "nested"))}"`.includes(needle), false);

  // Null, ambiguous or unreadable results are never a pid.
  assert.equal(launcherProcessPid(home, deps("null")), null);
  assert.equal(launcherProcessPid(home, deps("ambiguous")), null);
  assert.equal(launcherProcessPid(home, { ...deps(""), run: () => ({ ok: false, out: "denied" }) }), null);
  // Another installation's task: the lookup does not run at all.
  const beforeForeign = scripts.length;
  assert.equal(launcherProcessPid(home, deps("4242", other)), null);
  assert.equal(scripts.length, beforeForeign, "a task that belongs to another home is never inspected");

  // The stop: that pid only, re-checked against the same predicate in the same step, one Stop-Process.
  assert.equal(stopLauncherProcess(4242, home, deps("stopped")), true);
  const stop = scripts.at(-1)!;
  assert.ok(stop.includes("$_.ProcessId -eq 4242"));
  assert.ok(stop.includes(`IndexOf('${needle}', [System.StringComparison]::OrdinalIgnoreCase) -ge 0`));
  assert.equal(stop.match(/Stop-Process/g)?.length, 1);
  assert.ok(stop.includes("Stop-Process -Id 4242 "));
  assert.doesNotMatch(stop, /Stop-ScheduledTask|schtasks|\/End|taskkill|node\.exe|ClaudeRipple\.exe|-like/);
  assert.equal(stopLauncherProcess(4242, home, deps("absent")), false, "a pid that no longer matches is left alone");
  assert.equal(stopLauncherProcess(0, home, deps("stopped")), false);
  assert.equal(stopLauncherProcess(Number.NaN, home, deps("stopped")), false);
  const selfBefore = scripts.length;
  assert.equal(stopLauncherProcess(process.pid, home, deps("stopped")), false, "the installer's own process is never stopped");
  assert.equal(scripts.length, selfBefore);
  const stopsBefore = scripts.length;
  assert.equal(stopLauncherProcess(4242, home, deps("stopped", other)), false);
  assert.equal(scripts.length, stopsBefore, "another home's task is never stopped through");
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
