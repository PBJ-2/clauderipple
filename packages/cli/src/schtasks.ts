// Windows supervisor: a per-user scheduled task that starts the router at logon and restarts it
// if it dies. The launchd counterpart is launchd.ts; supervisor.ts picks between them.
//
// Measured in a Windows 11 VM (2026-09-14) as a standard, non-elevated user:
//   Register-ScheduledTask with LogonType Interactive + RunLevel Limited → "registered OK", no UAC.
// That is the whole reason this is a scheduled task rather than a Windows service: creating a
// service needs administrator rights, and a personal proxy should not ask for them.
//
// Two things launchd gives us for free need doing by hand here:
//   * KeepAlive → RestartCount/RestartInterval, which only fire on a *non-zero* exit. That still
//     covers a crash and the health self-exit (code 75); a clean exit stays exited, which is what
//     `clauderipple stop` wants anyway.
//   * A graceful restart → there is no SIGTERM on Windows (process.kill terminates outright and
//     would cut the drain), so restart asks the router over POST /api/shutdown and waits.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir } from "../../router/src/config.ts";
import { type AgentRemove, type AgentStart, type AgentStop, type Ownership, launcherHome, ownerOf } from "./ownership.ts";
import { type RouterIdentity, routerIdentity } from "./router-state.ts";
import { runtime } from "./runtime.ts";
import { windowsPowerShellEnv } from "./windows-powershell.ts";
import { assertGeneration, definitionGeneration, withServiceLock, writeServiceFile } from "./service-definition.ts";

export const TASK_NAME = "ClaudeRippleRouter";

export function taskName(): string {
  return process.env.CLAUDERIPPLE_TASK_NAME ?? TASK_NAME;
}

/**
 * What a caller may inject: the registered definition, the router pid under that task's launcher,
 * and one PowerShell invocation. Tests use these so no Task Scheduler, PowerShell or real process
 * is ever touched; production passes none.
 */
export type TaskDeps = {
  name?: string;
  definition?: () => unknown;
  routerPid?: () => number | null;
  run?: (script: string) => { ok: boolean; out: string };
};

function invoke(script: string, deps: TaskDeps): { ok: boolean; out: string } {
  return (deps.run ?? run)(script);
}

/** Single-quoted PowerShell literal; the only escape inside one is a doubled quote. */
function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Windows PowerShell writes to a pipe in the console's code page, which we would read as UTF-8: on
 * a Korean Windows an account named in Hangul came back garbled, so the registered task never
 * matched and every install tried to register it again (measured 2026-10-13). The script sets
 * UTF-8 first.
 */
function run(script: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`], {
      env: windowsPowerShellEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // A hung PowerShell must not hang doctor/repair, which the menu-bar app waits on.
      timeout: 60_000,
    }).toString();
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.trim() };
  }
}

type TaskDefinition = {
  actionCount?: number;
  execute?: string;
  arguments?: string;
  userId?: string;
  runLevel?: number;
  logonType?: number;
  triggerCount?: number;
  triggerType?: string;
  triggerUserId?: string;
  restartCount?: number;
  restartInterval?: string;
  executionTimeLimit?: string;
  multipleInstances?: number;
  priority?: number;
  allowStartIfOnBatteries?: boolean;
  dontStopIfGoingOnBatteries?: boolean;
};

/**
 * The account the task runs as, qualified with its domain. A bare name is looked up as a machine
 * name too, so on a local account named after its computer (user X on host X) it resolves to
 * nothing and Register-ScheduledTask fails with 0x80070057 (#38). `X\X` names the user.
 */
export function taskUser(username = os.userInfo().username, domain = process.env.USERDOMAIN): string {
  return domain ? `${domain}\\${username}` : username;
}

/**
 * Windows stores the qualified name as given on the trigger but the bare one on the principal
 * (reported in #38), and a task registered before that fix carries the bare name on both, so
 * either spelling of the same account is a match.
 */
function sameAccount(stored: string | undefined, expected: string): boolean {
  if (stored === undefined) return false;
  const bare = expected.slice(expected.lastIndexOf("\\") + 1);
  return [expected, bare].some((name) => name.toLowerCase() === stored.toLowerCase());
}

export function taskDefinitionMatches(value: unknown, expected: { execute: string; arguments: string; userId: string }): boolean {
  if (!value || typeof value !== "object") return false;
  const task = value as TaskDefinition;
  return (
    task.actionCount === 1 &&
    task.execute?.toLowerCase() === expected.execute.toLowerCase() &&
    task.arguments === expected.arguments &&
    sameAccount(task.userId, expected.userId) &&
    task.runLevel === 0 &&
    task.logonType === 3 &&
    task.triggerCount === 1 &&
    task.triggerType === "MSFT_TaskLogonTrigger" &&
    sameAccount(task.triggerUserId, expected.userId) &&
    task.restartCount === 99 &&
    task.restartInterval === "PT1M" &&
    task.executionTimeLimit === "PT0S" &&
    task.multipleInstances === 2 &&
    task.priority === 4 &&
    task.allowStartIfOnBatteries === true &&
    task.dontStopIfGoingOnBatteries === true
  );
}

function taskDefinitionMatchesExceptPriority(value: unknown, expected: { execute: string; arguments: string; userId: string }): boolean {
  if (!value || typeof value !== "object") return false;
  return taskDefinitionMatches({ ...value, priority: 4 }, expected);
}

/**
 * The task runs a PowerShell launcher rather than node directly, for three reasons.
 *
 * 1. It pins CLAUDERIPPLE_HOME and any extra environment the installer recorded, which a scheduled
 *    task cannot carry on its own, and keeps output in a log file the way StandardOutPath does.
 * 2. `Start-Process` detaches the router from the console: a task started from one inherits it, and
 *    closing that window sends a Ctrl+C — measured 2026-09-14, the router died with 0xC000013A the
 *    moment the installer's window closed.
 * 3. **It is the KeepAlive.** Task Scheduler's RestartCount/RestartInterval only cover failing to
 *    *start* a task; a process that dies while running just ends the task as complete (measured
 *    2026-09-14: the router was killed, the task went back to Ready with 0xFFFFFFFF, and nothing
 *    restarted it for three minutes). So the launcher supervises the router itself, with launchd's
 *    semantics: a non-zero exit — a crash, or the health self-exit 75 — is relaunched; a clean exit
 *    is not, because that is `stop` or the drain half of `restart`, which starts the task again.
 *    A router that keeps dying immediately backs off instead of spinning.
 */
export function renderLauncher(opts: { program: string; args: string[]; home: string; env?: Record<string, string> }): string {
  const logDir = path.join(opts.home, "logs");
  const env = { CLAUDERIPPLE_HOME: opts.home, ...(opts.env ?? {}) };
  const quoteArg = (arg: string): string => ps(`"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);
  // No `$ErrorActionPreference = 'Stop'`: one failed Start-Process (a locked log file, say) would end
  // the loop and leave the router or host unsupervised; the loop retries instead.
  // Windows PowerShell 5.1 decodes -File as ANSI unless the UTF-8 BOM is present.
  return String.fromCharCode(0xFEFF) + [
    ...Object.entries(env).map(([k, v]) => `$env:${k} = ${ps(v)}`),
    `$routerArgs = @(${opts.args.map(quoteArg).join(", ")})`,
    `$out = ${ps(path.join(logDir, "launcher.log"))}`,
    `$err = ${ps(path.join(logDir, "launcher.err.log"))}`,
    "$quickFailures = 0",
    // A task registered before -Priority 4 starts this at BelowNormal, and Start-Process hands that
    // to the router (process-priority.ts has the measurement).
    "try {",
    "  $self = [System.Diagnostics.Process]::GetCurrentProcess()",
    "  if ($self.PriorityClass -eq [System.Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.PriorityClass -eq [System.Diagnostics.ProcessPriorityClass]::Idle) {",
    "    $self.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::Normal",
    "  }",
    "} catch {}",
    "while ($true) {",
    "  $startedAt = Get-Date",
    `  $p = Start-Process -FilePath ${ps(opts.program)} -ArgumentList $routerArgs -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $out -RedirectStandardError $err`,
    "  if ($p.ExitCode -eq 0) { break }",
    "  if (((Get-Date) - $startedAt).TotalSeconds -lt 10) { $quickFailures++ } else { $quickFailures = 0 }",
    "  Start-Sleep -Seconds $(if ($quickFailures -ge 5) { 60 } else { 2 })",
    "}",
  ].join("\r\n") + "\r\n";
}

export function writeLauncher(opts: { program: string; args: string[]; home: string; env?: Record<string, string>; name?: string }): string {
  const launcher = path.join(opts.home, `${opts.name ?? "clauderipple-router"}.ps1`);
  const logDir = path.join(opts.home, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  writeServiceFile(launcher, renderLauncher(opts));
  return launcher;
}

/**
 * The registered task in the shape taskDefinitionMatches reads, or null. The settings object has
 * no AllowStartIfOnBatteries/DontStopIfGoingOnBatteries — the switches of the same names set
 * DisallowStartIfOnBatteries/StopIfGoingOnBatteries to false — so reading the switch names gave
 * null, and until #38 no existing task ever matched: every install re-registered.
 */
/** A task definition read: truly missing, found, or unreadable. Only the first is "absent". */
export type TaskDefinitionRead = { state: "absent" | "found" | "error"; definition?: unknown; error?: string };

/**
 * Reads the registered task without collapsing failures into "no task": an unreadable definition
 * must make install refuse to replace it, not look like a fresh machine (B01).
 */
export function readTaskDefinition(name = taskName(), deps: TaskDeps = {}): TaskDefinitionRead {
  if (deps.definition) {
    const definition = deps.definition();
    return definition === null || definition === undefined ? { state: "absent" } : { state: "found", definition };
  }
  const existing = invoke(
    [
      `$ErrorActionPreference = 'Stop'`,
      // Enumerate successfully before deciding "absent": a named query with SilentlyContinue also
      // returns null on access denied, which would let registration overwrite an unreadable task.
      `$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq ${ps(name)} })`,
      `if ($tasks.Count -eq 0) { 'null'; exit 0 }`,
      `if ($tasks.Count -ne 1) { throw 'ambiguous scheduled task name' }; $t = $tasks[0]`,
      `$a = @($t.Actions); $p = $t.Principal; $tr = @($t.Triggers); $s = $t.Settings`,
      `[pscustomobject]@{ actionCount = $a.Count; execute = $a[0].Execute; arguments = $a[0].Arguments; userId = $p.UserId; runLevel = [int]$p.RunLevel; logonType = [int]$p.LogonType; triggerCount = $tr.Count; triggerType = $tr[0].CimClass.CimClassName; triggerUserId = $tr[0].UserId; restartCount = $s.RestartCount; restartInterval = [string]$s.RestartInterval; executionTimeLimit = [string]$s.ExecutionTimeLimit; multipleInstances = [int]$s.MultipleInstances; priority = [int]$s.Priority; allowStartIfOnBatteries = $s.DisallowStartIfOnBatteries -eq $false; dontStopIfGoingOnBatteries = $s.StopIfGoingOnBatteries -eq $false } | ConvertTo-Json -Compress`,
    ].join("; "),
    deps,
  );
  if (!existing.ok) return { state: "error", error: existing.out || "Get-ScheduledTask failed" };
  const text = existing.out.trim();
  if (text === "null") return { state: "absent" };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null) return { state: "absent" };
    return { state: "found", definition: parsed };
  } catch (error) {
    // A malformed inspection result is not trusted: an error, never "no task".
    return { state: "error", error: `unreadable task definition: ${(error as Error).message}` };
  }
}

/** The registered task in the shape taskDefinitionMatches reads, or null when absent/unreadable. */
export function existingTaskDefinition(name = taskName(), deps: TaskDeps = {}): unknown {
  const read = readTaskDefinition(name, deps);
  if (read.state === "error") throw new Error(`scheduled task lookup failed: ${read.error}`);
  return read.state === "found" ? read.definition : null;
}

/** One lock for every home using this account-wide task name, never a lock under a custom home. */
function withTaskDefinition<T>(name: string, deps: TaskDeps, body: (guarded: TaskDeps) => T): T {
  const key = path.join(os.homedir(), ".clauderipple", "service-locks", encodeURIComponent(name.toLowerCase()));
  return withServiceLock(key, () => {
    const read = () => {
      const result = readTaskDefinition(name, deps);
      if (result.state === "error") throw new Error(`scheduled task lookup failed: ${result.error}`);
      return result;
    };
    const initial = read();
    const generation = definitionGeneration(initial);
    const check = () => assertGeneration(read, generation);
    let registered = false;
    const result = body({
      ...deps,
      definition: () => { check(); return initial.definition ?? null; },
      run: script => {
        check();
        const result = invoke(script, deps);
        // Registration and unregistration intentionally change this generation and end the
        // operation. Every state/PID query and start/stop must retain the original definition.
        if (result.ok && /Register-ScheduledTask|Unregister-ScheduledTask/.test(script)) registered = true;
        else check();
        return result;
      },
    });
    if (!registered) check();
    return result;
  });
}

/** Who the task registered under this name belongs to (B01). */
export function taskOwnership(home: string = homeDir(), deps: TaskDeps = {}): Ownership {
  const read = readTaskDefinition(deps.name ?? taskName(), deps);
  if (read.state === "absent") return { state: "absent", home: null };
  // An unreadable definition says nothing about ownership: never treat it as "no task".
  if (read.state === "error") return { state: "unknown", home: null };
  const args = (read.definition as { arguments?: unknown }).arguments;
  return ownerOf(typeof args === "string" ? launcherHome(args) : null, home);
}

export function installAgent(...args: Parameters<typeof installAgentLocked>): string {
  const [opts, deps = {}] = args;
  return withTaskDefinition(opts.name ?? deps.name ?? taskName(), deps, guarded => installAgentLocked(opts, guarded));
}

function installAgentLocked(opts: { program: string; args?: string[]; home: string; env?: Record<string, string>; name?: string }, deps: TaskDeps = {}): string {
  const name = opts.name ?? deps.name ?? taskName();
  // Before the launcher and the registration: a same-named task may belong to another home (B01),
  // and a definition that cannot be read must not be replaced as if there were none.
  const read = readTaskDefinition(name, deps);
  if (read.state === "error") throw new Error(`could not read the scheduled task ${name} (${read.error}); refusing to replace it`);
  const owner = taskOwnership(opts.home, { ...deps, name, definition: () => read.definition ?? null });
  if (owner.state === "other") {
    throw new Error(`the scheduled task ${name} belongs to another ClaudeRipple installation (${owner.home}); remove it with that installation's uninstall, or use its own task name for this one`);
  }
  if (owner.state === "unknown") {
    throw new Error(`the scheduled task ${name} does not record an installation, so it cannot be identified; refusing to replace it`);
  }
  const launcher = writeLauncher({ ...opts, args: opts.args ?? [] });
  const user = taskUser();
  const powershellArgs = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcher}"`;
  // PowerShell is started inside a headless console host. Started directly, it gets a console from
  // the user's default terminal, and when that is Windows Terminal (the Windows 11 default)
  // `-WindowStyle Hidden` hides nothing: a PowerShell window sat on screen after every logon (#49;
  // measured 2026-10-06 in a Windows 11 24H2 VM — a CASCADIA_HOSTING_WINDOW_CLASS window appeared
  // for `powershell.exe`, none for `conhost.exe --headless powershell.exe`, and both ran the script).
  const execute = "conhost.exe";
  const actionArgs = `--headless powershell.exe ${powershellArgs}`;
  const existing = read.definition ?? null;
  // Updating the generated launcher does not require re-registering an otherwise correct task.
  // Some Windows installations protect an existing per-user task's security descriptor so that
  // even the same unelevated user gets E_ACCESSDENIED from Register-ScheduledTask -Force. Treat the
  // verified existing definition as success; never silently accept a same-named foreign task.
  if (taskDefinitionMatches(existing, { execute, arguments: actionArgs, userId: user })) return launcher;
  const script = renderTaskRegistration(name, user, execute, actionArgs);
  const r = invoke(script, deps);
  if (!r.ok) {
    // BelowNormal starved the listener under full CPU load on 2026-10-29. The rewritten launcher
    // corrects that stale setting when E_ACCESSDENIED prevents replacing an otherwise exact task.
    if (taskDefinitionMatchesExceptPriority(existing, { execute, arguments: actionArgs, userId: user })) return launcher;
    if (taskDefinitionMatchesExceptPriority(existing, { execute: "powershell.exe", arguments: powershellArgs, userId: user })) return launcher;
    throw new Error(`Register-ScheduledTask failed: ${r.out}`);
  }
  return launcher;
}

export function renderTaskRegistration(name: string, user: string, execute: string, actionArgs: string): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$a = New-ScheduledTaskAction -Execute ${ps(execute)} -Argument ${ps(actionArgs)}`,
    `$t = New-ScheduledTaskTrigger -AtLogOn -User ${ps(user)}`,
    // Limited: the router needs no elevation, and asking for it would put a UAC prompt at every logon.
    `$p = New-ScheduledTaskPrincipal -UserId ${ps(user)} -LogonType Interactive -RunLevel Limited`,
    `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 4`,
    `Register-ScheduledTask -TaskName ${ps(name)} -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`,
    `'ok'`,
  ].join("; ");
}

export function removeAgent(...args: Parameters<typeof removeAgentLocked>): AgentRemove {
  const [name = taskName(), opts = {}] = args;
  return withTaskDefinition(name, opts.deps ?? {}, guarded => removeAgentLocked(name, { ...opts, deps: guarded }));
}

function removeAgentLocked(name = taskName(), opts: { home?: string; deps?: TaskDeps; identity?: (expectedPid: number | null) => RouterIdentity } = {}): AgentRemove {
  const deps = opts.deps ?? {};
  const home = opts.home ?? homeDir();
  const owner = taskOwnership(home, { ...deps, name });
  if (owner.state === "absent") return "absent";
  if (owner.state === "other") return "other-installation";
  if (owner.state === "unknown") return "ownership-unknown";
  // Unregistering a running task terminates it. A same-named task whose definition points here is
  // not proof that the running instance is this installation's (the registration can have been
  // replaced, or an older generation started), so a running task must prove both its installation
  // id and the pid under its own launcher.
  if (agentState(name, deps) === "running") {
    const who = (opts.identity ?? ((expectedPid) => routerIdentity(home, { expectedPid })))(
      taskRouterPid(name, { home, deps }),
    );
    if (who === "other") return "other-installation";
    if (who !== "ours") return "identity-unknown";
  }
  const removed = invoke(`Unregister-ScheduledTask -TaskName ${ps(name)} -Confirm:$false -ErrorAction Stop; 'ok'`, deps);
  if (!removed.ok) throw new Error(`scheduled task removal failed: ${removed.out}`);
  return "removed";
}

export function agentState(name = taskName(), deps: TaskDeps = {}): "running" | "loaded" | "not-loaded" {
  const r = invoke(`(Get-ScheduledTask -TaskName ${ps(name)} -ErrorAction Stop).State`, deps);
  if (!r.ok) throw new Error(`scheduled task state lookup failed: ${r.out}`);
  return /^Running/im.test(r.out) ? "running" : "loaded";
}

/**
 * The scheduled task starts PowerShell, which starts the runtime, so the task's own pid is the
 * launcher's. What callers want is the router, so find the process whose command line names our
 * script. The runtime is `node.exe` for a source checkout and `ClaudeRipple.exe` (Electron as
 * Node) for the packaged app — until 0.1.2 only `node.exe` was looked for, so on every packaged
 * install `restart` found no router, skipped the shutdown, and `Start-ScheduledTask` was ignored
 * by the task already running: "Restart Router" never restarted anything (found 2026-09-16).
 */
/**
 * The router's pid, for display only. Never used to wait on, stop or signal a process: when two
 * installations share one runtime their router command lines are identical, so this can name the
 * other home's process. Stop/restart use this installation's admin port (router-state.ts) instead.
 */
export function agentPid(name = taskName(), opts: { home?: string; expectedRouter?: string; deps?: TaskDeps } = {}): number | null {
  const deps = opts.deps ?? {};
  // Without our own definition the running router could be any installation's (B01/D6): never
  // hand its pid to a caller that will wait on it or stop it.
  if (taskOwnership(opts.home ?? homeDir(), { ...deps, name }).state !== "ours") return null;
  const r = invoke(
    // Three layouts run the same router: a checkout (packages\router\src\index.ts), an npm
    // install (dist\router\src\index.js) and the packaged app (the .ts under resources). Matching
    // on "router\src\index." covers all three and still cannot match an unrelated process.
    `$p = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='ClaudeRipple.exe'" | Where-Object { $_.CommandLine -like '*router\\src\\index.*' } | Select-Object -First 1; if ($null -eq $p) { 'null' } else { [pscustomobject]@{ pid = $p.ProcessId; commandLine = $p.CommandLine } | ConvertTo-Json -Compress }`,
    deps,
  );
  if (!r.ok) return null;
  let found: { pid?: unknown; commandLine?: unknown } | null;
  try {
    found = JSON.parse(r.out.trim()) as { pid?: unknown; commandLine?: unknown } | null;
  } catch {
    return null;
  }
  // #110: no router yet prints 'null', which parses. Reading .pid off it threw out of install,
  // start and repair right after the task was registered.
  if (found === null || typeof found !== "object") return null;
  const pid = Number(found.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  // A process running another installation's router script is not this one's to wait on, even
  // with the task registered here (both can share one task name only through this gate).
  if (opts.expectedRouter && !String(found.commandLine ?? "").includes(opts.expectedRouter)) return null;
  return pid;
}

/**
 * The router process that belongs to this task's own launcher, for control decisions. Unlike
 * `agentPid`, this proves the process is under the task registered here: the launcher's command
 * line names this installation's home, and the router is its descendant. A direct router of the same
 * home, or another home's process, cannot satisfy both. Null when anything is unreadable.
 */
export function taskRouterPid(name = taskName(), opts: { home?: string; deps?: TaskDeps } = {}): number | null {
  const deps = opts.deps ?? {};
  const home = opts.home ?? homeDir();
  if (taskOwnership(home, { ...deps, name }).state !== "ours") return null;
  if (deps.routerPid) return deps.routerPid();
  const launcher = path.join(home, "clauderipple-router.ps1");
  const listed = invoke(
    `Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress`,
    deps,
  );
  if (!listed.ok) return null;
  let rows: unknown;
  try {
    rows = JSON.parse(listed.out.trim());
  } catch {
    return null;
  }
  const list = Array.isArray(rows) ? rows : rows !== null && typeof rows === "object" ? [rows] : [];
  type Process = { pid: number; commandLine: string };
  const processes: Process[] = [];
  const children = new Map<number, Process[]>();
  for (const row of list) {
    if (row === null || typeof row !== "object") return null;
    const value = row as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown };
    const pid = Number(value.ProcessId);
    const parent = Number(value.ParentProcessId);
    if (!Number.isSafeInteger(pid) || pid < 0 || !Number.isSafeInteger(parent) || parent < 0) return null;
    // Win32_Process includes System Idle Process (PID 0), never a launcher or a router.
    if (pid === 0) continue;
    const process = { pid, commandLine: typeof value.CommandLine === "string" ? value.CommandLine : "" };
    processes.push(process);
    const siblings = children.get(parent) ?? [];
    siblings.push(process);
    children.set(parent, siblings);
  }
  const root = processes.find(process => process.commandLine.includes(launcher));
  if (!root) return null;
  // #100: conhost's command line also names the launcher. The router is then a grandchild,
  // not a direct child. Walk the same snapshot's whole subtree, never the global router list.
  const pending = [root.pid];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    for (const child of children.get(pid) ?? []) {
      if (/router\\src\\index\./i.test(child.commandLine)) return child.pid;
      pending.push(child.pid);
    }
  }
  return null;
}

/**
 * What `startAgent` asks and what it judges the answer by. Injected so a test can model a task
 * whose start was accepted while no router ever appeared, without Task Scheduler existing.
 */
export type StartProbe = {
  /** True once what this task starts is actually running (the router for the default task). */
  up(): boolean;
  /** `Start-ScheduledTask`; true when the request was accepted, not when anything came up. */
  start(): boolean;
};

function realStartProbe(name: string, home: string, deps: TaskDeps, up?: () => boolean): StartProbe {
  return {
    // The job's process, not an admin-port answer: this decides "already running" before a start,
    // and an older router of this installation reports no installation id. Shutdown uses the id
    // (WindowsRouterOps in supervisor.ts); this never does.
    up: () => (name === taskName() ? (up ?? (() => agentPid(name, { home, expectedRouter: runtime().router, deps }) !== null))() : agentState(name, deps) === "running"),
    start: () => invoke(`Start-ScheduledTask -TaskName ${ps(name)} -ErrorAction Stop; 'ok'`, deps).ok,
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitUntil(ok: () => boolean, budgetMs: number, pollMs = 500): boolean {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (ok()) return true;
    sleepSync(pollMs);
  }
  return ok();
}

/**
 * Start-ScheduledTask succeeds once the task has been told to run — the launcher may then fail to
 * start the router, or start a program that exits at once. On 2026-10-22 an update drained the
 * router, the task start was accepted, nothing came up, and the update reported success while
 * Claude had no router for 11h47m (#80). So "started" means the router's process exists.
 */
export function startAgent(...args: Parameters<typeof startAgentLocked>): AgentStart {
  const [name = taskName(), opts = {}] = args;
  if (opts.probe) return startAgentLocked(name, opts);
  return withTaskDefinition(name, opts.deps ?? {}, guarded => startAgentLocked(name, { ...opts, deps: guarded }));
}

function startAgentLocked(name = taskName(), opts: { waitMs?: number; probe?: StartProbe; home?: string; deps?: TaskDeps; up?: () => boolean } = {}): AgentStart {
  const home = opts.home ?? homeDir();
  // An injected probe models the supervisor, so it also stands in for what is registered. One
  // definition read is shared with the answer poll: a start waits, and each poll must not re-read it.
  let deps = opts.deps ?? {};
  if (!opts.probe) {
    const definition = deps.definition ? deps.definition() : existingTaskDefinition(name, deps);
    deps = { ...deps, definition: () => definition };
    const owner = taskOwnership(home, { ...deps, name });
    if (owner.state === "other") return "other-installation";
    if (owner.state === "unknown") return "ownership-unknown";
  }
  const probe = opts.probe ?? realStartProbe(name, home, deps, opts.up);
  if (probe.up()) return "already-running";
  if (!probe.start()) return "failed";
  return waitUntil(probe.up, opts.waitMs ?? 20_000) ? "started" : "failed";
}

/**
 * Stop-ScheduledTask for a task whose definition is this installation's. It terminates the running
 * instance, so it is only called by `stopWindowsRouter`, after that router proved (installation id)
 * to be ours. Do not call it directly: the definition's home is not proof of the running instance.
 */
export function stopAgent(...args: Parameters<typeof stopAgentLocked>): AgentStop {
  const [name = taskName(), opts = {}] = args;
  return withTaskDefinition(name, opts.deps ?? {}, guarded => stopAgentLocked(name, { ...opts, deps: guarded }));
}

function stopAgentLocked(name = taskName(), opts: { home?: string; deps?: TaskDeps } = {}): AgentStop {
  const deps = opts.deps ?? {};
  const owner = taskOwnership(opts.home ?? homeDir(), { ...deps, name });
  if (owner.state === "absent") return "not-loaded";
  if (owner.state === "other") return "other-installation";
  if (owner.state === "unknown") return "ownership-unknown";
  // Host callers first request authenticated graceful shutdown and wait for its clean exit.
  return invoke(`Stop-ScheduledTask -TaskName ${ps(name)} -ErrorAction Stop`, deps).ok ? "stopped" : "failed";
}
